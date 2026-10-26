import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, RunStatus } from "../src/core/types.ts";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { ISSUE_CLAIM_STATUSES, IssueClaimed, linkedIssues, Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { githubWebhook, issueRunRequest, mapGitHubEvent, unquoteGitHub } from "../src/integrations/github.ts";
import type { GitHubIdentity } from "../src/integrations/github-identity.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { pollIssueComments } from "../src/integrations/issue-comments.ts";
import { reconcileIssueLifecycle } from "../src/integrations/issue-lifecycle.ts";
import { issueEligibility, type QueueIssue, startIssueQueue } from "../src/integrations/issue-queue.ts";
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
function commandComment(id: number, created: number, body = "/limitless do the work", author = "owner") {
  const at = new Date(created).toISOString();
  return {
    id,
    node_id: `COMMENT_${id}`,
    body,
    created_at: at,
    updated_at: at,
    issue_url: `https://api.github.com/repos/owner/repo/issues/${id}`,
    user: { login: author, type: "User" },
  };
}

function harness(rawQueue: Record<string, unknown> | null = {}, repos = ["owner/repo"], disk = false) {
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
  const store = new Store(disk ? join(dir, "store.db") : ":memory:");
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
  const labels = new Map<number, Set<string>>();
  const comments = new Map<number, string[]>();
  const calls: string[][] = [];
  const delays: number[] = [];
  const logs: string[] = [];
  const requests: CreateRunRequest[] = [];
  let stop = () => {};
  const h = {
    cfg,
    store,
    closed: false,
    async close() {
      await factory.stop();
      store.close();
      h.closed = true;
    },
    dir,
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
    streamCalls: [] as string[][],
    allCalls: [] as string[][],
    stream: [] as ReturnType<typeof commandComment>[],
    streamReply: undefined as ((args: string[]) => string | Promise<string>) | undefined,
    commandIssue: { title: "Command issue", body: "Allow: submodules" },
    editHistory: { totalCount: 1, nodes: [{ editor: { login: "owner" } }] } as unknown,
    labelAt: at,
    identity: async (_repo?: string): Promise<GitHubIdentity> => ({ kind: "owner" }),
    maxCalls: undefined as number | undefined,
    intercept: undefined as ((args: string[]) => void) | undefined,
    afterWrite: undefined as ((args: string[]) => void) | undefined,
    rate: { cost: 1, remaining: 5000, resetAt: new Date(clock.now() + 3600_000).toISOString() },
    response: undefined as unknown,
    hold: undefined as Promise<void> | undefined,
    scopes: [] as (string | undefined)[],
    async gh(args: string[], _signal?: AbortSignal, _stdin?: string, repo?: string) {
      h.allCalls.push(args);
      if (args[1]?.startsWith(`repos/${repo}/issues/comments?`)) {
        h.streamCalls.push(args);
        if (h.streamReply) return h.streamReply(args);
        return `HTTP/2.0 200 OK\r\nETag: "comments"\r\n\r\n${JSON.stringify(h.stream)}`;
      }
      if (/^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1] ?? "")) {
        calls.push(args);
        h.intercept?.(args);
        return JSON.stringify(h.commandIssue);
      }
      if (args[1] === "graphql" && args[3]?.includes("userContentEdits")) {
        calls.push(args);
        h.intercept?.(args);
        const comment = h.stream.find((c) => `id=${c.node_id}` === args[5]);
        const node = comment && {
          body: comment.body,
          createdAt: comment.created_at,
          lastEditedAt: comment.updated_at === comment.created_at ? null : comment.updated_at,
          userContentEdits: h.editHistory,
        };
        return JSON.stringify({ data: { node: node ?? null, rateLimit: h.rate } });
      }
      h.scopes.push(repo);
      calls.push(args);
      h.intercept?.(args);
      if (h.hold) await h.hold;
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
        lifecycle: {
          identity: h.identity,
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
    if (!h.closed) {
      await factory.stop();
      store.close();
    }
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

function commandDelivery(
  h: ReturnType<typeof harness>,
  comment: ReturnType<typeof commandComment>,
  id: string,
  factory = h.factory,
) {
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "owner/repo" },
    sender: comment.user,
    comment,
    issue: { number: comment.id, ...h.commandIssue },
  });
  return githubWebhook(
    factory,
    async () => null,
    h.identity,
  )(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
      },
    }),
  );
}
function commandPoll(
  h: ReturnType<typeof harness>,
  cap = 50,
  factory = h.factory,
  cache = new Map<string, { key: string; etag: string }>(),
) {
  const budget = { remaining: cap };
  return pollIssueComments(
    factory,
    "owner/repo",
    h.gh,
    new AbortController().signal,
    h.clock.now(),
    budget,
    cache,
    (s) => h.logs.push(s),
    h.identity,
  ).then(() => budget);
}

