import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { GhRunner } from "../integrations/github.ts";

type Spot = { file: string; line?: number | null };
export type HistoryRecord = Record<"source" | "at", string> & {
  kind: "commit" | "review";
  spots: Spot[];
  author?: string | null;
};
export type HistoryReader = (run: Run) => Promise<HistoryRecord[] | null>;
export type Outcome = "fixed" | "review-matched" | "converged-without-fix" | "unknown";
type Evidence = Omit<HistoryRecord, "spots" | "author"> & { basis: string };
const BASIS = { commit: "changes lines within 5 of it", review: "reports the same file within 5 lines" };
type PanelOnly = { finding: string; outcome: Outcome; evidence: Evidence[] };
type Ids = Record<"runId" | "repo" | "round" | "status", string> & { pr: string | null; createdAt: number };
type Results = Record<"single" | "panel" | "shared", string[]> & { history: boolean; panelOnly: PanelOnly[] };
export type ShadowRow = Ids & Results & { reason?: string };
/** Lines a unified-diff patch removes (old numbering) or adds (new numbering); context lines are not changes. */
export function changedLines(patch: string): number[] {
  const lines: number[] = [];
  let [old, now] = [0, 0];
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) [old, now] = [Number(hunk[1]), Number(hunk[2])];
    else if (text.startsWith("+")) lines.push(now++);
    else if (text.startsWith("-")) lines.push(old++);
    else if (text.startsWith(" ")) [old, now] = [old + 1, now + 1];
  }
  return lines;
}
const COMMENTS =
  ".[] | {author: .user.login, file: .path, line: (.line // .original_line), source: .html_url, at: .created_at}";
const COMMITS = ["--json", "commits", "--jq", "[.commits[] | {oid, at: .committedDate}]"];
const PATCHES = ["--jq", "[.files[] | {filename, patch}]"];
type Patch = { filename: string; patch?: string | null };
export const ghPrHistory = (gh: GhRunner): HistoryReader => {
  const json = async (args: string[]) => JSON.parse(String(await gh(args)));
  const view = async ({ prUrl, repoSlug }: Run): Promise<HistoryRecord[]> => {
    const commits: { oid: string; at: string }[] = await json(["pr", "view", `${prUrl}`, ...COMMITS]);
    const records: HistoryRecord[] = [];
    for (const { oid, at } of commits) {
      const files: Patch[] = await json(["api", `repos/${repoSlug}/commits/${oid}`, ...PATCHES]);
      const spots = files.flatMap((f): Spot[] =>
        f.patch === undefined || f.patch === null
          ? [{ file: f.filename, line: null }]
          : changedLines(f.patch).map((line) => ({ file: f.filename, line })),
      );
      records.push({ kind: "commit", source: `commit ${oid}`, at, spots });
    }
    const pr = `repos/${repoSlug}/pulls/${prUrl?.split("/pull/")[1]}/comments`;
    const comments = String(await gh(["api", "--paginate", pr, "--jq", COMMENTS])).split("\n");
    for (const line of comments.filter(Boolean)) {
      const { file, line: at, ...c } = JSON.parse(line);
      records.push({ kind: "review", ...c, spots: [{ file, line: at }] });
    }
    return records;
  };
  return async (r) => (r.prUrl ? view(r).catch(() => null) : null);
};
type Finding = { file: string; title: string; line?: number };
const label = (f: Finding) => `${f.file}:${f.line ?? "?"}: ${f.title}`;
const path = (file: string) => file.replace(/^(\.\/)+/, "");
/** As the review grader: the same file, both lines known, at most 5 apart. */
const near = (f: Finding, s: Spot, [a, b] = [f.line ?? 0, s.line ?? 0]) =>
  path(f.file) === path(s.file) && a > 0 && b > 0 && Math.abs(a - b) <= 5;
const list = (v: unknown): Finding[] | null =>
  Array.isArray(v) && v.every((f) => typeof f?.file === "string" && typeof f.title === "string") ? v : null;
