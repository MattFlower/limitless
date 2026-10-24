import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { HealthResponse } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { untilAborted } from "../src/pipeline/faults.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { deferred } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { models, policy, providers } from "./pipeline-support.ts";
import { testWaits } from "./wait-support.ts";

const waits = testWaits();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function fixture(limit = 2, concurrency = 3) {
  const root = mkdtempSync(join(tmpdir(), "limitless-scheduler-load-"));
  const cfg = loadConfig({
    home: root,
    configDir: join(root, "config"),
    raw: { limits: { max_load_per_core: limit, max_concurrent_runs: concurrency } },
  });
  let load = 1;
  const calls: AgentSpec[] = [];
  const release = deferred<void>();
  const factory = new Factory(cfg, {
    store: new Store(":memory:"),
    loadSource: () => load,
    providers: providers.slice(0, 1).map((provider) => ({ ...provider, maxConcurrent: 4 })),
    models: models.slice(0, 1),
    policy,
    harnesses: {
      fake: fakeHarness(async (spec) => {
        calls.push(spec);
        if (calls.length > 1) return { fault: "block" };
        // A completed fake invocation ends the execution without running unrelated stages or git.
        await Promise.race([release.promise, untilAborted(spec.signal)]);
        return { status: "cancelled" };
      }),
    },
  });
  const repo = factory.store.upsertRepo({
    slug: "test/load",
    kind: "local",
    localPath: root,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const enqueue = () => {
    const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "work" });
    // Resume at model work so admission tests need no repository or subprocess setup.
    factory.store.setRunState(run.id, {
      phase: "triage",
      worktreePath: root,
      previewConfig: null,
      slottedCommands: [],
      agentFullSuite: "slot",
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    } satisfies RunState);
    return run.id;
  };
  cleanups.push(async () => {
    await factory.stop();
    factory.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    factory,
    scheduler: factory.scheduler,
    calls,
    enqueue,
    setLoad: (value: number) => {
      load = value;
    },
    release: () => release.resolve(),
    reload: (concurrency: number) => {
      mkdirSync(cfg.paths.configDir, { recursive: true });
      writeFileSync(
        join(cfg.paths.configDir, "config.toml"),
        `[limits]\nmax_load_per_core = ${limit}\nmax_concurrent_runs = ${concurrency}\n`,
      );
      factory.reloadConfig();
      factory.scheduler.tick();
    },
  };
}

test("reload raises and lowers admission without interrupting active runs", async () => {
  const f = fixture(2, 1);
  const queued = [f.enqueue(), f.enqueue(), f.enqueue(), f.enqueue()] as const;
  f.scheduler.tick();
  await waits.until(() => f.calls.length === 1, { timeoutMs: 2000 });
  expect(f.scheduler.activeRunIds).toEqual([queued[0]]);
  f.reload(3);
  await waits.until(() => f.calls.length === 3, { timeoutMs: 2000 });
  expect(f.scheduler.activeRunIds).toEqual(queued.slice(0, 3));
  f.reload(1);
  expect(f.scheduler.activeRunIds).toHaveLength(3);
  expect(f.calls.every((call) => !call.signal.aborted)).toBe(true);
  for (const id of queued.slice(1, 3)) f.scheduler.cancel(id);
  await waits.until(() => f.scheduler.activeRunIds.length === 1, { timeoutMs: 2000 });
  expect(f.factory.store.getRun(queued[3] ?? "")?.status).toBe("queued");
  f.release();
  await waits.until(() => f.calls.length === 4, { timeoutMs: 2000 });
  expect(f.scheduler.activeRunIds).toEqual([queued[3]]);
});

test("reload preserves drain and load holds when concurrency increases", async () => {
  const f = fixture(2, 1);
  f.enqueue();
  f.scheduler.tick();
  await waits.until(() => f.calls.length === 1, { timeoutMs: 2000 });
  f.enqueue();
  f.scheduler.drain();
  f.reload(3);
  expect(f.scheduler.activeRunIds).toHaveLength(1);
  f.setLoad(3);
  f.scheduler.resume();
  f.scheduler.tick();
  expect(f.scheduler.activeRunIds).toHaveLength(1);
  expect(f.scheduler.admissionHeld).toBe(true);
  expect(f.calls[0]?.signal.aborted).toBe(false);
});

test.each([
  [2, 3, true],
  [2, 1.5, false],
  [2, 2, false],
  [0, 100, false],
] as const)("active execution admission: limit %s, load %s", async (limit, load, held) => {
  const f = fixture(limit);
  const first = f.enqueue();
  f.scheduler.tick();
  await waits.until(() => f.calls.length === 1, { timeoutMs: 2000 });
  const queued = [f.enqueue(), f.enqueue()];
  f.setLoad(load);
  for (let tick = 0; tick < 3; tick++) f.scheduler.tick();
  expect(f.scheduler.activeRunIds).toEqual(held ? [first] : expect.arrayContaining([first, ...queued]));
  expect(f.scheduler.activeRunIds).toHaveLength(held ? 1 : 3);
  expect(f.scheduler.admissionHeld).toBe(held);
  for (const id of queued) expect(f.factory.store.getRun(id)?.status).toBe(held ? "queued" : "running");
  expect(f.calls[0]?.signal.aborted).toBe(false);
});

test("sustained overload admits one when idle, then another only after completion", async () => {
  const f = fixture();
  f.setLoad(3);
  const queued = [f.enqueue(), f.enqueue(), f.enqueue()];
  for (let tick = 0; tick < 3; tick++) f.scheduler.tick();
  const first = f.scheduler.activeRunIds[0];
  if (!first) throw new Error("No execution admitted while idle");
  expect(queued).toContain(first);
  expect(f.scheduler.activeRunIds).toHaveLength(1);
  await waits.until(() => f.calls.length === 1, { timeoutMs: 2000 });
  const remaining = queued.filter((id) => id !== first);
  for (const id of remaining) expect(f.factory.store.getRun(id)?.status).toBe("queued");
  f.release();
  await waits.until(() => f.calls.length === 2, { timeoutMs: 2000 });
  expect(f.scheduler.activeRunIds).toHaveLength(1);
  expect(f.scheduler.activeRunIds).not.toContain(first);
  expect(remaining).toContain(f.scheduler.activeRunIds[0] ?? "");
  for (let tick = 0; tick < 3; tick++) f.scheduler.tick();
  expect(f.scheduler.activeRunIds).toHaveLength(1);
  expect(f.scheduler.admissionHeld).toBe(true);
});

test.each(["drain", "stop", "zero concurrency"] as const)("idle exception respects %s", async (guard) => {
  const f = fixture(2, guard === "zero concurrency" ? 0 : 3);
  f.setLoad(3);
  const queued = f.enqueue();
  if (guard === "drain") f.scheduler.drain();
  if (guard === "stop") await f.scheduler.stop();
  f.scheduler.tick();
  expect(f.scheduler.activeRunIds).toEqual([]);
  expect(f.factory.store.getRun(queued)?.status).toBe("queued");
});

test("hold and resume log once per transition and health exposes the latest sample", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const f = fixture();
    const health = createHttpRoutes(f.factory)["/api/health"] as Route;
    const read = async () =>
      (await (
        await health(requestWithParams("http://localhost/api/health"), localServer)
      ).json()) as HealthResponse;
    expect((await read()).loadPerCore).toBeUndefined();
    for (const [load, held] of [
      [1, false],
      [3, true],
      [3, true],
      [1, false],
      [1, false],
    ] as const) {
      f.setLoad(load);
      f.scheduler.tick();
      expect(await read()).toMatchObject({
        ok: true,
        sha: "unknown",
        draining: false,
        active: [],
        parked: [],
        uptimeMs: expect.any(Number),
        eventLoopLagMaxMs: expect.any(Number),
        gateSlots: expect.any(Object),
        agentTestSlots: expect.any(Object),
        loadPerCore: load,
        admissionHeld: held,
      });
    }
    expect(log.mock.calls).toEqual([
      ["Holding new runs: load 3 per core is above 2"],
      ["Resuming new runs: host load is within the limit"],
    ]);
  } finally {
    log.mockRestore();
  }
});
