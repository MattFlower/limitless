import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { GhRunner } from "../integrations/github.ts";

type Cited = Record<"source" | "at" | "text", string>;
export type HistoryRecord = Cited & { kind: "commit" | "review"; files?: string[] };
export type HistoryReader = (run: Run) => Promise<HistoryRecord[] | null>;
export type Outcome = "fixed" | "review-matched" | "converged-without-fix" | "unknown";
type Evidence = Omit<HistoryRecord, "text" | "files"> & { basis: string };
const BASIS = { commit: "explicit fix, file/title and file change", review: "names the file and title" };
type PanelOnly = { finding: string; outcome: Outcome; evidence: Evidence[] };
type Ids = Record<"runId" | "repo" | "round" | "status", string> & { pr: string | null; createdAt: number };
type Results = Record<"single" | "panel" | "shared", string[]> & { history: boolean; panelOnly: PanelOnly[] };
export type ShadowRow = Ids & Results & { reason?: string };
const PR_HISTORY = `[(.commits[] | {kind: "commit", oid: .oid, source: "commit \\(.oid)", at: .committedDate, text: "\\(.messageHeadline)\\n\\(.messageBody)"}), ((.reviews + .comments)[] | {kind: "review", source: .url, at: (.submittedAt // .createdAt), text: (.body // "")})]`;
const VIEW = ["--json", "commits,reviews,comments", "--jq", PR_HISTORY];
export const ghPrHistory = (gh: GhRunner): HistoryReader => {
  const json = async (args: string[]) => JSON.parse(String(await gh(args)));
  const view = async ({ prUrl, repoSlug }: Run): Promise<HistoryRecord[]> => {
    const records: (HistoryRecord & { oid?: string })[] = await json(["pr", "view", `${prUrl}`, ...VIEW]);
    for (const c of records.filter((c) => c.oid)) {
      c.files = await json(["api", `repos/${repoSlug}/commits/${c.oid}`, "--jq", "[.files[].filename]"]);
      if (!c.files?.every((f) => typeof f === "string")) throw new Error(`no file list for commit ${c.oid}`);
    }
    return records;
  };
  return async (r) => (r.prUrl ? view(r).catch(() => null) : null);
};
type Finding = { file: string; title: string };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/._-]+/g, " ");
const label = (f: Finding) => `${f.file}: ${f.title}`;
const names = (text: string, f: Finding) => [f.file, f.title].every((s) => norm(text).includes(norm(s)));
const UNFIXED =
  /\b(not|never|unfixed|unresolved|defer(?:red)?|diagnostics?|pending|remains?|still|later|planned|todo)\b/i;
const fixes = (text: string, f: Finding) =>
  !UNFIXED.test(text) &&
  text
    .split(/[\n;]+/)
    .some((line) => /^(fix(?:es|ed)?|resolve[sd]?)(\([^)]*\))?:?\s/i.test(line.trim()) && names(line, f));
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
export async function shadowReport(store: Store, readHistory: HistoryReader): Promise<ShadowRow[]> {
  const runs = store.listRuns({ limit: Number.MAX_SAFE_INTEGER });
  const rows: ShadowRow[] = [];
  for (const run of runs) {
    const artifacts = store.listArtifacts(run.id);
    if (!artifacts.some((a) => roundOf(a.name, ".shadow"))) continue;
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
        return (found ?? []).map((f) => ({ kind: "review" as const, source, at, text: label(f), own }));
      }),
    );
    // One history per PR; this run's is needed even without a PR, as it can't be observed then.
    const byPr = new Map(related.filter((r) => r.prUrl || r.id === run.id).map((r) => [r.prUrl ?? r.id, r]));
    const histories = await Promise.all(
      [...byPr.values()].map(async (r) => [r, await readHistory(r).catch(() => null)] as const),
    );
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
      const records = [
        ...reviews.filter((r) => r.own > Number(round) || !r.source.startsWith(`run ${run.id}/`)),
        ...placed.flatMap(([h, i]) => h.filter((r, j) => r.kind === "review" || j > i)),
      ].filter((r) => Date.parse(r.at) > after);
      row.panel = panel.map(label);
      row.shared = row.panel.filter((p) => row.single.some((s) => norm(s) === norm(p)));
      for (const f of panel.filter((f) => !row.shared.includes(label(f)))) {
        const evidence: Evidence[] = records
          .filter((r) => names(r.text, f))
          .filter((r) => r.kind === "review" || (r.files?.includes(f.file) && fixes(r.text, f)))
          .map(({ kind, source, at }) => ({ kind, source, at, basis: BASIS[kind] }));
        const fixed = evidence.some((e) => e.kind === "commit");
        const noMatch = row.history && done ? "converged-without-fix" : "unknown";
        const outcome = fixed ? "fixed" : evidence.length ? "review-matched" : noMatch;
        row.panelOnly.push({ finding: label(f), outcome, evidence });
      }
    }
  }
  return rows;
}
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
        ...p.evidence.map((e) => `    ${e.source} @ ${e.at} (${e.basis})`),
      ]),
    ])
    .join("\n");
}
