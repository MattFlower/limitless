import { createHash } from "node:crypto";
import { constants } from "node:os";
import { decodeHTML } from "entities";
import { z } from "zod";
import type { Factory } from "../app.ts";
import { ownerDiagnostics } from "../db/owner-diagnostics.ts";
import { redactGateOutput } from "../gates/output.ts";
import { loadPrivateStrings, normalizedLayers, privateMatches } from "../gates/private.ts";
import { sanitizePublication } from "../gates/publication.ts";
import { worktreeGit } from "../git/command.ts";
import { cachePath } from "../git/repos.ts";
import { holdoutBoundaryPattern, privateHoldoutDetails, privateVerifySummary } from "../pipeline/prompts.ts";
import { reportSourcesSchema, reportStructure } from "../pipeline/report-privacy.ts";
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
/** Clipped spans supply their complete rendering for matching before the display cut. */
type HoldoutRedactor = (value: string, source?: string) => string;
// Retain at most 2,048 details totaling 256K UTF-16 characters per store. Larger catalogues
// still redact each read, but their patterns are not retained. Privacy filters load each read.
const CATALOGUE_DETAILS_CAP = 2_048;
const CATALOGUE_CHARACTERS_CAP = 256_000;
type Catalogue = {
  redact: HoldoutRedactor;
  factoryRedact: HoldoutRedactor;
  verifierRedact: HoldoutRedactor;
  implementerRedact: HoldoutRedactor;
  cacheable: boolean;
};
const catalogues = new WeakMap<Factory["store"], { key: string; catalogue: Catalogue }>();

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
        JSON.stringify([store.getArtifact(id, "report.md"), store.getArtifact(id, "report-sources.json")]),
      );
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
        status: z.string().optional(),
        requirement: z.string().nullish(),
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

/** Apply each author’s backstop only within validated factory structure. */
function redactReport(report: string, catalogue: Catalogue, sourcesArtifact: string | null): string {
  const structure = reportStructure(report);
  if (structure === null) return "[withheld: invalid report structure]";
  if (!structure) return "[withheld: report without structural provenance]";
  const { body, spans } = structure;
  let sources: Record<string, string> = {};
  try {
    const parsed = reportSourcesSchema.safeParse(JSON.parse(sourcesArtifact ?? "null"));
    if (parsed.success && parsed.data.digest === structure.digest) sources = parsed.data.sources;
  } catch {
    // Clipped spans fail closed without a valid, matching sources artifact.
  }
  let filtered = "";
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    filtered += catalogue.factoryRedact(body.slice(cursor, span.start));
    const text = body.slice(span.start, span.end);
    const source = span.clipped ? sources[index] : undefined;
    filtered +=
      span.clipped && source === undefined
        ? "[withheld: clipped report span without matching source]"
        : span.kind === "private"
          ? `[withheld: private verifier rendering; ${text.split("\n").length} lines]`
          : span.kind === "verifier"
            ? catalogue.verifierRedact(text, source)
            : span.kind === "implementer"
              ? catalogue.implementerRedact(text, source)
              : catalogue.factoryRedact(text, source);
    cursor = span.end;
  }
  filtered += catalogue.factoryRedact(body.slice(cursor));
  // An evidence-cell match withholds its whole acceptance row, including id and criterion.
  filtered = filtered
    .split("\n")
    .map((line) =>
      line.startsWith("| ") && /\[(?:withheld:|private detail\])/u.test(line)
        ? "[withheld: report row containing private or unconfirmed text]"
        : line,
    )
    .join("\n");
  return withoutHoldoutSection(filtered, (text) => text);
}

type LineRange = { first: number; last: number };

