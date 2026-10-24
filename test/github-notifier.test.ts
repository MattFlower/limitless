import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { computeStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import {
  type GitHubPrClient,
  type GitHubPrState,
  RECONCILE_REQUEST_CAP,
  reconcileMergedRuns,
  startGitHubNotifier,
} from "../src/integrations/github-notifier.ts";
import { observedPrs } from "../src/integrations/github-poller.ts";
import { pollerHarness, respond, SHA, url } from "./github-poller-support.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "github-notifier-"));
  store = new Store(join(dir, "store.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("comments once at creation and terminal status with cost and PR link", async () => {
  const calls: string[][] = [];
  const stop = startGitHubNotifier(
    store,
    async (args) => {
      calls.push(args);
    },
    () => {},
    async () => null,
  );
  const repo = store.upsertRepo({
    slug: "MattFlower/limitless",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, {
    repo: repo.slug,
    prompt: "fix",
    source: "github",
    sourceRef: { kind: "pull_request", repo: repo.slug, number: 12 },
  });
  store.updateRun(run.id, { stage: "prepare" });
  store.updateRun(run.id, { status: "running" });
  store.updateRun(run.id, { prUrl: "https://github.com/MattFlower/limitless/pull/12" });
  store.db.query("UPDATE runs SET cost_usd = 1.25, cost_equiv_usd = 2.5 WHERE id = ?").run(run.id);
  store.updateRun(run.id, { status: "succeeded" });
  store.updateRun(run.id, { stage: null });
  const other = store.createRun(repo, { repo: repo.slug, prompt: "other" });
  store.updateRun(other.id, { status: "failed" });
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual([
    "pr",
    "comment",
    "12",
    "--repo",
    repo.slug,
    "--body",
    `Limitless run created: ${run.id}`,
  ]);
  expect(calls[1]?.at(-1)).toContain("succeeded");
  expect(calls[1]?.at(-1)).toContain("https://github.com/MattFlower/limitless/pull/12");
  expect(calls[1]?.at(-1)).toContain("$1.25");
  stop();
});

test.each([
  ["queue", undefined, 0],
  ["queue without config", undefined, 0],
  ["ordinary", undefined, 2],
  ["ordinary", [], 2],
  ["queue disabled", undefined, 2],
] as const)("issue lifecycle comments for %s runs with trust %j", async (kind, trusted, expected) => {
  const cfg = loadConfig({
    home: join(dir, "data"),
    configDir: join(dir, "cfg"),
    raw: {
      owners: { github: "owner" },
      github:
        kind === "queue disabled" || kind === "queue without config"
          ? {}
          : { queue: { repos: ["owner/repo"], trusted } },
    },
  });
  const calls: string[][] = [];
  const stop = startGitHubNotifier(
    store,
    async (args) => {
      calls.push(args);
    },
    () => {},
    async () => null,
    cfg.paths.configDir,
    [],
    cfg,
  );
  try {
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, {
      repo: repo.slug,
      prompt: "fix",
      source: "github",
      sourceRef: {
        kind: "issue",
        repo: repo.slug,
        number: 12,
        ...(kind === "queue" || kind === "queue without config" ? { via: "queue" } : {}),
      },
    });
    expect(run.githubWebhookVerified).toBe(false);
    store.updateRun(run.id, { status: "failed" });
    expect(calls).toHaveLength(expected);
    if (expected) {
      expect(calls[0]?.at(-1)).toBe(`Limitless run created: ${run.id}`);
      expect(calls[1]?.at(-1)).toContain("**failed**");
    }
  } finally {
    await stop();
  }
});

test("PR verification runs skip the creation comment", async () => {
  const calls: string[][] = [];
  const stop = startGitHubNotifier(store, async (args) => {
    calls.push(args);
  });
  const repo = store.upsertRepo({
    slug: "MattFlower/limitless",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, {
    repo: repo.slug,
    prompt: "verify",
    source: "github",
    sourceRef: {
      kind: "pull_request",
      repo: repo.slug,
      number: 12,
      baseRef: "main",
      baseSha: "b".repeat(40),
    },
  });
  store.updateRun(run.id, { status: "failed" });
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.at(-1)).toContain("failed");
  stop();
});

const prUrl = "https://github.com/MattFlower/limitless/pull/39";

function needsHuman(pr: string | null = prUrl) {
  const repo = store.upsertRepo({
    slug: "MattFlower/limitless",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "fix", source: "cli" });
  store.updateRun(run.id, {
    status: "needs_human",
    error: "review required",
    finishedAt: 123456,
    ...(pr ? { prUrl: pr } : {}),
  });
  store.startStage(run.id, "implement");
  return run.id;
}

test("merged PR resolves once, preserves evidence, and survives reopening", async () => {
  const id = needsHuman();
  store.putArtifact(id, "report", "markdown", "Human review required");
  store.addEvent({ runId: id, type: "status", message: "Run needs human", data: { to: "needs_human" } });
  const messages: string[] = [];
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run") messages.push(msg.run.status);
  });
  const client: GitHubPrClient = async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: { login: "MattFlower" },
  });
  await reconcileMergedRuns(store, client);
  await reconcileMergedRuns(store, client);
  unsubscribe();
  const run = store.getRun(id);
  expect(run?.status).toBe("resolved");
  expect(run?.merged).toBe(true);
  expect(run?.mergedBy).toBe("MattFlower");
  expect(run?.mergedAt).toBe(Date.parse("2026-09-27T20:00:00Z"));
  expect(run?.finishedAt).toBe(123456);
  expect(run?.error).toBe("review required");
  expect(store.listStages(id)).toHaveLength(1);
  const events = store.listEvents(id).filter((event) => event.type === "status");
  expect(events).toHaveLength(2);
  expect(events[0]?.data).toEqual({ to: "needs_human" });
  expect(events[1]?.data).toEqual({
    from: "needs_human",
    to: "resolved",
    mergedBy: "MattFlower",
    mergedAt: run?.mergedAt,
  });
  expect(messages).toEqual(["resolved"]);
  expect(store.getArtifact(id, "report")).toBe("Human review required");
  expect(run?.resolution).toEqual({
    kind: "merged",
    ref: prUrl,
    note: null,
    by: "github",
    at: Date.parse("2026-09-27T20:00:00Z"),
  });
  const kinds = () => store.readFeed({ after: 0, limit: 100 }).items.map((i) => i.kind);
  expect(kinds().filter((k) => k === "run.merged" || k === "run.resolved")).toEqual([
    "run.merged",
    "run.resolved",
  ]);
  store.close();
  store = new Store(join(dir, "store.db"));
  expect(store.getRun(id)?.resolution?.kind).toBe("merged");
  expect(kinds().filter((k) => k === "run.resolved")).toHaveLength(1);
  expect(store.getRun(id)?.mergedBy).toBe("MattFlower");
  expect(store.listEvents(id).filter((event) => event.type === "status")).toHaveLength(2);
});

