import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
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
  const identities = new Map<number, string | null | undefined | Error>();
  const pids = new Map<string, number>();
  const connections = new Map<string, Database>();
  const deadlines = new Map<string, Map<ReturnType<typeof setTimeout>, number>>();
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pool = (owner: string, key = "gate", limit = 1, timers = clock.timer) => {
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout = 0");
    const pid = pids.size + 1;
    pids.set(owner, pid);
    identities.set(pid, `birth-${owner}`);
    connections.set(owner, db);
    const scheduled = new Map<ReturnType<typeof setTimeout>, number>();
    deadlines.set(owner, scheduled);
    const slots = new DatabaseSlotPool(db, key, limit, {
      owner,
      pid,
      inspect: (pid) => {
        const identity = identities.get(pid);
        if (identity instanceof Error) throw identity;
        return identity;
      },
      now: clock.now,
      timer: (callback, ms) => {
        const id = timers.set(() => {
          scheduled.delete(id);
          callback();
        }, ms);
        scheduled.set(id, clock.now() + ms);
        return id;
      },
      clear: (id) => {
        scheduled.delete(id as ReturnType<typeof setTimeout>);
        timers.clear(id as ReturnType<typeof setTimeout>);
      },
    });
    cleanups.push(() => {
      slots.close();
      db.close();
    });
    return slots;
  };
  return { clock, pool, store, identities, pids, connections, deadlines };
}

test("polling and owner renewal recover after a database write lock", async () => {
  const { clock, pool, store } = setup();
  const a = pool("a"),
    b = pool("b");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  const release = await a.acquire(signal, undefined, "live");
  let acquired = false;
  const pending = b.acquire(signal, undefined, "waiting").then((free) => {
    acquired = true;
    return free;
  });
  store.db.exec("BEGIN IMMEDIATE");
  try {
    await clock.advance(10_000);
    expect(warn).toHaveBeenCalledTimes(3); // Two owner renewals and the waiter's poll.
    expect(acquired).toBe(false);
  } finally {
    store.db.exec("ROLLBACK");
  }
  await clock.advance(10_000);
  expect(store.db.query("SELECT renewed_at FROM slot_requests WHERE holder = 'live'").get()).toEqual({
    renewed_at: clock.now(),
  });
  for (let i = 0; i < 4; i++) await clock.advance(10_000);
  expect(acquired).toBe(false);
  expect(b.snapshot().holders).toEqual(["live"]);
  release();
  await clock.advance(250);
  expect(acquired).toBe(true);
  (await pending)();
});

test("lease expiry retries a database write lock without losing its cleanup timer", async () => {
  const { clock, pool, store } = setup();
  const a = pool("a");
  const leaseClock = waitClock();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  const id = await a.lease("deploy", false, leaseClock.timer.set, leaseClock.timer.clear);
  let acquired = false;
  const pending = a.acquire(signal, undefined, "waiting").then((free) => {
    acquired = true;
    return free;
  });
  store.db.exec("BEGIN IMMEDIATE");
  try {
    await clock.advance(GATE_LEASE_EXPIRY_MS);
    await leaseClock.advance(GATE_LEASE_EXPIRY_MS);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(leaseClock.pending).toBe(1);
    expect(acquired).toBe(false);
  } finally {
    store.db.exec("ROLLBACK");
  }
  await leaseClock.advance(250);
  expect(leaseClock.pending).toBe(0);
  expect(acquired).toBe(true);
  expect(a.heartbeat(id)).toBeUndefined();
  expect(a.snapshot().holders).toEqual(["waiting"]);
  (await pending)();
  await clock.flush();
});

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

test.each([null, "reused-pid"])(
  "live owners survive stalls and inspection failures until death or PID reuse (%s)",
  async (dead) => {
    const { clock, pool, identities, pids, store } = setup();
    const stalled = waitClock();
    const a = pool("a", "gate", 1, stalled.timer),
      b = pool("b");
    const pid = pids.get("a") ?? 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    const release = await a.acquire(signal, undefined, "live");
    const localWaiter = a.acquire(signal, undefined, "live waiter").catch((error: unknown) => error);
    let acquired = false;
    const pending = b.acquire(signal, undefined, "waiting").then((free) => {
      acquired = true;
      return free;
    });
    for (let i = 0; i < 7; i++) await clock.advance(10_000);
    expect(acquired).toBe(false);
    expect(b.snapshot().holders).toEqual(["live"]);
    expect(
      store.db.query("SELECT holder FROM slot_requests WHERE owner = 'a' AND state = 'waiting'").all(),
    ).toEqual([{ holder: "live waiter" }]);
    a.close();
    for (let i = 0; i < 3; i++) await clock.advance(10_000);
    expect(acquired).toBe(false); // Closing a pool does not prove that its process exited.
    for (const failure of [new Error("inspection denied"), undefined, ""]) {
      identities.set(pid, failure);
      await clock.advance(GATE_LEASE_EXPIRY_MS + 1);
      expect(acquired).toBe(false);
      expect(b.snapshot().holders).toEqual(["live"]);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("preserving reservations"));
    identities.set(pid, dead);
    await clock.advance(250);
    expect(acquired).toBe(true);
    expect(b.snapshot().holders).toEqual(["waiting"]);
    release(); // A dead holder cannot release another owner's slot.
    expect(await localWaiter).toEqual(new Error("Slot expired"));
    expect(b.snapshot().occupied).toBe(1);
    (await pending)();
  },
);

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

