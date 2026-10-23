import type { Database, SQLQueryBindings } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";
import { processBirthSync, redactCredentials } from "../util/proc.ts";

export const GATE_LEASE_EXPIRY_MS = 30_000;
export type GatePriority = "ship" | "finish" | "start";
export const isGatePriority = (value: unknown): value is GatePriority =>
  value === "ship" || value === "finish" || value === "start";

/** A full gate suite is CPU-heavy, so by default one suite runs per four cores. */
export function defaultGateSlots(cores = availableParallelism()): number {
  return Math.max(1, Math.floor(cores / 4));
}

/** Priority counting semaphore, FIFO within each class; held slots are never interrupted. */
export class Semaphore {
  private max = 1;
  private active = 0;
  private holders = new Map<() => void, string>();
  private leases = new Map<string, (release: boolean) => boolean>();

  snapshot() {
    return { occupied: this.holders.size, limit: this.max, holders: [...this.holders.values()] };
  }
  private readonly waiters: Record<GatePriority, (() => void)[]> = { ship: [], finish: [], start: [] };

  constructor(limit: number) {
    this.setLimit(limit);
  }

  get limit(): number {
    return this.max;
  }

  setLimit(limit: number): void {
    this.max = Math.max(1, Math.floor(limit));
    this.drain();
  }

  /** Resolves with a release function; `onWait` fires once when the caller has to queue. */
  async acquire(
    signal: AbortSignal,
    onWait?: (limit: number) => void,
    holder = "gate",
    running = false,
    priority: GatePriority = "finish",
  ): Promise<() => void> {
    signal.throwIfAborted();
    if (running || this.active < this.max) this.active++;
    else {
      onWait?.(this.max);
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiters[priority];
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const i = queue.indexOf(wake);
          if (i >= 0) queue.splice(i, 1);
          reject(signal.reason);
        };
        queue.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holders.delete(release);
      this.active--;
      this.drain();
    };
    this.holders.set(release, holder);
    if (signal.aborted) release();
    signal.throwIfAborted();
    return release;
  }

  async lease(
    name: string,
    immediate = false,
    timer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    clear = clearTimeout,
    running = false,
    observe?: { onWait: () => void; onAcquired: () => void },
    priority: GatePriority = "finish",
  ): Promise<string> {
    const id = crypto.randomUUID(),
      controller = new AbortController();
    let release: (() => void) | undefined, expiry: ReturnType<typeof setTimeout>;
    const touch = (done: boolean) => {
      clear(expiry);
      if (done) {
        this.leases.delete(id);
        controller.abort();
        release?.();
      } else expiry = timer(() => touch(true), GATE_LEASE_EXPIRY_MS);
      return !!release;
    };
    this.leases.set(id, touch);
    touch(false);
    void this.acquire(controller.signal, observe?.onWait, name, running, priority).then(
      (free) => {
        release = free;
        if (controller.signal.aborted) touch(true);
        else observe?.onAcquired();
      },
      () => touch(true),
    );
    await Promise.resolve();
    if (immediate && !release) touch(true);
    return id;
  }

  heartbeat(id: string, release = false): boolean | undefined {
    return this.leases.get(id)?.(release);
  }

  private drain(): void {
    while (this.active < this.max) {
      const next = this.waiters.ship.shift() ?? this.waiters.finish.shift() ?? this.waiters.start.shift();
      if (!next) return;
      this.active++;
      next();
    }
  }
}

type Timer = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
interface Options {
  owner?: string;
  pid?: number;
  /** null confirms absence; undefined or an exception means inspection is unavailable. */
  inspect?: (pid: number) => string | null | undefined;
  now?: () => number;
  timer?: Timer;
  clear?: typeof clearTimeout;
  pollMs?: number;
  renewMs?: number;
}
interface Slot {
  id: string;
  owner: string;
  holder: string;
  state: "waiting" | "held";
  lease_until: number | null;
  owner_pid: number | null;
  owner_birth: string | null;
}

const processOwner = crypto.randomUUID();