test("reconciliation resolves a persisted PR owner and all rounds together without superseding them", async () => {
  const id = needsHuman();
  const owner = store.updateRun(id, { branch: `limitless/${id}-fix` });
  const repo = store.getRepo(owner.repoId);
  if (!repo) throw new Error("missing owner repository");
  store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("owner\nCloses #42", id);
  const rounds = [];
  for (let i = 0; i < 2; i++) {
    const result = store.createReviewRound(
      repo,
      owner,
      { prUrl, reviewedSha: SHA, findings: [], cap: 3 },
      (round) => ({
        repo: repo.slug,
        prompt: "round\nCloses #42",
        baseBranch: owner.branch ?? undefined,
        deliveryBranch: owner.branch ?? undefined,
        sourceRef: { kind: "review-round", runId: id, round, prUrl, reviewedSha: SHA },
      }),
    );
    if (!("run" in result)) throw new Error("round refused");
    rounds.push(result.run.id);
    store.updateRun(result.run.id, { status: "needs_human", finishedAt: 123, error: "round review" });
  }
  const other = needsHuman(`${prUrl}0`);
  store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("other PR\nCloses #42", other);
  store.close();
  store = new Store(join(dir, "store.db"));
  const client = mock(async (url: string) =>
    url === prUrl
      ? {
          url,
          state: "MERGED",
          mergedAt: "2026-09-27T20:00:00Z",
          mergedBy: { login: "owner" },
        }
      : null,
  );
  await reconcileMergedRuns(store, client);
  for (const runId of [id, ...rounds]) {
    expect(store.getRun(runId)).toMatchObject({
      status: "resolved",
      merged: true,
      mergedBy: "owner",
      resolution: { kind: "merged", ref: prUrl },
    });
  }
  for (const runId of rounds)
    expect(store.getRun(runId)).toMatchObject({ finishedAt: 123, error: "round review" });
  expect(store.getRun(other)?.resolution?.kind).toBe("superseded");
  store.close();
  store = new Store(join(dir, "store.db"));
  for (const runId of [id, ...rounds]) expect(store.getRun(runId)?.resolution?.kind).toBe("merged");
});

test("a needs_human run with a pre-recorded merge still gets its resolution and metadata", async () => {
  const id = needsHuman();
  store.updateRun(id, { merged: true });
  await reconcileMergedRuns(store, async (url) => ({
    url,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: { login: "owner" },
  }));
  expect(store.getRun(id)).toMatchObject({
    status: "resolved",
    merged: true,
    mergedBy: "owner",
    mergedAt: Date.parse("2026-09-27T20:00:00Z"),
    resolution: { kind: "merged" },
  });
  expect(store.readFeed().items.filter((item) => item.kind === "run.merged")).toHaveLength(1);
});

test("merged runs with permanently missing metadata never spend reconciliation requests", async () => {
  const ids = [needsHuman(), needsHuman(`${prUrl}0`), needsHuman(`${prUrl}1`)];
  for (const [i, id] of ids.entries())
    store.updateRun(id, {
      status: "succeeded",
      merged: true,
      mergedBy: i === 1 ? "owner" : null,
      mergedAt: i === 2 ? 123456 : null,
    });
  const live = needsHuman(`${prUrl}2`);
  const client = mock(async (url: string) => ({ url, state: "OPEN", mergedAt: null, mergedBy: null }));
  for (const elapsed of [0, 300_000, 2 * 86_400_000])
    await reconcileMergedRuns(
      store,
      client,
      () => {},
      () => Date.now() + elapsed,
    );
  expect(client.mock.calls.map(([url]) => url)).toEqual(Array(3).fill(`${prUrl}2`));
  expect(store.getRun(live)?.merged).toBe(false);
});

test("only an exact merged PR resolves; failures remain retryable", async () => {
  let now = Date.now();
  const reconcile = (client: GitHubPrClient, log = () => {}) => {
    now += 900_001;
    return reconcileMergedRuns(store, client, log, () => now);
  };
  const id = needsHuman();
  const noPr = needsHuman(null);
  let calls = 0;
  for (const state of [
    { url: prUrl, state: "OPEN", mergedAt: null, mergedBy: null },
    {
      url: "https://github.com/MattFlower/limitless/pull/40",
      state: "CLOSED",
      mergedAt: null,
      mergedBy: null,
    },
    {
      url: "https://github.com/MattFlower/limitless/pull/40",
      state: "MERGED",
      mergedAt: "2026-09-27T20:00:00Z",
      mergedBy: null,
    },
    null,
  ]) {
    await reconcile(async () => {
      calls++;
      return state;
    });
    expect(store.getRun(id)?.status).toBe("needs_human");
  }
  await reconcile(
    async () => {
      calls++;
      throw new Error("offline");
    },
    () => {},
  );
  expect(store.getRun(id)?.status).toBe("needs_human");
  expect(store.getRun(noPr)?.status).toBe("needs_human");
  expect(calls).toBe(5);
  await reconcile(async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: null,
  }));
  expect(store.getRun(id)?.status).toBe("resolved");
  expect(store.getRun(id)?.mergedBy).toBeNull();
});

test("a needs_human PR closed unmerged resolves once as pr_closed; a manual resolution that wins is kept", async () => {
  const id = needsHuman();
  const closed = async () => ({ url: prUrl, state: "CLOSED", mergedAt: null, mergedBy: null });
  await reconcileMergedRuns(store, closed);
  await reconcileMergedRuns(store, closed);
  const run = store.getRun(id);
  expect(run).toMatchObject({
    status: "resolved",
    merged: false,
    prClosedUnmerged: true,
    finishedAt: 123456,
  });
  expect(run?.resolution).toMatchObject({ kind: "pr_closed", ref: prUrl, by: "github", note: null });
  expect(
    store.readFeed({ after: 0, limit: 100 }).items.filter((i) => i.kind === "run.resolved"),
  ).toHaveLength(1);

  const pendingUrl = `${prUrl}0`;
  const pending = needsHuman(pendingUrl);
  let answer: (pr: Awaited<ReturnType<GitHubPrClient>>) => void = () => {};
  let started = () => {};
  const checking = new Promise<void>((done) => {
    started = done;
  });
  const observed = reconcileMergedRuns(store, async (url) =>
    url === pendingUrl
      ? new Promise((done) => {
          answer = done;
          started();
        })
      : closed(),
  );
  await checking;
  store.resolveRun(pending, { kind: "done_elsewhere", by: "human" });
  answer({ url: pendingUrl, state: "CLOSED", mergedAt: null, mergedBy: null });
  await observed;
  expect(store.getRun(pending)?.resolution?.kind).toBe("done_elsewhere");
});

test("a merge observed by GitHub supersedes needs_human runs closing the same issue", async () => {
  const id = needsHuman();
  store.db.query("UPDATE runs SET prompt = 'Fix\n\nCloses #12' WHERE id = ?").run(id);
  const run = store.getRun(id);
  const repo = run && store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  // Older releases could persist overlapping claims; reconciliation must still resolve them.
  const older = store.createRun(repo, { repo: repo.slug, prompt: "First try." });
  store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("First try. Closes #12", older.id);
  store.updateRun(older.id, { status: "needs_human", finishedAt: 1 });
  await reconcileMergedRuns(store, async (url) =>
    url === prUrl ? { url, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: null } : null,
  );
  expect(store.getRun(id)?.resolution?.kind).toBe("merged");
  expect(store.getRun(older.id)?.resolution).toMatchObject({ kind: "superseded", ref: prUrl, by: "system" });
});

