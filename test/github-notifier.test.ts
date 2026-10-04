import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import {
  type GitHubPrClient,
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
  const older = store.createRun(repo, { repo: repo.slug, prompt: "First try. Closes #12" });
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

test("startup pass publishes a resolved run and stats count only open needs human", async () => {
  const id = needsHuman();
  needsHuman(null);
  const messages: string[] = [];
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run") messages.push(msg.run.status);
  });
  const stop = startGitHubNotifier(
    store,
    async () => {},
    () => {},
    async () => ({ url: prUrl, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: null }),
  );
  for (let i = 0; i < 20 && store.getRun(id)?.status !== "resolved"; i++) await Bun.sleep(5);
  expect(store.getRun(id)?.status).toBe("resolved");
  expect(messages).toContain("resolved");
  const totals = computeStats(store).totals;
  expect(totals.openNeedsHuman).toBe(1);
  expect(totals.openNeedsHumanRate).toBe(0.5);
  stop();
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

test.each(["CLOSED", "OPEN", "throw"])(
  "expired probes returning %s wait a day, follow healthy PRs, and share the cap",
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
