import type { StageName } from "../core/types.ts";
import type { FailureObservation } from "../db/failure-observations.ts";
import type { Store } from "../db/store.ts";
import { hostLoadPerCore, WorkerStore } from "../db/workers.ts";
import type { GateConfig } from "../gates/detect.ts";
import {
  blockInterrupted,
  cancelGateExecution,
  type ExecutionHandle,
  executeGate,
  type GateRequest,
  gateDigest,
  gateShutdown,
} from "../gates/executor.ts";
import { lanExecutor } from "../gates/lan.ts";
import { redactGateOutput } from "../gates/output.ts";
import type { GateHooks, GateResult, GateRun } from "../gates/run.ts";
import { confinementFailed, gateEnv } from "../gates/run.ts";
import { checkoutCommitted, headSha } from "../git/repos.ts";
import { withCommandScratch } from "../harness/sandbox.ts";
import { removeScratch, withScratch } from "../harness/scratch.ts";
import { ciSignature } from "../integrations/ci-classifier.ts";
import { invocationScratch } from "../util/proc.ts";
import type { RunContext } from "./context.ts";

/**
 * A LAN identity alone does not prove remote execution: it can finish locally.
 * Locality is structural, never inferred from the name: a worker may be called "coordinator".
 */
export function executionSite(
  store: Store,
  buildSha: string | undefined,
  runId: string | null,
  handle: ExecutionHandle,
) {
  const job = handle.kind === "local" ? null : new WorkerStore(store, buildSha).job(handle.id);
  const coordinator = { location: "coordinator", remote: false, job } as const;
  if (handle.kind === "local" || handle.kind === "inplace") return coordinator;
  const unknown = { location: null, remote: false, job } as const;
  if (handle.kind !== "lan" || !job || job.run_id !== runId) return unknown;
  if (job.failure_reason || job.setup_fallback) return coordinator;
  return job.state === "done" && !job.in_place && job.worker
    ? ({ location: job.worker, remote: true, job } as const)
    : unknown;
}

export function executionLocation(ctx: RunContext, handle: ExecutionHandle): string | null {
  return executionSite(ctx.store, ctx.deps.buildSha, ctx.run.id, handle).location;
}

