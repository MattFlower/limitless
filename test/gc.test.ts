import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { type RunStatus, TERMINAL_STATUSES } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { collectGarbage, type GcResult } from "../src/gc.ts";
import { recordWorktree, worktreeGit } from "../src/git/command.ts";
import {
  cachePath,
  commitAll,
  createWorktree,
  headSha,
  iterationRefs,
  removeWorktree,
} from "../src/git/repos.ts";
import { startHttp } from "../src/server/http.ts";
import { sh } from "../src/util/proc.ts";
import { testWaits } from "./wait-support.ts";

const waits = testWaits();

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

const DAY = 86_400_000;
const now = 2_000_000_000_000;
let root: string;
let cfg: Config;
let store: Store;
let repoDir: string;
let repo: ReturnType<Store["upsertRepo"]>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "limitless-gc-"));
  cfg = loadConfig({ home: join(root, "data"), configDir: join(root, "config"), port: 0 });
  store = new Store(cfg.paths.db);
  repoDir = join(root, "local");
  mkdirSync(repoDir);
  await sh(["git", "init", "-q"], { cwd: repoDir });
  await sh(["git", "config", "user.email", "gc@example.test"], { cwd: repoDir });
  await sh(["git", "config", "user.name", "GC Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "base.txt"), "base");
  await sh(["git", "add", "base.txt"], { cwd: repoDir });
  await sh(["git", "commit", "-qm", "base"], { cwd: repoDir });
  repo = store.upsertRepo({
    slug: "local/test",
    kind: "local",
    url: null,
    localPath: repoDir,
    defaultBranch: (await sh(["git", "branch", "--show-current"], { cwd: repoDir })).stdout.trim(),
    mergePolicy: "none",
  });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function run(status: RunStatus, ageDays: number, withFinish = true) {
  const record = store.createRun(repo, { prompt: status, repo: repo.slug });
  // A resolved run here was resolved by hand from failed, keeping its original finishedAt.
  const actual = status === "resolved" ? "failed" : status;
  store.updateRun(record.id, { status: actual, finishedAt: withFinish ? now - ageDays * DAY : null });
  if (status === "resolved") store.resolveRun(record.id, { kind: "wont_do", by: "human" });
  return record;
}

async function worktree(id: string): Promise<string> {
  return (await createWorktree(cfg.paths, repo, id, id, repo.defaultBranch)).path;
}

async function listed(): Promise<string> {
  return (await sh(["git", "worktree", "list", "--porcelain"], { cwd: cachePath(cfg.paths, repo) })).stdout;
}

test("cancelling a parked run cleans its iteration refs without waiting for GC", async () => {
  const record = run("queued", 0, false);
  const cwd = await worktree(record.id);
  const base = await headSha(cwd);
  writeFileSync(join(cwd, "iteration.txt"), "first\n");
  await commitAll(cwd, "first");
  writeFileSync(join(cwd, "iteration.txt"), "second\n");
  await commitAll(cwd, "second", { boundary: base, runId: record.id });
  store.setRunState(record.id, { parked: true });
  const factory = new Factory(cfg, { store, providers: [] });
  try {
    expect(factory.cancelRun(record.id)).toBe(true);
    expect(store.getRun(record.id)?.status).toBe("cancelled");
    await waits.until(async () => (await iterationRefs(cwd, record.id)).length === 0, { timeoutMs: 10_000 });
    expect(factory.cancelRun(record.id)).toBe(false);
  } finally {
    await factory.stop();
  }
});

test.each(["cache", "legacy", "linked"])(
  "terminal refs in %s are cleaned without a worktree",
  async (owner) => {
    const statuses: RunStatus[] = [...TERMINAL_STATUSES, "queued", "running", "waiting", "waiting_input"];
    const records = [];
    const legacy = owner !== "cache";
    if (owner === "linked") {
      // A registered source that is itself a linked worktree has no factory sidecar.
      const source = join(root, "linked-source");
      await sh(["git", "worktree", "add", "-q", "-b", "linked-source", source], { cwd: repoDir });
      const { id: _, createdAt: __, ...registration } = repo;
      repo = store.upsertRepo({ ...registration, slug: "local/linked", localPath: source });
    }
    for (const status of statuses) {
      const record = run(status, 0, status !== "failed");
      const cwd = legacy ? join(cfg.paths.work, record.id) : await worktree(record.id);
      if (legacy) {
        await sh(["git", "worktree", "add", "-b", record.id, cwd], { cwd: repo.localPath ?? repoDir });
        await recordWorktree(cwd);
      }
      const base = await headSha(cwd);
      writeFileSync(join(cwd, "iteration.txt"), "first\n");
      await commitAll(cwd, "first");
      const previous = await headSha(cwd);
      writeFileSync(join(cwd, "iteration.txt"), "second\n");
      await commitAll(cwd, "second", { boundary: base, runId: record.id });
      if (status === "queued") store.setRunState(record.id, { parked: true });
      await removeWorktree(cfg.paths, repo, cwd);
      records.push({ ...record, status, previous });
    }
    const cache = legacy ? repoDir : cachePath(cfg.paths, repo);
    await worktreeGit(
      ["git", "update-ref", "refs/limitless/iterations/unrelated/keep", records[0]?.previous ?? ""],
      { cwd: cache },
    );
    await collectGarbage(store, cfg, { now, dryRun: true });
    for (const record of records) expect(await iterationRefs(cache, record.id)).toHaveLength(1);
    for (let pass = 0; pass < 2; pass++) {
      expect((await collectGarbage(store, cfg, { now })).errors).toEqual([]);
      for (const record of records) {
        expect(await iterationRefs(cache, record.id)).toHaveLength(
          TERMINAL_STATUSES.includes(record.status) ? 0 : 1,
        );
        if (!TERMINAL_STATUSES.includes(record.status))
          expect((await sh(["git", "cat-file", "-e", record.previous], { cwd: cache })).exitCode).toBe(0);
      }
      expect(await iterationRefs(cache, "unrelated")).toHaveLength(1);
    }
  },
);

test("terminal worktrees use exact 3/7 day boundaries and preserve nonterminal worktrees", async () => {
  const cases: [RunStatus, number, boolean][] = [
    ["succeeded", 3, true],
    ["cancelled", 3, true],
    ["failed", 7, true],
    ["needs_human", 7, true],
    ["resolved", 3, true],
    ["succeeded", 3 - 1 / DAY, false],
    ["resolved", 3 - 1 / DAY, false],
    ["failed", 7 - 1 / DAY, false],
    ["needs_human", 7 - 1 / DAY, false],
    ["queued", 99, false],
    ["running", 99, false],
    ["waiting_input", 99, false],
  ];
  const paths = await Promise.all(cases.map(async ([status, age]) => worktree(run(status, age).id)));
  const absent = run("failed", 8);
  const missing = await worktree(absent.id);
  rmSync(missing, { recursive: true, force: true });
  const dry = await collectGarbage(store, cfg, { now, dryRun: true });
  expect(dry.worktrees.toSorted()).toEqual(paths.filter((_, i) => cases[i]?.[2]).toSorted());
  const result = await collectGarbage(store, cfg, { now });
  expect(result.errors).toEqual([]);
  const gitList = await listed();
  for (const [i, [, , removed]] of cases.entries()) {
    expect(existsSync(paths[i] as string)).toBe(!removed);
    expect(existsSync(`${paths[i]}.git-paths`)).toBe(!removed);
    expect(gitList.includes(paths[i] as string)).toBe(!removed);
  }
  expect(gitList).not.toContain(missing);
  expect(existsSync(`${missing}.git-paths`)).toBe(false);
  expect(result.worktrees).toHaveLength(5);
});

test("cleanup removes legacy and cloned worktrees through their owners and prunes both", async () => {
  const legacyRun = run("succeeded", 4);
  const legacy = join(cfg.paths.work, legacyRun.id);
  await sh(["git", "worktree", "add", "-b", "legacy", legacy], { cwd: repoDir });
  await recordWorktree(legacy);
  const staleRun = run("succeeded", 4);
  const stale = join(cfg.paths.work, staleRun.id);
  await sh(["git", "worktree", "add", "-b", "legacy-stale", stale], { cwd: repoDir });
  rmSync(stale, { recursive: true, force: true });
  const cloned = await worktree(run("succeeded", 4).id);
  const active = await worktree(run("running", 10).id);
  const result = await collectGarbage(store, cfg, { now });
  expect(result.errors).toEqual([]);
  expect(result.worktrees.sort()).toEqual([legacy, cloned].sort());
  expect(result.metadata).toHaveLength(1);
  const source = (await sh(["git", "worktree", "list", "--porcelain"], { cwd: repoDir })).stdout;
  expect(source).not.toContain(legacy);
  expect(source).not.toContain(stale);
  expect(await listed()).not.toContain(cloned);
  expect(await listed()).toContain(active);
});

test("cleanup for new runs leaves unrelated source worktree metadata untouched", async () => {
  const outside = join(root, "user-worktree");
  await sh(["git", "worktree", "add", "--detach", outside], { cwd: repoDir });
  rmSync(outside, { recursive: true, force: true });
  const before = (await sh(["git", "worktree", "list", "--porcelain"], { cwd: repoDir })).stdout;
  await worktree(run("succeeded", 4).id);
  const result = await collectGarbage(store, cfg, { now });
  expect(result.errors).toEqual([]);
  expect((await sh(["git", "worktree", "list", "--porcelain"], { cwd: repoDir })).stdout).toBe(before);
});

test("cleanup refuses a run path that is a worktree of an unrelated repository", async () => {
  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated);
  await sh(["git", "init", "-q"], { cwd: unrelated });
  await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: unrelated,
  });
  const stray = join(cfg.paths.work, run("succeeded", 4).id);
  await sh(["git", "worktree", "add", "--detach", stray], { cwd: unrelated });
  await recordWorktree(stray);
  writeFileSync(join(stray, "uncommitted.txt"), "keep me");
  const result = await collectGarbage(store, cfg, { now });
  expect(result.errors.join("\n")).toContain("worktree is not registered to local/test");
  expect(result.worktrees).toEqual([]);
  expect(readFileSync(join(stray, "uncommitted.txt"), "utf8")).toBe("keep me");
  expect((await sh(["git", "worktree", "list", "--porcelain"], { cwd: unrelated })).stdout).toContain(stray);
});

