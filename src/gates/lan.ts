import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerStore } from "../db/workers.ts";
import {
  type Execution,
  type ExecutionEvent,
  type GateExecutor,
  type GateRequest,
  gateShutdown,
  localExecutor,
} from "./executor.ts";
import type { GateRun } from "./run.ts";

export function lanExecutor(workers: WorkerStore, repos: readonly string[]): GateExecutor {
  const local = localExecutor();
  const live = new Map<string, Execution<GateRun>>();
  const starts = new Map<
    string,
    { signal: AbortSignal; context: ReturnType<typeof AsyncLocalStorage.snapshot> }
  >();
  return {
    kind: "lan",
    freshCheckoutFor: (repo) => repos.includes(repo),
    discard(handle) {
      workers.cancel(handle.id);
      void live.get(handle.id)?.cancel();
      starts.delete(handle.id);
    },
    async start(req, signal) {
      signal.throwIfAborted();
      if (!repos.includes(req.repo)) return local.start(req, signal);
      const id = workers.enqueue(req);
      starts.set(id, { signal, context: AsyncLocalStorage.snapshot() });
      return { kind: "lan", id, startedAt: workers.now() };
    },
    attach(handle, signal, req, hooks) {
      if (handle.kind === "local") return local.attach(handle, signal, req, hooks);
      const known = live.get(handle.id);
      if (known) {
        if (signal.aborted) void known.cancel(signal.reason);
        else {
          const abort = () => void known.cancel(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          const cleanup = () => signal.removeEventListener("abort", abort);
          void known.result.then(cleanup, cleanup);
        }
        return known;
      }
      const initial = workers.job(handle.id);
      if (!initial) throw new Error("Unknown LAN gate job");
      const start = starts.get(handle.id);
      if (start) signal = AbortSignal.any([signal, start.signal]);
      const controller = new AbortController();
      const events: ExecutionEvent[] = [];
      let done = false;
      const cancel = async (reason = signal.reason) => {
        if (!gateShutdown(AbortSignal.abort(reason))) workers.cancel(handle.id);
        controller.abort();
      };
      const abort = () => void cancel();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const result = (async (): Promise<GateRun> => {
        let index = 0;
        for (;;) {
          controller.signal.throwIfAborted();
          workers.sweep();
          const job = workers.job(handle.id);
          if (!job) throw new Error("LAN gate job disappeared");
          const stored: ExecutionEvent[] = JSON.parse(job.events);
          events.push(...stored.slice(index));
          index = stored.length;
          if (job.state === "cancelled") throw new Error("LAN gate job cancelled");
          if (job.state === "done" && job.result) {
            const run = JSON.parse(job.result) as GateRun;
            const failed = run.setup.find((r) => !r.ok);
            if (!run.setupOk && failed && workers.fallbackSetup(handle.id, failed.command)) continue;
            return run;
          }
          if (job.state === "failed") {
            const request = JSON.parse(job.request) as GateRequest;
            workers.event(handle.id, { type: "status", text: "LAN gates falling back to local execution" });
            const fallback = async () => {
              const h = await local.start(request, controller.signal);
              const execution = local.attach(h, controller.signal, undefined, hooks);
              const stream = (async () => {
                for await (const e of execution.events) {
                  const safe = workers.sanitize(e);
                  events.push(safe);
                  workers.event(handle.id, safe);
                }
              })();
              const [run] = await Promise.all([execution.result, stream]);
              controller.signal.throwIfAborted();
              if (!workers.complete(handle.id, run, true)) throw new Error("LAN gate job cancelled");
              return workers.sanitize(run);
            };
            return start ? start.context(fallback) : fallback();
          }
          await Bun.sleep(workers.times.tick);
        }
      })().finally(() => {
        done = true;
        live.delete(handle.id);
        starts.delete(handle.id);
        signal.removeEventListener("abort", abort);
      });
      const execution = {
        result,
        cancel,
        events: {
          async *[Symbol.asyncIterator]() {
            let index = 0;
            while (!done || index < events.length) {
              const event = events[index];
              if (event) {
                index++;
                yield event;
              } else await Bun.sleep(workers.times.tick);
            }
            await result;
          },
        },
      };
      live.set(handle.id, execution);
      return execution;
    },
  };
}