/** Every normalization replacement retains the source lines it consumed. */
function markdownProjection(text: string, origins: LineRange[]) {
  const replace = (pattern: RegExp, replacement: (match: RegExpExecArray) => string) => {
    const next: string[] = [];
    const mapped: LineRange[] = [];
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      next.push(text.slice(cursor, match.index));
      for (let i = cursor; i < match.index; i++) {
        const origin = origins[i];
        if (origin) mapped.push(origin);
      }
      const output = replacement(match);
      next.push(output);
      const first = origins[match.index]?.first ?? 0;
      const last = origins[match.index + match[0].length - 1]?.last ?? first;
      for (let i = 0; i < output.length; i++) mapped.push({ first, last });
      cursor = match.index + match[0].length;
    }
    next.push(text.slice(cursor));
    for (let i = cursor; i < origins.length; i++) {
      const origin = origins[i];
      if (origin) mapped.push(origin);
    }
    text = next.join("");
    origins = mapped;
  };
  replace(/&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]+;?)/gu, (match) =>
    decodeHTML(match[0]).normalize("NFKC").toLowerCase(),
  );
  replace(/\\+(?:r\\+n|[nrt])/gu, (match) => (match[0].endsWith("t") ? "\t" : "\n"));
  replace(/[\p{Cf}\u00ad]/gu, () => "");
  // Table cell line breaks are factory rendering, including within code spans.
  replace(/<br\s*\/?>/giu, () => "\n");
  // Protect code contents before classifying markup or emphasis; restore them for private matching.
  let codeMarker = "\ue000";
  while (text.includes(codeMarker)) codeMarker += "\ue000";
  const code = new Map<string, string>();
  replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/gu, (match) => {
    const token = `${codeMarker}${code.size}\ue001`;
    code.set(token, match[2] ?? "");
    return token;
  });
  if (text.includes("`")) return null;
  let unparsedMarkup = false;
  replace(/<!--[\s\S]*?-->/gu, () => "");
  replace(/<\/?(?:em|strong|b|i|u|s|code|span|sub|sup|mark|kbd|a|del|ins|small)\b[^>]*>/giu, (match) => {
    // Attributes are outside the confirmed projection; do not guess where their values end.
    if (!/^<\/?[a-z]+\s*\/?>$/iu.test(match[0])) unparsedMarkup = true;
    return "";
  });
  if (unparsedMarkup || text.includes("<")) return null;
  replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, (match) => match[1] ?? "");
  replace(/!?\[([^\]]*)\]\([^)]*\)/gu, (match) => match[1] ?? "");
  replace(/^[ \t]*(?:>[ \t]*|(?:[-+*]|\d+[.)])[ \t]+)+/gmu, () => "");
  const emphasis: string[] = [];
  let ambiguous = false;
  replace(/[*_~]+/gu, (match) => {
    // Delimiter flanking is local: a newline is whitespace, never an identifier neighbor.
    const before = match.input[match.index - 1] ?? "";
    const after = match.input[match.index + match[0].length] ?? "";
    const word = (character: string) => /[\p{L}\p{N}_]/u.test(character);
    if ([...match[0]].some((character) => character !== match[0][0])) ambiguous = true;
    if (word(before) && word(after)) {
      if (emphasis.length) ambiguous = true;
      return match[0];
    }
    const space = (character: string) => !character || /\s/u.test(character);
    const punctuation = (character: string) => /[\p{P}\p{S}]/u.test(character);
    const opens = !space(after) && (!punctuation(after) || space(before) || punctuation(before));
    const closes = !space(before) && (!punctuation(before) || space(after) || punctuation(after));
    // Only a homogeneous run with a single role and an exact pair is confirmed formatting.
    if (opens && closes) ambiguous = true;
    else if (opens) emphasis.push(match[0]);
    else if (closes) {
      if (emphasis.pop() !== match[0]) ambiguous = true;
    } else return match[0];
    return "";
  });
  if (ambiguous || emphasis.length) return null;
  replace(/\|/gu, () => "");
  for (const [token, content] of code) replace(new RegExp(token, "gu"), () => content);
  replace(/\s+/gu, (match) => (/[\r\n]/u.test(match[0]) ? "\0" : " "));
  return { text, origins };
}

function normalizeMarkdown(text: string): string | null {
  return markdownProjection(text, [])?.text.replace(/^[ \0]+|[ \0]+$/gu, "") ?? null;
}

