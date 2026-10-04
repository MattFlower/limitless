import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { diffPr, githubDoctor, normalizePr } from "../src/integrations/github-poller.ts";
import { type PrNode, pollerHarness, prNode, respond, SHA, url } from "./github-poller-support.ts";

let h: ReturnType<typeof pollerHarness>;
afterEach(() => h.close());

const S = 1000;
const kinds = (): string[] => h.fresh().map((i) => i.kind);
const ci = (node: PrNode, rollup: unknown) => {
  const head = node.commits.nodes[0];
  if (head) head.commit.statusCheckRollup = rollup;
};
const snapshotOf = (prUrl: string) => {
  const data = h.store.githubPrData(prUrl);
  if (!data) throw new Error(`no snapshot for ${prUrl}`);
  return data;
};
const rollup = (state: string, contexts: Record<string, unknown>[] = []) => ({
  state,
  contexts: { nodes: contexts },
});

test("tracks only factory PRs from run records, one nodes(ids:) query per repository", async () => {
  h = pollerHarness(["o/r", "o/s", "o/empty"]);
  for (let n = 1; n <= 51; n++) h.factoryPr("o/r", n);
  h.factoryPr("o/r", 7, "needs_human"); // a second run referencing the same PR
  h.factoryPr("o/s", 1, "running");
  // A verification run only checked someone else's PR.
  h.gh.add("o/r", 900);
  const verify = h.store.createRun(h.repo("o/r"), {
    repo: "o/r",
    prompt: "verify",
    source: "github",
    sourceRef: { kind: "pull_request", repo: "o/r", number: 900, baseRef: "main", baseSha: "b".repeat(40) },
  });
  h.store.updateRun(verify.id, { prUrl: url("o/r", 900), status: "succeeded" });
  // A limitless/* branch PR the factory did not open exists on GitHub only.
  h.gh.add("o/r", 901);
  h.start();
  await h.advance(0);
  const graphql = h.gh.graphql();
  expect(graphql).toHaveLength(2);
  expect(graphql[0]?.ids).toEqual(
    Array.from({ length: 51 }, (_, i) => `PR_o/r_${i + 1}`).sort((a, b) =>
      url("o/r", Number(a.split("_")[2])).localeCompare(url("o/r", Number(b.split("_")[2]))),
    ),
  );
  expect(graphql[1]?.ids).toEqual(["PR_o/s_1"]);
  expect(h.gh.rest()).toHaveLength(52);
  expect(
    h.gh.calls.some((c) => /900|901|branch|head=/.test(c.path) || c.ids?.some((id) => /90[01]/.test(id))),
  ).toBe(false);
  h.reopen();
  h.gh.calls.length = 0;
  h.start();
  await h.advance(0);
  expect(h.gh.rest()).toHaveLength(0);
  expect(h.gh.graphql()).toHaveLength(2);
});

test.each([
  ["octocat/hello-world", "Octocat/Hello-World"],
  ["Octocat/Hello-World", "octocat/hello-world"],
])("tracks %s PRs with URL spelling %s through restart and merge", async (repo, spelling) => {
  h = pollerHarness([repo]);
  const run = h.factoryPr(repo, 1);
  const prUrl = url(spelling, 1);
  h.store.updateRun(run.id, { prUrl });
  const pr = h.node(repo, 1);
  pr.url = prUrl;
  h.gh.restNext.push(respond(200, { node_id: pr.id }));
  expect(h.store.githubTracked().map((p) => p.url)).toEqual([prUrl]);
  h.start();
  await h.advance(0);
  expect(h.gh.rest()).toEqual([{ path: `repos/${repo}/pulls/1` }]);
  expect(h.gh.graphql().map((c) => c.ids)).toEqual([[pr.id]]);
  expect(JSON.parse(snapshotOf(prUrl)).url).toBe(prUrl);
  h.reopen();
  h.gh.calls.length = 0;
  pr.state = "MERGED";
  pr.mergedAt = pr.updatedAt;
  pr.mergedBy = { login: "octocat" };
  h.start();
  await h.advance(0);
  expect(h.gh.rest()).toHaveLength(0);
  expect(h.gh.graphql().map((c) => c.ids)).toEqual([[pr.id]]);
  expect(h.store.getRun(run.id)?.merged).toBe(true);
  expect(kinds()).toEqual(["pr.merged"]);
  expect(h.store.readFeed().items.filter((i) => i.kind === "run.merged")).toHaveLength(1);
});

test("rejects mismatched repositories and malformed PR numbers", async () => {
  h = pollerHarness(["octocat/hello-world"]);
  const invalid = [
    "https://github.com/other/hello-world/pull/1",
    "https://github.com/octocat/other/pull/1",
    "https://github.com/octocat/hello-world/pull/1extra",
    "https://github.com/octocat/hello-world/pull/1/files",
    "https://github.com/octocat/hello-world/pull/0",
    "https://github.com/octocat/hello-world/pull/-1",
    "https://github.com/octocat/hello-world/pull/1.5",
    "https://github.com.evil/octocat/hello-world/pull/1",
  ];
  for (const [i, prUrl] of invalid.entries()) {
    const run = h.factoryPr("octocat/hello-world", i + 1);
    h.store.updateRun(run.id, { prUrl });
  }
  expect(h.store.githubTracked()).toEqual([]);
  h.start();
  await h.advance(0);
  expect(h.gh.calls).toEqual([]);
});