test("a restart adopts a waiting lease in place and stale owner callbacks cannot release it", async () => {
  const { clock, pool, store } = setup();
  const oldTimers = waitClock();
  const a = pool("old", "gate", 1, oldTimers.timer),
    b = pool("replacement");
  const blocker = await b.acquire(signal, undefined, "blocker");
  const id = await a.lease("queued");
  const original = store.db
    .query("SELECT id, seq, requested_at, priority, state FROM slot_requests WHERE id = ?")
    .get(id);
  const later = await b.lease("later");
  await clock.advance(10_000);
  expect(b.heartbeat(id)).toBe(false);
  expect(
    store.db.query("SELECT id, seq, requested_at, priority, state FROM slot_requests WHERE id = ?").get(id),
  ).toEqual(original);
  await oldTimers.advance(GATE_LEASE_EXPIRY_MS); // Includes the old waiter's callback and expiry.
  expect(b.heartbeat(id)).toBe(false);
  const cancelled = await b.lease("cancelled");
  expect(a.heartbeat(cancelled, true)).toBe(false); // Cross-owner release of a waiting lease.
  const ordinary = store.db
    .query<{ id: string }, []>("SELECT id FROM slot_requests WHERE holder = 'blocker'")
    .get();
  expect(b.heartbeat(ordinary?.id ?? "", true)).toBeUndefined();
  expect(b.snapshot().holders).toEqual(["blocker"]);
  blocker();
  expect(b.heartbeat(id)).toBe(true);
  expect(b.heartbeat(later)).toBe(false);
  expect(b.snapshot().holders).toEqual(["queued"]);
  expect(a.heartbeat(id, true)).toBe(true); // Cross-owner release after admission.
  expect(b.heartbeat(later)).toBe(true);
  b.heartbeat(later, true);
  expect(b.snapshot().occupied).toBe(0);
  expect(b.heartbeat(id)).toBeUndefined();
});

test("an adopted waiting lease expires without heartbeat independently of owner renewal", async () => {
  const { clock, pool } = setup();
  const a = pool("old"),
    b = pool("replacement");
  const blocker = await b.acquire(signal);
  const id = await a.lease("queued");
  expect(b.heartbeat(id)).toBe(false);
  for (let i = 0; i < 3; i++) await clock.advance(10_000);
  expect(b.heartbeat(id)).toBeUndefined();
  blocker();
  expect(b.snapshot().occupied).toBe(0);
});

test("idle instances do no transactions; only waiters poll and only owners renew", async () => {
  const { clock, pool, connections, deadlines, store } = setup();
  const a = pool("a"),
    b = pool("b");
  const dbA = connections.get("a"),
    dbB = connections.get("b");
  if (!dbA || !dbB) throw new Error("Missing test connections");
  const txA = spyOn(dbA, "transaction"),
    txB = spyOn(dbB, "transaction");
  cleanups.push(() => {
    txA.mockRestore();
    txB.mockRestore();
  });
  const remaining = (owner: string) =>
    [...(deadlines.get(owner)?.values() ?? [])].map((at) => at - clock.now()).sort((a, b) => a - b);
  for (let i = 0; i < 4; i++) await clock.advance(10_000);
  expect(clock.pending).toBe(0);
  expect(txA).not.toHaveBeenCalled();
  expect(txB).not.toHaveBeenCalled();
  const first = await a.acquire(signal);
  const controller = new AbortController();
  const cancelled = b.acquire(controller.signal).catch((error: unknown) => error);
  expect(remaining("a")).toEqual([10_000]);
  expect(remaining("b")).toEqual([250, 10_000]);
  txA.mockClear();
  txB.mockClear();
  await clock.advance(249);
  expect(txA).not.toHaveBeenCalled();
  expect(txB).not.toHaveBeenCalled();
  await clock.advance(1);
  expect(txA).not.toHaveBeenCalled();
  expect(txB).toHaveBeenCalledTimes(1);
  await clock.advance(9_750);
  expect(txA).toHaveBeenCalledTimes(1); // The holder renews once at 10 seconds.
  expect(store.db.query("SELECT DISTINCT renewed_at FROM slot_requests").all()).toEqual([
    { renewed_at: clock.now() },
  ]);
  controller.abort("cancel");
  expect(await cancelled).toBe("cancel");
  expect(remaining("b")).toEqual([]);
  txB.mockClear();
  await clock.advance(250);
  expect(txB).not.toHaveBeenCalled();
  const local = a.acquire(signal);
  expect(remaining("a")[0]).toBe(250);
  first();
  const release = await local; // Same-process release admits without a timer tick.
  expect(remaining("a")).toHaveLength(1);
  expect(remaining("a")[0]).toBeGreaterThan(250);
  release();
  expect(clock.pending).toBe(0);
  txA.mockClear();
  await clock.advance(30_000);
  expect(txA).not.toHaveBeenCalled();
  expect(txB).not.toHaveBeenCalled();
});