test("log and debug event retention is selective, including active-run events", async () => {
  const old = run("succeeded", 30);
  const young = run("succeeded", 30 - 1 / DAY);
  const active = run("running", 90);
  for (const r of [old, young, active]) {
    const dir = join(cfg.paths.runs, r.id);
    mkdirSync(dir);
    writeFileSync(join(dir, "inv-1.log"), "log");
    writeFileSync(join(dir, "report.txt"), "keep");
    writeFileSync(join(dir, "other.log"), "keep");
  }
  const oldDebug = store.addEvent({ runId: active.id, type: "log", level: "debug", message: "old" });
  const cutoffDebug = store.addEvent({ runId: old.id, type: "log", level: "debug", message: "cutoff" });
  const newDebug = store.addEvent({ runId: old.id, type: "log", level: "debug", message: "new" });
  const info = store.addEvent({ runId: old.id, type: "log", level: "info", message: "info" });
  store.db.query("UPDATE events SET ts = ? WHERE id = ?").run(now - 14 * DAY - 1, oldDebug.id);
  store.db.query("UPDATE events SET ts = ? WHERE id = ?").run(now - 14 * DAY, cutoffDebug.id);
  store.db.query("UPDATE events SET ts = ? WHERE id = ?").run(now - 14 * DAY + 1, newDebug.id);
  store.db.query("UPDATE events SET ts = ? WHERE id = ?").run(now - 14 * DAY - 1, info.id);
  const result = await collectGarbage(store, cfg, { now });
  expect(result.errors).toEqual([]);
  expect(result.logs).toEqual([join(cfg.paths.runs, old.id, "inv-1.log")]);
  for (const r of [old, young, active]) {
    const dir = join(cfg.paths.runs, r.id);
    expect(existsSync(join(dir, "inv-1.log"))).toBe(r !== old);
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(dir, "other.log"))).toBe(true);
  }
  expect(result.debugEvents).toBe(1);
  const ids = (store.db.query("SELECT id FROM events ORDER BY id").all() as { id: number }[]).map(
    (r) => r.id,
  );
  expect(ids).toEqual([cutoffDebug.id, newDebug.id, info.id]);
});