test("each change produces exactly one feed item; repeats and non-changes produce none", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  h.start(15);
  await h.advance(0);
  expect(kinds()).toEqual([]);
  const failing = [
    { name: "b-test", conclusion: "FAILURE", url: "https://ci/b" },
    { name: "neutral", conclusion: "NEUTRAL", url: null },
    { name: "skipped", conclusion: "SKIPPED", url: null },
    { name: "a-status", state: "ERROR", url: "https://ci/a" },
  ];
  const steps: [string, (n: PrNode) => void, string[]][] = [
    [
      "updatedAt only",
      (n) => {
        n.updatedAt = "2026-10-03T01:00:00Z";
      },
      [],
    ],
    [
      "pending rollup",
      (n) => {
        ci(n, rollup("PENDING"));
      },
      [],
    ],
    [
      "ci passed",
      (n) => {
        ci(n, rollup("SUCCESS"));
      },
      ["pr.ci_passed"],
    ],
    [
      "ci failed",
      (n) => {
        ci(n, rollup("FAILURE", failing));
      },
      ["pr.ci_failed"],
    ],
    [
      "reordered",
      (n) => {
        ci(n, rollup("FAILURE", failing.toReversed()));
      },
      [],
    ],
    [
      "null rollup",
      (n) => {
        ci(n, null);
      },
      [],
    ],
    [
      "conflicting",
      (n) => {
        n.mergeable = "CONFLICTING";
      },
      ["pr.conflicting"],
    ],
    [
      "behind",
      (n) => {
        n.mergeStateStatus = "BEHIND";
      },
      ["pr.behind"],
    ],
    // reviewDecision stays null, as in repositories without required reviews.
    [
      "approved",
      (n) => {
        n.latestReviews.nodes = [{ state: "APPROVED", author: { login: "alice" } }];
      },
      ["pr.review"],
    ],
    [
      "changes requested by a second reviewer",
      (n) => {
        n.latestReviews.nodes.push({ state: "CHANGES_REQUESTED", author: { login: "bob" } });
      },
      ["pr.review"],
    ],
    [
      "reordered, plus a comment-only review",
      (n) => {
        n.latestReviews.nodes = [
          { state: "COMMENTED", author: { login: "carol" } },
          ...n.latestReviews.nodes.toReversed(),
        ];
      },
      [],
    ],
    [
      "bob approves",
      (n) => {
        n.latestReviews.nodes = [
          { state: "APPROVED", author: { login: "alice" } },
          { state: "APPROVED", author: { login: "bob" } },
        ];
      },
      ["pr.review"],
    ],
    [
      "dismissed",
      (n) => {
        n.latestReviews.nodes = [{ state: "DISMISSED", author: { login: "bob" } }];
      },
      [],
    ],
    [
      "review",
      (n) => {
        n.reviews.nodes = [{ id: "R1", updatedAt: "t1", comments: { nodes: [] } }];
      },
      ["pr.comment"],
    ],
    [
      "review comment",
      (n) => {
        n.reviews.nodes = [
          { id: "R1", updatedAt: "t1", comments: { nodes: [{ id: "RC1", updatedAt: "t1" }] } },
        ];
      },
      ["pr.comment"],
    ],
    [
      "second review",
      (n) => {
        n.reviews.nodes.push({ id: "R2", updatedAt: "t2", comments: { nodes: [] } });
      },
      ["pr.comment"],
    ],
    [
      "older review's comment edited",
      (n) => {
        n.reviews.nodes[0] = {
          id: "R1",
          updatedAt: "t1",
          comments: { nodes: [{ id: "RC1", updatedAt: "t3" }] },
        };
      },
      ["pr.comment"],
    ],
    [
      "issue comment",
      (n) => {
        n.comments.nodes = [{ id: "C1", updatedAt: "t1" }];
      },
      ["pr.comment"],
    ],
    [
      "edit, same id",
      (n) => {
        n.comments.nodes = [{ id: "C1", updatedAt: "t2" }];
      },
      ["pr.comment"],
    ],
    [
      "replacement, same count",
      (n) => {
        n.comments.nodes = [{ id: "C2", updatedAt: "t3" }];
      },
      ["pr.comment"],
    ],
    [
      "deletion",
      (n) => {
        n.comments.nodes = [];
      },
      [],
    ],
  ];
  for (const [name, change, expected] of steps) {
    change(pr);
    await h.advance(15 * S);
    const items = h.fresh();
    expect([name, items.map((i): string => i.kind)]).toEqual([name, expected]);
    if (name === "ci failed")
      expect(items[0]?.data.failing).toEqual([
        { name: "a-status", url: "https://ci/a" },
        { name: "b-test", url: "https://ci/b" },
      ]);
    if (name === "review comment" || name === "older review's comment edited")
      expect(items[0]?.data.category).toBe("review_comment");
    if (name === "second review") expect(items[0]?.data.category).toBe("review");
    if (name === "bob approves") expect(items[0]?.data).toMatchObject({ review: "bob:APPROVED" });
    await h.advance(15 * S);
    expect([name, kinds()]).toEqual([name, []]);
  }
  pr.state = "MERGED";
  pr.mergedAt = "2026-10-03T02:00:00Z";
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.merged"]);
  await h.advance(60 * S);
  expect(kinds()).toEqual([]);
});

test("a closed PR is rechecked every 10 minutes; a reopen is observed and a later merge resolves once", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 2);
  h.factoryPr("o/r", 3); // an open PR in the same repository keeps the fast cadence
  h.start();
  await h.advance(0);
  h.node("o/r", 2).state = "CLOSED";
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.closed"]);
  expect(h.store.getRun(run.id)?.prClosedUnmerged).toBe(true);
  const closedPolls = () => h.gh.graphql().filter((c) => c.ids?.includes("PR_o/r_2")).length;
  // The observation that saw the close counts as its last one: no immediate re-observation.
  expect(closedPolls()).toBe(2);
  await h.advance(0);
  await h.advance(15 * S);
  expect(closedPolls()).toBe(2);
  expect(h.gh.graphql().length).toBe(3);
  // Still tracked after a restart; the restart observes it once, then it waits 10 minutes.
  h.reopen();
  h.start();
  await h.advance(0);
  const polls = closedPolls();
  const open = h.gh.graphql().length;
  for (let i = 0; i < 39; i++) await h.advance(15 * S);
  expect(closedPolls()).toBe(polls);
  expect(h.gh.graphql().length).toBe(open + 39);
  h.node("o/r", 2).state = "OPEN";
  await h.advance(15 * S);
  expect(closedPolls()).toBe(polls + 1);
  expect(h.store.getRun(run.id)?.prClosedUnmerged).toBe(false);
  expect(kinds()).toEqual([]);
  const node = h.node("o/r", 2);
  node.state = "MERGED";
  node.mergedAt = "2026-10-03T05:00:00Z";
  await h.advance(15 * S);
  expect(h.store.getRun(run.id)).toMatchObject({ merged: true, prClosedUnmerged: false });
  expect(kinds()).toEqual(["pr.merged"]);
  await h.advance(3600 * S);
  expect(h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged")).toHaveLength(1);
  expect(h.store.githubTracked().map((p) => p.url)).toEqual([url("o/r", 3)]);
});

test("a needs_human run's PR closed unmerged is resolved as pr_closed once, across later polls", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 2, "needs_human");
  const open = h.factoryPr("o/r", 3, "needs_human");
  h.start();
  await h.advance(0);
  h.node("o/r", 2).state = "CLOSED";
  await h.advance(15 * S);
  await h.advance(15 * S);
  expect(h.store.getRun(run.id)).toMatchObject({ status: "resolved", merged: false, prClosedUnmerged: true });
  expect(h.store.getRun(run.id)?.resolution).toMatchObject({
    kind: "pr_closed",
    ref: url("o/r", 2),
    by: "github",
  });
  expect(h.store.getRun(open.id)).toMatchObject({ status: "needs_human", resolution: null });
  const items = h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.resolved");
  expect(items.map((i) => i.runId)).toEqual([run.id]);
});

test("tracking ends with the run; open PRs of runs failed or cancelled over 7 days ago expire", async () => {
  h = pollerHarness();
  const now = Date.now();
  setSystemTime(now); // the age rule reads the wall clock
  const DAY = 86_400_000;
  const pr = (n: number, status: RunStatus, finishedAt: number | null) => {
    const run = h.factoryPr("o/r", n, status);
    h.store.updateRun(run.id, { finishedAt });
    return run;
  };
  pr(1, "failed", now - 7 * DAY); // exactly 7 days: kept
  pr(2, "failed", now - 7 * DAY - 1);
  pr(3, "cancelled", now - 8 * DAY);
  pr(4, "failed", null); // no completion time: kept
  pr(5, "failed", now - 8 * DAY);
  pr(5, "running", null); // another run shares the PR
  const closed = pr(6, "cancelled", now - 30 * DAY);
  h.store.updateRun(closed.id, { prClosedUnmerged: true }); // closed PRs wait for a reopen
  try {
    expect(h.store.githubTracked().map((p) => p.url)).toEqual([1, 4, 5, 6].map((n) => url("o/r", n)));
    h.store.db.query("DELETE FROM runs WHERE id = ?").run(closed.id);
    expect(h.store.githubTracked().map((p) => p.url)).toEqual([1, 4, 5].map((n) => url("o/r", n)));
  } finally {
    setSystemTime();
  }
});

