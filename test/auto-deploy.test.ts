import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { AutoDeploy, type AutoDeployDeps, type DeployResult } from "../src/land/auto-deploy.ts";
import {
  type DeployJobStatus,
  deployCredentialsDir,
  deployJobStatus,
  removeDeployJob,
} from "../src/land/deploy-process.ts";
import { registerCredential, type sh } from "../src/util/proc.ts";

const BOOT = "a".repeat(40);
const MAIN = "b".repeat(40);
const stores: Store[] = [];
const modules: AutoDeploy[] = [];
afterEach(() => {
  for (const module of modules) module.stop();
  modules.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(overrides: Partial<AutoDeployDeps> = {}) {
  const store = overrides.store ?? new Store(":memory:");
  if (!overrides.store) stores.push(store);
  let active: string[] = [];
  let tick = () => {};
  const calls: string[] = [];
  const logs: string[] = [];
  let resolves = 0;
  const deps: AutoDeployDeps = {
    store,
    afterLand: "when_idle",
    activeRunIds: () => active,
    selfRepo: async () => "test/self",
    mainSha: async () => {
      resolves++;
      return MAIN;
    },
    bootSha: BOOT,
    deploy: async (sha) => {
      calls.push(sha);
      return { ok: true };
    },
    jobStatus: async () => ({ kind: "running" }),
    cleanup: async () => true,
    now: () => 1234,
    log: (reason) => logs.push(reason),
    timer: {
      set: (fn) => {
        tick = fn;
        return 1;
      },
      clear: () => {
        tick = () => {};
      },
    },
    ...overrides,
  };
  const module = new AutoDeploy(deps);
  modules.push(module);
  return {
    store,
    module,
    deps,
    calls,
    logs,
    resolves: () => resolves,
    run: (ids: string[]) => {
      active = ids;
    },
    timer: async () => {
      tick();
      await flush();
    },
  };
}
let pr = 0;
function entry(store: Store, repo = "test/self", baseBranch = "main") {
  return store.createLandEntry({
    runId: null,
    repo,
    baseBranch,
    headBranch: "change",
    approvedSha: MAIN,
    prUrl: `https://github.com/${repo}/pull/${++pr}`,
  });
}
function land(store: Store, repo = "test/self", branch = "main") {
  const row = entry(store, repo, branch);
  store.updateLandEntry(row.id, { state: "landed" });
  return row;
}
function feed(store: Store) {
  return store.readFeed().items.filter((item) => item.kind.startsWith("deploy."));
}

test("timer deploys one pending landing once, records SHA, and ignores historic landings", async () => {
  const f = fixture();
  land(f.store);
  f.module.start();
  await flush();
  expect(f.calls).toEqual([]);
  land(f.store);
  await f.timer();
  await f.timer();
  expect(f.calls).toEqual([MAIN]);
  expect(feed(f.store)).toMatchObject([{ kind: "deploy.started", repo: "test/self", data: { sha: MAIN } }]);
});

test("active runs and active lands in any repository delay and coalesce landings", async () => {
  const f = fixture();
  await f.module.tick();
  f.run(["run"]);
  land(f.store);
  const other = entry(f.store, "other/repo");
  land(f.store);
  await f.module.tick();
  expect(f.calls).toEqual([]);
  expect(f.resolves()).toBe(0);
  f.run([]);
  await f.module.tick();
  expect(f.calls).toEqual([]);
  f.store.updateLandEntry(other.id, { state: "cancelled" });
  await f.module.tick();
  await f.module.tick();
  expect(f.calls).toEqual([MAIN]);
});

for (const scenario of ["off", "other repo", "other branch", "unchanged"] as const) {
  test(`does not deploy: ${scenario}`, async () => {
    const f = fixture({
      ...(scenario === "off" ? { afterLand: "off" } : {}),
      ...(scenario === "unchanged" ? { bootSha: MAIN } : {}),
    });
    await f.module.tick();
    land(
      f.store,
      scenario === "other repo" ? "other/repo" : "test/self",
      scenario === "other branch" ? "release" : "main",
    );
    for (let i = 0; i < 3; i++) await f.module.tick();
    expect(f.calls).toEqual([]);
    expect(f.resolves()).toBe(scenario === "unchanged" ? 1 : 0);
  });
}

test("failure redacts its reason and blocks across restart until a newer self landing", async () => {
  const secret = `private-${crypto.randomUUID()}`;
  registerCredential("AUTO_DEPLOY_TEST", secret);
  const calls: string[] = [];
  const deploy = async (sha: string): Promise<DeployResult> => {
    calls.push(sha);
    return { ok: false, reason: `locked ${secret}` };
  };
  const f = fixture({ deploy });
  await f.module.tick();
  land(f.store);
  await f.module.tick();
  await f.module.tick();
  const failed = feed(f.store).find((item) => item.kind === "deploy.failed");
  expect(failed?.summary).toContain("locked");
  expect(failed?.summary).toContain("[redacted");
  expect(JSON.stringify(feed(f.store))).not.toContain(secret);
  expect(JSON.stringify(f.store.getSetting("deploy.after_land:test/self", {}))).not.toContain(secret);
  f.module.stop();
  const restarted = fixture({ store: f.store, deploy });
  await restarted.module.tick();
  land(f.store, "other/repo");
  await restarted.module.tick();
  expect(calls).toHaveLength(1);
  land(f.store);
  await restarted.module.tick();
  await restarted.module.tick();
  expect(calls).toHaveLength(2);
});

const KEY = "deploy.after_land:test/self";
function state(store: Store) {
  return store.getSetting<{
    handled: number;
    attempt: { job: string } | null;
    blocked: { landId: number; reason: string } | null;
    lastDeployed?: string;
    lastOutcome?: DeployResult;
    pendingRemoval?: string[];
  }>(KEY, { handled: 0, attempt: null, blocked: null });
}

for (const bootSha of [MAIN, BOOT]) {
  test(`restart waits for job status with running SHA ${bootSha.slice(0, 1)}`, async () => {
    const pending = Promise.withResolvers<DeployResult>();
    const f = fixture({ deploy: () => pending.promise });
    await f.module.tick();
    land(f.store);
    const inflight = f.module.tick();
    await flush();
    const job = state(f.store).attempt?.job;
    expect(job).toBeString();
    if (!job) throw new Error("Missing persisted deploy job");
    f.module.stop();
    const secret = `rollback-${crypto.randomUUID()}`;
    registerCredential("ROLLBACK_TEST", secret);
    let status: DeployJobStatus = { kind: "running" };
    const cleaned: string[] = [];
    const restarted = fixture({
      store: f.store,
      bootSha,
      jobStatus: async () => status,
      cleanup: async (job) => {
        cleaned.push(job);
        return true;
      },
    });
    await restarted.module.tick();
    expect(state(f.store).attempt?.job).toBe(job);
    expect(state(f.store).blocked).toBeNull();
    expect(feed(f.store).filter((item) => item.kind === "deploy.failed")).toEqual([]);
    // A later landing with the same main must not redeploy a successful target after restart.
    if (bootSha === BOOT) land(f.store);
    await restarted.module.tick();
    await restarted.module.tick();
    expect(restarted.calls).toEqual([]);
    expect(cleaned).toEqual([]);
    status = { kind: "done", exitCode: bootSha === MAIN ? 1 : 0, tail: `rollback ${secret}` };
    await restarted.module.tick();
    expect(state(f.store).attempt).toBeNull();
    expect(cleaned).toEqual([job]);
    if (bootSha === MAIN) {
      expect(state(f.store).blocked?.reason).toContain("[redacted]");
      const failed = feed(f.store).filter((item) => item.kind === "deploy.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.summary).toContain(MAIN);
      expect(failed[0]?.summary).toContain("rollback [redacted]");
      expect(JSON.stringify(state(f.store))).not.toContain(secret);
    } else expect(state(f.store).blocked).toBeNull();
    await restarted.module.tick();
    await restarted.module.tick();
    expect(restarted.calls).toEqual([]);
    expect(feed(f.store).filter((item) => item.kind === "deploy.failed")).toHaveLength(
      bootSha === MAIN ? 1 : 0,
    );
    pending.resolve({ ok: false, reason: "late failure" });
    await inflight;
    expect(JSON.stringify(feed(f.store))).not.toContain("late failure");
    if (bootSha === MAIN) {
      restarted.deps.mainSha = async () => "c".repeat(40);
      land(f.store);
      await restarted.module.tick();
      expect(restarted.calls).toEqual(["c".repeat(40)]);
    }
  });
}

for (const ok of [true, false]) {
  test(`a newer main landing during a deploy stays pending after ${ok ? "success" : "failure"}`, async () => {
    const pending = Promise.withResolvers<DeployResult>();
    const calls: string[] = [];
    const f = fixture({
      deploy: (sha) => {
        calls.push(sha);
        return pending.promise;
      },
    });
    await f.module.tick();
    const first = land(f.store);
    const inflight = f.module.tick();
    await flush();
    expect(calls).toEqual([MAIN]);
    const newer = land(f.store);
    await f.module.tick();
    expect(calls).toEqual([MAIN]);
    pending.resolve(ok ? { ok: true } : { ok: false, reason: "deploy failed" });
    await inflight;
    expect(state(f.store).handled).toBe(first.id);
    if (ok) {
      expect(state(f.store).blocked).toBeNull();
      expect(state(f.store).lastDeployed).toBe(MAIN);
    } else expect(state(f.store).blocked?.landId).toBe(first.id);
    f.module.stop();

    const next = "c".repeat(40);
    const restarted = fixture({
      store: f.store,
      bootSha: ok ? MAIN : BOOT,
      mainSha: async () => next,
    });
    await restarted.module.tick();
    await restarted.module.tick();
    expect(restarted.calls).toEqual([next]);
    expect(state(f.store).handled).toBe(newer.id);
    expect(state(f.store).blocked).toBeNull();
  });
}

for (const kind of ["missing", "expired"] as const) {
  test(`${kind} job blocks and removal is durable until successful`, async () => {
    const f = fixture();
    await f.module.tick();
    const row = land(f.store);
    f.store.setSetting(KEY, {
      handled: row.id,
      attempt: { sha: MAIN, landId: row.id, time: 100, job: "stalled" },
      blocked: null,
    });
    const reason =
      kind === "missing"
        ? "deploy job dev.limitless.deploy.stalled disappeared without reporting a status"
        : "deploy job dev.limitless.deploy.stalled did not finish within 10800000ms";
    f.deps.jobStatus = async () => ({ kind, reason });
    let removes = 0;
    f.deps.cleanup = async () => ++removes > 1;
    await f.module.tick();
    expect(state(f.store).blocked?.reason).toBe(reason);
    expect(state(f.store).attempt).toBeNull();
    expect(state(f.store).pendingRemoval).toEqual(["stalled"]);
    expect(feed(f.store).filter((item) => item.kind === "deploy.failed")).toHaveLength(1);
    await f.module.tick();
    expect(removes).toBe(2);
    expect(state(f.store).pendingRemoval).toEqual([]);
    expect(f.calls).toEqual([]);
    land(f.store);
    await f.module.tick();
    expect(f.calls).toEqual([MAIN]);
  });
}

test("tick and in-process completion record a terminal outcome once", async () => {
  const pending = Promise.withResolvers<DeployResult>();
  const f = fixture({ deploy: () => pending.promise });
  await f.module.tick();
  land(f.store);
  const inflight = f.module.tick();
  await flush();
  f.deps.jobStatus = async () => ({ kind: "done", exitCode: 1, tail: "failure" });
  await f.module.tick();
  pending.resolve({ ok: false, reason: "duplicate failure" });
  await inflight;
  expect(feed(f.store).filter((item) => item.kind === "deploy.failed")).toHaveLength(1);
  expect(state(f.store).blocked?.reason).toBe("Deploy exited 1: failure");
});

test("resolver errors stay pending and redact logs; work arriving across resolution delays deployment", async () => {
  const main = Promise.withResolvers<string>();
  const secret = `private-${crypto.randomUUID()}`;
  registerCredential("AUTO_RESOLVE_TEST", secret);
  const f = fixture({
    mainSha: async () => {
      throw new Error(`unreachable ${secret}`);
    },
  });
  await f.module.tick();
  land(f.store);
  await f.module.tick();
  expect(f.calls).toEqual([]);
  expect(f.logs.join()).toContain("unreachable");
  expect(f.logs.join()).not.toContain(secret);
  f.deps.mainSha = () => main.promise;
  const resolving = f.module.tick();
  await flush();
  f.run(["new run"]);
  main.resolve(MAIN);
  await resolving;
  expect(f.calls).toEqual([]);
  f.run([]);
  await f.module.tick();
  expect(f.calls).toEqual([MAIN]);
});

test("new landing during main resolution requires a fresh SHA and does not start overlapping attempts", async () => {
  const resolving = Promise.withResolvers<string>();
  const deploying = Promise.withResolvers<DeployResult>();
  const calls: string[] = [];
  const f = fixture({
    mainSha: () => resolving.promise,
    deploy: (sha) => {
      calls.push(sha);
      return deploying.promise;
    },
  });
  await f.module.tick();
  land(f.store);
  const first = f.module.tick();
  await flush();
  land(f.store);
  resolving.resolve(MAIN);
  await first;
  expect(calls).toEqual([]);
  const next = "c".repeat(40);
  f.deps.mainSha = async () => next;
  const attempt = f.module.tick();
  await flush();
  await f.module.tick();
  expect(calls).toEqual([next]);
  deploying.resolve({ ok: true });
  await attempt;
});

test("a landing while self-repository resolution is pending is not mistaken for history", async () => {
  const repo = Promise.withResolvers<string>();
  const f = fixture({ selfRepo: () => repo.promise });
  land(f.store);
  const starting = f.module.tick();
  land(f.store);
  repo.resolve("test/self");
  await starting;
  expect(f.calls).toEqual([MAIN]);
});

test("a new block observed after main resolution is preserved", async () => {
  const main = Promise.withResolvers<string>();
  const f = fixture({ mainSha: () => main.promise });
  await f.module.tick();
  const row = land(f.store);
  const pending = f.module.tick();
  await flush();
  const key = "deploy.after_land:test/self";
  const newer = {
    handled: row.id,
    attempt: null,
    blocked: { sha: MAIN, landId: row.id, time: 2000, reason: "newer failure" },
  };
  f.store.setSetting(key, newer);
  main.resolve(MAIN);
  await pending;
  expect(f.calls).toEqual([]);
  expect(f.store.getSetting(key, {})).toEqual(newer);
});

test("a late hook result cannot overwrite a newer persisted attempt", async () => {
  const hook = Promise.withResolvers<DeployResult>();
  const f = fixture({ deploy: () => hook.promise });
  await f.module.tick();
  const row = land(f.store);
  const pending = f.module.tick();
  await flush();
  const key = "deploy.after_land:test/self";
  const newer = {
    handled: row.id + 1,
    attempt: { sha: "c".repeat(40), landId: row.id + 1, time: 2000 },
    blocked: null,
  };
  f.store.setSetting(key, newer);
  hook.resolve({ ok: false, reason: "old failure" });
  await pending;
  expect(f.store.getSetting(key, {})).toEqual(newer);
  expect(feed(f.store).some((item) => item.kind === "deploy.failed")).toBe(false);
});

for (const inspection of [null, 1, "throw"] as const) {
  test(`inconclusive inspection ${inspection} preserves attempt and pending removal across restart`, async () => {
    const root = mkdtempSync(join(tmpdir(), "auto-deploy-inspection-"));
    const database = join(root, "store.db");
    let store = new Store(database);
    let observed: typeof inspection | 113 = inspection;
    const status = join(root, "dev.limitless.deploy.tracked.status");
    const credentials = join(deployCredentialsDir(root), "dev.limitless.deploy.tracked.credentials");
    const command: typeof sh = async (args) => {
      if (args[1] === "remove") return { stdout: "", stderr: "", exitCode: null };
      if (observed === "throw") throw new Error("inspection failed");
      return { stdout: "", stderr: "", exitCode: observed };
    };
    const deps = () => ({
      store,
      jobStatus: (job: string, time: number) => deployJobStatus(job, time, command, root, "fake-launchctl"),
      cleanup: (job: string) =>
        removeDeployJob(job, command, root, "fake-launchctl", { home: root, recorded: true }),
    });
    try {
      const f = fixture(deps());
      await f.module.tick();
      const row = land(store);
      store.setSetting(KEY, {
        handled: row.id,
        attempt: { sha: MAIN, landId: row.id, time: 0, job: "tracked" },
        blocked: null,
      });
      mkdirSync(deployCredentialsDir(root), { recursive: true });
      writeFileSync(credentials, "[]");
      writeFileSync(`${status}.started`, "");
      await f.module.tick();
      expect(state(store).attempt?.job).toBe("tracked");
      expect(state(store).blocked).toBeNull();
      expect(f.calls).toEqual([]);
      f.module.stop();
      store.close();
      store = new Store(database);
      const restarted = fixture(deps());
      await restarted.module.tick();
      expect(state(store).attempt?.job).toBe("tracked");
      // Completion becomes observable, but failed cleanup must remain durable too.
      writeFileSync(status, "0 0\n");
      await restarted.module.tick();
      expect(state(store).attempt).toBeNull();
      expect(state(store).pendingRemoval).toEqual(["tracked"]);
      for (const file of [status, `${status}.started`, credentials]) expect(existsSync(file)).toBe(true);
      restarted.module.stop();
      store.close();
      store = new Store(database);
      const reconciled = fixture(deps());
      await reconciled.module.tick();
      expect(state(store).pendingRemoval).toEqual(["tracked"]);
      observed = 113;
      await reconciled.module.tick();
      expect(state(store).pendingRemoval).toEqual([]);
      for (const file of [status, `${status}.started`, credentials]) expect(existsSync(file)).toBe(false);
      expect(restarted.calls).toEqual([]);
      expect(reconciled.calls).toEqual([]);
      expect(state(store).lastDeployed).toBe(MAIN);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const exitCode of [0, 7]) {
  for (const restart of [false, true]) {
    test(`filter failure records log unavailable independently of deploy ${exitCode}, restart ${restart}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "auto-deploy-log-"));
      const database = join(root, "store.db");
      let store = new Store(database);
      const pending = Promise.withResolvers<DeployResult>();
      const f = fixture({ store, deploy: () => pending.promise });
      let inflight: Promise<void> | undefined;
      try {
        await f.module.tick();
        land(store);
        inflight = f.module.tick();
        await flush();
        const job = state(store).attempt?.job;
        if (!job) throw new Error("Missing deploy attempt");
        const result: DeployResult = {
          ok: exitCode === 0,
          exitCode,
          filterExitCode: 1,
          reason: "log unavailable",
        };
        if (restart) {
          f.module.stop();
          store.close();
          store = new Store(database);
          writeFileSync(join(root, `dev.limitless.deploy.${job}.status`), `${exitCode} 1\n`);
          const restarted = fixture({
            store,
            jobStatus: (id, time) =>
              deployJobStatus(
                id,
                time,
                async () => {
                  throw new Error("status should avoid inspection");
                },
                root,
              ),
          });
          await restarted.module.tick();
          expect(restarted.calls).toEqual([]);
        } else {
          pending.resolve(result);
          await inflight;
        }
        expect(state(store).lastOutcome).toMatchObject({
          ok: exitCode === 0,
          exitCode,
          filterExitCode: 1,
          reason: expect.stringContaining("log unavailable"),
        });
        expect(state(store).blocked === null).toBe(exitCode === 0);
        if (exitCode === 0) expect(state(store).lastDeployed).toBe(MAIN);
        else
          expect(feed(store).find((item) => item.kind === "deploy.failed")?.summary).toContain(
            "log unavailable",
          );
      } finally {
        pending.resolve({ ok: true });
        await inflight;
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