test("baseline cache entries expire after seven days and each key component misses", async () => {
  const key = { repoId: repo.id, baseSha: "a".repeat(40), gatesHash: "h", envHash: "e" };
  const since = now - 7 * DAY;
  store.putBaselineCache(key, { setupOk: true, setup: [], checks: [] }, "r1", now - 7 * DAY);
  const young = { ...key, baseSha: "b".repeat(40) };
  store.putBaselineCache(young, { setupOk: true, setup: [], checks: [] }, "r2", now - 7 * DAY + 1);
  expect(store.getBaselineCache(key, since)).toBeNull();
  expect(store.getBaselineCache<object>(young, since)).toEqual({ setupOk: true, setup: [], checks: [] });
  for (const miss of [
    { baseSha: "c".repeat(40) },
    { gatesHash: "other" },
    { envHash: "other" },
    { repoId: "x" },
  ])
    expect(store.getBaselineCache({ ...young, ...miss }, since)).toBeNull();
  const dry = await collectGarbage(store, cfg, { now, dryRun: true });
  expect(dry.baselineCache).toBe(1);
  expect(store.countExpiredBaselineCache(since)).toBe(1);
  const actual = await collectGarbage(store, cfg, { now });
  expect([actual.errors, actual.baselineCache]).toEqual([[], 1]);
  expect(store.countExpiredBaselineCache(now)).toBe(1);
  expect(store.getBaselineCache(young, since)).not.toBeNull();
  expect(store.db.query("SELECT run_id, created_at FROM passing_baselines").all()).toEqual([
    { run_id: "r2", created_at: now - 7 * DAY + 1 },
  ]);
  expect(store.clearBaselineCache("x")).toBe(0);
  expect(store.clearBaselineCache(repo.id)).toBe(1);
  expect(store.getBaselineCache(young, since)).toBeNull();
});