test("comment polling shares webhook framing and scopes allowances to the owner's request", async () => {
  const h = harness({ trusted: ["owner", "helper"] });
  h.identity = async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" });
  h.stream = [
    commandComment(901, h.clock.now(), "/limitless fix it\nAllow: binary"),
    commandComment(902, h.clock.now(), "@factory[bot]\tfix that\nAllow: binary", "HeLpEr"),
  ];
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(2);
  for (const [number, author, request, allow] of [
    [901, "owner", "fix it\nAllow: binary", ["binary"]],
    [902, "HeLpEr", "fix that\nAllow: binary", []],
  ] as const) {
    const run = h.runs().find((r) => r.sourceRef?.number === number);
    expect(run).toMatchObject({
      source: "github",
      title: `Issue #${number}: Command issue`,
      requestedBy: author,
      sourceRef: { kind: "issue", repo: "owner/repo", number },
      allow,
      githubWebhookVerified: false,
    });
    expect(unquoteGitHub(run?.prompt ?? "")).toMatchObject({
      kind: "comment",
      data: {
        request,
        issueTitle: "Command issue",
        issueBody: "Allow: submodules",
      },
    });
  }
  expect(h.scopes.every((r) => r === "owner/repo")).toBe(true);
  expect(h.streamCalls).toHaveLength(1);
  const url = new URL(`https://example.com/${h.streamCalls[0]?.[1]}`);
  expect(url.pathname).toBe("/repos/owner/repo/issues/comments");
  expect(url.searchParams.get("since")).toBe(new Date(h.clock.now() - 1000).toISOString());
  expect(url.searchParams.get("direction")).toBe("asc");
  expect(url.searchParams.get("sort")).toBe("updated");
});

test.each(["poll", "webhook"] as const)(
  "comment identity dedupes both transports when %s wins, even after completion and reopen",
  async (first) => {
    const h = harness({}, ["owner/repo"], true);
    const comment = commandComment(903, h.clock.now());
    h.stream = [comment];
    if (first === "webhook") expect((await commandDelivery(h, comment, "first")).status).toBe(201);
    await commandPoll(h);
    const run = h.runs()[0];
    if (!run) throw new Error("missing command run");
    expect(h.runs()).toHaveLength(1);
    h.store.updateRun(run.id, { status: "succeeded" });
    expect((await commandDelivery(h, comment, "replay")).status).toBe(200);
    await h.close();
    const reopened = new Store(join(h.dir, "store.db"));
    try {
      const factory = new Factory(h.cfg, { store: reopened });
      await commandPoll(h, 50, factory);
      expect(reopened.listRuns()).toHaveLength(1);
      expect(reopened.commentCommand({ repo: "OWNER/REPO", id: comment.id })?.runId).toBe(run.id);
      expect((await commandDelivery(h, comment, "after-reopen", factory)).status).toBe(200);
      await factory.stop();
    } finally {
      reopened.close();
    }
  },
);

