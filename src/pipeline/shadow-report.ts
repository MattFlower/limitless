import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { GhRunner } from "../integrations/github.ts";

/** A later fix (commit) or review finding/comment, cited by `source` at ISO time `at`. */
export type HistoryRecord = { kind: "fix" | "review"; source: string; at: string; text: string };
/** A run's PR history (commits in PR order first), or null when it has no PR or it is unavailable. */
export type HistoryReader = (run: Run) => Promise<HistoryRecord[] | null>;
export type Outcome = "fixed" | "review-matched" | "converged-without-fix" | "unknown";
type Evidence = Omit<HistoryRecord, "text"> & { basis: string };
type PanelOnly = { finding: string; outcome: Outcome; evidence: Evidence[] };
type Ids = Record<"runId" | "repo" | "round" | "status", string> & { pr: string | null; createdAt: number };
/** `history` is false when some related history or review was unavailable: unmatched findings stay unknown. */
type Results = Record<"single" | "panel" | "shared", string[]> & { history: boolean; panelOnly: PanelOnly[] };
export type ShadowRow = Ids & Results & { reason?: string };

const PR_HISTORY = `[(.commits[] | {kind: "fix", source: "commit \\(.oid)", at: .committedDate, text: "\\(.messageHeadline)\\n\\(.messageBody)"}), ((.reviews + .comments)[] | {kind: "review", source: .url, at: (.submittedAt // .createdAt), text: (.body // "")})]`;

/** Read-only `gh pr view`: commits are fix records, reviews and comments review records. */
export const ghPrHistory = (gh: GhRunner): HistoryReader => {
  const fields = ["--json", "commits,reviews,comments", "--jq", PR_HISTORY];
  const view = async (u: string) => JSON.parse(String(await gh(["pr", "view", u, ...fields])));
  return async (r) => (r.prUrl ? view(r.prUrl).catch(() => null) : null);
};

type Finding = { file: string; title: string };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/._-]+/g, " ");
const label = (f: Finding) => `${f.file}: ${f.title}`;
const list = (v: unknown): Finding[] | null =>
  Array.isArray(v) && v.every((f) => typeof f?.file === "string" && typeof f.title === "string") ? v : null;
/** null for a missing artifact, undefined for a malformed one. */
export const parseArtifact = (text: string | null): Record<string, unknown> | null | undefined => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return undefined;
  }
};
const roundOf = (name: string, tag = "") => new RegExp(`^review-(-?\\d+)${tag}\\.json$`).exec(name)?.[1];

/**
 * Single vs shadow panel blocking findings per round, matched against later reviews and PR histories
 * of the run and runs depending on it or its PR. Reads only; never writes or calls a model.
 */
export async function shadowReport(store: Store, readHistory: HistoryReader): Promise<ShadowRow[]> {
  const runs = store.listRuns({ limit: Number.MAX_SAFE_INTEGER });
  const rows: ShadowRow[] = [];
  for (const run of runs) {
    const artifacts = store.listArtifacts(run.id);
    if (!artifacts.some((a) => roundOf(a.name, ".shadow"))) continue;
    const onPr = ({ sourceRef: s }: Run) =>
      s?.kind === "pull_request" && run.prUrl?.endsWith(`/pull/${s.number}`);
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
        return (found ?? []).map((f) => ({ kind: "review" as const, source, at, text: label(f), own }));
      }),
    );
    // One history per PR; this run's is needed even without a PR, as it can't be observed then.
    const byPr = new Map(related.filter((r) => r.prUrl || r.id === run.id).map((r) => [r.prUrl ?? r.id, r]));
    const histories = await Promise.all([...byPr.values()].map(readHistory));
    if (histories.includes(null)) complete = false;
    const done = run.merged || run.status === "succeeded";
    const rounds = [...new Set(artifacts.flatMap((a) => roundOf(a.name.replace(".shadow", "")) ?? []))];
    for (const round of rounds.sort((a, b) => Number(a) - Number(b))) {
      const single = list(parseArtifact(store.getArtifact(run.id, `review-${round}.json`))?.blocking);
      const shadow = parseArtifact(store.getArtifact(run.id, `review-${round}.shadow.json`));
      const panel = list(shadow?.blocking);
      const status = shadow === null ? "missing" : String(shadow?.status ?? "malformed");
      const reason = single ? shadow?.reason : "single review artifact missing or malformed";
      // Commits are placed after the reviewed commit in PR order. A rewritten history lost that commit:
      // rebased commits have new ids and times, so none is placed and the evidence is incomplete.
      const sha = `commit ${String(shadow?.reviewedSha)}`;
      const placed = histories.map((h) => [h ?? [], h?.findIndex((r) => r.source === sha) ?? -1] as const);
      const row: ShadowRow = {
        ...{ runId: run.id, repo: run.repoSlug, pr: run.prUrl, createdAt: run.createdAt, round },
        ...{ status: status === "completed" && !panel ? "malformed" : status },
        ...{ history: complete && placed.every(([, i]) => i >= 0) },
        ...(reason ? { reason: String(reason) } : {}),
        ...{ single: (single ?? []).map(label), panel: [], shared: [], panelOnly: [] },
      };
      rows.push(row);
      if (row.status !== "completed" || !panel) continue;
      // Evidence follows the shadow review in time; own reviews also by round, since a replay moves their time.
      const after = artifacts.find((a) => a.name === `review-${round}.shadow.json`)?.createdAt ?? Infinity;
      const records = [
        ...reviews.filter((r) => r.own > Number(round) || !r.source.startsWith(`run ${run.id}/`)),
        ...placed.flatMap(([h, i]) => h.filter((r, j) => (i < 0 ? r.kind === "review" : j > i))),
      ].filter((r) => Date.parse(r.at) > after);
      row.panel = panel.map(label);
      row.shared = row.panel.filter((p) => row.single.some((s) => norm(s) === norm(p)));
      for (const f of panel.filter((f) => !row.shared.includes(label(f)))) {
        const evidence = records
          .filter((r) => norm(r.text).includes(norm(f.file)) && norm(r.text).includes(norm(f.title)))
          .map(({ kind, source, at }) => ({ kind, source, at, basis: "names the file and title" }));
        const fixed = evidence.some((e) => e.kind === "fix");
        const noMatch = row.history && done ? "converged-without-fix" : "unknown";
        const outcome = fixed ? "fixed" : evidence.length ? "review-matched" : noMatch;
        row.panelOnly.push({ finding: label(f), outcome, evidence });
      }
    }
  }
  return rows;
}

/** Rows for runs created at or after `since` (ms), as text. */
export function formatShadowReport(rows: ShadowRow[], since?: number): string {
  const join = (items: string[]) => items.join("; ") || "none";
  const kept = rows.filter((r) => since === undefined || r.createdAt >= since);
  if (!kept.length) return "No shadow review comparisons.";
  return kept
    .flatMap((r) => [
      `${r.runId} ${r.repo}${r.pr ? ` ${r.pr}` : ""} round ${r.round}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.history ? "" : "; evidence incomplete"}`,
      `  single blocking: ${join(r.single)}`,
      ...(r.status === "completed"
        ? [`  panel blocking: ${join(r.panel)}`, `  shared: ${join(r.shared)}`]
        : []),
      ...r.panelOnly.flatMap((p) => [
        `  panel-only ${p.finding}: ${p.outcome}`,
        ...p.evidence.map((e) => `    ${e.kind} ${e.source} @ ${e.at} (${e.basis})`),
      ]),
    ])
    .join("\n");
}