export function observeGateFailures(
  store: Store,
  identity: Pick<
    FailureObservation,
    "run_id" | "repo" | "stage_id" | "round" | "sha" | "handle_kind" | "handle_id" | "purpose"
  >,
  handle: ExecutionHandle,
  result: GateRun,
  buildSha?: string,
  loadSource = hostLoadPerCore,
): void {
  const failed = (r: GateResult) =>
    !r.reused && r.docsOnly?.mode !== "skipped" && (!r.ok || r.timedOut || confinementFailed(r));
  if (![...result.setup, ...result.checks].some(failed)) return;
  const { location, remote, job } = executionSite(
    store,
    buildSha,
    identity.purpose === "land" ? null : identity.run_id,
    handle,
  );
  const coordinator = !remote && location !== null;
  const os = coordinator ? process.platform : remote ? (job?.worker_os ?? null) : null;
  const load = coordinator ? loadSource() : null;
  store.transaction(() => {
    for (const phase of ["setup", "check"] as const) {
      for (const r of phase === "setup" ? result.setup : result.checks) {
        const confinement = confinementFailed(r);
        if (!failed(r)) continue;
        const name = redactGateOutput(r.name),
          command = redactGateOutput(r.command);
        const output = redactGateOutput(r.output).slice(-6000);
        store.observations.insert({
          ...identity,
          phase,
          name,
          command,
          location: location === null ? null : redactGateOutput(location),
          os,
          load_per_core: load,
          observed_at: Date.now(),
          exit_code: r.exitCode,
          timed_out: Number(!!r.timedOut),
          confinement: Number(confinement),
          duration_ms: r.durationMs,
          failed_files: JSON.stringify((r.failedFiles ?? []).map(redactGateOutput)),
          output_tail: output,
          signature: ciSignature(name, output, command).signature,
          setup_eligible: Number((phase === "setup" || r.exitCode === 127) && !confinement),
        });
      }
    }
    if (
      identity.purpose === "land" &&
      ["landed", "blocked", "cancelled"].includes(
        store.getLandEntry(Number(identity.run_id.slice(5)))?.state ?? "",
      )
    )
      store.observations.finalize(identity.run_id);
  }, true);
}

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
      // An interrupted save can leave a replayable handle ahead of the in-memory state.
      keep: () =>
        ctx.store.getRunState<RunContext["state"]>(ctx.run.id)?.gateExecution?.handle.kind === "inplace",
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
  preserveSequence = true,
) {
  ctx.checkCancelled();
  const pending = ctx.state.gateExecution;
  if (!pending) return undefined;
  const executor = ctx.deps.gateExecutor;
  const round = ctx.state.round;
  sha ??= await headSha(cwd);
  const stored =
    pending?.stage === stage &&
    pending.handle.kind !== "local" &&
    pending.round === round &&
    (pending.purpose === purpose ||
      (preserveSequence && pending.previous?.some((attempt) => attempt.purpose === purpose))) &&
    (pending.handle.kind !== "inplace" || executor?.canResume?.(pending.handle, env, ctx.deps.cfg.port)) &&
    pending.sha === sha
      ? pending.handle
      : undefined;
  if (pending && !stored) {
    const workers = new WorkerStore(ctx.store, ctx.deps.buildSha);
    const job = pending.handle.kind === "inplace" ? workers.job(pending.handle.id) : null;
    const scratch = job ? (JSON.parse(job.request) as GateRequest).scratch : undefined;
    try {
      if (pending.handle.githubActions && (!pending.handle.githubActions.completed || pending.sha !== sha))
        await blockInterrupted(pending.handle, executor, async () => {});
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

/** Keep earlier results with the active attempt until the consumer durably saves its result. */
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
  const executor = ctx.deps.gateExecutor;
  const round = ctx.state.round;
  const pending = ctx.state.gateExecution;
  const sameIdentity = pending?.stage === stage && pending.round === round && pending.sha === sha;
  const gateKey = gateDigest(gates);
  const previous = sameIdentity ? [...(pending.previous ?? [])] : [];
  const replay = previous.find((attempt) => attempt.purpose === purpose && attempt.gateKey === gateKey);
  if (replay) {
    await resumeGateExecution(ctx, stage, pending?.purpose ?? purpose, cwd, env, sha);
    if (pending && executor?.kind !== pending.handle.kind)
      throw new Error(`Unavailable gate executor: ${pending.handle.kind}`);
    return structuredClone(replay.result);
  }
  const completed = pending?.handle.githubActions?.completed;
  let stored: ExecutionHandle | undefined;
  if (
    sameIdentity &&
    pending.gateKey &&
    completed &&
    (pending.purpose !== purpose || pending.gateKey !== gateKey)
  ) {
    // Leave the previous identity durable until the next handle and its history replace it together.
    try {
      // A changed configuration for the same attempt, or blocked work, never replaces Actions work.
      if (pending.purpose === purpose || pending.handle.githubActions?.interrupted)
        await blockInterrupted(pending.handle, executor, async () => {});
      await cancelGateExecution(pending.handle, executor);
      if (pending.handle.githubActions?.cleanupFailed)
        throw new Error("GitHub Actions gate cleanup remains pending");
    } catch (error) {
      await ctx.save("gate-cleanup-pending");
      throw error;
    }
    previous.push({ purpose: pending.purpose, gateKey: pending.gateKey, result: completed });
  } else stored = await resumeGateExecution(ctx, stage, purpose, cwd, env, sha, false);
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
        const first = ctx.state.gateExecution?.handle.id !== handle.id;
        ctx.state.gateExecution = { stage, round, purpose, sha, handle, gateKey, previous };
        if (first && purpose === "timeout")
          ctx.state.gateTimeoutReruns = (ctx.state.gateTimeoutReruns ?? 0) + 1;
        await ctx.save("gate-started");
      },
      () => {
        settled = true;
      },
    );
    // Preserve the handle if the result has not reached its evidence checkpoint.
    settled = false;
    await ctx.faults.hit("gate:executed", { runId: ctx.run.id, stage, round }, ctx.signal);
    const handle = stored ?? ctx.state.gateExecution?.handle;
    if (
      handle &&
      stage === "gates" &&
      (purpose === "initial" || purpose === "rebase") &&
      ctx.stageId !== undefined
    )
      observeGateFailures(
        ctx.store,
        {
          run_id: ctx.run.id,
          repo: ctx.repo.slug,
          stage_id: ctx.stageId,
          round,
          sha,
          handle_kind: handle.kind,
          handle_id: handle.id,
          purpose,
        },
        handle,
        result,
        ctx.deps.buildSha,
        ctx.deps.loadSource,
      );
    settled = true;
    ctx.checkCancelled();
    if (handle) onExecuted?.(handle, result);
    return result;
  } finally {
    // A termination before attach leaves the durable identity available for resume; so does
    // any Actions handle until consumed: a failed one stays blocked and retries pending cleanup.
    if (
      settled &&
      !(
        ["lan", "inplace", "github-actions"].includes(ctx.state.gateExecution?.handle.kind ?? "") &&
        gateShutdown(ctx.signal)
      ) &&
      !ctx.state.gateExecution?.handle.githubActions
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