test.each(["poll", "webhook"] as const)(
  "overlapping %s command admission cannot insert two runs",
  async (first) => {
    const h = harness();
    const comment = commandComment(904, h.clock.now());
    h.stream = [comment];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = h.factory.createRun.bind(h.factory);
    let calls = 0;
    h.factory.createRun = async (...args) => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return original(...args);
    };
    const pending = first === "poll" ? commandPoll(h) : commandDelivery(h, comment, "held");
    await entered.promise;
    if (first === "poll") expect((await commandDelivery(h, comment, "wins")).status).toBe(201);
    else await commandPoll(h);
    const winner = h.runs()[0];
    if (!winner) throw new Error("missing winning run");
    h.store.updateRun(winner.id, { status: "succeeded" });
    release.resolve();
    await pending;
    expect(h.runs()).toHaveLength(1);
    expect(h.store.commentCommand({ repo: "owner/repo", id: comment.id })?.runId).toBe(h.runs()[0]?.id);
  },
);

test.each(["before insertion", "after insertion"] as const)(
  "an interruption %s leaves a recoverable command",
  async (where) => {
    const h = harness({}, ["owner/repo"], true);
    h.stream = [commandComment(905, h.clock.now())];
    const original = h.factory.createRun.bind(h.factory);
    h.factory.createRun = async (...args) => {
      if (where === "after insertion") await original(...args);
      throw new Error("interrupted");
    };
    await commandPoll(h);
    expect(h.runs()).toHaveLength(where === "after insertion" ? 1 : 0);
    await h.close();
    const reopened = new Store(join(h.dir, "store.db"));
    const factory = new Factory(h.cfg, { store: reopened });
    try {
      await commandPoll(h, 50, factory);
      expect(reopened.listRuns()).toHaveLength(1);
      expect(reopened.commentCommand({ repo: "owner/repo", id: 905 })?.runId).toBe(
        reopened.listRuns()[0]?.id,
      );
    } finally {
      await factory.stop();
      reopened.close();
    }
  },
);

test.each([
  "untrusted",
  "foreign editor",
  "missing editor",
  "incomplete edits",
  "bot",
  "factory id",
  "factory pending",
  "empty",
  "non-leading",
  "historical",
  "unresolved mention",
])("comment polling rejects %s with durable first-enable boundaries", async (reason) => {
  const h = harness({ trusted: ["owner", "helper"] });
  const boundary = h.clock.now();
  h.store.commentStream("owner/repo", boundary);
  const comment = commandComment(906, boundary);
  if (reason === "untrusted") comment.user.login = "stranger";
  if (reason.includes("editor") || reason === "incomplete edits") {
    comment.updated_at = new Date(boundary + 1000).toISOString();
    h.editHistory =
      reason === "missing editor"
        ? null
        : {
            totalCount: reason === "incomplete edits" ? 2 : 1,
            nodes: [{ editor: { login: reason === "foreign editor" ? "helper" : "owner" } }],
          };
    if (reason === "foreign editor")
      h.editHistory = {
        totalCount: 2,
        nodes: [{ editor: { login: "helper" } }, { editor: { login: "owner" } }],
      };
  }
  if (reason === "bot") comment.user.type = "Bot";
  if (reason.startsWith("factory")) {
    const run = await h.factory.createRun({ repo: "owner/repo", prompt: "factory run" });
    h.store.setIssueLifecycleEffect(
      run.id,
      "owner/repo",
      906,
      "comment:started",
      "pending",
      reason === "factory id" ? { commentId: 906 } : { body: comment.body, login: "owner" },
    );
  }
  if (reason === "empty") comment.body = "/limitless \t\n";
  if (reason === "non-leading") comment.body = "please /limitless work";
  if (reason === "historical") {
    comment.created_at = new Date(boundary - 1000).toISOString();
    comment.updated_at = new Date(boundary + 1000).toISOString();
  }
  if (reason === "unresolved mention") comment.body = "@factory[bot] work";
  const originalCount = h.runs().length;
  h.stream = [comment];
  await commandPoll(h);
  expect(h.runs()).toHaveLength(originalCount);
  expect(h.store.commentCommand({ repo: "owner/repo", id: 906 })?.runId).toBeNull();
});

