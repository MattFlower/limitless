import { z } from "zod";
import type { Factory } from "../app.ts";
import { privateMatches } from "../gates/private.ts";
import { worktreeGit } from "../git/command.ts";
import { cachePath } from "../git/repos.ts";
import { privateHoldoutDetails } from "../pipeline/prompts.ts";
import { type Holdout, HoldoutSchema } from "../pipeline/schemas.ts";
import { loadOutputPrivacy, privateOutputData } from "../util/private-output.ts";

export const commitSha = z.string().regex(/^[a-fA-F0-9]{40}$/);
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
  const headSha = snapshot.data.headRefOid;
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
  const holdouts: Holdout[] = [];
  for (const id of [owner.id, ...rounds.map((round) => round.runId)]) {
    const state = z.object({ holdout: HoldoutSchema.optional() }).safeParse(store.getRunState(id) ?? {});
    if (!state.success) return { available: false, reason: "Holdout policy unavailable; content withheld." };
    if (state.data.holdout) holdouts.push(state.data.holdout);
  }
  const holdoutEntries = holdouts
    .flatMap((holdout) => [
      ...privateHoldoutDetails(holdout),
      ...holdout.scenarios.flatMap((s) => [s.id, s.description, s.steps, s.expected]),
    ])
    .map((value) => ({ value, entry: 0 }));
  const protect = (value: string) => {
    if (privateMatches(value, holdoutEntries).length) return "[withheld: holdout text]";
    return privacy(value);
  };
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
    const counts = await git(["diff", "--no-renames", "--numstat", "-z", baseSha, headSha, "--"]);
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
              "--unified=3",
              "--diff-algorithm=myers",
              "--no-indent-heuristic",
              baseSha,
              headSha,
              "--",
              `:(literal)${selected.path}`,
            ]),
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
        : { run, available: true, ...page(protect(report), q.reportOffset, REPORT_CAP) };
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
    if (!current || JSON.parse(current).headRefOid !== headSha)
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
