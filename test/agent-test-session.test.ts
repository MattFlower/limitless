import { afterEach, expect, spyOn, test } from "bun:test";
import { AgentTestSession, type TestWait } from "../src/gates/agent-tests.ts";
import { Semaphore } from "../src/gates/slots.ts";
import { waitClock } from "./wait-clock.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function rig() {
  const time = waitClock(),
    slots = { gate: new Semaphore(1), small: new Semaphore(1) };
  const events: TestWait[] = [];
  const session = new AgentTestSession((event) => events.push(event), {
    slots,
    now: time.now,
    timer: time.timer.set,
    clear: time.timer.clear,
    caps: { gate: 90_000, small: 60_000 },
  });
  cleanup.push(() => session.close());
  const request = (body: Record<string, unknown>) => session.request({ token: session.token, ...body });
  const command = { name: "bun test a.test.ts", lane: "small" };
  return { time, slots, events, session, request, command };
}

test("running claims require this invocation's acquired, heartbeat-expired lease", async () => {
  const f = rig(),
    other = rig();
  const foreign = await other.request(other.command);
  for (const recover of [undefined, "forged", foreign.id]) {
    await expect(f.request({ ...f.command, running: true, recover })).rejects.toThrow("recovery");
    expect(f.slots.small.snapshot().occupied).toBe(0);
  }
  const own = await f.request(f.command);
  await expect(f.request({ ...f.command, running: true, recover: own.id })).rejects.toThrow("recovery");
  expect(f.slots.small.snapshot().occupied).toBe(1);
  await f.request({ id: own.id, release: true });
  await expect(f.request({ ...f.command, running: true, recover: own.id })).rejects.toThrow("recovery");
  expect(f.slots.small.snapshot().occupied).toBe(0);
});

test.each([false, true])(
  "one lease per lane even with 100 simultaneous requests (queued=%s)",
  async (queued) => {
    const f = rig();
    const release = queued ? await f.slots.small.acquire(new AbortController().signal) : () => {};
    const lease = spyOn(f.slots.small, "lease");
    cleanup.push(() => lease.mockRestore());
    try {
      const first = await f.request(f.command);
      expect(first.acquired).toBe(!queued);
      const replies = await Promise.all(Array.from({ length: 100 }, () => f.request(f.command)));
      expect(replies.every((reply) => "busy" in reply && reply.busy === true)).toBe(true);
      expect(lease).toHaveBeenCalledTimes(1);
      expect(f.slots.small.snapshot().occupied).toBe(1);
      const gate = await f.request({ name: "bun test", lane: "gate" });
      expect(gate.acquired).toBe(true);
      f.session.close();
      release();
      await f.time.flush();
      expect(f.slots.small.snapshot().occupied).toBe(0);
      expect(f.slots.gate.snapshot().occupied).toBe(0);
      expect(f.time.pending).toBe(0);
      for (const body of [
        f.command,
        { id: first.id },
        { ...f.command, running: true, recover: first.id },
        { reuse: gate.id, lane: "small" },
      ])
        await expect(f.request(body)).rejects.toThrow("capability");
    } finally {
      release();
    }
  },
);

test("heartbeats cannot extend the total duration cap and capped leases cannot recover", async () => {
  const f = rig(),
    lease = await f.request(f.command);
  for (let i = 0; i < 2; i++) {
    await f.time.advance(20_000);
    expect(await f.request({ id: lease.id })).toMatchObject({ acquired: true });
  }
  await f.time.advance(20_000);
  expect(f.slots.small.snapshot().occupied).toBe(0);
  expect(await f.request({ id: lease.id })).toMatchObject({
    acquired: false,
    expired: true,
    capped: true,
    capMs: 60_000,
  });
  await expect(f.request({ ...f.command, running: true, recover: lease.id })).rejects.toThrow();
  expect(f.events).toContainEqual({
    kind: "agent-test",
    phase: "capped",
    command: f.command.name,
    lane: "small",
    capMs: 60_000,
  });
  expect(f.time.pending).toBe(0);
});

test("heartbeat recovery keeps the acquisition time, cannot repeat, and cannot change lanes", async () => {
  const f = rig(),
    lease = await f.request(f.command);
  await f.time.advance(30_000);
  expect(f.slots.small.snapshot().occupied).toBe(0);
  await expect(
    f.request({ name: "bun test", lane: "gate", running: true, recover: lease.id }),
  ).rejects.toThrow();
  const recovered = await f.request({ ...f.command, running: true, recover: lease.id });
  expect(recovered.acquired).toBe(true);
  await expect(f.request({ ...f.command, running: true, recover: lease.id })).rejects.toThrow();
  await f.time.advance(20_000);
  await f.request({ id: recovered.id });
  await f.time.advance(10_000);
  expect(await f.request({ id: recovered.id })).toMatchObject({ capped: true, acquired: false });
  expect(f.slots.small.snapshot().occupied).toBe(0);
  expect(f.events.filter((event) => event.phase === "capped")).toHaveLength(1);
});

test("a queued lease that never acquired is not recoverable", async () => {
  const f = rig(),
    release = await f.slots.small.acquire(new AbortController().signal);
  try {
    const lease = await f.request(f.command);
    await f.time.advance(30_000);
    await expect(f.request({ ...f.command, running: true, recover: lease.id })).rejects.toThrow();
    release();
    await f.time.flush();
    expect(f.slots.small.snapshot().occupied).toBe(0);
  } finally {
    release();
  }
});

test("nested confirmation checks ownership, acquisition, expiry and lane coverage", async () => {
  const f = rig(),
    other = rig();
  const small = await f.request(f.command),
    foreign = await other.request(other.command);
  for (const reuse of ["forged", foreign.id, small.id]) {
    expect(await f.request({ reuse, lane: "gate" })).toMatchObject({ reused: false, acquired: false });
  }
  expect(await f.request({ reuse: small.id, lane: "small" })).toMatchObject({ reused: true });
  const gate = await f.request({ name: "bun test", lane: "gate" });
  for (const lane of ["gate", "small"])
    expect(await f.request({ reuse: gate.id, lane })).toMatchObject({ reused: true });
  await f.request({ id: small.id, release: true });
  expect(await f.request({ reuse: small.id, lane: "small" })).toMatchObject({ reused: false });
  await f.time.advance(30_000);
  expect(await f.request({ reuse: gate.id, lane: "small" })).toMatchObject({ reused: false });
});

test("close during registration releases the eventual lease and refuses the response", async () => {
  const f = rig();
  const request = f.request(f.command);
  f.session.close();
  await expect(request).rejects.toThrow("capability");
  expect(f.slots.small.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("waits within an invocation emit one wait and acquisition with the full wait duration", async () => {
  const f = rig();
  const first = await f.request(f.command);
  const second = { ...f.command, waiter: "second" };
  expect(await f.request(second)).toMatchObject({ busy: true });
  await f.time.advance(1000);
  expect(await f.request(second)).toMatchObject({ busy: true });
  await f.request({ id: first.id, release: true });
  expect((await f.request(second)).acquired).toBe(true);
  expect(f.events).toEqual([
    { kind: "agent-test", phase: "wait", command: f.command.name, lane: "small" },
    { kind: "agent-test", phase: "acquired", command: f.command.name, lane: "small", waitMs: 1000 },
  ]);
});