test("daemon API and CLI dry run leave Git, files and DB unchanged", async () => {
  const r = run("succeeded", 31);
  const path = await worktree(r.id);
  const dir = join(cfg.paths.runs, r.id);
  mkdirSync(dir);
  writeFileSync(join(dir, "inv-2.log"), "log");
  const event = store.addEvent({ runId: r.id, type: "log", level: "debug", message: "old" });
  store.db.query("UPDATE events SET ts = ? WHERE id = ?").run(now - 15 * DAY, event.id);
  // Use the real clock for the HTTP pass by moving the test run into the past relative to it.
  store.updateRun(r.id, { finishedAt: Date.now() - 31 * DAY });
  store.db.query("UPDATE events SET ts = ? WHERE id = ?").run(Date.now() - 15 * DAY, event.id);
  const factory = new Factory(cfg, { store, providers: [] });
  const server = await startHttp(factory);
  try {
    const before = await listed();
    const url = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${url}/api/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as GcResult;
    expect([data.worktrees.length, data.logs.length, data.debugEvents]).toEqual([1, 1, 1]);
    const cli = await sh(["bun", "src/cli/main.ts", "gc", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, LIMITLESS_URL: url } as Record<string, string>,
    });
    expect(cli.stdout).toContain("Would clean: 1 worktrees, 1 logs");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, "inv-2.log"))).toBe(true);
    expect(await listed()).toBe(before);
    expect(store.countOldDebugEvents(Date.now() - 14 * DAY)).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("gates clear-cache drops cached baselines for one repo or all of them", async () => {
  const other = store.upsertRepo({
    slug: "local/other",
    kind: "local",
    url: null,
    localPath: root,
    defaultBranch: repo.defaultBranch,
    mergePolicy: "none",
  });
  const pass = { setupOk: true, setup: [], checks: [] };
  const key = { repoId: repo.id, baseSha: "a".repeat(40), gatesHash: "h", envHash: "e" };
  store.putBaselineCache(key, pass, "r");
  store.putBaselineCache({ ...key, baseSha: "b".repeat(40) }, pass, "r");
  store.putBaselineCache({ ...key, repoId: other.id }, pass, "r");
  const count = () => store.db.query("SELECT repo_id FROM passing_baselines ORDER BY repo_id").all();
  const factory = new Factory(cfg, { store, providers: [] });
  const server = await startHttp(factory);
  const url = `http://127.0.0.1:${server.port}`;
  const cli = (...args: string[]) =>
    sh(["bun", "src/cli/main.ts", "gates", "clear-cache", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, LIMITLESS_URL: url } as Record<string, string>,
    });
  try {
    expect(count()).toHaveLength(3);
    expect((await cli("--repo", repo.slug)).stdout).toContain("Cleared 2 cached baselines");
    expect(count()).toEqual([{ repo_id: other.id }]);
    const missing = await fetch(`${url}/api/gates/clear-cache`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "no/such" }),
    });
    expect(missing.status).toBe(404);
    expect((await cli()).stdout).toContain("Cleared 1 cached baselines");
    expect(count()).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("one worktree failure leaves other items retryable", async () => {
  const bad = run("succeeded", 4);
  const good = run("succeeded", 4);
  const badPath = join(cfg.paths.work, bad.id);
  mkdirSync(badPath);
  const goodPath = await worktree(good.id);
  const first = await collectGarbage(store, cfg, { now });
  expect(first.errors.some((e) => e.includes(bad.id))).toBe(true);
  expect(existsSync(goodPath)).toBe(false);
  rmSync(badPath, { recursive: true });
  await worktree(bad.id);
  const second = await collectGarbage(store, cfg, { now });
  expect(second.errors).toEqual([]);
  expect(existsSync(badPath)).toBe(false);
});