/** SQLite owns admission; timers only renew ownership and observe other processes. */
export class DatabaseSlotPool extends Semaphore {
  private readonly owner;
  private readonly now;
  private readonly timer: Timer;
  private readonly clear: typeof clearTimeout;
  private readonly pending = new Map<string, () => void>();
  private readonly touches = new Map<string, (done: boolean) => boolean | undefined>();
  private readonly leaseTimers = new Map<string, () => void>();
  private pollTick?: ReturnType<typeof setTimeout>;
  private renewTick?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly pid;
  private readonly birth;
  private readonly inspect;
  private readonly pollMs;
  private readonly renewMs;
  private readonly inspectionWarnings = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly pool: string,
    defaultLimit: number,
    options: Options = {},
  ) {
    super(defaultLimit);
    this.owner = options.owner ?? processOwner;
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? setTimeout;
    this.clear = options.clear ?? clearTimeout;
    this.pid = options.pid ?? process.pid;
    this.inspect = options.inspect ?? processBirthSync;
    const birth = this.inspect(this.pid);
    if (!birth) throw new Error("Slot owner process identity is unavailable");
    this.birth = birth;
    this.pollMs = Math.max(1, Math.min(250, options.pollMs ?? 250));
    this.renewMs = options.renewMs ?? 10_000;
    this.write(
      "INSERT OR IGNORE INTO slot_pools (pool, capacity) VALUES (?, ?)",
      pool,
      Math.max(1, Math.floor(defaultLimit)),
    );
  }

  private schedule() {
    if (this.closed) return;
    const owned =
      this.rows("SELECT id FROM slot_requests WHERE pool = ? AND owner = ? LIMIT 1", this.pool, this.owner)
        .length > 0;
    const arm = (renew: boolean) => {
      const tick = this.timer(
        () => {
          if (renew) this.renewTick = undefined;
          else this.pollTick = undefined;
          try {
            this.refresh(() => {
              if (renew)
                this.write(
                  "UPDATE slot_requests SET renewed_at = ? WHERE pool = ? AND owner = ?",
                  this.now(),
                  this.pool,
                  this.owner,
                );
            });
          } catch (error) {
            console.warn(redactCredentials(`Slot pool renewal/poll failed: ${String(error)}`));
          } finally {
            this.schedule();
          }
        },
        renew ? this.renewMs : this.pollMs,
      );
      tick.unref?.();
      return tick;
    };
    if (!this.pending.size && this.pollTick !== undefined) {
      this.clear(this.pollTick);
      this.pollTick = undefined;
    } else if (this.pending.size && this.pollTick === undefined) this.pollTick = arm(false);
    if (!owned && this.renewTick !== undefined) {
      this.clear(this.renewTick);
      this.renewTick = undefined;
    } else if (owned && this.renewTick === undefined) this.renewTick = arm(true);
  }

  /** Stop renewal without discarding external leases during graceful shutdown. */
  close() {
    this.closed = true;
    if (this.pollTick !== undefined) this.clear(this.pollTick);
    if (this.renewTick !== undefined) this.clear(this.renewTick);
    for (const cancel of this.leaseTimers.values()) cancel();
    this.leaseTimers.clear();
    this.touches.clear();
  }

  override get limit(): number {
    return (
      this.rows<{ capacity: number }>("SELECT capacity FROM slot_pools WHERE pool = ?", this.pool)[0]
        ?.capacity ?? 1
    );
  }

  override setLimit(limit: number): void {
    // Semaphore's constructor calls this before the database fields are initialized.
    if (!this.db) return;
    this.refresh(() =>
      this.write(
        "UPDATE slot_pools SET capacity = ? WHERE pool = ?",
        Math.max(1, Math.floor(limit)),
        this.pool,
      ),
    );
  }

  override snapshot() {
    this.refresh();
    const holders = this.rows(
      "SELECT * FROM slot_requests WHERE pool = ? AND state = 'held' ORDER BY held_order",
      this.pool,
    ).map((row) => row.holder);
    return { occupied: holders.length, limit: this.limit, holders };
  }

  private row(id: string) {
    return this.rows("SELECT * FROM slot_requests WHERE pool = ? AND id = ?", this.pool, id)[0];
  }

  private rows<T = Slot>(sql: string, ...values: SQLQueryBindings[]): T[] {
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...values);
  }

  private write(sql: string, ...values: SQLQueryBindings[]) {
    return this.db.query(sql).run(...values);
  }

  private refresh(change = () => {}) {
    this.db
      .transaction(() => {
        this.write("DELETE FROM slot_requests WHERE pool = ? AND lease_until <= ?", this.pool, this.now());
        for (const row of this.rows(
          "SELECT DISTINCT owner, owner_pid, owner_birth FROM slot_requests WHERE pool = ? AND lease_until IS NULL",
          this.pool,
        )) {
          try {
            // Older requests cannot be attributed safely; timestamps do not prove death.
            if (row.owner_pid === null || !row.owner_birth)
              throw new Error("missing recorded process identity");
            const birth = this.inspect(row.owner_pid);
            if (birth === undefined || birth === "") throw new Error("process identity is unavailable");
            if (birth !== row.owner_birth)
              this.write(
                "DELETE FROM slot_requests WHERE pool = ? AND owner = ? AND owner_pid = ? AND owner_birth = ? AND lease_until IS NULL",
                this.pool,
                row.owner,
                row.owner_pid,
                row.owner_birth,
              );
            this.inspectionWarnings.delete(row.owner);
          } catch (error) {
            if (!this.inspectionWarnings.has(row.owner))
              console.warn(
                redactCredentials(
                  `Slot owner ${row.owner} inspection failed; preserving reservations: ${String(error)}`,
                ),
              );
            this.inspectionWarnings.add(row.owner);
          }
        }
        change();
        const rows = this.rows(
          `SELECT * FROM slot_requests WHERE pool = ?
        ORDER BY CASE priority WHEN 'ship' THEN 0 WHEN 'finish' THEN 1 ELSE 2 END, requested_at, seq`,
          this.pool,
        );
        const free = Math.max(0, this.limit - rows.filter((row) => row.state === "held").length);
        for (const row of rows.filter((row) => row.state === "waiting").slice(0, free))
          this.write(
            `UPDATE slot_requests SET state = 'held',
            held_order = (SELECT coalesce(max(held_order), 0) + 1 FROM slot_requests) WHERE id = ?`,
            row.id,
          );
      })
      .immediate();
    for (const wake of [...this.pending.values()]) wake();
    this.schedule();
  }

  private remove(id: string) {
    this.refresh(() =>
      this.write(
        "DELETE FROM slot_requests WHERE pool = ? AND id = ? AND owner = ?",
        this.pool,
        id,
        this.owner,
      ),
    );
  }

  override acquire(...args: Parameters<Semaphore["acquire"]>): Promise<() => void> {
    return this.reserve(crypto.randomUUID(), null, ...args);
  }

  private async reserve(
    id: string,
    leaseUntil: number | null,
    signal: AbortSignal,
    onWait?: (limit: number) => void,
    holder = "gate",
    running = false,
    priority: GatePriority = "finish",
  ): Promise<() => void> {
    signal.throwIfAborted();
    this.refresh(() =>
      this.write(
        `INSERT INTO slot_requests
      (id, pool, owner, holder, priority, state, requested_at, renewed_at, lease_until, owner_pid, owner_birth, held_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(held_order), 0) + 1 FROM slot_requests))`,
        id,
        this.pool,
        this.owner,
        holder,
        priority,
        running ? "held" : "waiting",
        this.now(),
        this.now(),
        leaseUntil,
        this.pid,
        this.birth,
      ),
    );
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (leaseUntil === null) this.remove(id);
    };
    try {
      if (this.row(id)?.state !== "held") {
        onWait?.(this.limit);
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const done = (error?: unknown) => {
            this.pending.delete(id);
            this.schedule();
            signal.removeEventListener("abort", abort);
            if (error !== undefined) reject(error);
            else resolve();
          };
          const abort = () => {
            done(signal.reason);
            release();
          };
          const wake = () => {
            const row = this.row(id);
            if (!row) done(new Error("Slot expired"));
            else if (row.owner !== this.owner) done(new Error("Slot ownership transferred"));
            else if (row.state === "held") done();
          };
          this.pending.set(id, wake);
          signal.addEventListener("abort", abort, { once: true });
          wake();
          this.schedule();
        });
      }
      signal.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  override async lease(
    name: string,
    immediate = false,
    timer: Timer = this.timer,
    clear = this.clear,
    running = false,
    observe?: { onWait: () => void; onAcquired: () => void },
    priority: GatePriority = "finish",
  ): Promise<string> {
    const id = crypto.randomUUID(),
      controller = new AbortController();
    const touch = this.armLease(id, timer, clear, () => controller.abort());
    let acquired = false;
    void this.reserve(
      id,
      this.now() + GATE_LEASE_EXPIRY_MS,
      controller.signal,
      observe?.onWait,
      name,
      running,
      priority,
    ).then(
      () => {
        if (controller.signal.aborted) touch(true);
        else {
          acquired = true;
          observe?.onAcquired();
        }
      },
      () => touch(true),
    );
    await Promise.resolve();
    if (immediate && !acquired) this.heartbeat(id, true);
    return id;
  }

  private armLease(id: string, timer = this.timer, clear = this.clear, abort = () => {}) {
    this.leaseTimers.get(id)?.();
    let expiry: ReturnType<typeof setTimeout>;
    const touch = (done: boolean) => {
      if (this.touches.get(id) !== touch) return undefined;
      clear(expiry);
      const row = this.row(id);
      if (done || !row || row.owner !== this.owner) {
        // Keep cleanup armed until the database write succeeds.
        if (row?.owner === this.owner) this.remove(id);
        this.touches.delete(id);
        this.leaseTimers.delete(id);
        abort();
        this.schedule();
        return row?.state === "held";
      }
      expiry = timer(expire, GATE_LEASE_EXPIRY_MS);
      expiry.unref?.();
      return row.state === "held";
    };
    const expire = () => {
      if (this.touches.get(id) !== touch) return;
      try {
        const row = this.row(id);
        if (row?.owner === this.owner && row.lease_until !== null && row.lease_until > this.now()) {
          expiry = timer(expire, row.lease_until - this.now());
          expiry.unref?.();
          return;
        }
        touch(true);
      } catch (error) {
        console.warn(redactCredentials(`Slot lease expiry failed: ${String(error)}`));
        expiry = timer(expire, 250);
        expiry.unref?.();
      }
    };
    this.touches.set(id, touch);
    this.leaseTimers.set(id, () => clear(expiry));
    expiry = timer(expire, GATE_LEASE_EXPIRY_MS);
    expiry.unref?.();
    return touch;
  }

  override heartbeat(id: string, release = false): boolean | undefined {
    let held: boolean | undefined,
      adopt = false;
    this.refresh(() => {
      const row = this.row(id);
      if (!row || row.lease_until === null) return;
      held = row.state === "held";
      adopt = !this.touches.has(id) || row.owner !== this.owner;
      if (release) this.write("DELETE FROM slot_requests WHERE pool = ? AND id = ?", this.pool, id);
      else
        this.write(
          `UPDATE slot_requests SET owner = ?, owner_pid = ?, owner_birth = ?, renewed_at = ?, lease_until = ?
        WHERE pool = ? AND id = ?`,
          this.owner,
          this.pid,
          this.birth,
          this.now(),
          this.now() + GATE_LEASE_EXPIRY_MS,
          this.pool,
          id,
        );
    });
    if (held === undefined) return undefined;
    if (release) {
      this.touches.get(id)?.(true);
      return held;
    }
    if (adopt) this.armLease(id);
    return this.touches.get(id)?.(release);
  }
}

