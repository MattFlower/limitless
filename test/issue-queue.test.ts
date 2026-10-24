import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, RunStatus } from "../src/core/types.ts";
import { ISSUE_CLAIM_STATUSES, IssueClaimed, Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { githubWebhook, issueRunRequest, mapGitHubEvent } from "../src/integrations/github.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { issueEligibility, type QueueIssue, startIssueQueue } from "../src/integrations/issue-queue.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { waitClock } from "./wait-clock.ts";

const at = "2026-01-01T00:00:00Z";
function issue(number = 1, p = 1): QueueIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: "Implement it.\nAllow: submodules",
    createdAt: at,
    state: "OPEN",
    author: { login: "owner" },
    editor: null,
    lastEditedAt: null,
    labels: { totalCount: 1, nodes: [{ name: `priority:${p}` }] },
    subIssuesSummary: { total: 0 },
    blockedBy: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    timelineItems: {
      totalCount: 1,
      nodes: [
        {
          __typename: "LabeledEvent",
          label: { name: `priority:${p}` },
          actor: { login: "owner" },
          createdAt: at,
        },
      ],
    },
  };
}
const exclusions: [string, (i: QueueIssue) => void][] = [
  [
    "untrusted author",
    (i) => {
      i.author = { login: "stranger" };
    },
  ],
  [
    "untrusted body editor",
    (i) => {
      i.lastEditedAt = at;
      i.editor = { login: "stranger" };
    },
  ],
  [
    "untrusted body editor",
    (i) => {
      i.lastEditedAt = at;
    },
  ],
  [
    "no priority label",
    (i) => {
      i.labels = { totalCount: 0, nodes: [] };
    },
  ],
  [
    "priority application",
    (i) => {
      i.timelineItems.nodes[0] = {
        __typename: "LabeledEvent",
        label: { name: "priority:1" },
        actor: { login: "stranger" },
        createdAt: at,
      };
    },
  ],
  [
    "priority application",
    (i) => {
      i.timelineItems = { totalCount: 0, nodes: [] };
    },
  ],
  [
    "epic",
    (i) => {
      i.subIssuesSummary.total = 1;
    },
  ],
  [
    "native blocker",
    (i) => {
      i.blockedBy = { totalCount: 1, nodes: [{ state: "OPEN" }] };
    },
  ],
  [
    "body blocker",
    (i) => {
      i.body = "bLoCkEd By #9";
    },
  ],
  [
    "factory status",
    (i) => {
      i.labels.nodes.push({ name: "limitless:in-progress" });
      i.labels.totalCount++;
    },
  ],
  [
    "factory status",
    (i) => {
      i.labels.nodes.push({ name: "limitless:failed" });
      i.labels.totalCount++;
    },
  ],
  [
    "closing PR",
    (i) => {
      i.closedByPullRequestsReferences = { totalCount: 1, nodes: [{ state: "OPEN" }] };
    },
  ],
  [
    "incomplete",
    (i) => {
      i.blockedBy.totalCount = 101;
    },
  ],
  [
    "closed",
    (i) => {
      i.state = "CLOSED";
    },
  ],
];
test.each(exclusions)("excludes %s", (reason, change) => {
  const candidate = issue();
  change(candidate);
  expect(issueEligibility(candidate, ["OWNER"])).toMatchObject({
    eligible: false,
    reason: expect.stringContaining(reason),
  });
});

test("closed dependencies and merged PRs allow a trusted, edited issue", () => {
  const i = issue();
  i.editor = { login: "OWNER" };
  i.lastEditedAt = at;
  i.body = "Blocked by #9\r\nBlocked by #10";
  i.blockedBy = { totalCount: 1, nodes: [{ state: "CLOSED" }] };
  i.closedByPullRequestsReferences = { totalCount: 1, nodes: [{ state: "MERGED" }] };
  expect(
    issueEligibility(i, ["owner"], {
      blockers: new Map([
        [9, "CLOSED"],
        [10, "CLOSED"],
      ]),
    }),
  ).toEqual({ eligible: true, priority: 1 });
});

test.each([
  ["succeeded", "CLOSED"],
  ["succeeded", null],
  ["resolved", null],
  ["succeeded", "MERGED"],
] as const)("finished %s run with closing PR %s requires re-approval", async (status, pr) => {
  const h = harness();
  const candidate = issue();
  if (pr) candidate.closedByPullRequestsReferences = { totalCount: 1, nodes: [{ state: pr }] };
  const run = await h.factory.createRun(
    issueRunRequest({ repo: "owner/repo", number: 1, title: "Issue", body: "", author: "owner" }, "owner"),
  );
  const finishedAt = Date.parse(at) + 1000;
  const latest = h.store.updateRun(run.id, { status, finishedAt });
  const check = () => issueEligibility(candidate, ["owner"], { latest });
  expect(check()).toEqual({
    eligible: false,
    reason: "priority re-approval required after the latest issue run",
  });
  candidate.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "priority:2" },
    actor: { login: "stranger" },
    createdAt: new Date(finishedAt + 1).toISOString(),
  });
  candidate.timelineItems.totalCount++;
  expect(check()).toEqual({
    eligible: false,
    reason: "priority re-approval required after the latest issue run",
  });
  // A different priority label may re-approve; the current label must still be trusted.
  candidate.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "priority:2" },
    actor: { login: "owner" },
    createdAt: new Date(finishedAt + 2).toISOString(),
  });
  candidate.timelineItems.totalCount++;
  expect(check()).toEqual({ eligible: true, priority: 1 });
  latest.finishedAt = null;
  expect(check()).toEqual({
    eligible: false,
    reason: "priority re-approval required after the latest issue run",
  });
});

