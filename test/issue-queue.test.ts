import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { feedCommand } from "../src/cli/feed.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, FeedPage, RunStatus } from "../src/core/types.ts";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { ISSUE_CLAIM_STATUSES, IssueClaimed, linkedIssues, Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import {
  commentRunRequest,
  githubWebhook,
  issueRunRequest,
  mapGitHubEvent,
} from "../src/integrations/github.ts";
import type { GitHubIdentity } from "../src/integrations/github-identity.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { reconcileIssueLifecycle } from "../src/integrations/issue-lifecycle.ts";
import {
  epicAttention,
  issueEligibility,
  type QueueIssue,
  startIssueQueue,
} from "../src/integrations/issue-queue.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { buildReport } from "../src/pipeline/report.ts";
import { reviewRoundPrompt } from "../src/pipeline/review-round.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { feedRound } from "./feed-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { waitClock } from "./wait-clock.ts";

const at = "2026-01-01T00:00:00Z";
const beforeLifecycle = (path: string) =>
  !path.endsWith("-issue-lifecycle.sql") && !path.endsWith("-issue-lifecycle-history.sql");
function issue(number = 1, p = 1): QueueIssue & { repository: { nameWithOwner: string } } {
  return {
    repository: { nameWithOwner: "owner/repo" },
    number,
    title: `Issue ${number}`,
    body: "Implement it.\nAllow: submodules",
    createdAt: at,
    updatedAt: at,
    comments: { totalCount: 0, nodes: [] },
    state: "OPEN",
    author: { login: "owner" },
    editor: null,
    lastEditedAt: null,
    labels: { totalCount: 1, nodes: [{ name: `priority:${p}` }] },
    subIssuesSummary: { total: 0 },
    subIssues: { totalCount: 0, nodes: [] },
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
      i.blockedBy = {
        totalCount: 1,
        nodes: [{ number: 9, state: "OPEN", repository: { nameWithOwner: "owner/repo" } }],
      };
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
  i.blockedBy = {
    totalCount: 1,
    nodes: [{ number: 9, state: "CLOSED", repository: { nameWithOwner: "owner/repo" } }],
  };
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
function harness(rawQueue: Record<string, unknown> | null = {}, repos = ["owner/repo"], fresh = false) {
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
  // Policy tests start with an enabled queue; initialization is exercised separately below.
  if (!fresh) for (const repo of repos) store.githubCommentBoundary(repo, at);
  const clock = waitClock();
  const data = new Map(repos.map((r) => [r, [] as QueueIssue[]]));
  const states = new Map<number, string | null>();
  const labels = new Map<number, Set<string>>();
  const comments = new Map<number, string[]>();
  const calls: string[][] = [];
  const delays: number[] = [];
  const logs: string[] = [];
  const requests: CreateRunRequest[] = [];
  let stop = () => {};
  let pollNow = () => {};
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
    labels,
    comments,
    timelines: new Map<number, QueueIssue["timelineItems"]>(),
    commentAuthors: new Map<string, string>(),
    login: "owner",
    labelAt: at,
    identity: async (_repo?: string): Promise<GitHubIdentity> => ({ kind: "owner" }),
    maxCalls: undefined as number | undefined,
    intercept: undefined as ((args: string[]) => void) | undefined,
    afterWrite: undefined as ((args: string[]) => void) | undefined,
    rate: { cost: 1, remaining: 5000, resetAt: new Date(clock.now() + 3600_000).toISOString() },
    response: undefined as unknown,
    rawResponse: undefined as string | undefined,
    boundaryResponse: `HTTP/2.0 200 OK\r\ndAtE: ${new Date(at).toUTCString()}\r\n\r\n{}`,
    hold: undefined as Promise<void> | undefined,
    scopes: [] as (string | undefined)[],
    async gh(args: string[], _signal?: AbortSignal, _stdin?: string, repo?: string) {
      h.scopes.push(repo);
      calls.push(args);
      h.intercept?.(args);
      if (h.hold) await h.hold;
      if (args.includes("rate_limit")) return h.boundaryResponse;
      if (args[1] !== "graphql") {
        const path = args[1] ?? "";
        if (path === "user") return JSON.stringify({ login: h.login });
        const number = Number(path.match(/issues\/(\d+)/)?.[1]);
        const current = labels.get(number) ?? new Set<string>();
        labels.set(number, current);
        const method = args[args.indexOf("-X") + 1];
        if (path.includes("/labels")) {
          if (method === "POST") {
            const name = (args.at(-1) ?? "").replace("labels[]=", "");
            if (!current.has(name)) {
              const timeline = data.get(repo ?? "")?.find((i) => i.number === number)?.timelineItems ??
                h.timelines.get(number) ?? { totalCount: 0, nodes: [] };
              timeline.nodes.push({
                __typename: "LabeledEvent",
                label: { name },
                actor: { login: h.login },
                createdAt: h.labelAt,
              });
              timeline.totalCount++;
              h.timelines.set(number, timeline);
            }
            current.add(name);
          } else if (method === "DELETE") current.delete(decodeURIComponent(path.split("/labels/")[1] ?? ""));
          else {
            const page = Number(new URL(`https://example.com/${path}`).searchParams.get("page") ?? 1);
            const result = [...current].slice((page - 1) * 100, page * 100).map((name) => ({ name }));
            return JSON.stringify(args.includes("--slurp") ? [result] : result);
          }
        } else if (path.includes("/comments")) {
          if (method !== "POST") {
            const page = Number(new URL(`https://example.com/${path}`).searchParams.get("page") ?? 1);
            const result = (comments.get(number) ?? [])
              .map((body, i) => ({
                id: number * 1000 + i + 1,
                body,
                user: { login: h.commentAuthors.get(body) ?? h.login },
              }))
              .slice((page - 1) * 100, page * 100);
            return JSON.stringify(args.includes("--slurp") ? [result] : result);
          }
          const body = (args.at(-1) ?? "").replace(/^body=/, "");
          comments.set(number, [...(comments.get(number) ?? []), body]);
          h.commentAuthors.set(body, h.login);
        } else throw new Error(`unexpected lifecycle call ${args}`);
        h.afterWrite?.(args);
        return JSON.stringify({ id: number * 1000 + (comments.get(number)?.length ?? 0) });
      }
      if (args[3]?.includes("timelineItems(first:1, itemTypes:")) {
        const number = Number(args[3].match(/issue\(number:(\d+)/)?.[1]);
        const timeline =
          data.get(repo ?? "")?.find((i) => i.number === number)?.timelineItems ?? h.timelines.get(number);
        return JSON.stringify({
          data: { repository: { issue: { timelineItems: { totalCount: timeline?.totalCount ?? 0 } } } },
        });
      }
      if (h.rawResponse !== undefined) return h.rawResponse;
      if (h.response !== undefined) return JSON.stringify(h.response);
      const query = args[3] ?? "";
      const owner = query.match(/owner:"([^"]+)"/)?.[1];
      const name = query.match(/name:"([^"]+)"/)?.[1];
      const offset = Number(query.match(/after:"issues:(\d+)"/)?.[1] ?? 0);
      const issues = data.get(`${owner}/${name}`) ?? [];
      const repository = query.includes("issues(first:")
        ? {
            issues: {
              nodes: issues.slice(offset, offset + 100),
              pageInfo: {
                hasNextPage: issues.length > offset + 100,
                endCursor: `issues:${offset + 100}`,
              },
            },
          }
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
        lifecycle: {
          identity: (repo) => h.identity(repo),
          get maxCalls() {
            return h.maxCalls;
          },
        },
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
      pollNow = (stop as ReturnType<typeof startIssueQueue>).pollNow;
    },
    stop: () => stop(),
    pollNow: () => pollNow(),
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
    h.labels.set(1, new Set(["priority:1"]));
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
    if (status === "failed") {
      i.labels.nodes.push({ name: "limitless:failed" });
      i.labels.totalCount++;
    }
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
  expect(h.calls[0]?.[3]).toContain("createdAt updatedAt");
  expect(h.calls[0]?.[3]).toContain(
    "comments(last: 20) { totalCount nodes { databaseId body createdAt lastEditedAt author { login } } }",
  );
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
  h.pollNow();
  await h.advance();
  expect(h.calls).toHaveLength(1);
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
  h.pollNow();
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

test.each([false, true])(
  "stopping during an in-flight query prevents a late run or timer (initializing: %s)",
  async (fresh) => {
    const h = harness({}, ["owner/repo"], fresh);
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
    if (fresh) expect(h.store.githubCommentBoundary("owner/repo")).toBeNull();
    expect(h.clock.pending).toBe(0);
  },
);

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

test("client-supplied round IDs cannot bypass issue admission claims", async () => {
  const h = harness();
  const origin = await h.factory.createRun({ repo: "owner/repo", prompt: "Unlinked work" });
  const repo = h.store.getRepo(origin.repoId);
  if (!repo) throw new Error("missing repo");
  const round = feedRound(h.store, repo, origin, "review");
  const claimed = await h.factory.createRun({ repo: repo.slug, prompt: "Closes #7" });
  const route = (createHttpRoutes(h.factory)["/api/runs"] as { POST: Route }).POST;
  for (const id of [undefined, round.id]) {
    const response = await route(
      requestWithParams("http://localhost:7400/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repo.slug, prompt: "Closes #7", id }),
      }),
      localServer,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(claimed.id);
  }
  expect(h.runs()).toHaveLength(3);
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

test("mounted queue reconciles lifecycle writes and cleans up its timer", async () => {
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
    await h.advance(180_000);
    expect(h.labels.get(1)).toEqual(new Set(["limitless:failed"]));
    expect(h.comments.get(1)).toHaveLength(2);
    expect(h.comments.get(1)?.[0]).toContain(`Limitless run ${run.id} started:`);
    expect(h.comments.get(1)?.[1]).toContain(`Limitless run ${run.id} failed:`);
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

async function linkedRun(h: ReturnType<typeof harness>, number = 7) {
  return h.factory.createRun(
    issueRunRequest({ repo: "owner/repo", number, title: "work", body: "", author: "owner" }, "owner"),
  );
}

test.each([
  ["needs_human", "limitless:needs-you", "needs you: see"],
  ["failed", "limitless:failed", "failed: see"],
  ["cancelled", null, "was cancelled: see"],
] as const)(
  "lifecycle %s replaces labels and comments once across polling and restart",
  async (status, label, text) => {
    const h = harness();
    const run = await linkedRun(h);
    h.labels.set(7, new Set(["priority:1", "limitless:failed", "limitless:needs-you"]));
    h.start();
    await h.advance();
    expect(h.labels.get(7)).toEqual(new Set(["priority:1", "limitless:in-progress"]));
    expect(h.comments.get(7)).toEqual([
      expect.stringContaining(`Limitless run ${run.id} started: see ${h.cfg.uiUrl}/runs/${run.id}`),
    ]);
    h.store.updateRun(run.id, {
      status,
      error: status === "cancelled" ? "cancelled by discord:private-id" : "reason",
    });
    await h.advance(180_000);
    expect(h.labels.get(7)).toEqual(new Set(["priority:1", ...(label ? [label] : [])]));
    expect(h.comments.get(7)).toHaveLength(2);
    expect(h.comments.get(7)?.[1]).toContain(`Limitless run ${run.id} ${text}`);
    expect(h.comments.get(7)?.[1]).not.toContain("discord:");
    h.stop();
    h.start();
    await h.advance();
    await h.advance(180_000);
    expect(h.comments.get(7)).toHaveLength(2);
    expect(h.scopes.filter(Boolean).every((repo) => repo === "owner/repo")).toBe(true);
  },
);

test("PR opened comments once and merging clears labels without a merge comment", async () => {
  const h = harness();
  const run = await linkedRun(h);
  h.start();
  await h.advance();
  const prUrl = "https://github.com/owner/repo/pull/8";
  h.store.updateRun(run.id, { status: "succeeded", prUrl });
  await h.advance(180_000);
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.comments.get(7)).toHaveLength(2);
  expect(h.comments.get(7)?.[1]).toContain(`Limitless run ${run.id} opened a PR ${prUrl}`);
  h.store.updateRun(run.id, { merged: true });
  h.labels.get(7)?.add("limitless:needs-you");
  await h.advance(180_000);
  h.stop();
  h.start();
  await h.advance();
  expect(h.labels.get(7)).toEqual(new Set());
  expect(h.comments.get(7)).toHaveLength(2);
});

test.each(["succeeded", "resolved"] as const)(
  "%s without an open PR releases lifecycle labels",
  async (status) => {
    const h = harness();
    const run = await linkedRun(h);
    h.start();
    await h.advance();
    h.store.updateRun(run.id, { status });
    await h.advance(180_000);
    expect(h.labels.get(7)).toEqual(new Set());
    expect(h.comments.get(7)).toHaveLength(1);
    h.store.updateRun(run.id, { prUrl: "https://github.com/owner/repo/pull/8", prClosedUnmerged: true });
    await h.advance(180_000);
    expect(h.labels.get(7)).toEqual(new Set());
  },
);

test.each(["after label", "after comment"])("lifecycle resumes exactly once %s write", async (point) => {
  const h = harness();
  const run = await linkedRun(h);
  let interrupted = false;
  h.afterWrite = (args) => {
    if (interrupted || args[args.indexOf("-X") + 1] !== "POST") return;
    if (!args[1]?.endsWith(point === "after label" ? "/labels" : "/comments")) return;
    interrupted = true;
    h.stop();
    if (point === "after comment") throw new Error("connection lost after accepted comment");
  };
  h.start();
  await h.advance();
  expect(interrupted).toBe(true);
  expect(h.comments.get(7) ?? []).toHaveLength(point === "after label" ? 0 : 1);
  if (point === "after comment")
    expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("pending");
  h.start();
  await h.advance();
  await h.advance(180_000);
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.comments.get(7)).toHaveLength(1);
  expect(h.calls.filter((a) => a[1]?.endsWith("/labels") && a.includes("POST"))).toHaveLength(1);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("done");
});

test.each(["write failure", "status changes"])(
  "partial label transition recovers its previous desired set after %s",
  async (interruption) => {
    const h = harness();
    const run = await linkedRun(h);
    h.start();
    await h.advance();
    h.store.updateRun(run.id, { status: "needs_human" });
    if (interruption === "write failure") {
      h.intercept = (args) => {
        if (args.at(-1) === "labels[]=limitless:needs-you") throw new Error("label write rejected");
      };
    } else {
      h.afterWrite = (args) => {
        if (args.includes("DELETE")) h.store.updateRun(run.id, { status: "running" });
      };
    }
    await h.advance(180_000);
    expect(h.labels.get(7)).toEqual(new Set());
    h.store.updateRun(run.id, { status: "running" });
    h.intercept = undefined;
    h.afterWrite = undefined;
    h.stop();
    h.start();
    await h.advance();
    expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  },
);

test.each([
  ["needs_human", false],
  ["needs_human", true],
  ["failed", false],
  ["failed", true],
] as const)("pending %s comment survives resolution and restart (accepted: %s)", async (status, accepted) => {
  const h = harness();
  const run = await linkedRun(h);
  h.start();
  await h.advance();
  h.store.updateRun(run.id, { status, error: "original reason" });
  const reject = (args: string[]) => {
    if (args[1]?.endsWith("/comments") && args.includes("POST")) throw new Error("comment connection lost");
  };
  if (accepted) h.afterWrite = reject;
  else h.intercept = reject;
  await h.advance(180_000);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, `comment:${status}`)).toBe("pending");
  h.store.updateRun(run.id, { status: "resolved", error: "changed reason" });
  h.stop();
  h.start();
  await h.advance();
  if (!accepted) {
    expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, `comment:${status}`)).toBe("pending");
    h.intercept = undefined;
    await h.advance(180_000);
  }
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, `comment:${status}`)).toBe("done");
  expect(h.comments.get(7)).toHaveLength(2);
  expect(h.comments.get(7)?.[1]).toContain(
    `${status === "needs_human" ? "needs you" : "failed"}: see ${h.cfg.uiUrl}/runs/${run.id}.`,
  );
  expect(h.comments.get(7)?.[1]).not.toContain("original reason");
  expect(h.comments.get(7)?.[1]).not.toContain("changed reason");
  await h.advance(180_000);
  expect(h.comments.get(7)).toHaveLength(2);
});

