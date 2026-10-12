import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { wrapperLeaseClient } from "../src/cli/agent-test.ts";
import { DaemonTimeoutError, type DeployClock } from "../src/cli/deploy-wait.ts";
import {
  gateSlotCommand,
  type LeaseClient,
  LeaseRejected,
  localLeaseClient,
  withGateLease,
} from "../src/cli/gate-slot.ts";
import { AgentTestSession } from "../src/gates/agent-tests.ts";
import { GATE_LEASE_EXPIRY_MS, Semaphore } from "../src/gates/slots.ts";
import { waitClock } from "./wait-clock.ts";

function rig(limit = 1) {
  const time = waitClock();
  let slots = new Semaphore(limit);
  const clock: DeployClock = {
    now: time.now,
    sleep: async (ms) => time.advance(ms),
    timeout: (fn, ms) => {
      const id = time.timer.set(fn, ms);
      return () => time.timer.clear(id);
    },
  };
  const calls: Record<string, unknown>[] = [];
  const client: LeaseClient = async (body) => {
    calls.push(body);
    const id =
      typeof body.id === "string"
        ? body.id
        : await slots.lease(
            String(body.name),
            body.immediate === true,
            time.timer.set,
            time.timer.clear,
            body.running === true,
          );
    const acquired = slots.heartbeat(id, body.release === true);
    return { id, acquired: acquired ?? false, expired: acquired === undefined };
  };
  return {
    time,
    clock,
    calls,
    client,
    get slots() {
      return slots;
    },
    set slots(value: Semaphore) {
      slots = value;
    },
  };
}
const signal = new AbortController().signal;

test("mixed internal and lease waiters share FIFO; queued time does not shorten lease lifetime", async () => {
  const f = rig();
  const first = await f.slots.acquire(signal, undefined, "run-a");
  const lease = await f.slots.lease("deploy", false, f.time.timer.set, f.time.timer.clear);
  const internal = f.slots.acquire(signal, undefined, "run-b");
  expect(f.slots.snapshot()).toEqual({ occupied: 1, limit: 1, holders: ["run-a"] });
  await f.time.advance(29_000);
  expect(f.slots.heartbeat(lease)).toBe(false);
  first();
  await f.time.flush();
  expect(f.slots.snapshot().holders).toEqual(["deploy"]);
  await f.time.advance(29_000);
  expect(f.slots.snapshot().holders).toEqual(["deploy"]);
  await f.time.advance(1000);
  const last = await internal;
  expect(f.slots.snapshot().holders).toEqual(["run-b"]);
  expect(f.slots.heartbeat(lease)).toBeUndefined();
  last();
  expect(f.time.pending).toBe(0);
});