/** Match before paging, across wraps and at every offset, then withhold original lines. */
function redactMultiline(value: string, pattern: RegExp): string | null {
  const lines = value.split("\n");
  const layers = lines.map((line) => normalizedLayers(decodeHTML(line)));
  if (layers.some((layer) => layer === null)) return null;
  const hidden = new Set<number>();
  const depth = Math.max(1, ...layers.map((layer) => layer?.length ?? 0));
  for (let layer = 0; layer < depth; layer++) {
    let text = "";
    const origins: LineRange[] = [];
    for (const [index, forms] of layers.entries()) {
      const line = forms?.[Math.min(layer, forms.length - 1)] ?? "";
      text += `${line}\n`;
      for (let i = 0; i <= line.length; i++) origins.push({ first: index, last: index });
    }
    const projection = markdownProjection(text, origins);
    if (!projection) return null;
    pattern.lastIndex = 0;
    for (const match of projection.text.matchAll(pattern)) {
      const end = match.index + (match[1] ?? match[0]).length;
      for (let i = match.index; i < end; i++) {
        const range = projection.origins[i];
        if (range) for (let line = range.first; line <= range.last; line++) hidden.add(line);
      }
    }
  }
  return lines.map((line, index) => (hidden.has(index) ? "[private detail]" : line)).join("\n");
}