test("migration suppresses history but reconciles later transitions after reopen", async () => {
  const h = harness();
  const before = join(h.cfg.paths.home, "before");
  cpSync(MIGRATION_DIR, before, {
    recursive: true,
    filter: beforeLifecycle,
  });
  const path = join(h.cfg.paths.home, "old.db");
  let store = new Store(path, before);
  const repo = store.upsertRepo({
    slug: "owner/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Closes #7" });
  store.updateRun(run.id, { status: "running" });
  const terminal = store.createRun(repo, { repo: repo.slug, prompt: "Closes #8" });
  store.updateRun(terminal.id, { status: "failed" });
  const merged = store.createRun(repo, { repo: repo.slug, prompt: "Closes #9" });
  store.updateRun(merged.id, { status: "succeeded", prUrl: "https://github.com/owner/repo/pull/90" });
  const closed = store.createRun(repo, { repo: repo.slug, prompt: "Closes #10" });
  store.updateRun(closed.id, { status: "succeeded", prUrl: "https://github.com/owner/repo/pull/100" });
  store.close();
  store = new Store(path);
  store.close();
  store = new Store(path);
  store.updateRun(run.id, { status: "failed" });
  h.labels.set(7, new Set(["limitless:in-progress"]));
  const stop = startIssueQueue(
    { cfg: h.cfg, store, scheduler: h.factory.scheduler, createRun: h.factory.createRun },
    {
      gh: h.gh,
      lifecycle: { identity: h.identity },
      clock: {
        now: h.clock.now,
        set: h.clock.timer.set as unknown as typeof setTimeout,
        clear: h.clock.timer.clear,
      },
    },
  );
  try {
    await h.advance();
    await h.advance(180_000);
    expect(h.labels.get(7)).toEqual(new Set(["limitless:failed"]));
    expect(h.comments.get(7)).toEqual([expect.stringContaining(`Limitless run ${run.id} failed: see`)]);
    expect(
      h.calls
        .filter((args) => args[1] !== "graphql")
        .every((args) => !/issues\/(8|9|10)\b/.test(args[1] ?? "")),
    ).toBe(true);
    h.calls.length = 0;
    h.labels.set(9, new Set(["priority:1", "limitless:in-progress"]));
    h.labels.set(10, new Set(["priority:1", "limitless:in-progress"]));
    expect(store.resolveMergedRun(merged.id, "owner", h.clock.now())).toBe(true);
    store.updateRun(closed.id, { prClosedUnmerged: true });
    await h.advance(180_000);
    await h.advance(180_000);
    for (const number of [9, 10]) {
      expect(h.labels.get(number)).toEqual(new Set(["priority:1"]));
      expect(h.comments.get(number) ?? []).toHaveLength(0);
    }
    h.calls.length = 0;
    await h.advance(180_000);
    expect(h.calls.filter((args) => args[1] !== "graphql")).toEqual([]);
    expect(h.comments.get(7)).toHaveLength(1);
  } finally {
    stop();
    store.close();
  }
});

test.each([
  ["missing failure event", false],
  ["removed priority", false],
  ["priority before failure", false],
  ["same timestamp later index", true],
  ["untrusted failure then trusted priority", true],
  ["untrusted failure without priority", false],
  ["untrusted priority", false],
] as const)("failure re-approval follows current labels and timeline: %s", async (mode, eligible) => {
  const h = harness();
  const run = await linkedRun(h);
  const latest = h.store.updateRun(run.id, { status: "failed", finishedAt: Date.parse(at) + 999 });
  const candidate = issue();
  candidate.labels.nodes.push({ name: "limitless:failed" });
  if (mode !== "missing failure event")
    candidate.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name: "limitless:failed" },
      actor: { login: mode.startsWith("untrusted failure") ? "stranger" : "factory[bot]" },
      createdAt: at,
    });
  if (!["priority before failure", "untrusted failure without priority"].includes(mode)) {
    const name = mode === "removed priority" ? "priority:2" : "priority:1";
    candidate.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name },
      actor: { login: mode === "untrusted priority" ? "stranger" : "owner" },
      createdAt: mode === "removed priority" ? new Date(Date.parse(at) + 1000).toISOString() : at,
    });
  }
  candidate.labels.totalCount = candidate.labels.nodes.length;
  candidate.timelineItems.totalCount = candidate.timelineItems.nodes.length;
  expect(issueEligibility(candidate, ["owner"]).eligible).toBe(eligible);
  expect(issueEligibility(candidate, ["owner"], { latest, failureBoundary: 1 }).eligible).toBe(eligible);
});

test("poll requires trusted re-approval later than the failure label", async () => {
  const h = harness();
  const candidate = issue();
  candidate.labels.nodes.push({ name: "limitless:failed" });
  candidate.labels.totalCount++;
  candidate.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "limitless:failed" },
    actor: { login: "factory[bot]" },
    createdAt: at,
  });
  candidate.timelineItems.totalCount++;
  h.data.set("owner/repo", [candidate]);
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(0);
  candidate.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "priority:1" },
    actor: { login: "owner" },
    createdAt: new Date(Date.parse(at) + 1).toISOString(),
  });
  candidate.timelineItems.totalCount++;
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(1);
});

test.each(["failed", "needs_human"] as const)(
  "%s comments contain only fixed public text",
  async (status) => {
    const h = harness();
    const token = ["lifecycle", "test", "credential"].join("-");
    const privateText = ["lifecycle", "private", "location"].join("-");
    registerCredential("ISSUE_LIFECYCLE_TEST", token);
    writeFileSync(join(h.cfg.paths.configDir, "private-strings.txt"), privateText);
    const run = await linkedRun(h);
    const worktree = join(h.cfg.paths.work, run.id);
    h.store.setRunState(run.id, { worktreePath: worktree });
    const homePath = join(h.cfg.paths.home, "internal.db");
    h.store.updateRun(run.id, { status, error: `${worktree} ${homePath} ${token} ${privateText}` });
    h.start();
    await h.advance();
    expect(h.comments.get(7)).toHaveLength(2);
    expect(h.comments.get(7)?.[1]).toBe(
      `<!-- limitless-lifecycle:${run.id}:${status} -->\nLimitless run ${run.id} ${status === "failed" ? "failed" : "needs you"}: see ${h.cfg.uiUrl}/runs/${run.id}.`,
    );
    for (const value of [worktree, homePath, token, privateText])
      expect(h.comments.get(7)?.[1]).not.toContain(value);
  },
);

test("private lifecycle bodies are suppressed durably while labels still reconcile", async () => {
  const h = harness();
  const run = await linkedRun(h);
  writeFileSync(join(h.cfg.paths.configDir, "private-strings.txt"), run.id);
  h.start();
  await h.advance();
  await h.advance(180_000);
  expect(h.calls.some((args) => args[1]?.endsWith("/comments") && args.includes("POST"))).toBe(false);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("done");
  expect(h.logs.join("\n")).toContain(`owner/repo#7 run ${run.id}`);
  expect(h.logs.join("\n")).toContain("Issue lifecycle comment");
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
});

test("records all observed events before a failed started delivery and later resolution", async () => {
  const h = harness();
  const run = await linkedRun(h);
  h.store.updateRun(run.id, { status: "needs_human" });
  h.intercept = (args) => {
    if (args[1]?.endsWith("/comments") && args.includes("POST")) throw new Error("rejected");
  };
  h.start();
  await h.advance();
  for (const event of ["started", "needs_human"])
    expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, `comment:${event}`)).toBe("pending");
  h.intercept = undefined;
  h.store.updateRun(run.id, { status: "resolved" });
  await h.advance(180_000);
  await h.advance(180_000);
  expect(h.comments.get(7)).toEqual([
    expect.stringContaining(`Limitless run ${run.id} started:`),
    expect.stringContaining(`Limitless run ${run.id} needs you:`),
  ]);
});

test("a foreign marker cannot acknowledge a pending comment; successful POST stores its id", async () => {
  const h = harness();
  const run = await linkedRun(h);
  const body = `<!-- limitless-lifecycle:${run.id}:started -->\nLimitless run ${run.id} started: see ${h.cfg.uiUrl}/runs/${run.id}.`;
  h.store.setIssueLifecycleEffect(run.id, "owner/repo", 7, "comment:started", "pending", {
    body,
    login: "owner",
  });
  h.comments.set(7, [body]);
  h.commentAuthors.set(body, "stranger");
  h.start();
  await h.advance();
  expect(h.comments.get(7)).toHaveLength(2);
  expect(h.calls.filter((a) => a[1]?.endsWith("/comments") && a.includes("POST"))).toHaveLength(1);
  const effect = h.store
    .issueLifecycleEffects(run.id, "owner/repo", 7)
    .find((e) => e.effect === "comment:started");
  expect(effect).toMatchObject({ state: "done", commentId: 7002 });
});

test.each(["app", "owner"] as const)(
  "lost POST response dedupes using the %s posting identity",
  async (kind) => {
    const h = harness();
    h.login = kind === "app" ? "factory[bot]" : "gh-user";
    h.identity = async () => (kind === "app" ? { kind, token: "fake", botLogin: h.login } : { kind });
    const run = await linkedRun(h);
    h.afterWrite = (args) => {
      if (args[1]?.endsWith("/comments")) {
        h.stop();
        throw new Error("response lost");
      }
    };
    h.start();
    await h.advance();
    expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("pending");
    h.afterWrite = undefined;
    h.start();
    await h.advance();
    expect(h.comments.get(7)).toHaveLength(1);
    expect(h.calls.filter((a) => a[1]?.endsWith("/comments") && a.includes("POST"))).toHaveLength(1);
    expect(
      h.store.issueLifecycleEffects(run.id, "owner/repo", 7).find((e) => e.effect === "comment:started"),
    ).toMatchObject({ state: "done", commentId: 7001, login: h.login });
    expect(h.calls.some((a) => a[1] === "user")).toBe(kind === "owner");
  },
);

test("discreet lifecycle labels have durable suppression of comments", async () => {
  const h = harness();
  h.cfg.repos = { "owner/repo": { discreet: true, branchPrefix: "change/", landRequiresApproval: false } };
  const run = await linkedRun(h);
  h.start();
  await h.advance();
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  h.store.updateRun(run.id, { status: "needs_human" });
  await h.advance(180_000);
  expect(h.labels.get(7)).toEqual(new Set(["limitless:needs-you"]));
  h.store.updateRun(run.id, { status: "failed" });
  await h.advance(180_000);
  expect(h.labels.get(7)).toEqual(new Set(["limitless:failed"]));
  h.stop();
  h.start();
  await h.advance();
  await h.advance(180_000);
  expect(h.comments.size).toBe(0);
  h.cfg.repos = {};
  await h.advance(180_000);
  expect(h.comments.size).toBe(0);
});

test("failed lifecycle writes are redacted, retry next poll, and do not block selection", async () => {
  const h = harness({ max_issue_runs: 3 });
  const run = await linkedRun(h);
  const token = ["lifecycle", "write", "credential"].join("-");
  registerCredential("ISSUE_WRITE_TEST", token);
  const failed = new Set<string>();
  h.intercept = (args) => {
    const endpoint = args[1]?.split("/").at(-1) ?? "";
    if (args.includes("POST") && !failed.has(endpoint)) {
      failed.add(endpoint);
      throw new Error(`write rejected ${token}`);
    }
  };
  h.data.set("owner/repo", [issue()]);
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(2);
  expect(h.store.getRun(run.id)?.status).toBe("queued");
  expect(h.comments.size).toBe(0);
  expect(h.logs.join("\n")).toContain("write rejected [redacted");
  expect(h.logs.join("\n")).not.toContain(token);
  await h.advance(180_000);
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.comments.get(7)).toHaveLength(1);
  await h.advance(180_000);
  expect(h.comments.get(7)).toHaveLength(1);
});

test("non-GitHub Closes directives exclude fenced issues from claims and lifecycle targets", async () => {
  const h = harness();
  const run = await h.factory.createRun({
    repo: "owner/repo",
    prompt: "work\n```text\nCloses #9\n```\nCloses #7\nCloses #8",
    source: "mcp",
  });
  expect(linkedIssues(run, h.store)).toEqual([
    { repo: "owner/repo", number: 7 },
    { repo: "owner/repo", number: 8 },
  ]);
  expect(h.store.issueClaim("owner/repo", 7)?.id).toBe(run.id);
  expect(h.store.issueClaim("owner/repo", 9)).toBeNull();
  h.start();
  await h.advance();
  for (const number of [7, 8]) {
    expect(h.labels.get(number)).toEqual(new Set(["limitless:in-progress"]));
    expect(h.comments.get(number)).toHaveLength(1);
  }
  const repo = h.store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const ctx = new RunContext(h.factory.deps, run, repo, new AbortController().signal);
  const body = buildReport(ctx, true);
  expect(body).toContain("\n\nCloses #7\n\nCloses #8\n\n");
  expect(h.labels.has(9)).toBe(false);
  expect(h.comments.has(9)).toBe(false);
  expect(h.calls.some((args) => /issues\/9(?:\/|$)|issue\(number:9\)/.test(args.join(" ")))).toBe(false);
});

