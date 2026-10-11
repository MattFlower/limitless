import { randomUUID } from "node:crypto";
import type { GateConfig } from "./detect.ts";
import { redactGateData } from "./output.ts";
import { type GateHooks, type GateResult, type GateRun, runLocalGates } from "./run.ts";

export interface Executor<Req, Res> {
  readonly kind: "local" | "github-actions" | "lan" | "claude-cloud";
  start(req: Req, signal: AbortSignal): Promise<ExecutionHandle>;
  attach(handle: ExecutionHandle, signal: AbortSignal, req?: Req, hooks?: GateHooks): Execution<Res>;
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
  cancel(): Promise<void>;
}
export type ExecutionEvent =
  | { type: "status"; text: string }
  | { type: "check"; phase: "setup" | "check"; result: GateResult };
export interface GateRequest {
  repo: string;
  cwd: string;
  baseSha: string;
  headSha: string;
  gates: GateConfig;
  checks?: string[];
}
export type GateExecutor = Executor<GateRequest, GateRun>;
export type GateRunner = (gates: GateConfig) => Promise<GateRun>;

export function gateExecutorFor(kind: "local"): GateExecutor {
  switch (kind) {
    case "local":
      return localExecutor();
  }
}

export function localExecutor(hooks: GateHooks = {}): GateExecutor {
  const executions = new Map<string, Execution<GateRun>>();
  const starts = new Map<string, { request: GateRequest; signal: AbortSignal }>();
  return {
    kind: "local",
    async start(request, signal) {
      signal.throwIfAborted();
      const id = randomUUID();
      starts.set(id, { request, signal });
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
      const result = runLocalGates(
        req.cwd,
        {
          ...req.gates,
          checks: req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name)),
        },
        controller.signal,
        {
          onWait: slotHooks.onWait,
          holder: slotHooks.holder,
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
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation ??= execution.cancel();
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
  } finally {
    onSettled();
    signal.removeEventListener("abort", abort);
    await cancellation;
  }
}