test("a missed poll is caught later; restarts, retries and same-head recurrences are exact", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  h.start();
  await h.advance(0);
  h.gh.next.push(new Error("offline"));
  await h.advance(15 * S);
  expect(h.logs.at(-1)).toContain("offline");
  ci(pr, rollup("FAILURE", [{ name: "t", conclusion: "FAILURE" }]));
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.ci_failed"]);
  h.reopen();
  h.start();
  await h.advance(0);
  expect(kinds()).toEqual([]);
  ci(pr, rollup("SUCCESS"));
  await h.advance(15 * S);
  ci(pr, rollup("FAILURE", [{ name: "t", conclusion: "FAILURE" }]));
  await h.advance(15 * S);
  pr.headRefOid = "c".repeat(40);
  await h.advance(15 * S);
  const items = h.fresh();
  expect(items.map((i) => i.kind)).toEqual(["pr.ci_passed", "pr.ci_failed", "pr.ci_failed"]);
  expect(items.map((i) => i.data.head)).toEqual([SHA, SHA, "c".repeat(40)]);
});

test("a failed feed write rolls the snapshot back with it", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  h.start();
  await h.advance(0);
  const before = snapshotOf(url("o/r", 1));
  h.store.db.exec(
    "CREATE TEMP TRIGGER boom BEFORE INSERT ON feed WHEN NEW.kind = 'pr.conflicting' BEGIN SELECT RAISE(ABORT, 'boom'); END",
  );
  h.node("o/r", 1).mergeable = "CONFLICTING";
  await h.advance(15 * S);
  expect(h.logs.at(-1)).toContain("boom");
  expect(snapshotOf(url("o/r", 1))).toBe(before);
  h.store.db.exec("DROP TRIGGER boom");
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.conflicting"]);
});

test("cadence: 45s by default, configured, floored at 15s, 15s while a delivery waits", async () => {
  for (const [seconds, status, expected] of [
    [undefined, "running", 45],
    [60, "running", 60],
    [5, "running", 15],
    [undefined, "succeeded", 15],
  ] as const) {
    h = pollerHarness();
    h.factoryPr("o/r", 1, status);
    h.start(seconds);
    await h.advance(0);
    expect(h.gh.graphql()).toHaveLength(1);
    await h.advance((expected - 1) * S);
    expect(h.gh.graphql()).toHaveLength(1);
    await h.advance(S);
    expect(h.gh.graphql()).toHaveLength(2);
    h.close();
  }
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1, "running");
  h.start();
  await h.advance(0);
  h.store.updateRun(run.id, { status: "succeeded" });
  await h.advance(45 * S);
  const count = h.gh.graphql().length;
  await h.advance(15 * S);
  expect(h.gh.graphql()).toHaveLength(count + 1);
});

test("config: poll defaults on at 45s; poll_seconds floors at 15; poll can be turned off", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-poll-config-"));
  try {
    expect(loadConfig({ home: dir, configDir: dir })).toMatchObject({
      githubPoll: true,
      githubPollSeconds: 45,
    });
    writeFileSync(join(dir, "config.toml"), "[github]\npoll = false\npoll_seconds = 5\n");
    expect(loadConfig({ home: dir, configDir: dir })).toMatchObject({
      githubPoll: false,
      githubPollSeconds: 15,
    });
    writeFileSync(join(dir, "config.toml"), '[github]\npoll = "yes"\n');
    expect(() => loadConfig({ home: dir, configDir: dir })).toThrow("github.poll");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  h = pollerHarness();
});

test("requests are serial across repositories and REST; idle without PRs; stop ends scheduling", async () => {
  h = pollerHarness(["o/r", "o/s"]);
  const stop = h.start();
  await h.advance(3600 * S);
  expect(h.gh.calls).toHaveLength(0);
  for (const n of [1, 2, 3]) h.factoryPr("o/r", n);
  h.factoryPr("o/s", 1);
  await h.advance(0);
  expect(h.gh.calls).toHaveLength(6);
  expect(h.gh.maxInFlight).toBe(1);
  h.node("o/s", 1).state = "MERGED";
  h.node("o/s", 1).mergedAt = "2026-10-03T00:00:00Z";
  await h.advance(15 * S);
  const after = h.gh.calls.length;
  await h.advance(15 * S);
  expect(h.gh.graphql().slice(-1)[0]?.ids).toEqual(["PR_o/r_1", "PR_o/r_2", "PR_o/r_3"]);
  expect(h.gh.calls.length).toBe(after + 1);
  // Stop while a request is in flight: it completes, nothing further is sent or scheduled.
  const response = Promise.withResolvers<void>();
  h.gh.hold = response.promise;
  await h.advance(15 * S);
  const inFlight = h.gh.calls.length;
  expect(inFlight).toBe(after + 2);
  stop();
  h.gh.hold = null;
  response.resolve();
  await h.advance(3600 * S);
  expect(h.gh.calls.length).toBe(inFlight);
});

