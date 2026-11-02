import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Repo } from "../src/core/types.ts";
import { worktreeGitScope } from "../src/git/command.ts";
import { homeReadPolicy, readPolicyScope } from "../src/harness/read-policy.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { validateScratch, writeRoots } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { claimGuard, claimScope, hasClaimScope } from "../src/integrations/claim-guard.ts";
import {
  CAPABILITY_REFRESH_MS,
  capabilitiesSchema,
  createCapabilityMonitor,
  type MonitorDeps,
} from "../src/integrations/member-capabilities.ts";
import * as proc from "../src/util/proc.ts";
import { processScope, registerCredential } from "../src/util/proc.ts";

let dir: string;
const monitors: ReturnType<typeof createCapabilityMonitor>[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "member-capabilities-test-"));
});
afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.start()();
  await turn();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(overrides: Partial<MonitorDeps> = {}) {
  let inclusive = 0;
  let exclusive = 0;
  let tick = () => {};
  const specs: AgentSpec[] = [];
  const runner = mock(async (args: string[]) => ({
    exitCode: 0,
    stdout: args.includes("--version")
      ? args[0] === "claude"
        ? "1.2.3 (Claude Code)"
        : "codex-cli 4.5.6"
      : "logged in",
    stderr: "",
  }));
  const cfg = loadConfig({ home: join(dir, "factory"), configDir: join(dir, "config"), raw: {} });
  const home = join(dir, "home");
  mkdirSync(home);
  const deps: MonitorDeps = {
    cfg: { ...cfg, secrets: {}, readPolicy: { home, environment: {} } },
    platform: "darwin",
    arch: "arm64",
    release: "a".repeat(40),
    runner,
    confinement: { verify: mock(async () => {}), wrap: (cmd) => cmd },
    codex: mock(async (spec: AgentSpec) => {
      specs.push(spec);
      const scratch = validateScratch(spec);
      if (spec.mode === "edit") writeRoots(spec.cwd, scratch, false, spec.denyRead);
      else homeReadPolicy([spec.cwd, scratch], false, spec.denyRead);
      return { ok: true, path: "/fake/codex", version: "4.5.6", reason: "verified", exitCode: 0 };
    }),
    machineState: mock(async () => ({ onAC: true, idleSeconds: 0 })),
    slots: () => 2,
    draining: () => false,
    clock: { sample: () => ({ inclusive, exclusive }) },
    timer: mock((callback, ms) => {
      expect(ms).toBe(30_000);
      tick = callback;
      return cleared;
    }),
    pushAccess: mock(async () => true),
    ...overrides,
  };
  const cleared = mock(() => {});
  const monitor = createCapabilityMonitor(deps);
  monitors.push(monitor);
  return {
    deps,
    monitor,
    runner,
    specs,
    cleared,
    tick: () => tick(),
    advance: (ms: number, awake = ms) => {
      inclusive += ms;
      exclusive += awake;
    },
  };
}
const repo: Repo = {
  id: "r",
  slug: "owner/repo",
  kind: "github",
  url: "file:///unused.git",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
  createdAt: 0,
};

test("construction captures context but performs no IO or timer work", () => {
  expect(typeof AsyncLocalStorage.snapshot).toBe("function");
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("limitless-member-capabilities-"));
  const f = fixture();
  for (const probe of [
    f.runner,
    f.deps.confinement?.verify,
    f.deps.codex,
    f.deps.machineState,
    f.deps.timer,
    f.deps.pushAccess,
  ])
    expect(probe).not.toHaveBeenCalled();
  expect(f.monitor.current(f.deps.clock.sample())).toBeNull();
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith("limitless-member-capabilities-"))).toEqual(
    before,
  );
});

