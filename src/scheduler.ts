import { TERMINAL_STATUSES } from "./core/types.ts";
import type { EngineDeps } from "./pipeline/context.ts";
import { executeRun } from "./pipeline/engine.ts";

/**
 * Starts queued runs up to the concurrency limit, cancels on request, and re-queues runs that
 * were interrupted by a restart so they resume where they left off.
 */
export class Scheduler {
  private active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private drainEnabled = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly maxConcurrent: number,
  ) {}

  start(): void {
    const interrupted = this.deps.store.listRuns({ status: ["running", "waiting_input"], limit: 1000 });
    for (const run of interrupted) {
      this.deps.store.updateRun(run.id, { status: "queued" });
      this.deps.store.addEvent({
        runId: run.id,
        type: "log",
        level: "warn",
        message: "Daemon restarted; run re-queued to resume",
      });
    }
    this.unsubscribe = this.deps.store.subscribe((msg) => {
      if (msg.kind === "run") queueMicrotask(() => this.tick());
    });
    this.timer = setInterval(() => this.tick(), 2000);
    this.tick();
    // Probe local model servers now and every minute.
    void this.deps.tracker.probe();
    // Re-probe shortly after startup, once ssh forwards to remote model servers are up.
    setTimeout(() => void this.deps.tracker.probe(), 8_000).unref?.();
    setInterval(() => void this.deps.tracker.probe(), 60_000).unref?.();
  }

  get activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  get parkedRunIds(): string[] {
    return this.deps.store.parkedRunIds();
  }

  get draining(): boolean {
    return this.drainEnabled;
  }

  drain(): void {
    this.drainEnabled = true;
  }

  resume(): void {
    this.drainEnabled = false;
    this.tick();
  }

  tick(): void {
    if (this.stopping) return;
    this.deps.store.reconcileWaitingRuns();
    this.deps.tracker.refreshAlerts();
    if (this.draining) return;
    const capacity = this.maxConcurrent - this.active.size;
    if (capacity <= 0) return;
    for (const run of this.deps.store.nextQueuedRuns(capacity)) {
      if (this.stopping || this.draining) return;
      if (this.active.has(run.id)) continue;
      const controller = new AbortController();
      const done = executeRun(this.deps, run.id, controller.signal, () => this.draining)
        .catch((e) => {
          this.deps.store.updateRun(run.id, {
            status: "failed",
            error: `internal error: ${(e as Error).message}`,
            finishedAt: Date.now(),
          });
        })
        .finally(() => {
          this.active.delete(run.id);
          if (this.stopping) {
            const r = this.deps.store.getRun(run.id);
            // Runs interrupted by shutdown go back to the queue instead of staying cancelled.
            if (r?.status === "cancelled" && !r.error?.startsWith("cancelled by")) {
              this.deps.store.updateRun(run.id, { status: "queued", finishedAt: null });
            }
          } else {
            this.tick();
          }
        });
      this.active.set(run.id, { controller, done });
    }
  }

  /** Cancel a run in any non-terminal state. Returns false if it already finished. */
  cancel(runId: string, by = "user"): boolean {
    const run = this.deps.store.getRun(runId);
    if (!run || TERMINAL_STATUSES.includes(run.status)) return false;
    this.deps.store.updateRun(runId, { error: `cancelled by ${by}` });
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
    } else {
      this.deps.store.updateRun(runId, { status: "cancelled", finishedAt: Date.now() });
    }
    this.deps.store.addEvent({ runId, type: "log", level: "warn", message: `Cancel requested by ${by}` });
    return true;
  }

  /** Graceful shutdown: interrupt active runs and wait for them to unwind (they are re-queued). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
