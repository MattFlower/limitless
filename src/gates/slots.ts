import { availableParallelism } from "node:os";

export const GATE_LEASE_EXPIRY_MS = 30_000;

/** A full gate suite is CPU-heavy, so by default one suite runs per four cores. */
export function defaultGateSlots(cores = availableParallelism()): number {
  return Math.max(1, Math.floor(cores / 4));
}

/** FIFO counting semaphore; a slot is handed straight to the next waiter on release. */
export class Semaphore {
  private max = 1;
  private active = 0;
  private holders = new Map<() => void, string>();
  private leases = new Map<string, (release: boolean) => boolean>();

  snapshot() {
    return { occupied: this.holders.size, limit: this.max, holders: [...this.holders.values()] };
  }
  private readonly waiters: (() => void)[] = [];

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
  ): Promise<() => void> {
    signal.throwIfAborted();
    if (running || (this.active < this.max && !this.waiters.length)) this.active++;
    else {
      onWait?.(this.max);
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
        };
        this.waiters.push(wake);
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
    void this.acquire(controller.signal, observe?.onWait, name, running).then(
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
      const next = this.waiters.shift();
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