test("rate limits honour Retry-After, else back off 60..900s, across repositories, without advancing snapshots", async () => {
  h = pollerHarness(["o/r", "o/s"]);
  h.factoryPr("o/r", 1);
  h.factoryPr("o/s", 1);
  h.start();
  await h.advance(0);
  const before = snapshotOf(url("o/r", 1));
  const count = () => h.gh.calls.length;
  h.node("o/r", 1).mergeable = "CONFLICTING";
  h.gh.next.push(respond(403, { message: "rate" }, { "retry-after": "120" }));
  await h.advance(15 * S);
  let c = count();
  // Round robin: this pass starts with o/s, and its rate limit stops o/r too.
  expect(h.gh.calls.at(-1)?.ids).toEqual(["PR_o/s_1"]);
  // A run update during the cooldown does not bypass it.
  h.factoryPr("o/s", 2);
  await h.advance(119 * S);
  expect(count()).toBe(c);
  expect(snapshotOf(url("o/r", 1))).toBe(before);
  expect(kinds()).toEqual([]);
  await h.advance(S);
  expect(count()).toBeGreaterThan(c);
  expect(kinds()).toEqual(["pr.conflicting"]);

  const limited = [
    respond(429, {}),
    respond(403, { message: "You have exceeded a secondary rate limit." }),
    respond(200, { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
    respond(429, {}),
    respond(429, {}),
    respond(429, {}),
  ];
  await h.advance(15 * S);
  h.gh.next.push(...limited);
  await h.advance(15 * S);
  for (const wait of [60, 120, 240, 480, 900, 900]) {
    c = count();
    await h.advance((wait - 1) * S);
    expect([wait, count()]).toEqual([wait, c]);
    await h.advance(S);
    expect(count()).toBeGreaterThan(c);
  }
  expect(h.gh.next).toHaveLength(0);
  // Each cooldown is logged once, not on every check while it lasts.
  expect(h.logs.filter((l) => l.startsWith("GitHub rate limit"))).toHaveLength(7);
  // Success resets the backoff.
  await h.advance(15 * S);
  h.gh.next.push(respond(429, {}));
  await h.advance(15 * S);
  c = count();
  await h.advance(59 * S);
  expect(count()).toBe(c);
  await h.advance(S);
  expect(count()).toBeGreaterThan(c);
});

test("UNKNOWN mergeability gets one REST nudge after the third poll, then CONFLICTING is reported", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  pr.mergeable = "UNKNOWN";
  h.start();
  const nudges = () => h.gh.rest().length - 1; // the first REST call resolves the node id
  await h.advance(0);
  await h.advance(15 * S);
  expect(nudges()).toBe(0);
  await h.advance(15 * S);
  expect(nudges()).toBe(1);
  expect(h.gh.rest().at(-1)?.path).toBe("repos/o/r/pulls/1");
  await h.advance(15 * S);
  await h.advance(15 * S);
  expect(nudges()).toBe(1);
  pr.mergeable = "CONFLICTING";
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.conflicting"]);
  // A known value ends the episode: a later UNKNOWN on the same head (the base moved) is nudged
  // once more, and not again within that episode, even across a restart; a new head is.
  pr.mergeable = "UNKNOWN";
  for (let i = 0; i < 3; i++) await h.advance(15 * S);
  expect(nudges()).toBe(2);
  h.reopen();
  h.start();
  for (let i = 0; i < 3; i++) await h.advance(15 * S);
  expect(nudges()).toBe(2);
  pr.headRefOid = "d".repeat(40);
  for (let i = 0; i < 3; i++) await h.advance(15 * S);
  expect(nudges()).toBe(3);
  for (let i = 0; i < 5; i++) await h.advance(15 * S);
  expect(nudges()).toBe(3);
});

test("an access failure during a nudge is kept for doctor; the cycle that hit it never clears it", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  h.node("o/r", 1).mergeable = "UNKNOWN";
  h.start();
  await h.advance(0);
  await h.advance(15 * S);
  h.gh.restNext.push(respond(403, { message: "SSO" }, { "x-github-sso": "required; url=https://idp" }));
  await h.advance(15 * S);
  expect(h.gh.rest().at(-1)?.path).toBe("repos/o/r/pulls/1");
  expect(kinds()).toEqual(["github.access_problem"]);
  expect(h.store.githubAccessProblems().map((p) => p.repo)).toEqual(["o/r"]);
  expect(githubDoctor(h.store.githubAccessProblems()).join("\n")).toContain("o/r");
  // The swallowed nudge is retried after the cooldown, and success clears the episode.
  const sent = h.gh.rest().length;
  await h.advance(59 * S);
  expect(h.gh.rest()).toHaveLength(sent);
  await h.advance(S);
  expect(h.gh.rest()).toHaveLength(sent + 1);
  expect(h.store.githubAccessProblems()).toEqual([]);
  await h.advance(15 * S);
  expect(h.gh.rest()).toHaveLength(sent + 1);
});

test("nudges a rate limit interrupted stay pending for every PR, across the cooldown and a restart", async () => {
  h = pollerHarness();
  for (const n of [1, 2]) {
    h.factoryPr("o/r", n);
    h.node("o/r", n).mergeable = "UNKNOWN";
  }
  h.start();
  await h.advance(0);
  await h.advance(15 * S);
  const nudges = () =>
    h.gh.rest().filter((c) => c.path === "repos/o/r/pulls/1" || c.path === "repos/o/r/pulls/2");
  expect(nudges()).toHaveLength(2); // node id lookups
  h.gh.restNext.push(respond(429, {}));
  await h.advance(15 * S);
  // The first nudge was rate limited; the second was never sent.
  expect(nudges().map((c) => c.path)).toEqual([
    "repos/o/r/pulls/1",
    "repos/o/r/pulls/2",
    "repos/o/r/pulls/1",
  ]);
  h.reopen();
  h.start();
  await h.advance(0);
  expect(
    nudges()
      .slice(3)
      .map((c) => c.path),
  ).toEqual(["repos/o/r/pulls/1", "repos/o/r/pulls/2"]);
  await h.advance(15 * S);
  await h.advance(15 * S);
  expect(nudges()).toHaveLength(5);
});

test("SSO, 404, IP restrictions and missing nodes are access problems, once per episode, never pr.closed", async () => {
  h = pollerHarness(["o/r", "o/gone"]);
  const run = h.factoryPr("o/r", 1);
  h.start();
  await h.advance(0);
  const before = snapshotOf(url("o/r", 1));
  const sso = () => respond(403, { message: "SSO" }, { "x-github-sso": "required; url=https://idp" });
  h.gh.next.push(sso(), sso());
  await h.advance(15 * S);
  let items = h.fresh();
  expect(items.map((i) => [i.kind, i.repo, i.data.reason, i.data.head])).toEqual([
    ["github.access_problem", "o/r", "sso", null],
  ]);
  await h.advance(60 * S);
  expect(h.gh.next).toHaveLength(0);
  expect(kinds()).toEqual([]);
  // Still the same episode after a restart.
  h.gh.next.push(sso());
  h.reopen();
  h.start();
  await h.advance(0);
  expect(h.gh.next).toHaveLength(0);
  expect(kinds()).toEqual([]);
  expect(h.store.githubAccessProblems().map((p) => p.repo)).toEqual(["o/r"]);
  await h.advance(3600 * S);
  expect(kinds()).toEqual([]);
  expect(snapshotOf(url("o/r", 1))).toBe(before);
  expect(h.store.getRun(run.id)).toMatchObject({
    status: "succeeded",
    merged: false,
    prClosedUnmerged: false,
  });
  expect(h.store.githubAccessProblems()).toEqual([]);

  // A node that vanishes from GraphQL is not a close.
  h.gh.nodes.delete("PR_o/r_1");
  await h.advance(3600 * S);
  items = h.fresh();
  expect(items.map((i) => [i.kind, i.data.reason, i.data.head])).toEqual([
    ["github.access_problem", "not_found", SHA],
  ]);
  await h.advance(3600 * S);
  expect(kinds()).toEqual([]);
  h.gh.add("o/r", 1);
  await h.advance(3600 * S);
  expect(h.store.githubAccessProblems()).toEqual([]);
  h.gh.next.push(
    respond(403, {
      message:
        "Although you appear to have the correct authorization credentials, the `o` organization has an IP allow list enabled",
    }),
  );
  await h.advance(3600 * S);
  expect(h.fresh().map((i) => i.data.reason)).toEqual(["ip"]);

  // A factory PR whose REST lookup 404s.
  const gone = h.store.createRun(h.repo("o/gone"), { repo: "o/gone", prompt: "gone" });
  h.store.updateRun(gone.id, { prUrl: url("o/gone", 5), status: "succeeded" });
  await h.advance(3600 * S);
  expect(h.fresh().map((i) => [i.repo, i.data.reason, i.data.head])).toEqual([["o/gone", "not_found", null]]);
  expect(h.store.getRun(gone.id)?.prClosedUnmerged).toBe(false);
  expect(h.store.readFeed({ limit: 1000 }).items.some((i) => i.kind === "pr.closed")).toBe(false);
});