/** Shared by every gate run in the process: pipeline runs, baselines and eval trials. */
export let gateSlots = new Semaphore(defaultGateSlots());

/** Targeted agent tests never queue behind a full gate suite. */
export let agentTestSlots = new Semaphore(2);

/** Only daemon startup attaches coordinator capacity; workers keep the in-memory pools. */
export function attachSlotPools(db: Database, limit: number): () => void {
  const previous = [gateSlots, agentTestSlots] as const;
  const gate = new DatabaseSlotPool(db, "gate", defaultGateSlots());
  const small = new DatabaseSlotPool(db, "agent-test", 2);
  gate.setLimit(limit);
  gateSlots = gate;
  agentTestSlots = small;
  return () => {
    gate.close();
    small.close();
    [gateSlots, agentTestSlots] = previous;
  };
}

const reservation = new AsyncLocalStorage<{
  release?: Promise<() => void>;
  closed: boolean;
  users: number;
  releaseRequested: boolean;
}>();

/** Restoring execution context must not replace the attaching operation's reservation. */
export function bindGateSlotScope<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
  const held = reservation.getStore();
  return held ? (...args) => reservation.run(held, fn, ...args) : (...args) => reservation.exit(fn, ...args);
}

/** Worker attempts must leave coordinator capacity available for local gates. */
export async function releaseGateSlotScope(): Promise<void> {
  const held = reservation.getStore();
  if (!held) return;
  held.releaseRequested = true;
  if (held.users) return;
  const pending = held.release;
  held.release = undefined;
  held.releaseRequested = false;
  (await pending?.catch(() => undefined))?.();
}