test("renewal, idempotent release, queued cancellation and admission/cancel race conserve capacity", async () => {
  const f = rig();
  let id = await f.slots.lease("deploy", false, f.time.timer.set, f.time.timer.clear);
  await f.time.advance(20_000);
  expect(f.slots.heartbeat(id)).toBe(true);
  await f.time.advance(20_000);
  expect(f.slots.snapshot().occupied).toBe(1);
  f.slots.heartbeat(id, true);
  f.slots.heartbeat(id, true);
  expect(f.slots.heartbeat(id)).toBeUndefined();
  for (const race of [false, true]) {
    const release = await f.slots.acquire(signal);
    id = await f.slots.lease("queued", false, f.time.timer.set, f.time.timer.clear);
    if (race) release();
    f.slots.heartbeat(id, true);
    release();
    await f.time.flush();
    expect(f.slots.snapshot().occupied).toBe(0);
    (await f.slots.acquire(signal))();
  }
  const release = await f.slots.acquire(signal);
  id = await f.slots.lease("abandoned", false, f.time.timer.set, f.time.timer.clear);
  await f.time.advance(30_000);
  release();
  expect(f.slots.heartbeat(id)).toBeUndefined();
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("wrapper holds and heartbeats throughout work and releases on success and failure", async () => {
  for (const fails of [false, true]) {
    const f = rig();
    const operation = withGateLease(
      "deploy",
      async () => {
        for (let i = 0; i < 4; i++) {
          await f.time.advance(10_000);
          expect(f.slots.snapshot().holders).toEqual(["deploy"]);
        }
        if (fails) throw new Error("check failed");
        return 7;
      },
      f,
    );
    if (fails) await expect(operation).rejects.toThrow("check failed");
    else expect(await operation).toBe(7);
    expect(f.calls.filter((c) => c.id && !c.release).length).toBe(4);
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test("a failed heartbeat retries while a second client waits beyond the original expiry", async () => {
  const f = rig();
  const clock = {
    ...f.clock,
    sleep: (ms: number) => new Promise<void>((resolve) => f.clock.timeout(resolve, ms)),
  };
  const done = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const warnings: string[] = [];
  let renewals = 0,
    secondStarted = false;
  const first = withGateLease(
    "first",
    () => {
      started.resolve();
      return done.promise;
    },
    {
      ...f,
      clock,
      warn: (s) => warnings.push(s),
      client: (body, signal) => {
        if (body.id && !body.release && ++renewals === 1) throw new Error("one failed heartbeat");
        return f.client(body, signal);
      },
    },
  );
  await started.promise;
  const second = withGateLease(
    "second",
    async () => {
      secondStarted = true;
    },
    { ...f, clock },
  );
  try {
    await f.time.flush();
    await f.time.advance(10_000);
    expect(warnings.join()).toContain("one failed heartbeat");
    expect(renewals).toBe(1);
    await f.time.advance(1000);
    expect(renewals).toBe(2);
    for (let i = 0; i < 3; i++) {
      await f.time.advance(10_000);
      expect(f.slots.snapshot().holders).toEqual(["first"]);
      expect(secondStarted).toBe(false);
    }
  } finally {
    done.resolve();
    await first;
    await f.time.advance(250);
    await second;
  }
  expect(secondStarted).toBe(true);
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("a late response to a timed-out heartbeat does not release running work", async () => {
  const f = rig(),
    started = Promise.withResolvers<void>(),
    done = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
  let late: Awaited<ReturnType<LeaseClient>> | undefined,
    renewals = 0,
    nextStarted = false;
  const warnings: string[] = [];
  const work = withGateLease(
    "first",
    () => {
      started.resolve();
      return done.promise;
    },
    {
      ...f,
      warn: (s) => warnings.push(s),
      client: async (body, signal) => {
        const result = await f.client(body, signal);
        if (body.id && !body.release && ++renewals === 1) {
          late = result;
          return reply.promise;
        }
        return result;
      },
    },
  );
  await started.promise;
  const next = f.slots.acquire(signal, undefined, "next").then((release) => {
    nextStarted = true;
    return release;
  });
  try {
    await f.time.advance(10_000);
    await f.time.advance(2000);
    expect(warnings.join()).toContain("timed out");
    await f.time.advance(1000);
    expect(renewals).toBe(2);
    if (!late) throw new Error("missing heartbeat response");
    reply.resolve(late);
    await f.time.flush();
    expect(f.slots.snapshot().holders).toEqual(["first"]);
    expect(nextStarted).toBe(false);
  } finally {
    done.resolve();
    await work;
    (await next)();
  }
  expect(f.time.pending).toBe(0);
});

test("restart re-registers running work immediately, even above the cap, before admitting new work", async () => {
  for (const occupied of [false, true]) {
    const f = rig();
    const clock = {
      ...f.clock,
      sleep: (ms: number) => new Promise<void>((resolve) => f.clock.timeout(resolve, ms)),
    };
    const done = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    const first = withGateLease(
      "survivor",
      () => {
        started.resolve();
        return done.promise;
      },
      { ...f, clock },
    );
    await started.promise;
    // Retire the old daemon's timers; the command itself remains running.
    const oldSlots = f.slots;
    f.slots = new Semaphore(1);
    const release = occupied ? await f.slots.acquire(signal, undefined, "new-run") : () => {};
    let secondStarted = false;
    const queue = () =>
      withGateLease(
        "second",
        async () => {
          secondStarted = true;
        },
        { ...f, clock },
      );
    let second: Promise<void> | undefined;
    try {
      if (occupied) {
        second = queue();
        await f.time.flush();
      }
      await f.time.advance(10_000);
      const holders = occupied ? ["new-run", "survivor"] : ["survivor"];
      expect(f.slots.snapshot()).toEqual({ occupied: holders.length, limit: 1, holders });
      expect(f.calls).toContainEqual({ name: "survivor", running: true });
      const heartbeat = f.calls.find((body) => typeof body.id === "string" && !body.release);
      if (typeof heartbeat?.id === "string") oldSlots.heartbeat(heartbeat.id, true);
      second ??= queue();
      await f.time.flush();
      expect(secondStarted).toBe(false);
      done.resolve();
      await first;
      await f.time.advance(250);
      if (occupied) {
        expect(f.slots.snapshot().holders).toEqual(["new-run"]);
        expect(secondStarted).toBe(false);
      }
    } finally {
      done.resolve();
      await first;
      release();
      await f.time.flush();
      await f.time.advance(250);
      await second;
    }
    expect(secondStarted).toBe(true);
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test("late recovery replies keep running work leased until exit, including after a recovery retry", async () => {
  for (const [retryDelay, delayExpired] of [
    [0, false],
    [1000, false],
    [41_000, false],
    [1000, true],
  ] as const) {
    const f = rig();
    const clock = {
      ...f.clock,
      sleep: (ms: number) => new Promise<void>((resolve) => f.clock.timeout(resolve, ms)),
    };
    const done = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>(),
      heartbeatReply = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
    const warnings: string[] = [],
      order: string[] = [];
    let recovered: Awaited<ReturnType<LeaseClient>> | undefined,
      expired: Awaited<ReturnType<LeaseClient>> | undefined,
      secondStarted = false;
    const first = withGateLease(
      "survivor",
      () => {
        started.resolve();
        return done.promise.then(() => {
          order.push("first exited");
        });
      },
      {
        ...f,
        clock,
        warn: (s) => warnings.push(s),
        client: async (body, signal) => {
          const result = await f.client(body, signal);
          if (delayExpired && recovered && body.id && !body.release && result.expired) {
            expired = result;
            return heartbeatReply.promise;
          }
          if (body.running && !recovered) {
            recovered = result;
            return reply.promise;
          }
          return result;
        },
      },
    );
    await started.promise;
    const oldSlots = f.slots;
    f.slots = new Semaphore(1);
    await f.time.advance(10_000);
    const heartbeat = f.calls.find((body) => typeof body.id === "string" && !body.release);
    if (typeof heartbeat?.id === "string") oldSlots.heartbeat(heartbeat.id, true);
    await f.time.advance(2000);
    expect(warnings.join()).toContain("timed out");
    const second = withGateLease(
      "second",
      async () => {
        secondStarted = true;
        order.push("second started");
      },
      { ...f, clock },
    );
    try {
      await f.time.flush();
      for (let elapsed = 0; elapsed < retryDelay; elapsed += 1000) await f.time.advance(1000);
      if (!recovered) throw new Error("missing recovery response");
      reply.resolve(recovered);
      await f.time.flush();
      if (expired) {
        heartbeatReply.resolve(expired);
        await f.time.flush();
      }
      expect(f.slots.snapshot()).toEqual({ occupied: 1, limit: 1, holders: ["survivor"] });
      expect(secondStarted).toBe(false);
      for (let i = 0; i < 4; i++) {
        await f.time.advance(10_000);
        expect(f.slots.snapshot()).toEqual({ occupied: 1, limit: 1, holders: ["survivor"] });
        expect(secondStarted).toBe(false);
      }
    } finally {
      done.resolve();
      await first;
      await f.time.advance(250);
      await second;
    }
    expect(order).toEqual(["first exited", "second started"]);
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test("recovery responses arriving after work exits or times out retire the new lease", async () => {
  for (const timeout of [false, true]) {
    const f = rig();
    const done = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
    const warnings: string[] = [];
    let recovered: Awaited<ReturnType<LeaseClient>> | undefined;
    const work = withGateLease(
      "survivor",
      () => {
        started.resolve();
        return done.promise;
      },
      {
        ...f,
        warn: (s) => warnings.push(s),
        client: async (body, signal) => {
          const result = await f.client(body, signal);
          if (body.running) {
            recovered = result;
            return reply.promise;
          }
          return result;
        },
      },
    );
    await started.promise;
    const oldSlots = f.slots;
    f.slots = new Semaphore(1);
    await f.time.advance(10_000);
    expect(f.slots.snapshot().holders).toEqual(["survivor"]);
    const heartbeat = f.calls.find((body) => typeof body.id === "string" && !body.release);
    if (typeof heartbeat?.id === "string") oldSlots.heartbeat(heartbeat.id, true);
    if (timeout) {
      await f.time.advance(2000);
      expect(warnings.join()).toContain("timed out");
    }
    done.resolve();
    await work;
    if (!recovered) throw new Error("missing recovery response");
    reply.resolve(recovered);
    await f.time.flush();
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test.each(["retry reply", "late reply", "after exit", "transport late reply", "transport after exit"])(
  "agent recovery keeps heartbeats and retires delayed replies (%s)",
  async (mode) => {
    const f = rig();
    const options = {
      slots: { gate: f.slots, small: new Semaphore(1) },
      now: f.time.now,
      timer: f.time.timer.set,
      clear: f.time.timer.clear,
      caps: { gate: 180_000, small: 180_000 },
    };
    const session = new AgentTestSession(() => {}, options),
      competitor = new AgentTestSession(() => {}, options);
    const done = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>(),
      delayed = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
    let firstBeat = true,
      recoveries = 0,
      recovered: Awaited<ReturnType<LeaseClient>> | undefined;
    const adopted: string[] = [];
    const warnings: string[] = [];
    const client: LeaseClient = async (body) => {
      const result = await session.request({ ...body, token: session.token, lane: "gate" });
      if (body.running && ++recoveries === 1) {
        recovered = result;
        return delayed.promise;
      }
      if (body.running && mode !== "retry reply") throw new LeaseRejected("recovery reply rejected");
      return result;
    };
    const work = withGateLease(
      "survivor",
      () => {
        started.resolve();
        return done.promise;
      },
      {
        clock: {
          ...f.clock,
          timeout: (fn, ms) => {
            // Delay the first heartbeat past expiry, as on a stalled machine.
            if (firstBeat && ms === 10_000) {
              firstBeat = false;
              return f.clock.timeout(fn, 31_000);
            }
            return f.clock.timeout(fn, ms);
          },
        },
        agentTest: { lane: "gate", onLease: (id) => adopted.push(id) },
        warn: (message) => warnings.push(message),
        client: mode.startsWith("transport")
          ? wrapperLeaseClient(
              { commands: [], directory: "", port: 0, unix: "unused", token: session.token },
              f.clock,
              client,
              async () => {
                throw new Error("ECONNREFUSED socket");
              },
            )
          : client,
      },
    );
    try {
      await started.promise;
      await f.time.advance(30_000);
      expect(f.slots.snapshot().occupied).toBe(0);
      await f.time.advance(1000);
      expect(f.slots.snapshot().holders).toEqual(["survivor"]);
      await f.time.advance(2000);
      expect(warnings.join()).toContain("timed out");
      await f.time.advance(1000);
      expect(recoveries).toBe(2);
      if (!recovered) throw new Error("missing recovery response");
      if (mode.endsWith("after exit")) {
        done.resolve();
        await work;
      }
      delayed.resolve(recovered);
      await f.time.flush();
      if (!mode.endsWith("after exit")) {
        expect(adopted.at(-1)).toBe(recovered.id);
        for (let i = 0; i < 4; i++) {
          await f.time.advance(10_000);
          expect(f.slots.snapshot().holders).toEqual(["survivor"]);
          expect(
            await competitor.request({
              token: competitor.token,
              name: "second",
              lane: "gate",
              immediate: true,
            }),
          ).toMatchObject({ acquired: false });
        }
      }
      done.resolve();
      await work;
      expect(f.slots.snapshot().occupied).toBe(0);
    } finally {
      done.resolve();
      if (recovered) delayed.resolve(recovered);
      await work;
      session.close();
      competitor.close();
    }
    expect(f.time.pending).toBe(0);
  },
);

test("an abandoned queued lease admitted at 29 seconds still expires by 30 seconds", async () => {
  const f = rig();
  const release = await f.slots.acquire(signal, undefined, "first");
  const id = await f.slots.lease("abandoned", false, f.time.timer.set, f.time.timer.clear);
  const next = f.slots.acquire(signal, undefined, "next");
  await f.time.advance(29_000);
  release();
  await f.time.flush();
  expect(f.slots.snapshot().holders).toEqual(["abandoned"]);
  await f.time.advance(2000);
  expect(f.slots.snapshot().holders).toEqual(["next"]);
  expect(f.slots.heartbeat(id)).toBeUndefined();
  (await next)();
  expect(f.time.pending).toBe(0);
});

test("deadline and zero budget cancel before executing once; default budget is 1800 seconds", async () => {
  for (const maxWaitMs of [0, 500, undefined]) {
    const f = rig();
    const release = await f.slots.acquire(signal);
    let executions = 0;
    const warnings: string[] = [];
    const start = f.clock.now();
    expect(
      await withGateLease("land", async () => ++executions, {
        ...f,
        maxWaitMs,
        warn: (s) => warnings.push(s),
      }),
    ).toBe(1);
    expect(executions).toBe(1);
    expect(f.clock.now() - start).toBe(maxWaitMs ?? 1_800_000);
    expect(warnings.join()).toContain("deadline");
    release();
    await f.time.flush();
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
  const f = rig();
  await withGateLease(
    "immediate",
    async () => {
      expect(f.slots.snapshot().occupied).toBe(1);
    },
    { ...f, maxWaitMs: 0 },
  );
});

test("late acquisition responses are retired after bounded fallback", async () => {
  const f = rig();
  const late = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
  const warnings: string[] = [];
  let executions = 0;
  const work = withGateLease("late", async () => ++executions, {
    ...f,
    maxWaitMs: 2000,
    client: (body, signal) => (body.name ? late.promise : f.client(body, signal)),
    warn: (s) => warnings.push(s),
  });
  await f.time.advance(2000);
  expect(await work).toBe(1);
  const id = await f.slots.lease("late", false, f.time.timer.set, f.time.timer.clear);
  late.resolve({ id, acquired: true });
  await f.time.flush();
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(warnings.join()).toContain("deadline");
});

test("a failed waiting poll retries the same lease and starts only after acquisition", async () => {
  for (const timeout of [false, true]) {
    const f = rig();
    const release = await f.slots.acquire(signal, undefined, "pipeline");
    const warnings: string[] = [];
    let polls = 0,
      executions = 0;
    const requests: Record<string, unknown>[] = [];
    const work = withGateLease(
      "land",
      async () => {
        executions++;
        expect(f.slots.snapshot().holders).toEqual(["land"]);
      },
      {
        ...f,
        clock: { ...f.clock, sleep: (ms) => new Promise((resolve) => f.clock.timeout(resolve, ms)) },
        warn: (s) => warnings.push(s),
        client: (body, signal) => {
          requests.push(body);
          if (body.id && !body.release && ++polls === 1) {
            if (timeout) return new Promise(() => {});
            throw new Error("ECONNREFUSED");
          }
          return f.client(body, signal);
        },
      },
    );
    try {
      await f.time.flush();
      await f.time.advance(250);
      if (timeout) await f.time.advance(2000);
      expect(executions).toBe(0);
      expect(warnings).toEqual([]);
      release();
      await f.time.flush();
      await f.time.advance(250);
      await work;
      expect(executions).toBe(1);
      expect(polls).toBe(2);
      expect(requests[2]).toEqual(requests[1]);
      expect(warnings).toEqual([]);
    } finally {
      release();
    }
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test("failed polls fall back only after silence exceeds lease expiry or the wait deadline", async () => {
  for (const maxWaitMs of [500, 60_000]) {
    const f = rig();
    const release = await f.slots.acquire(signal);
    const warnings: string[] = [];
    const start = f.clock.now();
    let lastReply = start,
      executions = 0;
    try {
      await withGateLease(
        "land",
        async () => {
          executions++;
          const elapsed = f.clock.now() - start;
          if (maxWaitMs === 500) expect(elapsed).toBe(maxWaitMs);
          else {
            expect(f.clock.now() - lastReply).toBeGreaterThan(GATE_LEASE_EXPIRY_MS);
            expect(elapsed).toBeLessThan(maxWaitMs);
          }
        },
        {
          ...f,
          maxWaitMs,
          warn: (s) => warnings.push(s),
          client: (body, signal) => {
            if (!body.release && body.id && f.clock.now() - start >= (maxWaitMs === 500 ? 250 : 10_000))
              throw new DaemonTimeoutError();
            if (!body.release) lastReply = f.clock.now();
            return f.client(body, signal);
          },
        },
      );
      expect(executions).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(maxWaitMs === 500 ? "deadline" : "daemon is unreachable");
    } finally {
      release();
    }
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test("a refused first request falls back immediately with an unreachable warning", async () => {
  const f = rig();
  const warnings: string[] = [];
  const start = f.clock.now();
  let requests = 0;
  expect(
    await withGateLease("offline", async () => 7, {
      ...f,
      warn: (s) => warnings.push(s),
      client: async () => {
        requests++;
        throw new Error("ECONNREFUSED");
      },
    }),
  ).toBe(7);
  expect(requests).toBe(1);
  expect(f.clock.now()).toBe(start);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("daemon is unreachable");
  expect(warnings[0]).toContain("ECONNREFUSED");
  expect(f.time.pending).toBe(0);
});

test("a timed-out first registration is retired while its retry waits for acquisition", async () => {
  const f = rig();
  const release = await f.slots.acquire(signal, undefined, "pipeline");
  const late = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
  const warnings: string[] = [];
  let abandoned: Awaited<ReturnType<LeaseClient>> | undefined,
    registrations = 0,
    executions = 0;
  const work = withGateLease(
    "land",
    async () => {
      executions++;
      expect(f.slots.snapshot().holders).toEqual(["land"]);
    },
    {
      ...f,
      clock: { ...f.clock, sleep: (ms) => new Promise((resolve) => f.clock.timeout(resolve, ms)) },
      warn: (s) => warnings.push(s),
      client: async (body, signal) => {
        const result = await f.client(body, signal);
        if (body.name && ++registrations === 1) {
          abandoned = result;
          return late.promise;
        }
        return result;
      },
    },
  );
  try {
    await f.time.flush();
    await f.time.advance(2000);
    expect(executions).toBe(0);
    await f.time.advance(250);
    expect(registrations).toBe(2);
    if (!abandoned) throw new Error("missing first registration");
    late.resolve(abandoned);
    await f.time.flush();
    expect(f.slots.heartbeat(abandoned.id)).toBeUndefined();
    release();
    await f.time.flush();
    await f.time.advance(250);
    await work;
    expect(executions).toBe(1);
    expect(warnings).toEqual([]);
  } finally {
    release();
  }
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("CLI preserves arguments, environment, cwd and statuses; rejects invalid options and spawn errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-slot-"));
  try {
    for (const code of [0, 7]) {
      const f = rig(),
        file = join(dir, "args");
      const args = ["space here", "$(false); 'quoted'", "--max-wait", "-h"];
      expect(
        await gateSlotCommand(
          [
            "--name",
            "test",
            "--",
            process.execPath,
            "-e",
            'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH })); process.exit(0)',
            file,
            ...args,
          ],
          async (body, signal) => {
            // Exit status is tested separately below without modifying the shared environment.
            return f.client(body, signal);
          },
        ),
      ).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        args,
        cwd: process.cwd(),
        path: process.env.PATH,
      });
      expect(await gateSlotCommand(["--", process.execPath, "-e", `process.exit(${code})`], f.client)).toBe(
        code,
      );
      expect(f.slots.snapshot().occupied).toBe(0);
    }
    for (const args of [
      [],
      ["--"],
      ["true"],
      ["--max-wait", "-1", "--", "true"],
      ["--max-wait", "1.5", "--", "true"],
      ["--bad", "--", "true"],
    ]) {
      const f = rig();
      await expect(gateSlotCommand(args, f.client)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
    const f = rig();
    await expect(gateSlotCommand(["--", join(dir, "missing")], f.client)).rejects.toThrow();
    expect(f.slots.snapshot().occupied).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreachable and unsupported daemons warn; authorization and validation failures never bypass", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = spyOn(globalThis, "fetch");
  try {
    fetcher.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await gateSlotCommand(["--", "true"], localLeaseClient())).toBe(0);
    expect(warn.mock.calls.flat().join()).toContain("ECONNREFUSED");
    for (const payload of [
      "not json",
      "null",
      "{}",
      '{"id":"","acquired":true}',
      '{"id":"lease","acquired":true,"expired":true}',
      '{"id":"lease","acquired":true,"expired":"false"}',
    ]) {
      fetcher.mockResolvedValue(new Response(payload));
      let ran = false;
      await expect(
        withGateLease("check", async () => {
          ran = true;
        }),
      ).rejects.toThrow("invalid gate-slot");
      expect(ran).toBe(false);
    }
    for (const status of [404, 405, 501, 400, 401, 403, 415, 500]) {
      fetcher.mockResolvedValue(new Response(null, { status }));
      let ran = 0;
      const work = withGateLease("check", async () => ++ran);
      if ([404, 405, 501].includes(status)) expect(await work).toBe(1);
      else {
        await expect(work).rejects.toThrow(`HTTP ${status}`);
        expect(ran).toBe(0);
      }
    }
  } finally {
    fetcher.mockRestore();
    warn.mockRestore();
  }
});

test("interruption forwards only to the wrapper's child and releases the lease", async () => {
  const f = rig();
  const started = Promise.withResolvers<void>();
  const file = join(mkdtempSync(join(tmpdir(), "gate-slot-signal-")), "ready");
  const poll = setInterval(() => {
    try {
      readFileSync(file);
      started.resolve();
    } catch {}
  }, 10);
  const before = new Set(process.listeners("SIGTERM"));
  try {
    const work = gateSlotCommand(
      [
        "--",
        process.execPath,
        "-e",
        `const child = require("child_process").spawn(process.execPath, ["-e", process.argv[2], process.argv[1]], { stdio: "inherit" });
         process.on("SIGTERM", () => {});
         child.on("exit", () => process.exit(143));`,
        file,
        `const fs = require("fs"), file = process.argv[1];
         process.on("SIGTERM", () => { fs.writeFileSync(file, "terminated"); process.exit(0); });
         fs.writeFileSync(file, "ready"); setTimeout(() => process.exit(7), 3000);`,
      ],
      f.client,
    );
    await started.promise;
    const listener = process.listeners("SIGTERM").find((entry) => !before.has(entry));
    expect(listener).toBeDefined();
    process.emit("SIGTERM");
    expect(await work).toBe(143);
    expect(readFileSync(file, "utf8")).toBe("terminated");
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(process.listeners("SIGTERM")).not.toContain(listener);
  } finally {
    clearInterval(poll);
    rmSync(dirname(file), { recursive: true, force: true });
  }
});

test("CLI command waits behind a pipeline holder and starts once admitted", async () => {
  const f = rig();
  const release = await f.slots.acquire(signal, undefined, "run-pipeline");
  const waiting = Promise.withResolvers<void>();
  const dir = mkdtempSync(join(tmpdir(), "gate-slot-command-"));
  const output = join(dir, "started");
  try {
    const work = gateSlotCommand(
      ["--", process.execPath, "-e", 'require("fs").writeFileSync(process.argv[1], "ran")', output],
      async (body, signal) => {
        const reply = await f.client(body, signal);
        if (!reply.acquired) waiting.resolve();
        return reply;
      },
    );
    await waiting.promise;
    expect(() => readFileSync(output)).toThrow();
    expect(f.slots.snapshot().holders).toEqual(["run-pipeline"]);
    release();
    expect(await work).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("ran");
    expect(f.slots.snapshot().occupied).toBe(0);
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordination loss after startup warns without interrupting or restarting work", async () => {
  const f = rig();
  let runs = 0;
  const warnings: string[] = [];
  await withGateLease(
    "deploy",
    async () => {
      runs++;
      await f.time.advance(10_000);
      expect(warnings.join()).toContain("disconnected");
    },
    {
      ...f,
      warn: (s) => warnings.push(s),
      client: (body, signal) => {
        if (body.id && !body.release) throw new Error("disconnected");
        return f.client(body, signal);
      },
    },
  );
  expect(runs).toBe(1);
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("cancellation while waiting retires the reservation before rejecting", async () => {
  const f = rig(),
    controller = new AbortController();
  const release = await f.slots.acquire(signal);
  try {
    await expect(
      withGateLease(
        "cancelled",
        async () => {
          throw new Error("must not run");
        },
        {
          ...f,
          signal: controller.signal,
          client: async (body, signal) => {
            const reply = await f.client(body, signal);
            if (body.name) controller.abort(new Error("interrupted while waiting"));
            return reply;
          },
        },
      ),
    ).rejects.toThrow("interrupted while waiting");
  } finally {
    release();
  }
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("main dispatches gate-slot and warns on an injected connection refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-slot-main-"));
  try {
    const preload = join(dir, "offline.ts");
    await Bun.write(preload, 'globalThis.fetch = async () => { throw new Error("ECONNREFUSED-test"); };');
    const child = Bun.spawn(
      [process.execPath, "--preload", preload, "src/cli/main.ts", "gate-slot", "--", "true"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toContain("warning: gate-slot");
    const streams = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(process.cwd(), "src/cli/main.ts"),
        "gate-slot",
        "--",
        process.execPath,
        "-e",
        'process.stdout.write(require("fs").readFileSync(0)); process.stderr.write("child-stderr"); process.exit(7)',
      ],
      { cwd: dir, stdin: new Blob(["literal stdin $()"]), stdout: "pipe", stderr: "pipe" },
    );
    expect(await streams.exited).toBe(7);
    expect(await new Response(streams.stdout).text()).toBe("literal stdin $()");
    expect(await new Response(streams.stderr).text()).toContain("child-stderr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
