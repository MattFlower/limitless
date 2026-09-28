import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import {
  type GitHubPrClient,
  reconcileMergedRuns,
  startGitHubNotifier,
} from "../src/integrations/github-notifier.ts";

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
  store.close();
  store = new Store(join(dir, "store.db"));
  expect(store.getRun(id)?.mergedBy).toBe("MattFlower");
  expect(store.listEvents(id).filter((event) => event.type === "status")).toHaveLength(2);
});

test("only an exact merged PR resolves; failures remain retryable", async () => {
  const id = needsHuman();
  const noPr = needsHuman(null);
  let calls = 0;
  for (const state of [
    { url: prUrl, state: "OPEN", mergedAt: null, mergedBy: null },
    { url: prUrl, state: "CLOSED", mergedAt: null, mergedBy: null },
    {
      url: "https://github.com/MattFlower/limitless/pull/40",
      state: "MERGED",
      mergedAt: "2026-09-27T20:00:00Z",
      mergedBy: null,
    },
    null,
  ]) {
    await reconcileMergedRuns(store, async () => {
      calls++;
      return state;
    });
    expect(store.getRun(id)?.status).toBe("needs_human");
  }
  await reconcileMergedRuns(
    store,
    async () => {
      calls++;
      throw new Error("offline");
    },
    () => {},
  );
  expect(store.getRun(id)?.status).toBe("needs_human");
  expect(store.getRun(noPr)?.status).toBe("needs_human");
  expect(calls).toBe(5);
  await reconcileMergedRuns(store, async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: null,
  }));
  expect(store.getRun(id)?.status).toBe("resolved");
  expect(store.getRun(id)?.mergedBy).toBeNull();
});

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