test("polling stops after cross-connection admission and close cancels all timers", async () => {
  const { clock, pool, deadlines } = setup();
  const a = pool("a"),
    b = pool("b");
  const release = await a.acquire(signal);
  const next = b.acquire(signal);
  release();
  await clock.advance(250);
  const free = await next;
  expect([...(deadlines.get("b")?.values() ?? [])]).toEqual([clock.now() + 9_750]);
  free();
  expect(clock.pending).toBe(0);
  const id = await a.lease("external");
  expect(clock.pending).toBe(2);
  a.close();
  expect(clock.pending).toBe(0);
  expect(b.heartbeat(id)).toBe(true);
  b.heartbeat(id, true);
  expect(clock.pending).toBe(0);
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
  const { store } = setup();
  const previous = [gateSlots, agentTestSlots];
  const detach = await attachSlotPools(store.db, 3);
  cleanups.push(detach);
  const other = new DatabaseSlotPool(store.db, "gate", 1);
  cleanups.push(() => other.close());
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
      filter: (src) => !src.endsWith("-shared-slot-pools.sql") && !src.endsWith("-slot-process-identity.sql"),
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

test("process identity migration preserves capacity, lease FIFO and previous-schema writes", () => {
  const root = mkdtempSync(join(tmpdir(), "slot-identity-upgrade-")),
    path = join(root, "db");
  const before = join(root, "before");
  cpSync(MIGRATION_DIR, before, {
    recursive: true,
    filter: (src) => !src.endsWith("-slot-process-identity.sql"),
  });
  const previous = new Store(path, before);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = waitClock();
  const writeOldRequest = (db: Database, id: string, state: string, lease: number | null) =>
    db
      .query(
        `INSERT INTO slot_requests
      (id, pool, owner, holder, priority, state, requested_at, renewed_at, lease_until, held_order)
      VALUES (?, 'gate', 'legacy', ?, 'finish', ?, ?, ?, ?, 1)`,
      )
      .run(id, id, state, clock.now(), clock.now() - GATE_LEASE_EXPIRY_MS * 2, lease);
  previous.db.query("INSERT INTO slot_pools (pool, capacity) VALUES ('gate', 1)").run();
  writeOldRequest(previous.db, "legacy-holder", "held", null);
  writeOldRequest(previous.db, "first", "waiting", clock.now() + GATE_LEASE_EXPIRY_MS);
  writeOldRequest(previous.db, "second", "waiting", clock.now() + GATE_LEASE_EXPIRY_MS);
  const original = previous.db
    .query<Record<string, unknown>, []>("SELECT * FROM slot_requests ORDER BY seq")
    .all();
  previous.close();
  const upgraded = new Store(path);
  cleanups.push(() => upgraded.close());
  expect(upgraded.db.query("SELECT capacity FROM slot_pools WHERE pool = 'gate'").get()).toEqual({
    capacity: 1,
  });
  expect(upgraded.db.query("SELECT * FROM slot_requests ORDER BY seq").all()).toEqual(
    original.map((row) => ({ ...row, owner_pid: null, owner_birth: null })),
  );
  const older = new Store(path, before);
  try {
    writeOldRequest(older.db, "third", "waiting", clock.now() + GATE_LEASE_EXPIRY_MS);
    older.db.query("UPDATE slot_pools SET capacity = 1 WHERE pool = 'gate'").run();
  } finally {
    older.close();
  }
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  const slots = new DatabaseSlotPool(upgraded.db, "gate", 9, {
    now: clock.now,
    timer: clock.timer.set,
    clear: clock.timer.clear,
  });
  cleanups.push(() => slots.close());
  expect(slots.limit).toBe(1);
  expect(slots.snapshot().holders).toEqual(["legacy-holder"]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing recorded process identity"));
  expect(slots.heartbeat("first")).toBe(false);
  upgraded.db.query("DELETE FROM slot_requests WHERE id = 'legacy-holder'").run();
  expect(slots.heartbeat("first")).toBe(true);
  expect(slots.heartbeat("second")).toBe(false);
  expect(slots.heartbeat("first", true)).toBe(true);
  expect(slots.snapshot().holders).toEqual(["second"]);
  expect(slots.heartbeat("second", true)).toBe(true);
  expect(slots.snapshot().holders).toEqual(["third"]);
  slots.heartbeat("third", true);
  expect(slots.snapshot().occupied).toBe(0);
});
