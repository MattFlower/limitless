import { availableParallelism } from "node:os";

/** A full gate suite is CPU-heavy, so by default one suite runs per four cores. */
export function defaultGateSlots(cores = availableParallelism()): number {
  return Math.max(1, Math.floor(cores / 4));
}

/** FIFO counting semaphore; a slot is handed straight to the next waiter on release. */
export class Semaphore {
  private max = 1;
  private active = 0;
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
  async acquire(signal: AbortSignal, onWait?: (limit: number) => void): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.max && !this.waiters.length) this.active++;
    else {
      onWait?.(this.max);
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
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
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
