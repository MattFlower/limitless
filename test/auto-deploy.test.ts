import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/db/store.ts";
import { AutoDeploy, type AutoDeployDeps, type DeployResult } from "../src/land/auto-deploy.ts";
import { registerCredential } from "../src/util/proc.ts";

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

for (const bootSha of [MAIN, BOOT]) {
  test(`restart reconciles an attempt with running SHA ${bootSha.slice(0, 1)}`, async () => {
    const pending = Promise.withResolvers<DeployResult>();
    const f = fixture({ deploy: () => pending.promise });
    await f.module.tick();
    land(f.store);
    const inflight = f.module.tick();
    await flush();
    f.module.stop();
    const restarted = fixture({ store: f.store, bootSha });
    await restarted.module.tick();
    expect(restarted.calls).toEqual([]);
    const state = f.store.getSetting<{ attempt: unknown; blocked: unknown }>("deploy.after_land:test/self", {
      attempt: null,
      blocked: null,
    });
    expect(state.attempt).toBeNull();
    if (bootSha === MAIN) expect(state.blocked).toBeNull();
    else {
      expect(state.blocked).not.toBeNull();
      expect(feed(f.store).find((item) => item.kind === "deploy.failed")?.summary).toContain(MAIN);
      expect(feed(f.store).find((item) => item.kind === "deploy.failed")?.summary).toContain(BOOT);
      land(f.store);
      await restarted.module.tick();
      expect(restarted.calls).toEqual([MAIN]);
    }
    // A late result from the old instance cannot replace the reconciled state.
    pending.resolve({ ok: false, reason: "late failure" });
    await inflight;
    expect(JSON.stringify(feed(f.store))).not.toContain("late failure");
  });
}

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
