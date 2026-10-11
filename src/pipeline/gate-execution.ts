import type { StageName } from "../core/types.ts";
import type { GateConfig } from "../gates/detect.ts";
import { executeGate } from "../gates/executor.ts";
import { redactGateData } from "../gates/output.ts";
import type { GateHooks, GateRun } from "../gates/run.ts";
import { headSha } from "../git/repos.ts";
import type { RunContext } from "./context.ts";

/** Keep preceding attempts until the stage consumes them, including across a restart in a retry. */
export async function runGateExecution(
  ctx: RunContext,
  stage: StageName,
  purpose: string,
  cwd: string,
  gates: GateConfig,
  hooks: GateHooks = {},
): Promise<GateRun> {
  ctx.checkCancelled();
  const round = ctx.state.round;
  if (ctx.state.gateResults?.stage !== stage || ctx.state.gateResults.round !== round)
    ctx.state.gateResults = { stage, round, sha: await headSha(cwd), values: {} };
  const results = ctx.state.gateResults.values;
  if (results[purpose]) return results[purpose];
  const pending = ctx.state.gateExecution;
  const stored =
    pending?.stage === stage && pending.round === round && pending.purpose === purpose
      ? pending.handle
      : undefined;
  try {
    const result = await executeGate(
      {
        repo: ctx.repo.slug,
        cwd,
        baseSha: ctx.run.baseSha ?? "",
        headSha: await headSha(cwd),
        gates,
        checks: gates.checks.map((c) => c.name),
      },
      ctx.signal,
      hooks,
      ctx.deps.gateExecutor,
      stored,
      async (handle) => {
        ctx.state.gateExecution = { stage, round, purpose, handle: redactGateData(handle) };
        if (purpose === "timeout") ctx.state.gateTimeoutReruns = (ctx.state.gateTimeoutReruns ?? 0) + 1;
        await ctx.save("gate-started");
      },
    );
    ctx.checkCancelled();
    results[purpose] = redactGateData(result);
    ctx.state.gateExecution = undefined;
    await ctx.save("gate-result");
    return results[purpose];
  } catch (error) {
    ctx.checkCancelled();
    throw error;
  }
}