test("snapshot strips suffixes and never carries probe messages or credentials", async () => {
  const sentinel = "private" + "sentinel";
  const credential = `credential-${crypto.randomUUID()}`;
  registerCredential("CAPABILITY_TEST_TOKEN", credential);
  const f = fixture({
    runner: async (args) => ({
      exitCode: args.includes("--version") ? 0 : 1,
      stdout: args[0] === "claude" ? `1.2.3-${sentinel}.example (Claude Code)` : "codex-cli 4.5.6",
      stderr: `${sentinel} ${credential}`,
    }),
    confinement: {
      verify: async () => {
        throw new Error(`${sentinel} ${credential}`);
      },
      wrap: (cmd) => cmd,
    },
    codex: async () => ({
      ok: true,
      path: "/fake/codex",
      version: null,
      reason: `${sentinel} ${credential}`,
      exitCode: null,
    }),
  });
  f.deps.cfg.secrets.CLAUDE_CODE_OAUTH_TOKEN = credential;
  const { value } = await f.monitor.refresh();
  expect(value.agents.claude).toEqual({ version: "1.2.3", loggedIn: false });
  expect(value.confinement).toEqual({
    backend: "seatbelt",
    verified: false,
    codex: { edit: true, read: true, confinedRead: true },
  });
  expect(JSON.stringify(value)).not.toContain(sentinel);
  expect(JSON.stringify(value)).not.toContain(credential);
  expect(value.privateStrings).toEqual({ parity: "unknown", policy: null });
  for (const invalid of [
    { ...value, release: "not-hex" },
    { ...value, release: "a".repeat(39) },
    { ...value, release: "A".repeat(40) },
    { ...value, extra: true },
    { ...value, freeSlots: -1 },
    { ...value, freeSlots: 1.5 },
    { ...value, freeSlots: Infinity },
    { ...value, freeSlots: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, checkpoints: [3] },
    { ...value, privateStrings: { parity: "match", policy: "z".repeat(40) } },
    { ...value, agents: { ...value.agents, claude: { version: "1.2.3-suffix", loggedIn: true } } },
  ])
    expect(capabilitiesSchema.safeParse(invalid).success).toBe(false);
  for (const key of ["confinement", "agents", "privateStrings"] as const)
    expect(capabilitiesSchema.safeParse({ ...value, [key]: { ...value[key], extra: true } }).success).toBe(
      false,
    );
  expect(
    capabilitiesSchema.safeParse({
      ...value,
      confinement: { ...value.confinement, codex: { ...value.confinement.codex, extra: true } },
    }).success,
  ).toBe(false);
  expect(
    capabilitiesSchema.safeParse({
      ...value,
      agents: { ...value.agents, codex: { ...value.agents.codex, extra: true } },
    }).success,
  ).toBe(false);
  expect(capabilitiesSchema.safeParse({ ...value, release: "b".repeat(64) }).success).toBe(true);
});

test.each(["edit", "read", "confinedRead", "missing", "throw"])("Codex failure: %s", async (failure) => {
  const f = fixture({
    codex: async (spec) => {
      const key = spec.mode === "edit" ? "edit" : spec.confineReads ? "confinedRead" : "read";
      if (failure === "throw") throw new Error("private reason");
      return {
        ok: key !== failure,
        path: failure === "missing" ? null : "/fake/codex",
        version: null,
        reason: "private reason",
        exitCode: null,
      };
    },
  });
  const { value } = await f.monitor.refresh();
  expect(value.confinement.verified).toBe(true);
  for (const key of ["edit", "read", "confinedRead"] as const)
    expect(value.confinement.codex[key]).toBe(
      failure !== "missing" && failure !== "throw" && key !== failure,
    );
});

test.each([
  ["linux", true, false, "unknown"],
  ["darwin", true, false, "ac"],
  ["darwin", false, false, "battery"],
  ["darwin", true, true, "unknown"],
] as const)("power on %s: AC %s, throws %s", async (platform, onAC, throws, power) => {
  const state = mock(async () => {
    if (throws) throw new Error("private");
    return { onAC, idleSeconds: 0 };
  });
  const f = fixture({ platform, machineState: state });
  expect((await f.monitor.refresh()).value.power).toBe(power);
  expect(state.mock.calls.length).toBe(platform === "linux" ? 0 : 1);
  expect(f.deps.confinement?.verify).toHaveBeenCalledTimes(1);
});

