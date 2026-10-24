import { availableParallelism, loadavg } from "node:os";
import { TERMINAL_STATUSES } from "./core/types.ts";
import { clearGitHubWait, finalizeRecordedCancellation } from "./pipeline/cancellation.ts";
import type { EngineDeps, RunState } from "./pipeline/context.ts";
import { executeRun } from "./pipeline/engine.ts";

/**
 * Starts queued runs up to the concurrency limit, cancels on request, and re-queues runs that
 * were interrupted by a restart so they resume where they left off.
 */
export class Scheduler {
  private active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private probeDelay: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly probes = new Set<Promise<void>>();
  private drainEnabled = false;
  private readonly drainEvents = new EventTarget();
  private unsubscribe: (() => void) | null = null;
  loadPerCore?: number;
  admissionHeld = false;

  constructor(
    private readonly deps: EngineDeps,
    private maxConcurrent: number,
    private readonly options: { maxLoadPerCore?: number; loadSource?: () => number } = {},
  ) {}

  setLimit(limit: number): void {
    this.maxConcurrent = limit;
  }

  start(): void {
    for (const run of this.deps.store.listRuns({
      status: ["queued", "cancelled"],
      limit: Number.MAX_SAFE_INTEGER,
    })) {
      if (run.status === "queued") finalizeRecordedCancellation(this.deps.store, run.id);
      else if (run.githubWait)
        this.deps.store.updateRun(run.id, {}, clearGitHubWait(this.deps.store.getRunState<RunState>(run.id)));
    }
    const interrupted = this.deps.store.listRuns({ status: ["running", "waiting_input"], limit: 1000 });
    for (const run of interrupted) {
      const cancelled = finalizeRecordedCancellation(this.deps.store, run.id);
      for (const stage of this.deps.store.listStages(run.id))
        if (stage.status === "running")
          this.deps.store.finishStage(stage.id, "cancelled", "Daemon interrupted stage");
      for (const invocation of this.deps.store.listInvocations(run.id))
        if (invocation.status === "running")
          this.deps.store.updateInvocation(invocation.id, {
            status: cancelled ? "cancelled" : "error",
            error: "Daemon interrupted invocation; final usage unknown",
            finishedAt: Date.now(),
          });
      this.deps.store.refreshRunTotals(run.id);
      if (!cancelled) this.deps.store.updateRun(run.id, { status: "queued", finishedAt: null });
      this.deps.store.addEvent({
        runId: run.id,
        type: "log",
        level: "warn",
        message: cancelled
          ? "Daemon restarted; cancellation preserved"
          : "Daemon restarted; run re-queued to resume",
      });
    }
    this.unsubscribe = this.deps.store.subscribe((msg) => {
      if (msg.kind === "run") queueMicrotask(() => this.tick());
    });
    this.timer = setInterval(() => this.tick(), 2000);
    this.tick();
    // Probe local model servers now and every minute.
    this.probe();
    // Re-probe shortly after startup, once ssh forwards to remote model servers are up.
    this.probeDelay = setTimeout(() => this.probe(), 8_000);
    this.probeDelay.unref?.();
    this.probeTimer = setInterval(() => this.probe(), 60_000);
    this.probeTimer.unref?.();
  }

  private probe(): void {
    if (this.stopping) return;
    const pending = this.deps.tracker.probe();
    this.probes.add(pending);
    void pending.then(
      () => this.probes.delete(pending),
      () => this.probes.delete(pending),
    );
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
    this.drainEvents.dispatchEvent(new Event("drain"));
  }

  resume(): void {
    this.drainEnabled = false;
    this.tick();
  }

  tick(): void {
    if (this.stopping) return;
    this.deps.store.reconcileWaitingRuns();
    this.deps.tracker.refreshAlerts();
    this.loadPerCore = (
      this.options.loadSource ?? (() => (loadavg()[0] as number) / availableParallelism())
    )();
    const limit = this.options.maxLoadPerCore ?? 2;
    const held = limit > 0 && this.loadPerCore > limit;
    if (held !== this.admissionHeld) {
      this.admissionHeld = held;
      console.log(
        held
          ? `Holding new runs: load ${this.loadPerCore} per core is above ${limit}`
          : "Resuming new runs: host load is within the limit",
      );
    }
    if (this.draining) return;
    const capacity = Math.min(
      this.maxConcurrent - this.active.size,
      held ? (this.active.size === 0 ? 1 : 0) : Infinity,
    );
    if (capacity <= 0) return;
    for (const run of this.deps.store.nextQueuedRuns(capacity)) {
      if (this.stopping || this.draining) return;
      if (this.active.has(run.id)) continue;
      if (finalizeRecordedCancellation(this.deps.store, run.id)) continue;
      const controller = new AbortController();
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const done = promise
        .catch((e) => {
          this.deps.store.updateRun(run.id, {
            status: "failed",
            error: `internal error: ${(e as Error).message}`,
            finishedAt: Date.now(),
          });
        })
        .finally(() => {
          finalizeRecordedCancellation(this.deps.store, run.id);
          this.active.delete(run.id);
          if (!this.stopping) this.tick();
        });
      this.active.set(run.id, { controller, done });
      // State subscribers can cancel or stop synchronously during executeRun's first publication.
      resolve(executeRun(this.deps, run.id, controller.signal, () => this.draining, this.drainEvents));
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
      finalizeRecordedCancellation(this.deps.store, runId);
    }
    this.deps.store.addEvent({ runId, type: "log", level: "warn", message: `Cancel requested by ${by}` });
    return true;
  }

  /** Graceful shutdown: interrupt active runs and wait for them to unwind (they are re-queued). */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.probeDelay) clearTimeout(this.probeDelay);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    for (const { controller } of this.active.values()) controller.abort(new Error("shutdown"));
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    await Promise.allSettled(this.probes);
  }
}