test.each([
  "Blocked by #12, #13",
  "- Blocked by #12",
  "Blocked by: #12",
  "1. blocked by #12",
  "2) Blocked by #12",
  " \t* BLOCKED BY: #12",
  "+ Blocked by #12",
])("body blocker shape: %s", (body) => {
  const candidate = { ...issue(), body };
  const states = new Map([
    [12, "OPEN"],
    [13, "OPEN"],
  ]);
  const check = () => issueEligibility(candidate, ["owner"], { blockers: states });
  expect(check()).toEqual({ eligible: false, reason: "open or unresolved body blocker" });
  states.set(12, "CLOSED");
  if (body.includes("#13"))
    expect(check()).toEqual({ eligible: false, reason: "open or unresolved body blocker" });
  states.set(13, "CLOSED");
  expect(check()).toEqual({ eligible: true, priority: 1 });
});

test.each([{ login: "stranger" }, null])("untrusted title rename actor %j", (actor) => {
  const candidate = issue();
  candidate.timelineItems.nodes.push({
    __typename: "RenamedTitleEvent",
    actor,
    createdAt: at,
  });
  candidate.timelineItems.totalCount++;
  expect(issueEligibility(candidate, ["owner"])).toEqual({
    eligible: false,
    reason: "untrusted title editor",
  });
  candidate.timelineItems.nodes.push({
    __typename: "RenamedTitleEvent",
    actor: { login: "OWNER" },
    createdAt: at,
  });
  candidate.timelineItems.totalCount++;
  expect(issueEligibility(candidate, ["owner"])).toEqual({ eligible: true, priority: 1 });
  // A later node with an older timestamp must not override the latest rename.
  candidate.timelineItems.nodes.push({
    __typename: "RenamedTitleEvent",
    actor,
    createdAt: "2025-01-01T00:00:00Z",
  });
  candidate.timelineItems.totalCount++;
  expect(issueEligibility(candidate, ["owner"])).toEqual({ eligible: true, priority: 1 });
});