test("an author-only edit has complete evidence and an owner human command still counts", async () => {
  const h = harness();
  const comment = commandComment(907, h.clock.now());
  comment.updated_at = new Date(h.clock.now() + 1000).toISOString();
  h.stream = [comment];
  await commandPoll(h);
  expect(h.runs()).toHaveLength(1);
  expect(h.calls.filter((a) => a[3]?.includes("userContentEdits"))).toHaveLength(1);
});

test("first enable survives reopening and never executes a later edit of an older comment", async () => {
  const h = harness({}, ["owner/repo"], true);
  const boundary = h.clock.now();
  await commandPoll(h);
  await h.close();
  await h.clock.advance(5000);
  const comment = commandComment(908, boundary - 1000);
  comment.updated_at = new Date(h.clock.now()).toISOString();
  h.stream = [comment, commandComment(909, boundary + 1000)];
  const reopened = new Store(join(h.dir, "store.db"));
  const factory = new Factory(h.cfg, { store: reopened });
  try {
    await commandPoll(h, 50, factory);
    expect(reopened.commentStream("owner/repo", h.clock.now()).initializedAt).toBe(
      new Date(boundary).toISOString(),
    );
    expect(reopened.listRuns().map((r) => r.sourceRef?.number)).toEqual([909]);
  } finally {
    await factory.stop();
    reopened.close();
  }
});

test("304 costs one call, is conditional on the exact stream request, and mutates no command state", async () => {
  const h = harness();
  const cache = new Map<string, { key: string; etag: string }>();
  await commandPoll(h, 50, h.factory, cache);
  const state = h.store.commentStream("owner/repo", h.clock.now());
  h.streamReply = () => 'HTTP/2.0 304 Not Modified\r\nETag: "comments"\r\n\r\n';
  const before = h.allCalls.length;
  expect((await commandPoll(h, 50, h.factory, cache)).remaining).toBe(49);
  expect(h.allCalls).toHaveLength(before + 1);
  expect(h.streamCalls.at(-1)).toContain('If-None-Match: "comments"');
  expect(h.store.commentStream("owner/repo", h.clock.now())).toEqual(state);
  expect(h.store.db.query("SELECT * FROM issue_comment_commands").all()).toEqual([]);
  expect(h.runs()).toEqual([]);
});

/** GitHub's comment stream: updated after since, ascending by update, offset pages of per_page. */
function githubStream(comments: ReturnType<typeof commandComment>[], fail?: () => boolean) {
  return (args: string[]) => {
    if (fail?.()) throw new Error("page failed");
    const query = new URL(`https://example.com/${args[1]}`).searchParams;
    const since = Date.parse(query.get("since") ?? "");
    const [page, size] = [Number(query.get("page")), Number(query.get("per_page"))];
    const matching = comments
      .filter((c) => Date.parse(c.updated_at) > since)
      .sort((x, y) => Date.parse(x.updated_at) - Date.parse(y.updated_at) || x.id - y.id);
    return `HTTP/2.0 200 OK\r\nETag: "${since}-${page}"\r\n\r\n${JSON.stringify(matching.slice((page - 1) * size, page * size))}`;
  };
}
const budgeted = (calls: string[][]) =>
  calls.filter((a) => a[1] !== "graphql" || a[3]?.includes("userContentEdits"));

