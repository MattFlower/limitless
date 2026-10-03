import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
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
    [
      "approved",
      (n) => {
        n.reviewDecision = "APPROVED";
      },
      ["pr.review"],
    ],
    [
      "changes requested",
      (n) => {
        n.reviewDecision = "CHANGES_REQUESTED";
      },
      ["pr.review"],
    ],
    [
      "review required",
      (n) => {
        n.reviewDecision = "REVIEW_REQUIRED";
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

test("closed without merge emits pr.closed and leaves the polling set", async () => {
  h = pollerHarness();
  const run = h.factoryPr("o/r", 2);
  h.start();
  await h.advance(0);
  h.node("o/r", 2).state = "CLOSED";
  await h.advance(15 * S);
  expect(kinds()).toEqual(["pr.closed"]);
  expect(h.store.getRun(run.id)?.prClosedUnmerged).toBe(true);
  const calls = h.gh.calls.length;
  await h.advance(3600 * S);
  expect(h.gh.calls.length).toBe(calls);
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
  expect(h.gh.calls.at(-1)?.ids).toEqual(["PR_o/r_1"]);
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
    respond(403, {}),
    respond(200, { errors: [{ type: "RATE_LIMITED", message: "You have exceeded a secondary rate limit" }] }),
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
  pr.mergeable = "UNKNOWN";
  for (let i = 0; i < 3; i++) await h.advance(15 * S);
  expect(nudges()).toBe(2);
  pr.headRefOid = "d".repeat(40);
  for (let i = 0; i < 3; i++) await h.advance(15 * S);
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
  expect(githubDoctor(h.store).join("\n")).toContain("o/r");
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
  expect(diffPr(snap, { ...snap, activity: { ...snap.activity, comment: null } })).toEqual([]);
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
  expect(githubDoctor(h.store).join("\n")).toMatch(/o\/r[\s\S]*gh auth refresh/);
  await h.advance(15 * S);
  expect(h.store.githubAccessProblems()).toEqual([]);
  expect(githubDoctor(h.store)).toEqual(["GitHub access: ok"]);
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