test("incomplete timeline cannot approve an issue", () => {
  const candidate = issue();
  candidate.timelineItems.totalCount = 101;
  expect(issueEligibility(candidate, ["owner"])).toEqual({
    eligible: false,
    reason: "incomplete issue evidence",
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function harness(rawQueue: Record<string, unknown> | null = {}, repos = ["owner/repo"]) {
  const dir = mkdtempSync(join(tmpdir(), "issue-queue-"));
  const cfg = loadConfig({
    home: dir,
    configDir: dir,
    raw: {
      owners: { github: "owner" },
      github: { poll: false, ...(rawQueue === null ? {} : { queue: { repos, ...rawQueue } }) },
      limits: { max_concurrent_runs: 4 },
    },
  });
  cfg.secrets.DISCORD_BOT_TOKEN = "";
  cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
  const store = new Store(":memory:");
  const factory = new Factory(cfg, {
    store,
    harnesses: {
      fake: fakeHarness(() => {
        throw new Error("queue must not execute stages");
      }),
    },
  });
  for (const slug of repos)
    store.upsertRepo({
      slug,
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
  const clock = waitClock();
  const data = new Map(repos.map((r) => [r, [] as QueueIssue[]]));
  const states = new Map<number, string | null>();
  const calls: string[][] = [];
  const delays: number[] = [];
  const logs: string[] = [];
  const requests: CreateRunRequest[] = [];
  let stop = () => {};
  const h = {
    cfg,
    store,
    factory,
    clock,
    data,
    states,
    calls,
    delays,
    logs,
    requests,
    rate: { cost: 1, remaining: 5000, resetAt: new Date(clock.now() + 3600_000).toISOString() },
    response: undefined as unknown,
    hold: undefined as Promise<void> | undefined,
    scopes: [] as (string | undefined)[],
    async gh(args: string[], _signal?: AbortSignal, _stdin?: string, repo?: string) {
      h.scopes.push(repo);
      calls.push(args);
      if (h.hold) await h.hold;
      if (h.response !== undefined) return JSON.stringify(h.response);
      const query = args[3] ?? "";
      const owner = query.match(/owner:"([^"]+)"/)?.[1];
      const name = query.match(/name:"([^"]+)"/)?.[1];
      const repository = query.includes("issues(first:")
        ? { issues: { nodes: data.get(`${owner}/${name}`), pageInfo: { hasNextPage: false } } }
        : Object.fromEntries(
            [...query.matchAll(/i(\d+):issue/g)].map((m) => [
              `i${m[1]}`,
              states.get(Number(m[1])) ? { state: states.get(Number(m[1])) } : null,
            ]),
          );
      return JSON.stringify({ data: { repository, rateLimit: h.rate } });
    },
    start() {
      stop = startIssueQueue(factory, {
        gh: h.gh,
        clock: {
          now: clock.now,
          set: ((fn: () => void, ms: number) => {
            delays.push(ms);
            return clock.timer.set(fn, ms);
          }) as unknown as typeof setTimeout,
          clear: clock.timer.clear,
        },
        log: (s) => logs.push(s),
      });
    },
    stop: () => stop(),
    async advance(ms = 0) {
      await clock.advance(ms);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    },
    runs: () => store.listRuns({ limit: 1000 }),
  };
  const create = factory.createRun.bind(factory);
  factory.createRun = async (req, ...args) => {
    requests.push(req);
    return create(req, ...args);
  };
  cleanups.push(async () => {
    stop();
    await factory.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("poll selects an eligible issue using exactly the webhook builder", async () => {
  const h = harness();
  const i = issue();
  h.data.set("owner/repo", [i]);
  h.start();
  await h.advance();
  const mapped = mapGitHubEvent(
    "issues",
    {
      action: "labeled",
      repository: { full_name: "owner/repo" },
      sender: { login: "owner" },
      label: { name: "limitless" },
      issue: { ...i, user: i.author },
    },
    "owner",
  );
  if (!mapped.request) throw new Error("missing webhook request");
  expect(h.requests).toEqual([
    { ...mapped.request, sourceRef: { ...mapped.request.sourceRef, via: "queue" } },
  ]);
  expect(h.runs()[0]).toMatchObject({
    sourceRef: { kind: "issue", repo: "owner/repo", number: 1, via: "queue" },
    githubWebhookVerified: false,
  });
  expect(h.requests[0]?.allow).toEqual(["submodules"]);
  expect(
    issueRunRequest(
      { repo: "owner/repo", number: 2, title: i.title, body: i.body, author: "collaborator" },
      "owner",
    ).allow,
  ).toEqual([]);
});

test.each(["priority", "age", "multiple labels", "untrusted urgent", "number"])(
  "global ordering by %s",
  async (mode) => {
    const h = harness({}, ["owner/a", "owner/b"]);
    h.cfg.maxConcurrentRuns = 1;
    const first = issue(2, mode === "priority" ? 5 : 1);
    const second = issue(1, 1);
    if (mode === "priority" || mode === "age") first.createdAt = "2025-01-01T00:00:00Z";
    if (mode === "age") second.createdAt = "2024-01-01T00:00:00Z";
    if (mode === "multiple labels") {
      second.labels.nodes.push({ name: "priority:5" });
      second.labels.totalCount++;
      second.timelineItems.nodes.push({
        __typename: "LabeledEvent",
        label: { name: "priority:5" },
        actor: { login: "owner" },
        createdAt: at,
      });
      second.timelineItems.totalCount++;
      first.labels.nodes = [{ name: "priority:2" }];
      first.timelineItems.nodes[0] = {
        __typename: "LabeledEvent",
        label: { name: "priority:2" },
        actor: { login: "owner" },
        createdAt: at,
      };
    }
    if (mode === "untrusted urgent") {
      first.labels.nodes.push({ name: "priority:0" });
      first.labels.totalCount++;
      first.timelineItems.nodes.push({
        __typename: "LabeledEvent",
        label: { name: "priority:0" },
        actor: { login: "stranger" },
        createdAt: at,
      });
    }
    first.timelineItems.totalCount = first.timelineItems.nodes.length;
    h.data.set("owner/a", [first]);
    h.data.set("owner/b", [second]);
    h.start();
    await h.advance();
    expect(h.runs()).toHaveLength(1);
    expect(h.runs()[0]?.sourceRef).toMatchObject({ repo: "owner/b", number: 1 });
  },
);

test("capacity includes held issue runs; urgency adds exactly one", async () => {
  const h = harness();
  const repo = h.store.listRepos()[0];
  if (!repo) throw new Error("missing repo");
  const active = await h.factory.createRun(
    issueRunRequest({ repo: repo.slug, number: 10, title: "active", body: "", author: "owner" }, "owner"),
  );
  h.store.updateRun(active.id, { status: "needs_human" });
  h.data.set(repo.slug, [issue(1)]);
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(1);
  h.data.set(repo.slug, [issue(1), issue(2, 0), issue(3, 0)]);
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(2);
  expect(h.runs().some((r) => r.sourceRef?.kind === "issue" && r.sourceRef.number === 2)).toBe(true);
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(2);
});

test("overall run slots limit urgent issues even when the issue cap has room", async () => {
  const limited = harness({ max_issue_runs: 10 });
  limited.cfg.maxConcurrentRuns = 1;
  await limited.factory.createRun({ repo: "owner/repo", prompt: "unrelated work" });
  limited.data.set("owner/repo", [issue(1, 0)]);
  limited.start();
  await limited.advance();
  expect(limited.runs()).toHaveLength(1);
});

test("draining prevents queue starts", async () => {
  const draining = harness();
  draining.factory.scheduler.drain();
  draining.data.set("owner/repo", [issue()]);
  draining.start();
  await draining.advance();
  expect(draining.runs()).toHaveLength(0);
});

test.each(["failed", "cancelled"] as const)(
  "%s run needs a newer trusted priority application",
  async (status) => {
    const h = harness();
    const i = issue();
    h.data.set("owner/repo", [i]);
    h.start();
    await h.advance();
    const run = h.runs()[0];
    if (!run) throw new Error("missing run");
    const finishedAt = Date.parse(at) + 1000;
    h.store.updateRun(run.id, { status, finishedAt });
    i.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name: "priority:1" },
      actor: { login: "owner" },
      createdAt: new Date(finishedAt).toISOString(),
    });
    i.timelineItems.totalCount++;
    await h.advance(180_000);
    expect(h.runs()).toHaveLength(1);
    i.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name: "priority:1" },
      actor: { login: "stranger" },
      createdAt: new Date(finishedAt + 1).toISOString(),
    });
    i.timelineItems.totalCount++;
    await h.advance(180_000);
    expect(h.runs()).toHaveLength(1);
    i.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name: "priority:1" },
      actor: { login: "OWNER" },
      createdAt: new Date(finishedAt + 2).toISOString(),
    });
    i.timelineItems.totalCount++;
    await h.advance(180_000);
    expect(h.runs()).toHaveLength(2);
  },
);