test("uncapped finished-run query and dry-run metadata reporting", async () => {
  for (let i = 0; i < 110; i++) run("succeeded", 4);
  const eligible = run("succeeded", 4);
  const path = await worktree(eligible.id);
  const missing = run("succeeded", 4);
  const stale = await worktree(missing.id);
  rmSync(stale, { recursive: true });
  const before = await listed();
  const dry = await collectGarbage(store, cfg, { now, dryRun: true });
  expect(dry.errors).toEqual([]);
  expect(dry.worktrees).toEqual([path]);
  expect(dry.metadata.length).toBeGreaterThan(0);
  expect(existsSync(path)).toBe(true);
  expect(await listed()).toBe(before);
  const actual = await collectGarbage(store, cfg, { now });
  expect(actual.errors).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(await listed()).not.toContain(stale);
});

test("missing worktree parent is tolerated in dry run and pruned without affecting unrelated entries", async () => {
  const staleRun = run("succeeded", 4);
  const otherRun = run("succeeded", 4);
  const stalePath = await worktree(staleRun.id);
  const otherPath = await worktree(otherRun.id);
  rmSync(cfg.paths.work, { recursive: true, force: true });
  const outside = join(root, "outside", "unrelated");
  mkdirSync(join(root, "outside"));
  await sh(["git", "worktree", "add", "--detach", outside], { cwd: cachePath(cfg.paths, repo) });
  rmSync(outside, { recursive: true, force: true });

  const dry = await collectGarbage(store, cfg, { now, dryRun: true });
  expect(dry.errors).toHaveLength(1);
  expect(dry.errors[0]).toContain("prune would affect unrelated worktrees");
  expect(dry.errors[0]).toContain("outside/unrelated");
  expect(await listed()).toContain(stalePath);
  expect(await listed()).toContain(otherPath);
  expect(await listed()).toContain(outside);

  await sh(["git", "worktree", "prune", "--expire", "now"], { cwd: cachePath(cfg.paths, repo) });
  // Create fresh eligible stale entries after clearing the unrelated entry.
  const freshA = run("succeeded", 4);
  const freshB = run("succeeded", 4);
  mkdirSync(cfg.paths.work, { recursive: true });
  const freshPathA = await worktree(freshA.id);
  const freshPathB = await worktree(freshB.id);
  rmSync(cfg.paths.work, { recursive: true, force: true });
  const before = await listed();
  const preview = await collectGarbage(store, cfg, { now, dryRun: true });
  expect(preview.errors).toEqual([]);
  expect(preview.metadata).toHaveLength(2);
  expect(await listed()).toBe(before);
  const actual = await collectGarbage(store, cfg, { now });
  expect(actual.errors).toEqual([]);
  expect(actual.metadata).toHaveLength(2);
  expect(await listed()).not.toContain(freshPathA);
  expect(await listed()).not.toContain(freshPathB);
});