test.each(["needs_human", "failed"] as const)(
  "review findings cannot add issue claims or lifecycle targets on %s",
  async (status) => {
    const h = harness();
    const origin = await h.factory.createRun({ repo: "owner/repo", prompt: "Work\nCloses #7" });
    const prUrl = "https://github.com/owner/repo/pull/20";
    const sha = "a".repeat(40);
    const owner = h.store.updateRun(origin.id, { status: "succeeded", branch: "work", prUrl });
    const repo = h.store.getRepo(owner.repoId);
    if (!repo) throw new Error("missing repo");
    const findings = [{ severity: "major", title: "Fixture", detail: "Fixture quotes Closes #8" }] as const;
    const result = h.store.createReviewRound(
      repo,
      owner,
      { prUrl, reviewedSha: sha, findings: [...findings], cap: 3 },
      (round) => ({
        repo: repo.slug,
        prompt: reviewRoundPrompt(owner.prompt, prUrl, round, [...findings]),
        baseBranch: "work",
        deliveryBranch: "work",
        sourceRef: { kind: "review-round", runId: owner.id, round, prUrl, reviewedSha: sha },
      }),
    );
    if (!("run" in result)) throw new Error("missing round");
    const run = result.run;
    expect(linkedIssues(run, h.store)).toEqual([{ repo: repo.slug, number: 7 }]);
    expect(h.store.issueClaim(repo.slug, 7)?.id).toBe(run.id);
    expect(h.store.issueClaim(repo.slug, 8)).toBeNull();
    h.start();
    await h.advance();
    expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
    expect(h.comments.get(7)?.some((body) => body.includes(run.id) && body.includes("started"))).toBe(true);
    h.store.updateRun(run.id, { status });
    await h.advance(180_000);
    expect(h.labels.get(7)).toEqual(
      new Set([status === "failed" ? "limitless:failed" : "limitless:needs-you"]),
    );
    expect(h.comments.get(7)?.some((body) => body.includes(run.id) && body.includes(status))).toBe(true);
    expect(h.labels.has(8)).toBe(false);
    expect(h.comments.has(8)).toBe(false);
    expect(h.calls.some((args) => /issues\/8(?:\/|$)|issue\(number:8\)/.test(args.join(" ")))).toBe(false);
  },
);

test.each(["ci", "conflict"] as const)("%s rounds inherit sourceRef links and empty origins", (kind) => {
  for (const linked of [true, false]) {
    const h = harness();
    const repo = h.store.getRepoBySlug("owner/repo");
    if (!repo) throw new Error("missing repo");
    const prUrl = "https://github.com/owner/repo/pull/20";
    const head = "a".repeat(40);
    const origin = h.store.createRun(repo, {
      repo: repo.slug,
      prompt: "Original request without directives",
      ...(linked
        ? ({ source: "github", sourceRef: { kind: "issue", repo: repo.slug, number: 7 } } as const)
        : {}),
    });
    const owner = h.store.updateRun(origin.id, {
      status: "succeeded",
      branch: "work",
      baseSha: head,
      prUrl,
    });
    if (kind === "ci")
      h.store.recordCiFixTrigger(
        prUrl,
        head,
        "failure",
        { check: "test", line: "failed", excerpt: "Closes #8" },
        1,
      );
    else h.store.recordConflictTrigger(prUrl, head, "poller", 1);
    const trigger = (kind === "ci" ? h.store.pendingCiFixTriggers() : h.store.pendingConflictTriggers())[0];
    if (!trigger) throw new Error("missing trigger");
    const observation = { state: "OPEN", headRefOid: head, headRefName: "work" };
    const run =
      kind === "ci"
        ? h.store.startCiFixTrigger(trigger.id, observation, 1)
        : h.store.startConflictTrigger(trigger.id, observation, 1);
    if (!run) throw new Error("missing round");
    // Older or future assembled sections must not independently add links.
    h.store.db
      .query("UPDATE runs SET prompt = ? WHERE id = ?")
      .run("Factory instructions\nCloses #8", run.id);
    const saved = h.store.getRun(run.id);
    if (!saved) throw new Error("missing persisted round");
    expect(linkedIssues(saved, h.store)).toEqual(linked ? [{ repo: repo.slug, number: 7 }] : []);
    expect(h.store.issueClaim(repo.slug, 7)?.id ?? null).toBe(linked ? run.id : null);
    expect(h.store.issueClaim(repo.slug, 8)).toBeNull();
    expect(h.store.latestIssueRun(repo.slug, 7)?.id ?? null).toBe(linked ? run.id : null);
    expect(h.store.issueLifecycleOwnsLabels(owner, repo.slug, 7)).toBe(!linked);
    const body = buildReport(new RunContext(h.factory.deps, saved, repo, new AbortController().signal), true);
    expect(body.includes("\n\nCloses #7\n\n")).toBe(linked);
    expect(body).not.toContain("\n\nCloses #8\n\n");
    // The persisted round record is authoritative even without prompt or sourceRef hints.
    h.store.db.query("UPDATE runs SET prompt = 'Repair it', source_ref = NULL WHERE id = ?").run(run.id);
    expect(h.store.issueClaim(repo.slug, 7)?.id ?? null).toBe(linked ? run.id : null);
    expect(h.store.latestIssueRun(repo.slug, 7)?.id ?? null).toBe(linked ? run.id : null);
    expect(h.store.issueLifecycleOwnsLabels(owner, repo.slug, 7)).toBe(!linked);
  }
});

test.each(["Quoted Closes #8\nCloses #7", "```text\nCloses #8\n```\nCloses #7"])(
  "obsolete historical lifecycle effects make no GitHub calls: %j",
  async (prompt) => {
    const h = harness();
    const origin = await h.factory.createRun({ repo: "owner/repo", prompt: "Work" });
    h.store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run(prompt, origin.id);
    expect(h.store.issueClaim("owner/repo", 7)?.id).toBe(origin.id);
    expect(h.store.issueClaim("owner/repo", 8)).toBeNull();
    for (const [effect, state] of [
      ["labels", "pending"],
      ["label:limitless:in-progress:true", "pending"],
      ["comment:started", "pending"],
      ["comment:failed", "done"],
    ] as const)
      h.store.setIssueLifecycleEffect(origin.id, "owner/repo", 8, effect, state, {
        body: "obsolete comment",
        login: "owner",
        page: 1,
      });
    const signal = new AbortController().signal;
    for (const status of ["running", "needs_human", "failed"] as const) {
      h.store.updateRun(origin.id, { status });
      await reconcileIssueLifecycle(h.store, h.cfg, h.gh, signal, h.logs.push.bind(h.logs), {
        identity: h.identity,
      });
    }
    expect(h.labels.get(7)).toEqual(new Set(["limitless:failed"]));
    expect(h.comments.get(7)).toHaveLength(3);
    expect(h.calls.some((args) => /issues\/8(?:\/|$)|issue\(number:8\)/.test(args.join(" ")))).toBe(false);
    expect(h.labels.has(8)).toBe(false);
    expect(h.comments.has(8)).toBe(false);
  },
);

test("lifecycle uses the status that wins while fetching labels", async () => {
  const h = harness();
  const run = await linkedRun(h);
  h.intercept = (args) => {
    if (args[1]?.includes("/labels?"))
      h.store.updateRun(run.id, { status: "failed", error: "stopped during lookup" });
  };
  h.start();
  await h.advance();
  expect(h.labels.get(7)).toEqual(new Set(["limitless:failed"]));
  expect(h.comments.get(7)).toHaveLength(2);
  expect(h.comments.get(7)?.[1]).toContain(`failed: see ${h.cfg.uiUrl}/runs/${run.id}.`);
});

test("a new run owns labels even when the old run is still failed", async () => {
  const h = harness();
  const old = await linkedRun(h);
  h.store.updateRun(old.id, { status: "failed" });
  h.start();
  await h.advance();
  const next = await linkedRun(h);
  // Give both runs the same timestamp to exercise creation order rather than random ids.
  h.store.db.query("UPDATE runs SET created_at = ? WHERE id = ?").run(old.createdAt, next.id);
  await h.advance(180_000);
  await h.advance(180_000);
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.calls.filter((a) => a.at(-1) === "labels[]=limitless:failed")).toHaveLength(1);
  expect(h.comments.get(7)).toHaveLength(3);
});

test.each(["outside repo", "disabled", "GitHub prompt"])("lifecycle ignores %s", async (mode) => {
  const h = harness();
  if (mode === "GitHub prompt") {
    await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #7", source: "github" });
  } else {
    await linkedRun(h);
    if (mode === "disabled") h.cfg.githubQueue = null;
    else if (h.cfg.githubQueue) h.cfg.githubQueue.repos = ["owner/other"];
  }
  h.start();
  await h.advance();
  expect(h.labels.size).toBe(0);
  expect(h.comments.size).toBe(0);
});

test("issue links compare repository names case insensitively and ignore quoted closures", async () => {
  const h = harness();
  const run = await h.factory.createRun({
    repo: "owner/repo",
    prompt: "quoted Closes #8",
    source: "github",
    sourceRef: { kind: "issue", repo: "OWNER/REPO", number: 7 },
  });
  h.start();
  await h.advance();
  expect(h.labels.get(7)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.labels.has(8)).toBe(false);
  const repo = h.store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const ctx = new RunContext(h.factory.deps, run, repo, new AbortController().signal);
  const body = buildReport(ctx, true);
  expect(body).toContain("\n\nCloses #7\n\n");
  expect(body).not.toContain("\n\nCloses #8\n\n");
  expect(h.scopes.filter((scope) => scope === "OWNER/REPO").length).toBeGreaterThan(0);
});

test("completed lifecycle history adds no GitHub calls or per-run reads", async () => {
  const counts: number[][] = [];
  for (const count of [1, 25]) {
    const h = harness();
    for (let i = 0; i < count; i++) {
      const run = await linkedRun(h, i + 10);
      h.store.updateRun(run.id, { status: "failed" });
    }
    h.start();
    for (let i = 0; i < 6; i++) await h.advance(i ? 180_000 : 0);
    expect(h.comments.size).toBe(count);
    for (const comments of h.comments.values()) expect(comments).toHaveLength(2);
    h.calls.length = 0;
    const reads = spyOn(h.store, "getRun");
    const effectReads = spyOn(h.store, "issueLifecycleEffect");
    const batchReads = spyOn(h.store, "issueLifecycleEffects");
    await h.advance(180_000);
    expect(h.calls.every((args) => args[1] === "graphql")).toBe(true);
    counts.push([reads.mock.calls.length, effectReads.mock.calls.length, batchReads.mock.calls.length]);
    reads.mockRestore();
    effectReads.mockRestore();
    batchReads.mockRestore();
  }
  expect(counts).toEqual([
    [0, 0, 0],
    [0, 0, 0],
  ]);
});

test("a one-call pause refreshes completed labels after a human edit in the same session", async () => {
  const h = harness();
  const run = await linkedRun(h);
  const signal = new AbortController().signal;
  const poll = (maxCalls: number) =>
    reconcileIssueLifecycle(h.store, h.cfg, h.gh, signal, (s) => h.logs.push(s), {
      identity: h.identity,
      maxCalls,
    });
  await poll(50);
  h.store.updateRun(run.id, { status: "needs_human" });
  h.labels.set(7, new Set(["priority:1"]));
  h.calls.length = 0;
  await poll(1);
  expect(h.calls).toHaveLength(1);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "labels")).toBe("pending");
  h.labels.set(7, new Set(["priority:1", "limitless:in-progress"]));
  await poll(50);
  expect(h.labels.get(7)).toEqual(new Set(["priority:1", "limitless:needs-you"]));
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "labels")).toBe("limitless:needs-you");
  await poll(50);
  expect(h.comments.get(7)).toEqual([
    expect.stringContaining("started: see"),
    expect.stringContaining("needs you: see"),
  ]);
});

test("owner credentials changed during a budget pause use a fresh author for a lost POST", async () => {
  const h = harness();
  const run = await linkedRun(h);
  h.labels.set(7, new Set(["limitless:in-progress"]));
  h.store.setIssueLifecycleEffect(run.id, "owner/repo", 7, "labels", "limitless:in-progress");
  const signal = new AbortController().signal;
  const poll = (maxCalls: number) =>
    reconcileIssueLifecycle(h.store, h.cfg, h.gh, signal, (s) => h.logs.push(s), {
      identity: h.identity,
      maxCalls,
    });
  h.login = "owner-a";
  await poll(1);
  expect(h.calls.length).toBeLessThanOrEqual(1);
  expect(h.comments.size).toBe(0);
  h.login = "owner-b";
  h.afterWrite = (args) => {
    if (args[1]?.endsWith("/comments") && args.includes("POST")) throw new Error("response lost");
  };
  h.calls.length = 0;
  await poll(2);
  expect(h.calls.length).toBeLessThanOrEqual(2);
  expect(h.comments.get(7)).toHaveLength(1);
  expect(
    h.store.issueLifecycleEffects(run.id, "owner/repo", 7).find((e) => e.effect === "comment:started"),
  ).toMatchObject({ state: "pending", login: "owner-b", page: 1 });
  h.afterWrite = undefined;
  await poll(50);
  expect(h.comments.get(7)).toHaveLength(1);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("done");
});

test.each([1, 5])(
  "lifecycle call cap %s defers writes while admitting an eligible queue issue",
  async (cap) => {
    const h = harness();
    h.maxCalls = cap;
    for (let i = 10; i < 18; i++) {
      const run = await linkedRun(h, i);
      h.store.updateRun(run.id, { status: "failed" });
    }
    h.data.set("owner/repo", [issue()]);
    h.start();
    await h.advance();
    expect(
      h.calls.filter((args) => args[1] !== "graphql" || !args[3]?.includes("rateLimit")).length,
    ).toBeLessThanOrEqual(cap);
    expect(h.runs()).toHaveLength(9);
    // Fresh reads and their writes need two slots; retain the one-slot admission/deferral check above.
    const progressCap = Math.max(2, cap);
    h.maxCalls = progressCap;
    for (let i = 0; i < 80; i++) {
      h.calls.length = 0;
      await h.advance(180_000);
      expect(
        h.calls.filter((args) => args[1] !== "graphql" || !args[3]?.includes("rateLimit")).length,
      ).toBeLessThanOrEqual(progressCap);
    }
    for (let i = 10; i < 18; i++) {
      expect(h.labels.get(i)).toEqual(new Set(["limitless:failed"]));
      expect(h.comments.get(i)).toHaveLength(2);
    }
    expect(h.labels.get(1)).toEqual(new Set(["limitless:in-progress"]));
    expect(h.comments.get(1)).toHaveLength(1);
  },
);

test("paginated lifecycle reads respect the cap and resume through a lost response", async () => {
  const h = harness();
  h.maxCalls = 1;
  const run = await linkedRun(h);
  h.store.updateRun(run.id, { status: "failed" });
  const ordinary = Array.from({ length: 100 }, (_, i) => `ordinary:${i}`);
  h.labels.set(7, new Set([...ordinary, "limitless:needs-you"]));
  h.comments.set(
    7,
    Array.from({ length: 100 }, (_, i) => `Other comment ${i}`),
  );
  let interrupted = false;
  h.afterWrite = (args) => {
    if (args[1]?.endsWith("/comments")) {
      interrupted = true;
      h.stop();
      throw new Error("response lost");
    }
  };
  h.start();
  await h.advance();
  expect(h.calls).toHaveLength(2); // One lifecycle observation plus queue admission.
  expect(h.calls.filter((a) => a[1] !== "graphql" || !a[3]?.includes("rateLimit"))).toHaveLength(1);
  expect(h.comments.get(7)).toHaveLength(100);
  h.maxCalls = 2;
  for (let i = 0; i < 20 && !interrupted; i++) {
    h.calls.length = 0;
    await h.advance(180_000);
    expect(
      h.calls.filter((a) => a[1] !== "graphql" || !a[3]?.includes("rateLimit")).length,
    ).toBeLessThanOrEqual(2);
  }
  expect(interrupted).toBe(true);
  h.afterWrite = undefined;
  h.start();
  for (let i = 0; i < 12; i++) {
    h.calls.length = 0;
    await h.advance(i ? 180_000 : 0);
    expect(
      h.calls.filter((a) => a[1] !== "graphql" || !a[3]?.includes("rateLimit")).length,
    ).toBeLessThanOrEqual(2);
  }
  expect(h.labels.get(7)).toEqual(new Set([...ordinary, "limitless:failed"]));
  expect(h.comments.get(7)).toHaveLength(102);
  for (const event of ["started", "failed"])
    expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, `comment:${event}`)).toBe("done");
});