function buildCatalogue(store: Factory["store"], ids: string[], dataDirectory: string): Catalogue | null {
  // Holdouts from earlier rounds remain private even after a later round delivers.
  const details = new Set<string>();
  const literals = new Set<string>();
  const proseDetails = new Set<string>();
  const verifierDetails = new Set<string>();
  const receivedSummaries = new Set<string>();
  const privateRows = new Set<string>();
  const worktrees: string[] = [];
  for (const id of ids) {
    const state = z
      .object({
        worktreePath: z.string().optional(),
        holdout: HoldoutSchema.or(z.object({ scenarios: z.tuple([]) })).optional(),
        spec: SpecSchema.nullish().catch(null),
        lastVerify: verificationText.extend({ modelOutput: verificationText.optional() }).nullish(),
        verifyResults: z
          .array(verificationText.extend({ modelOutput: verificationText.optional() }))
          .optional(),
      })
      .safeParse(store.getRunState(id) ?? {});
    if (!state.success) return null;
    worktrees.push(state.data.worktreePath ?? "");
    const { holdout, spec } = state.data;
    for (const ac of spec?.acceptance_criteria ?? [])
      if (rowKind(ac.id, spec ?? null, holdout) !== "public") privateRows.add(ac.id.trim().toUpperCase());
    const scenarios = holdout?.scenarios ?? [];
    for (const scenario of scenarios)
      for (const text of [scenario.description, scenario.steps, scenario.expected])
        if (text.trim()) verifierDetails.add(text.trim());
    // Same exemption as verifier feedback: what the run's request and spec already state is public.
    const publicSources = [store.getRun(id)?.prompt ?? "", spec ? renderSpec(spec) : "", ...errnoNames].join(
      "\n",
    );
    const standalone = {
      scenarios: scenarios.map((scenario) => ({
        ...scenario,
        description: /[\r\n\t]/u.test(scenario.description) ? "" : scenario.description,
        steps: /[\r\n\t]/u.test(scenario.steps) ? "" : scenario.steps,
        expected: /[\r\n\t]/u.test(scenario.expected) ? "" : scenario.expected,
      })),
    };
    const independent = privateHoldoutDetails(standalone, publicSources);
    const quoted = new Set(
      scenarios.flatMap((scenario) =>
        [scenario.description, scenario.steps, scenario.expected].flatMap((source) =>
          [...source.matchAll(/(["'`])(?:(?!\1)[^\n])*?\1/gu)].map((match) => match[0].slice(1, -1)),
        ),
      ),
    );
    // Legacy multiline phrases protect generic syntax in context. Literal values, paths, flags and
    // distinctive identifiers also match independently; bare numbers and assertion methods do not.
    for (const detail of privateHoldoutDetails({ scenarios }, publicSources))
      if (
        independent.has(detail) ||
        /[\r\n\t]/u.test(detail) ||
        (!/^(?:\d+(?:\.\d+)?|to(?:Be|Have|Equal|Contain|Match|Throw|Start|End)\w*)$/u.test(detail) &&
          (quoted.has(detail) ||
            detail.length >= DISTINCTIVE_LENGTH ||
            /[/_-]|[\p{L}$].*\d|\d.*[\p{L}$]/u.test(detail)))
      )
        details.add(detail);
    const harvest = (source: string) => {
      for (const literal of privateHoldoutDetails({ scenarios: [] }, publicSources, source))
        literals.add(literal);
    };
    for (const scenario of scenarios)
      for (const source of [scenario.description, scenario.steps, scenario.expected]) harvest(source);
    const collect = (observed?: string, privateProse = false, legacyShort = false) => {
      if (observed === undefined) return;
      harvest(observed);
      for (const detail of privateHoldoutDetails(standalone, publicSources, observed)) details.add(detail);
      const prose = observed.trim();
      if (privateProse && prose) verifierDetails.add(prose);
      // Keep the legacy catalogue at least as protective as before marked reports existed.
      const words = normalizeWhitespace(normalizedLayers(prose)?.at(-1) ?? prose).trim();
      if (
        privateProse &&
        words.split(" ").length > 1 &&
        (legacyShort || words.length >= DISTINCTIVE_LENGTH) &&
        !new RegExp(holdoutBoundaryPattern(prose), "iu").test(publicSources)
      )
        proseDetails.add(prose);
    };
    const collectOutput = (value: unknown, privateProse = false, legacyShort = false) => {
      if (typeof value === "string") collect(value, privateProse, legacyShort);
      else if (value && typeof value === "object")
        for (const field of Object.values(value)) collectOutput(field, privateProse, legacyShort);
    };
    collect();
    const collectVerification = (
      verify: z.output<typeof verificationText> | null | undefined,
      feedback = true,
    ) => {
      collect(verify?.notes);
      if (verify?.notes?.trim()) verifierDetails.add(verify.notes.trim());
      for (const criterion of verify?.criteria ?? []) {
        // Public acceptance evidence/summaries stay public, as in preDeliveryVerifyArtifact.
        const kind = rowKind(criterion.id, spec ?? null, holdout);
        if (kind !== "public") {
          privateRows.add(criterion.id.trim().toUpperCase());
          if (kind === "holdout") {
            details.add(criterion.id.trim());
            literals.add(criterion.id.trim());
          }
          if (
            feedback &&
            kind !== "unknown" &&
            criterion.status !== "met" &&
            criterion.status !== "blocked" &&
            !(criterion.status === "unmet" && criterion.requirement === "not_required")
          ) {
            receivedSummaries.add(
              privateVerifySummary(criterion.publicSummary ?? "", holdout, publicSources),
            );
          }
          collectOutput(
            [criterion.evidence, criterion.publicSummary, criterion.requirementCitation],
            true,
            kind === "holdout",
          );
        }
        collectOutput(criterion.gateEvidence);
      }
    };
    collectVerification(state.data.lastVerify);
    collectVerification(state.data.lastVerify?.modelOutput);
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
        collectVerification(verify.data, false);
        // Factory gate citations are not part of the model's Verify schema.
        if (fields.success)
          for (const criterion of fields.data.criteria ?? []) collectOutput(criterion.gateEvidence);
      } else if (fields.success && (fields.data.criteria || fields.data.notes !== undefined)) {
        // Incomplete verifier JSON still distinguishes public rows from private observations.
        collectVerification(fields.data, false);
      } else {
        // Only unstructured diagnostics need whole-text harvesting, including quoted JSON
        // literals that lose their quotes when parsed.
        if (diagnostic.kind !== "event") collect(diagnostic.text, true);
        collectOutput(output, true);
      }
    }
  }
  // Reports normalize before clipping. Retain historical spellings and match publication
  // copies from every round using the same roots and sanitizer order as the renderer.
  for (const entries of [details, literals, proseDetails, verifierDetails, receivedSummaries])
    for (const detail of [...entries])
      for (const worktree of worktrees)
        entries.add(sanitizePublication(redactGateOutput(detail), worktree, dataDirectory));
  const allDetails = new Set([...details, ...proseDetails]);
  // Verifier-written text is matched against every private string, including holdout phrases.
  const strict = new Set([...allDetails, ...literals, ...verifierDetails]);
  const implementer = new Set([...literals, ...receivedSummaries]);
  const retained = new Set([...allDetails, ...strict, ...implementer]);
  // Author redactors apply only to marked reports, so compile them on first use.
  const lazy = (details: Set<string>): HoldoutRedactor => {
    let built: HoldoutRedactor | undefined;
    return (value, source) => {
      built ??= buildReportRedactor(details);
      return built(value, source);
    };
  };
  return {
    redact: buildReportRedactor(allDetails, privateRows),
    verifierRedact: lazy(strict),
    implementerRedact: lazy(implementer),
    factoryRedact: lazy(literals),
    cacheable:
      retained.size <= CATALOGUE_DETAILS_CAP &&
      [...retained].reduce((size, detail) => size + detail.length, 0) <= CATALOGUE_CHARACTERS_CAP,
  };
}

export function buildReportRedactor(details: Set<string>, privateRows = new Set<string>()): HoldoutRedactor {
  // Match the exact sanitizer used before report spans and clipped sources are stored.
  details = new Set([...details].map(redactGateOutput));
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
  let invalidCatalogue = false;
  const matchForm = (detail: string) => {
    const layers = normalizedLayers(decodeHTML(detail));
    const projected = normalizeMarkdown(layers?.at(-1) ?? "");
    const normalized = normalizeWhitespace(projected ?? "");
    if (!layers || !normalized) invalidCatalogue = true;
    return normalized;
  };
  // Any phrase can wrap in a report, even if its catalogue entry is a single line.
  const multilineDetails = [...details];
  const multiline = multilineDetails.length
    ? new RegExp(
        `(?=(${multilineDetails
          .sort((a, b) => b.length - a.length)
          .map((detail) => {
            const normalized = matchForm(detail);
            const wrap = "\x00?";
            const literal = [...normalized]
              .map((character) =>
                character === " "
                  ? "[ \x00]+"
                  : character === "\0"
                    ? "[ \x00]*"
                    : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              )
              .join(wrap);
            return detail.length >= DISTINCTIVE_LENGTH
              ? literal
              : `(?<![\\p{L}\\p{N}_$])${literal}(?![\\p{L}\\p{N}_$])`;
          })
          .join("|")}))`,
        "giu",
      )
    : null;
  const holdoutRedact = (value: string): string => {
    if (invalidCatalogue) return "[withheld: private matching normalization unavailable]";
    if (!pattern && !privateRows.size) return value;
    if (multiline) {
      const matched = redactMultiline(value, multiline);
      if (matched === null)
        return `[withheld: holdout result or quotation; ${value.split("\n").length} lines]`;
      value = matched;
    }
    return value
      .split("\n")
      .map((line) => {
        if (pattern) pattern.lastIndex = 0;
        const rowId = /^\|([^|]*)\|/u
          .exec(line)?.[1]
          ?.trim()
          .replace(/^(?:[✅❌❔·]|🚧 blocked)\s+/u, "")
          .trim()
          .toUpperCase();
        return (rowId !== undefined && privateRows.has(rowId)) ||
          line.includes("[private detail]") ||
          pattern?.test(line) ||
          encoded(line) ||
          privateMatches(line, distinctive).length
          ? "[withheld: holdout result or quotation; 1 line]"
          : line;
      })
      .join("\n");
  };
  return (value, source) => {
    if (source === undefined) return holdoutRedact(value);
    // Command cells add a closing backtick after the cut; all other clipped displays are prefixes.
    const prefix = value.startsWith("`") && value.endsWith("`") ? value.slice(0, -1) : value;
    if (!source.startsWith(prefix)) return "[withheld: invalid clipped source mapping]";
    const original = source.split("\n");
    if (value.split("\n").length > original.length) return "[withheld: invalid clipped source mapping]";
    const filtered = holdoutRedact(source).split("\n");
    // A normalization failure withholds the entire source rather than individual lines.
    if (original.length !== filtered.length)
      return `[withheld: holdout result or quotation; ${value.split("\n").length} lines]`;
    return value
      .split("\n")
      .map((line, index) => (filtered[index] === original[index] ? line : filtered[index]))
      .join("\n");
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
  const catalogue =
    key && cached?.key === key ? cached.catalogue : buildCatalogue(store, ids, factory.cfg.paths.home);
  if (!catalogue) return { available: false, reason: "Holdout policy unavailable; content withheld." };
  if (key && catalogue.cacheable) catalogues.set(store, { key, catalogue });
  else catalogues.delete(store);
  const protect = (value: string) =>
    privacy(value) === value
      ? privacy(catalogue.redact(value))
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
    const normalizeNewlines = (value: string) => value.replace(/\r\n?/gu, "\n");
    const multiline = [...loadPrivateStrings().map(({ value }) => value), ...registeredCredentials()]
      .map((value) => normalizeNewlines(value.normalize("NFKC").toLowerCase()))
      .filter((value) => value.includes("\n"));
    // The patch's exact selection: a trailing slash would also exclude a gitlink, so changed
    // descendants are excluded one by one.
    const selection = (path: string) => [
      "--no-renames",
      "--ignore-submodules=none",
      baseSha,
      headSha,
      "--",
      `:(top,literal)${path}`,
      ...files
        .filter((file) => file.path.startsWith(`${path}/`))
        .map((file) => `:(top,exclude,literal)${file.path}`),
    ];
    // Inspect the blobs this selection diffs, not whatever a path lookup finds: a malformed tree
    // can hold two entries that render as the same path.
    const privateFile = async (path: string) => {
      if (!multiline.length) return false;
      const records = (await git(["diff", "--raw", "-z", "--no-abbrev", ...selection(path)])).split("\0");
      if (records.length !== 3 || records[1] !== path || records[2] !== "")
        throw new Error("Invalid Git patch selection");
      const meta = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z][0-9]*$/u.exec(
        records[0] ?? "",
      );
      if (!meta) throw new Error("Invalid Git file metadata");
      for (const [mode, oid] of [
        [meta[1], meta[3]],
        [meta[2], meta[4]],
      ]) {
        // Absent sides are all zeros; gitlinks reference commits outside this repository.
        if (!oid || /^0+$/u.test(oid) || !["100644", "100755", "120000"].includes(mode ?? "")) continue;
        // `cat-file blob` peels a tag to its target, but the patch shows the object itself.
        if ((await git(["cat-file", "-t", oid])).trim() !== "blob")
          throw new Error("Invalid Git file metadata");
        const layers = normalizedLayers(await git(["cat-file", "blob", oid]));
        if (
          !layers ||
          layers.some((layer) => multiline.some((value) => normalizeNewlines(layer).includes(value)))
        )
          return true;
      }
      return false;
    };
    // Filter complete lines before paging, then check the complete sanitized patch too.
    const privatePatch = (patch: string) => {
      const filtered = patch
        .split("\n")
        .map((line) => (privacy(line) === line ? line : "[withheld: private text; 1 line]"))
        .join("\n");
      return privacy(filtered) === filtered
        ? filtered
        : privacy(`[withheld: private text; ${patch.split("\n").length} lines]`);
    };
    const selectedPatch = async (path: string) => {
      const args = selection(path);
      if ((await git(["diff", "--name-only", "-z", ...args])) !== `${path}\0`)
        throw new Error("Invalid Git patch selection");
      return privatePatch(
        await git(["diff", "--unified=3", "--diff-algorithm=myers", "--no-indent-heuristic", ...args]),
      );
    };
    const patch =
      selected && !selected.binary && safePath(selected.path)
        ? (await privateFile(selected.path))
          ? "[withheld: private text; 1 file]"
          : await selectedPatch(selected.path)
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
                ? privacy(redactReport(report, catalogue, store.getArtifact(run, "report-sources.json")))
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