for (const status of ["needs_human", "succeeded"] as const) {
  test(`${status} merge and every supersession roll back on feed failure and retry`, async () => {
    const id = needsHuman();
    store.db.query("UPDATE runs SET prompt = 'Closes #12' WHERE id = ?").run(id);
    const merging = store.updateRun(id, { status });
    const targets = [needsHuman(null), needsHuman(null)];
    for (const target of targets)
      store.db.query("UPDATE runs SET prompt = 'Retry. Closes #12' WHERE id = ?").run(target);
    const before = targets.map((target) => store.getRun(target));
    const feed = store.readFeed().items;
    const events = [id, ...targets].map((target) => store.listEvents(target));
    const published: unknown[] = [];
    const unsubscribe = store.subscribe((message) => published.push(message));
    const errors: string[] = [];
    const client: GitHubPrClient = async (url) => ({
      url,
      state: "MERGED",
      mergedAt: "2026-09-27T20:00:00Z",
      mergedBy: { login: "owner" },
    });
    store.db.exec(`CREATE TEMP TRIGGER reject_supersession BEFORE INSERT ON feed
      WHEN NEW.kind = 'run.resolved' AND NEW.run_id = '${targets[0]}'
      BEGIN SELECT RAISE(ABORT, 'injected supersession failure'); END`);
    try {
      await reconcileMergedRuns(store, client, (message) => errors.push(message));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("injected supersession failure");
      expect(store.getRun(id)).toEqual(merging);
      expect(targets.map((target) => store.getRun(target))).toEqual(before);
      expect(store.readFeed().items).toEqual(feed);
      expect([id, ...targets].map((target) => store.listEvents(target))).toEqual(events);
      expect(published).toEqual([]);
    } finally {
      store.db.exec("DROP TRIGGER reject_supersession");
      unsubscribe();
    }
    await reconcileMergedRuns(store, client);
    await reconcileMergedRuns(store, client);
    expect(store.getRun(id)).toMatchObject({
      status: status === "needs_human" ? "resolved" : status,
      merged: true,
      mergedBy: "owner",
      mergedAt: Date.parse("2026-09-27T20:00:00Z"),
    });
    const items = store.readFeed().items;
    expect(items.filter((item) => item.kind === "run.merged" && item.runId === id)).toHaveLength(1);
    for (const target of targets) {
      expect(store.getRun(target)?.resolution).toMatchObject({ kind: "superseded", ref: prUrl });
      expect(items.filter((item) => item.kind === "run.resolved" && item.runId === target)).toHaveLength(1);
    }
  });
}

for (const timing of ["already resolved", "lookup in flight"] as const) {
  test(`a later PR merge keeps the manual resolution: ${timing}`, async () => {
    const id = needsHuman();
    store.db.query("UPDATE runs SET prompt = 'Closes #12' WHERE id = ?").run(id);
    const target = needsHuman(null);
    store.db.query("UPDATE runs SET prompt = 'Old attempt. Closes #12' WHERE id = ?").run(target);
    const resolve = () =>
      store.resolveRun(id, {
        kind: "done_elsewhere",
        by: "human",
        note: "handled separately",
        ref: "other work",
        at: 42,
      });
    if (timing === "already resolved") resolve();
    let release: (pr: Awaited<ReturnType<GitHubPrClient>>) => void = () => {};
    const pending = reconcileMergedRuns(
      store,
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    if (timing === "lookup in flight") resolve();
    const resolution = store.getRun(id)?.resolution;
    release({ url: prUrl, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: { login: "owner" } });
    await pending;
    await reconcileMergedRuns(
      store,
      async () => {
        throw new Error("must not repoll merged PR");
      },
      () => {
        throw new Error("unexpected lookup");
      },
    );
    expect(store.getRun(id)).toMatchObject({
      status: "resolved",
      merged: true,
      mergedBy: "owner",
      mergedAt: Date.parse("2026-09-27T20:00:00Z"),
      resolution,
    });
    expect(store.getRun(target)?.resolution).toMatchObject({ kind: "superseded", ref: prUrl });
    const items = store.readFeed().items.filter((item) => item.runId === id);
    expect(items.filter((item) => item.kind === "run.merged")).toHaveLength(1);
    expect(items.filter((item) => item.kind === "run.resolved")).toHaveLength(1);
  });
}

test.each(["merged", "closed", "rejected"])(
  "stop aborts and awaits a held %s lookup without writing",
  async (outcome) => {
    needsHuman(null);
    const repo = store.getRepoBySlug("MattFlower/limitless");
    if (!repo) throw new Error("missing repo");
    const { id } = store.createRun(repo, {
      repo: repo.slug,
      prompt: "verify PR",
      source: "github",
      sourceRef: { kind: "pull_request", repo: repo.slug, number: 39 },
    });
    store.updateRun(id, { status: "needs_human", prUrl });
    const lookup = Promise.withResolvers<GitHubPrState>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const stop = startGitHubNotifier(
      store,
      async () => {},
      () => {},
      observedPrs(store, async (_url, lookupSignal) => {
        signal = lookupSignal;
        calls++;
        return lookup.promise;
      }),
    );
    // Request another pass while the startup lookup is held open.
    store.updateRun(id, { title: "pending check" });
    const before = store.getRun(id);
    const feed = store.readFeed();
    let stopped = false;
    const stopping = Promise.resolve(stop()).then(() => {
      stopped = true;
    });
    try {
      expect(signal?.aborted).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      if (outcome === "rejected") lookup.reject(new Error("aborted"));
      else
        lookup.resolve({
          url: prUrl,
          state: outcome === "merged" ? "MERGED" : "CLOSED",
          mergedAt: outcome === "merged" ? "2026-09-27T20:00:00Z" : null,
          mergedBy: null,
        });
      await stopping;
      expect(stopped).toBe(true);
      expect(calls).toBe(1);
      expect(store.getRun(id)).toEqual(before);
      expect(store.readFeed()).toEqual(feed);
    } finally {
      lookup.resolve({ url: prUrl, state: "OPEN", mergedAt: null, mergedBy: null });
      await stopping;
    }
  },
);

test("stop aborts and awaits an in-flight gh comment", async () => {
  needsHuman(null);
  const repo = store.getRepoBySlug("MattFlower/limitless");
  if (!repo) throw new Error("missing repo");
  const comment = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const stop = startGitHubNotifier(
    store,
    async (_args, commentSignal) => {
      signal = commentSignal;
      await comment.promise;
    },
    () => {},
    async () => null,
  );
  store.createRun(repo, {
    repo: repo.slug,
    prompt: "comment",
    source: "github",
    sourceRef: { kind: "issue", repo: "fake/repo", number: 1 },
  });
  let stopped = false;
  const stopping = Promise.resolve(stop()).then(() => {
    stopped = true;
  });
  try {
    expect(signal?.aborted).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    comment.resolve();
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    comment.resolve();
    await stopping;
  }
});

test("startup pass publishes a resolved run and stats count only open needs human", async () => {
  const id = needsHuman();
  needsHuman(null);
  const messages: string[] = [];
  const resolved = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run") {
      messages.push(msg.run.status);
      if (msg.run.id === id && msg.run.status === "resolved") resolved.resolve();
    }
  });
  const stop = startGitHubNotifier(
    store,
    async () => {},
    () => {},
    async () => ({ url: prUrl, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: null }),
  );
  await resolved.promise;
  await stop();
  expect(store.getRun(id)?.status).toBe("resolved");
  expect(messages).toContain("resolved");
  const totals = computeStats(store).totals;
  expect(totals.openNeedsHuman).toBe(1);
  expect(totals.openNeedsHumanRate).toBe(0.5);
  unsubscribe();
});

