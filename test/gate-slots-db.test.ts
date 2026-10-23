import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { Store } from "../src/db/store.ts";
import {
  agentTestSlots,
  attachSlotPools,
  DatabaseSlotPool,
  GATE_LEASE_EXPIRY_MS,
  gateSlots,
} from "../src/gates/slots.ts";
import { waitClock } from "./wait-clock.ts";

const signal = new AbortController().signal;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "db-slots-"));
  const path = join(root, "db");
  const store = new Store(path);
  const clock = waitClock();
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pool = (owner: string, key = "gate", limit = 1) => {
    const db = new Database(path);
    const slots = new DatabaseSlotPool(db, key, limit, {
      owner,
      now: clock.now,
      timer: clock.timer.set,
      clear: clock.timer.clear,
    });
    cleanups.push(() => {
      slots.close();
      db.close();
    });
    return slots;
  };
  return { clock, pool, store };
}

test("connections share capacity, wake on polling, and release exactly once", async () => {
  const { clock, pool } = setup();
  const a = pool("a"),
    b = pool("b");
  const first = await a.acquire(signal, undefined, "first");
  const waits: number[] = [];
  let second: (() => void) | undefined, third: (() => void) | undefined;
  void b
    .acquire(signal, (n) => waits.push(n), "second")
    .then((free) => {
      second = free;
    });
  void b.acquire(signal, undefined, "third").then((free) => {
    third = free;
  });
  await clock.flush();
  expect(waits).toEqual([1]);
  expect(second).toBeUndefined();
  expect(a.snapshot()).toEqual({ occupied: 1, limit: 1, holders: ["first"] });
  first();
  await clock.advance(250);
  expect(second).toBeFunction();
  first();
  await clock.advance(250);
  expect(third).toBeUndefined();
  second?.();
  await clock.flush();
  expect(third).toBeFunction(); // Same-instance release wakes without a poll.
  third?.();
  expect(b.snapshot().occupied).toBe(0);
});

test("global priority and FIFO survive equal request timestamps", async () => {
  const { clock, pool } = setup();
  const a = pool("a"),
    b = pool("b");
  const held = await a.acquire(signal);
  const order: string[] = [];
  const queue = (slots: DatabaseSlotPool, name: string, priority: "ship" | "finish" | "start") =>
    slots.acquire(signal, undefined, name, false, priority).then((free) => {
      order.push(name);
      return free;
    });
  const start = queue(a, "start", "start");
  const finish1 = queue(a, "finish1", "finish");
  const finish2 = queue(b, "finish2", "finish");
  const ship = queue(b, "ship", "ship");
  held();
  await clock.advance(250);
  expect(order).toEqual(["ship"]);
  (await ship)();
  await clock.advance(250);
  expect(order).toEqual(["ship", "finish1"]);
  (await finish1)();
  await clock.advance(250);
  expect(order).toEqual(["ship", "finish1", "finish2"]);
  (await finish2)();
  await clock.advance(250);
  expect(order).toEqual(["ship", "finish1", "finish2", "start"]);
  (await start)();
});

test("dead owners expire while renewing owners keep their held and waiting rows", async () => {
  const { clock, pool } = setup();
  const a = pool("a"),
    b = pool("b");
  const release = await a.acquire(signal, undefined, "live");
  let acquired = false;
  const pending = b.acquire(signal, undefined, "waiting").then((free) => {
    acquired = true;
    return free;
  });
  for (let i = 0; i < 7; i++) await clock.advance(10_000);
  expect(acquired).toBe(false);
  expect(b.snapshot().holders).toEqual(["live"]);
  a.close();
  for (let i = 0; i < 3; i++) await clock.advance(10_000);
  expect(acquired).toBe(true);
  expect(b.snapshot().holders).toEqual(["waiting"]);
  release(); // An expired holder cannot release another owner's slot.
  expect(b.snapshot().occupied).toBe(1);
  (await pending)();
});

test("a restart adopts a heartbeating external lease and ignores stale expiry timers", async () => {
  const { clock, pool } = setup();
  const a = pool("a");
  const id = await a.lease("deploy");
  await clock.advance(10_000);
  const c = pool("new-boot");
  expect(c.snapshot()).toEqual({ occupied: 1, limit: 1, holders: ["deploy"] });
  expect(c.heartbeat(id)).toBe(true);
  let acquired = false;
  const pending = c.acquire(signal, undefined, "gate").then((free) => {
    acquired = true;
    return free;
  });
  for (let i = 0; i < 7; i++) {
    await clock.advance(10_000);
    expect(c.heartbeat(id)).toBe(true);
    expect(c.snapshot().holders).toEqual(["deploy"]);
    expect(acquired).toBe(false);
  }
  a.close();
  expect(c.heartbeat(id, true)).toBe(true);
  await clock.flush();
  expect(acquired).toBe(true);
  expect(c.heartbeat(id)).toBeUndefined();
  (await pending)();
});

test("graceful close preserves external leases and per-lease expiry ignores owner renewal", async () => {
  const { clock, pool } = setup();
  const a = pool("a");
  const id = await a.lease("deploy");
  a.close();
  const b = pool("b");
  expect(b.heartbeat(id)).toBe(true);
  for (let i = 0; i < 3; i++) await clock.advance(10_000);
  expect(b.heartbeat(id)).toBeUndefined();
  expect(b.snapshot().occupied).toBe(0);
  expect(await b.lease("new-deploy")).toBeString();
  for (let i = 0; i < 3; i++) await clock.advance(10_000);
  expect(b.snapshot().occupied).toBe(0);
});