test("diff reports a completed CI result on first sight, baselines activity, ignores marker deletion", () => {
  const node = prNode("o/r", 1);
  ci(node, rollup("FAILURE", [{ name: "x", conclusion: "FAILURE", url: "https://ci/x" }]));
  node.reviewDecision = "APPROVED";
  node.comments.nodes = [{ id: "C", updatedAt: "t" }];
  const snap = normalizePr(node);
  if (!snap) throw new Error("bad node");
  expect(diffPr(null, snap).map((c) => [c.kind, c.data])).toEqual([
    ["pr.ci_failed", { failing: [{ name: "x", url: "https://ci/x" }] }],
  ]);
  expect(diffPr(null, { ...snap, ci: "SUCCESS", failing: [] }).map((c) => c.kind)).toEqual(["pr.ci_passed"]);
  expect(diffPr(null, { ...snap, ci: null, failing: [] })).toEqual([]);
  expect(diffPr(snap, { ...snap, activity: { ...snap.activity, comment: [] } })).toEqual([]);
  expect(normalizePr(null)).toBeNull();
  h = pollerHarness();
});

test("a PR first seen with CI already finished reports that result", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  ci(h.node("o/r", 1), rollup("SUCCESS", [{ name: "t", conclusion: "SUCCESS" }]));
  h.start();
  await h.advance(0);
  expect(h.fresh().map((i) => [i.kind, i.data.head])).toEqual([["pr.ci_passed", SHA]]);
  await h.advance(15 * S);
  expect(kinds()).toEqual([]);
});

test("an HTTP 404 from the observation query is an access problem, not a close, until access returns", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1);
  h.start();
  await h.advance(0);
  const before = snapshotOf(url("o/r", 1));
  h.gh.next.push(respond(404, { message: "Not Found" }), respond(404, { message: "Not Found" }));
  await h.advance(15 * S);
  await h.advance(15 * S);
  expect(h.gh.next).toHaveLength(0);
  expect(h.fresh().map((i) => [i.kind, i.repo, i.data.reason, i.data.head])).toEqual([
    ["github.access_problem", "o/r", "not_found", SHA],
  ]);
  expect(snapshotOf(url("o/r", 1))).toBe(before);
  expect(h.store.getRun(run.id)).toMatchObject({
    status: "succeeded",
    merged: false,
    prClosedUnmerged: false,
  });
  expect(githubDoctor(h.store.githubAccessProblems()).join("\n")).toMatch(/o\/r[\s\S]*gh auth refresh/);
  await h.advance(15 * S);
  expect(h.store.githubAccessProblems()).toEqual([]);
  expect(githubDoctor(h.store.githubAccessProblems())).toEqual(["GitHub access: ok"]);
  h.gh.next.push(respond(404, { message: "Not Found" }));
  await h.advance(15 * S);
  expect(kinds()).toEqual(["github.access_problem"]);
  expect(h.store.readFeed({ limit: 1000 }).items.some((i) => i.kind === "pr.closed")).toBe(false);
});

test("GraphQL partial errors never overwrite the last successful snapshot", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  pr.reviewDecision = "APPROVED";
  h.start();
  await h.advance(0);
  const before = snapshotOf(url("o/r", 1));
  const partial = { ...pr, reviewDecision: null, mergeable: null };
  h.gh.next.push(
    respond(200, { data: { nodes: [partial] }, errors: [{ type: "FORBIDDEN", path: ["nodes", 0, "x"] }] }),
    respond(200, { data: { nodes: [{ ...pr, headRefOid: null }] } }),
  );
  await h.advance(15 * S);
  await h.advance(15 * S);
  expect(snapshotOf(url("o/r", 1))).toBe(before);
  await h.advance(15 * S);
  expect(kinds()).toEqual([]);
});

test("an unsuccessful node lookup does not clear an unresolved access episode", async () => {
  h = pollerHarness();
  h.store.setGithubAccess("o/r", { reason: "sso", detail: "SSO" });
  h.fresh();
  h.factoryPr("o/r", 1);
  h.gh.next.push(respond(500, { message: "boom" }));
  h.start();
  await h.advance(0);
  expect(h.store.githubAccessProblems()).toHaveLength(1);
  await h.advance(15 * S);
  expect(h.store.githubAccessProblems()).toHaveLength(0);
  h.store.setGithubAccess("o/r", { reason: "sso", detail: "SSO" });
  expect(h.fresh().map((i) => i.kind)).toEqual(["github.access_problem"]);
});

test("a delivery adopts the 15 second cadence without waiting for the old deadline", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1, "running");
  h.start();
  await h.advance(0);
  await h.advance(5 * S);
  h.store.updateRun(run.id, { status: "succeeded" });
  await h.advance(9 * S);
  expect(h.gh.graphql()).toHaveLength(1);
  await h.advance(S);
  expect(h.gh.graphql()).toHaveLength(2);
  await h.advance(15 * S);
  expect(h.gh.graphql()).toHaveLength(3);
});

const merge = (node: PrNode) => {
  node.state = "MERGED";
  node.mergedAt = "2026-10-03T05:00:00Z";
};