test("unavailable posting identity keeps comments pending until a later poll", async () => {
  const h = harness();
  h.login = "";
  const run = await linkedRun(h);
  h.start();
  await h.advance();
  expect(h.comments.size).toBe(0);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("pending");
  h.login = "owner";
  await h.advance(180_000);
  expect(h.comments.get(7)).toHaveLength(1);
});

test("the exact posted body includes redaction and publication path sanitization", async () => {
  const h = harness();
  const run = await linkedRun(h);
  h.cfg.uiUrl = `${h.cfg.paths.home}/ui`;
  registerCredential("ISSUE_MARKER_TEST", run.id);
  writeFileSync(join(h.cfg.paths.configDir, "private-strings.txt"), h.cfg.paths.home);
  h.start();
  await h.advance();
  const body = h.comments.get(7)?.[0];
  expect(body).toContain("<data>/ui/runs/");
  expect(body).toContain("[redacted");
  expect(body).not.toContain(h.cfg.paths.home);
  expect(body).not.toContain(run.id);
  expect(
    h.store.issueLifecycleEffects(run.id, "owner/repo", 7).find((e) => e.effect === "comment:started")?.body,
  ).toBe(body);
});

test.each([
  "https://github.com/owner/other/pull/8",
  "https://example.com/owner/repo/pull/8",
  "arbitrary run text",
])("PR comments omit unvalidated URLs: %s", async (prUrl) => {
  const h = harness();
  const run = await linkedRun(h);
  h.store.updateRun(run.id, { status: "succeeded", prUrl });
  h.start();
  await h.advance();
  expect(h.comments.get(7)?.[1]).toBe(
    `<!-- limitless-lifecycle:${run.id}:pr -->\nLimitless run ${run.id} opened a PR: see ${h.cfg.uiUrl}/runs/${run.id}.`,
  );
});

test.each(["app", "owner"] as const)(
  "a retried comment checkpoints its new %s author before a lost response",
  async (kind) => {
    const h = harness();
    const identity = (login: string): GitHubIdentity =>
      login.endsWith("[bot]") ? { kind: "app", token: "fake", botLogin: login } : { kind: "owner" };
    h.login = kind === "app" ? "gh-user" : "factory[bot]";
    h.identity = async () => identity(h.login);
    const run = await linkedRun(h);
    h.intercept = (args) => {
      if (args[1]?.endsWith("/comments") && args.includes("POST")) throw new Error("POST rejected");
    };
    h.start();
    await h.advance();
    h.stop();
    expect(h.comments.get(7) ?? []).toHaveLength(0);
    h.intercept = undefined;
    h.login = kind === "app" ? "factory[bot]" : "gh-user";
    h.afterWrite = (args) => {
      if (args[1]?.endsWith("/comments") && args.includes("POST")) {
        expect(
          h.store.issueLifecycleEffects(run.id, "owner/repo", 7).find((e) => e.effect === "comment:started"),
        ).toMatchObject({ login: h.login, state: "pending", page: 1 });
        throw new Error("response lost");
      }
    };
    h.start();
    await h.advance();
    h.stop();
    expect(h.comments.get(7)).toHaveLength(1);
    expect(
      h.store.issueLifecycleEffects(run.id, "owner/repo", 7).find((e) => e.effect === "comment:started"),
    ).toMatchObject({ login: h.login, state: "pending", page: 1 });
    h.afterWrite = undefined;
    h.start();
    await h.advance();
    expect(h.comments.get(7)).toHaveLength(1);
  },
);

test("inaccessible linked issues cannot starve later issues of the same run", async () => {
  const h = harness();
  await h.factory.createRun({
    repo: "owner/repo",
    prompt: Array.from({ length: 26 }, (_, i) => `Closes #${i + 1}`).join("\n"),
  });
  h.intercept = (args) => {
    const number = Number(args[1]?.match(/issues\/(\d+)/)?.[1]);
    if (number && number < 26) throw new Error("HTTP 404: issue unavailable");
  };
  h.start();
  for (let i = 0; i < 10; i++) {
    h.calls.length = 0;
    await h.advance(i ? 180_000 : 0);
    expect(h.calls.filter((args) => args[1] !== "graphql").length).toBeLessThanOrEqual(50);
  }
  expect(h.labels.get(26)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.comments.get(26)).toHaveLength(1);
  expect(h.logs.join("\n")).toContain("issue unavailable");
  h.intercept = undefined;
  await h.advance(180_000);
  for (let i = 0; i < 10; i++) await h.advance(180_000);
  expect(h.labels.get(1)).toEqual(new Set(["limitless:in-progress"]));
  expect(h.comments.get(1)).toHaveLength(1);
});

test("same-second timeline re-approval also works with the latest failed run", async () => {
  const h = harness();
  const run = await linkedRun(h);
  const finishedAt = Date.parse(at) + 1000;
  const latest = h.store.updateRun(run.id, { status: "failed", finishedAt });
  const candidate = issue(7);
  candidate.labels.nodes.push({ name: "limitless:failed" });
  candidate.labels.totalCount++;
  for (const [name, login] of [
    ["limitless:failed", "factory[bot]"],
    ["priority:1", "owner"],
  ]) {
    candidate.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name: name ?? "" },
      actor: { login: login ?? "" },
      createdAt: new Date(finishedAt).toISOString(),
    });
  }
  candidate.timelineItems.totalCount = candidate.timelineItems.nodes.length;
  expect(issueEligibility(candidate, ["owner"], { latest, failureBoundary: 1 })).toEqual({
    eligible: true,
    priority: 1,
  });
});

test("populated migration resumes label reconciliation after human edits", async () => {
  const h = harness();
  const before = join(h.cfg.paths.home, "all-statuses-before");
  cpSync(MIGRATION_DIR, before, { recursive: true, filter: beforeLifecycle });
  const path = join(h.cfg.paths.home, "all-statuses.db");
  let store = new Store(path, before);
  const repo = store.upsertRepo({
    slug: "owner/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const statuses: RunStatus[] = [
    "queued",
    "waiting",
    "running",
    "waiting_input",
    "needs_human",
    "succeeded",
    "failed",
    "cancelled",
    "resolved",
  ];
  const runs = statuses.map((status, i) => {
    const run = store.createRun(repo, { repo: repo.slug, prompt: `Closes #${i + 1}` });
    return store.updateRun(run.id, { status });
  });
  store.close();
  store = new Store(path);
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.issueLifecycleRuns().map((run) => run.status)).toEqual(statuses.slice(0, 5));
  store.close();
  store = new Store(path);
  const active = runs[2];
  if (!active) throw new Error("missing running run");
  store.updateRun(active.id, { status: "needs_human" });
  h.labels.set(3, new Set(["limitless:in-progress"]));
  h.intercept = (args) => {
    if (args[1]?.includes("/issues/3/") && args.at(-1) === "labels[]=limitless:needs-you")
      throw new Error("label write rejected");
  };
  const start = () =>
    startIssueQueue(
      { cfg: h.cfg, store, scheduler: h.factory.scheduler, createRun: h.factory.createRun },
      {
        gh: h.gh,
        lifecycle: { identity: h.identity },
        clock: {
          now: h.clock.now,
          set: h.clock.timer.set as unknown as typeof setTimeout,
          clear: h.clock.timer.clear,
        },
      },
    );
  let stop = start();
  try {
    await h.advance();
    expect(h.comments.get(3)).toEqual([expect.stringContaining("needs you: see")]);
    expect(h.labels.get(3)).toEqual(new Set());
    stop();
    store.close();
    store = new Store(path);
    h.labels.set(3, new Set(["priority:1", "limitless:in-progress"]));
    h.intercept = undefined;
    stop = start();
    await h.advance();
    expect(h.labels.get(3)).toEqual(new Set(["priority:1", "limitless:needs-you"]));
    expect(h.comments.get(3)).toHaveLength(1);
  } finally {
    stop();
    store.close();
  }
});

test.each(["merged", "closed", "merged before correction", "closed before correction"])(
  "a pre-existing succeeded run clears issue labels when its open PR is %s",
  async (state) => {
    const h = harness();
    const before = join(h.cfg.paths.home, "open-pr-before");
    cpSync(MIGRATION_DIR, before, { recursive: true, filter: beforeLifecycle });
    const path = join(h.cfg.paths.home, "open-pr.db");
    let store = new Store(path, before);
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "Closes #7" });
    store.updateRun(run.id, { status: "succeeded", prUrl: "https://github.com/owner/repo/pull/8" });
    store.close();
    cpSync(
      join(MIGRATION_DIR, "20261024T224811-issue-lifecycle.sql"),
      join(before, "20261024T224811-issue-lifecycle.sql"),
    );
    store = new Store(path, before);
    const endPr = () => {
      if (state.startsWith("merged"))
        expect(store.resolveMergedRun(run.id, "owner", h.clock.now())).toBe(true);
      else store.updateRun(run.id, { prClosedUnmerged: true });
    };
    if (state.includes("before correction")) endPr();
    store.close();
    store = new Store(path);
    store.close();
    store = new Store(path);
    if (!state.includes("before correction")) endPr();
    h.labels.set(7, new Set(["priority:1", "limitless:in-progress"]));
    const stop = startIssueQueue(
      { cfg: h.cfg, store, scheduler: h.factory.scheduler, createRun: h.factory.createRun },
      {
        gh: h.gh,
        lifecycle: { identity: h.identity },
        clock: {
          now: h.clock.now,
          set: h.clock.timer.set as unknown as typeof setTimeout,
          clear: h.clock.timer.clear,
        },
      },
    );
    try {
      await h.advance();
      expect(h.comments.get(7) ?? []).toHaveLength(0);
      expect(h.labels.get(7)).toEqual(new Set(["priority:1"]));
      expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      h.calls.length = 0;
      await h.advance(180_000);
      expect(h.calls.filter((args) => args[1] !== "graphql")).toEqual([]);
    } finally {
      stop();
      store.close();
    }
  },
);

test("a failed start comment cannot starve another effect on the same issue", async () => {
  const h = harness();
  h.maxCalls = 1;
  const run = await linkedRun(h);
  h.store.updateRun(run.id, { status: "needs_human" });
  h.intercept = (args) => {
    if (args.includes("POST") && args.at(-1)?.includes(":started -->"))
      throw new Error("start comment rejected");
  };
  h.start();
  await h.advance();
  expect(h.calls.filter((args) => args[1] !== "graphql")).toHaveLength(1);
  expect(h.comments.get(7) ?? []).toHaveLength(0);
  h.maxCalls = 2;
  for (let i = 0; i < 12; i++) {
    h.calls.length = 0;
    await h.advance(180_000);
    expect(h.calls.filter((args) => args[1] !== "graphql").length).toBeLessThanOrEqual(2);
  }
  expect(h.labels.get(7)).toEqual(new Set(["limitless:needs-you"]));
  expect(h.comments.get(7)).toEqual([expect.stringContaining("needs you: see")]);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("pending");
  h.intercept = undefined;
  for (let i = 0; i < 6; i++) await h.advance(180_000);
  expect(h.comments.get(7)).toHaveLength(2);
  expect(h.store.issueLifecycleEffect(run.id, "owner/repo", 7, "comment:started")).toBe("done");
});

test.each([11_000, 999])(
  "review: fast second failure at +%sms requires its own ordered approval",
  async (offset) => {
    const h = harness();
    const candidate = issue(7);
    candidate.labels.nodes.push({ name: "limitless:failed" });
    candidate.labels.totalCount++;
    for (const name of ["limitless:failed", "priority:1"])
      candidate.timelineItems.nodes.push({
        __typename: "LabeledEvent",
        label: { name },
        actor: { login: name === "priority:1" ? "owner" : "factory[bot]" },
        createdAt:
          name === "priority:1" && offset === 11_000 ? new Date(Date.parse(at) + 10_000).toISOString() : at,
      });
    h.labelAt = new Date(Date.parse(at) + Math.floor(offset / 1000) * 1000).toISOString();
    candidate.timelineItems.totalCount = candidate.timelineItems.nodes.length;
    h.data.set("owner/repo", [candidate]);
    h.labels.set(7, new Set(["priority:1", "limitless:failed"]));
    const run = await linkedRun(h);
    const latest = h.store.updateRun(run.id, { status: "failed", finishedAt: Date.parse(at) + offset });
    const boundary = () => {
      const effect = h.store
        .issueLifecycleEffects(run.id, "owner/repo", 7)
        .find((e) => e.effect === "failure");
      return effect?.state === "done" ? Number(effect.body) : null;
    };
    const check = () => {
      const current = [...(h.labels.get(7) ?? [])];
      candidate.labels = { nodes: current.map((name) => ({ name })), totalCount: current.length };
      return issueEligibility(candidate, ["owner"], { latest, failureBoundary: boundary() });
    };
    const poll = () =>
      reconcileIssueLifecycle(h.store, h.cfg, h.gh, new AbortController().signal, () => {}, {
        identity: h.identity,
      });
    expect(check().eligible).toBe(false); // The previous episode and approval cannot authorize this run.
    h.intercept = (args) => {
      if (args.at(-1) === "labels[]=limitless:failed") throw new Error("addition unavailable");
    };
    await poll();
    expect(h.labels.get(7)).toEqual(new Set(["priority:1"]));
    expect(check().eligible).toBe(false); // Including during the temporary absence of the failure label.
    h.intercept = undefined;
    h.afterWrite = (args) => {
      if (args.at(-1) === "labels[]=limitless:failed") throw new Error("accepted addition lost response");
    };
    await poll();
    expect(check().eligible).toBe(false);
    h.afterWrite = undefined;
    await poll();
    expect(boundary()).toBe(3);
    expect(check().eligible).toBe(false); // New episode observed, but no fresh approval.
    candidate.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name: "priority:1" },
      actor: { login: "owner" },
      createdAt: offset === 999 ? at : new Date(Date.parse(at) + 20_000).toISOString(),
    });
    candidate.timelineItems.totalCount++;
    expect(check()).toEqual({ eligible: true, priority: 1 });
    h.labels.get(7)?.delete("limitless:failed");
    expect(check()).toEqual({ eligible: true, priority: 1 }); // Established timeline evidence survives label removal.
    const current = candidate.timelineItems;
    candidate.timelineItems = { totalCount: 3, nodes: current.nodes.slice(0, 3) };
    expect(check().eligible).toBe(false); // A stale read cannot support the completed checkpoint.
    candidate.timelineItems = current;
    expect(h.calls.filter((args) => args.includes("DELETE"))).toHaveLength(1);
    expect(h.calls.filter((args) => args.at(-1) === "labels[]=limitless:failed")).toHaveLength(2);
  },
);