test("startup and hourly passes do not overlap and shutdown clears the timer", async () => {
  let tick: (() => void) | undefined;
  let cleared = false;
  let calls = 0;
  let resolvePass: ((result: GcResult) => void) | undefined;
  const empty: GcResult = {
    dryRun: false,
    worktrees: [],
    logs: [],
    metadata: [],
    debugEvents: 0,
    baselineCache: 0,
    feedItems: 0,
    errors: [],
  };
  const factory = new Factory(cfg, {
    store,
    providers: [],
    cleanup: () => {
      calls++;
      return new Promise((resolve) => {
        resolvePass = resolve;
      });
    },
    gcTimer: {
      set: (fn, ms) => {
        expect(ms).toBe(60 * 60_000);
        tick = fn;
        return 1 as never;
      },
      clear: () => {
        cleared = true;
      },
    },
  });
  factory.start();
  expect(calls).toBe(1);
  tick?.();
  expect(calls).toBe(1);
  expect(() => factory.gc()).toThrow("cleanup already running");
  resolvePass?.(empty);
  await Bun.sleep(0);
  tick?.();
  expect(calls).toBe(2);
  const stopping = factory.stop();
  expect(cleared).toBe(true);
  resolvePass?.(empty);
  await stopping;
  expect(tick).toBeDefined();
});

test("feed items strictly older than 30 days are pruned; dry-run only counts them", async () => {
  for (const ageMs of [30 * DAY + 1, 30 * DAY, 0]) {
    const record = store.createRun(repo, { prompt: "feed", repo: repo.slug });
    store.updateRun(record.id, { status: "failed" });
    const id = store.readFeed().nextAfter;
    store.db.query("UPDATE feed SET ts = ? WHERE id = ?").run(now - ageMs, id);
  }
  const ids = store.readFeed().items.map((i) => i.id);
  const dry = await collectGarbage(store, cfg, { now, dryRun: true });
  expect([dry.errors, dry.feedItems]).toEqual([[], 1]);
  expect(store.readFeed().items).toHaveLength(3);
  const actual = await collectGarbage(store, cfg, { now });
  expect([actual.errors, actual.feedItems]).toEqual([[], 1]);
  expect(store.readFeed().items.map((i) => i.id)).toEqual(ids.slice(1));
  expect(store.readFeed().pruned).toBe(true);
  expect(store.readFeed({ after: ids[0] }).pruned).toBe(false);
});