/** Local attempts share ownership until retry decisions and cancellation cleanup finish. */
export const gateSlotScope =
  <T>(fn: () => Promise<T>): (() => Promise<T>) =>
  async () => {
    if (reservation.getStore()?.closed === false) return fn();
    const held = {
      closed: false,
      users: 0,
      releaseRequested: false,
      release: undefined as Promise<() => void> | undefined,
    };
    return reservation.run(held, async () => {
      try {
        return await fn();
      } finally {
        held.closed = true;
        await releaseGateSlotScope();
      }
    });
  };

export async function acquireGateSlot(
  signal: AbortSignal,
  onWait?: (limit: number) => void,
  holder?: string,
  skipGateSlot = false,
  priority?: GatePriority,
): Promise<() => void> {
  signal.throwIfAborted();
  const held = reservation.getStore();
  if (held && !held.closed && (held.release || !skipGateSlot)) {
    held.release ??= gateSlots.acquire(signal, onWait, holder, false, priority);
    held.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.users--;
      if (!held.users && held.releaseRequested) void reservation.run(held, releaseGateSlotScope);
    };
    try {
      await held.release;
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  return (skipGateSlot ? agentTestSlots : gateSlots).acquire(
    signal,
    skipGateSlot ? undefined : onWait,
    holder,
    false,
    skipGateSlot ? undefined : priority,
  );
}