test("body dependencies are resolved by read-only aliased lookups; missing issues remain blocked", async () => {
  const h = harness();
  const i = issue();
  i.body = "Blocked by #9\nblocked BY #10";
  h.data.set("owner/repo", [i]);
  h.states.set(9, "CLOSED");
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(0);
  h.states.set(10, "OPEN");
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(0);
  h.states.set(10, "CLOSED");
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(1);
  expect(h.calls).toHaveLength(6);
  expect(
    h.calls.every(
      (args) => args.slice(0, 3).join(" ") === "api graphql -f" && !args[3]?.includes("mutation"),
    ),
  ).toBe(true);
});

test("poll query reads title evidence and looks up all body blockers", async () => {
  const h = harness();
  h.data.set("owner/repo", [{ ...issue(), body: "- Blocked by: #12, #13" }]);
  h.states.set(12, "CLOSED");
  h.states.set(13, "CLOSED");
  h.start();
  await h.advance();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[0]?.[3]).toContain("itemTypes:[LABELED_EVENT, RENAMED_TITLE_EVENT]");
  expect(h.calls[0]?.[3]).toContain("{ totalCount nodes { __typename");
  expect(h.calls[0]?.[3]).toContain("... on RenamedTitleEvent { actor { login } createdAt }");
  expect(h.calls[1]?.[3]).toContain("i12:issue(number:12)");
  expect(h.calls[1]?.[3]).toContain("i13:issue(number:13)");
  expect(h.runs()).toHaveLength(1);
});