for (const status of ["succeeded", "needs_human"] as const) {
  test(`${status} PR merge releases dependents with metadata and preserved evidence`, async () => {
    let now = Date.now();
    const reconcile = (client: GitHubPrClient, log = () => {}) => {
      now += 900_001;
      return reconcileMergedRuns(store, client, log, () => now);
    };
    const id = needsHuman();
    store.updateRun(id, { status });
    const run = store.getRun(id);
    const repo = run && store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const dependent = store.createRun(repo, { repo: repo.slug, prompt: "next", dependsOn: [id] });
    for (const response of [
      null,
      { url: prUrl, state: "OPEN" },
      { url: `${prUrl}0`, state: "CLOSED" },
      { url: `${prUrl}0`, state: "MERGED" },
    ]) {
      await reconcileMergedRuns(
        store,
        async () => response && { ...response, mergedAt: "2026-09-27T20:00:00Z", mergedBy: null },
      );
      expect(store.getRun(dependent.id)?.status).toBe("waiting");
    }
    await reconcile(
      async () => {
        throw new Error("offline");
      },
      () => {},
    );
    expect(store.getRun(dependent.id)?.status).toBe("waiting");
    await reconcile(async () => ({
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-09-27T20:00:00Z",
      mergedBy: { login: "owner" },
    }));
    expect(store.getRun(id)).toMatchObject({
      status: status === "succeeded" ? status : "resolved",
      merged: true,
      mergedBy: "owner",
      mergedAt: Date.parse("2026-09-27T20:00:00Z"),
      error: "review required",
      finishedAt: 123456,
    });
    expect(store.getRun(dependent.id)?.status).toBe("queued");
    await reconcile(
      async () => {
        throw new Error("must not repoll merged run");
      },
      () => {
        throw new Error("unexpected lookup");
      },
    );
    expect(store.listEvents(dependent.id).filter((event) => event.type === "status")).toHaveLength(1);
  });
}

test("confirmed CLOSED PR blocks dependents, persists and applies to later creation", async () => {
  const id = needsHuman();
  store.updateRun(id, { status: "succeeded" });
  const run = store.getRun(id);
  const repo = run && store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const dependent = store.createRun(repo, { repo: repo.slug, prompt: "next", dependsOn: [id] });
  const descendant = store.createRun(repo, {
    repo: repo.slug,
    prompt: "descendant",
    dependsOn: [dependent.id],
  });
  await reconcileMergedRuns(store, async () => ({
    url: prUrl,
    state: "CLOSED",
    mergedAt: null,
    mergedBy: null,
  }));
  store.close();
  store = new Store(join(dir, "store.db"));
  const later = store.createRun(repo, { repo: repo.slug, prompt: "later", dependsOn: [id] });
  const laterDescendant = store.createRun(repo, {
    repo: repo.slug,
    prompt: "later descendant",
    dependsOn: [dependent.id],
  });
  for (const blocked of [dependent.id, descendant.id, later.id, laterDescendant.id]) {
    expect(store.getRun(blocked)).toMatchObject({
      status: "needs_human",
      startedAt: null,
      error: `Dependency ${id}: PR was closed unmerged`,
    });
  }
  await reconcileMergedRuns(store, async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: null,
  }));
  expect(store.getRun(dependent.id)?.status).toBe("needs_human");
});

test("startup polling includes succeeded PRs and never overlaps event-triggered checks", async () => {
  const id = needsHuman();
  store.updateRun(id, { status: "succeeded" });
  let calls = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = startGitHubNotifier(
    store,
    async () => {},
    () => {},
    async () => {
      calls++;
      await barrier;
      return { url: prUrl, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: null };
    },
  );
  try {
    store.updateRun(id, { title: "one" });
    store.updateRun(id, { title: "two" });
    expect(calls).toBe(1);
    release();
    for (let i = 0; i < 20 && !store.getRun(id)?.merged; i++) await Bun.sleep(5);
    expect(store.getRun(id)).toMatchObject({ status: "succeeded", merged: true });
    expect(calls).toBe(1);
  } finally {
    release();
    stop();
  }
});

test("with polling, observations reconcile runs: merged metadata, resolution, dependants and one run.merged", async () => {
  const h = pollerHarness();
  try {
    const human = h.factoryPr("o/r", 1, "needs_human");
    h.store.updateRun(human.id, { error: "review required" });
    h.store.putArtifact(human.id, "report", "markdown", "Human review required");
    const done = h.factoryPr("o/r", 2);
    const closed = h.factoryPr("o/r", 3);
    const dependant = h.store.createRun(h.repo("o/r"), { repo: "o/r", prompt: "next", dependsOn: [done.id] });
    expect(dependant.status).toBe("waiting");
    // Wired as mountIntegrations does with polling on: the notifier reads observations, never GitHub.
    const stopNotifier = startGitHubNotifier(
      h.store,
      async () => {},
      () => {},
      observedPrs(h.store),
    );
    h.start();
    await h.advance(0);
    for (const n of [1, 2]) {
      const node = h.node("o/r", n);
      node.state = "MERGED";
      node.mergedAt = "2026-10-03T05:00:00Z";
      node.mergedBy = { login: "MattFlower" };
    }
    h.node("o/r", 3).state = "CLOSED";
    await h.advance(15_000);
    await h.advance(15_000);
    stopNotifier();
    const mergedAt = Date.parse("2026-10-03T05:00:00Z");
    expect(h.store.getRun(human.id)).toMatchObject({
      status: "resolved",
      merged: true,
      mergedBy: "MattFlower",
      mergedAt,
    });
    expect(h.store.getRun(human.id)?.error).toBe("review required");
    expect(h.store.getArtifact(human.id, "report")).toBe("Human review required");
    expect(h.store.getRun(done.id)).toMatchObject({
      status: "succeeded",
      merged: true,
      mergedBy: "MattFlower",
    });
    expect(h.store.getRun(closed.id)).toMatchObject({ merged: false, prClosedUnmerged: true });
    expect(h.store.getRun(dependant.id)?.status).toBe("queued");
    const feed = h.store.readFeed({ limit: 1000 }).items;
    const mergedRuns = feed.filter((i) => i.kind === "run.merged").map((i) => i.runId);
    expect(mergedRuns.toSorted()).toEqual([human.id, done.id].toSorted());
    expect(feed.filter((i) => i.kind === "pr.merged")).toHaveLength(2);
    expect(feed.filter((i) => i.kind === "pr.closed")).toHaveLength(1);
    expect(h.gh.calls.every((c) => c.path === "graphql" || /^repos\/o\/r\/pulls\/\d$/.test(c.path))).toBe(
      true,
    );
  } finally {
    h.close();
  }
});

test("a terminal observation reconciles a run that finishes delivery later, including after a restart", async () => {
  const h = pollerHarness();
  try {
    const run = h.factoryPr("o/r", 1, "running");
    h.start();
    await h.advance(0);
    const node = h.node("o/r", 1);
    node.state = "MERGED";
    node.mergedAt = "2026-10-03T05:00:00Z";
    await h.advance(45_000);
    expect(h.store.getRun(run.id)?.merged).toBe(false);
    const calls = h.gh.calls.length;
    h.reopen();
    const stopNotifier = startGitHubNotifier(
      h.store,
      async () => {},
      () => {},
      observedPrs(h.store),
    );
    h.start();
    h.store.updateRun(run.id, { status: "succeeded" });
    for (let i = 0; i < 20 && !h.store.getRun(run.id)?.merged; i++) await Bun.sleep(1);
    stopNotifier();
    expect(h.store.getRun(run.id)).toMatchObject({
      merged: true,
      mergedAt: Date.parse("2026-10-03T05:00:00Z"),
    });
    expect(h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged")).toHaveLength(1);
    expect(h.gh.calls.length).toBe(calls);
  } finally {
    h.close();
  }
});

test("a terminal observation whose feed write fails stays retryable and reconciles only once written", async () => {
  const h = pollerHarness();
  try {
    const run = h.factoryPr("o/r", 1);
    h.start();
    await h.advance(0);
    h.store.db.exec(
      "CREATE TEMP TRIGGER boom BEFORE INSERT ON feed WHEN NEW.kind = 'pr.merged' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const node = h.node("o/r", 1);
    node.state = "MERGED";
    node.mergedAt = "2026-10-03T05:00:00Z";
    await h.advance(15_000);
    expect(h.store.getRun(run.id)?.merged).toBe(false);
    h.store.db.exec("DROP TRIGGER boom");
    await h.advance(15_000);
    const kinds = h.store.readFeed({ limit: 1000 }).items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "pr.merged" || k === "run.merged")).toEqual(["pr.merged", "run.merged"]);
    expect(h.store.getRun(run.id)?.merged).toBe(true);
  } finally {
    h.close();
  }
});

