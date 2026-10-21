import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { WorkerStore } from "../db/workers.ts";
import type { GateConfig } from "./detect.ts";
import { lanExecutor } from "./lan.ts";
import { redactGateData } from "./output.ts";
import {
  type GateHooks,
  type GateResult,
  type GateRetryOptions,
  type GateRun,
  runLocalGates,
} from "./run.ts";
import { bindGateSlotScope, type GatePriority } from "./slots.ts";

export interface Executor<Req, Res> {
  readonly kind: "local" | "github-actions" | "lan" | "claude-cloud";
  start(req: Req, signal: AbortSignal): Promise<ExecutionHandle>;
  attach(handle: ExecutionHandle, signal: AbortSignal, req?: Req, hooks?: GateHooks): Execution<Res>;
  discard?(handle: ExecutionHandle): void;
}
export interface ExecutionHandle {
  kind: Executor<unknown, unknown>["kind"];
  id: string;
  startedAt: number;
  url?: string;
}
export interface Execution<Res> {
  events: AsyncIterable<ExecutionEvent>;
  result: Promise<Res>;
  cancel(reason?: unknown): Promise<void>;
}
export type ExecutionEvent =
  | { type: "status"; text: string }
  | { type: "check"; phase: "setup" | "check"; result: GateResult };
export interface GateRequest {
  runId?: string;
  priority?: GatePriority;
  repo: string;
  cwd: string;
  baseSha: string;
  headSha: string;
  gates: GateConfig;
  checks?: string[];
  skipGateSlot?: boolean;
}
export type GateExecutor = Executor<GateRequest, GateRun> & {
  freshCheckoutFor?: (repo: string) => boolean;
};
export type GateRunner = (gates: GateConfig, options?: GateRetryOptions) => Promise<GateRun>;

/** Shutdown detaches durable jobs; owner cancellation discards them. */
export const gateShutdown = (signal: AbortSignal): boolean =>
  signal.aborted && signal.reason instanceof Error && signal.reason.message === "shutdown";

const liveExecutions = new WeakMap<GateExecutor, Map<string, Execution<GateRun>>>();

/** Discard only work still owned by this process; never replay an old handle to cancel it. */
export async function cancelGateExecution(handle: ExecutionHandle, executor?: GateExecutor): Promise<void> {
  const execution = executor?.kind === handle.kind ? liveExecutions.get(executor)?.get(handle.id) : undefined;
  if (execution) {
    await execution.cancel();
    await execution.result.catch(() => {});
  } else if (executor?.kind === handle.kind) executor.discard?.(handle);
}

export function gateExecutorFor(
  kind: "local" | "lan",
  workers?: WorkerStore,
  repos: readonly string[] = [],
): GateExecutor {
  switch (kind) {
    case "local":
      return localExecutor();
    case "lan":
      if (!workers) throw new Error("LAN executor requires a worker store");
      return lanExecutor(workers, repos);
  }
}

export function localExecutor(hooks: GateHooks = {}): GateExecutor {
  const executions = new Map<string, Execution<GateRun>>();
  const starts = new Map<
    string,
    { request: GateRequest; signal: AbortSignal; context: ReturnType<typeof AsyncLocalStorage.snapshot> }
  >();
  const executor: GateExecutor = {
    kind: "local",
    async start(request, signal) {
      signal.throwIfAborted();
      const id = randomUUID();
      starts.set(id, { request, signal, context: AsyncLocalStorage.snapshot() });
      return { kind: "local", id, startedAt: Date.now() };
    },
    attach(handle, signal, request, slotHooks = hooks) {
      const started = starts.get(handle.id);
      if (started) signal = AbortSignal.any([started.signal, signal]);
      const known = executions.get(handle.id);
      if (known) {
        if (signal.aborted) void known.cancel();
        else {
          const abort = () => void known.cancel();
          signal.addEventListener("abort", abort, { once: true });
          const cleanup = () => signal.removeEventListener("abort", abort);
          void known.result.then(cleanup, cleanup);
        }
        return known;
      }
      const req = request ?? started?.request;
      if (!req) throw new Error("Local gate execution is missing its request");
      const controller = new AbortController();
      const cancel = async () => {
        if (!controller.signal.aborted) controller.abort();
      };
      const abort = () => void cancel();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const results: ExecutionEvent[] = [];
      let done = false;
      let changed = Promise.withResolvers<void>();
      const notify = () => {
        const previous = changed;
        changed = Promise.withResolvers<void>();
        previous.resolve();
      };
      const local = bindGateSlotScope(runLocalGates);
      const run = (...args: Parameters<typeof runLocalGates>) =>
        started ? started.context(local, ...args) : local(...args);
      const result = run(
        req.cwd,
        {
          ...req.gates,
          checks: req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name)),
        },
        controller.signal,
        {
          onWait: slotHooks.onWait,
          holder: slotHooks.holder,
          skipGateSlot: req.skipGateSlot,
          priority: req.priority,
          onLocalSetup: slotHooks.onLocalSetup,
          onResult(r, phase) {
            results.push({ type: "check", phase, result: r });
            notify();
          },
        },
      ).finally(() => {
        executions.delete(handle.id);
        starts.delete(handle.id);
        done = true;
        notify();
        signal.removeEventListener("abort", abort);
      });
      const execution = {
        result,
        cancel,
        events: {
          async *[Symbol.asyncIterator]() {
            let index = 0;
            while (!done || index < results.length) {
              const event = results[index++];
              if (event) yield event;
              else {
                index--;
                await changed.promise;
              }
            }
            await result;
          },
        },
      };
      executions.set(handle.id, execution);
      return execution;
    },
  };
  liveExecutions.set(executor, executions);
  return executor;
}

/** Start, checkpoint, attach and cancel through the same path for all daemon gates. */
export async function executeGate(
  req: GateRequest,
  signal: AbortSignal,
  hooks: GateHooks = {},
  injected?: GateExecutor,
  stored?: ExecutionHandle,
  persist: (handle: ExecutionHandle) => Promise<void> = async () => {},
  onSettled: () => void = () => {},
): Promise<GateRun> {
  const executor =
    stored?.kind === "local" && injected?.kind !== "local"
      ? localExecutor(hooks)
      : (injected ?? localExecutor(hooks));
  if (stored && stored.kind !== executor.kind) throw new Error(`Unavailable gate executor: ${stored.kind}`);
  const handle = stored ?? (await executor.start(req, signal));
  if (!stored) await persist(handle);
  let execution: Execution<GateRun>;
  try {
    execution = executor.attach(handle, signal, req, hooks);
  } catch (error) {
    onSettled();
    throw error;
  }
  let live = liveExecutions.get(executor);
  if (!live) {
    live = new Map();
    liveExecutions.set(executor, live);
  }
  live.set(handle.id, execution);
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation ??= execution.cancel(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const events = (async () => {
      for await (const event of execution.events)
        if (event.type === "check") hooks.onResult?.(redactGateData(event.result), event.phase);
    })();
    const [result] = await Promise.all([execution.result, events]);
    return result;
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await cancellation;
    await execution.result.catch(() => {});
    live.delete(handle.id);
    onSettled();
  }
}