test("pagination tolerates edits, ties, a failed page and budget pauses without skipping commands", async () => {
  const h = harness();
  const at = (i: number) => new Date(h.clock.now() + 1000 + 2000 * Math.min(i, 99)).toISOString();
  h.stream = Array.from({ length: 103 }, (_, i) => ({
    ...commandComment(1000 + i, 0, i === 100 || i === 102 ? "/limitless work" : "ordinary comment"),
    created_at: at(i),
    updated_at: at(i),
  }));
  let fetches = 0;
  h.streamReply = githubStream(h.stream, () => ++fetches === 2);
  await commandPoll(h, 2);
  expect(h.allCalls).toHaveLength(2);
  expect(h.logs.join("\n")).toContain("page failed");
  // Editing a handled comment moves it to the end, shifting the unseen command 1100 into page 1.
  const edited = h.stream[0];
  if (!edited) throw new Error("missing comment");
  edited.updated_at = new Date(h.clock.now() + 900_000).toISOString();
  let count = h.allCalls.length;
  await commandPoll(h, 2);
  expect(h.allCalls.length - count).toBe(1);
  expect(h.runs()).toHaveLength(0);
  await commandPoll(h, 2);
  expect(h.runs().map((r) => r.sourceRef?.number)).toEqual([1100]);
  await commandPoll(h, 2);
  expect(h.runs()).toHaveLength(2);
  expect(h.store.commentStream("owner/repo", h.clock.now())).toMatchObject({
    page: 1,
    pending: null,
    since: new Date(Date.parse(edited.updated_at) - 1000).toISOString(),
  });
  // A new arrival shares the cursor's timestamp; the overlap must still discover it.
  h.stream.push({ ...commandComment(1103, 0), created_at: edited.updated_at, updated_at: edited.updated_at });
  count = h.allCalls.length;
  await commandPoll(h);
  expect(h.allCalls.length - count).toBe(3);
  expect(
    h
      .runs()
      .map((r) => r.sourceRef?.number)
      .sort(),
  ).toEqual([1100, 1102, 1103]);
});

test("a full page inside one second falls back to page offsets instead of stalling", async () => {
  const h = harness();
  const at = new Date(h.clock.now() + 1000).toISOString();
  h.stream = Array.from({ length: 101 }, (_, i) => ({
    ...commandComment(2000 + i, 0, i === 100 ? "/limitless work" : "ordinary comment"),
    created_at: at,
    updated_at: at,
  }));
  h.streamReply = githubStream(h.stream);
  await commandPoll(h);
  expect(h.runs().map((r) => r.sourceRef?.number)).toEqual([2100]);
  expect(h.streamCalls.map((a) => new URL(`https://example.com/${a[1]}`).searchParams.get("page"))).toEqual([
    "1",
    "1",
    "2",
  ]);
});

test("claim refusal is processed, redacted and durable after claim release and reopen", async () => {
  const h = harness({}, ["owner/repo"], true);
  const claimant = await h.factory.createRun({ repo: "owner/repo", prompt: "Closes #910" });
  h.stream = [commandComment(910, h.clock.now())];
  const secret = `claim-${crypto.randomUUID()}`;
  registerCredential("TEST_COMMENT_CLAIM", secret);
  const original = h.store.issueClaim.bind(h.store);
  h.store.issueClaim = (...args) => {
    const run = original(...args);
    return run ? { ...run, id: `${run.id}-${secret}` } : null;
  };
  await commandPoll(h);
  expect(h.logs.join("\n")).toContain(claimant.id);
  expect(h.logs.join("\n")).not.toContain(secret);
  expect(h.store.commentCommand({ repo: "owner/repo", id: 910 })?.note).not.toContain(secret);
  h.store.updateRun(claimant.id, { status: "succeeded" });
  await h.close();
  const reopened = new Store(join(h.dir, "store.db"));
  const factory = new Factory(h.cfg, { store: reopened });
  try {
    await commandPoll(h, 50, factory);
    expect(reopened.listRuns()).toHaveLength(1);
  } finally {
    await factory.stop();
    reopened.close();
  }
});

test.each(["unchanged", "foreign edit", "deleted"] as const)(
  "a budget pause re-reads a %s command before it runs, across reopen",
  async (change) => {
    const h = harness({ trusted: ["owner", "helper"] }, ["owner/repo"], true);
    const comment = commandComment(911, h.clock.now());
    h.stream = [comment];
    await commandPoll(h, 1);
    expect(h.allCalls).toHaveLength(1);
    expect(h.runs()).toHaveLength(0);
    if (change === "foreign edit") {
      comment.updated_at = new Date(h.clock.now() + 60_000).toISOString();
      h.editHistory = {
        totalCount: 2,
        nodes: [{ editor: { login: "helper" } }, { editor: { login: "owner" } }],
      };
    }
    if (change === "deleted") h.stream = [];
    await h.close();
    const reopened = new Store(join(h.dir, "store.db"));
    const factory = new Factory(h.cfg, { store: reopened });
    try {
      await commandPoll(h, 2, factory);
      expect(h.allCalls).toHaveLength(3);
      expect(h.streamCalls).toHaveLength(1);
      expect(h.allCalls.at(-1)).toContain("id=COMMENT_911");
      expect(reopened.listRuns()).toHaveLength(change === "unchanged" ? 1 : 0);
      expect(reopened.commentCommand({ repo: "owner/repo", id: 911 })).not.toBeNull();
      expect(reopened.commentStream("owner/repo", h.clock.now()).pending).toBeNull();
    } finally {
      await factory.stop();
      reopened.close();
    }
  },
);

