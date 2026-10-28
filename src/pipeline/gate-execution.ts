import type { StageName } from "../core/types.ts";
import { WorkerStore } from "../db/workers.ts";
import type { GateConfig } from "../gates/detect.ts";
import {
  cancelGateExecution,
  type ExecutionHandle,
  executeGate,
  type GateRequest,
  gateShutdown,
} from "../gates/executor.ts";
import { lanExecutor } from "../gates/lan.ts";
import type { GateHooks, GateRun } from "../gates/run.ts";
import { gateEnv } from "../gates/run.ts";
import { checkoutCommitted, headSha } from "../git/repos.ts";
import { withCommandScratch } from "../harness/sandbox.ts";
import { removeScratch, withScratch } from "../harness/scratch.ts";
import { invocationScratch } from "../util/proc.ts";
import type { RunContext } from "./context.ts";

/** The daemon owns scratch across detachment, reattachment and the stage's retries. */
export function gateCommandScope<T>(
  ctx: RunContext,
  stage: StageName,
  purpose: string,
  cwd: string,
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const handle = await resumeGateExecution(ctx, stage, purpose, cwd);
    const job =
      handle?.kind === "inplace" ? new WorkerStore(ctx.store, ctx.deps.buildSha).job(handle.id) : null;
    const scratch = job ? (JSON.parse(job.request) as GateRequest).scratch : undefined;
    return withScratch(cwd, (dir) => withCommandScratch(cwd, fn, dir), {
      existing: scratch,
      keep: () => gateShutdown(ctx.signal) && ctx.state.gateExecution?.handle.kind === "inplace",
    });
  };
}

/** Validate before preserving a surviving gate's worktree or doing destructive Git operations. */
export async function resumeGateExecution(
  ctx: RunContext,
  stage: StageName,
  purpose: string,
  cwd: string,
  env = gateEnv(),
  sha?: string,
) {
  ctx.checkCancelled();
  const pending = ctx.state.gateExecution;
  if (!pending) return undefined;
  const executor = ctx.deps.gateExecutor;
  const round = ctx.state.round;
  sha ??= await headSha(cwd);
  const stored =
    pending?.stage === stage &&
    pending.round === round &&
    pending.purpose === purpose &&
    ["baseline", "initial", "rebase"].includes(purpose) &&
    (pending.handle.kind !== "inplace" || executor?.canResume?.(pending.handle, env, ctx.deps.cfg.port)) &&
    pending.sha === sha
      ? pending.handle
      : undefined;
  if (pending && !stored) {
    const workers = new WorkerStore(ctx.store, ctx.deps.buildSha);
    const job = pending.handle.kind === "inplace" ? workers.job(pending.handle.id) : null;
    const scratch = job ? (JSON.parse(job.request) as GateRequest).scratch : undefined;
    try {
      await cancelGateExecution(
        pending.handle,
        pending.handle.kind === "inplace" ? lanExecutor(workers, [], true) : executor,
      );
      if (pending.handle.githubActions?.cleanupFailed)
        throw new Error("GitHub Actions gate cleanup remains pending");
    } catch (error) {
      await ctx.save("gate-cleanup-pending");
      throw error;
    }
    ctx.state.gateExecution = undefined;
    await ctx.save();
    if (pending.handle.kind === "inplace")
      await checkoutCommitted(cwd, undefined, Boolean(ctx.state.implementerIssue));
    if (scratch && scratch !== invocationScratch.getStore()) removeScratch(scratch);
  }
  return stored;
}

/** Resume only a stage's first execution; later attempts depend on its setup. */
export async function runGateExecution(
  ctx: RunContext,
  stage: StageName,
  purpose: string,
  cwd: string,
  gates: GateConfig,
  hooks: GateHooks = {},
  env = gateEnv(),
  onExecuted?: (handle: ExecutionHandle, result: GateRun) => void,
): Promise<GateRun> {
  ctx.checkCancelled();
  const sha = await headSha(cwd);
  const stored = await resumeGateExecution(ctx, stage, purpose, cwd, env, sha);
  const executor = ctx.deps.gateExecutor;
  const round = ctx.state.round;
  let settled = false;
  try {
    const result = await executeGate(
      {
        env,
        releaseSha: ctx.deps.buildSha,
        daemonPort: ctx.deps.cfg.port,
        scratch: invocationScratch.getStore(),
        implementerIssue: Boolean(ctx.state.implementerIssue),
        fallbackSetup: hooks.fallbackSetup,
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
      async (handle) => {
        const first = !ctx.state.gateExecution;
        ctx.state.gateExecution = { stage, round, purpose, sha, handle };
        if (first && purpose === "timeout")
          ctx.state.gateTimeoutReruns = (ctx.state.gateTimeoutReruns ?? 0) + 1;
        await ctx.save("gate-started");
      },
      () => {
        settled = true;
      },
    );
    ctx.checkCancelled();
    const handle = stored ?? ctx.state.gateExecution?.handle;
    if (handle) onExecuted?.(handle, result);
    return result;
  } finally {
    // A termination before attach leaves the durable identity available for resume; so does
    // failed remote cleanup, so a later resume or discard retries it.
    if (
      settled &&
      !(
        ["lan", "inplace", "github-actions"].includes(ctx.state.gateExecution?.handle.kind ?? "") &&
        gateShutdown(ctx.signal)
      ) &&
      !ctx.state.gateExecution?.handle.githubActions?.cleanupFailed &&
      !ctx.state.gateExecution?.handle.githubActions?.completed
    ) {
      ctx.state.gateExecution = undefined;
      await ctx.save("gate-result");
    }
  }
}

/** Call only when saving the consumer's result in the same checkpoint. */
export function consumeGateExecution(ctx: RunContext): void {
  const progress = ctx.state.gateExecution?.handle.githubActions;
  if (progress?.completed && !progress.cleanupFailed) ctx.state.gateExecution = undefined;
}