test.each(["run limit", "issue run limit", "draining", "stopped", "re-approval"])(
  "admission rechecks %s after repository resolution",
  async (mode) => {
    const h = harness();
    if (mode === "run limit") h.cfg.maxConcurrentRuns = 1;
    const repo = h.store.getRepoBySlug("owner/repo");
    if (!repo) throw new Error("missing repo");
    const getRepo = h.store.getRepoBySlug.bind(h.store);
    let changed = false;
    let competingId = "";
    const finishedAt = Date.parse(at) + 1000;
    h.store.getRepoBySlug = (slug) => {
      h.store.getRepoBySlug = getRepo;
      // resolveRepo returns a promise, so this changes state while createRun awaits it.
      queueMicrotask(() => {
        if (mode === "run limit") h.store.createRun(repo, { repo: repo.slug, prompt: "other work" });
        else if (mode === "issue run limit")
          h.store.updateRun(
            h.store.createRun(
              repo,
              issueRunRequest(
                { repo: repo.slug, number: 99, title: "Other issue", body: "", author: "owner" },
                "owner",
              ),
            ).id,
            { status: "needs_human" },
          );
        else if (mode === "re-approval") {
          competingId = h.store.createRun(
            repo,
            issueRunRequest(
              { repo: repo.slug, number: 1, title: "Other start", body: "", author: "owner" },
              "owner",
            ),
          ).id;
          h.store.updateRun(competingId, { status: "cancelled", finishedAt });
        } else if (mode === "draining") h.factory.scheduler.drain();
        else h.stop();
        changed = true;
      });
      return getRepo(slug);
    };
    const queuePublications: string[] = [];
    const unsubscribe = h.store.subscribe((msg) => {
      if (msg.kind === "run" && msg.run.sourceRef?.via === "queue") queuePublications.push(msg.run.id);
    });
    try {
      const candidate = issue();
      h.data.set(repo.slug, [candidate]);
      h.start();
      await h.advance();
      expect(changed).toBe(true);
      expect(h.runs()).toHaveLength(mode.includes("limit") || mode === "re-approval" ? 1 : 0);
      expect(h.runs().some((r) => r.sourceRef?.via === "queue")).toBe(false);
      expect(queuePublications).toEqual([]);
      expect(h.store.db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
      expect(h.logs.join("\n")).toContain("Run admission refused:");
      expect(h.logs.join("\n")).toContain(mode);
      expect(h.clock.pending).toBe(mode === "stopped" ? 0 : 1);
      if (mode.includes("limit")) {
        for (const run of h.runs()) h.store.updateRun(run.id, { status: "succeeded" });
        await h.advance(180_000);
        expect(h.runs().filter((r) => r.sourceRef?.via === "queue")).toHaveLength(1);
      } else if (mode === "re-approval") {
        expect(h.runs()).toMatchObject([
          { id: competingId, status: "cancelled", sourceRef: { kind: "issue", number: 1 } },
        ]);
        candidate.timelineItems.nodes.push({
          __typename: "LabeledEvent",
          label: { name: "priority:1" },
          actor: { login: "owner" },
          createdAt: new Date(finishedAt + 1).toISOString(),
        });
        candidate.timelineItems.totalCount++;
        await h.advance(180_000);
        expect(h.runs()).toHaveLength(2);
        expect(h.runs().filter((r) => r.sourceRef?.via === "queue")).toHaveLength(1);
        expect(queuePublications).toHaveLength(1);
      }
    } finally {
      unsubscribe();
      h.store.getRepoBySlug = getRepo;
    }
  },
);

test("healthy daily polls retain their deadline across hourly wakeups", async () => {
  const h = harness({ poll_seconds: 86400 });
  h.start();
  await h.advance();
  expect(h.calls).toHaveLength(1);
  for (let hour = 1; hour < 24; hour++) {
    await h.advance(3_600_000);
    expect(h.calls).toHaveLength(1);
  }
  await h.advance(3_599_999);
  expect(h.calls).toHaveLength(1);
  await h.advance(1);
  expect(h.calls).toHaveLength(2);
  expect(h.delays[0]).toBe(0);
  expect(h.delays.slice(1).every((ms) => ms > 0 && ms <= 3_600_000)).toBe(true);
});

test("far-future rate reset caps every timer and queries nothing before the deadline", async () => {
  const h = harness();
  h.rate.remaining = 1;
  h.rate.resetAt = new Date(h.clock.now() + 40 * 24 * 3600_000).toISOString();
  h.start();
  await h.advance();
  expect(h.delays).toEqual([0, 3_600_000]);
  await h.advance(3_600_000);
  expect(h.calls).toHaveLength(1);
  expect(h.delays.at(-1)).toBe(3_600_000);
  await h.advance(39 * 24 * 3600_000 + 22 * 3600_000 + 3_000_000);
  expect(h.calls).toHaveLength(1);
  expect(h.delays.at(-1)).toBe(600_000);
  h.rate.remaining = 5000;
  await h.advance(599_999);
  expect(h.calls).toHaveLength(1);
  await h.advance(1);
  expect(h.calls).toHaveLength(2);
  expect(h.delays.at(-1)).toBe(180_000);
  expect(h.delays.slice(1).every((ms) => ms > 0 && ms <= 3_600_000)).toBe(true);
  await h.advance(179_999);
  expect(h.calls).toHaveLength(2);
  await h.advance(1);
  expect(h.calls).toHaveLength(3);
});

test("stopping during an intermediate rate-limit wait clears the timer", async () => {
  const h = harness();
  h.rate.remaining = 1;
  h.rate.resetAt = new Date(h.clock.now() + 40 * 24 * 3_600_000).toISOString();
  h.start();
  await h.advance();
  await h.advance(3_600_000);
  expect(h.calls).toHaveLength(1);
  expect(h.clock.pending).toBe(1);
  h.stop();
  expect(h.clock.pending).toBe(0);
  await h.advance(40 * 24 * 3_600_000);
  expect(h.calls).toHaveLength(1);
  expect(h.clock.pending).toBe(0);
});

test("low rate budget defers to reset and skips subsequent repositories; healthy polls use the normal cadence", async () => {
  const h = harness({}, ["owner/a", "owner/b"]);
  h.rate.remaining = 5;
  h.start();
  await h.advance();
  expect(h.calls).toHaveLength(1);
  await h.advance(3599_999);
  expect(h.calls).toHaveLength(1);
  h.rate.remaining = 5000;
  await h.advance(1);
  expect(h.calls).toHaveLength(3);
  await h.advance(179_999);
  expect(h.calls).toHaveLength(3);
  await h.advance(1);
  expect(h.calls).toHaveLength(5);
});

test.each([
  {},
  { errors: [{ message: "bad query" }], data: null },
  { data: { repository: { issues: null }, rateLimit: { cost: 1, remaining: 5000, resetAt: at } } },
])("malformed responses cannot start work and polling recovers", async (response) => {
  const h = harness();
  h.response = response;
  h.data.set("owner/repo", [issue()]);
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(0);
  expect(h.logs.length).toBeGreaterThan(0);
  h.response = undefined;
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(1);
});

test("stopping during an in-flight query prevents a late run or timer", async () => {
  const h = harness();
  const held = Promise.withResolvers<void>();
  h.hold = held.promise;
  h.data.set("owner/repo", [issue()]);
  const stop = startIssueQueue(h.factory, {
    gh: h.gh,
    clock: {
      now: h.clock.now,
      set: h.clock.timer.set as unknown as typeof setTimeout,
      clear: h.clock.timer.clear,
    },
  });
  await h.advance();
  stop();
  held.resolve();
  await h.advance();
  expect(h.runs()).toHaveLength(0);
  expect(h.clock.pending).toBe(0);
});

function webhook(h: ReturnType<typeof harness>, id: string) {
  const i = issue();
  const body = JSON.stringify({
    action: "labeled",
    repository: { full_name: "owner/repo" },
    sender: { login: "owner" },
    label: { name: "limitless" },
    issue: { ...i, user: i.author },
  });
  return githubWebhook(h.factory)(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
      },
    }),
  );
}
async function httpStart(h: ReturnType<typeof harness>) {
  const route = (createHttpRoutes(h.factory)["/api/runs"] as { POST: Route }).POST;
  return route(
    requestWithParams("http://localhost:7400/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo", prompt: "Implement it\nCloses #1" }),
    }),
    localServer,
  );
}