export const parseArtifact = (text: string | null): Record<string, unknown> | null | undefined => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return undefined;
  }
};
const roundOf = (name: string, tag = "") => new RegExp(`^review-(-?\\d+)${tag}\\.json$`).exec(name)?.[1];
export type ShadowReport = { rows: ShadowRow[]; limit: number; capped: boolean };
export async function shadowReport(
  store: Store,
  readHistory: HistoryReader,
  { since = 0, limit = 200, trusted = [] as string[] } = {},
): Promise<ShadowReport> {
  const runs = store.listRuns({ limit: Number.MAX_SAFE_INTEGER });
  const shadowed = runs.filter(
    (r) => r.createdAt >= since && store.listArtifacts(r.id).some((a) => roundOf(a.name, ".shadow")),
  );
  const cache = new Map<string, Promise<HistoryRecord[] | null>>();
  const read = (r: Run) => {
    const key = r.prUrl ?? r.id;
    const history = cache.get(key) ?? readHistory(r).catch(() => null);
    cache.set(key, history);
    return history;
  };
  const rows: ShadowRow[] = [];
  for (const run of shadowed.slice(0, limit)) {
    const artifacts = store.listArtifacts(run.id);
    const trust = new Set([run.repoSlug.split("/")[0], ...trusted].map((login) => login?.toLowerCase()));
    const onPr = ({ sourceRef: s }: Run) =>
      s?.kind === "pull_request" && s.repo === run.repoSlug && run.prUrl?.endsWith(`/pull/${s.number}`);
    const related = runs.filter(
      (r) => r.repoId === run.repoId && (r.id === run.id || r.dependsOn.includes(run.id) || onPr(r)),
    );
    let complete = true;
    const reviews = related.flatMap((r) =>
      store.listArtifacts(r.id).flatMap(({ name, createdAt }) => {
        const round = roundOf(name);
        if (round === undefined) return [];
        const found = list(parseArtifact(store.getArtifact(r.id, name))?.findings);
        if (!found) complete = false;
        const [source, at, own] = [`run ${r.id}/${name}`, new Date(createdAt).toISOString(), Number(round)];
        return (found ?? []).map((f) => ({ kind: "review" as const, source, at, spots: [f], own }));
      }),
    );
    // One history per PR; this run's is needed even without a PR, as it can't be observed then.
    const byPr = new Map(related.filter((r) => r.prUrl || r.id === run.id).map((r) => [r.prUrl ?? r.id, r]));
    const histories = await Promise.all([...byPr.values()].map(async (r) => [r, await read(r)] as const));
    const done = run.merged || run.status === "succeeded";
    const rounds = [...new Set(artifacts.flatMap((a) => roundOf(a.name.replace(".shadow", "")) ?? []))];
    for (const round of rounds.sort((a, b) => Number(a) - Number(b))) {
      const single = list(parseArtifact(store.getArtifact(run.id, `review-${round}.json`))?.blocking);
      const shadow = parseArtifact(store.getArtifact(run.id, `review-${round}.shadow.json`));
      const panel = list(shadow?.blocking);
      const status = shadow === null ? "missing" : String(shadow?.status ?? "malformed");
      const reason = single ? shadow?.reason : "single review artifact missing or malformed";
      const after = artifacts.find((a) => a.name === `review-${round}.shadow.json`)?.createdAt ?? Infinity;
      // Original/stacked PRs use commit order; distinct follow-ups need a later run and commit time.
      const sha = `commit ${String(shadow?.reviewedSha)}`;
      const placed = histories.map(([owner, h]) => {
        if (!h) complete = false;
        const i = h?.findIndex((r) => r.source === sha) ?? -1;
        const follow = owner.prUrl !== run.prUrl && owner.createdAt > after;
        return [h ?? [], i >= 0 ? i : follow ? -1 : Infinity] as const;
      });
      const row: ShadowRow = {
        ...{ runId: run.id, repo: run.repoSlug, pr: run.prUrl, createdAt: run.createdAt, round },
        ...{ status: status === "completed" && !panel ? "malformed" : status },
        ...{ history: complete && single !== null && placed.every(([, i]) => i !== Infinity) },
        ...(reason ? { reason: String(reason) } : {}),
        ...{ single: (single ?? []).map(label), panel: [], shared: [], panelOnly: [] },
      };
      rows.push(row);
      if (row.status !== "completed" || !panel) continue;
      // Evidence follows the shadow review in time; own reviews also by round, since a replay moves their time.
      // Commits after the reviewed one are later by PR order alone: Git stamps whole seconds, so their
      // time can read as earlier than an artifact written in the same second.
      const later = (r: { at: string }) => Date.parse(r.at) > after;
      const records = [
        ...reviews
          .filter((r) => r.own > Number(round) || !r.source.startsWith(`run ${run.id}/`))
          .filter(later),
        ...placed.flatMap(([h, i]) =>
          h.filter((r, j) =>
            r.kind === "review"
              ? trust.has(r.author?.toLowerCase()) && later(r)
              : j > i && (i >= 0 || later(r)),
          ),
        ),
      ];
      row.panel = panel.map(label);
      row.shared = panel.filter((f) => (single ?? []).some((s) => near(f, s))).map(label);
      const settled = row.history && done;
      for (const f of panel.filter((f) => !row.shared.includes(label(f)))) {
        const evidence: Evidence[] = records
          .filter((r) => r.spots.some((spot) => near(f, spot)))
          .map(({ kind, source, at }) => ({ kind, source, at, basis: BASIS[kind] }));
        const fixed = evidence.some((e) => e.kind === "commit");
        // A later commit changed this file but its patch is unavailable: no evidence either way.
        const unseen = (s: Spot) => s.line == null && path(s.file) === path(f.file);
        const blind = !fixed && records.some((r) => r.kind === "commit" && r.spots.some(unseen));
        if (blind) row.history = false;
        const noMatch = settled && !blind ? "converged-without-fix" : "unknown";
        const outcome = fixed ? "fixed" : evidence.length ? "review-matched" : noMatch;
        row.panelOnly.push({ finding: label(f), outcome, evidence });
      }
    }
  }
  return { rows, limit, capped: shadowed.length > limit };
}
export function formatShadowReport({ rows, limit, capped }: ShadowReport): string {
  const join = (items: string[]) => items.join("; ") || "none";
  if (!rows.length) return "No shadow review comparisons.";
  const output = rows
    .flatMap((r) => [
      `${r.runId} ${r.repo}${r.pr ? ` ${r.pr}` : ""} round ${r.round}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.history ? "" : "; evidence incomplete"}`,
      `  single blocking: ${join(r.single)}`,
      ...(r.status === "completed"
        ? [`  panel blocking: ${join(r.panel)}`, `  shared: ${join(r.shared)}`]
        : []),
      ...r.panelOnly.flatMap((p) => [
        `  panel-only ${p.finding}: ${p.outcome}`,
        ...p.evidence.map((e) => `    ${e.source} @ ${e.at} (${e.basis})`),
      ]),
    ])
    .join("\n");
  return (capped ? `Showing the newest ${limit} runs; older runs were left out.\n` : "") + output;
}