test("stored limits, independent pools, running recovery and held admission order", async () => {
  const { clock, pool } = setup();
  const a = pool("a");
  a.setLimit(3);
  const b = pool("b");
  expect(b.limit).toBe(3);
  expect(b.snapshot().limit).toBe(3);
  const releases = [await a.acquire(signal, undefined, "a"), await b.acquire(signal, undefined, "b")];
  b.setLimit(0);
  releases.push(await b.acquire(signal, undefined, "recovered", true));
  expect(a.snapshot()).toEqual({ occupied: 3, limit: 1, holders: ["a", "b", "recovered"] });
  const small = pool("small", "agent-test", 2);
  const freeSmall = await small.acquire(signal, undefined, "targeted");
  expect(small.snapshot()).toEqual({ occupied: 1, limit: 2, holders: ["targeted"] });
  let ready = false;
  const next = a.acquire(signal, undefined, "next").then((free) => {
    ready = true;
    return free;
  });
  a.setLimit(4);
  await clock.flush();
  expect(ready).toBe(true);
  for (const free of releases) free();
  (await next)();
  freeSmall();
});

test("queued abort removes its row before another owner's lower-priority waiter is admitted", async () => {
  const { clock, pool } = setup();
  const a = pool("a"),
    b = pool("b");
  const held = await a.acquire(signal);
  const controller = new AbortController();
  const cancelled = a.acquire(controller.signal, undefined, "cancelled", false, "ship");
  const rejection = cancelled.catch((reason: unknown) => reason);
  const start = b.acquire(signal, undefined, "start", false, "start");
  controller.abort("cancel reason");
  held();
  expect(a.snapshot().holders).toEqual(["start"]);
  await clock.advance(250);
  expect(await rejection).toBe("cancel reason");
  (await start)();
  expect(b.snapshot().occupied).toBe(0);
});

test("abort during onWait and immediately after admission releases the reservation", async () => {
  const { clock, pool } = setup();
  const a = pool("a");
  const held = await a.acquire(signal);
  const before = new AbortController();
  const beforeResult = a
    .acquire(before.signal, () => before.abort("before"))
    .catch((reason: unknown) => reason);
  expect(await beforeResult).toBe("before");
  const after = new AbortController();
  const afterResult = a.acquire(after.signal).catch((reason: unknown) => reason);
  held();
  after.abort("after");
  expect(await afterResult).toBe("after");
  await clock.flush();
  expect(a.snapshot().occupied).toBe(0);
});

test("coordinator attachment uses shared pools and detaches without affecting in-memory clients", async () => {
  const { pool, store } = setup();
  const previous = [gateSlots, agentTestSlots];
  const detach = await attachSlotPools(store.db, 3);
  cleanups.push(detach);
  const other = pool("executor");
  expect(other.limit).toBe(3);
  const release = await other.acquire(signal, undefined, "executor gate");
  expect(gateSlots.snapshot()).toEqual({ occupied: 1, limit: 3, holders: ["executor gate"] });
  expect(agentTestSlots.snapshot()).toEqual({ occupied: 0, limit: 2, holders: [] });
  release();
  detach();
  expect([gateSlots, agentTestSlots]).toEqual(previous);
});

test("waiting leases heartbeat, expire and support immediate probes and observers", async () => {
  const { clock, pool } = setup();
  const a = pool("a"),
    b = pool("b");
  const free = await a.acquire(signal);
  const events: string[] = [];
  const id = await b.lease("queued", false, undefined, undefined, false, {
    onWait: () => events.push("wait"),
    onAcquired: () => events.push("acquired"),
  });
  expect(b.heartbeat(id)).toBe(false);
  const probe = await b.lease("probe", true);
  expect(b.heartbeat(probe)).toBeUndefined();
  free();
  await clock.advance(250);
  expect(events).toEqual(["wait", "acquired"]);
  expect(b.heartbeat(id)).toBe(true);
  await clock.advance(GATE_LEASE_EXPIRY_MS);
  expect(b.heartbeat(id)).toBeUndefined();
  const immediate = await b.lease("available", true);
  expect(b.heartbeat(immediate, true)).toBe(true);
  const remote = await a.lease("remote-release");
  expect(b.heartbeat(remote, true)).toBe(true);
  expect(a.heartbeat(remote)).toBeUndefined();
});

test("snapshots list holders in admission order when priority overtakes request order", async () => {
  const { clock, pool } = setup();
  const a = pool("a"),
    b = pool("b");
  const first = await a.acquire(signal, undefined, "first");
  const low = a.acquire(signal, undefined, "start", false, "start");
  const high = b.acquire(signal, undefined, "ship", false, "ship");
  a.setLimit(3);
  expect(a.snapshot()).toEqual({ occupied: 3, limit: 3, holders: ["first", "ship", "start"] });
  await clock.advance(250);
  first();
  (await high)();
  (await low)();
});

test("additive migration upgrades a database written by the previous release", () => {
  const root = mkdtempSync(join(tmpdir(), "slot-upgrade-")),
    path = join(root, "db");
  try {
    const before = join(root, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-shared-slot-pools.sql"),
    });
    const previous = new Store(path, before);
    expect(previous.db.query("SELECT name FROM sqlite_master WHERE name = 'slot_requests'").get()).toBeNull();
    previous.close();
    const upgraded = new Store(path);
    expect(upgraded.db.query("SELECT name FROM sqlite_master WHERE name = 'slot_requests'").get()).toEqual({
      name: "slot_requests",
    });
    upgraded.close();
    new Store(path, before).close(); // The older release can still open the upgraded database.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