test.each([
  ["401", () => respond(401, { message: "Bad credentials" }), "auth"],
  ["SSO", () => respond(403, { message: "SSO" }, { "x-github-sso": "required; url=https://idp" }), "sso"],
  ["IP", () => respond(403, { message: "the `a` organization has an IP allow list enabled" }), "ip"],
  ["generic 403", () => respond(403, { message: "Resource not accessible by integration" }), "forbidden"],
])(
  "a repository blocked by %s backs off alone; the others keep polling and merging",
  async (_, deny, reason) => {
    h = pollerHarness(["a/blocked", "b/ok"]);
    h.factoryPr("a/blocked", 1);
    const ok = h.factoryPr("b/ok", 1);
    h.gh.deny.set("a/blocked", deny);
    h.start();
    await h.advance(0);
    const blocked = () => h.gh.times.filter((_, i) => /a\/blocked/.test(JSON.stringify(h.gh.calls[i])));
    for (let i = 0; i < 4 * 60; i++) {
      if (i === 30) merge(h.node("b/ok", 1));
      await h.advance(15 * S);
    }
    expect(h.store.getRun(ok.id)?.merged).toBe(true);
    expect(h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged")).toHaveLength(1);
    const times = blocked();
    expect(times.slice(1, 6).map((t, i) => (t - (times[i] ?? 0)) / S)).toEqual([60, 120, 240, 480, 900]);
    expect(times.slice(6).every((t, i) => t - (times[i + 5] ?? 0) === 900 * S)).toBe(true);
    const problems = h.fresh().filter((i) => i.kind === "github.access_problem");
    expect(problems.map((i) => [i.repo, i.data.reason])).toEqual([["a/blocked", reason]]);
    if (reason === "auth") expect(problems[0]?.summary).toContain("gh auth refresh");
    // Recovery clears the problem and resets the backoff.
    h.gh.deny.delete("a/blocked");
    await h.advance(900 * S);
    expect(h.store.githubAccessProblems()).toEqual([]);
    h.gh.deny.set("a/blocked", deny);
    await h.advance(15 * S);
    const failedAt = blocked().at(-1) ?? 0;
    await h.advance(45 * S);
    expect(blocked().at(-1)).toBe(failedAt);
    await h.advance(15 * S);
    expect(blocked().at(-1)).toBe(failedAt + 60 * S);
    expect(h.logs.some((l) => l.startsWith("GitHub rate limit"))).toBe(false);
  },
);

test("repositories are polled round robin, so a failing one is not always first", async () => {
  h = pollerHarness(["a/r", "b/r", "c/r"]);
  for (const repo of ["a/r", "b/r", "c/r"]) h.factoryPr(repo, 1);
  h.start();
  await h.advance(0);
  for (let i = 0; i < 2; i++) await h.advance(15 * S);
  const order = h.gh.graphql().map((c) => c.ids?.[0]?.split("_")[1]);
  expect(order).toEqual(["a/r", "b/r", "c/r", "b/r", "c/r", "a/r", "c/r", "a/r", "b/r"]);
  // A pass a rate limit interrupts resumes with the next repository.
  h.gh.next.push(respond(429, {}));
  await h.advance(15 * S);
  await h.advance(60 * S);
  expect(
    h.gh
      .graphql()
      .map((c) => c.ids?.[0]?.split("_")[1])
      .slice(9),
  ).toEqual(["a/r", "b/r", "c/r", "a/r"]);
});

test.each([
  [
    "x-ratelimit-remaining: 0",
    () => respond(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "" }),
  ],
  ["REST secondary limit", () => respond(403, { message: "You have exceeded a secondary rate limit" })],
  ["GraphQL RATE_LIMITED", () => respond(200, { errors: [{ type: "RATE_LIMITED", message: "limited" }] })],
  ["Retry-After", () => respond(403, {}, { "retry-after": "300" })],
  ["Retry-After HTTP date", () => respond(403, {}, { "retry-after": "" })],
])("%s pauses every repository until its deadline and is logged once", async (name, limit) => {
  h = pollerHarness(["o/r", "o/s"]);
  h.factoryPr("o/r", 1);
  h.factoryPr("o/s", 1);
  h.start();
  await h.advance(0);
  const response = limit();
  // A usable reset deadline is honoured exactly.
  if (name.startsWith("x-ratelimit"))
    response.headers.set("x-ratelimit-reset", String(Math.floor((h.clock.now() + 315 * S) / 1000)));
  if (name.endsWith("date"))
    response.headers.set("retry-after", new Date(h.clock.now() + 315 * S).toUTCString());
  h.gh.next.push(response);
  await h.advance(15 * S);
  const calls = h.gh.calls.length;
  const dated = name.startsWith("x-ratelimit") || name.endsWith("date");
  const wait = name === "Retry-After" || dated ? 300 : 60;
  const deadline = dated ? Math.floor((h.clock.now() + 300 * S) / 1000) * 1000 : 0;
  for (let t = 15; t < wait; t += 15) {
    await h.advance(15 * S);
    if (!deadline || h.clock.now() < deadline) expect([t, h.gh.calls.length]).toEqual([t, calls]);
  }
  await h.advance(15 * S);
  expect(h.gh.calls.length).toBeGreaterThan(calls);
  expect(h.logs.filter((l) => l.startsWith("GitHub rate limit"))).toHaveLength(1);
});

test("UNKNOWN keeps the last known mergeability and never makes a transition", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  pr.mergeable = "UNKNOWN";
  pr.mergeStateStatus = "UNKNOWN";
  h.start();
  await h.advance(0);
  const saved = () => JSON.parse(snapshotOf(url("o/r", 1)));
  expect(saved()).toMatchObject({ mergeable: null, mergeStateStatus: null });
  for (const [field, state, kind] of [
    ["mergeable", "CONFLICTING", "pr.conflicting"],
    ["mergeStateStatus", "BEHIND", "pr.behind"],
  ] as const) {
    pr[field] = state;
    await h.advance(15 * S);
    expect(kinds()).toEqual([kind]);
    pr[field] = "UNKNOWN";
    await h.advance(15 * S);
    expect(saved()[field]).toBe(state);
    h.reopen();
    h.start();
    await h.advance(0);
    pr[field] = state;
    await h.advance(15 * S);
    expect(kinds()).toEqual([]);
  }
  // A new head that is still conflicting and behind is reported once more, with no UNKNOWN between.
  pr.headRefOid = "e".repeat(40);
  await h.advance(15 * S);
  expect(kinds().toSorted()).toEqual(["pr.behind", "pr.conflicting"]);
  pr.mergeable = "MERGEABLE";
  await h.advance(15 * S);
  pr.mergeable = "CONFLICTING";
  await h.advance(15 * S);
  expect(kinds()).toEqual([]);
  // A new head whose mergeability is not known yet reports nothing until GitHub computes it.
  pr.headRefOid = "f".repeat(40);
  pr.mergeable = "UNKNOWN";
  pr.mergeStateStatus = "UNKNOWN";
  await h.advance(15 * S);
  expect(kinds()).toEqual([]);
  expect(saved()).toMatchObject({ headRefOid: pr.headRefOid, mergeable: null, mergeStateStatus: null });
  pr.mergeable = "CONFLICTING";
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.conflicting"]);
});

test("deleting comments or reviews is not activity; additions and edits of older items are", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  const c = (id: string, updatedAt: string) => ({ id, updatedAt });
  pr.comments.nodes = [c("C1", "t1"), c("C2", "t2"), c("C3", "t3")];
  pr.reviews.nodes = [
    { ...c("R1", "t1"), comments: { nodes: [] } },
    { ...c("R2", "t2"), comments: { nodes: [] } },
  ];
  h.start();
  await h.advance(0);
  const steps: [() => void, string[]][] = [
    [() => pr.comments.nodes.pop(), []],
    [() => pr.reviews.nodes.pop(), []],
    [() => (pr.comments.nodes = []), []],
    [() => (pr.reviews.nodes = []), []],
    [() => pr.comments.nodes.push(c("C4", "t4")), ["comment"]],
    [() => pr.reviews.nodes.push({ ...c("R3", "t4"), comments: { nodes: [] } }), ["review"]],
    [() => pr.comments.nodes.unshift(c("C0", "t0")), []],
    [() => (pr.comments.nodes[0] = c("C0", "t5")), ["comment"]],
    // A new item in the same second as the newest is still new.
    [() => pr.comments.nodes.push(c("C9", "t5")), ["comment"]],
    [() => pr.comments.nodes.pop(), []],
  ];
  for (const [i, [change, expected]] of steps.entries()) {
    change();
    await h.advance(15 * S);
    expect([i, h.fresh().map((item) => item.data.category)]).toEqual([i, expected]);
  }
});