test.each(["remove", "remove lost response", "add", "add lost response", "comment lost response"])(
  "failure episode survives a database reopen after %s",
  async (point) => {
    const h = harness();
    const path = join(h.cfg.paths.home, "failure.db");
    let store = new Store(path);
    try {
      const repo = h.store.getRepoBySlug("owner/repo");
      if (!repo) throw new Error("missing repo");
      const run = store.createRun(store.upsertRepo(repo), { repo: repo.slug, prompt: "Closes #7" });
      store.updateRun(run.id, { status: "failed" });
      store.setIssueLifecycleEffect(run.id, "owner/repo", 7, "comment:started", "done");
      h.labels.set(7, new Set(["priority:1", "ordinary", "limitless:failed"]));
      const controller = new AbortController();
      let interrupted = false;
      h.afterWrite = (args) => {
        const matches = point.startsWith("remove")
          ? args.includes("DELETE")
          : point.startsWith("add")
            ? args.at(-1) === "labels[]=limitless:failed"
            : args[1]?.endsWith("/comments");
        if (!matches || interrupted) return;
        interrupted = true;
        controller.abort();
        if (point.includes("lost response")) throw new Error("accepted write lost response");
      };
      await reconcileIssueLifecycle(store, h.cfg, h.gh, controller.signal, () => {}, {
        identity: h.identity,
      });
      expect(interrupted).toBe(true);
      store.close();
      store = new Store(path);
      h.afterWrite = undefined;
      for (let i = 0; i < 3; i++)
        await reconcileIssueLifecycle(store, h.cfg, h.gh, new AbortController().signal, () => {}, {
          identity: h.identity,
        });
      expect(h.labels.get(7)).toEqual(new Set(["priority:1", "ordinary", "limitless:failed"]));
      expect(store.issueLifecycleEffect(run.id, "owner/repo", 7, "failure")).toBe("done");
      expect(h.calls.filter((args) => args.includes("DELETE"))).toHaveLength(1);
      expect(h.calls.filter((args) => args.at(-1) === "labels[]=limitless:failed")).toHaveLength(1);
      expect(h.comments.get(7)).toEqual([expect.stringContaining(`Limitless run ${run.id} failed: see`)]);
    } finally {
      store.close();
    }
  },
);

test.each(["labels", "comment"] as const)(
  "review: a %s task gets two adjacent call slots despite 49 persistent failures",
  async (task) => {
    const h = harness();
    for (let number = 1; number <= 49; number++) {
      const run = await linkedRun(h, number);
      h.store.setIssueLifecycleEffect(run.id, "owner/repo", number, "comment:started", "done");
    }
    const healthy = await linkedRun(h, 50);
    if (task === "labels")
      h.store.setIssueLifecycleEffect(healthy.id, "owner/repo", 50, "comment:started", "done");
    else {
      h.labels.set(50, new Set(["limitless:in-progress"]));
      h.store.setIssueLifecycleEffect(healthy.id, "owner/repo", 50, "labels", "limitless:in-progress");
    }
    h.intercept = (args) => {
      const number = Number(args[1]?.match(/issues\/(\d+)/)?.[1]);
      if (number && number < 50) throw new Error("HTTP 404: issue unavailable");
    };
    const signal = new AbortController().signal;
    for (let i = 0; i < 10; i++) {
      h.calls.length = 0;
      await reconcileIssueLifecycle(h.store, h.cfg, h.gh, signal, () => {}, { identity: h.identity });
      expect(h.calls.length).toBeLessThanOrEqual(50);
    }
    if (task === "labels") expect(h.labels.get(50)).toEqual(new Set(["limitless:in-progress"]));
    else expect(h.comments.get(50) ?? []).toHaveLength(1);
  },
);

test("a deferred task stays first when its preceding run leaves the lifecycle worklist", async () => {
  const h = harness();
  for (let number = 1; number <= 50; number++) {
    const run = await linkedRun(h, number);
    h.store.setIssueLifecycleEffect(run.id, "owner/repo", number, "comment:started", "done");
    if (number === 50) {
      h.store.updateRun(run.id, { status: "resolved" });
      h.store.setIssueLifecycleEffect(run.id, "owner/repo", number, "labels", "none");
    }
  }
  const healthy = await linkedRun(h, 51);
  h.store.setIssueLifecycleEffect(healthy.id, "owner/repo", 51, "comment:started", "done");
  h.intercept = (args) => {
    const number = Number(args[1]?.match(/issues\/(\d+)/)?.[1]);
    if (number && number < 50) throw new Error("HTTP 404: issue unavailable");
  };
  const signal = new AbortController().signal;
  const poll = () =>
    reconcileIssueLifecycle(h.store, h.cfg, h.gh, signal, () => {}, { identity: h.identity });
  await poll();
  expect(h.calls).toHaveLength(49);
  expect(h.labels.has(51)).toBe(false);
  h.calls.length = 0;
  await poll();
  expect(h.calls[0]?.[1]).toContain("issues/51/labels?");
  expect(h.calls.length).toBeLessThanOrEqual(50);
  expect(h.labels.get(51)).toEqual(new Set(["limitless:in-progress"]));
});

test("a newer CLI failure cannot reuse an older issue run's approved failure episode", async () => {
  const h = harness();
  const candidate = issue(7);
  h.data.set("owner/repo", [candidate]);
  h.labels.set(7, new Set(["priority:1"]));
  const first = await linkedRun(h);
  h.store.updateRun(first.id, { status: "failed" });
  await reconcileIssueLifecycle(h.store, h.cfg, h.gh, new AbortController().signal, () => {}, {
    identity: h.identity,
  });
  candidate.labels.nodes.push({ name: "limitless:failed" });
  candidate.labels.totalCount++;
  candidate.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "priority:1" },
    actor: { login: "owner" },
    createdAt: at,
  });
  candidate.timelineItems.totalCount++;
  const retry = await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #7" });
  h.store.updateRun(retry.id, { status: "failed" });
  h.maxCalls = 0;
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(2);
  expect(h.store.latestIssueRun("OWNER/REPO", 7)?.id).toBe(retry.id);
  h.maxCalls = 50;
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(2);
  candidate.timelineItems.nodes.push({
    __typename: "LabeledEvent",
    label: { name: "priority:1" },
    actor: { login: "owner" },
    createdAt: at,
  });
  candidate.timelineItems.totalCount++;
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(3);
});

test("review: a pre-lifecycle failed run can be re-approved after upgrading", async () => {
  const h = harness();
  const before = join(h.cfg.paths.home, "legacy-failure-migrations");
  cpSync(MIGRATION_DIR, before, { recursive: true, filter: beforeLifecycle });
  const path = join(h.cfg.paths.home, "legacy-failure.db");
  let store = new Store(path, before);
  const originalRepo = h.store.getRepoBySlug("owner/repo");
  if (!originalRepo) throw new Error("missing repo");
  const repo = store.upsertRepo(originalRepo);
  const run = store.createRun(
    repo,
    issueRunRequest({ repo: repo.slug, number: 7, title: "work", body: "", author: "owner" }, "owner"),
  );
  store.updateRun(run.id, { status: "failed", finishedAt: Date.parse(at) + 999 });
  store.close();
  store = new Store(path);
  const candidate = issue(7);
  candidate.labels.nodes.push({ name: "limitless:failed" });
  candidate.labels.totalCount++;
  for (const [name, seconds] of [
    ["limitless:failed", 1],
    ["priority:1", 2],
  ] as const)
    candidate.timelineItems.nodes.push({
      __typename: "LabeledEvent",
      label: { name },
      actor: { login: "owner" },
      createdAt: new Date(Date.parse(at) + seconds * 1000).toISOString(),
    });
  candidate.timelineItems.totalCount = candidate.timelineItems.nodes.length;
  h.data.set(repo.slug, [candidate]);
  h.labels.set(7, new Set(["priority:1", "limitless:failed"]));
  const created: CreateRunRequest[] = [];
  const stop = startIssueQueue(
    {
      cfg: h.cfg,
      store,
      scheduler: h.factory.scheduler,
      createRun: async (request) => {
        created.push(request);
        return store.createRun(repo, request);
      },
    },
    {
      gh: h.gh,
      lifecycle: { identity: h.identity },
      clock: {
        now: h.clock.now,
        set: h.clock.timer.set as unknown as typeof setTimeout,
        clear: h.clock.timer.clear,
      },
    },
  );
  try {
    await h.advance();
    await h.advance(180_000);
    expect(created).toHaveLength(1);
  } finally {
    stop();
    store.close();
  }
});

const commandAt = "2026-01-01T00:00:01Z";
function commandComment(databaseId = 1): QueueIssue["comments"]["nodes"][number] {
  return {
    databaseId,
    body: "/limitless do it\nAllow: workflows",
    createdAt: commandAt,
    lastEditedAt: null,
    author: { login: "owner" },
  };
}
function commentIssue(number = 1): QueueIssue {
  return { ...issue(number), labels: { totalCount: 0, nodes: [] } };
}
const records = (h: ReturnType<typeof harness>) =>
  h.store.db.query("SELECT * FROM github_processed_comments").all();
async function pollComments(h: ReturnType<typeof harness>) {
  h.pollNow();
  await h.advance(30_000);
}
async function enableComments(h: ReturnType<typeof harness>) {
  const i = commentIssue();
  h.data.set("owner/repo", [i]);
  h.start();
  await h.advance();
  expect(Date.parse(h.store.githubCommentBoundary("OWNER/REPO") ?? "")).toBe(Date.parse(at));
  return i;
}
function commentDelivery(i: QueueIssue, id = "command", author = "owner", pr = false) {
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: pr ? "owner/repo" : "OWNER/REPO" },
    sender: { login: author },
    issue: { ...i, user: i.author, ...(pr ? { pull_request: { url: "https://example.com/pr" } } : {}) },
    comment: { id: 1, body: commandComment().body, user: { login: author } },
  });
  return new Request("http://localhost/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": id,
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
    },
  });
}

test.each(["owner", "collaborator", "mention"])(
  "polled %s command uses the shared builder and bypasses label admission",
  async (mode) => {
    const h = harness({ trusted: ["OWNER", "collaborator"] });
    const i = await enableComments(h);
    h.cfg.maxConcurrentRuns = 0;
    h.factory.scheduler.drain();
    const c = commandComment();
    if (mode === "collaborator") c.author = { login: "collaborator" };
    if (mode === "mention") {
      h.identity = async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" });
      c.body = "@FACTORY[bot] do it\nAllow: workflows";
    }
    i.comments = { totalCount: 1, nodes: [c] };
    await pollComments(h);
    const expected = commentRunRequest(
      {
        repo: "owner/repo",
        number: 1,
        issueTitle: i.title,
        issueBody: i.body,
        request: "do it\nAllow: workflows",
        author: c.author?.login ?? "",
      },
      "owner",
    );
    expect(h.requests).toEqual([{ ...expected, sourceRef: { ...expected.sourceRef, via: "queue" } }]);
    expect(h.requests[0]?.allow).toEqual(mode === "collaborator" ? [] : ["workflows"]);
    expect(h.runs()).toHaveLength(1);
    expect(h.runs()[0]?.githubWebhookVerified).toBe(false);
    await pollComments(h);
    expect(h.runs()).toHaveLength(1);
    expect(records(h)).toHaveLength(1);
  },
);

test("comment run, processed record and boundary survive closing and reopening the database", async () => {
  const h = harness();
  const path = join(h.cfg.paths.home, "comments.db");
  let store = new Store(path);
  const makeFactory = () =>
    new Factory(h.cfg, {
      store,
      harnesses: {
        fake: fakeHarness(() => {
          throw new Error("must not execute stages");
        }),
      },
    });
  let factory = makeFactory();
  const repo = h.store.getRepoBySlug("owner/repo");
  if (!repo) throw new Error("missing repo");
  store.upsertRepo(repo);
  const i = commentIssue();
  h.data.set(repo.slug, [i]);
  const start = () =>
    startIssueQueue(factory, {
      gh: h.gh,
      lifecycle: { identity: h.identity },
      clock: {
        now: h.clock.now,
        set: h.clock.timer.set as unknown as typeof setTimeout,
        clear: h.clock.timer.clear,
      },
    });
  let stop = start();
  try {
    await h.advance();
    const boundary = new Date(at).toISOString();
    expect(store.githubCommentBoundary(repo.slug)).toBe(boundary);
    i.comments = { totalCount: 1, nodes: [commandComment()] };
    stop.pollNow();
    await h.advance(30_000);
    const run = store.listRuns()[0];
    if (!run) throw new Error("missing command run");
    stop();
    await factory.stop();
    store.close();
    store = new Store(path);
    factory = makeFactory();
    expect(store.githubCommentBoundary(repo.slug)).toBe(boundary);
    expect(
      store.db.query("SELECT repo, comment_id, outcome, run_id FROM github_processed_comments").all(),
    ).toEqual([{ repo: repo.slug, comment_id: 1, outcome: "run", run_id: run.id }]);
    stop = start();
    await h.advance();
    stop.pollNow();
    await h.advance(30_000);
    expect(store.listRuns().map((r) => r.id)).toEqual([run.id]);
    expect(store.db.query("SELECT count(*) AS n FROM github_processed_comments").get()).toEqual({ n: 1 });
  } finally {
    stop();
    await factory.stop();
    store.close();
  }
});

test("comment transaction rolls back the run when recording fails, then retries once", async () => {
  const h = harness();
  const i = await enableComments(h);
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  let inserted = false;
  const record = spyOn(h.store, "recordGitHubComment").mockImplementation((_comment, run) => {
    inserted = !!run && h.store.getRun(run) !== null;
    throw new Error("crash after run insert");
  });
  await pollComments(h);
  expect(inserted).toBe(true);
  expect(h.runs()).toHaveLength(0);
  expect(records(h)).toHaveLength(0);
  record.mockRestore();
  await pollComments(h);
  await pollComments(h);
  expect(h.runs()).toHaveLength(1);
  expect(records(h)).toHaveLength(1);
});

test("in-flight hints coalesce into one follow-up poll without concurrent gh calls", async () => {
  const h = harness();
  const i = await enableComments(h);
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  let release = () => {};
  h.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = h.calls.length;
  await pollComments(h);
  expect(h.calls.length).toBe(before + 1);
  h.pollNow();
  h.pollNow();
  h.pollNow();
  await h.advance();
  expect(h.calls.length).toBe(before + 1);
  // The next tick has no lifecycle writes, so its only call is the issues query.
  const lifecycle = spyOn(h.store, "issueLifecycleRuns").mockReturnValue([]);
  h.hold = undefined;
  release();
  await h.advance(29_999);
  expect(h.calls.length).toBe(before + 1);
  await h.advance(1);
  expect(h.calls.length).toBe(before + 2);
  expect(h.runs()).toHaveLength(1);
  expect(h.clock.pending).toBe(1);
  lifecycle.mockRestore();
});

test.each(["HTTP 429 Too Many Requests", "HTTP 503 Service Unavailable"])(
  "%s keeps regular retry deadlines despite hint bursts",
  async (message) => {
    const h = harness();
    const starts: number[] = [];
    h.intercept = () => {
      starts.push(h.clock.now());
      throw new Error(message);
    };
    h.start();
    await h.advance();
    const initial = h.clock.now();
    for (let step = 1; step <= 36; step++) {
      h.pollNow();
      await h.advance(10_000);
      expect(starts).toEqual(
        Array.from({ length: 1 + Math.floor(step / 18) }, (_, n) => initial + n * 180_000),
      );
    }
    h.stop();
    h.pollNow();
    await h.advance(180_000);
    expect(starts).toHaveLength(3);
  },
);

