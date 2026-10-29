import type { Run } from "../src/core/types.ts";
import { closedIssues, type Store } from "../src/db/store.ts";

type DecisionRun = Pick<
  Run,
  "id" | "status" | "source" | "sourceRef" | "prompt" | "repoSlug" | "createdAt" | "finishedAt"
>;

// Frozen pre-batch linkage rule, independent of the production predicate and ownership query.
function links(run: DecisionRun, store: Store): { repo: string; number: number }[] {
  const owner = store.reviewRound(run.id)?.owner;
  if (owner) return links(owner, store);
  const ref = run.sourceRef;
  if (ref?.kind === "review-round") return [];
  if (ref?.kind === "issue")
    return typeof ref.repo === "string" &&
      typeof ref.number === "number" &&
      Number.isSafeInteger(ref.number) &&
      ref.number > 0
      ? [{ repo: ref.repo, number: ref.number }]
      : [];
  return run.source !== "github"
    ? [...closedIssues(run.prompt)].map((number) => ({ repo: run.repoSlug, number }))
    : [];
}

/** Original SELECT and eager state hydration. Retain only decision fields after parsing each state. */
export function legacyLatestIssueRun(store: Store, repo: string, number: number): DecisionRun | null {
  const rows = store.db
    .query(`SELECT runs.*, repos.slug AS repo_slug FROM runs JOIN repos ON repos.id = runs.repo_id WHERE
      (json_extract(runs.source_ref, '$.kind') = 'issue'
        AND lower(json_extract(runs.source_ref, '$.repo')) = lower(?)
        AND json_extract(runs.source_ref, '$.number') = ?)
      OR (lower(repos.slug) = lower(?) AND runs.source != 'github' AND runs.prompt LIKE '%closes%')
      OR runs.id IN (SELECT run_id FROM review_rounds)
      ORDER BY runs.created_at DESC, runs.rowid DESC`)
    .all(repo, number, repo) as Record<string, unknown>[];
  const runs = rows.map((row): DecisionRun => {
    if (typeof row.state_json === "string") JSON.parse(row.state_json);
    return {
      id: row.id as string,
      status: row.status as Run["status"],
      source: row.source as Run["source"],
      sourceRef: typeof row.source_ref === "string" ? JSON.parse(row.source_ref) : null,
      prompt: row.prompt as string,
      repoSlug: row.repo_slug as string,
      createdAt: row.created_at as number,
      finishedAt: row.finished_at as number | null,
    };
  });
  return (
    runs.find((run) =>
      links(run, store).some(
        (link) => link.repo.toLowerCase() === repo.toLowerCase() && link.number === number,
      ),
    ) ?? null
  );
}
