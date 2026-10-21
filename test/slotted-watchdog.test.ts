import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTestSession, type TestLane } from "../src/gates/agent-tests.ts";
import { Semaphore } from "../src/gates/slots.ts";
import { runClaude } from "../src/harness/claude.ts";
import { runCodex } from "../src/harness/codex.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { idleWatchdog, type ProcOptions, type ProcResult } from "../src/util/proc.ts";
import { waitClock } from "./wait-clock.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const paths = ["claude-byte", "claude-progress", "codex-byte"] as const;
type WatchdogPath = (typeof paths)[number];

function fixture(path: WatchdogPath, enabled = true, capMs = 90_000) {
  const time = waitClock();
  const root = mkdtempSync(join(tmpdir(), "slotted-watchdog-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // waitClock's one-shot timers also drive repeat checks, without changing global timers.
  const intervals = {
    set: ((callback: () => void, ms: number) => {
      let handle: ReturnType<typeof setInterval>;
      let active = true;
      const tick = () => {
        callback();
        if (active) handle = time.timer.set(tick, ms);
      };
      handle = time.timer.set(tick, ms);
      const stop = () => {
        active = false;
        time.timer.clear(handle);
      };
      return stop as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clear: ((stop: unknown) => (stop as () => void)()) as typeof clearInterval,
  };
  const slots = { small: new Semaphore(1), gate: new Semaphore(1) };
  const events: { active: boolean; elapsedMs: number; at: number }[] = [];
  const options = {
    now: time.now,
    timer: time.timer.set,
    clear: time.timer.clear,
    slots,
    caps: { small: capMs, gate: capMs },
  };
  const session = new AgentTestSession(() => {}, {
    ...options,
    onWatchdog: (active, elapsedMs) => events.push({ active, elapsedMs, at: time.now() }),
  });
  cleanup.push(() => session.close());
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let processOptions: ProcOptions;
  let finish: (over?: Partial<ProcResult>) => void = () => {
    throw new Error("fake process has not started");
  };
  let output: () => void = () => {};
  let done = false;
  const runner = (opts: ProcOptions): Promise<ProcResult> => {
    processOptions = opts;
    // Exercise the production byte watchdog's decision, using the clock passed by the harness.
    expect(opts.idleNow).toBe(enabled ? session.idleNow : time.now);
    const idle = idleWatchdog(opts.idleTimeoutMs ?? Infinity, opts.idleNow);
    const result = Promise.withResolvers<ProcResult>();
    const overall = time.timer.set(() => finish({ timedOut: true }), opts.timeoutMs ?? 0);
    const byte = intervals.set(
      () => {
        if (path !== "claude-progress" && idle.expired()) finish({ idleTimedOut: true });
      },
      Math.min(opts.idleTimeoutMs ?? Infinity, 5000),
    );
    const abort = () => finish({ cancelled: true });
    finish = (over = {}) => {
      if (done) return;
      done = true;
      intervals.clear(byte);
      time.timer.clear(overall);
      opts.signal?.removeEventListener("abort", abort);
      result.resolve({
        exitCode: 0,
        signal: null,
        cancelled: false,
        timedOut: false,
        idleTimedOut: false,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
        ...over,
      });
    };
    output = () => {
      idle.reset();
      opts.onStdoutLine?.(
        path === "codex-byte"
          ? '{"type":"item.completed","item":{"type":"agent_message","text":"working"}}'
          : '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
      );
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    started.resolve();
    return result.promise;
  };
  const spec: AgentSpec = {
    cwd: root,
    prompt: "test",
    mode: "readonly",
    noTools: true,
    target: {
      modelId: "test",
      model: "test",
      provider: "claude",
      harness: "claude",
      vendor: "test",
      tier: 1,
      billing: "subscription",
    },
    timeoutMs: 60_000,
    idleTimeoutMs: 10_000,
    idleNow: enabled ? session.idleNow : time.now,
    maxToolCalls: 10,
    signal: controller.signal,
    logPath: join(root, "invocation.log"),
    onEvent: () => {},
  };
  const result = (
    path === "codex-byte"
      ? runCodex(spec, runner)
      : runClaude(spec, runner, {
          ...intervals,
          // Isolate Claude's byte and meaningful-progress watchdogs so either can catch a regression.
          set: ((callback: () => void, ms: number) =>
            intervals.set(path === "claude-progress" ? callback : () => {}, ms)) as typeof setInterval,
        })
  ).finally(() => session.close());
  cleanup.push(() => {
    controller.abort();
    finish({ cancelled: true });
  });
  const request = (body: Record<string, unknown>) => session.request({ ...body, token: session.token });
  return {
    time,
    slots,
    options,
    session,
    request,
    events,
    controller,
    started: started.promise,
    result,
    get done() {
      return done;
    },
    output: () => output(),
    complete: () => {
      processOptions.onStdoutLine?.(
        path === "codex-byte"
          ? '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'
          : '{"type":"result","subtype":"success","result":"ok"}',
      );
      finish();
    },
  };
}

test.each(paths.flatMap((path) => (["small", "gate"] as const).map((lane) => [path, lane] as const)))(
  "%s excludes queued and acquired time in the %s lane",
  async (path, lane) => {
    const f = fixture(path);
    await f.started;
    const start = f.time.now();
    const release = await f.slots[lane].acquire(new AbortController().signal);
    try {
      const lease = await f.request({ name: "bun test", lane });
      expect(lease.acquired).toBe(false);
      await f.time.advance(12_000);
      expect(f.done).toBe(false);
      release();
      await f.time.flush();
      expect(await f.request({ id: lease.id })).toMatchObject({ acquired: true });
      await f.time.advance(12_000);
      expect(f.done).toBe(false);
      await f.request({ id: lease.id, release: true });
      f.complete();
      expect((await f.result).status).toBe("ok");
      expect(f.events).toEqual([
        { active: true, elapsedMs: 0, at: start },
        { active: false, elapsedMs: 24_000, at: start + 24_000 },
      ]);
      expect(f.time.pending).toBe(0);
    } finally {
      release();
    }
  },
);

test.each(paths.flatMap((path) => (["timeout", "cancelled"] as const).map((end) => [path, end] as const)))(
  "%s preserves %s during suppression and closes its interval",
  async (path, end) => {
    const f = fixture(path);
    await f.started;
    const start = f.time.now();
    const lease = await f.request({ name: "bun test", lane: "gate" });
    for (let i = 0; i < (end === "timeout" ? 5 : 2); i++) {
      await f.time.advance(10_000);
      expect(f.done).toBe(false);
      await f.request({ id: lease.id });
    }
    if (end === "timeout") await f.time.advance(10_000);
    else f.controller.abort();
    expect((await f.result).status).toBe(end);
    const duration = end === "timeout" ? 60_000 : 20_000;
    expect(f.events).toEqual([
      { active: true, elapsedMs: 0, at: start },
      { active: false, elapsedMs: duration, at: start + duration },
    ]);
    expect(f.slots.gate.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
    await expect(f.request({ id: lease.id })).rejects.toThrow("capability");
  },
);

test.each(
  paths.flatMap((path) => (["none", "foreign", "disabled"] as const).map((mode) => [path, mode] as const)),
)("%s still detects idle with %s activity", async (path, mode) => {
  const f = fixture(path, mode !== "disabled");
  await f.started;
  const foreign = new AgentTestSession(() => {}, f.options);
  try {
    if (mode === "foreign") await foreign.request({ token: foreign.token, name: "bun test", lane: "small" });
    await f.time.advance(10_000);
    expect(f.done).toBe(false);
    await f.time.advance(10_000);
    expect((await f.result).status).toBe("stuck");
    expect(f.events).toEqual([]);
  } finally {
    foreign.close();
  }
  expect(f.time.pending).toBe(0);
});

test.each([...paths])("%s resumes the remaining idle budget after overlapping leases", async (path) => {
  const f = fixture(path);
  await f.started;
  const start = f.time.now();
  await f.time.advance(4000);
  const small = await f.request({ name: "targeted tests", lane: "small" });
  await f.time.advance(4000);
  const gate = await f.request({ name: "full tests", lane: "gate" });
  expect(await f.request({ reuse: gate.id, lane: "small" })).toMatchObject({ reused: true });
  await f.time.advance(12_000);
  await f.request({ id: small.id, release: true });
  await f.time.advance(12_000);
  expect(f.done).toBe(false);
  expect(f.events).toHaveLength(1);
  await f.request({ id: gate.id, release: true });
  expect(f.events.at(-1)).toEqual({ active: false, elapsedMs: 28_000, at: start + 32_000 });
  await f.time.advance(6000);
  expect(f.done).toBe(false);
  await f.time.advance(10_000);
  expect((await f.result).status).toBe("stuck");
  expect(f.time.pending).toBe(0);
});

test.each([...paths])("%s counts a whole suppression interval between watchdog checks", async (path) => {
  const f = fixture(path);
  await f.started;
  await f.time.advance(2000);
  const lease = await f.request({ name: "bun test", lane: "small" });
  await f.time.advance(2000);
  await f.request({ id: lease.id, release: true });
  // The first check observes 12s of wall time, but only 10s of unsuppressed silence.
  await f.time.advance(8000);
  expect(f.done).toBe(false);
  expect(f.events.at(-1)?.elapsedMs).toBe(2000);
  await f.time.advance(10_000);
  expect(f.done).toBe(true);
  expect((await f.result).status).toBe("stuck");
});

test.each(["release", "expiry", "cap"] as const)(
  "%s ends suppression and recovery starts a new interval",
  async (end) => {
    const f = fixture("codex-byte", true, end === "cap" ? 20_000 : 90_000);
    await f.started;
    const start = f.time.now();
    const lane: TestLane = "small";
    const lease = await f.request({ name: "bun test", lane });
    const duration = end === "expiry" ? 30_000 : 20_000;
    await f.time.advance(duration);
    if (end === "release") await f.request({ id: lease.id, release: true });
    expect(f.events.at(-1)).toEqual({ active: false, elapsedMs: duration, at: start + duration });
    expect(f.slots.small.snapshot().occupied).toBe(0);
    if (end === "expiry") {
      const recovered = await f.request({ name: "bun test", lane, running: true, recover: lease.id });
      await f.time.advance(5000);
      await f.request({ id: recovered.id, release: true });
      expect(f.events.slice(-2)).toEqual([
        { active: true, elapsedMs: 0, at: start + duration },
        { active: false, elapsedMs: 5000, at: start + duration + 5000 },
      ]);
    }
    await f.time.advance(10_000);
    expect(f.done).toBe(false);
    await f.time.advance(5000);
    expect((await f.result).status).toBe("stuck");
    expect(f.time.pending).toBe(0);
  },
);

test.each([...paths])("%s retains output/progress resets during and after suppression", async (path) => {
  const f = fixture(path);
  await f.started;
  await f.time.advance(8000);
  const lease = await f.request({ name: "bun test", lane: "small" });
  await f.time.advance(12_000);
  f.output();
  await f.time.advance(12_000);
  await f.request({ id: lease.id, release: true });
  await f.time.advance(8000);
  expect(f.done).toBe(false);
  f.output();
  await f.time.advance(8000);
  expect(f.done).toBe(false);
  await f.time.advance(10_000);
  expect(f.done).toBe(true);
  expect((await f.result).status).toBe("stuck");
  expect(f.time.pending).toBe(0);
});