test("an older item a deletion lets the page backfill is not activity, even with a tied timestamp", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  const c = (id: string, createdAt: string, updatedAt = createdAt) => ({ id, createdAt, updatedAt });
  const old = c("C0", "2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z"); // edited when C10 was created
  const page = Array.from({ length: 10 }, (_, i) =>
    c(`C${i + 1}`, `2026-10-02T00:00:${String(i).padStart(2, "0")}Z`),
  );
  const last = page[9];
  if (!last) throw new Error("no page");
  last.createdAt = last.updatedAt = "2026-10-03T00:00:00Z";
  pr.comments.nodes = page;
  const review = { ...c("R1", "2026-10-01T00:00:00Z"), comments: { nodes: page.map((x) => ({ ...x })) } };
  pr.reviews.nodes = [review];
  h.start();
  await h.advance(0);
  const steps: [() => void, string[]][] = [
    [() => (pr.comments.nodes = [old, ...page.slice(0, 9)]), []],
    [() => (review.comments.nodes = [old, ...page.slice(0, 9)]), []],
    // Created in the same second as the newest known item: still new.
    [() => pr.comments.nodes.push(c("C11", "2026-10-02T00:00:08Z")), ["comment"]],
    [() => (pr.comments.nodes[0] = c("C0", "2026-10-01T00:00:00Z", "2026-10-04T00:00:00Z")), ["comment"]],
  ];
  for (const [i, [change, expected]] of steps.entries()) {
    change();
    await h.advance(15 * S);
    expect([i, h.fresh().map((item) => item.data.category)]).toEqual([i, expected]);
  }
});

test("a backfilled item created in the same second as the whole page is not activity", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  const t = "2026-10-02T00:00:00Z";
  const c = (id: string, updatedAt = t) => ({ id, createdAt: t, updatedAt });
  const burst = Array.from({ length: 11 }, (_, i) => c(`C${i}`)); // one second of bot comments
  pr.comments.nodes = burst.slice(1);
  const review = { ...c("R1"), comments: { nodes: burst.slice(1) } };
  pr.reviews.nodes = [review];
  h.start();
  await h.advance(0);
  const steps: [() => void, string[]][] = [
    // Deleting the newest item lets C0, created and updated in the same second as every other, backfill.
    [() => (pr.comments.nodes = burst.slice(0, 10)), []],
    [() => (review.comments.nodes = burst.slice(0, 10)), []],
    // An item appended in that same second is still new, and so is an edit of the backfilled one.
    [() => pr.comments.nodes.push(c("C11")), ["comment"]],
    [() => review.comments.nodes.push(c("RC11")), ["review_comment"]],
    [() => (pr.comments.nodes[0] = c("C0", "2026-10-02T00:00:01Z")), ["comment"]],
  ];
  for (const [i, [change, expected]] of steps.entries()) {
    change();
    await h.advance(15 * S);
    expect([i, h.fresh().map((item) => item.data.category)]).toEqual([i, expected]);
  }
});

test.each([false, true])(
  "review-comment backfills use their own review's ordering (legacy=%s)",
  async (legacy) => {
    h = pollerHarness();
    const run = h.factoryPr("o/r", 1);
    const pr = h.node("o/r", 1);
    const c = (id: string, updatedAt = "t1") => ({ id, createdAt: "t1", updatedAt });
    const page = Array.from({ length: 11 }, (_, i) => c(`C${i}`));
    const first = { ...c("R1"), comments: { nodes: [c("other")] } };
    const second = { ...c("R2"), comments: { nodes: page.slice(1) } };
    pr.reviews.nodes = [first, second];
    h.start();
    await h.advance(0);
    expect(kinds()).toEqual([]);
    if (legacy) {
      const data = JSON.parse(snapshotOf(pr.url));
      delete data.reviewComments;
      h.store.saveGithubPr({
        url: pr.url,
        repo: "o/r",
        runId: run.id,
        delivered: 1,
        nodeId: pr.id,
        data: JSON.stringify(data),
      });
    }
    h.reopen();
    // Deleting C10 backfills C0. The first review's known comment proves nothing about C0's order.
    second.comments.nodes = page.slice(0, 10);
    h.start();
    await h.advance(0);
    expect(kinds()).toEqual([]);
    const steps: [() => void, string[]][] = [
      [() => pr.reviews.nodes.unshift({ ...c("R0"), comments: { nodes: [c("backfilled")] } }), []],
      [() => pr.reviews.nodes.reverse(), []],
      [() => second.comments.nodes.push(c("C11")), ["review_comment"]],
      [() => (second.comments.nodes[0] = c("C0", "t2")), ["review_comment"]],
      [() => (second.comments.nodes = []), []],
    ];
    for (const [change, expected] of steps) {
      change();
      await h.advance(15 * S);
      expect(h.fresh().map((item) => item.data.category)).toEqual(expected);
    }
  },
);

test("snapshots persisted with the previous activity markers are upgraded, not fatal", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1);
  h.factoryPr("o/r", 2); // a later PR in the same batch must still be observed
  const pr = h.node("o/r", 1);
  const c = (id: string, createdAt: string, updatedAt = createdAt) => ({ id, createdAt, updatedAt });
  pr.comments.nodes = [
    c("C1", "2026-10-01T00:00:00Z"),
    c("C2", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z"),
  ];
  const full = normalizePr(pr);
  if (!full) throw new Error("bad node");
  const { reviews: _, ...snap } = full;
  // The previous release kept each category's newest item as `id@updatedAt`, or null, and no reviews.
  const activity = { review: null, review_comment: null, comment: "C2@2026-10-02T01:00:00Z" };
  const data = JSON.stringify({ ...snap, activity, revision: 0, unknown: 0, nudged: null });
  h.store.saveGithubPr({ url: url("o/r", 1), repo: "o/r", runId: run.id, delivered: 1, nodeId: pr.id, data });
  // A review arrived while the daemon was down: the first upgraded observation reports it, and only it.
  const review = { ...c("R1", "2026-10-02T02:00:00Z"), comments: { nodes: [] as ReturnType<typeof c>[] } };
  pr.reviews.nodes = [review];
  h.start();
  await h.advance(0);
  expect(h.logs).toEqual([]);
  expect(h.fresh().map((i) => i.data.category)).toEqual(["review"]);
  expect(h.store.githubPrData(url("o/r", 2))).not.toBeNull();
  await h.advance(15 * S);
  expect(kinds()).toEqual([]);
  pr.comments.nodes.push(c("C3", "2026-10-03T00:00:00Z"));
  review.comments.nodes.push(c("RC1", "2026-10-03T00:00:00Z"));
  pr.latestReviews.nodes = [{ state: "APPROVED", author: { login: "alice" } }];
  await h.advance(15 * S);
  expect(
    h
      .fresh()
      .map((i) => i.data.category ?? i.kind)
      .sort(),
  ).toEqual(["comment", "pr.review", "review_comment"]);
  pr.state = "MERGED";
  pr.mergedAt = "2026-10-03T02:00:00Z";
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.merged"]);
  expect(h.store.getRun(run.id)?.merged).toBe(true);
});