test("agent command failures and malformed versions are conservative; injected state is validated", async () => {
  const f = fixture({
    release: "bad release",
    parity: () => ({ parity: "match", policy: "a".repeat(40) }),
    draining: () => true,
    slots: () => 0,
    runner: async (args) => {
      if (args[0] === "codex") throw new Error("private stderr");
      return { exitCode: 0, stdout: "no version triple" };
    },
  });
  const { value } = await f.monitor.refresh();
  expect(value.agents).toEqual({
    claude: { version: null, loggedIn: true },
    codex: { version: null, loggedIn: false },
  });
  expect(value.release).toBeNull();
  expect(value.privateStrings).toEqual({ parity: "match", policy: "a".repeat(40) });
  expect(value.freeSlots).toBe(0);
  expect(value.draining).toBe(true);
  f.advance(30_000);
  f.deps.slots = () => -1;
  await expect(f.monitor.refresh()).rejects.toThrow();
});

test("configured read policy works outside a run and stable probe directories survive refresh", async () => {
  const f = fixture();
  expect(readPolicyScope.getStore()).toBeUndefined();
  expect((await f.monitor.refresh()).value.confinement.codex).toEqual({
    edit: true,
    read: true,
    confinedRead: true,
  });
  f.advance(30_000);
  await f.monitor.refresh();
  expect(f.specs.map((spec) => [spec.mode, spec.confineReads])).toEqual([
    ["edit", undefined],
    ["readonly", undefined],
    ["readonly", true],
    ["edit", undefined],
    ["readonly", undefined],
    ["readonly", true],
  ]);
  expect(new Set(f.specs.map((spec) => spec.cwd)).size).toBe(1);
  expect(new Set(f.specs.map((spec) => spec.scratchDir)).size).toBe(1);
  const cwd = f.specs[0]?.cwd ?? "";
  f.monitor.start()();
  await turn();
  expect(existsSync(cwd)).toBe(false);
});

test("caller scopes and cancellation cannot own the shared probe", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const f = fixture();
  const contexts: unknown[][] = [];
  const original = f.deps.runner;
  f.deps.runner = async (args, opts) => {
    contexts.push([
      processScope.getStore(),
      hasClaimScope(),
      confinementScope.getStore(),
      worktreeGitScope.getStore(),
      readPolicyScope.getStore(),
    ]);
    entered.resolve();
    await gate.promise;
    opts?.signal?.throwIfAborted();
    if (!original) throw new Error("missing fake runner");
    return original(args, opts);
  };
  const run = new AbortController();
  const beforeSpawn = mock(() => {});
  const recordProcessCleanup = mock(() => {});
  const children = new Map();
  const scoped = () =>
    processScope.run(
      {
        signal: run.signal,
        killGraceMs: 0,
        children,
        scratchDirs: new Set(),
        beforeSpawn,
        cleanups: {
          recordProcessCleanup,
          listProcessCleanups: () => [],
          deleteProcessCleanup: () => {},
          deleteInvocationCleanups: () => {},
        },
      },
      () =>
        claimScope.run(
          [
            {
              handle: {
                repo: "owner/repo",
                ref: "refs/heads/claim",
                run: "run",
                member: "m",
                generation: 1,
              },
              lost: true,
              cancelled: () => true,
              windowOpen: () => false,
              onLost: () => {},
            },
          ],
          () =>
            readPolicyScope.run({ home: "/caller-policy" }, () =>
              worktreeGitScope.run(false, () =>
                confinementScope.run(
                  {
                    verify: async () => {
                      throw new Error("caller backend");
                    },
                    wrap: (cmd) => cmd,
                  },
                  () => f.monitor.refresh(run.signal),
                ),
              ),
            ),
        ),
    );
  const first = scoped();
  const rejected = first.catch((error: unknown) => error);
  await entered.promise;
  const second = f.monitor.refresh();
  run.abort(new Error("caller cancelled"));
  expect(await rejected).toBeInstanceOf(Error);
  gate.resolve();
  const result = await second;
  expect(result.value.agents.claude.version).toBe("1.2.3");
  expect(f.monitor.current(f.deps.clock.sample())).toBe(result);
  expect(contexts.length).toBe(4);
  for (const context of contexts)
    expect(context).toEqual([undefined, false, undefined, undefined, f.deps.cfg.readPolicy]);
  claimGuard();
  expect(beforeSpawn).not.toHaveBeenCalled();
  expect(recordProcessCleanup).not.toHaveBeenCalled();
  expect(children.size).toBe(0);
});

