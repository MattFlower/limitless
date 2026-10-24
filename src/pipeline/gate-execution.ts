import type { StageName } from "../core/types.ts";
import { WorkerStore } from "../db/workers.ts";
import type { GateConfig } from "../gates/detect.ts";
import { cancelGateExecution, executeGate, gateShutdown } from "../gates/executor.ts";
import { lanExecutor } from "../gates/lan.ts";
import type { GateHooks, GateRun } from "../gates/run.ts";
import { gateEnv } from "../gates/run.ts";
import { headSha } from "../git/repos.ts";
import type { RunContext } from "./context.ts";

/** Resume only a stage's first execution; later attempts depend on its setup. */
export async function runGateExecution(
  ctx: RunContext,
  stage: StageName,
  purpose: string,
  cwd: string,
  gates: GateConfig,
  hooks: GateHooks = {},
  env = gateEnv(),
): Promise<GateRun> {
  ctx.checkCancelled();
  const executor = ctx.deps.gateExecutor;
  const round = ctx.state.round;
  const sha = await headSha(cwd);
  const pending = ctx.state.gateExecution;
  const stored =
    pending?.stage === stage &&
    pending.round === round &&
    pending.purpose === purpose &&
    ["baseline", "initial", "rebase"].includes(purpose) &&
    (pending.handle.kind !== "inplace" || executor?.canResume?.(pending.handle, env)) &&
    pending.sha === sha
      ? pending.handle
      : undefined;
  if (pending && !stored) {
    await cancelGateExecution(
      pending.handle,
      pending.handle.kind === "inplace"
        ? lanExecutor(new WorkerStore(ctx.store, ctx.deps.buildSha), [], true)
        : executor,
    );
    ctx.state.gateExecution = undefined;
    await ctx.save();
  }
  let settled = false;
  try {
    const result = await executeGate(
      {
        env,
        releaseSha: ctx.deps.buildSha,
        runId: ctx.run.id,
        repo: ctx.repo.slug,
        cwd,
        baseSha: ctx.run.baseSha ?? "",
        headSha: sha,
        gates,
        skipGateSlot: hooks.skipGateSlot,
        priority: stage === "prepare" ? "start" : "finish",
        checks: gates.checks.map((c) => c.name),
      },
      ctx.signal,
      hooks,
      executor,
      stored,
      async ({ kind, id, startedAt, url }) => {
        ctx.state.gateExecution = { stage, round, purpose, sha, handle: { kind, id, startedAt, url } };
        if (purpose === "timeout") ctx.state.gateTimeoutReruns = (ctx.state.gateTimeoutReruns ?? 0) + 1;
        await ctx.save("gate-started");
      },
      () => {
        settled = true;
      },
    );
    ctx.checkCancelled();
    return result;
  } finally {
    // A termination before attach leaves the durable identity available for resume.
    if (
      settled &&
      !(["lan", "inplace"].includes(ctx.state.gateExecution?.handle.kind ?? "") && gateShutdown(ctx.signal))
    ) {
      ctx.state.gateExecution = undefined;
      await ctx.save("gate-result");
    }
  }
}
