/** Offline repository evaluation: bun scripts/benchmark-issue-queue.ts
 * One in-memory SQLite store, 1,000 terminal runs (300 rounds), three repositories, 60 open issues.
 * States contain repeated spec/feedback/gate-output objects at approximately 128/384 KiB per run.
 * The reference retains the original eager state parsing and owner hydration, omitting unused Run fields.
 * Measure latest selection, claim/failure reads and eligibility; exclude fixture creation, lifecycle
 * reconciliation and network I/O. All issues require reapproval, as in a steady-state blocked queue.
 * One warmup and three alternating measured trials; GC between trials, never inside evaluation.
 * A queued immediate measures the evaluation's blocking interval, without timing assertions.
 */
import { LATEST_ISSUE_RUNS_SQL, Store } from "../src/db/store.ts";
import { issueEligibility, type QueueIssue } from "../src/integrations/issue-queue.ts";
import { legacyLatestIssueRun } from "../test/issue-queue-reference.ts";

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
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    comments: { nodes: [], totalCount: 0 },
    labels: { nodes: [{ name: "priority:1" }], totalCount: 1 },
    subIssuesSummary: { total: 0 },
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
  const states = [payload(128), payload(384)];
  const insert = store.db.query(`INSERT INTO runs
    (id, repo_id, title, prompt, source, source_ref, status, created_at, finished_at, state_json)
    VALUES (?, ?, 'Synthetic work', ?, ?, ?, 'succeeded', ?, 10000, ?)`);
  const round = store.db.query(`INSERT INTO review_rounds
    (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at)
    VALUES (?, ?, ?, 1, ?, '[]', ?)`);
  const promptBody = "Implement the specification and verify the resulting behavior.\n".repeat(64);
  store.db.transaction(() => {
    for (let i = 0; i < 700; i++) {
      const target = i < 420 ? repo : repos[1 + (i % 2)];
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
    for (let i = 0; i < 300; i++) {
      const owner = i < 200 ? i : 420 + i - 200;
      const target = owner < 420 ? repo : repos[1 + (owner % 2)];
      if (!target) throw new Error("missing round repository");
      insert.run(
        `round${i}`,
        target.id,
        `${promptBody}\nCloses #${61 + (i % 30)}`,
        "github",
        null,
        1000 + i,
        states[1] ?? "",
      );
      round.run(`round${i}`, `root${owner}`, `https://example.com/pull/${i}`, "a".repeat(40), 1000 + i);
    }
  })();
  console.log(
    `Bun ${Bun.version}, ${process.platform}/${process.arch}; in-memory SQLite, warm cache, same process/data`,
  );
  console.log(
    "1,000 runs = 700 roots + 300 review rounds; 3 repositories; 60 open issues in evaluated repository",
  );
  console.log(
    `state_json bytes: root=${Buffer.byteLength(states[0] ?? "")}, round=${Buffer.byteLength(states[1] ?? "")}; prompt ~${Buffer.byteLength(promptBody)} bytes`,
  );
  console.log("EXPLAIN QUERY PLAN (optimized selection):");
  const plan = store.db.query(`EXPLAIN QUERY PLAN ${LATEST_ISSUE_RUNS_SQL}`).all(repo.slug) as {
    detail: string;
  }[];
  for (const row of plan) console.log(`  ${row.detail}`);

  const evaluate = (kind: "before" | "after") => {
    const latest =
      kind === "after"
        ? store.latestIssueRuns(
            repo.slug,
            issues.map((i) => i.number),
          )
        : null;
    return issues.map((issue) => {
      const run = latest ? latest.get(issue.number) : legacyLatestIssueRun(store, repo.slug, issue.number);
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
      if (result.eligible) throw new Error("benchmark issue unexpectedly eligible");
      return run?.id ?? null;
    });
  };
  type Sample = { total: number; sync: number; delay: number };
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
      const ids = evaluate(kind);
      const sync = performance.now() - start;
      await tick;
      const sample = { total: performance.now() - start, sync, delay };
      const result = JSON.stringify(ids);
      if (reference && reference !== result) throw new Error("before/after linked runs differ");
      reference = result;
      if (trial >= 0) measurements[kind].push(sample);
      console.log(
        `${trial < 0 ? "warmup" : `trial ${trial + 1}`} ${kind}: poll=${sample.total.toFixed(2)}ms sync=${sync.toFixed(2)}ms event-loop delay=${delay.toFixed(2)}ms`,
      );
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  for (const kind of ["before", "after"] as const) {
    const samples = measurements[kind];
    const worst = Math.max(...samples.map((s) => s.sync));
    console.log(
      `${kind}: median poll=${median(samples.map((s) => s.total)).toFixed(2)}ms, median sync=${median(samples.map((s) => s.sync)).toFixed(2)}ms, max sync=${worst.toFixed(2)}ms, worst event-loop delay=${Math.max(...samples.map((s) => s.delay)).toFixed(2)}ms; under 50ms synchronous target: ${worst < 50 ? "yes" : "no"}`,
    );
  }
} finally {
  store.close();
}
