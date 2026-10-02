import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { GhRunner } from "../integrations/github.ts";

/** A later fix (commit) or review finding/comment, cited by `source` at a time or revision `at`. */
export type HistoryRecord = { kind: "fix" | "review"; source: string; at: string; text: string };
/** A run's PR history, or null when it has no PR or the history is unavailable. */
export type HistoryReader = (run: Run) => Promise<HistoryRecord[] | null>;
export type Outcome = "fixed" | "review-matched" | "converged-without-fix" | "unknown";
type Evidence = Omit<HistoryRecord, "text"> & { basis: string };
type Found = { single: string[]; panel: string[]; shared: string[] };
/** `history` is false when the PR history could not be read: unmatched findings stay unknown. */
export type ShadowRow = Found & { runId: string; repo: string; pr: string | null; createdAt: number } & {
  round: string;
  status: string;
  reason?: string;
  history: boolean;
  panelOnly: { finding: string; outcome: Outcome; evidence: Evidence[] }[];
};

const PR_HISTORY = `[(.commits[] | {kind: "fix", source: "commit \\(.oid)", at: .committedDate, text: "\\(.messageHeadline)\\n\\(.messageBody)"}), ((.reviews + .comments)[] | {kind: "review", source: .url, at: (.submittedAt // .createdAt), text: (.body // "")})]`;

/** Read-only `gh pr view`: commits are fix records, reviews and comments review records. */
export const ghPrHistory =
  (gh: GhRunner): HistoryReader =>
  async (run) =>
    run.prUrl
      ? gh(["pr", "view", run.prUrl, "--json", "commits,reviews,comments", "--jq", PR_HISTORY])
          .then((out) => JSON.parse(String(out)))
          .catch(() => null)
      : null;

type Finding = { file: string; title: string };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/._-]+/g, " ");
const label = (f: Finding) => `${f.file}: ${f.title}`;
/** null for a missing artifact, undefined for a malformed one. */
export const parseArtifact = (text: string | null) => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return undefined;
  }
};
const list = (value: unknown): Finding[] => (Array.isArray(value) ? value : []);
const roundOf = (name: string, suffix = "") =>
  new RegExp(`^review-(-?\\d+)${suffix}\\.json$`).exec(name)?.[1];

/**
 * Single vs shadow panel blocking findings per round, and what later reviews (this run's, runs on its PR
 * or depending on it) and PR history say about panel-only ones. Evidence must name the finding's file
 * and title; only a fix counts as fixed. Reads the store and history; never writes or calls a model.
 */
export async function shadowReport(store: Store, readHistory: HistoryReader): Promise<ShadowRow[]> {
  const runs = store.listRuns({ limit: Number.MAX_SAFE_INTEGER });
  const rows: ShadowRow[] = [];
  for (const run of runs) {
    const names = store.listArtifacts(run.id).map((a) => a.name);
    if (!names.some((n) => roundOf(n, ".shadow"))) continue;
    const pr = /\/pull\/(\d+)$/.exec(run.prUrl ?? "")?.[1];
    const onPr = (r: Run) => r.sourceRef?.kind === "pull_request" && String(r.sourceRef.number) === pr;
    const related = runs.filter(
      (r) => r.repoId === run.repoId && (r.id === run.id || r.dependsOn.includes(run.id) || onPr(r)),
    );
    const reviewsAfter = (round: number): HistoryRecord[] =>
      related.flatMap((r) =>
        store.listArtifacts(r.id).flatMap(({ name }) => {
          const n = roundOf(name);
          if (n === undefined || (r.id === run.id && Number(n) <= round)) return [];
          const review = parseArtifact(store.getArtifact(r.id, name));
          const [at, source] = [String(review?.reviewedSha), `run ${r.id}/${name}`];
          return list(review?.findings).map(
            (f: Finding): HistoryRecord => ({ kind: "review", source, at, text: label(f) }),
          );
        }),
      );
    const history = await readHistory(run);
    const done = run.merged || run.status === "succeeded";
    const rounds = [...new Set(names.flatMap((n) => roundOf(n) ?? roundOf(n, ".shadow") ?? []))];
    for (const round of rounds.sort((a, b) => Number(a) - Number(b))) {
      const single = parseArtifact(store.getArtifact(run.id, `review-${round}.json`));
      const shadow = parseArtifact(store.getArtifact(run.id, `review-${round}.shadow.json`));
      const status = shadow === null ? "missing" : (shadow?.status ?? "malformed");
      const reason = single ? shadow?.reason : "single review artifact missing or malformed";
      const row: ShadowRow = {
        ...{ runId: run.id, repo: run.repoSlug, pr: run.prUrl, createdAt: run.createdAt, round, status },
        ...(reason ? { reason: String(reason) } : {}),
        ...{ history: history !== null, single: list(single?.blocking).map(label) },
        ...{ panel: [], shared: [], panelOnly: [] },
      };
      rows.push(row);
      if (status !== "completed") continue;
      const records = [...reviewsAfter(Number(round)), ...(history ?? [])];
      for (const f of Array.isArray(shadow.blocking) ? shadow.blocking : [null]) {
        if (typeof f?.file !== "string" || typeof f.title !== "string") {
          row.status = "malformed";
          break;
        }
        row.panel.push(label(f));
        if (row.single.some((s) => norm(s) === norm(label(f)))) {
          row.shared.push(label(f));
          continue;
        }
        const evidence = records
          .filter((r) => norm(r.text).includes(norm(f.file)) && norm(r.text).includes(norm(f.title)))
          .map(({ text: _text, ...r }) => ({ ...r, basis: "names the file and title" }));
        const outcome: Outcome = evidence.some((e) => e.kind === "fix")
          ? "fixed"
          : evidence.length
            ? "review-matched"
            : history && done
              ? "converged-without-fix"
              : "unknown";
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
      `${r.runId} ${r.repo}${r.pr ? ` ${r.pr}` : ""} round ${r.round}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.history ? "" : "; PR history unavailable"}`,
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