test("hints during an unresolved HTTP failure cannot accelerate its regular retry", async () => {
  const h = harness();
  const held = Promise.withResolvers<void>();
  const gh = h.gh;
  const starts: number[] = [];
  h.gh = async (...args) => {
    starts.push(h.clock.now());
    await held.promise;
    return gh(...args);
  };
  h.intercept = () => {
    throw new Error("HTTP 429");
  };
  h.start();
  await h.advance();
  const initial = h.clock.now();
  h.pollNow();
  h.pollNow();
  await h.advance(30_000);
  expect(starts).toEqual([initial]);
  held.resolve();
  await h.advance();
  h.pollNow();
  await h.advance(179_999);
  expect(starts).toEqual([initial]);
  await h.advance(1);
  expect(starts).toEqual([initial, initial + 210_000]);
});

test("healthy hints wait 30 seconds from tick start and do not postpone an eligible hint", async () => {
  const h = harness();
  const starts: number[] = [];
  h.intercept = () => {
    starts.push(h.clock.now());
  };
  h.start();
  await h.advance();
  const initial = h.clock.now();
  for (let step = 0; step < 3; step++) {
    h.pollNow();
    await h.advance(9_999);
    expect(starts).toEqual([initial]);
  }
  h.pollNow();
  await h.advance(2);
  expect(starts).toEqual([initial]);
  await h.advance(1);
  expect(starts).toEqual([initial, initial + 30_000]);
});

test.each([false, true])(
  "hints preserve a shorter regular polling cadence (HTTP failure: %s)",
  async (fail) => {
    const h = harness({ poll_seconds: 15 });
    h.intercept = () => {
      if (fail) throw new Error("HTTP 429");
    };
    h.start();
    await h.advance();
    h.pollNow();
    await h.advance(14_999);
    expect(h.calls).toHaveLength(1);
    await h.advance(1);
    expect(h.calls).toHaveLength(2);
  },
);

test("claim refusal is recorded and redacted once even after the claim is released", async () => {
  const h = harness();
  const i = await enableComments(h);
  const run = await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #1" });
  registerCredential("CLAIM_RUN_TEST", run.id);
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  await pollComments(h);
  expect(h.runs()).toHaveLength(1);
  expect(records(h)).toMatchObject([
    { outcome: "refused", run_id: null, note: expect.stringContaining("is claimed by run [redacted]") },
  ]);
  expect(h.logs.join("\n")).toContain("Issue owner/repo#1 is claimed by run [redacted]");
  h.store.updateRun(run.id, { status: "succeeded", finishedAt: h.clock.now() });
  const attempts = h.requests.length;
  await pollComments(h);
  expect(h.requests).toHaveLength(attempts);
  expect(h.runs()).toHaveLength(1);
});

const badCommentResponses = ["graphql errors", "null node", "schema mismatch", "invalid JSON", "gh failure"];
test.each(badCommentResponses)("%s consumes no command and remains retryable", async (mode) => {
  const h = harness();
  const i = commentIssue();
  const fail = () => {
    if (mode === "gh failure") throw new Error("gh failed");
  };
  h.intercept = fail;
  h.data.set("owner/repo", [i]);
  const response = {
    data: {
      repository: { issues: { nodes: [i], pageInfo: { hasNextPage: false, endCursor: null } } },
      rateLimit: h.rate,
    },
    ...(mode === "graphql errors" ? { errors: [{ message: "partial" }] } : {}),
  };
  const damage = () => {
    i.comments = { totalCount: 1, nodes: [commandComment()] };
    if (mode === "null node") (i.comments.nodes as unknown[])[0] = null;
    if (mode === "schema mismatch")
      delete (i.comments.nodes[0] as Partial<ReturnType<typeof commandComment>>).databaseId;
    h.response = response;
    h.rawResponse = mode === "invalid JSON" ? "{" : undefined;
  };
  damage();
  h.start();
  await h.advance();
  expect(h.store.githubCommentBoundary("owner/repo")).toBe(at);
  expect(records(h)).toEqual([]);
  h.intercept = undefined;
  h.response = undefined;
  h.rawResponse = undefined;
  i.comments = { totalCount: 0, nodes: [] };
  await h.advance(180_000);
  expect(h.store.githubCommentBoundary("owner/repo")).toBe(at);
  h.intercept = fail;
  damage();
  await pollComments(h);
  expect(h.runs()).toEqual([]);
  expect(records(h)).toEqual([]);
  h.intercept = undefined;
  h.response = undefined;
  h.rawResponse = undefined;
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  await h.advance(180_000);
  expect(h.runs()).toHaveLength(1);
});

test.each([
  "edited",
  "untrusted",
  "factory author",
  "leading marker",
  "empty",
  "whitespace",
  "null author",
  "closed",
])("%s comments never run or get recorded", async (mode) => {
  const h = harness({ trusted: ["owner", "factory[bot]"] });
  h.identity = async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" });
  const i = await enableComments(h);
  const c = commandComment();
  if (mode === "edited") c.lastEditedAt = commandAt;
  if (mode === "untrusted") c.author = { login: "stranger" };
  if (mode === "factory author") c.author = { login: "FACTORY[bot]" };
  if (mode === "null author") c.author = null;
  if (mode === "leading marker") c.body = `<!-- limitless-status -->\n${c.body}`;
  if (mode === "closed") i.state = "CLOSED";
  if (mode === "empty") c.body = "/limitless";
  if (mode === "whitespace") c.body = "/limitless \n \t";
  i.comments = { totalCount: 1, nodes: [c] };
  await pollComments(h);
  await pollComments(h);
  expect(h.runs()).toEqual([]);
  expect(records(h)).toEqual([]);
});

test.each([-60_000, 60_000])(
  "GitHub boundary ignores local clock offset %i and survives reopened issues",
  async (offset) => {
    const h = harness({}, ["owner/repo"], true);
    await h.clock.advance(Date.parse(at) + offset - h.clock.now());
    const i = commentIssue();
    i.updatedAt = "2025-01-01T00:00:00Z";
    h.data.set("owner/repo", [i]);
    h.start();
    await h.advance();
    expect(h.store.githubCommentBoundary("owner/repo")).toBe(new Date(at).toISOString());
    i.comments = { totalCount: 1, nodes: [{ ...commandComment(), createdAt: at }] };
    await pollComments(h);
    expect(h.runs()).toEqual([]);
    const reopened = commentIssue(2);
    reopened.updatedAt = "2026-01-01T01:00:00Z";
    reopened.comments = {
      totalCount: 1,
      nodes: [{ ...commandComment(2), createdAt: "2025-12-31T23:59:59Z" }],
    };
    h.data.set("owner/repo", [i, reopened]);
    await pollComments(h);
    expect(h.runs()).toEqual([]);
    i.comments.nodes.push(commandComment(3));
    i.comments.totalCount++;
    await pollComments(h);
    expect(h.runs()).toHaveLength(1);
    expect(h.store.githubCommentBoundary("owner/repo")).toBe(new Date(at).toISOString());
  },
);

test("an empty repository saves GitHub time before any issue query and later accepts commands", async () => {
  const h = harness({}, ["owner/repo"], true);
  h.start();
  await h.advance();
  expect(h.calls).toEqual([["api", "--include", "rate_limit"]]);
  expect(h.scopes).toEqual(["owner/repo"]);
  expect(h.store.githubCommentBoundary("owner/repo")).toBe(new Date(at).toISOString());
  const i = commentIssue();
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  h.data.set("owner/repo", [i]);
  await pollComments(h);
  await pollComments(h);
  expect(h.calls[1]?.[1]).toBe("graphql");
  expect(h.runs()).toHaveLength(1);
  expect(records(h)).toHaveLength(1);
});

test("initializing one repository leaves an already enabled repository actionable", async () => {
  const h = harness({}, ["owner/a", "owner/b"], true);
  h.store.githubCommentBoundary("owner/b", at);
  for (const repo of ["owner/a", "owner/b"]) h.data.set(repo, [issue()]);
  h.start();
  await h.advance();
  expect(h.calls[0]).toEqual(["api", "--include", "rate_limit"]);
  expect(h.calls[1]?.[1]).toBe("graphql");
  expect(h.scopes).toEqual(["owner/a", "owner/b"]);
  expect(h.runs()).toHaveLength(1);
  expect(h.runs()[0]?.sourceRef?.repo).toBe("owner/b");
});

test.each(["missing", "invalid", "body only", "http error", "request failed"])(
  "%s GitHub Date leaves initialization retryable and starts no work",
  async (mode) => {
    const h = harness({}, ["owner/repo"], true);
    h.data.set("owner/repo", [issue()]);
    h.boundaryResponse =
      mode === "missing"
        ? "HTTP/2.0 200 OK\r\n\r\n{}"
        : mode === "invalid"
          ? "HTTP/2.0 200 OK\r\nDate: nonsense\r\n\r\n{}"
          : mode === "body only"
            ? `HTTP/2.0 200 OK\r\n\r\nDate: ${new Date(at).toUTCString()}`
            : `HTTP/2.0 429 Too Many Requests\r\nDate: ${new Date(at).toUTCString()}\r\n\r\n{}`;
    if (mode === "request failed")
      h.intercept = () => {
        throw new Error("HTTP 503");
      };
    h.start();
    await h.advance();
    expect(h.calls).toEqual([["api", "--include", "rate_limit"]]);
    expect(h.store.githubCommentBoundary("owner/repo")).toBeNull();
    expect(h.runs()).toEqual([]);
    expect(records(h)).toEqual([]);
    h.intercept = undefined;
    h.boundaryResponse = `HTTP/2.0 200 OK\nDATE: ${new Date(at).toUTCString()}\n\n{}`;
    await h.advance(180_000);
    expect(h.store.githubCommentBoundary("owner/repo")).toBe(new Date(at).toISOString());
    expect(h.calls).toHaveLength(2);
    expect(h.runs()).toEqual([]);
    await pollComments(h);
    expect(h.runs()).toHaveLength(1);
  },
);

test("20 returned comments out of 25 leave label eligibility intact and include newest commands", async () => {
  const h = harness();
  const i = await enableComments(h);
  i.comments = {
    totalCount: 25,
    nodes: Array.from({ length: 19 }, (_, n) => ({ ...commandComment(n + 2), body: "discussion" })).concat(
      commandComment(),
    ),
  };
  expect(issueEligibility({ ...issue(), comments: i.comments }, ["owner"])).toEqual({
    eligible: true,
    priority: 1,
  });
  await pollComments(h);
  expect(h.runs()).toHaveLength(1);
});

test.each([false, true])("queue webhook is only a poll hint; delayed edited state: %s", async (edited) => {
  const h = harness();
  const i = await enableComments(h);
  i.comments = { totalCount: 1, nodes: [{ ...commandComment(), lastEditedAt: edited ? commandAt : null }] };
  const handle = githubWebhook(h.factory, undefined, h.pollNow);
  expect((await handle(commentDelivery(i))).status).toBe(200);
  expect(h.runs()).toEqual([]);
  expect(h.store.db.query("SELECT status, note FROM inbox WHERE id = 'command'").get()).toEqual({
    status: "ignored",
    note: "Issue queue poll requested",
  });
  await h.advance(30_000);
  expect(h.runs()).toHaveLength(edited ? 0 : 1);
  expect(records(h)).toHaveLength(edited ? 0 : 1);
});

test("PR comment webhooks in queue repositories retain provenance and comment deduplication", async () => {
  const h = harness();
  const i = commentIssue();
  let hints = 0;
  const handle = githubWebhook(h.factory, undefined, () => {
    hints++;
  });
  expect((await handle(commentDelivery(i, "pr-first", "owner", true))).status).toBe(201);
  const run = h.runs()[0];
  if (!run) throw new Error("missing PR command run");
  expect(run.githubWebhookVerified).toBe(true);
  expect(run.sourceRef).toEqual({ kind: "issue", repo: "owner/repo", number: 1 });
  expect(h.requests[0]?.allow).toEqual(["workflows"]);
  h.store.updateRun(run.id, { status: "succeeded", finishedAt: h.clock.now() });
  expect((await handle(commentDelivery(i, "pr-first", "owner", true))).status).toBe(200);
  expect((await handle(commentDelivery(i, "pr-second", "owner", true))).status).toBe(200);
  expect(h.runs()).toHaveLength(1);
  expect(records(h)).toMatchObject([{ outcome: "run", run_id: run.id }]);
  expect(hints).toBe(0);
  expect((await handle(commentDelivery(i, "issue-hint"))).status).toBe(200);
  expect(hints).toBe(1);
  expect(h.runs()).toHaveLength(1);
});

test.each([false, true])(
  "trusted bot authors are excluded even when identity fails: %s",
  async (failIdentity) => {
    const h = harness({ trusted: ["owner", "factory[bot]", "dependabot[bot]"] });
    const i = await enableComments(h);
    h.identity = async () => {
      if (failIdentity) throw new Error("identity unavailable");
      return { kind: "app", token: "fake", botLogin: "factory[bot]" };
    };
    i.comments = {
      totalCount: 2,
      nodes: [
        { ...commandComment(), author: { login: "FACTORY[BoT]" } },
        { ...commandComment(2), author: { login: "Dependabot[BOT]" } },
      ],
    };
    await pollComments(h);
    await pollComments(h);
    expect(h.runs()).toEqual([]);
    expect(records(h)).toEqual([]);
  },
);

test("webhook hints find commands beyond the oldest 100 open issues", async () => {
  const h = harness();
  const issues = Array.from({ length: 201 }, (_, n) => commentIssue(n + 1));
  const target = issues[200];
  if (!target) throw new Error("missing last-page issue");
  h.data.set("owner/repo", issues);
  h.start();
  await h.advance();
  expect(h.store.githubCommentBoundary("owner/repo")).toBe(at);
  target.comments = { totalCount: 1, nodes: [commandComment()] };
  const handle = githubWebhook(h.factory, undefined, h.pollNow);
  expect((await handle(commentDelivery(target))).status).toBe(200);
  expect(h.runs()).toEqual([]);
  await h.advance(30_000);
  expect(h.runs()).toHaveLength(1);
  expect(h.calls).toHaveLength(6);
  expect(h.runs()[0]?.sourceRef).toEqual({
    kind: "issue",
    repo: "owner/repo",
    number: 201,
    via: "queue",
  });
  expect(records(h)).toHaveLength(1);
  await pollComments(h);
  expect(h.runs()).toHaveLength(1);
});

test("initialization skips all issue pages and pre-enable commands on later pages", async () => {
  const h = harness({}, ["owner/repo"], true);
  const issues = Array.from({ length: 101 }, (_, n) => commentIssue(n + 1));
  const target = issues[100];
  if (!target) throw new Error("missing last-page issue");
  target.comments = { totalCount: 1, nodes: [{ ...commandComment(), createdAt: at }] };
  h.data.set("owner/repo", issues);
  h.start();
  await h.advance();
  expect(h.store.githubCommentBoundary("owner/repo")).toBe(new Date(at).toISOString());
  expect(h.calls).toEqual([["api", "--include", "rate_limit"]]);
  expect(h.runs()).toEqual([]);
  await pollComments(h);
  expect(h.runs()).toEqual([]);
  expect(records(h)).toEqual([]);
  expect(h.calls).toHaveLength(3);
});