test("with polling, PRs the poller does not track are reconciled through the per-run client, once", async () => {
  const h = pollerHarness();
  try {
    // A Dependabot existing-branch verify run and a PR-verification run: neither PR is the poller's.
    const dependabot = h.store.createRun(
      h.repo("o/r"),
      {
        repo: "o/r",
        prompt: "verify",
        source: "github",
        requestedBy: "dependabot[bot]",
        baseBranch: "deps",
        deliveryBranch: "deps",
        sourceRef: {
          kind: "pull_request",
          repo: "o/r",
          number: 7,
          baseRef: "main",
          baseSha: SHA,
          headSha: SHA,
        },
      },
      true,
    );
    h.store.updateRun(dependabot.id, { prUrl: url("o/r", 7), status: "succeeded" });
    const verify = h.store.createRun(h.repo("o/r"), {
      repo: "o/r",
      prompt: "verify",
      source: "github",
      sourceRef: { kind: "pull_request", repo: "o/r", number: 8, baseRef: "main", baseSha: SHA },
    });
    h.store.updateRun(verify.id, { prUrl: url("o/r", 8), status: "needs_human" });
    // The poller's own PR has no snapshot yet and then hits an access failure: never a fallback read.
    const own = h.factoryPr("o/r", 1);
    const fallback = mock(async (prUrl: string) => ({
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-10-03T05:00:00Z",
      mergedBy: { login: "dependabot[bot]" },
    }));
    const client = observedPrs(h.store, fallback);
    await reconcileMergedRuns(h.store, client, () => {});
    expect(fallback.mock.calls.map((c) => c[0]).toSorted()).toEqual([url("o/r", 7), url("o/r", 8)]);
    const mergedAt = Date.parse("2026-10-03T05:00:00Z");
    expect(h.store.getRun(dependabot.id)).toMatchObject({
      merged: true,
      mergedBy: "dependabot[bot]",
      mergedAt,
    });
    expect(h.store.getRun(verify.id)).toMatchObject({ status: "resolved", merged: true, mergedAt });
    expect(h.store.getRun(own.id)?.merged).toBe(false);
    h.gh.deny.set("o/r", () => respond(403, { message: "SSO" }, { "x-github-sso": "required" }));
    h.start();
    await h.advance(0);
    expect(h.store.githubAccessProblems().map((p) => p.repo)).toEqual(["o/r"]);
    fallback.mockClear();
    h.reopen();
    await reconcileMergedRuns(h.store, observedPrs(h.store, fallback), () => {});
    await reconcileMergedRuns(h.store, observedPrs(h.store, fallback), () => {});
    expect(fallback).not.toHaveBeenCalled();
    const merged = h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged");
    expect(merged.map((i) => i.runId).toSorted()).toEqual([dependabot.id, verify.id].toSorted());
  } finally {
    h.close();
  }
});

test("a stale snapshot never hides an untracked PR from the fallback; a merged one is authoritative", async () => {
  const h = pollerHarness();
  try {
    // The factory run observed the PR open, then failed over 7 days ago, so the poller stopped tracking it.
    const factory = h.factoryPr("o/r", 1);
    const merged = h.factoryPr("o/r", 2);
    h.start();
    await h.advance(0);
    h.store.updateRun(factory.id, { status: "failed", finishedAt: Date.now() - 8 * 86_400_000 });
    const verify = h.store.createRun(h.repo("o/r"), {
      repo: "o/r",
      prompt: "verify",
      source: "github",
      sourceRef: { kind: "pull_request", repo: "o/r", number: 1, baseRef: "main", baseSha: SHA },
    });
    h.store.updateRun(verify.id, { prUrl: url("o/r", 1), status: "needs_human" });
    expect(JSON.parse(h.store.githubPrData(url("o/r", 1)) ?? "null")?.state).toBe("OPEN");
    expect(h.store.githubTracked().map((p) => p.url)).toEqual([url("o/r", 2)]);
    // The poller then sees its other PR merge; that observation needs no fallback read.
    const node = h.node("o/r", 2);
    node.state = "MERGED";
    node.mergedAt = "2026-10-03T04:00:00Z";
    h.store.updateRun(merged.id, { status: "needs_human" });
    await h.advance(15_000);
    h.reopen();
    const fallback = mock(async (prUrl: string) => ({
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-10-03T05:00:00Z",
      mergedBy: { login: "octocat" },
    }));
    await reconcileMergedRuns(h.store, observedPrs(h.store, fallback), () => {});
    expect(fallback.mock.calls.map((c) => c[0])).toEqual([url("o/r", 1)]);
    expect(h.store.getRun(verify.id)).toMatchObject({ merged: true, mergedBy: "octocat" });
    expect(h.store.getRun(merged.id)).toMatchObject({ merged: true, mergedAt: Date.parse(node.mergedAt) });
  } finally {
    h.close();
  }
});

