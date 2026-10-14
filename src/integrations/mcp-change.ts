import { createHash } from "node:crypto";
import { constants } from "node:os";
import { z } from "zod";
import type { Factory } from "../app.ts";
import { ownerDiagnostics } from "../db/owner-diagnostics.ts";
import { loadPrivateStrings, normalizedLayers, privateMatches } from "../gates/private.ts";
import { worktreeGit } from "../git/command.ts";
import { cachePath } from "../git/repos.ts";
import { holdoutBoundaryPattern, privateHoldoutDetails } from "../pipeline/prompts.ts";
import { HoldoutSchema, renderSpec, rowKind, SpecSchema, VerifySchema } from "../pipeline/schemas.ts";
import { loadOutputPrivacy, privateOutputData } from "../util/private-output.ts";
import { registeredCredentials } from "../util/proc.ts";
import { commitSha, reviewableHead } from "./mcp-head.ts";

export const ChangeQuerySchema = z
  .object({
    run: z.string().trim().min(1),
    headSha: commitSha.optional(),
    baseSha: commitSha.optional(),
    filesOffset: z.number().int().nonnegative().default(0),
    file: z.number().int().nonnegative().default(0),
    diffOffset: z.number().int().nonnegative().default(0),
    reportOffset: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine(
    (q) =>
      (q.headSha === undefined) === (q.baseSha === undefined) &&
      ((!q.filesOffset && !q.file && !q.diffOffset && !q.reportOffset) || (q.headSha && q.baseSha)),
    "Further reads require headSha and baseSha from the first page",
  );

const PATCH_CAP = 16_000;
const REPORT_CAP = 4_000;
const FILES_CAP = 50;
const DISTINCTIVE_LENGTH = 12;
const normalizeWhitespace = (value: string) => value.replace(/\\+[nrt]/gu, " ").replace(/\s+/gu, " ");
// Platform error names are public diagnostics, as in verifier feedback.
const errnoNames = Object.keys(constants.errno);
type HoldoutRedactor = (value: string) => string;
// Retain at most 2,048 details totaling 256K UTF-16 characters per store. Larger catalogues
// still redact each read, but their patterns are not retained. Privacy filters load each read.
const CATALOGUE_DETAILS_CAP = 2_048;
const CATALOGUE_CHARACTERS_CAP = 256_000;
type Catalogue = { redact: HoldoutRedactor; cacheable: boolean };
const catalogues = new WeakMap<Factory["store"], { key: string; catalogue: Catalogue }>();

/** Map literal matches in each file side back to their physical patch lines. */
function privatePatchLines(patch: string, values: readonly string[]): Set<number> {
  const hidden = new Set<number>();
  const literals = values.map((value) => value.normalize("NFKC").toLowerCase());
  type Line = { index: number; prefix: string; text: string };
  let hunk: Line[] = [];
  let inHunk = false;
  const scan = (side: Line[], patterns = literals) => {
    const layers = side.map((line) => {
      const forms = normalizedLayers(line.text);
      // Withhold unsafe decoding at its source, retaining raw text for literal spans.
      if (!forms) hidden.add(line.index);
      return forms ?? [line.text.normalize("NFKC").toLowerCase()];
    });
    const depth = layers.reduce((max, forms) => Math.max(max, forms?.length ?? 0), 0);
    for (let layer = 0; layer < depth; layer++) {
      let text = "";
      const ranges = side.map((line, i) => {
        const forms = layers[i];
        const start = text.length;
        text += forms?.[Math.min(layer, forms.length - 1)] ?? "";
        return { index: line.index, start, end: text.length };
      });
      const withhold = (start: number, end: number) => {
        for (const range of ranges) if (range.start < end && range.end > start) hidden.add(range.index);
      };
      for (const literal of patterns) {
        if (!literal) continue;
        let start = text.indexOf(literal);
        while (start >= 0) {
          withhold(start, start + literal.length);
          // Overlapping occurrences can involve additional patch lines.
          start = text.indexOf(literal, start + 1);
        }
        // Hunk context clips the file at line boundaries; protect either exposed fragment.
        for (const { index } of literal.matchAll(/\n/gu)) {
          const prefix = literal.slice(0, index + 1);
          const suffix = literal.slice(index + 1);
          if (prefix.replace(/\r?\n/gu, "") && text.endsWith(prefix))
            withhold(text.length - prefix.length, text.length);
          if (suffix.replace(/\r?\n/gu, "") && text.startsWith(suffix)) withhold(0, suffix.length);
        }
        if (!literal.includes("\n")) continue;
        // Both hunk edges can fall inside a long credential; protect whole-line runs from its middle.
        const framed = `\n${literal}\n`;
        for (let i = 0; i < ranges.length; i++) {
          for (let j = i; j < ranges.length; j++) {
            const run = text.slice(ranges[i]?.start, ranges[j]?.end);
            if (!framed.includes(`\n${run}`)) break;
            // Two or more lines: a lone shared line is not evidence of the credential.
            if (j > i && run.endsWith("\n")) withhold(ranges[i]?.start ?? 0, ranges[j]?.end ?? 0);
          }
        }
      }
    }
  };
  const flush = () => {
    scan(hunk.filter((line) => line.prefix !== "+"));
    scan(hunk.filter((line) => line.prefix !== "-"));
    hunk = [];
  };
  for (const [index, line] of patch.split("\n").entries()) {
    if (line.startsWith("@@ ")) {
      flush();
      // Git can quote an isolated credential line as the hunk's function annotation.
      scan(
        [{ index, prefix: "", text: line.replace(/^@@ [^@]* @@ ?/u, "") }],
        literals.flatMap((value) => (value.includes("\n") ? value.split(/\r?\n/u) : [value])),
      );
      inHunk = true;
    } else if (inHunk && /^[-+ ]/u.test(line)) {
      hunk.push({ index, prefix: line[0] ?? "", text: `${line.slice(1)}\n` });
    } else if (inHunk && line.startsWith("\\")) {
      const previous = hunk.at(-1);
      if (previous) previous.text = previous.text.slice(0, -1);
    } else {
      flush();
      inHunk = false;
    }
  }
  flush();
  return hidden;
}

function catalogueKey(store: Factory["store"], ids: string[], rounds: unknown): string | null {
  try {
    const hash = createHash("sha256").update(JSON.stringify(rounds));
    hash.update(JSON.stringify([loadPrivateStrings(), registeredCredentials()]));
    hash.update(JSON.stringify(store.db.query("PRAGMA data_version").get()));
    const diagnostics = store.db.query("SELECT 1 FROM sqlite_master WHERE name = 'owner_diagnostics'").get();
    for (const id of ids) {
      const run = store.db
        .query<{ prompt: string; state_json: string | null }, [string]>(
          "SELECT prompt, state_json FROM runs WHERE id = ?",
        )
        .get(id);
      if (!run) return null;
      hash.update(JSON.stringify([id, run.prompt, run.state_json]));
      hash.update(
        JSON.stringify(
          store.db
            .query("SELECT id FROM invocations WHERE run_id = ? AND role = 'verify' ORDER BY id")
            .all(id),
        ),
      );
      // Owner diagnostics are append-only. Read their watermark without loading their text.
      if (diagnostics)
        hash.update(
          JSON.stringify(
            store.db.query("SELECT MAX(id), COUNT(*) FROM owner_diagnostics WHERE run_id = ?").get(id),
          ),
        );
    }
    return hash.digest("hex");
  } catch {
    // If freshness cannot be established, the caller rebuilds rather than reusing patterns.
    return null;
  }
}
// Only the verifier text fields: routing and checkpoint metadata are public structure.
const verificationText = z.object({
  notes: z.string().optional(),
  criteria: z
    .array(
      z.object({
        id: z.string(),
        evidence: z.string().optional(),
        publicSummary: z.string().optional(),
        requirementCitation: z.string().nullish(),
        gateEvidence: z.object({ check: z.string(), command: z.string() }).optional(),
      }),
    )
    .optional(),
});

/**
 * The rendered report clips holdout scenarios, so phrase matching cannot vet them; drop the
 * whole section. It always precedes the Checks heading, and any earlier or later lookalike
 * headings only widen what is dropped.
 */
function withoutHoldoutSection(report: string, redact: HoldoutRedactor) {
  const start = report.indexOf("## Holdout scenarios");
  if (start < 0) return redact(report);
  const end = report.lastIndexOf("\n\n## Checks");
  const section = report.slice(start, end > start ? end : undefined);
  return `${redact(report.slice(0, start))}[withheld: holdout section; 1 section, ${section.split("\n").length} lines]${end > start ? redact(report.slice(end)) : "\n"}`;
}

/** Match before paging and retain a line map through decoding, including escaped line breaks. */
function redactMultiline(value: string, pattern: RegExp, keep?: (line: string) => number): string | null {
  const lines = value.split("\n");
  const hidden = new Set<number>();
  type ContentLine = { index: number; prefix: string; text: string };
  let hunk: ContentLine[] = [];
  const match = (content: ContentLine[]): boolean => {
    const layers = content.map(({ text }) => normalizedLayers(text));
    if (layers.some((layer) => layer === null)) return false;
    const depth = Math.max(1, ...layers.map((layer) => layer?.length ?? 0));
    for (let layer = 0; layer < depth; layer++) {
      let text = "";
      const ranges: { index: number; start: number; end: number }[] = [];
      for (let i = 0; i < content.length; i++) {
        const forms = layers[i];
        const line = content[i];
        if (!forms || !line) return false;
        const decoded = (forms[Math.min(layer, forms.length - 1)] ?? "").replace(
          /\\+[nrt]/gu,
          (sequence) => ({ n: "\n", r: "\r", t: "\t" })[sequence.at(-1) ?? ""] ?? sequence,
        );
        // Collapse each whitespace run once, merging runs across physical line boundaries.
        // A shared space belongs to both lines so a match hides every contributing line.
        let normalized = `${decoded}\n`.replace(/\s+/gu, " ");
        const shared = text.length > 0 && normalized.startsWith(" ");
        if (shared) normalized = normalized.slice(1);
        ranges.push({
          index: line.index,
          start: text.length - Number(shared),
          // The appended line separator has no original character to withhold.
          end: text.length + normalized.length - Number(!/\s$/u.test(decoded)),
        });
        text += normalized;
      }
      pattern.lastIndex = 0;
      let cursor = 0;
      for (const found of text.matchAll(pattern)) {
        const end = found.index + found[0].length;
        while (ranges[cursor] && (ranges[cursor]?.end ?? 0) <= found.index) cursor++;
        for (let i = cursor; i < ranges.length; i++) {
          const range = ranges[i];
          if (!range || range.start >= end) break;
          if (range.end > found.index) hidden.add(range.index);
        }
      }
    }
    return true;
  };
  const flush = () => {
    // Old and new file projections prevent interleaved removed lines from interrupting a
    // phrase in context and additions (and vice versa). Neither crosses a hunk boundary.
    const ok = keep
      ? match(hunk.filter((line) => line.prefix !== "-")) && match(hunk.filter((line) => line.prefix !== "+"))
      : match(hunk);
    hunk = [];
    return ok;
  };
  for (const [index, line] of lines.entries()) {
    if (!keep) hunk.push({ index, prefix: "", text: line });
    else if (keep(line) > 0) {
      if (!flush()) return null;
      const suffix = line.slice(keep(line));
      if (suffix && !match([{ index, prefix: "", text: suffix }])) return null;
    } else if (/^[-+ ]/u.test(line)) hunk.push({ index, prefix: line[0] ?? "", text: line.slice(1) });
    else if (line.startsWith("\\")) {
      // Git's missing-final-newline marker is structure, not intervening file content.
    } else if (!flush()) return null;
  }
  if (!flush()) return null;
  return lines
    .map((line, index) => {
      const prefix = keep ? (/^@@ [^@]* @@/u.exec(line)?.[0] ?? line.slice(0, 1)) : "";
      return hidden.has(index) ? `${prefix}[private detail]` : line;
    })
    .join("\n");
}

function buildCatalogue(store: Factory["store"], ids: string[]): Catalogue | null {
  // Holdouts from earlier rounds remain private even after a later round delivers.
  const details = new Set<string>();
  for (const id of ids) {
    const state = z
      .object({
        holdout: HoldoutSchema.optional(),
        spec: SpecSchema.nullish().catch(null),
        lastVerify: verificationText.nullish(),
        verifyResults: z
          .array(verificationText.extend({ modelOutput: verificationText.optional() }))
          .optional(),
      })
      .safeParse(store.getRunState(id) ?? {});
    if (!state.success) return null;
    const { holdout, spec } = state.data;
    if (!holdout?.scenarios.length) continue;
    // Same exemption as verifier feedback: what the run's request and spec already state is public.
    const publicSources = [store.getRun(id)?.prompt ?? "", spec ? renderSpec(spec) : "", ...errnoNames].join(
      "\n",
    );
    const standalone = {
      scenarios: holdout.scenarios.map((scenario) => ({
        ...scenario,
        description: /[\r\n\t]/u.test(scenario.description) ? "" : scenario.description,
        steps: /[\r\n\t]/u.test(scenario.steps) ? "" : scenario.steps,
        expected: /[\r\n\t]/u.test(scenario.expected) ? "" : scenario.expected,
      })),
    };
    const independent = privateHoldoutDetails(standalone, publicSources);
    const quoted = new Set(
      holdout.scenarios.flatMap((scenario) =>
        [scenario.description, scenario.steps, scenario.expected].flatMap((source) =>
          [...source.matchAll(/(["'`])(?:(?!\1)[^\n])*?\1/gu)].map((match) => match[0].slice(1, -1)),
        ),
      ),
    );
    // Multiline phrases protect generic syntax in context. Quoted values, paths, flags and
    // distinctive identifiers also match independently; bare numbers and assertion methods do not.
    for (const detail of privateHoldoutDetails(holdout, publicSources))
      if (
        independent.has(detail) ||
        /[\r\n\t]/u.test(detail) ||
        (!/^(?:\d+(?:\.\d+)?|to(?:Be|Have|Equal|Contain|Match|Throw|Start|End)\w*)$/u.test(detail) &&
          (quoted.has(detail) ||
            detail.length >= DISTINCTIVE_LENGTH ||
            /[/_-]|[\p{L}$].*\d|\d.*[\p{L}$]/u.test(detail)))
      )
        details.add(detail);
    const collect = (observed?: string, privateProse = false) => {
      if (observed !== undefined) {
        for (const detail of privateHoldoutDetails(standalone, publicSources, observed)) details.add(detail);
        const prose = observed.trim();
        const words = normalizeWhitespace(normalizedLayers(prose)?.at(-1) ?? prose).trim();
        // Gate citations and generic notes are public; only private observations need
        // whole-prose matching when they have no distinctive literals to harvest.
        if (
          privateProse &&
          words.length >= DISTINCTIVE_LENGTH &&
          words.split(" ").length > 1 &&
          !new RegExp(holdoutBoundaryPattern(prose), "iu").test(publicSources)
        )
          details.add(prose);
      }
    };
    const collectOutput = (value: unknown, privateProse = false) => {
      if (typeof value === "string") collect(value, privateProse);
      else if (value && typeof value === "object")
        for (const field of Object.values(value)) collectOutput(field, privateProse);
    };
    collect();
    const collectVerification = (verify: z.output<typeof verificationText> | null | undefined) => {
      collect(verify?.notes);
      for (const criterion of verify?.criteria ?? []) {
        // Public acceptance evidence/summaries stay public, as in preDeliveryVerifyArtifact.
        const kind = rowKind(criterion.id, spec ?? null, holdout);
        if (kind !== "public") {
          if (kind === "holdout") details.add(criterion.id.trim());
          collectOutput([criterion.evidence, criterion.publicSummary, criterion.requirementCitation], true);
        }
        collectOutput(criterion.gateEvidence);
      }
    };
    collectVerification(state.data.lastVerify);
    for (const verify of state.data.verifyResults ?? []) {
      collectVerification(verify);
      collectVerification(verify.modelOutput);
    }
    // These raw copies are internal catalogue inputs only, never response fields.
    const verifiers = new Set(
      store
        .listInvocations(id)
        .filter((v) => v.role === "verify")
        .map((v) => v.id),
    );
    for (const diagnostic of ownerDiagnostics(store.db, id)) {
      if (diagnostic.kind !== "run-error" && !verifiers.has(diagnostic.invocationId ?? -1)) continue;
      let output: unknown = diagnostic.text;
      try {
        output = JSON.parse(diagnostic.text);
      } catch {
        /* Plain verifier diagnostics are also private. */
      }
      const verify = VerifySchema.safeParse(output);
      const fields = verificationText.safeParse(output);
      if (verify.success) {
        collectVerification(verify.data);
        // Factory gate citations are not part of the model's Verify schema.
        if (fields.success)
          for (const criterion of fields.data.criteria ?? []) collectOutput(criterion.gateEvidence);
      } else if (fields.success && fields.data.criteria) {
        // Incomplete verifier JSON still distinguishes public rows from private observations.
        collectVerification(fields.data);
      } else {
        // Only unstructured diagnostics need whole-text harvesting, including quoted JSON
        // literals that lose their quotes when parsed.
        if (diagnostic.kind !== "event") collect(diagnostic.text);
        collectOutput(output);
      }
    }
  }
  const pattern = details.size
    ? new RegExp(
        [...details]
          .sort((a, b) => b.length - a.length)
          .map(holdoutBoundaryPattern)
          .join("|"),
        "giu",
      )
    : null;
  // Long, distinctive details are also caught embedded in other words.
  const distinctive = [...details]
    .filter((detail) => detail.length >= DISTINCTIVE_LENGTH)
    .map((value) => ({ value, entry: 0 }));
  const boundary =
    pattern &&
    new RegExp(
      [...details].map((detail) => holdoutBoundaryPattern(detail.normalize("NFKC").toLowerCase())).join("|"),
      "iu",
    );
  // Any detail, however short, is private even after decoding or normalization.
  const encoded = (text: string) => {
    const layers = normalizedLayers(text);
    return !layers || layers.some((layer) => boundary?.test(layer));
  };
  // Any phrase can wrap in a report, even if its catalogue entry is a single line.
  const multilineDetails = [...details];
  const multiline = multilineDetails.length
    ? new RegExp(
        multilineDetails
          .map((detail) => {
            const normalized = normalizeWhitespace(
              normalizedLayers(detail)?.at(-1) ?? detail.normalize("NFKC").toLowerCase(),
            );
            const literal = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return detail.length >= DISTINCTIVE_LENGTH ? literal : holdoutBoundaryPattern(normalized);
          })
          .join("|"),
        "giu",
      )
    : null;
  const holdoutRedact: HoldoutRedactor = (value) => {
    if (multiline) {
      const matched = redactMultiline(value, multiline);
      if (matched === null)
        return `[withheld: holdout result or quotation; ${value.split("\n").length} lines]`;
      value = matched;
    }
    if (!pattern) return value;
    return value
      .split("\n")
      .map((line) => {
        pattern.lastIndex = 0;
        return line.includes("[private detail]") ||
          pattern.test(line) ||
          encoded(line) ||
          privateMatches(line, distinctive).length
          ? "[withheld: holdout result or quotation; 1 line]"
          : line;
      })
      .join("\n");
  };
  return {
    redact: holdoutRedact,
    cacheable:
      details.size <= CATALOGUE_DETAILS_CAP &&
      [...details].reduce((size, detail) => size + detail.length, 0) <= CATALOGUE_CHARACTERS_CAP,
  };
}

/** Saved observations only: no fetch, working-tree bytes, arbitrary paths, or artifact reads. */
export async function getChange(factory: Factory, input: unknown, signal?: AbortSignal) {
  const privacy = loadOutputPrivacy();
  if (!privacy) return { available: false, reason: "Privacy policy unavailable; content withheld." };
  const query = ChangeQuerySchema.safeParse(input);
  if (!query.success)
    return {
      available: false,
      reason: query.error.issues.some((issue) => issue.code === "custom")
        ? "Further reads require headSha and baseSha from the first page."
        : "Invalid change-view request.",
    };
  const q = query.data;
  const { store } = factory;
  const owner = store.getRun(q.run);
  if (!owner) return { available: false, reason: "Run not found." };
  let observed: unknown;
  try {
    observed = owner.prUrl ? JSON.parse(store.githubPrData(owner.prUrl) ?? "null") : null;
  } catch {
    return { available: false, reason: "Observed PR head unavailable." };
  }
  const snapshot = z
    .object({ headRefOid: commitSha, baseRefName: z.string().optional(), baseRefOid: commitSha.optional() })
    .safeParse(observed);
  if (!snapshot.success) return { available: false, reason: "Observed PR head unavailable." };
  const recorded = owner.prUrl ? store.prHead(owner.prUrl) : null;
  const superseded = (sha: unknown) => ({
    available: false,
    reason: `PR head superseded${commitSha.safeParse(sha).success ? `; current head ${sha}` : ""}; restart limitless_get_change.`,
  });
  const head = reviewableHead(
    snapshot.data.headRefOid,
    recorded && { ...recorded, pushing: store.pushingTo(owner.prUrl ?? "") },
  );
  if (head.problem)
    return head.problem === "superseded"
      ? superseded(recorded?.sha)
      : { available: false, reason: "PR head unavailable; restart limitless_get_change." };
  const headSha = head.headSha;
  if (q.headSha && q.headSha !== headSha) return superseded(headSha);
  const baseBranch = snapshot.data.baseRefName ?? owner.baseBranch;
  const parsedComparison = commitSha.safeParse(snapshot.data.baseRefOid ?? owner.baseSha);
  if (!parsedComparison.success || !baseBranch)
    return { available: false, reason: "Recorded comparison unavailable." };
  const comparison = parsedComparison.data;
  const repo = store.getRepo(owner.repoId);
  if (!repo) return { available: false, reason: "Repository unavailable." };
  const rounds = owner.prUrl ? store.reviewRounds(owner.prUrl) : [];
  const ids = [...new Set([owner.id, ...rounds.map((round) => round.runId)])];
  const key = catalogueKey(store, ids, rounds);
  const cached = catalogues.get(store);
  const catalogue = key && cached?.key === key ? cached.catalogue : buildCatalogue(store, ids);
  if (!catalogue) return { available: false, reason: "Holdout policy unavailable; content withheld." };
  if (key && catalogue.cacheable) catalogues.set(store, { key, catalogue });
  else catalogues.delete(store);
  const holdoutRedact = catalogue.redact;
  const protect = (value: string) =>
    privacy(value) === value
      ? privacy(holdoutRedact(value))
      : privacy(`[withheld: private text; ${value.split("\n").length} lines]`);
  const cwd = cachePath(factory.cfg.paths, repo);
  const git = async (args: string[]) =>
    (await worktreeGit(["git", ...args], { cwd, signal, redactOutput: false })).stdout;
  try {
    for (const sha of [headSha, comparison, ...(q.baseSha ? [q.baseSha] : [])]) {
      const result = await worktreeGit(["git", "cat-file", "-e", `${sha}^{commit}`], {
        cwd,
        signal,
        allowFail: true,
      });
      if (result.exitCode !== 0)
        return { available: false, reason: `Required commit ${sha} unavailable in local cache.` };
    }
    const baseSha = (await git(["merge-base", comparison, headSha])).trim();
    if (q.baseSha && q.baseSha !== baseSha)
      return { available: false, reason: "Comparison superseded; restart limitless_get_change." };
    const counts = await git([
      "diff",
      "--no-renames",
      "--ignore-submodules=none",
      "--numstat",
      "-z",
      baseSha,
      headSha,
      "--",
    ]);
    const files = counts
      .split("\0")
      .filter(Boolean)
      .map((entry, index) => {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Invalid Git change metadata");
        const path = match[3] ?? "";
        return {
          index,
          path,
          additions: match[1] === "-" ? null : Number(match[1]),
          deletions: match[2] === "-" ? null : Number(match[2]),
          binary: match[1] === "-",
        };
      });
    const selected = files[q.file];
    if (!selected && (q.file > 0 || files.length > 0))
      return { available: false, reason: `Unknown file index ${q.file}; change has ${files.length} files.` };
    // Only files present in the delivered tree qualify for the visible PR diff.
    const deleted = new Set(
      (
        await git([
          "diff",
          "--no-renames",
          "--ignore-submodules=none",
          "--diff-filter=D",
          "--name-only",
          "-z",
          baseSha,
          headSha,
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    const prText = (path: string) => !deleted.has(path);
    const safePath = (path: string) =>
      privacy(path) === path && privacy(JSON.stringify(path)) === JSON.stringify(path) && prText(path);
    // Filter complete lines before paging, then check the complete sanitized patch too.
    const privatePatch = (patch: string) => {
      const hidden = privatePatchLines(patch, [
        ...loadPrivateStrings().map(({ value }) => value),
        ...registeredCredentials(),
      ]);
      const filtered = patch
        .split("\n")
        .map((line, index) =>
          hidden.has(index)
            ? `${/^@@ [^@]* @@/u.exec(line)?.[0]?.concat(" ") ?? line[0]}[withheld: private text; 1 line]`
            : privacy(line) === line
              ? line
              : "[withheld: private text; 1 line]",
        )
        .join("\n");
      return privacy(filtered) === filtered
        ? filtered
        : privacy(`[withheld: private text; ${patch.split("\n").length} lines]`);
    };
    const patch =
      selected && !selected.binary && safePath(selected.path)
        ? privatePatch(
            await git([
              "diff",
              "--no-renames",
              "--ignore-submodules=none",
              "--unified=3",
              "--diff-algorithm=myers",
              "--no-indent-heuristic",
              baseSha,
              headSha,
              "--",
              `:(literal)${selected.path}`,
            ]),
          )
        : selected && !selected.binary
          ? prText(selected.path)
            ? "[withheld: protected path; 1 file]"
            : `[withheld: file absent from PR head; 1 file, ${selected.deletions ?? 0} lines]`
          : "";
    const pin = { run: owner.id, headSha, baseSha };
    const page = (text: string, offset: number, cap: number) => ({
      text: text.slice(offset, offset + cap),
      total: text.length,
      truncated: offset + cap < text.length,
      nextOffset: offset + cap < text.length ? offset + cap : null,
    });
    const latest = rounds.findLast((round) => round.deliveredSha);
    const reports = [owner.id, ...(latest?.deliveredSha ? [latest.runId] : [])].map((run) => {
      const report = store.getArtifact(run, "report.md");
      return report === null
        ? { run, available: false, reason: "Persisted report unavailable." }
        : {
            run,
            available: true,
            ...page(
              privacy(report) === report
                ? privacy(withoutHoldoutSection(report, holdoutRedact))
                : protect(report),
              q.reportOffset,
              REPORT_CAP,
            ),
          };
    });
    const listing = [];
    let size = 0;
    for (const file of files.slice(q.filesOffset, q.filesOffset + FILES_CAP)) {
      const entry = { ...file, path: prText(file.path) ? privacy(file.path) : protect(file.path) };
      size += JSON.stringify(entry).length;
      if (size > PATCH_CAP && listing.length) break;
      listing.push(entry.path.length > REPORT_CAP ? { ...entry, path: "[withheld: oversized path]" } : entry);
    }
    // Awaited Git reads must not return a head that advanced while the view was assembled.
    const current = owner.prUrl && store.githubPrData(owner.prUrl);
    const now = owner.prUrl ? store.prHead(owner.prUrl) : null;
    if (
      !current ||
      !now ||
      now.version !== recorded?.version ||
      reviewableHead(JSON.parse(current).headRefOid, { ...now, pushing: store.pushingTo(owner.prUrl ?? "") })
        .headSha !== headSha
    )
      return superseded(now?.sha);
    if (!key || catalogueKey(store, ids, owner.prUrl ? store.reviewRounds(owner.prUrl) : []) !== key)
      return { available: false, reason: "Holdout policy changed; restart limitless_get_change." };
    return privateOutputData(
      {
        available: true,
        ...pin,
        baseBranch:
          baseBranch.length > REPORT_CAP ? "[withheld: oversized base branch]" : protect(baseBranch),
        comparisonSha: comparison,
        files: listing,
        totalFiles: files.length,
        filesTruncated: q.filesOffset + listing.length < files.length,
        nextFilesOffset:
          q.filesOffset + listing.length < files.length ? q.filesOffset + listing.length : null,
        diff: { file: q.file, binary: selected?.binary ?? false, ...page(patch, q.diffOffset, PATCH_CAP) },
        reports,
        paging:
          "Repeat limitless_get_change with run, headSha and baseSha; use nextFilesOffset as filesOffset, a file index as file, and nextOffset as diffOffset or reportOffset. Offsets count characters in sanitized text.",
      },
      privacy,
    );
  } catch {
    // Git diagnostics can contain quoted paths and clipped secrets; expose no raw error text.
    return { available: false, reason: "Local comparison commits or Git inspection unavailable." };
  }
}
