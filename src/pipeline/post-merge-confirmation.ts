import { WorkerStore } from "../db/workers.ts";
import type { GateConfig } from "../gates/detect.ts";
import { type ExecutionHandle, executeGate, localExecutor } from "../gates/executor.ts";
import { findGateCounterpart, redactGateData, redactGateOutput } from "../gates/output.ts";
import {
  confinementFailed,
  type GateComparison,
  type GateResult,
  gateEnv,
  retryFailures,
  validateRetry,
} from "../gates/run.ts";
import type { RunContext } from "./context.ts";
import { InjectedFault, SimulatedTermination } from "./faults.ts";

/** A LAN handle alone does not prove remote execution: failed jobs can finish locally. */
export function postMergeWorker(ctx: RunContext, handle: ExecutionHandle): string | null | undefined {
  if (handle.kind !== "lan") return undefined;
  const job = new WorkerStore(ctx.store, ctx.deps.buildSha).job(handle.id);
  if (job?.failure_reason || job?.setup_fallback) return undefined;
  return job?.state === "done" && job.run_id === ctx.run.id && !job.in_place ? job.worker : null;
}

export async function confirmPostMerge(
  ctx: RunContext,
  cwd: string,
  gates: GateConfig,
  comparisons: GateComparison[],
  deadline: number,
  sha: string,
  save: () => Promise<void>,
): Promise<void> {
  const left = deadline - Date.now();
  const signal = AbortSignal.any([
    ctx.signal,
    left > 0 ? AbortSignal.timeout(left) : AbortSignal.abort(new Error("confirmation deadline")),
  ]);
  const local = localExecutor();
  for (const c of comparisons) {
    const original = c.firstAttempt ?? c.result.firstAttempt;
    if (c.result.ok && original && !original.ok) {
      const targeted = c.result.targetedRetry;
      const validated = targeted?.ok ? validateRetry(targeted, original, sha) : undefined;
      const restored = validated && !validated.ok ? validated : validateRetry(c.result, original, sha);
      if (!restored.ok) {
        c.result = { ...restored, retryAttempt: c.result, targetedRetry: targeted };
        c.verdict =
          c.retryOriginal?.verdict ??
          c.coordinatorConfirmation?.originalVerdict ??
          (original.docsOnly?.mode === "targeted" ? "targeted_failure" : "regressed");
        c.blocking = c.retryOriginal?.blocking ?? true;
        c.retryProvenanceRejected = true;
        if (c.coordinatorConfirmation) c.coordinatorConfirmation.reason = c.result.output;
        await save();
        continue;
      }
    }
    if (c.coordinatorConfirmation || c.retryProvenanceRejected) continue;
    if (!c.blocking || !["regressed", "targeted_failure"].includes(c.verdict)) continue;
    const worker = c.postMergeWorker;
    if (worker === undefined) continue;
    let reason = "worker execution attribution unavailable";
    let result: GateResult | undefined;
    const check = findGateCounterpart(c, comparisons, gates.checks);
    if (worker && check && redactGateOutput(check.run) === redactGateOutput(c.result.command)) {
      reason = "targeted retry returned no check result";
      try {
        signal.throwIfAborted();
        const retries = await retryFailures(
          [{ check, original: c.result }],
          cwd,
          gates,
          signal,
          undefined,
          (retry) =>
            executeGate(
              {
                repo: ctx.repo.slug,
                cwd,
                baseSha: ctx.run.baseSha ?? "",
                headSha: sha,
                gates: retry,
                env: gateEnv(),
                skipGateSlot: false,
                priority: "finish",
              },
              signal,
              { holder: ctx.run.id },
              local,
            ),
          true,
          true,
          (_original, why) => {
            reason = why;
          },
        );
        signal.throwIfAborted();
        result = retries.get(c.result);
        if (result)
          reason = confinementFailed(result)
            ? "confinement failure"
            : result.timedOut
              ? "confirmation timed out"
              : reason !== "targeted retry returned no check result"
                ? reason
                : result.ok
                  ? "pass (worker-specific flake)"
                  : "failed on coordinator";
      } catch (error) {
        ctx.checkCancelled();
        if (error instanceof SimulatedTermination || error instanceof InjectedFault) throw error;
        reason = signal.aborted
          ? "coordinator confirmation deadline expired (slot wait or execution)"
          : `coordinator confirmation unavailable: ${String(error)}`;
      }
    } else if (worker)
      reason = gates.setup.some((run) => redactGateOutput(run) === redactGateOutput(c.result.command))
        ? "setup failures are not retried"
        : "check does not match base configuration";
    c.coordinatorConfirmation = redactGateData({
      worker: worker ?? undefined,
      originalVerdict: c.verdict,
      reason,
      result,
    });
    if (result) {
      c.retryOriginal ??= { verdict: c.verdict, blocking: c.blocking };
      c.firstAttempt ??= c.result;
      c.result = redactGateData({
        ...result,
        ...(c.result.docsOnly ? { docsOnly: c.result.docsOnly } : {}),
      });
    }
    if (result?.ok && !result.timedOut && !confinementFailed(result)) {
      c.verdict = "flaky";
      c.blocking = false;
    }
    await save();
  }
}