test.each(["issue", "pull_request"] as const)(
  "blocks a factory %s terminal comment containing a whitespace-folded private phrase",
  async (kind) => {
    const phrase = ["PR:", "none", "Cost:"].join(" ");
    writeFileSync(join(dir, "private-strings.txt"), phrase);
    const calls: string[][] = [];
    const logs: string[] = [];
    const stop = startGitHubNotifier(
      store,
      async (args) => {
        calls.push(args);
      },
      (message) => logs.push(message),
      async () => null,
      dir,
    );
    try {
      const repo = store.upsertRepo({
        slug: "fake/repo",
        kind: "github",
        url: "unused",
        localPath: null,
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const run = store.createRun(repo, {
        repo: repo.slug,
        prompt: "fix",
        source: "github",
        sourceRef: { kind, repo: repo.slug, number: 1 },
      });
      expect(calls.map((args) => args.at(-1))).toEqual([`Limitless run created: ${run.id}`]);
      calls.length = 0;
      store.updateRun(run.id, { status: "failed" });
      expect(calls).toEqual([]);
      expect(logs).toEqual(["Factory comment blocked by private-string policy"]);
    } finally {
      await stop();
    }
  },
);

for (const kind of ["issue", "pull_request"] as const) {
  test.each([
    "matching",
    "encoded",
    "malformed",
    "unreadable",
    "absent",
    "clean",
    "repository-config",
    "worktree-config",
    "cache-config",
  ])(`private factory ${kind} comment: %s`, async (scenario) => {
    const calls: string[][] = [];
    const file = join(dir, "private-strings.txt");
    if (scenario === "unreadable") mkdirSync(file);
    else if (scenario !== "absent")
      writeFileSync(file, scenario === "malformed" ? Buffer.from([0xff]) : "secret-host.example");
    const invocationDir = process.cwd();
    process.chdir(dir);
    const stop = startGitHubNotifier(
      store,
      async (args) => {
        calls.push(args);
      },
      () => {},
      async () => null,
      dir,
      scenario === "cache-config" ? [dir] : [],
    );
    try {
      const repo = store.upsertRepo({
        slug: "fake/repo",
        kind: "github",
        url: "unused",
        localPath: scenario === "repository-config" ? dir : null,
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const run = store.createRun(repo, {
        repo: repo.slug,
        prompt: "fix",
        source: "github",
        sourceRef: { kind, repo: repo.slug, number: 1 },
      });
      if (scenario === "worktree-config") store.setRunState(run.id, { worktreePath: dir });
      calls.length = 0;
      store.updateRun(run.id, {
        status: "succeeded",
        prUrl:
          scenario === "encoded"
            ? "https://%73ecret-host.example/pr/1"
            : scenario === "matching"
              ? "https://secret-host.example/pr/1"
              : undefined,
      });
      await Bun.sleep(0);
      expect(calls).toHaveLength(["clean", "absent"].includes(scenario) ? 1 : 0);
    } finally {
      stop();
      process.chdir(invocationDir);
    }
  });
}

test("each reconciliation pass looks up tracking once, caps calls, and progresses fairly with shared PRs", async () => {
  const h = pollerHarness();
  try {
    const count = RECONCILE_REQUEST_CAP + 8;
    for (let i = 1; i <= count; i++) h.factoryPr("o/r", i, "needs_human");
    const runs = h.store.listRuns().sort((a, b) => a.id.localeCompare(b.id));
    const firstRun = runs[0];
    const lastRun = runs.at(-1);
    if (!firstRun?.prUrl || !lastRun) throw new Error("missing factory PR");
    h.store.updateRun(lastRun.id, { prUrl: firstRun.prUrl });
    let lookups = 0;
    const tracked = h.store.githubTracked.bind(h.store);
    h.store.githubTracked = () => {
      lookups++;
      return tracked();
    };
    const observed = observedPrs(h.store, async () => {
      throw new Error("tracked PR fallback");
    });
    const checked: string[] = [];
    const client: GitHubPrClient = async (url) => {
      checked.push(url);
      return observed(url);
    };
    client.beginPass = observed.beginPass;
    client.observed = observed.observed;
    await reconcileMergedRuns(h.store, client);
    expect(lookups).toBe(1);
    expect(checked).toHaveLength(RECONCILE_REQUEST_CAP);
    const first = checked.slice();
    checked.length = 0;
    await reconcileMergedRuns(h.store, client);
    expect(lookups).toBe(2);
    expect(checked).toHaveLength(RECONCILE_REQUEST_CAP);
    expect(new Set([...first, ...checked]).size).toBe(count - 1);
  } finally {
    h.close();
  }
});

test.each(["throw", "null"])("repeated %s lookups back off while later runs progress", async (failure) => {
  const h = pollerHarness();
  try {
    const bad = h.factoryPr("o/r", 1, "needs_human");
    h.factoryPr("o/r", 1, "needs_human"); // a shared PR is still attempted only once per pass
    const good = h.factoryPr("o/r", 2, "needs_human");
    let now = Date.now();
    const calls: string[] = [];
    const client: GitHubPrClient = async (url) => {
      calls.push(url);
      if (url === bad.prUrl || url.endsWith("/1")) {
        if (failure === "throw") throw new Error("inaccessible");
        return null;
      }
      return { url, state: "OPEN", mergedAt: null, mergedBy: null };
    };
    const reconcile = () =>
      reconcileMergedRuns(
        h.store,
        client,
        () => {},
        () => now,
      );
    await reconcile();
    expect(calls.filter((u) => u.endsWith("/1"))).toHaveLength(1);
    await reconcile();
    expect(calls.filter((u) => u.endsWith("/1"))).toHaveLength(2);
    calls.length = 0;
    await reconcile();
    expect(calls).toEqual([url("o/r", 2)]);
    now += 60_000;
    await reconcile();
    expect(calls.filter((u) => u.endsWith("/1"))).toHaveLength(1);
    calls.length = 0;
    now += 60_000;
    await reconcile();
    expect(calls).toEqual([url("o/r", 2)]);
    expect(h.store.getRun(good.id)?.status).toBe("needs_human");
  } finally {
    h.close();
  }
});

test("fallback observations expire closed PRs without poller snapshots and a reopen clears expiry", async () => {
  const id = needsHuman();
  const now = Date.now();
  const closed = mock(async (url: string) => ({ url, state: "CLOSED", mergedAt: null, mergedBy: null }));
  await reconcileMergedRuns(
    store,
    closed,
    () => {},
    () => now,
  );
  expect(store.getRun(id)?.prClosedUnmerged).toBe(true);
  await reconcileMergedRuns(
    store,
    closed,
    () => {},
    () => now + 604800000,
  );
  expect(closed).toHaveBeenCalledTimes(2);
  await reconcileMergedRuns(
    store,
    closed,
    () => {},
    () => now + 604800001,
  );
  expect(closed).toHaveBeenCalledTimes(2);
  const reopened = mock(async (url: string) => ({ url, state: "OPEN", mergedAt: null, mergedBy: null }));
  await reconcileMergedRuns(
    store,
    reopened,
    () => {},
    () => now + 604800001,
  );
  expect(reopened).toHaveBeenCalledTimes(0);
  await reconcileMergedRuns(
    store,
    reopened,
    () => {},
    () => now + 604800000 + 86_400_000,
  );
  expect(reopened).toHaveBeenCalledTimes(1);
  expect(store.githubPrExpired(prUrl, now + 604800000 + 86_400_000)).toBe(false);
  expect(store.getRun(id)?.prClosedUnmerged).toBe(false);
  expect(store.githubTracked(now + 604800000 + 86_400_000).map((pr) => pr.url)).toContain(prUrl);
});

test.each(["cancelled", "failed"] as const)(
  "an expired %s factory PR gets a daily probe and is tracked again on reopen",
  async (status) => {
    const h = pollerHarness();
    try {
      const day = 86_400_000;
      let now = Date.now();
      const run = h.factoryPr("o/r", 1, status);
      const prUrl = url("o/r", 1);
      h.store.observeGithubPrState(prUrl, "CLOSED", now - 8 * day);
      h.store.updateRun(run.id, { finishedAt: now - 8 * day, prClosedUnmerged: true });
      h.store.db
        .query("INSERT INTO github_prs (url, data) VALUES (?, ?)")
        .run(prUrl, JSON.stringify({ state: "CLOSED" }));
      const client = mock(async (url: string) => ({
        url,
        state: "OPEN",
        mergedAt: null,
        mergedBy: null,
      }));
      const reconcile = () =>
        reconcileMergedRuns(
          h.store,
          client,
          () => {},
          () => now,
        );
      expect(h.store.githubPrExpired(prUrl, now)).toBe(true);
      expect(h.store.githubTracked(now).map((pr) => pr.url)).not.toContain(prUrl);
      await reconcile();
      expect(client).not.toHaveBeenCalled();
      now += day - 1;
      await reconcile();
      expect(client).not.toHaveBeenCalled();
      now++;
      await reconcile();
      expect(client.mock.calls.map((c) => c[0])).toEqual([prUrl]);
      expect(JSON.parse(h.store.githubPrData(prUrl) ?? "null")?.state).toBe("OPEN");
      expect(h.store.githubPrExpired(prUrl, now)).toBe(false);
      expect(h.store.getRun(run.id)).toMatchObject({ status, prClosedUnmerged: false });
      expect(h.store.githubTracked(now).map((pr) => pr.url)).toContain(prUrl);
    } finally {
      h.close();
    }
  },
);

test("polling probes a cancelled expired PR freshly within two capped passes under healthy load", async () => {
  const h = pollerHarness();
  try {
    const day = 86_400_000;
    let now = Date.now();
    const run = h.factoryPr("o/r", 1, "cancelled");
    const expired = url("o/r", 1);
    h.store.observeGithubPrState(expired, "CLOSED", now - 8 * day);
    h.store.updateRun(run.id, { finishedAt: now - 8 * day, prClosedUnmerged: true });
    h.store.db
      .query("INSERT INTO github_prs (url, data) VALUES (?, ?)")
      .run(expired, JSON.stringify({ ...h.node("o/r", 1), state: "CLOSED" }));
    for (let i = 2; i <= 31; i++) h.factoryPr("o/r", i);
    const fresh = mock(async (url: string) => ({
      url,
      state: "OPEN",
      mergedAt: null,
      mergedBy: null,
    }));
    let calls: string[] = [];
    const counted = (observed: GitHubPrClient): GitHubPrClient => {
      const client: GitHubPrClient = async (...args) => {
        calls.push(args[0]);
        return observed(...args);
      };
      client.beginPass = observed.beginPass;
      client.observed = observed.observed;
      client.fresh = observed.fresh ? counted(observed.fresh) : observed.fresh;
      return client;
    };
    const client = counted(observedPrs(h.store, fresh));
    const reconcile = () =>
      reconcileMergedRuns(
        h.store,
        client,
        () => {},
        () => now,
      );
    await reconcile();
    expect(calls).toHaveLength(RECONCILE_REQUEST_CAP);
    expect(fresh).not.toHaveBeenCalled();
    now += day;
    calls = [];
    await reconcileMergedRuns(
      h.store,
      counted(observedPrs(h.store)),
      () => {},
      () => now,
    );
    expect(calls).toHaveLength(RECONCILE_REQUEST_CAP);
    expect(calls).not.toContain(expired);
    expect(fresh).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      calls = [];
      await reconcile();
      expect(calls).toHaveLength(RECONCILE_REQUEST_CAP);
      expect(new Set(calls).size).toBe(calls.length);
      if (i === 0) expect(calls).toContain(expired);
    }
    expect(fresh.mock.calls.map((c) => c[0])).toEqual([expired]);
    expect(h.store.githubPrExpired(expired, now)).toBe(false);
    expect(h.store.getRun(run.id)).toMatchObject({ status: "cancelled", prClosedUnmerged: false });
    expect(h.store.githubTracked(now).map((pr) => pr.url)).toContain(expired);
  } finally {
    h.close();
  }
});

test.each(["throw", "null", "mismatch"])(
  "polling leaves expired probes due after %s or cache-only reads, backs off, and clocks fresh success",
  async (failure) => {
    const h = pollerHarness();
    try {
      const day = 86_400_000;
      let now = Date.now();
      const expired = url("o/r", 1);
      h.factoryPr("o/r", 1, "cancelled");
      h.store.observeGithubPrState(expired, "CLOSED", now - 8 * day);
      h.store.db
        .query("INSERT INTO github_prs (url, data) VALUES (?, ?)")
        .run(expired, JSON.stringify({ ...h.node("o/r", 1), state: "CLOSED" }));
      let answer: typeof failure | "CLOSED" = failure;
      const fresh = mock(async (url: string) => {
        if (answer === "throw") throw new Error("offline");
        if (answer === "null") return null;
        return {
          url: answer === "mismatch" ? `${url}0` : url,
          state: "CLOSED",
          mergedAt: null,
          mergedBy: null,
        };
      });
      const client = observedPrs(h.store, fresh);
      const reconcile = (prClient = client) =>
        reconcileMergedRuns(
          h.store,
          prClient,
          () => {},
          () => now,
        );
      await reconcile();
      expect(fresh).not.toHaveBeenCalled();
      now += day;
      await reconcile();
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(h.store.githubPrExpired(expired, now)).toBe(true);
      await reconcile();
      expect(fresh).toHaveBeenCalledTimes(2);
      await reconcile();
      now += 59_999;
      await reconcile();
      expect(fresh).toHaveBeenCalledTimes(2);
      now++;
      await reconcile(observedPrs(h.store)); // A matching cached CLOSED snapshot cannot spend the probe.
      expect(h.store.githubPrExpired(expired, now)).toBe(true);
      answer = "CLOSED";
      await reconcile();
      expect(fresh).toHaveBeenCalledTimes(3);
      now += day - 1;
      await reconcile();
      expect(fresh).toHaveBeenCalledTimes(3);
      now++;
      await reconcile();
      expect(fresh).toHaveBeenCalledTimes(4);
      expect(fresh.mock.calls.every(([url]) => url === expired)).toBe(true);
    } finally {
      h.close();
    }
  },
);

test.each(["CLOSED", "throw"])(
  "overdue probes returning %s get a slot under healthy load and respect daily or retry clocks",
  async (answer) => {
    const h = pollerHarness();
    try {
      const day = 86_400_000;
      let now = Date.now();
      h.factoryPr("o/r", 1);
      const overdue = url("o/r", 1);
      h.store.observeGithubPrState(overdue, "CLOSED", now - 8 * day);
      for (let i = 2; i <= 31; i++) h.factoryPr("o/r", i);
      let calls: string[] = [];
      let unavailable = answer === "throw";
      const client: GitHubPrClient = async (url) => {
        calls.push(url);
        if (url === overdue && unavailable) throw new Error("offline");
        return { url, state: url === overdue ? "CLOSED" : "OPEN", mergedAt: null, mergedBy: null };
      };
      const reconcile = () =>
        reconcileMergedRuns(
          h.store,
          client,
          () => {},
          () => now,
        );
      await reconcile(); // Start the existing daily clock for the expired PR.
      expect(calls).not.toContain(overdue);
      expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
      now += day;
      const passes: string[][] = [];
      for (let i = 0; i < 2; i++) {
        calls = [];
        await reconcile();
        passes.push(calls);
        expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
        expect(new Set(calls).size).toBe(calls.length);
      }
      expect(passes.flat().filter((url) => url === overdue)).toEqual(
        answer === "throw" ? [overdue, overdue] : [overdue],
      );
      if (unavailable) {
        calls = [];
        await reconcile();
        expect(calls).not.toContain(overdue);
        expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
        now += 59_999;
        calls = [];
        await reconcile();
        expect(calls).not.toContain(overdue);
        expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
        now++;
        unavailable = false;
        calls = [];
        await reconcile();
        expect(calls.filter((url) => url === overdue)).toEqual([overdue]);
        expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
      }
      calls = [];
      now += day - 1;
      await reconcile();
      expect(calls).not.toContain(overdue);
      expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
      calls = [];
      now++;
      await reconcile();
      expect(calls.filter((url) => url === overdue)).toEqual([overdue]);
      expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
    } finally {
      h.close();
    }
  },
);

test("overdue probes rotate through a backlog larger than the cap under healthy load", async () => {
  const h = pollerHarness();
  try {
    const day = 86_400_000;
    let now = Date.now();
    const overdue = Array.from({ length: RECONCILE_REQUEST_CAP + 2 }, (_, i) => {
      h.factoryPr("o/r", i + 1);
      const prUrl = url("o/r", i + 1);
      h.store.observeGithubPrState(prUrl, "CLOSED", now - 8 * day);
      return prUrl;
    });
    for (let i = 100; i < 130; i++) h.factoryPr("o/r", i);
    let calls: string[] = [];
    const client: GitHubPrClient = async (url) => {
      calls.push(url);
      return { url, state: overdue.includes(url) ? "CLOSED" : "OPEN", mergedAt: null, mergedBy: null };
    };
    const reconcile = () =>
      reconcileMergedRuns(
        h.store,
        client,
        () => {},
        () => now,
      );
    await reconcile();
    now += day;
    const probed: string[] = [];
    const healthy = new Set<string>();
    for (let i = 0; i < overdue.length; i++) {
      calls = [];
      await reconcile();
      expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
      expect(new Set(calls).size).toBe(calls.length);
      const daily = calls.filter((url) => overdue.includes(url));
      expect(daily).toHaveLength(1);
      probed.push(...daily);
      for (const url of calls.filter((url) => !overdue.includes(url))) healthy.add(url);
    }
    expect(probed.toSorted()).toEqual(overdue.toSorted());
    expect(healthy.size).toBe(30);
  } finally {
    h.close();
  }
});

test.each(["CLOSED", "OPEN", "throw"])(
  "expired probes returning %s wait a day, follow healthy PRs, share the cap, and back off failures",
  async (answer) => {
    const h = pollerHarness();
    try {
      const day = 86_400_000;
      let now = Date.now();
      const expired = Array.from({ length: RECONCILE_REQUEST_CAP + 2 }, (_, i) => {
        h.factoryPr("o/r", i + 1, "succeeded");
        const prUrl = url("o/r", i + 1);
        h.store.observeGithubPrState(prUrl, "CLOSED", now - 8 * day);
        return prUrl;
      });
      const shared = h.factoryPr("o/r", 1, "needs_human");
      h.factoryPr("o/r", 100, "succeeded");
      const healthy = url("o/r", 100);
      const calls: string[] = [];
      const client: GitHubPrClient = async (url) => {
        calls.push(url);
        if (url !== healthy && answer === "throw") throw new Error("offline");
        return { url, state: url === healthy ? "OPEN" : answer, mergedAt: null, mergedBy: null };
      };
      const reconcile = () =>
        reconcileMergedRuns(
          h.store,
          client,
          () => {},
          () => now,
        );
      await reconcile();
      expect(calls).toEqual([healthy]);
      calls.length = 0;
      now += day - 1;
      await reconcile();
      expect(calls).toEqual([healthy]);
      calls.length = 0;
      now++;
      await reconcile();
      expect(calls[0]).toBe(healthy);
      expect(calls).toHaveLength(RECONCILE_REQUEST_CAP);
      const probed = calls.slice(1);
      calls.length = 0;
      await reconcile();
      const slowCalls = calls.filter((url) => url !== healthy);
      if (answer === "OPEN") {
        expect(h.store.githubTracked(now).map((pr) => pr.url)).toEqual(expect.arrayContaining(probed));
      } else if (answer === "throw") {
        expect(slowCalls).toEqual(probed);
        const remaining = expired.filter((url) => !probed.includes(url));
        for (let i = 0; i < 2; i++) {
          calls.length = 0;
          await reconcile();
          expect(calls[0]).toBe(healthy);
          expect(calls.slice(1).toSorted()).toEqual(remaining.toSorted());
          expect(calls.length).toBeLessThanOrEqual(RECONCILE_REQUEST_CAP);
          expect(new Set(calls).size).toBe(calls.length);
        }
        calls.length = 0;
        await reconcile();
        expect(calls).toEqual([healthy]);
        now += 60_000;
        calls.length = 0;
        await reconcile();
        expect(calls[0]).toBe(healthy);
        expect(calls).toHaveLength(RECONCILE_REQUEST_CAP);
        expect(calls.slice(1)).toEqual(probed);
      } else {
        expect(slowCalls).toHaveLength(expired.length - probed.length);
        expect(slowCalls.every((url) => !probed.includes(url))).toBe(true);
        calls.length = 0;
        await reconcile();
        expect(calls).toEqual([healthy]);
        if (answer === "CLOSED")
          expect(h.store.getRun(shared.id)).toMatchObject({ status: "resolved", prClosedUnmerged: true });
      }
    } finally {
      h.close();
    }
  },
);

test("expiry timestamps retain the first close, clear on open, and restart on a later close", () => {
  const clock = (url: string) =>
    store.db.query("SELECT closed_at, reopened_at FROM github_pr_expiry WHERE url = ?").get(url);
  store.observeGithubPrState(prUrl, "CLOSED", 10);
  expect(clock(prUrl)).toEqual({ closed_at: 10, reopened_at: null });
  store.observeGithubPrState(prUrl, "CLOSED", 20);
  expect(clock(prUrl)).toEqual({ closed_at: 10, reopened_at: null });
  store.db
    .query("INSERT INTO github_prs (url, data) VALUES (?, ?)")
    .run(prUrl, JSON.stringify({ state: "CLOSED" }));
  store.db.exec(
    "CREATE TEMP TRIGGER boom BEFORE UPDATE ON github_prs BEGIN SELECT RAISE(ABORT, 'boom'); END",
  );
  expect(() => store.observeGithubPrState(prUrl, "OPEN", 30)).toThrow("boom");
  expect(clock(prUrl)).toEqual({ closed_at: 10, reopened_at: null });
  store.db.exec("DROP TRIGGER boom");
  store.observeGithubPrState(prUrl, "OPEN", 30);
  expect(clock(prUrl)).toEqual({ closed_at: null, reopened_at: 30 });
  store.observeGithubPrState(prUrl, "OPEN", 40);
  expect(clock(prUrl)).toEqual({ closed_at: null, reopened_at: 30 });
  store.observeGithubPrState(prUrl, "CLOSED", 50);
  expect(clock(prUrl)).toEqual({ closed_at: 50, reopened_at: 30 });
});

test("inaccessible expired PRs rotate with the others instead of holding the reserved probe", async () => {
  const h = pollerHarness();
  const day = 86_400_000;
  let now = Date.now();
  try {
    const expired = new Set<string>();
    const inaccessible = new Set([1, 2, 3].map((n) => url("o/r", n)));
    // 6 expired (3 always failing) behind 30 healthy PRs: only the reserved slot reaches them.
    for (let i = 1; i <= 36; i++) {
      const run = h.factoryPr("o/r", i, i <= 6 ? "cancelled" : "succeeded");
      h.store.db.query("UPDATE runs SET id = ? WHERE id = ?").run(String(i).padStart(6, "0"), run.id);
      if (i > 6) continue;
      expired.add(url("o/r", i));
      h.store.observeGithubPrState(url("o/r", i), "CLOSED", now - 8 * day);
      h.store.db
        .query("INSERT INTO github_prs (url, data) VALUES (?, ?)")
        .run(url("o/r", i), JSON.stringify({ ...h.node("o/r", i), state: "CLOSED" }));
    }
    const probed = new Set<string>();
    const fresh: GitHubPrClient = async (u: string) => {
      if (expired.has(u)) probed.add(u);
      if (inaccessible.has(u)) throw new Error("access denied");
      return { url: u, state: "OPEN", mergedAt: null, mergedBy: null };
    };
    const client = observedPrs(h.store, fresh);
    const pass = () =>
      reconcileMergedRuns(
        h.store,
        client,
        () => {},
        () => now,
      );
    await pass();
    now += day;
    // Two hours of passes five minutes apart, past the failing PRs' 15-minute backoff ceiling.
    for (let i = 0; i < 24; i++) {
      await pass();
      now += 300_000;
    }
    expect([...probed].sort()).toEqual([...expired].sort());
    for (const u of expired) expect(h.store.githubPrExpired(u, now)).toBe(inaccessible.has(u));
  } finally {
    h.close();
  }
});

test.each(["issue", "pull_request"] as const)(
  "discreet %s runs emit no creation or completion comment",
  async (kind) => {
    const cfg = loadConfig({
      home: join(dir, "data"),
      configDir: join(dir, "cfg"),
      raw: { repos: { "test/repo": { discreet: true } } },
    });
    const calls: string[][] = [];
    const stop = startGitHubNotifier(
      store,
      async (args) => {
        calls.push(args);
      },
      () => {},
      async () => null,
      cfg.paths.configDir,
      [],
      cfg,
    );
    try {
      const repo = store.upsertRepo({
        slug: "test/repo",
        kind: "github",
        url: "unused",
        localPath: null,
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const run = store.createRun(repo, {
        repo: repo.slug,
        prompt: "fix",
        source: "github",
        sourceRef: { kind, repo: repo.slug, number: 12 },
      });
      store.updateRun(run.id, { status: "running" });
      store.updateRun(run.id, { status: "succeeded" });
    } finally {
      await stop();
    }
    expect(calls).toHaveLength(0);
  },
);