test("freshness has a strict boundary, notices suspend and never reads wall time", async () => {
  const f = fixture();
  const result = await f.monitor.refresh();
  const wall = spyOn(Date, "now").mockImplementation(() => {
    throw new Error("wall clock");
  });
  try {
    expect(f.monitor.current({ inclusive: 59_999, exclusive: 59_999 })).toBe(result);
    expect(f.monitor.current({ inclusive: 60_000, exclusive: 60_000 })).toBeNull();
    expect(f.monitor.current({ inclusive: 7_000, exclusive: 5_000 })).toBeNull();
  } finally {
    wall.mockRestore();
  }
});

test("concurrent refresh shares a flight and stamps its start, even after 31 seconds", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture();
  f.deps.confinement = { verify: async () => gate.promise, wrap: (cmd) => cmd };
  const first = f.monitor.refresh();
  const second = f.monitor.refresh();
  f.advance(31_000);
  gate.resolve();
  const result = await first;
  expect(await second).toBe(result);
  expect(result.at).toEqual({ inclusive: 0, exclusive: 0 });
  expect(f.runner.mock.calls.filter(([args]) => args.includes("--version")).length).toBe(2);
});

test("failures are cached for 30 seconds, including undefined rejection", async () => {
  const f = fixture({
    slots: mock(() => {
      throw undefined;
    }),
  });
  await expect(f.monitor.refresh()).rejects.toBeUndefined();
  for (let i = 0; i < 10; i++) {
    f.advance(2_999);
    await expect(f.monitor.refresh()).rejects.toBeUndefined();
  }
  expect(f.deps.slots).toHaveBeenCalledTimes(1);
  f.advance(10);
  f.deps.slots = () => 1;
  expect((await f.monitor.refresh()).value.freeSlots).toBe(1);
});

test("background cadence is 0, 30, 60 seconds; stop aborts and clears it", async () => {
  const f = fixture();
  const stop = f.monitor.start();
  f.monitor.start();
  await f.monitor.refresh();
  expect(f.deps.timer).toHaveBeenCalledTimes(1);
  f.advance(CAPABILITY_REFRESH_MS);
  f.tick();
  expect((await f.monitor.refresh()).at.inclusive).toBe(30_000);
  f.advance(CAPABILITY_REFRESH_MS);
  f.tick();
  expect((await f.monitor.refresh()).at.inclusive).toBe(60_000);
  expect(f.deps.confinement?.verify).toHaveBeenCalledTimes(3);
  const signal = f.specs[0]?.signal;
  stop();
  expect(signal?.aborted).toBe(true);
  expect(f.cleared).toHaveBeenCalledTimes(1);
  f.advance(CAPABILITY_REFRESH_MS);
  f.tick();
  await expect(f.monitor.refresh()).rejects.toThrow();
  await expect(f.monitor.access(repo)).rejects.toThrow();
  expect(f.deps.confinement?.verify).toHaveBeenCalledTimes(3);
});

test("slow background probes let current lapse, then recover from the start sample", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture();
  f.monitor.start();
  await f.monitor.refresh();
  f.advance(30_000);
  f.deps.confinement = { verify: async () => gate.promise, wrap: (cmd) => cmd };
  f.tick();
  const pending = f.monitor.refresh();
  f.advance(30_000);
  f.tick();
  expect(f.monitor.current(f.deps.clock.sample())).toBeNull();
  f.advance(10_000);
  expect(f.monitor.current(f.deps.clock.sample())).toBeNull();
  gate.resolve();
  expect((await pending).at.inclusive).toBe(30_000);
  expect(f.monitor.current(f.deps.clock.sample())).not.toBeNull();
  expect(f.runner.mock.calls.filter(([args]) => args.includes("--version")).length).toBe(4);
});

test("stop aborts an unfinished probe and prevents it from storing a result", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const f = fixture({
    confinement: {
      wrap: (cmd) => cmd,
      verify: async (_roots, opts) => {
        const signal = opts.signal;
        if (!signal) throw new Error("missing signal");
        entered.resolve(signal);
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
    },
  });
  const stop = f.monitor.start();
  const flight = f.monitor.refresh();
  const rejected = flight.catch((error: unknown) => error);
  const signal = await entered.promise;
  stop();
  expect(await rejected).toBeInstanceOf(Error);
  expect(signal.aborted).toBe(true);
  expect(f.monitor.current(f.deps.clock.sample())).toBeNull();
  f.advance(30_000);
  f.tick();
  expect(f.deps.codex).not.toHaveBeenCalled();
});

