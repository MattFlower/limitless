import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { collectGarbage, type GcResult } from "../src/gc.ts";
import { createWorktree } from "../src/git/repos.ts";
import { startHttp } from "../src/server/http.ts";
import { sh } from "../src/util/proc.ts";

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
  store.updateRun(record.id, { status, finishedAt: withFinish ? now - ageDays * DAY : null });
  return record;
}

async function worktree(id: string): Promise<string> {
  return (await createWorktree(cfg.paths, repo, id, id, repo.defaultBranch)).path;
}

async function listed(): Promise<string> {
  return (await sh(["git", "worktree", "list", "--porcelain"], { cwd: repoDir })).stdout;
}

test("terminal worktrees use exact 3/7 day boundaries and preserve nonterminal worktrees", async () => {
  const cases: [RunStatus, number, boolean][] = [
    ["succeeded", 3, true],
    ["cancelled", 3, true],
    ["failed", 7, true],
    ["needs_human", 7, true],
    ["succeeded", 3 - 1 / DAY, false],
    ["failed", 7 - 1 / DAY, false],
    ["queued", 99, false],
    ["running", 99, false],
    ["waiting_input", 99, false],
  ];
  const paths = await Promise.all(cases.map(async ([status, age]) => worktree(run(status, age).id)));
  const absent = run("failed", 8);
  const missing = await worktree(absent.id);
  rmSync(missing, { recursive: true, force: true });
  const result = await collectGarbage(store, cfg, { now });
  expect(result.errors).toEqual([]);
  const gitList = await listed();
  for (const [i, [, , removed]] of cases.entries()) {
    expect(existsSync(paths[i] as string)).toBe(!removed);
    expect(gitList.includes(paths[i] as string)).toBe(!removed);
  }
  expect(gitList).not.toContain(missing);
  expect(result.worktrees).toHaveLength(4);
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
  const server = startHttp(factory);
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
  const server = startHttp(factory);
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
  await sh(["git", "worktree", "add", "--detach", outside], { cwd: repoDir });
  rmSync(outside, { recursive: true, force: true });

  const dry = await collectGarbage(store, cfg, { now, dryRun: true });
  expect(dry.errors).toHaveLength(1);
  expect(dry.errors[0]).toContain("prune would affect unrelated worktrees");
  expect(dry.errors[0]).toContain("outside/unrelated");
  expect(await listed()).toContain(stalePath);
  expect(await listed()).toContain(otherPath);
  expect(await listed()).toContain(outside);

  await sh(["git", "worktree", "prune", "--expire", "now"], { cwd: repoDir });
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
