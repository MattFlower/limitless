/** Offline queue comparison: bun scripts/benchmark-issue-queue.ts
 * Same 3,000-run in-memory fixture for both paths. Before: the removed all-run observation
 * seed plus batched selection. After: snapshot-only comparison initialization plus the same
 * batched selection (including owner decision fields). Both include claim/failure/eligibility
 * reads. Fixture setup, lifecycle reconciliation and external I/O are excluded.
 * One warmup and three alternating trials; GC only between evaluations. No timing assertions.
 */
import type { Run } from "../src/core/types.ts";
import { type IssueRunSummary, LATEST_ISSUE_RUNS_SQL, linkedIssues, Store } from "../src/db/store.ts";
import { issueEligibility, type QueueIssue } from "../src/integrations/issue-queue.ts";

const store = new Store(":memory:");
try {
  const repos = ["example/project", "example/other", "example/third"].map((slug) =>
    store.upsertRepo({
      slug,
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    }),
  );
  const repo = repos[0];
  if (!repo) throw new Error("missing benchmark repository");
  const issues: QueueIssue[] = Array.from({ length: 60 }, (_, i) => ({
    number: i + 1,
    title: `Issue ${i + 1}`,
    body: "Implement the requested change.",
    state: "OPEN",
    author: { login: "maintainer" },
    editor: null,
    lastEditedAt: null,
    parent: null,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    comments: { nodes: [], totalCount: 0 },
    labels: { nodes: [{ name: "priority:1" }], totalCount: 1 },
    subIssuesSummary: { total: 0 },
    subIssues: { totalCount: 0, nodes: [] },
    blockedBy: { nodes: [], totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [], totalCount: 0 },
    timelineItems: {
      nodes: [
        {
          __typename: "LabeledEvent",
          label: { name: "priority:1" },
          actor: { login: "maintainer" },
          createdAt: new Date(1).toISOString(),
        },
      ],
      totalCount: 1,
    },
  }));
  const payload = (kib: number) =>
    JSON.stringify({
      flow: "build",
      spec: { summary: "Synthetic specification" },
      gateHistory: Array.from({ length: kib / 4 }, (_, i) => ({
        round: i,
        name: "test",
        output: "gate output and review feedback ".repeat(132),
      })),
    });
  const states = [payload(16), payload(32)];
  const insert = store.db.query(`INSERT INTO runs
    (id, repo_id, title, prompt, source, source_ref, status, created_at, finished_at, state_json)
    VALUES (?, ?, 'Synthetic work', ?, ?, ?, 'succeeded', ?, 10000, ?)`);
  const round = store.db.query(`INSERT INTO review_rounds
    (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at)
    VALUES (?, ?, ?, 1, ?, '[]', ?)`);
  const promptBody = "Implement the specification and verify the resulting behavior.\n".repeat(64);
  store.db.transaction(() => {
    for (let i = 0; i < 2100; i++) {
      const target = i < 1260 ? repo : repos[1 + (i % 2)];
      if (!target) throw new Error("missing fixture repository");
      const source = Math.floor(i / 60) % 3 === 0 ? "cli" : "github";
      const ref =
        Math.floor(i / 60) % 3 === 1
          ? JSON.stringify({ kind: "issue", repo: target.slug.toUpperCase(), number: (i % 60) + 1 })
          : null;
      insert.run(
        `root${i}`,
        target.id,
        `${promptBody}\nCloses #${(i % 60) + 1}`,
        source,
        ref,
        i + 1,
        states[0] ?? "",
      );
    }
    for (let i = 0; i < 900; i++) {
      const owner = i < 600 ? i : 1260 + i - 600;
      const target = owner < 1260 ? repo : repos[1 + (owner % 2)];
      if (!target) throw new Error("missing round repository");
      insert.run(
        `round${i}`,
        target.id,
        `${promptBody}\nCloses #${61 + (i % 30)}`,
        "github",
        null,
        3000 + i,
        states[1] ?? "",
      );
      round.run(`round${i}`, `root${owner}`, `https://example.com/pull/${i}`, "a".repeat(40), 3000 + i);
    }
  })();
  console.log(
    `Bun ${Bun.version}, ${process.platform}/${process.arch}; in-memory SQLite, warm cache, same process/data`,
  );
  console.log(
    "3,000 runs = 2,100 roots + 900 review rounds; 3 repositories; 60 open issues in evaluated repository",
  );
  const dimensions = store.db
    .query("SELECT sum(length(prompt)) AS promptBytes, sum(length(state_json)) AS stateBytes FROM runs")
    .get();
  console.log(`Fixture bytes (ASCII): ${JSON.stringify(dimensions)}`);
  console.log("EXPLAIN QUERY PLAN (optimized selection):");
  const plan = store.db.query(`EXPLAIN QUERY PLAN ${LATEST_ISSUE_RUNS_SQL}`).all(repo.slug) as {
    detail: string;
  }[];
  for (const row of plan) console.log(`  ${row.detail}`);

  type Observation = Pick<
    Run,
    "id" | "status" | "finishedAt" | "source" | "sourceRef" | "prompt" | "repoSlug"
  >;
  // Kept only as a benchmark reference for the removed issueRunObservations + decision seed.
  const seedAllRuns = () => {
    const rows = store.db
      .query(`SELECT runs.id, runs.status, runs.finished_at AS finishedAt,
      runs.source, runs.source_ref, runs.prompt, repos.slug AS repoSlug
      FROM runs JOIN repos ON repos.id = runs.repo_id`)
      .all() as (Observation & { source_ref: string | null })[];
    const observations = rows.map((row) => ({
      ...row,
      sourceRef: JSON.parse(row.source_ref ?? "null") as Run["sourceRef"],
    }));
    return new Map(
      observations.map((run) => {
        const links = linkedIssues(run, store)
          .map((i) => `${i.repo.toLowerCase()}#${i.number}`)
          .sort();
        return [run.id, { issues: links, state: JSON.stringify([run.status, run.finishedAt, links]) }];
      }),
    );
  };
  const evaluate = (kind: "before" | "after") => {
    const setupStart = performance.now();
    const observed = kind === "before" ? seedAllRuns() : null;
    const invalidated = new Set<string>();
    const snapshots = new Map<string, Map<number, IssueRunSummary>>();
    const setup = performance.now() - setupStart;
    if (observed && observed.size !== 3000) throw new Error("incomplete comparison seed");
    const latest = store.latestIssueRuns(
      repo.slug,
      issues.map((i) => i.number),
    );
    snapshots.set(repo.slug.toLowerCase(), latest);
    const ids = issues.map((issue) => {
      const run = snapshots.get(repo.slug.toLowerCase())?.get(issue.number);
      const failure =
        run?.status === "failed"
          ? store.issueLifecycleEffects(run.id, repo.slug, issue.number).find((e) => e.effect === "failure")
          : null;
      const boundary = failure?.state === "done" && failure.body !== null ? Number(failure.body) : NaN;
      const result = issueEligibility(issue, ["maintainer"], {
        claim: store.issueClaim(repo.slug, issue.number),
        latest: run,
        failureBoundary: Number.isInteger(boundary) && boundary >= 0 ? boundary : null,
      });
      if (result.eligible || invalidated.size) throw new Error("benchmark issue unexpectedly eligible");
      return run?.id ?? null;
    });
    return { ids, setup };
  };
  type Sample = { total: number; sync: number; delay: number; setup: number };
  const measurements: Record<"before" | "after", Sample[]> = { before: [], after: [] };
  let reference: string | undefined;
  for (let trial = -1; trial < 3; trial++) {
    for (const kind of trial % 2 === 0 ? (["after", "before"] as const) : (["before", "after"] as const)) {
      Bun.gc(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const scheduled = performance.now();
      let delay = 0;
      const tick = new Promise<void>((resolve) =>
        setImmediate(() => {
          delay = performance.now() - scheduled;
          resolve();
        }),
      );
      const start = performance.now();
      const { ids, setup } = evaluate(kind);
      const sync = performance.now() - start;
      await tick;
      const sample = { total: performance.now() - start, sync, delay, setup };
      const result = JSON.stringify(ids);
      if (reference && reference !== result) throw new Error("before/after linked runs differ");
      reference = result;
      if (trial >= 0) measurements[kind].push(sample);
      console.log(
        `${trial < 0 ? "warmup" : `trial ${trial + 1}`} ${kind}: poll=${sample.total.toFixed(2)}ms sync=${sync.toFixed(2)}ms setup=${setup.toFixed(2)}ms event-loop delay=${delay.toFixed(2)}ms`,
      );
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  for (const kind of ["before", "after"] as const) {
    const samples = measurements[kind];
    const worst = Math.max(...samples.map((s) => s.sync));
    console.log(
      `${kind}: median poll=${median(samples.map((s) => s.total)).toFixed(2)}ms, median sync=${median(samples.map((s) => s.sync)).toFixed(2)}ms, median comparison setup=${median(samples.map((s) => s.setup)).toFixed(2)}ms, max sync=${worst.toFixed(2)}ms, worst event-loop delay=${Math.max(...samples.map((s) => s.delay)).toFixed(2)}ms; under 50ms synchronous target: ${worst < 50 ? "yes" : "no"}`,
    );
  }
} finally {
  store.close();
}