test.each([
  ["poll", "webhook", "http"],
  ["webhook", "http", "poll"],
  ["http", "poll", "webhook"],
])("one claim when %s starts first", async (...order) => {
  const h = harness();
  h.data.set("owner/repo", [issue()]);
  const responses: Response[] = [];
  for (const path of order) {
    if (path === "poll") {
      h.start();
      await h.advance();
    } else responses.push(await (path === "webhook" ? webhook(h, "label") : httpStart(h)));
  }
  expect(h.runs()).toHaveLength(1);
  const run = h.runs()[0];
  if (!run) throw new Error("missing run");
  for (const res of responses) if (res.status !== 201) expect(await res.text()).toContain(run.id);
  if (order[0] !== "poll") expect(h.logs.join("\n")).toContain(run.id);
  if (order[0] !== "webhook")
    expect(h.store.db.query("SELECT status, note FROM inbox WHERE id = 'label'").get()).toEqual({
      status: "ignored",
      note: expect.stringContaining(run.id),
    });
  const repo = h.store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const url = "https://github.com/owner/repo/pull/20";
  const sha = "a".repeat(40);
  const branch = "limitless/own";
  const owner = h.store.updateRun(run.id, { branch, prUrl: url });
  const round = h.store.createReviewRound(
    repo,
    owner,
    { prUrl: url, reviewedSha: sha, findings: [], cap: 3 },
    (n) => ({
      repo: repo.slug,
      prompt: "Review work\nCloses #1",
      baseBranch: branch,
      deliveryBranch: branch,
      sourceRef: { kind: "review-round", runId: run.id, round: n, prUrl: url, reviewedSha: sha },
    }),
  );
  expect(round).toHaveProperty("run");
  if ("run" in round) h.store.updateRun(round.run.id, { status: "succeeded" });
  h.store.updateRun(run.id, { status: "failed", finishedAt: Date.now() });
  expect((await httpStart(h)).status).toBe(201);
});

test("simultaneous poll, webhook and HTTP starts create one run", async () => {
  const h = harness();
  h.data.set("owner/repo", [issue()]);
  h.start();
  const results = await Promise.all([h.advance(), webhook(h, "race"), httpStart(h)]);
  expect(h.runs()).toHaveLength(1);
  const id = h.runs()[0]?.id;
  expect(id).toBeTruthy();
  for (const res of results)
    if (res && res.status !== 201) expect(await res.text()).toContain(id ?? "missing");
});

test.each(ISSUE_CLAIM_STATUSES)(
  "claims in status %s across repository casing and prompt/sourceRef paths",
  async (status) => {
    const h = harness();
    const run = await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #1" });
    h.store.updateRun(run.id, { status });
    expect(h.store.issueClaim("OWNER/REPO", 1)?.id).toBe(run.id);
    await expect(
      h.factory.createRun(
        issueRunRequest(
          { repo: "owner/repo", number: 1, title: "Issue", body: "", author: "owner" },
          "owner",
        ),
      ),
    ).rejects.toThrow(run.id);
  },
);

