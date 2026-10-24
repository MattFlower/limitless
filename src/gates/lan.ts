import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalGateCwd, type WorkerStore } from "../db/workers.ts";
import { checkoutCommitted } from "../git/repos.ts";
import {
  type Execution,
  type ExecutionEvent,
  type GateExecutor,
  type GateRequest,
  gateProvenance,
  gateShutdown,
  localExecutor,
} from "./executor.ts";
import type { GateRun } from "./run.ts";
import { bindGateSlotScope, releaseGateSlotScope } from "./slots.ts";

export function lanExecutor(workers: WorkerStore, repos: readonly string[], inplace = false): GateExecutor {
  const local = localExecutor();
  const live = new Map<string, Execution<GateRun>>();
  const starts = new Map<
    string,
    { signal: AbortSignal; context: ReturnType<typeof AsyncLocalStorage.snapshot> }
  >();
  return {
    kind: inplace ? "inplace" : "lan",
    canResume: inplace
      ? (h, env, daemonPort) => {
          const j = workers.job(h.id);
          const req = j ? (JSON.parse(j.request) as GateRequest) : undefined;
          return (
            !!j?.in_place &&
            !!workers.releaseSha &&
            req?.releaseSha === workers.releaseSha &&
            (!env || isDeepStrictEqual(req?.env, env)) &&
            (daemonPort === undefined || req?.daemonPort === daemonPort) &&
            (j.state === "done" ||
              (j.state === "queued"
                ? !!workers.executor()
                : j.state === "leased" &&
                  !!j.worker &&
                  !!workers.executor(j.worker) &&
                  (j.lease_expires_at ?? 0) > workers.now()))
          );
        }
      : undefined,
    freshCheckoutFor: (repo) => !inplace && repos.includes(repo),
    async discard(handle) {
      workers.cancel(handle.id);
      await live.get(handle.id)?.cancel();
      starts.delete(handle.id);
      if (inplace) await workers.waitStopped(handle.id);
    },
    async start(req, signal) {
      signal.throwIfAborted();
      if (inplace) {
        const cwd = canonicalGateCwd(req.cwd);
        for (const j of workers.jobs("in_place=1 AND (state IN ('queued','leased') OR stopped=0)")) {
          if (canonicalGateCwd((JSON.parse(j.request) as GateRequest).cwd) !== cwd) continue;
          workers.cancel(j.id);
          await workers.waitStopped(j.id, signal);
        }
        if (!workers.executor()) {
          if (req.runId)
            workers.store.addEvent({
              runId: req.runId,
              type: "gate",
              level: "warn",
              message: "In-place executor unavailable on this release; running gates in-process",
            });
          return local.start(req, signal);
        }
      } else if (!repos.includes(req.repo)) return local.start(req, signal);
      await releaseGateSlotScope();
      signal.throwIfAborted();
      const id = inplace ? randomUUID() : workers.enqueue({ ...req, env: undefined });
      starts.set(id, { signal, context: AsyncLocalStorage.snapshot() });
      return { kind: inplace ? "inplace" : "lan", id, startedAt: workers.now() };
    },
    attach(handle, signal, req, hooks) {
      if (handle.kind === "local") return local.attach(handle, signal, req, hooks);
      if (inplace && starts.has(handle.id) && req && !workers.job(handle.id))
        workers.enqueue(req, handle.id, true);
      const initial = workers.job(handle.id);
      if (!initial) throw new Error("Unknown LAN gate job");
      const released =
        initial.state === "queued" || initial.state === "leased" ? releaseGateSlotScope() : undefined;
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
      const start = starts.get(handle.id);
      if (start) signal = AbortSignal.any([signal, start.signal]);
      const controller = new AbortController();
      const events: ExecutionEvent[] = [];
      let done = false;
      const cancel = async (reason = signal.reason) => {
        if (!gateShutdown(AbortSignal.abort(reason))) workers.cancel(handle.id);
        controller.abort();
        if (inplace && !gateShutdown(AbortSignal.abort(reason))) await workers.waitStopped(handle.id);
      };
      const abort = () => void cancel().catch(() => {});
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const result = (async (): Promise<GateRun> => {
        await released;
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
            if (!inplace && !run.setupOk && failed && workers.fallbackSetup(handle.id, failed.command))
              continue;
            if (inplace && run.setupOk) hooks?.onLocalSetup?.();
            return run;
          }
          if (job.state === "failed") {
            if (inplace) await workers.waitStopped(handle.id, controller.signal);
            const request = JSON.parse(job.request) as GateRequest;
            if (inplace) {
              await checkoutCommitted(request.cwd, undefined, Boolean(request.implementerIssue));
              request.gates = { ...request.gates, setup: request.fallbackSetup ?? request.gates.setup };
            }
            workers.event(handle.id, {
              type: "status",
              text: `${inplace ? "In-place" : "LAN"} gates falling back to local execution`,
            });
            const fallback = bindGateSlotScope(async () => {
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
              Object.assign(run, await gateProvenance(request.cwd, controller.signal));
              controller.signal.throwIfAborted();
              if (!workers.complete(handle.id, run, true)) throw new Error("LAN gate job cancelled");
              return workers.sanitize(run);
            });
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
