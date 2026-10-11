import { constants } from "node:os";
import { z } from "zod";
import type { Factory } from "../app.ts";
import { ownerDiagnostics } from "../db/owner-diagnostics.ts";
import { normalizedLayers, privateMatches } from "../gates/private.ts";
import { worktreeGit } from "../git/command.ts";
import { cachePath } from "../git/repos.ts";
import { holdoutBoundaryPattern, privateHoldoutDetails } from "../pipeline/prompts.ts";
import { HoldoutSchema, renderSpec, rowKind, SpecSchema } from "../pipeline/schemas.ts";
import { loadOutputPrivacy, privateOutputData } from "../util/private-output.ts";
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
// Platform error names are public diagnostics, as in verifier feedback.
const errnoNames = Object.keys(constants.errno);
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
 * Header lines (whose only free text is the already-vetted path) and hunk ranges are Git's
 * own structure; holdout redaction applies to code lines and hunk context only.
 */
function patchStructure() {
  let header = true;
  return (line: string) => {
    if (line.startsWith("diff --git ")) header = true;
    const hunk = /^@@ [^@]* @@/.exec(line);
    if (hunk) header = false;
    return header ? line.length : (hunk?.[0].length ?? 0);
  };
}

/**
 * The rendered report clips holdout scenarios, so phrase matching cannot vet them; drop the
 * whole section. It always precedes the Checks heading, and any earlier or later lookalike
 * headings only widen what is dropped.
 */
function withoutHoldoutSection(report: string) {
  const start = report.indexOf("## Holdout scenarios");
  if (start < 0) return report;
  const end = report.lastIndexOf("\n\n## Checks");
  return `${report.slice(0, start)}[Holdout scenarios withheld from agents]${end > start ? report.slice(end) : "\n"}`;
}

/** Saved observations only: no fetch, working-tree bytes, arbitrary paths, or artifact reads. */
export async function getChange(factory: Factory, input: unknown, signal?: AbortSignal) {
  const privacy = loadOutputPrivacy();
  if (!privacy) return { available: false, reason: "Privacy policy unavailable; content withheld." };
  const query = ChangeQuerySchema.safeParse(input);
  if (!query.success) return { available: false, reason: "Invalid change-view request." };
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
  const head = reviewableHead(
    snapshot.data.headRefOid,
    recorded && { ...recorded, pushing: store.pushingTo(owner.prUrl ?? "") },
  );
  if (head.problem)
    return { available: false, reason: `PR head ${head.problem}; restart limitless_get_change.` };
  const headSha = head.headSha;
  if (q.headSha && q.headSha !== headSha)
    return { available: false, reason: "PR head superseded; restart limitless_get_change." };
  const baseBranch = snapshot.data.baseRefName ?? owner.baseBranch;
  const parsedComparison = commitSha.safeParse(snapshot.data.baseRefOid ?? owner.baseSha);
  if (!parsedComparison.success || !baseBranch)
    return { available: false, reason: "Recorded comparison unavailable." };
  const comparison = parsedComparison.data;
  const repo = store.getRepo(owner.repoId);
  if (!repo) return { available: false, reason: "Repository unavailable." };
  const rounds = owner.prUrl ? store.reviewRounds(owner.prUrl) : [];
  // Holdouts from earlier rounds remain private even after a later round delivers.
  const details = new Set<string>();
  for (const id of [owner.id, ...rounds.map((round) => round.runId)]) {
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
    if (!state.success) return { available: false, reason: "Holdout policy unavailable; content withheld." };
    const { holdout, spec } = state.data;
    if (!holdout?.scenarios.length) continue;
    // Same exemption as verifier feedback: what the run's request and spec already state is public.
    const publicSources = [store.getRun(id)?.prompt ?? "", spec ? renderSpec(spec) : "", ...errnoNames].join(
      "\n",
    );
    const collect = (observed?: string) => {
      for (const detail of privateHoldoutDetails(holdout, publicSources, observed)) {
        details.add(detail);
        // Patch prefixes interrupt whole multiline phrases. Protect each constituent line
        // before paging, including prose without syntax-shaped literals.
        if (/[\r\n]/u.test(detail))
          for (const line of detail.split(/\r?\n/u)) if (line.trim()) details.add(line.trim());
      }
    };
    const collectOutput = (value: unknown) => {
      if (typeof value === "string") collect(value);
      else if (value && typeof value === "object")
        for (const field of Object.values(value)) collectOutput(field);
    };
    collect();
    const collectVerification = (verify: z.output<typeof verificationText> | null | undefined) => {
      collect(verify?.notes);
      for (const criterion of verify?.criteria ?? []) {
        // Public acceptance evidence/summaries stay public, as in preDeliveryVerifyArtifact.
        if (rowKind(criterion.id, spec ?? null, holdout) !== "public")
          collectOutput([criterion.evidence, criterion.publicSummary, criterion.requirementCitation]);
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
      // Result/error copies are the exact text redacted by the invocation boundary,
      // including quoted JSON literals that lose their quotes when parsed.
      if (diagnostic.kind !== "event") collect(diagnostic.text);
      let output: unknown = diagnostic.text;
      try {
        output = JSON.parse(diagnostic.text);
      } catch {
        /* Plain verifier diagnostics are also private. */
      }
      collectOutput(output);
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
  // Any detail, however short, that appears once text is decoded or normalized withholds the value.
  const encoded = (text: string) => {
    const layers = normalizedLayers(text);
    return !layers || layers.some((layer) => boundary?.test(layer));
  };
  const holdoutRedact = (value: string, keep?: (line: string) => number) => {
    if (!pattern) return value;
    let removed = 0;
    let hidden = false;
    const replace = (text: string) => {
      const replaced = text.replace(pattern, () => {
        removed++;
        return "[private detail]";
      });
      if (encoded(replaced)) hidden = true;
      return replaced;
    };
    const safe = keep
      ? value
          .split("\n")
          .map((line) => {
            const kept = keep(line);
            return line.slice(0, kept) + replace(line.slice(kept));
          })
          .join("\n")
      : replace(value);
    if (hidden || privateMatches(safe, distinctive).length) return "[withheld: holdout text]";
    return removed ? `${safe}${keep ? "\n" : " "}[${removed} private details withheld]` : safe;
  };
  const protect = (value: string, keep?: (line: string) => number) => privacy(holdoutRedact(value, keep));
  const safe = (value: string) => protect(value) === value;
  const cwd = cachePath(factory.cfg.paths, repo);
  const git = async (args: string[]) =>
    (await worktreeGit(["git", ...args], { cwd, signal, redactOutput: false })).stdout;
  try {
    await git(["cat-file", "-e", `${headSha}^{commit}`]);
    await git(["cat-file", "-e", `${comparison}^{commit}`]);
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
    const patch =
      selected && !selected.binary && safe(selected.path) && safe(JSON.stringify(selected.path))
        ? protect(
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
            patchStructure(),
          )
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
            ...page(protect(withoutHoldoutSection(report)), q.reportOffset, REPORT_CAP),
          };
    });
    const listing = [];
    let size = 0;
    for (const file of files.slice(q.filesOffset, q.filesOffset + FILES_CAP)) {
      const entry = { ...file, path: protect(file.path) };
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
      return { available: false, reason: "PR head superseded; restart limitless_get_change." };
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