test.each(["before", "after"])(
  "quoted issue text never claims another issue started %s it, with the queue disabled",
  async (order) => {
    const h = harness(null);
    const request = (number: number, body = "") =>
      issueRunRequest({ repo: "owner/repo", number, title: "Issue", body, author: "owner" }, "owner");
    let secondId: string | undefined;
    if (order === "before") secondId = (await h.factory.createRun(request(2))).id;
    const first = await h.factory.createRun(request(1, "> Closes #2"));
    expect(h.store.issueClaim("OWNER/REPO", 1)?.id).toBe(first.id);
    if (order === "after") {
      expect(h.store.issueClaim("owner/repo", 2)).toBeNull();
      secondId = (await h.factory.createRun(request(2))).id;
    }
    expect(h.store.issueClaim("owner/repo", 2)?.id).toBe(secondId);
    expect(h.runs()).toHaveLength(2);
  },
);

test("non-issue GitHub prompts never claim quoted directives on insert or lookup", async () => {
  const h = harness(null);
  const cli = await h.factory.createRun({ repo: "owner/repo", source: "cli", prompt: "Closes #2" });
  await h.factory.createRun({ repo: "owner/repo", source: "github", prompt: "> Closes #2\n> Closes #3" });
  expect(h.store.issueClaim("owner/repo", 3)).toBeNull();
  const refused = h.factory.createRun(
    issueRunRequest({ repo: "owner/repo", number: 2, title: "Issue", body: "", author: "owner" }, "owner"),
  );
  await expect(refused).rejects.toThrow(IssueClaimed);
  await expect(refused).rejects.toThrow(cli.id);
  const webhook = await h.factory.createRun({ repo: "owner/repo", source: "webhook", prompt: "Closes #3" });
  expect(h.store.issueClaim("owner/repo", 3)?.id).toBe(webhook.id);
});

test.each(["failed", "cancelled", "succeeded", "resolved"] satisfies RunStatus[])(
  "terminal %s releases the claim",
  async (status) => {
    const h = harness();
    const run = await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #1" });
    h.store.updateRun(run.id, { status });
    expect(h.store.issueClaim("owner/repo", 1)).toBeNull();
    await expect(h.factory.createRun({ repo: "owner/repo", prompt: "Closes #1" })).resolves.toHaveProperty(
      "id",
    );
  },
);

test("queue config defaults and mount remain off without opt-in", async () => {
  const h = harness(null);
  expect(h.cfg.githubQueue).toBeNull();
  const integrations = await mountIntegrations(h.factory, {
    toolVersions: async () => [],
    gh: h.gh,
    prClient: async () => null,
    issueClock: {
      now: h.clock.now,
      set: h.clock.timer.set as unknown as typeof setTimeout,
      clear: h.clock.timer.clear,
    },
  });
  try {
    await h.advance(1000_000);
    expect(h.calls).toEqual([]);
    expect(integrations.notes).toContain("Issue queue disabled");
  } finally {
    await integrations.stop();
  }
  const enabled = harness();
  expect(enabled.cfg.githubQueue).toEqual({
    repos: ["owner/repo"],
    trusted: ["owner"],
    maxIssueRuns: 1,
    pollSeconds: 180,
  });
  const cfg = loadConfig({
    home: h.cfg.paths.home,
    configDir: h.cfg.paths.configDir,
    raw: { github: { queue: {} } },
  });
  expect(cfg.githubQueue?.trusted).toEqual([]);
});

test.each([
  ["repos", ["bad"]],
  ["repos", "owner/repo"],
  ["trusted", [""]],
  ["max_issue_runs", 0],
  ["max_issue_runs", 1.5],
  ["poll_seconds", 0],
  ["poll_seconds", "180"],
])("rejects invalid github.queue.%s", (key, value) => {
  const h = harness(null);
  expect(() =>
    loadConfig({
      home: h.cfg.paths.home,
      configDir: h.cfg.paths.configDir,
      raw: { github: { queue: { [String(key)]: value } } },
    }),
  ).toThrow(`github.queue.${key}`);
});

test("latest application wins even when timestamps tie, and missing actors cannot approve", () => {
  const i = issue();
  i.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "priority:1" },
    actor: null,
    createdAt: at,
  });
  i.timelineItems.totalCount++;
  expect(issueEligibility(i, ["owner"])).toMatchObject({
    eligible: false,
    reason: expect.stringContaining("priority application"),
  });
});

test("a run failing during another repository lookup is rechecked before starting", async () => {
  const h = harness({}, ["owner/a", "owner/b"]);
  const previous = await h.factory.createRun(
    issueRunRequest({ repo: "owner/a", number: 1, title: "Issue", body: "", author: "owner" }, "owner"),
  );
  h.store.updateRun(previous.id, { status: "succeeded", finishedAt: Date.parse(at) - 1000 });
  h.data.set("owner/a", [issue()]);
  const gh = h.gh;
  const pending = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  h.gh = async (args) => {
    if (args[3]?.includes('name:"b"')) {
      ready.resolve();
      await pending.promise;
    }
    return gh(args);
  };
  h.start();
  await h.advance();
  await ready.promise;
  h.store.updateRun(previous.id, { status: "failed", finishedAt: h.clock.now() });
  pending.resolve();
  await h.advance();
  expect(h.runs()).toHaveLength(1);
});