test("stop cancels both default macOS power commands with the monitor signal", async () => {
  const entered = Promise.withResolvers<void>();
  const output = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
  const signals: (AbortSignal | undefined)[] = [];
  const cancelled: string[] = [];
  const power = spyOn(proc, "sh").mockImplementation(async (args, opts) => {
    signals.push(opts.signal);
    opts.signal?.addEventListener("abort", () => {
      cancelled.push(args[0] ?? "");
      output.reject(opts.signal?.reason);
    });
    if (signals.length === 2) entered.resolve();
    return output.promise;
  });
  const f = fixture({ machineState: undefined });
  const stop = f.monitor.start();
  const flight = f.monitor.refresh();
  const rejected = flight.catch((error: unknown) => error);
  try {
    await entered.promise;
    expect(power.mock.calls.map(([args]) => args)).toEqual([
      ["/usr/bin/pmset", "-g", "batt"],
      ["/usr/sbin/ioreg", "-c", "IOHIDSystem"],
    ]);
    expect(signals).toEqual([f.specs[0]?.signal, f.specs[0]?.signal]);
    stop();
    expect(cancelled).toEqual(["/usr/bin/pmset", "/usr/sbin/ioreg"]);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(await rejected).toBeInstanceOf(Error);
    expect(f.monitor.current(f.deps.clock.sample())).toBeNull();
  } finally {
    stop();
    output.resolve({ stdout: 'AC Power "HIDIdleTime" = 0', stderr: "", exitCode: 0 });
    await rejected;
    power.mockRestore();
  }
});

test("access shares per URL, caches false for 60 seconds, detaches and isolates cancellation", async () => {
  const gate = Promise.withResolvers<boolean>();
  const pushAccess = mock(async (_paths, _repo, signal?: AbortSignal) => {
    expect(hasClaimScope()).toBe(false);
    expect(signal?.aborted).toBe(false);
    return gate.promise;
  });
  const f = fixture({ pushAccess });
  const caller = new AbortController();
  const first = f.monitor.access(repo, caller.signal);
  const rejected = first.catch((error: unknown) => error);
  const second = f.monitor.access({ ...repo, id: "other-id" });
  caller.abort();
  expect(await rejected).toBeInstanceOf(Error);
  f.advance(31_000);
  gate.resolve(false);
  const result = await second;
  expect(result).toEqual({ at: { inclusive: 0, exclusive: 0 }, value: false });
  f.advance(28_999);
  expect(await f.monitor.access(repo)).toBe(result);
  expect(pushAccess).toHaveBeenCalledTimes(1);
  f.advance(1);
  expect((await f.monitor.access(repo)).at.inclusive).toBe(60_000);
  await f.monitor.access({ ...repo, url: "file:///another.git" });
  expect(pushAccess).toHaveBeenCalledTimes(3);
  expect(f.monitor.current(f.deps.clock.sample())).toBeNull();
});

test("access exceptions are cached for 30 seconds and share detached read policy", async () => {
  const f = fixture({
    pushAccess: mock(async () => {
      expect(readPolicyScope.getStore()).toBe(f.deps.cfg.readPolicy);
      throw new Error("access failure");
    }),
  });
  for (let i = 0; i < 10; i++) await expect(f.monitor.access(repo)).rejects.toThrow("access failure");
  expect(f.deps.pushAccess).toHaveBeenCalledTimes(1);
  f.advance(30_000);
  await expect(f.monitor.access(repo)).rejects.toThrow("access failure");
  expect(f.deps.pushAccess).toHaveBeenCalledTimes(2);
});

test("synchronous access throws are recorded rather than launching repeated probes", async () => {
  const probe = mock(() => {
    throw new Error("synchronous failure");
  });
  const f = fixture({ pushAccess: probe });
  for (let i = 0; i < 10; i++) await expect(f.monitor.access(repo)).rejects.toThrow("synchronous failure");
  expect(probe).toHaveBeenCalledTimes(1);
  f.advance(30_000);
  await expect(f.monitor.access(repo)).rejects.toThrow("synchronous failure");
  expect(probe).toHaveBeenCalledTimes(2);
});