test("conditional headers never transfer to a changed since query or GitHub identity", async () => {
  const h = harness();
  const cache = new Map<string, { key: string; etag: string }>();
  await commandPoll(h, 50, h.factory, cache);
  h.identity = async () => ({ kind: "app", token: "fake-app", botLogin: "factory[bot]" });
  await commandPoll(h, 50, h.factory, cache);
  expect(h.streamCalls.at(-1)).not.toContain("-H");
  h.stream = [commandComment(912, h.clock.now() + 5000)];
  await commandPoll(h, 50, h.factory, cache);
  expect(h.streamCalls.at(-1)).toContain("-H");
  await commandPoll(h, 50, h.factory, cache);
  expect(h.streamCalls.at(-1)).not.toContain("-H");
});

test("comment metadata calls and lifecycle delivery share the existing poll allowance", async () => {
  const h = harness();
  h.maxCalls = 2;
  h.stream = [commandComment(913, h.clock.now())];
  h.start();
  await h.advance();
  expect(budgeted(h.allCalls)).toHaveLength(1);
  expect(h.runs()).toHaveLength(0);
  let before = h.allCalls.length;
  await h.advance(180_000);
  expect(budgeted(h.allCalls.slice(before))).toHaveLength(2);
  expect(h.runs()).toHaveLength(1);
  expect(h.streamCalls).toHaveLength(1);
  before = h.allCalls.length;
  await h.advance(180_000);
  // Lifecycle delivery for the new run spends the whole allowance, so the stream waits.
  expect(budgeted(h.allCalls.slice(before))).toHaveLength(2);
  expect(h.streamCalls).toHaveLength(1);
  for (let i = 0; i < 5 && h.streamCalls.length === 1; i++) {
    before = h.allCalls.length;
    await h.advance(180_000);
    expect(budgeted(h.allCalls.slice(before)).length).toBeLessThanOrEqual(2);
  }
  expect(h.streamCalls).toHaveLength(2);
  expect(h.runs()).toHaveLength(1);
});

test("edited-command metadata preserves the queue's GraphQL rate-limit deferral", async () => {
  const h = harness({}, ["owner/repo", "owner/other"]);
  const comment = commandComment(914, h.clock.now());
  comment.updated_at = new Date(h.clock.now() + 1000).toISOString();
  h.stream = [comment];
  h.intercept = (args) => {
    if (args[3]?.includes("userContentEdits")) h.rate.remaining = 0;
  };
  h.start();
  await h.advance();
  expect(h.runs()).toHaveLength(0);
  expect(h.streamCalls).toHaveLength(1);
  const before = h.allCalls.length;
  await h.advance(180_000);
  expect(h.allCalls).toHaveLength(before);
  h.intercept = undefined;
  h.rate.remaining = 5000;
  await h.advance(3600_000);
  expect(h.runs()).toHaveLength(1);
});

test("queue webhook commands share trusted authors and App mentions even without an owner", async () => {
  const h = harness({ trusted: ["helper"] });
  h.cfg.githubOwner = null;
  h.identity = async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" });
  const comment = commandComment(915, h.clock.now(), "@factory[bot] build it\nAllow: binary", "HeLpEr");
  expect((await commandDelivery(h, comment, "helper")).status).toBe(201);
  expect(h.runs()[0]).toMatchObject({ requestedBy: "HeLpEr", allow: [], githubWebhookVerified: true });
  h.stream = [comment];
  await commandPoll(h);
  expect(h.runs()).toHaveLength(1);
});