test("MCP, comments and retries share the claim refusal; repository scope stays independent", async () => {
  const h = harness({}, ["owner/repo", "owner/other"]);
  const owner = await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #1\nCloses #2" });
  const { factoryBackend } = await import("../src/integrations/mcp.ts");
  await expect(factoryBackend(h.factory).create({ repo: "owner/repo", prompt: "Closes #2" })).rejects.toThrow(
    owner.id,
  );
  await expect(h.factory.retryRun(owner.id)).rejects.toThrow(owner.id);
  const mapped = mapGitHubEvent(
    "issue_comment",
    {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "owner" },
      comment: { user: { login: "owner" }, body: "/limitless build this" },
      issue: { number: 1, title: "Issue", body: "" },
    },
    "owner",
  );
  if (!mapped.request) throw new Error("missing comment request");
  await expect(h.factory.createRun(mapped.request)).rejects.toThrow(owner.id);
  await expect(h.factory.createRun({ repo: "owner/other", prompt: "Closes #1" })).resolves.toHaveProperty(
    "id",
  );
});

test("explicit empty trust or repositories disable polling; positive short intervals clamp to 15 seconds", async () => {
  for (const q of [{ trusted: [] }, { repos: [] }]) {
    const h = harness(q);
    h.start();
    await h.advance(1000_000);
    expect(h.calls).toHaveLength(0);
  }
  expect(harness({ poll_seconds: 0.5 }).cfg.githubQueue?.pollSeconds).toBe(15);
});

test("mounted queue starts work without notifier writes and cleans up its timer", async () => {
  const h = harness();
  h.data.set("owner/repo", [issue()]);
  const integrations = await mountIntegrations(h.factory, {
    toolVersions: async () => [],
    gh: h.gh,
    prClient: async () => null,
    issueClock: {
      now: h.clock.now,
      set: h.clock.timer.set as unknown as typeof setTimeout,
      clear: h.clock.timer.clear,
    },
  });
  try {
    expect(integrations.notes).toContain("Issue queue: polling 1 repos every 180s");
    await h.advance();
    expect(h.runs()).toHaveLength(1);
    const run = h.runs()[0];
    if (!run) throw new Error("missing run");
    h.store.updateRun(run.id, { status: "failed", finishedAt: h.clock.now() });
    await h.advance();
    expect(h.calls.every((args) => args[0] === "api" && args[1] === "graphql")).toBe(true);
    expect(h.calls).toHaveLength(1);
  } finally {
    await integrations.stop();
  }
  expect(h.clock.pending).toBe(0);
});

test.each(["priority:01", "priority:11", "priority:-1", "Priority:1"])(
  "only exact priority labels approve: %s",
  (label) => {
    const i = issue();
    i.labels.nodes = [{ name: label }];
    expect(issueEligibility(i, ["owner"])).toMatchObject({ eligible: false, reason: "no priority label" });
  },
);

test("rate cost determines the low budget threshold, even on a partial GraphQL error", async () => {
  const h = harness({}, ["owner/a", "owner/b"]);
  h.rate = { ...h.rate, cost: 100, remaining: 500 };
  h.response = {
    errors: [{ message: "unavailable repository" }],
    data: { repository: null, rateLimit: h.rate },
  };
  h.start();
  await h.advance();
  expect(h.calls).toHaveLength(1);
  await h.advance(180_000);
  expect(h.calls).toHaveLength(1);
  expect(h.logs).toHaveLength(1);
});

test("a claim won after eligibility is refused without crashing the poll cycle", async () => {
  const h = harness();
  h.data.set("owner/repo", [issue()]);
  const create = h.factory.createRun.bind(h.factory);
  let claimingId = "";
  h.factory.createRun = async (request) => {
    const winner = await create({ repo: request.repo, prompt: "Closes #1" });
    claimingId = winner.id;
    return create(request);
  };
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(1);
  expect(h.logs.join("\n")).toContain(claimingId);
  expect(h.clock.pending).toBe(1);
});

test("App bot issues and priority labels never inherit the owner's trust", () => {
  const candidate = issue();
  candidate.author = { login: "factory[bot]" };
  expect(issueEligibility(candidate, ["owner"])).toEqual({ eligible: false, reason: "untrusted author" });
  candidate.author = { login: "owner" };
  const label = candidate.timelineItems.nodes[0];
  if (!label) throw new Error("missing priority event");
  label.actor = { login: "factory[bot]" };
  expect(issueEligibility(candidate, ["owner"])).toEqual({
    eligible: false,
    reason: "priority application is untrusted or missing",
  });
});

test("issue queue scopes both list and dependency GraphQL calls to the repository", async () => {
  const h = harness();
  h.data.set("owner/repo", [{ ...issue(), body: "Blocked by #9" }]);
  h.states.set(9, "CLOSED");
  h.start();
  await h.advance();
  expect(h.scopes).toEqual(["owner/repo", "owner/repo"]);
});
