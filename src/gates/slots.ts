import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";

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

/** Shared by every gate run in the process: pipeline runs, baselines and eval trials. */
export const gateSlots = new Semaphore(defaultGateSlots());

/** Targeted agent tests never queue behind a full gate suite. */
export const agentTestSlots = new Semaphore(2);

const reservation = new AsyncLocalStorage<{ release?: Promise<() => void>; closed: boolean }>();

/** Restoring execution context must not replace the attaching operation's reservation. */
export function bindGateSlotScope<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
  const held = reservation.getStore();
  return held ? (...args) => reservation.run(held, fn, ...args) : (...args) => reservation.exit(fn, ...args);
}

/** Worker attempts must leave coordinator capacity available for local gates. */
export async function releaseGateSlotScope(): Promise<void> {
  const held = reservation.getStore();
  const pending = held?.release;
  if (held) held.release = undefined;
  (await pending?.catch(() => undefined))?.();
}

/** Local attempts share ownership until retry decisions and cancellation cleanup finish. */
export const gateSlotScope =
  <T>(fn: () => Promise<T>): (() => Promise<T>) =>
  async () => {
    const held = { closed: false, release: undefined as Promise<() => void> | undefined };
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
    await held.release;
    return () => {};
  }
  return (skipGateSlot ? agentTestSlots : gateSlots).acquire(
    signal,
    skipGateSlot ? undefined : onWait,
    holder,
    false,
    skipGateSlot ? undefined : priority,
  );
}