test("node ids are queried at most 100 per request, serially, and resolved once", async () => {
  for (const count of [100, 101, 201]) {
    h = pollerHarness();
    for (let n = 1; n <= count; n++) h.factoryPr("o/r", n);
    h.start();
    await h.advance(0);
    const sizes = h.gh.graphql().map((c) => c.ids?.length);
    expect(sizes).toEqual(count === 100 ? [100] : count === 101 ? [100, 1] : [100, 100, 1]);
    expect(new Set(h.gh.graphql().flatMap((c) => c.ids)).size).toBe(count);
    expect(h.gh.rest()).toHaveLength(count);
    expect(h.gh.maxInFlight).toBe(1);
    await h.advance(15 * S);
    expect(h.gh.rest()).toHaveLength(count);
    expect(h.gh.graphql()).toHaveLength(sizes.length * 2);
    h.close();
  }
  h = pollerHarness();
});

test("a failing rollup that fills the 100 fetched contexts says its list may be truncated", async () => {
  h = pollerHarness();
  h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  const passing = Array.from({ length: 99 }, (_, i) => ({ name: `ok${i}`, conclusion: "SUCCESS" }));
  ci(pr, rollup("FAILURE", [...passing, { name: "t", conclusion: "FAILURE" }]));
  h.start();
  await h.advance(0);
  const [item] = h.fresh();
  expect(item?.data).toMatchObject({ failing: [{ name: "t", url: null }], truncated: true });
  expect(JSON.parse(snapshotOf(url("o/r", 1))).truncated).toBe(true);
  // A shorter list is complete.
  pr.headRefOid = "c".repeat(40);
  ci(pr, rollup("FAILURE", [{ name: "t", conclusion: "FAILURE" }]));
  await h.advance(15 * S);
  expect(h.fresh()[0]?.data.truncated).toBeUndefined();
  expect(JSON.parse(snapshotOf(url("o/r", 1))).truncated).toBeUndefined();
});

test("store failures anywhere in a poll are logged and polling continues, without a tight loop", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1);
  const store = h.store;
  const tracked = store.githubTracked.bind(store);
  let failPlan = 0;
  store.githubTracked = () => {
    if (failPlan-- > 0) throw new Error("plan boom");
    return tracked();
  };
  failPlan = 1; // the startup schedule itself fails
  h.start();
  expect(h.logs).toEqual([expect.stringContaining("plan boom")]);
  await h.advance(60 * S);
  expect(h.gh.graphql()).toHaveLength(1);
  // plan() inside the tick fails, then again on the retry, which backs off.
  const booms = () => h.logs.filter((l) => l.includes("plan boom")).length;
  failPlan = 2;
  await h.advance(15 * S);
  expect(booms()).toBe(2);
  await h.advance(15 * S);
  expect(booms()).toBe(3);
  await h.advance(29 * S);
  expect(h.gh.graphql()).toHaveLength(1);
  await h.advance(S);
  expect(h.gh.graphql()).toHaveLength(2);
  // A run update whose scheduling fails is logged; polling resumes within a minute.
  failPlan = 1;
  h.store.updateRun(run.id, { title: "renamed" });
  expect(booms()).toBe(4);
  expect(h.clock.pending).toBe(1);
  await h.advance(60 * S);
  expect(h.gh.graphql()).toHaveLength(3);
  // Reconciliation fails once after a merge; the next poll reconciles.
  const reconcile = store.reconcileWaitingRuns.bind(store);
  let failReconcile = true;
  store.reconcileWaitingRuns = () => {
    if (failReconcile) {
      failReconcile = false;
      throw new Error("reconcile boom");
    }
    reconcile();
  };
  merge(h.node("o/r", 1));
  await h.advance(15 * S);
  expect(h.logs.at(-1)).toContain("reconcile boom");
  // Nothing is left to observe, but the failed reconciliation still has its retry timer.
  expect(h.store.githubTracked()).toEqual([]);
  expect(h.clock.pending).toBe(1);
  await h.advance(15 * S);
  expect(h.store.getRun(run.id)?.merged).toBe(true);
  expect(h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged")).toHaveLength(1);
});

test("stop during a request aborts it and leaves no timer, request or further scheduling", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1);
  const stop = h.start();
  await h.advance(0);
  h.gh.hold = new Promise(() => {});
  await h.advance(15 * S);
  expect(h.gh.inFlight).toBe(1);
  const calls = h.gh.calls.length;
  stop();
  await h.advance(0);
  expect(h.gh.signals.at(-1)?.aborted).toBe(true);
  expect(h.gh.inFlight).toBe(0);
  expect(h.clock.pending).toBe(0);
  h.store.updateRun(run.id, { title: "a run update does not restart polling" });
  await h.advance(3600 * S);
  expect(h.gh.calls.length).toBe(calls);
  expect(h.clock.pending).toBe(0);
});

test("config: a poll_seconds that is not a finite number is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-poll-config-"));
  const load = (toml: string) => {
    writeFileSync(join(dir, "config.toml"), `[github]\n${toml}\n`);
    return loadConfig({ home: dir, configDir: dir });
  };
  try {
    for (const bad of [
      'poll_seconds = "60"',
      "poll_seconds = true",
      "poll_seconds = [60]",
      "poll_seconds = nan",
      "poll_seconds = inf",
    ])
      expect(() => load(bad)).toThrow("github.poll_seconds");
    expect(load("poll = true").githubPollSeconds).toBe(45);
    expect(load("poll_seconds = 90").githubPollSeconds).toBe(90);
    expect(load("poll_seconds = 1").githubPollSeconds).toBe(15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  h = pollerHarness();
});

test("an approval goes stale when the poller sees the PR head move, except through the factory's base merges", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 1);
  const pr = h.node("o/r", 1);
  const prUrl = url("o/r", 1);
  h.store.recordApproval(run.id, prUrl, SHA, "reviewer");
  h.start(15);
  await h.advance(0);
  expect(h.store.approvalFor(prUrl)).toEqual({ sha: SHA, stale: false });
  // Two base merges the factory made on top of the approved head keep it current.
  const [merge, again] = ["b".repeat(40), "c".repeat(40)];
  h.store.recordBaseMerge(prUrl, merge, SHA, run.id);
  h.store.recordBaseMerge(prUrl, again, merge, run.id);
  pr.headRefOid = again;
  await h.advance(15 * S);
  expect(h.store.approvalFor(prUrl)).toEqual({ sha: SHA, stale: false });
  pr.headRefOid = "d".repeat(40);
  await h.advance(15 * S);
  expect(h.store.approvalFor(prUrl)).toEqual({ sha: SHA, stale: true });
  // Staleness sticks: moving the head back does not restore the approval.
  pr.headRefOid = SHA;
  await h.advance(15 * S);
  expect(h.store.approvalFor(prUrl)).toEqual({ sha: SHA, stale: true });
});