test.each(["gh failure", "schema mismatch", "rate limit"])(
  "a later issue page %s leaves the whole repository retryable",
  async (failure) => {
    const h = harness();
    const issues = Array.from({ length: 101 }, (_, n) => commentIssue(n + 1));
    const first = issues[0];
    if (!first) throw new Error("missing first-page issue");
    h.data.set("owner/repo", issues);
    h.intercept = (args) => {
      if (!args[3]?.includes('after:"issues:100"')) return;
      if (failure === "gh failure") throw new Error("second page unavailable");
      if (failure === "schema mismatch") h.response = { data: { repository: null, rateLimit: h.rate } };
    };
    if (failure === "rate limit") h.rate.remaining = 0;
    h.start();
    await h.advance();
    expect(h.store.githubCommentBoundary("owner/repo")).toBe(at);
    h.intercept = undefined;
    h.response = undefined;
    h.rate.remaining = 5000;
    await h.advance(3600_000);
    expect(h.store.githubCommentBoundary("owner/repo")).toBe(at);
    first.comments = { totalCount: 1, nodes: [commandComment()] };
    h.intercept = (args) => {
      if (args[3]?.includes('after:"issues:100"')) throw new Error("second page unavailable");
    };
    await pollComments(h);
    expect(h.runs()).toEqual([]);
    expect(records(h)).toEqual([]);
    h.intercept = undefined;
    await h.advance(180_000);
    expect(h.runs()).toHaveLength(1);
  },
);

test("non-queue webhook records its comment transactionally before repository joins queue", async () => {
  const h = harness({ repos: [] });
  const i = commentIssue();
  const payload = commentDelivery(i);
  // Non-queue owner matching retains its existing case-sensitive repository policy.
  const body = (await payload.text()).replace("OWNER/REPO", "owner/repo");
  const send = (id: string) =>
    new Request(payload.url, {
      method: "POST",
      body,
      headers: {
        ...Object.fromEntries(payload.headers),
        "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
      },
    });
  const handle = githubWebhook(h.factory);
  expect((await handle(send("first"))).status).toBe(201);
  expect(h.requests[0]).toEqual(
    commentRunRequest(
      {
        repo: "owner/repo",
        number: 1,
        issueTitle: i.title,
        issueBody: i.body,
        request: "do it\nAllow: workflows",
        author: "owner",
      },
      "owner",
    ),
  );
  const run = h.runs()[0];
  if (!run || !h.cfg.githubQueue) throw new Error("missing run or queue");
  h.store.updateRun(run.id, { status: "succeeded", finishedAt: h.clock.now() });
  expect((await handle(send("second"))).status).toBe(200);
  expect(h.runs()).toHaveLength(1);
  h.cfg.githubQueue.repos = ["owner/repo"];
  h.data.set("owner/repo", [i]);
  h.start();
  await h.advance();
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  await pollComments(h);
  expect(h.runs()).toHaveLength(1);
  expect(records(h)).toMatchObject([{ outcome: "run", run_id: run.id }]);
});

test("identity failure leaves mentions retryable while slash commands still work", async () => {
  const h = harness();
  const i = await enableComments(h);
  h.identity = async () => {
    throw new Error("identity unavailable");
  };
  const mention = commentIssue(2);
  mention.comments = { totalCount: 1, nodes: [{ ...commandComment(2), body: "@FACTORY do it" }] };
  i.comments = {
    totalCount: 1,
    nodes: [{ ...commandComment(), body: "/limitless Fix <!-- limitless-lifecycle: marker" }],
  };
  h.data.set("owner/repo", [i, mention]);
  await pollComments(h);
  expect(h.runs()).toHaveLength(1);
  expect(h.store.githubCommentProcessed({ repo: "owner/repo", id: 2 })).toBe(false);
  h.identity = async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" });
  await pollComments(h);
  expect(h.runs()).toHaveLength(2);
  await pollComments(h);
  expect(records(h)).toHaveLength(2);
  expect(h.runs()).toHaveLength(2);
});

test("stopping during comment repository resolution leaves it retryable", async () => {
  const h = harness();
  const i = await enableComments(h);
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  const create = h.store.createRun.bind(h.store);
  const spy = spyOn(h.store, "createRun").mockImplementation((...args) => {
    h.stop();
    return create(...args);
  });
  await pollComments(h);
  expect(h.runs()).toEqual([]);
  expect(records(h)).toEqual([]);
  expect(h.clock.pending).toBe(0);
  spy.mockRestore();
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(1);
});

test("concurrent queues recheck the comment inside the transaction after a claim is released", async () => {
  const h = harness();
  const i = await enableComments(h);
  i.comments = { totalCount: 1, nodes: [commandComment()] };
  const create = h.store.createRun.bind(h.store);
  const spy = spyOn(h.store, "createRun").mockImplementation((...args) => {
    const run = create(...args);
    h.store.updateRun(run.id, { status: "succeeded", finishedAt: h.clock.now() });
    return run;
  });
  const second = startIssueQueue(h.factory, {
    gh: h.gh,
    lifecycle: { identity: h.identity },
    clock: {
      now: h.clock.now,
      set: h.clock.timer.set as unknown as typeof setTimeout,
      clear: h.clock.timer.clear,
    },
  });
  try {
    await pollComments(h);
    expect(h.requests).toHaveLength(2);
    expect(h.runs()).toHaveLength(1);
    expect(records(h)).toHaveLength(1);
  } finally {
    second();
    spy.mockRestore();
  }
});

test("mounted webhook requests a queue poll only for verified trusted created deliveries", async () => {
  const h = harness({ trusted: ["owner", "collaborator"] });
  const i = commentIssue();
  h.data.set("owner/repo", [i]);
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
    await h.advance();
    const route = integrations.routes["/webhooks/github"];
    if (!route) throw new Error("missing webhook");
    i.comments = { totalCount: 1, nodes: [{ ...commandComment(), author: { login: "collaborator" } }] };
    const calls = h.calls.length;
    for (const [action, author, valid] of [
      ["edited", "owner", true],
      ["created", "stranger", true],
      ["created", "owner", false],
    ] as const) {
      const delivery = commentDelivery(i, `${action}-${author}-${valid}`, author);
      const body = (await delivery.text()).replace('"action":"created"', `"action":"${action}"`);
      const headers = Object.fromEntries(delivery.headers);
      headers["x-hub-signature-256"] = valid
        ? `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`
        : `sha256=${"0".repeat(64)}`;
      await route(new Request(delivery.url, { method: "POST", body, headers }), localServer);
      await h.advance();
    }
    expect(h.calls).toHaveLength(calls);
    expect(h.runs()).toEqual([]);
    expect((await route(commentDelivery(i, "hint", "COLLABORATOR"), localServer)).status).toBe(200);
    expect(h.runs()).toEqual([]);
    await h.advance(30_000);
    expect(h.runs()).toHaveLength(1);
  } finally {
    await integrations.stop();
  }
});

function attentionEpic() {
  const closed = { ...issue(2), state: "CLOSED" as const };
  const open = issue(3);
  // Keep priority visible to attention while preventing automatic admission in poll tests.
  open.author = { login: "stranger" };
  const epic = { ...issue(1), body: "## Slices\n- Build: #2\n- Acceptance: #3" };
  epic.subIssuesSummary.total = 2;
  epic.subIssues = { totalCount: 2, nodes: [closed, open] };
  return { epic, open, closed };
}

test.each(["approval", "local claim", "missing record", "native acceptance", "foreign claim"] as const)(
  "epic attention does not substitute a local issue for a foreign child during %s",
  async (kind) => {
    const h = harness();
    const { epic, open, closed } = attentionEpic();
    epic.body = "";
    const foreign = {
      ...(kind === "native acceptance" ? closed : open),
      repository: { nameWithOwner: "other/repo" },
      labels: kind === "missing record" ? open.labels : { totalCount: 0, nodes: [] },
    };
    epic.subIssues.nodes = kind === "native acceptance" ? [foreign, open] : [closed, foreign];
    if (kind === "native acceptance") {
      open.blockedBy = {
        totalCount: 1,
        nodes: [{ number: 2, state: "CLOSED", repository: { nameWithOwner: "owner/repo" } }],
      };
    }
    if (kind === "local claim" || kind === "foreign claim") {
      open.labels = { totalCount: 0, nodes: [] };
      const repo = h.store.getRepoBySlug("owner/repo");
      if (!repo) throw new Error("missing repo");
      h.store.createRun(repo, {
        repo: repo.slug,
        prompt: "Local issue",
        sourceRef: {
          kind: "issue",
          repo: kind === "foreign claim" ? "OTHER/REPO" : "OWNER/REPO",
          number: 3,
        },
      });
      h.maxCalls = 0;
    }
    h.data.set("owner/repo", kind === "missing record" ? [epic] : [epic, open]);
    h.start();
    await h.advance();
    expect(
      h.store
        .readFeed()
        .items.filter((item) => item.kind === "queue.epic_attention")
        .map((item) => item.data.state),
    ).toEqual(kind === "native acceptance" || kind === "foreign claim" ? [] : ["needs_approval"]);
  },
);

test("native acceptance covers an exact foreign sibling even when its number equals the candidate's", () => {
  const { epic, open, closed } = attentionEpic();
  epic.body = "";
  closed.repository.nameWithOwner = "OTHER/REPO";
  open.repository.nameWithOwner = "OWNER/REPO";
  open.number = closed.number;
  const check = () =>
    epicAttention("Owner/Repo", epic, ["owner"], new Map([["owner/repo#2", open]]), () => false);
  expect(check()).toBeNull();
  open.blockedBy = {
    totalCount: 1,
    nodes: [{ number: 2, state: "CLOSED", repository: { nameWithOwner: "other/repo" } }],
  };
  expect(check()).toEqual({ state: "ready_for_acceptance", items: ["#2"] });
  // The same repository and number in different casing really is a duplicate.
  closed.repository.nameWithOwner = "owner/repo";
  expect(check()).toBeUndefined();
});

test("bare slice references cannot name a foreign child or acceptance candidate", () => {
  const { epic, open, closed } = attentionEpic();
  open.repository.nameWithOwner = "OWNER/REPO";
  expect(
    epicAttention("Owner/Repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false),
  ).toEqual({ state: "ready_for_acceptance", items: ["#3"] });
  closed.repository.nameWithOwner = "other/repo";
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false),
  ).toEqual({ state: "unfiled", items: ["- Build: #2"] });

  closed.repository.nameWithOwner = "owner/repo";
  open.repository.nameWithOwner = "other/repo";
  open.number = closed.number;
  epic.body = "## Slices\n- Acceptance: #2";
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["other/repo#2", open]]), () => false),
  ).toBeNull();
});

test.each([
  "Acceptance: [#3](https://github.com/other/repo/issues/3)",
  "Build: [#3](https://github.com/other/repo/issues/3)",
  "Acceptance: [Slice [#3]](https://github.com/other/repo/issues/3)",
  "Acceptance: [#3]()",
  "Acceptance: [#3](../issues/3)",
  "Acceptance: [#3](#3)",
  "Acceptance: [#3](https://example.com/#3)",
  "Acceptance: [#3](https://github.com/owner/repo/pull/3)",
  "Acceptance: [#3](http://github.com/owner/repo/issues/3)",
  "Acceptance: [#3](https://github.com/owner/repo/issues/0)",
  "Acceptance: [#3](https://github.com/owner/repo/issues/30)",
  "Acceptance: [#3](https://github.com/owner/repo/issues/3/extra)",
])("slice link labels cannot impersonate a child: %s", (text) => {
  const { epic, open } = attentionEpic();
  epic.body = `## Slices\n- ${text}`;
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false),
  ).toEqual({ state: "unfiled", items: [`- ${text}`] });
});

test.each([
  ["[#99](https://github.com/owner/repo/issues/3)", "ready_for_acceptance"],
  ['[#2](<https://github.com/OWNER/REPO/issues/3> "Slice #99")', "ready_for_acceptance"],
  ["[#99](https://github.com/owner/repo/issues/3#issuecomment-1)", "ready_for_acceptance"],
  ["[#99](https://example.com/#2) and #3", "ready_for_acceptance"],
  ["#3 and [#2](https://example.com/#2)", "ready_for_acceptance"],
  ["[#3](https://github.com/owner/repo/issues/2)", null],
  ["[#99](https://github.com/owner/repo/issues/2) and #3", null],
] as const)("slice destinations and independent plain text identify children: %s", (reference, state) => {
  const { epic, open } = attentionEpic();
  epic.body = `## Slices\n- Acceptance: ${reference}`;
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false),
  ).toEqual(state ? { state, items: ["#3"] } : null);
});

test("slice destinations identify foreign children with the same number as local children", () => {
  const { epic, open, closed } = attentionEpic();
  open.repository.nameWithOwner = "other/repo";
  open.number = closed.number;
  const check = () =>
    epicAttention("owner/repo", epic, ["owner"], new Map([["other/repo#2", open]]), () => false);
  epic.body = "## Slices\n- Acceptance: [#99](https://github.com/OTHER/REPO/issues/2)";
  expect(check()).toEqual({ state: "ready_for_acceptance", items: ["#2"] });
  epic.body = "## Slices\n- Acceptance: [#99](https://github.com/owner/repo/issues/2)";
  expect(check()).toBeNull();
});

test("queue-produced epic and existing feed items render in the CLI and preserve acknowledgement cursors", async () => {
  const h = harness();
  const { epic, open } = attentionEpic();
  epic.body += "\n- Later";
  h.data.set("owner/repo", [epic, open]);
  h.start();
  await h.advance();
  const repo = h.store.getRepoBySlug("owner/repo");
  if (!repo) throw new Error("missing repo");
  const run = h.store.createRun(repo, { repo: repo.slug, prompt: "Existing work" });
  h.store.updateRun(run.id, { status: "failed" });
  const routes = createHttpRoutes(h.factory);
  const feed = (routes["/api/feed"] as { GET: Route }).GET;
  const ack = (routes["/api/feed/ack"] as { POST: Route }).POST;
  const lines: string[] = [];
  const deps = {
    api: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const handler = init?.method === "POST" ? ack : feed;
      const response = await handler(
        requestWithParams(`http://localhost:7400${path}`, {
          ...init,
          headers: { "content-type": "application/json" },
        }),
        localServer,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    },
    print: (line: string) => lines.push(line),
  };
  await feedCommand([], { consumer: "legacy", json: true }, deps);
  const mixed: FeedPage = JSON.parse(lines.pop() ?? "");
  expect(mixed.items.map((i) => i.kind)).toEqual(["queue.epic_attention", "run.failed"]);
  expect(mixed.items[0]?.data).toEqual({
    repo: "owner/repo",
    epic: 1,
    state: "unfiled",
    items: ["- Later"],
  });
  const cursor = mixed.nextAfter;
  expect(mixed.items[1]?.id).toBe(cursor);
  await feedCommand([], { consumer: "legacy" }, deps);
  expect(lines.join("\n")).toContain(`#${mixed.items[0]?.id} queue.epic_attention`);
  expect(lines.join("\n")).toContain(`#${cursor} run.failed`);
  expect(lines.at(-1)).toBe(`next after: ${cursor}`);
  expect(h.store.feedCursor("legacy")).toBe(0);
  await feedCommand(["ack", String(cursor)], { consumer: "legacy" }, deps);
  expect(lines.at(-1)).toBe(`legacy acknowledged through ${cursor}`);
  expect(h.store.feedCursor("legacy")).toBe(cursor);
  h.store.updateRun(run.id, { status: "cancelled" });
  await feedCommand([], { consumer: "legacy", json: true }, deps);
  const next: FeedPage = JSON.parse(lines.at(-1) ?? "");
  expect(next.items.map((i) => i.kind)).toEqual(["run.cancelled"]);
  expect(next.items[0]?.id).toBeGreaterThan(cursor);
});

test.each([
  [
    "unrelated reference",
    (e: QueueIssue) => {
      e.body += "\n- Later #99";
    },
    "unfiled",
    ["- Later #99"],
  ],
  [
    "unfiled precedence",
    (e: QueueIssue, o: QueueIssue) => {
      e.body += "\n- Later";
      o.labels = { totalCount: 0, nodes: [] };
    },
    "unfiled",
    ["- Later"],
  ],
  [
    "approval precedence",
    (_e: QueueIssue, o: QueueIssue) => {
      o.labels = { totalCount: 0, nodes: [] };
    },
    "needs_approval",
    ["#3"],
  ],
  ["trusted acceptance", () => {}, "ready_for_acceptance", ["#3"]],
  [
    "native acceptance with closed sibling",
    (e: QueueIssue, o: QueueIssue) => {
      e.body = "";
      o.blockedBy = {
        totalCount: 1,
        nodes: [{ number: 2, state: "CLOSED", repository: { nameWithOwner: "owner/repo" } }],
      };
    },
    "ready_for_acceptance",
    ["#3"],
  ],
] as const)("epic attention: %s", (_name, change, state, items) => {
  const { epic, open } = attentionEpic();
  change(epic, open);
  expect(
    epicAttention("owner/repo", epic, ["OWNER"], new Map([["owner/repo#3", open]]), () => false),
  ).toEqual({
    state,
    items: [...items],
  });
});

test("Slices parsing excludes fences and other sections, counts closed children, and supports list markers", () => {
  const { epic, open } = attentionEpic();
  epic.body =
    "- Outside\n## Slices\n```md\n- Ignored\n```\n1. Build #2\n2) Acceptance: #3\n  continuation\n### Notes\n+ Future\n## Tests\n- Outside";
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false),
  ).toEqual({
    state: "unfiled",
    items: ["+ Future"],
  });
});

test.each(["author", "editor", "missing editor"])(
  "untrusted %s cannot identify unfiled or acceptance slices",
  (kind) => {
    const { epic, open } = attentionEpic();
    epic.body += "\n- Unfiled";
    if (kind === "author") epic.author = { login: "stranger" };
    else {
      epic.lastEditedAt = at;
      epic.editor = kind === "editor" ? { login: "stranger" } : null;
    }
    const check = () =>
      epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false);
    expect(check()).toBeNull();
    open.labels = { totalCount: 0, nodes: [] };
    expect(check()).toEqual({ state: "needs_approval", items: ["#3"] });
    open.blockedBy = {
      totalCount: 1,
      nodes: [{ number: 2, state: "CLOSED", repository: { nameWithOwner: "owner/repo" } }],
    };
    expect(
      epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => true),
    ).toEqual({
      state: "ready_for_acceptance",
      items: ["#3"],
    });
  },
);

test.each(["children", "51 children", "labels", "missing open record", "blockers"])(
  "incomplete %s preserves attention",
  (kind) => {
    const { epic, open } = attentionEpic();
    const records = new Map([["owner/repo#3", open]]);
    if (kind === "children") epic.subIssues.nodes.pop();
    if (kind === "51 children") epic.subIssues.totalCount = epic.subIssuesSummary.total = 51;
    if (kind === "labels") open.labels.totalCount++;
    if (kind === "missing open record") records.clear();
    if (kind === "blockers") {
      epic.body = "";
      open.blockedBy.totalCount++;
    }
    expect(epicAttention("owner/repo", epic, ["owner"], records, () => false)).toBeUndefined();
  },
);

test("fifty complete children report; closed, childless, approved and claimed slices do not need approval", () => {
  const { epic, open, closed } = attentionEpic();
  epic.body = "";
  epic.subIssues.nodes = [...Array.from({ length: 49 }, (_, n) => ({ ...closed, number: n + 4 })), open];
  epic.subIssues.totalCount = epic.subIssuesSummary.total = 50;
  const check = (claim = false) =>
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => claim);
  expect(check()).toBeNull();
  open.labels = { totalCount: 0, nodes: [] };
  expect(check()?.state).toBe("needs_approval");
  expect(check(true)).toBeNull();
  epic.state = "CLOSED";
  expect(check()).toBeNull();
  epic.state = "OPEN";
  epic.subIssues = { totalCount: 0, nodes: [] };
  epic.subIssuesSummary.total = 0;
  expect(check()).toBeNull();
  epic.subIssues = { totalCount: 1, nodes: [closed] };
  epic.subIssuesSummary.total = 1;
  expect(check()).toBeNull();
});

test("ambiguous acceptance or blockers missing a closed sibling do not establish acceptance", () => {
  const { epic, open } = attentionEpic();
  for (const body of [
    "",
    "## Slices\n- Acceptance: #2 #3",
    "## Slices\n- Acceptance: #2\n- Acceptance: #3",
  ]) {
    epic.body = body;
    expect(
      epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false),
    ).toBeNull();
  }
});

test("poll redacts attention before storage and publication without creating runs or mutations", async () => {
  const h = harness();
  const { epic, open } = attentionEpic();
  const secret = `credential-${crypto.randomUUID()}`;
  registerCredential("EPIC_TEST_CREDENTIAL", secret);
  epic.body += `\n- File ${secret}`;
  const published: unknown[] = [];
  h.store.subscribe((msg) => {
    if (msg.kind === "feed") published.push(msg.item);
  });
  h.data.set("owner/repo", [epic, open]);
  h.data.set("outside/repo", [epic]);
  h.start();
  await h.advance();
  const items = h.store.readFeed({ after: 0 }).items;
  expect(items).toMatchObject([
    {
      kind: "queue.epic_attention",
      runId: null,
      evalId: null,
      repo: "owner/repo",
      data: { repo: "owner/repo", epic: 1, state: "unfiled", items: ["- File [redacted]"] },
    },
  ]);
  expect(published).toEqual(items);
  expect(JSON.stringify(items)).not.toContain(secret);
  expect(h.runs()).toEqual([]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.[1]).toBe("graphql");
  expect(h.calls[0]?.[3]).toContain("subIssues(first:50)");
  expect(h.calls[0]?.[3]).toContain(
    "subIssues(first:50) { totalCount nodes { number state repository { nameWithOwner }",
  );
  expect(h.calls[0]?.[3]).toContain(
    "blockedBy(first:100) { totalCount nodes { number state repository { nameWithOwner }",
  );
});

test("epic episodes survive reopen, change A to B to A, clear silently and re-enter A", async () => {
  const h = harness();
  const path = join(h.cfg.paths.home, "epics.db");
  let store = new Store(path);
  store.githubCommentBoundary("owner/repo", at);
  const { epic, open } = attentionEpic();
  epic.body += "\n- Unfiled";
  h.data.set("owner/repo", [epic, open]);
  const start = () =>
    startIssueQueue(
      { ...h.factory, cfg: h.cfg, store, scheduler: h.factory.scheduler, createRun: h.factory.createRun },
      {
        gh: h.gh,
        lifecycle: { identity: h.identity },
        clock: {
          now: h.clock.now,
          set: h.clock.timer.set as unknown as typeof setTimeout,
          clear: h.clock.timer.clear,
        },
        log: (s) => h.logs.push(s),
      },
    );
  let stop = start();
  const poll = () => h.advance(180_000);
  const states = () => store.readFeed({ after: 0 }).items.map((i) => i.data.state);
  const saved = () => store.db.query("SELECT * FROM queue_epic_attention").all();
  try {
    await h.advance();
    await poll();
    expect(states()).toEqual(["unfiled"]);
    epic.body += "\n- Also unfiled";
    await poll();
    expect(states()).toEqual(["unfiled"]);
    stop();
    store.close();
    store = new Store(path);
    stop = start();
    await h.advance();
    expect(states()).toEqual(["unfiled"]);
    epic.body = "";
    open.labels = { totalCount: 0, nodes: [] };
    await poll();
    expect(states()).toEqual(["unfiled", "needs_approval"]);
    epic.body = "## Slices\n- Unfiled";
    await poll();
    expect(states()).toEqual(["unfiled", "needs_approval", "unfiled"]);
    expect(saved()).toEqual([{ repo: "owner/repo", epic: 1, state: "unfiled" }]);
    // A failed second page, then incomplete child evidence, cannot clear saved attention.
    h.data.set(
      "owner/repo",
      Array.from({ length: 101 }, (_, n) => commentIssue(n + 10)),
    );
    h.intercept = (args) => {
      if (args[3]?.includes('after:"issues:100"')) throw new Error("unavailable");
    };
    await poll();
    expect(saved()).toHaveLength(1);
    h.intercept = undefined;
    h.data.set("owner/repo", [epic, open]);
    epic.subIssues.totalCount++;
    await poll();
    expect(saved()).toHaveLength(1);
    epic.subIssues.totalCount--;
    epic.body = "";
    open.labels = { totalCount: 1, nodes: [{ name: "priority:1" }] };
    await poll();
    expect(saved()).toEqual([]);
    expect(states()).toHaveLength(3);
    epic.body = "## Slices\n- Unfiled";
    await poll();
    expect(states()).toEqual(["unfiled", "needs_approval", "unfiled", "unfiled"]);
    for (const leave of [
      () => {
        epic.state = "CLOSED";
      },
      () => {
        h.data.set("owner/repo", [open]);
      },
      () => {
        epic.subIssues = { totalCount: 0, nodes: [] };
        epic.subIssuesSummary.total = 0;
      },
    ]) {
      leave();
      await poll();
      expect(saved()).toEqual([]);
      epic.state = "OPEN";
      epic.subIssues = { totalCount: 2, nodes: [{ ...issue(2), state: "CLOSED" }, open] };
      epic.subIssuesSummary.total = 2;
      h.data.set("owner/repo", [epic, open]);
      await poll();
      expect(saved()).toHaveLength(1);
    }
  } finally {
    stop();
    store.close();
  }
});

test.each(["needs_approval", "ready_for_acceptance", "native", "claim"] as const)(
  "poll detects %s using current children and claims",
  async (kind) => {
    const h = harness();
    const { epic, open } = attentionEpic();
    if (kind === "needs_approval" || kind === "claim") open.labels = { totalCount: 0, nodes: [] };
    if (kind === "native") {
      epic.body = "";
      open.blockedBy = {
        totalCount: 1,
        nodes: [{ number: 2, state: "CLOSED", repository: { nameWithOwner: "owner/repo" } }],
      };
    }
    if (kind === "claim") {
      const repo = h.store.getRepoBySlug("owner/repo");
      if (!repo) throw new Error("missing repo");
      h.store.createRun(repo, {
        repo: repo.slug,
        prompt: "Acceptance",
        sourceRef: { kind: "issue", repo: "OWNER/REPO", number: 3 },
      });
      h.maxCalls = 0;
    }
    h.data.set("owner/repo", [epic, open]);
    h.start();
    await h.advance();
    expect(
      h.store
        .readFeed({ after: 0 })
        .items.filter((i) => i.kind === "queue.epic_attention")
        .map((i) => i.data),
    ).toEqual([
      {
        repo: "owner/repo",
        epic: 1,
        state: kind === "needs_approval" ? kind : "ready_for_acceptance",
        items: ["#3"],
      },
    ]);
  },
);

test("epic state rolls back with its feed item and publishes only committed observations", () => {
  const h = harness();
  const observation = new Map([[1, { state: "unfiled" as const, items: ["- Later"] }]]);
  h.store.db.exec(
    "CREATE TRIGGER reject_epic BEFORE INSERT ON feed BEGIN SELECT RAISE(ABORT, 'feed unavailable'); END",
  );
  expect(() => h.store.reconcileEpicAttention("OWNER/REPO", observation)).toThrow("feed unavailable");
  expect(h.store.db.query("SELECT * FROM queue_epic_attention").all()).toEqual([]);
  expect(h.store.readFeed().items).toEqual([]);
  h.store.db.exec("DROP TRIGGER reject_epic");
  const saved: unknown[] = [];
  h.store.subscribe((m) => {
    if (m.kind === "feed") saved.push(h.store.db.query("SELECT * FROM queue_epic_attention").all());
  });
  h.store.reconcileEpicAttention("OWNER/REPO", observation);
  expect(saved).toEqual([[{ repo: "owner/repo", epic: 1, state: "unfiled" }]]);
  h.store.reconcileEpicAttention("owner/repo", observation);
  expect(saved).toHaveLength(1);
});

test.each(["children", "51 children", "labels", "blockers", "missing child"])(
  "poll retains saved attention on incomplete %s evidence",
  async (kind) => {
    const h = harness();
    const { epic, open } = attentionEpic();
    epic.body = "";
    h.store.reconcileEpicAttention("owner/repo", new Map([[1, { state: "unfiled", items: ["- Previous"] }]]));
    if (kind === "children") epic.subIssues.nodes.pop();
    if (kind === "51 children") epic.subIssues.totalCount = epic.subIssuesSummary.total = 51;
    if (kind === "labels") open.labels.totalCount++;
    if (kind === "blockers") open.blockedBy.totalCount++;
    h.data.set("owner/repo", kind === "missing child" ? [epic] : [epic, open]);
    h.start();
    await h.advance();
    expect(h.store.readFeed().items.map((i) => i.data.state)).toEqual(["unfiled"]);
    expect(h.store.db.query("SELECT * FROM queue_epic_attention").all()).toEqual([
      { repo: "owner/repo", epic: 1, state: "unfiled" },
    ]);
  },
);

test("attention uses full open-issue labels when the child preview omits priority", () => {
  const { epic, open } = attentionEpic();
  epic.subIssues.nodes = epic.subIssues.nodes.map((c) => ({ ...c, labels: { nodes: [] } }));
  open.labels.nodes = [
    ...Array.from({ length: 20 }, (_, n) => ({ name: `label:${n}` })),
    { name: "priority:10" },
  ];
  open.labels.totalCount = 21;
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), () => false)?.state,
  ).toBe("ready_for_acceptance");
  open.labels = { totalCount: 0, nodes: [] };
  expect(
    epicAttention("owner/repo", epic, ["owner"], new Map([["owner/repo#3", open]]), (_repo, n) => n === 2)
      ?.state,
  ).toBe("needs_approval");
});
