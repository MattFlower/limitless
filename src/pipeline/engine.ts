import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { repoSettings } from "../config.ts";
import { assertExistingBranchDelivery, assertFactoryBranchPush, isBranchName } from "../core/delivery.ts";
import { type ResolvedProfile, type Run, type RunStatus, TERMINAL_STATUSES } from "../core/types.ts";
import { type AuditFinding, auditDiff } from "../gates/audit.ts";
import {
  BASELINE_CACHE_TTL_MS,
  baselineCacheKey,
  cacheableBaseline,
  gateBunVersion,
  gateEnvDigest,
  lockfileHash,
  singleFlight,
} from "../gates/cache.ts";
import {
  assertDistinctGateNames,
  detectGates,
  type GateConfig,
  GateNameCollisionError,
  gateScriptNames,
  pickScripts,
  readDocs,
  readRetryFiles,
} from "../gates/detect.ts";
import { docsOnlyGates } from "../gates/docs.ts";
import { gateProvenance } from "../gates/executor.ts";
import { formatGateOutput } from "../gates/failures.ts";
import { canonicalTestFile } from "../gates/junit.ts";
import { findGateCounterpart, redactGateData, redactGateOutput } from "../gates/output.ts";
import { loadPrivateStrings, PrivateError, privateStringsDigest, redactPrivate } from "../gates/private.ts";
import { checkPublicationText, publicationWorktree, sanitizePublication } from "../gates/publication.ts";
import {
  compareGates,
  confinementFailed,
  type GateComparison,
  type GateHooks,
  type GateRun,
  gateEnv,
  isSlowRegression,
  retryBaselineFailures,
  retryRegressions,
  runLocalGates,
  validateRetry,
} from "../gates/run.ts";
import { gateSlotScope } from "../gates/slots.ts";
import { WorktreeCleanError, worktreeGit, worktreeGitScope } from "../git/command.ts";
import { completeMerge, mergeGit, prepareMerge, requireMerge, validateMerge } from "../git/merge.ts";
import {
  adoptWorkerCommit,
  assertWorkflowPublication,
  checkoutCommitted,
  checkPrivateRange,
  commitAll,
  createPullRequest,
  createWorktree,
  deliveryPublicationRange,
  diffSince,
  discardChanges,
  ensureCache,
  exportCommit,
  fetchBase,
  findPullRequest,
  formatTopLevel,
  type GitHubBudget,
  GitHubUnavailableError,
  githubRetry,
  githubWait,
  headSha,
  isAncestor,
  mergeBase,
  mergePullRequest,
  type PullRequestIdentity,
  pushBranch,
  pushExistingBranch,
  readFileAt,
  remoteBranchSha,
  removeWorktree,
  resetTo,
  verifyWorkerCommit,
  withGitHubRetry,
} from "../git/repos.ts";
import { readPolicyScope } from "../harness/read-policy.ts";
import { confinementScope, platformConfinement } from "../harness/sandbox.ts";
import { readAgentFullSuite, readSlottedCommands } from "../harness/slotted-config.ts";
import { type GhRunner, runGh } from "../integrations/github.ts";
import { originExclusion } from "../router/origins.ts";
import type { RouteConstraints } from "../router/router.ts";
import { formatTarget } from "../router/targets.ts";
import {
  assertProcessesStopped,
  CommandError,
  ProcessTerminationError,
  processScope,
  recoverScopedProcesses,
  redactCredentials,
} from "../util/proc.ts";
import { publicationFields } from "../workers/publication.ts";
import {
  type AgentPublication,
  type AgentPublicationHooks,
  prepareReaderCheckout,
} from "./agent-executor.ts";
import { reusableAgentGate } from "./agent-gate.ts";
import { statedBudget } from "./budget.ts";
import { clearGitHubWait, finalizeRecordedCancellation } from "./cancellation.ts";
import {
  CancelledError,
  type EngineDeps,
  invokeGuard,
  NeedsHumanError,
  NoCapacityError,
  ParkedError,
  Preempted,
  RunContext,
  type RunState,
  redactPostMergeComparisons,
} from "./context.ts";
import { InjectedFault, SimulatedTermination } from "./faults.ts";
import { applyGateEvidence, gateTestCommand } from "./gate-evidence.ts";
import { gateCommandScope, resumeGateExecution, runGateExecution } from "./gate-execution.ts";
import {
  checkDiscreetCommits,
  DiscreetError,
  deliveryMarker,
  discreetModelText,
  hasFactoryMark,
} from "./markers.ts";
import { confirmPostMerge, postMergeWorker } from "./post-merge-confirmation.ts";
import { needsPreview, type Preview, readPreviewConfig, startPreview } from "./preview.ts";
import {
  formatAuditFeedback,
  formatGateFeedback,
  formatReviewFeedback,
  formatVerifyFeedback,
  holdoutPrompt,
  implementPrompt,
  promptJson,
  redactHoldoutText,
  specPrompt,
  triagePrompt,
  verifyPrompt,
} from "./prompts.ts";
import { buildReportArtifacts, saveReport } from "./report.ts";
import { stripReportManifest } from "./report-privacy.ts";
import {
  blockingReviewFindings,
  FinderSkipped,
  PANEL_REVIEWS,
  type PanelReview,
  pickVerifier,
  type ReviewInput,
  type ReviewRequest,
  resolvedPriorFindings,
  reviewFindingKey,
  runReview,
  type VerifierRequest,
} from "./review.ts";
import { readPrHead, roundSection, withPrLock } from "./review-round.ts";
import { type ShadowDeps, shadowReview } from "./review-shadow.ts";
import { configuredReviewSystem, readReviewLenses } from "./review-system.ts";
import {
  type Holdout,
  HoldoutSchema,
  type Review,
  type ReviewScope,
  renderSpec,
  rowKind,
  type Spec,
  SpecSchema,
  TriageSchema,
  toStrictJsonSchema,
  type Verify,
  VerifySchema,
} from "./schemas.ts";
import { measureSize } from "./size.ts";
import { createSnapshotParent } from "./snapshots.ts";
import { outOfRunCriteria, specCriteriaRange } from "./spec-criteria.ts";
import { specScopeViolation } from "./spec-scope.ts";
import { triageDecisions } from "./triage-decisions.ts";
import {
  blockedOnly,
  ENVIRONMENT_BLOCKED,
  normalizeVerify,
  preDeliveryVerifyArtifact,
} from "./verification.ts";

const ROUNDS_PER_IMPLEMENTER = 2;

// Resume the interrupted reader without publishing a draft or persisting a terminal reason.
class ReaderSetupError extends NeedsHumanError {}

/** Execute (or resume) one run to completion. Never throws. */
export async function executeRun(
  deps: EngineDeps,
  runId: string,
  signal: AbortSignal,
  isDraining: () => boolean = () => false,
  drainEvents?: EventTarget,
): Promise<RunStatus> {
  const run = deps.store.getRun(runId);
  if (!run) return "failed";
  if (finalizeRecordedCancellation(deps.store, runId)) return "cancelled";
  const repo = deps.store.getRepo(run.repoId);
  if (!repo) {
    deps.store.updateRun(runId, { status: "failed", error: "repo not found", finishedAt: Date.now() });
    return "failed";
  }
  // Local runs work in a factory-owned clone too; legacy source worktrees only gain `-c` flags.
  const ctx = new RunContext(deps, run, repo, signal, isDraining, drainEvents);
  return processScope.run(
    {
      signal: ctx.signal,
      killGraceMs: 100,
      children: new Map(),
      scratchDirs: new Set(),
      runId,
      cleanups: deps.store,
      checkout: () => ctx.state.worktreePath,
    },
    () =>
      confinementScope.run(deps.confinement ?? platformConfinement(deps.cfg.port), () =>
        readPolicyScope.run(deps.cfg.readPolicy, () =>
          worktreeGitScope.run(true, () => executeScopedRun(ctx, signal)),
        ),
      ),
  );
}

const REVIEW_RESOLUTION_BLOCK = "Review-base resolution requires a compatible engine to implement findings";

async function executeScopedRun(ctx: RunContext, signal: AbortSignal): Promise<RunStatus> {
  const { deps, run } = ctx;
  const runId = run.id;
  // Upgrade pending checkpoints from before rollback protection, before any state/run write.
  if (ctx.state.reviewResolution && !ctx.state.reviewResolution.sha)
    ctx.state.needsHumanReason ??= REVIEW_RESOLUTION_BLOCK;
  ctx.state.parked = false;
  if (ctx.state.phase !== "deliver") ctx.state.githubWait = undefined;
  // A recorded rejection is already terminal; resume only finishes its rollback.
  if (!ctx.state.postMergeRejection)
    ctx.run = deps.store.updateRun(
      runId,
      {
        status: "running",
        error: null,
        ...(run.startedAt ? {} : { startedAt: Date.now() }),
      },
      ctx.state,
    );
  if (ctx.state.phase !== "prepare") ctx.log(`Resuming at phase "${ctx.state.phase}"`, "warn");

  try {
    await recoverScopedProcesses();
    if (ctx.state.postMergeRejection) await rollbackRejectedMerge(ctx);
    // Recheck persisted provenance on resume, including runs created before this guard existed.
    assertExistingBranchDelivery(ctx.repo, ctx.run, reviewRound(ctx)?.grant);
    if (
      ctx.state.needsHumanReason &&
      !(
        ctx.state.needsHumanReason === REVIEW_RESOLUTION_BLOCK &&
        ctx.state.reviewResolution &&
        !ctx.state.reviewResolution.sha
      )
    )
      throw new NeedsHumanError(
        ctx.state.needsHumanReason.startsWith(ENVIRONMENT_BLOCKED) &&
          ctx.state.terminalReason &&
          !ctx.state.terminalReason.startsWith(ENVIRONMENT_BLOCKED)
          ? ctx.state.terminalReason
          : ctx.state.needsHumanReason,
      );
    ctx.state.flow ??= "build";
    await ctx.save();
    if (ctx.state.flow === "verify-change" && ctx.state.phase !== "prepare" && !ctx.state.verification)
      throw new Error("Verification state is missing its recorded PR revisions");
    if (ctx.state.phase !== "prepare" && ctx.state.previewConfig === undefined) {
      if (!ctx.run.baseSha || !ctx.state.worktreePath)
        throw new Error("Cannot restore base preview configuration: missing base SHA or worktree");
      // Upgrade older runs using the trusted revision, never the edited worktree config.
      ctx.state.previewConfig = readPreviewConfig(
        await readFileAt(
          ctx.state.worktreePath,
          ctx.state.verification?.baseSha ?? ctx.run.baseSha,
          ".limitless.toml",
        ),
      );
      await ctx.save();
    }
    if (
      ctx.state.phase !== "prepare" &&
      (ctx.state.slottedCommands === undefined || ctx.state.agentFullSuite === undefined)
    ) {
      const trustedSha =
        reviewRound(ctx)?.owner.baseSha ?? ctx.state.verification?.baseSha ?? ctx.run.baseSha;
      if (!trustedSha || !ctx.state.worktreePath)
        throw new Error("Cannot restore base slotted commands: missing base SHA or worktree");
      const contents = await readFileAt(ctx.state.worktreePath, trustedSha, ".limitless.toml");
      ctx.state.slottedCommands ??= readSlottedCommands(contents, (message) => ctx.log(message, "warn"));
      ctx.state.agentFullSuite ??= readAgentFullSuite(contents, (message) => ctx.log(message, "warn"));
      await ctx.save();
    }
    if (ctx.state.phase === "prepare") await prepare(ctx);
    if (ctx.state.phase === "triage") await triage(ctx);
    if (ctx.state.phase === "clarify") await clarify(ctx);
    if (ctx.state.phase === "spec") await spec(ctx);
    while (ctx.state.phase === "loop" || ctx.state.phase === "deliver") {
      if (ctx.state.phase === "loop") await buildLoop(ctx);
      if (ctx.state.phase === "deliver") {
        await deliver(ctx, true);
        if (ctx.state.phase === "deliver") break;
      }
    }
    ctx.checkCancelled();
    await ctx.setPhase("done");
    ctx.checkCancelled();
    ctx.run = deps.store.updateRun(runId, { status: "succeeded", stage: null, finishedAt: Date.now() });
    // Terminal success ends the cancellation window before destructive worktree cleanup.
    if (ctx.repo.kind === "github" && ctx.state.worktreePath) {
      try {
        await removeWorktree(ctx.deps.cfg.paths, ctx.repo, ctx.state.worktreePath);
      } catch (error) {
        ctx.log(`Worktree cleanup deferred to GC: ${(error as Error).message}`, "warn");
      }
    }
    ctx.log("Run succeeded");
    return "succeeded";
  } catch (e) {
    const terminationError = processScope.getStore()?.terminationError;
    if (
      terminationError &&
      !ctx.state.postMergeRejection &&
      ctx.state.needsHumanReason !== terminationError.message
    ) {
      ctx.state.feedback = redactGateOutput(
        `${ctx.state.implementerIssue ?? "Invocation ended"}\n${terminationError.message}`,
      );
      ctx.state.needsHumanReason = terminationError.message;
      // Shutdown can re-queue this run. Persist the cleanup block even with an aborted
      // signal, so a fresh process scope on resume cannot start another round.
      deps.store.setRunState(runId, ctx.state);
    }
    if (!signal.aborted && (e instanceof SimulatedTermination || ctx.termination)) return "running";
    if (ctx.state.postMergeRejection && (signal.aborted || !(e instanceof NeedsHumanError))) {
      ctx.log(`Rejected post-merge rollback interrupted: ${(e as Error).message}`, "warn");
      return finalizePostMergeRejection(ctx, ctx.state.postMergeRejection.reason);
    }
    if (e instanceof InjectedFault && !signal.aborted) {
      ctx.log(`Run interrupted: ${e.message}; re-queued to resume`, "warn");
      deps.store.updateRun(runId, { status: "queued", stage: null });
      return "queued";
    }
    const cancelled = (): RunStatus => {
      const rejected = ctx.state.postMergeRejection?.reason;
      if (rejected) {
        // A recorded rejection is terminal; shutdown during draft reporting must not requeue it.
        const status = finalizePostMergeRejection(ctx, rejected);
        ctx.log(`Draft reporting interrupted; rejected post-merge run stays ${status}`, "warn");
        return status;
      }
      const reason = ctx.state.terminalReason?.startsWith("superseded:")
        ? ctx.state.terminalReason
        : undefined;
      const shutdown =
        signal.reason instanceof Error &&
        signal.reason.message === "shutdown" &&
        !reason &&
        !deps.store.getRun(runId)?.error?.startsWith("cancelled by");
      const status = shutdown ? "queued" : "cancelled";
      // An interrupted save can leave in-memory state ahead of its durable checkpoint.
      const state = shutdown ? undefined : clearGitHubWait(deps.store.getRunState<RunState>(runId));
      if (!shutdown) clearGitHubWait(ctx.state);
      deps.store.updateRun(
        runId,
        {
          status,
          finishedAt: shutdown ? null : Date.now(),
          ...(reason ? { error: redactGateOutput(reason) } : {}),
        },
        state ?? undefined,
      );
      ctx.log(reason ?? (shutdown ? "Daemon shutdown; run re-queued to resume" : "Run cancelled"), "warn");
      return status;
    };
    if (e instanceof CancelledError || signal.aborted) return cancelled();
    if (e instanceof ParkedError) {
      ctx.state.parked = true;
      ctx.run = deps.store.updateRun(runId, { status: "queued", stage: null }, ctx.state);
      ctx.log(`Run parked at phase "${ctx.state.phase}" for deploy`);
      return "queued";
    }
    const verifiedSha = ctx.state.lastVerifiedSha;
    const terminationBlocked =
      !!processScope.getStore()?.terminationError ||
      ctx.state.needsHumanReason?.startsWith(ProcessTerminationError.prefix);
    const unavailable = githubUnavailable(e);
    const now = Date.now();
    const since = ctx.state.githubWait?.since ?? now;
    if (
      unavailable &&
      ctx.state.phase === "deliver" &&
      ctx.repo.kind === "github" &&
      !ctx.run.deliveryBranch &&
      !reviewRound(ctx) &&
      !ctx.state.verification &&
      !terminationBlocked &&
      githubWait.maxMs > 0 &&
      now < since + githubWait.maxMs
    ) {
      if (deps.store.getRun(runId)?.error?.startsWith("cancelled by")) return cancelled();
      const reason = redactCredentials((e as Error).message).slice(0, 300);
      ctx.state.githubWait = { since, nextAttemptAt: now + githubWait.intervalMs, reason };
      ctx.run = deps.store.updateRun(runId, { status: "queued", stage: null }, ctx.state);
      ctx.log(
        `GitHub unavailable; delivery retries at ${new Date(ctx.state.githubWait.nextAttemptAt).toISOString()}, gives up at ${new Date(since + githubWait.maxMs).toISOString()}: ${reason}`,
        "warn",
      );
      return "queued";
    }
    const waited =
      unavailable && ctx.state.githubWait
        ? `; waited ${Math.floor((now - since) / 60_000)} minutes for GitHub`
        : "";
    if (ctx.state.githubWait) {
      ctx.state.githubWait = undefined;
      deps.store.setRunState(runId, ctx.state);
    }
    const verifiedFailure =
      verifiedSha &&
      ctx.repo.kind === "github" &&
      !ctx.run.deliveryBranch &&
      (!ctx.run.prUrl || !!ctx.state.needsHumanReason) &&
      (ctx.state.phase === "deliver" || ctx.state.conflictRound !== undefined);
    const resolvingReview = !!ctx.state.reviewResolution && !ctx.state.reviewResolution.sha;
    const needsHuman =
      e instanceof NeedsHumanError ||
      e instanceof NoCapacityError ||
      !!verifiedFailure ||
      resolvingReview ||
      terminationBlocked;
    let message = redactGateOutput((e as Error).message) + waited;
    if (resolvingReview && !(e instanceof ReaderSetupError)) {
      message = redactGateOutput(
        `The PR branch conflicts with ${reviewRound(ctx)?.owner.baseBranch ?? ctx.repo.defaultBranch} in ${(ctx.state.conflictFiles ?? []).join(", ")}; resolution failed: ${message}`,
      );
      ctx.state.needsHumanReason = message;
      deps.store.setRunState(runId, ctx.state);
    }
    const failureStage =
      ctx.state.conflictRound !== undefined
        ? "conflict resolution"
        : message.includes("post-merge gate")
          ? "post-merge gates"
          : ctx.run.stage === "deliver"
            ? "delivery merge"
            : (ctx.run.stage ?? "delivery merge");
    ctx.log(`Run ${needsHuman ? "needs a human" : "failed"}: ${message}`, "error", {
      stack: (e as Error).stack,
    });
    if (
      verifiedFailure &&
      !(e instanceof ReaderSetupError) &&
      !(e instanceof DeliveryHeadError) &&
      !(e instanceof GateNameCollisionError) &&
      !terminationBlocked &&
      !ctx.state.terminalReason?.startsWith("the resolution leaves no change against ")
    ) {
      try {
        ctx.state.needsHumanReason = message;
        await ctx.save("needs-human");
        await ctx.stage(
          "deliver",
          async () => {
            await deliverVerifiedDraft(ctx, verifiedSha, failureStage, message);
            return { summary: "verified-work draft delivered", value: undefined };
          },
          ctx.state.round,
          false,
          false,
        );
      } catch (err) {
        if (err instanceof CancelledError || signal.aborted) return cancelled();
        if (
          !signal.aborted &&
          (err instanceof SimulatedTermination || ctx.termination || err instanceof InjectedFault)
        )
          return "running";
        // A failed fallback must retain the delivery fault that made the draft necessary.
        if (err instanceof NeedsHumanError)
          message += `; verified-work draft failed: ${redactGateOutput(err.message)}`;
        ctx.log(`Could not open verified-work draft PR: ${(err as Error).message}`, "warn");
      }
    } else if (
      e instanceof NeedsHumanError &&
      !(e instanceof ReaderSetupError) &&
      !(e instanceof DeliveryHeadError) &&
      !terminationBlocked &&
      ctx.state.worktreePath &&
      ((ctx.state.conflictRound === undefined && !ctx.state.pendingRebaseSha && !resolvingReview) ||
        environmentBlockedRound(ctx)) &&
      !(reviewRound(ctx)?.kind === "ci" && ctx.run.headSha === reviewRound(ctx)?.reviewedSha)
    ) {
      // Surface the unfinished work as a draft PR so a human can pick it up.
      try {
        if (ctx.state.needsHumanReason !== message) {
          ctx.state.needsHumanReason = message;
          await ctx.save("needs-human");
        }
        await deliver(ctx, false);
      } catch (err) {
        if (
          !signal.aborted &&
          (err instanceof SimulatedTermination || ctx.termination || err instanceof InjectedFault)
        )
          return "running";
        // Cancellation or shutdown during the draft must not be recorded as the original failure.
        if (err instanceof CancelledError || signal.aborted) return cancelled();
        if (err instanceof NeedsHumanError) message = redactGateOutput(err.message);
        ctx.log(`Could not open draft PR: ${(err as Error).message}`, "warn");
      }
    }
    if (
      !message.startsWith(ENVIRONMENT_BLOCKED) &&
      (ctx.state.needsHumanReason?.startsWith(ENVIRONMENT_BLOCKED) ||
        ctx.state.terminalReason?.startsWith(ENVIRONMENT_BLOCKED)) &&
      (ctx.state.needsHumanReason !== message || ctx.state.terminalReason !== message)
    ) {
      ctx.state.needsHumanReason = redactCredentials(message);
      ctx.state.terminalReason = ctx.state.needsHumanReason;
      deps.store.setRunState(runId, ctx.state);
    }
    if (ctx.state.postMergeRejection)
      return finalizePostMergeRejection(ctx, ctx.state.postMergeRejection.reason);
    const status: RunStatus = needsHuman ? "needs_human" : "failed";
    deps.store.updateRun(runId, { status, error: message.slice(0, 2000), finishedAt: Date.now() });
    return status;
  }
}

// ---------------------------------------------------------------------------
// prepare: repo cache, worktree, gate detection, baseline

function gateEvents(
  ctx: RunContext,
  label?: string,
): Required<Omit<GateHooks, "onLocalSetup" | "env" | "fallbackSetup">> {
  return {
    priority: "finish",
    skipGateSlot: false,
    holder: ctx.run.id,
    onResult: (r) =>
      ctx.event({
        runId: ctx.run.id,
        type: "gate",
        level: r.ok ? "info" : "warn",
        message: `${label ?? r.name}: ${r.ok ? "pass" : r.timedOut ? "timed out" : "FAIL"} (${Math.round(r.durationMs / 1000)}s)`,
        data: r,
      }),
    onWait: (slots) =>
      ctx.event({
        runId: ctx.run.id,
        type: "gate",
        message: `Waiting for a gate slot (all ${slots} in use; limits.max_concurrent_gates)`,
      }),
  };
}

/** A review round's record and the grant it alone gives to push onto its original run's PR branch. */
function reviewRound(ctx: RunContext) {
  const review = ctx.store.reviewRound(ctx.run.id);
  if (review && review.kind !== "review" && review.kind !== "conflict" && review.kind !== "ci")
    throw new Error(`Unsupported review round kind: ${redactCredentials(review.kind)}`);
  return (
    review && { ...review, grant: { owner: review.owner, prUrl: review.prUrl, head: review.reviewedSha } }
  );
}
type ReviewRoundRecord = NonNullable<ReturnType<typeof reviewRound>>;

async function prepare(ctx: RunContext): Promise<void> {
  assertExistingBranchDelivery(ctx.repo, ctx.run, reviewRound(ctx)?.grant);
  await ctx.stage("prepare", async () => {
    const { cfg, store } = ctx.deps;
    if (ctx.state.flow === "verify-change") {
      const ref = ctx.run.sourceRef;
      if (
        typeof ref?.baseRef !== "string" ||
        !isBranchName(ref.baseRef) ||
        typeof ref.baseSha !== "string" ||
        !/^[a-fA-F0-9]{40}$/.test(ref.baseSha) ||
        typeof ref.headSha !== "string" ||
        !/^[a-fA-F0-9]{40}$/.test(ref.headSha) ||
        ref.repo !== ctx.repo.slug ||
        typeof ref.number !== "number" ||
        !Number.isSafeInteger(ref.number) ||
        ref.number <= 0
      )
        throw new Error("Verification requires valid PR baseRef, baseSha, headSha and repository metadata");
      ctx.state.verification = { baseSha: ref.baseSha, headSha: ref.headSha };
      await ctx.save();
    }
    if (ctx.repo.kind === "github") await ensureCache(cfg.paths, ctx.repo);
    const base = ctx.run.baseBranch ?? ctx.repo.defaultBranch;
    const reusingWorktree = existsSync(join(cfg.paths.work, ctx.run.id));
    const wt = await createWorktree(cfg.paths, ctx.repo, ctx.run.id, ctx.run.title, base, {
      cfg,
      store,
      gh: ctx.deps.gh,
    });
    const review = reviewRound(ctx);
    // Refused before any model call; delivery checks the PR again just before pushing.
    if (review && wt.baseSha !== review.reviewedSha)
      throw new Error(
        `head moved: the PR branch is at ${wt.baseSha}, not the reviewed ${review.reviewedSha}`,
      );
    if (!review && ctx.run.deliveryBranch && ctx.run.sourceRef?.headSha !== wt.baseSha)
      throw new Error("PR head moved before preparation");
    ctx.state.worktreePath = wt.path;
    // A round's change is measured from the PR merged with its current base, not from the PR head.
    const merged = review?.kind === "review" && (await mergeReviewBase(ctx, wt.path, review));
    const baseSha =
      merged ||
      (reusingWorktree && ctx.state.flow !== "verify-change"
        ? (ctx.run.baseSha ?? (await headSha(wt.path)))
        : wt.baseSha);
    ctx.run = store.updateRun(ctx.run.id, { baseBranch: base, baseSha, branch: wt.branch });
    const verification = ctx.state.verification;
    const env = gateEnv();
    const resuming =
      (await resumeGateExecution(ctx, "prepare", "baseline", wt.path, env))?.kind === "inplace";
    if (verification) {
      ctx.run = store.updateRun(ctx.run.id, { baseSha: verification.headSha });
      if (!resuming) await resetTo(wt.path, verification.baseSha);
    }
    if (!resuming) await discardChanges(wt.path);
    // A round's gate, audit and review settings come from its original run's base commit: an
    // earlier round's edits to the PR must never weaken the next round's checks.
    const trustedSha = review ? review.owner.baseSha : (verification?.baseSha ?? baseSha);
    if (!trustedSha) throw new Error("Review round's original run has no recorded base commit");
    const trusted =
      review &&
      (await withBaseSnapshot(
        ctx,
        async (dir) => {
          const detected = detectGates(dir);
          return { gates: detected, scripts: pickScripts(readPackageJson(dir), gateScriptNames(detected)) };
        },
        trustedSha,
      ));
    let gates: GateConfig;
    try {
      const repoConfig = await readFileAt(wt.path, trustedSha, ".limitless.toml");
      ctx.state.previewConfig = readPreviewConfig(repoConfig);
      ctx.state.agentFullSuite = readAgentFullSuite(repoConfig, (message) => ctx.log(message, "warn"));
      ctx.state.slottedCommands = readSlottedCommands(repoConfig, (message) => ctx.log(message, "warn"));
      // Review lenses come from the base commit, never from the change under review.
      if (ctx.deps.cfg.reviewMode === "panel")
        ctx.state.reviewLenses = readReviewLenses(repoConfig, (message) => ctx.log(message, "warn"));
      // A shadow never fails a run: an invalid table only skips it.
      else if (ctx.deps.cfg.reviewShadow === "panel")
        try {
          ctx.state.shadowLenses = readReviewLenses(repoConfig, (message) => ctx.log(message, "warn"));
        } catch (error) {
          ctx.state.shadowLenses = { error: String((error as Error).message).slice(0, 500) };
        }
      gates =
        ctx.state.gateExecution?.handle.kind === "inplace" && ctx.state.gatesConfig
          ? ctx.state.gatesConfig
          : trusted
            ? trusted.gates
            : detectGates(wt.path);
      gates.retryFiles = readRetryFiles(repoConfig, (message) => ctx.log(message, "warn"));
      gates.docs = readDocs(repoConfig, (message) => ctx.log(message, "warn"));
      ctx.state.gatesConfig = gates;
      ctx.state.baselineScripts = trusted
        ? trusted.scripts
        : pickScripts(readPackageJson(wt.path), gateScriptNames(gates));
      ctx.log(
        redactGateOutput(
          `Gates (${gates.source}): ${[...gates.setup, ...gates.checks.map((c) => c.run)].join(" | ") || "none"}`,
        ),
      );
      await ctx.save();
      const { onWait } = gateEvents(ctx);
      const hasGates = gates.setup.length > 0 || gates.checks.length > 0;
      const baselineSha = await headSha(wt.path);
      const runBaseline = gateSlotScope(
        gateCommandScope(ctx, "prepare", "baseline", wt.path, async (): Promise<GateRun> => {
          const run = await runGateExecution(ctx, "prepare", "baseline", wt.path, gates, { onWait }, env);
          ctx.checkCancelled();
          // Retry before resetting, so a check sees the same build output as its first attempt.
          const retried = await retryBaselineFailures(
            run,
            wt.path,
            gates,
            ctx.signal,
            onWait,
            (retry, options) =>
              runGateExecution(
                ctx,
                "prepare",
                options?.targeted ? "baseline-retry-targeted" : "baseline-retry",
                wt.path,
                retry,
                { onWait, skipGateSlot: options?.skipGateSlot, fallbackSetup: gates.setup },
                env,
              ),
            ctx.deps.gateExecutor?.freshCheckoutFor?.(ctx.repo.slug),
          );
          ctx.checkCancelled();
          return { ...retried, sha: (await headSha(wt.path)) === baselineSha ? baselineSha : undefined };
        }),
      );
      ctx.state.baselineCached = false;
      const buildSha = ctx.deps.buildSha;
      if (!hasGates) ctx.state.baseline = null;
      // Without a known build the gate environment can't be keyed: never read or write the cache.
      else if (!buildSha) ctx.state.baseline = await runBaseline();
      else {
        const executor =
          cfg.gateExecutor === "lan" && cfg.workers.repos.includes(ctx.repo.slug) ? "lan" : "local";
        const bunVersion =
          executor === "lan"
            ? (ctx.deps.bunVersion ?? Bun.version)
            : await gateBunVersion(ctx.runDir, env, ctx.signal);
        ctx.checkCancelled();
        // Keyed by the commit actually checked out, so verify-change caches its PR base.
        const key = baselineCacheKey({
          executor,
          repoId: ctx.repo.id,
          baseSha: await headSha(wt.path),
          gates,
          lockfileHash: lockfileHash(wt.path),
          bunVersion,
          platform: process.platform,
          arch: process.arch,
          buildSha,
          envDigest: gateEnvDigest(env, cfg.baselineEnv),
        });
        // A bypass still runs the baseline and refreshes the entry if it passes.
        const bypass = ctx.run.noBaselineCache === true || !cfg.baselineCache;
        const baseline = async (): Promise<GateRun> => {
          const cached =
            bypass || ctx.state.gateExecution?.stage === "prepare"
              ? null
              : store.getBaselineCache<GateRun>(key, Date.now() - BASELINE_CACHE_TTL_MS);
          if (cached && cacheableBaseline(cached, gates)) {
            ctx.state.baselineCached = true;
            ctx.log(`Baseline reused from cache (${key.baseSha.slice(0, 12)})`);
            return redactGateData(cached);
          }
          const fresh = await runBaseline();
          // Only a passing baseline is cached; a failure (maybe flaky) must run again next time,
          // and it contradicts any cached pass for this key, so that entry goes.
          if (cacheableBaseline(fresh, gates)) store.putBaselineCache(key, redactGateData(fresh), ctx.run.id);
          else store.deleteBaselineCache(key);
          return fresh;
        };
        // One cacheable baseline per key at a time: a concurrent run on the same base waits, then
        // reuses it. A bypass can't reuse anything, so it never waits.
        ctx.state.baseline = bypass
          ? await baseline()
          : await singleFlight(JSON.stringify(key), ctx.signal, baseline, (r) => cacheableBaseline(r, gates));
      }
    } finally {
      if (ctx.state.gateExecution?.handle.kind !== "inplace") {
        if (verification) await resetTo(wt.path, verification.headSha);
        else await discardChanges(wt.path);
      }
    }
    const baseline = redactGateData(ctx.state.baseline);
    if (baseline) {
      ctx.artifact("baseline-gates.json", "gates", JSON.stringify(baseline, null, 2));
      for (const r of [...baseline.setup, ...baseline.checks]) {
        ctx.event({
          runId: ctx.run.id,
          type: "gate",
          level: r.ok ? "info" : "warn",
          message: `baseline ${r.name}: ${r.ok ? "pass" : "FAIL"} (${Math.round(r.durationMs / 1000)}s)`,
          data: r,
        });
      }
      for (const { firstAttempt, ...retry } of baseline.checks) {
        if (!firstAttempt) continue;
        ctx.event({
          runId: ctx.run.id,
          type: "gate",
          level: "warn",
          message: `baseline ${retry.name}: ${retry.ok ? "flaky" : "retry FAIL again"}${retry.targetedRetry ? ` (targeted: ${firstAttempt.failedFiles?.length ?? 0} files${retry.targetedRetry.ok || (retry.targetedRetry.timedOut && !confinementFailed(retry.targetedRetry)) ? ", then full retry" : ""})` : ""}`,
          data: { flaky: retry.ok, firstAttempt, retry },
        });
      }
    }
    if (review?.kind === "conflict") {
      ctx.run = store.updateRun(ctx.run.id, { resolvedProfile: "quick" });
      const tip =
        ctx.state.reviewBaseSha ??
        (await fetchBase(cfg.paths, ctx.repo, review.owner.baseBranch ?? ctx.repo.defaultBranch, ctx.signal));
      ctx.state.reviewBaseSha = tip;
      await ctx.save("review-base-chosen");
      if (await isAncestor(wt.path, tip, review.reviewedSha)) await ctx.setPhase("done");
      else {
        const result = await mergeForDelivery(ctx, wt.path, tip, review.reviewedSha);
        if (result === "done") {
          ctx.state.conflictRound = ctx.state.round;
          ctx.state.pendingRebaseSha = tip;
          ctx.state.preRebaseHead = review.reviewedSha;
          ctx.state.implementedRound = ctx.state.round;
        }
        await ctx.setPhase("loop");
      }
    } else await ctx.setPhase("triage");
    const failing = baseline ? baseline.checks.filter((c) => !c.ok).map((c) => c.name) : [];
    return {
      summary: `worktree ${wt.branch}; ${gates.checks.length} checks${failing.length ? `, failing on base: ${failing.join(", ")}` : ""}${ctx.state.baselineCached ? "; baseline reused from cache" : ""}`,
      value: undefined,
    };
  });
}

function commitMessage(ctx: RunContext, round?: number): string {
  if (repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet)
    return round === undefined || (round === 0 && !reviewRound(ctx))
      ? ctx.run.title
      : `${ctx.run.title} (round ${round + 1})`;
  return `limitless: ${ctx.run.title}${round === undefined ? "" : ` (round ${round + 1})`}\n\nRun: ${ctx.run.id}`;
}

function commitIdentity(ctx: RunContext) {
  return repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet ? "operator" : "factory";
}

function draftTitle(ctx: RunContext) {
  return repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet
    ? ctx.run.title
    : `[needs human] ${ctx.run.title}`;
}

function mergeMessage(ctx: RunContext, base: string): string {
  return `${repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet ? "Merge" : "limitless: merge"} base ${base}`;
}

/**
 * Merges the original run's base into the PR branch when the PR doesn't contain it, with the
 * factory's merge helpers; returns the merge commit, or null when unnecessary or deferred.
 * The base is saved before merging, so a resume completes or accepts exactly that merge.
 */
async function mergeReviewBase(
  ctx: RunContext,
  cwd: string,
  review: { owner: Run; reviewedSha: string },
): Promise<string | null> {
  if (ctx.state.reviewResolution) return null;
  const head = review.reviewedSha;
  const at = await headSha(cwd);
  let tip = ctx.state.reviewBaseSha;
  const base = review.owner.baseBranch ?? ctx.repo.defaultBranch;
  if (!tip) {
    if (at !== head) throw new Error("The round's worktree does not start from the reviewed PR head");
    tip = await fetchBase(ctx.deps.cfg.paths, ctx.repo, base, ctx.signal);
    if (await isAncestor(cwd, tip, head)) return null;
    ctx.state.reviewBaseSha = tip;
    await ctx.save("review-base-chosen");
  }
  if (at === head) {
    const conflicts = await prepareMerge(cwd, head, tip);
    if (conflicts.length) {
      await mergeGit(cwd, ["merge", "--abort"]);
      ctx.state.conflictFiles = conflicts;
      ctx.state.reviewResolution = {};
      ctx.state.needsHumanReason = REVIEW_RESOLUTION_BLOCK;
      await ctx.save();
      return null;
    }
    await completeMerge(cwd, head, tip, mergeMessage(ctx, tip), commitIdentity(ctx));
    ctx.log(`Merged ${base} (${tip.slice(0, 8)}) into the PR branch before the round`);
  }
  return validateMerge(cwd, head, tip);
}

// ---------------------------------------------------------------------------
// triage

function topLevel(path: string): string {
  try {
    return formatTopLevel(readdirSync(path));
  } catch {
    return "(unavailable)";
  }
}

async function triage(ctx: RunContext): Promise<void> {
  await ctx.stage("triage", async (stage) => {
    const input = {
      repoSlug: ctx.repo.slug,
      prompt: ctx.run.prompt,
      tree: topLevel(ctx.state.worktreePath as string),
    };
    const { result, target } = await ctx.invoke({
      role: "triage",
      stage,
      mode: "readonly",
      complexity: "small",
      prompt: triagePrompt(input),
      decisionTask: triageDecisions(input, ctx.deps.cfg.triageDecisionConfidence),
      jsonSchema: toStrictJsonSchema(TriageSchema),
      schema: TriageSchema,
      requireStructured: true,
      noTools: true,
    });
    await discardChanges(ctx.state.worktreePath as string);
    const t = TriageSchema.parse(result.structured);
    ctx.state.triage = t;
    const profile: ResolvedProfile = ctx.run.profile === "auto" ? t.suggested_profile : ctx.run.profile;
    ctx.run = ctx.store.updateRun(ctx.run.id, {
      title:
        ctx.run.titleProvenance === "defaulted" ||
        (ctx.run.titleProvenance == null && ctx.run.title === ctx.run.prompt.split("\n")[0]?.slice(0, 80))
          ? t.title
          : ctx.run.title,
      taskClass: t.task_class,
      complexity: t.complexity,
      resolvedProfile: profile,
    });
    ctx.artifact("triage.json", "triage", JSON.stringify({ ...t, model: target.modelId }, null, 2));
    const verifying = ctx.state.flow === "verify-change";
    const questions = !verifying && profile !== "quick" && t.ambiguity === "high" ? t.blocking_questions : [];
    if (questions.length) {
      for (const q of questions) ctx.store.askQuestion(ctx.run.id, q);
      await ctx.setPhase("clarify");
    } else {
      await ctx.setPhase(verifying || profile === "quick" ? "loop" : "spec");
    }
    return {
      summary: `${t.task_class}, ${t.complexity}, risk ${t.risk} → ${profile} (${target.modelId})`,
      value: undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// clarify: wait for the human to answer open questions

async function waitForAnswers(ctx: RunContext): Promise<void> {
  const pending = () => ctx.store.listQuestions(ctx.run.id).filter((q) => q.answer === null);
  if (!pending().length) return;
  ctx.run = ctx.store.updateRun(ctx.run.id, { status: "waiting_input" });
  ctx.log(`Waiting for answers to ${pending().length} question(s)`, "warn");
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (ctx.signal.aborted) {
        cleanup();
        reject(new CancelledError());
      } else if (ctx.isDraining()) {
        cleanup();
        reject(new ParkedError());
      } else if (!pending().length) {
        cleanup();
        resolve();
      }
    };
    const unsubscribe = ctx.store.subscribe((msg) => {
      if (msg.kind === "question" && msg.question.runId === ctx.run.id) check();
    });
    const onAbort = () => check();
    ctx.signal.addEventListener("abort", onAbort);
    ctx.drainEvents?.addEventListener("drain", onAbort);
    const cleanup = () => {
      unsubscribe();
      ctx.signal.removeEventListener("abort", onAbort);
      ctx.drainEvents?.removeEventListener("drain", onAbort);
    };
    check();
  });
  ctx.run = ctx.store.updateRun(ctx.run.id, { status: "running" });
}

async function clarify(ctx: RunContext): Promise<void> {
  await ctx.stage("clarify", async () => {
    await waitForAnswers(ctx);
    const qs = ctx.store.listQuestions(ctx.run.id);
    ctx.state.answers = qs.map((q) => `Q: ${q.question}\n  A: ${q.answer}`);
    await ctx.setPhase(ctx.run.resolvedProfile === "quick" ? "loop" : "spec");
    return { summary: `${qs.length} question(s) answered`, value: undefined };
  });
}

// ---------------------------------------------------------------------------
// spec

async function spec(ctx: RunContext): Promise<void> {
  await ctx.stage("spec", async (stage) => {
    // A resumed spec may already have asked questions before it parked.
    if (ctx.store.listQuestions(ctx.run.id).length) {
      await waitForAnswers(ctx);
      ctx.state.answers = ctx.store
        .listQuestions(ctx.run.id)
        .map((q) => `Q: ${q.question}\n  A: ${q.answer}`);
    }
    const complexity = ctx.state.triage?.complexity ?? ctx.run.complexity ?? undefined;
    const [, maxCriteria] = specCriteriaRange(complexity);
    const invocation = {
      role: "spec" as const,
      stage,
      mode: "readonly" as const,
      complexity: ctx.complexity,
      prompt: specPrompt({ prompt: ctx.run.prompt, answers: ctx.state.answers, complexity }),
      jsonSchema: toStrictJsonSchema(SpecSchema),
      schema: SpecSchema,
      requireStructured: true,
      maxToolCalls: 60,
    };
    let { result, target } = await ctx.invoke(invocation);
    await discardChanges(ctx.state.worktreePath as string);
    let s = SpecSchema.parse(result.structured);
    let scopeRetried = false;
    let criteriaRetried = false;
    let sizeRetried = false;
    for (;;) {
      const offending = specScopeViolation(s, ctx.run.prompt);
      const flagged = outOfRunCriteria(s);
      if (offending && scopeRetried)
        throw new Error(`structured output failed validation: invalid spec scope: ${offending}`);
      const retryCriteria: boolean = flagged.length > 0 && !criteriaRetried;
      const oversized = s.acceptance_criteria.length > maxCriteria;
      const retrySize: boolean = oversized && !sizeRetried;
      if (!offending && !retryCriteria && !retrySize) {
        // Kept, not dropped: the match is a word list, and a wrongly dropped criterion weakens verify.
        if (flagged.length)
          ctx.log(
            `Kept acceptance criteria that may depend on something outside the run: ${flagged.map((a) => a.id).join(", ")}`,
            "warn",
          );
        if (oversized)
          ctx.log(
            `Kept oversized spec: ${s.acceptance_criteria.length} acceptance criteria exceed the ${complexity ?? "unknown"} limit of ${maxCriteria} after size retry`,
            "warn",
          );
        break;
      }
      const feedback = [
        offending
          ? `\n\nInvalid specification: this sentence restricts the task beyond the request: ${promptJson(offending)}\nThe read-only rule applies to your investigation only. Rewrite the spec to describe the requested change without this restriction.`
          : "",
        retryCriteria
          ? `\n\nInvalid acceptance criteria: ${flagged.map((a) => a.id).join(", ")} depend on something outside the run. Replace them with criteria verifiable in the run's checkout using repository commands and tests; move external concerns to assumptions or out_of_scope.`
          : "",
        retrySize
          ? `\n\nToo many acceptance criteria: ${s.acceptance_criteria.length}. For ${complexity ?? "unknown"} complexity, use at most ${maxCriteria} criteria. Consolidate the spec while preserving the requested behavior and concrete how_to_verify for every criterion.`
          : "",
      ].join("");
      ctx.log(feedback.trim(), "warn");
      scopeRetried ||= Boolean(offending);
      criteriaRetried ||= retryCriteria;
      sizeRetried ||= retrySize;
      ({ result, target } = await ctx.invoke({ ...invocation, prompt: invocation.prompt + feedback }));
      await discardChanges(ctx.state.worktreePath as string);
      s = SpecSchema.parse(result.structured);
    }
    ctx.artifact("spec.md", "spec", `# ${ctx.run.title}\n\n${renderSpec(s)}\n`);
    const unanswered = s.blocking_questions.filter(Boolean);
    if (unanswered.length && ctx.state.answers.length === 0) {
      for (const q of unanswered) ctx.store.askQuestion(ctx.run.id, q);
      ctx.state.spec = s;
      await ctx.save();
      await waitForAnswers(ctx);
      ctx.state.answers = ctx.store
        .listQuestions(ctx.run.id)
        .map((q) => `Q: ${q.question}\n  A: ${q.answer}`);
      s.assumptions.push(...ctx.state.answers);
    }
    ctx.state.spec = s;
    ctx.state.specAuthorVendor = target.vendor;
    await ctx.setPhase("loop");
    return {
      summary: `${s.acceptance_criteria.length} acceptance criteria (${target.modelId})`,
      value: undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// implement ⇄ gates/audit/review/verify

function profile(ctx: RunContext): ResolvedProfile {
  return ctx.run.resolvedProfile ?? "standard";
}

async function buildLoop(ctx: RunContext): Promise<void> {
  if (ctx.state.reviewResolution && !ctx.state.reviewResolution.sha) {
    const review = reviewRound(ctx);
    const tip = ctx.state.reviewBaseSha;
    if (!review || !tip) throw new Error("Missing review-base resolution revisions");
    await ctx.save("review-resolution-start");
    if (ctx.state.conflictRound === undefined)
      await mergeForDelivery(ctx, ctx.state.worktreePath as string, tip, review.reviewedSha);
    if (!(await oneRound(ctx, ctx.state.round, null)))
      throw new NeedsHumanError(`Conflict resolution rejected:\n${ctx.state.feedback ?? ""}`);
    await ctx.save("review-resolution-checked");
    const sha = await headSha(ctx.state.worktreePath as string);
    ctx.state.reviewResolution.sha = sha;
    ctx.state.conflictRound = undefined;
    ctx.state.pendingRebaseSha = undefined;
    ctx.state.preRebaseHead = undefined;
    ctx.state.preRebaseGates = undefined;
    ctx.state.feedback = null;
    ctx.state.round++;
    // Clear the legacy block with the findings round and its baseline in one database write.
    // The old engine must implement that round; resolution's cached checks belong to the prior one.
    ctx.state.needsHumanReason = undefined;
    ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: sha }, ctx.state);
    await ctx.save("review-resolution-complete");
  }
  if (ctx.state.verification && !ctx.state.verification.initialComplete) {
    // Initial verification does not consume an implementation round.
    const passed = await oneRound(ctx, -1, null);
    ctx.state.verification.initialComplete = true;
    if (passed) await ctx.setPhase("deliver");
    else await ctx.save();
    if (passed) return;
  }
  const maxRounds =
    ctx.state.conflictRound !== undefined
      ? ctx.state.conflictRound + 1
      : Math.max(1, ctx.deps.cfg.maxRounds) +
        ROUNDS_PER_IMPLEMENTER +
        (ctx.state.reviewResolution?.sha ? 2 : 0);
  const holdout =
    ctx.state.flow === "verify-change" || profile(ctx) === "quick" || ctx.state.holdoutStatus === "complete"
      ? null
      : authorHoldout(ctx).then(
          () => null,
          (error: unknown) => error as Error,
        );
  try {
    while (ctx.state.round < maxRounds) {
      ctx.checkCancelled();
      const round = ctx.state.round;
      const passed = await oneRound(ctx, round, holdout);
      if (passed) {
        await ctx.setPhase("deliver");
        return;
      }
      ctx.state.round++;
      ctx.state.roundsOnImplementer++;
      await ctx.save();
    }
    throw new NeedsHumanError(
      `Still failing after ${ctx.state.round} implementation rounds. Last feedback:\n${ctx.state.feedback ?? ""}`,
    );
  } finally {
    if (holdout) await holdout;
  }
}

/** Enough to read the entry points and config a scenario needs; holdouts don't explore at length. */
const HOLDOUT_TOOL_CALLS = 40;

/**
 * Run `fn` in a private export of the recorded base commit, removed after confirmed shutdown.
 * Holdout runs alongside implement, so it must never see the worktree the implementer is editing.
 */
async function withBaseSnapshot<T>(
  ctx: RunContext,
  fn: (dir: string) => Promise<T>,
  baseSha = ctx.run.baseSha,
): Promise<T> {
  const worktree = ctx.state.worktreePath;
  if (!worktree || !baseSha) throw new Error("A base snapshot needs the run worktree and a base commit");
  const snapshot = createSnapshotParent();
  try {
    const base = join(snapshot, "base");
    mkdirSync(base);
    await exportCommit(worktree, baseSha, base, ctx.signal);
    return await fn(base);
  } finally {
    assertProcessesStopped();
    rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * The reader is confined to the snapshot and its scratch (`confineReads`), which already excludes
 * home and temporary directories. Factory paths can live elsewhere (LIMITLESS_HOME), so deny them
 * too: the parallel implementer's worktree, every run's state, the bare caches its commits land in,
 * and the factory's config and secrets.
 */
function holdoutDenyRead(ctx: RunContext): string[] {
  const { home, work, runs, repos, configDir } = ctx.deps.cfg.paths;
  return [ctx.state.worktreePath, home, work, runs, repos, configDir].filter((p): p is string => !!p);
}

async function authorHoldout(ctx: RunContext): Promise<void> {
  await ctx.stage(
    "holdout",
    async (stage) => {
      ctx.state.holdoutStatus = "generating";
      await ctx.save();
      const { result, target } = await withBaseSnapshot(ctx, (base) =>
        ctx.invoke({
          role: "holdout",
          stage,
          mode: "readonly",
          complexity: ctx.complexity,
          constraints: { avoidVendor: ctx.state.specAuthorVendor },
          prompt: holdoutPrompt({ prompt: ctx.run.prompt, spec: ctx.state.spec as Spec }),
          jsonSchema: toStrictJsonSchema(HoldoutSchema),
          schema: HoldoutSchema,
          requireStructured: true,
          privateOutput: true,
          // Residual risk (docs/ARCHITECTURE.md): the parallel implementer isn't read-sandboxed, so
          // the scratch is readable while this runs; the prompt keeps scenario text out of files.
          cwd: base,
          confineReads: true,
          denyRead: holdoutDenyRead(ctx),
          maxToolCalls: HOLDOUT_TOOL_CALLS,
        }),
      );
      ctx.state.holdout = HoldoutSchema.parse(result.structured);
      ctx.state.holdoutModelId = target.modelId;
      ctx.state.holdoutSameVendor = target.vendor === ctx.state.specAuthorVendor;
      ctx.state.holdoutStatus = "complete";
      await ctx.save();
      return {
        summary: `authored ${ctx.state.holdout.scenarios.length} private scenarios (${target.modelId})`,
        value: undefined,
      };
    },
    0,
    true,
  );
}

function workerPublication(ctx: RunContext, cwd: string, round: number): AgentPublicationHooks {
  const branch = ctx.run.branch as string;
  const clean = async () =>
    (await worktreeGit(["git", "status", "--porcelain", "--untracked-files=all"], { cwd })).stdout === "";
  const remoteSha = () => remoteBranchSha(ctx.repo, cwd, branch, ctx.signal).catch(() => undefined);
  return {
    remoteSha,
    async started(id) {
      ctx.state.agentJob = { round, id };
      await ctx.save("agent-job-started");
    },
    async retired(id) {
      if (ctx.state.agentJob?.id !== id || ctx.state.agentJob.round !== round) return;
      delete ctx.state.agentJob;
      await ctx.save("agent-job-retired");
    },
    async resume(request) {
      try {
        return (
          (await headSha(cwd)) === request.parentSha &&
          (await clean()) &&
          request.expectedRemoteSha === (ctx.state.publishedSha ?? null) &&
          request.privateStringsDigest === privateStringsDigest(privateEntries(ctx, cwd))
        );
      } catch (error) {
        throw new NeedsHumanError(`Cannot reconcile worker job: ${redactCredentials(String(error))}`);
      }
    },
    async prepare() {
      const parentSha = await headSha(cwd);
      if (!(await clean())) return null;
      const remote = await remoteSha();
      if (remote === undefined) return null;
      if (remote !== (ctx.state.publishedSha ?? null)) {
        if (remote !== parentSha)
          throw new NeedsHumanError(
            `Run branch ${branch} is at ${remote}, expected ${ctx.state.publishedSha ?? "no branch"}; another push moved it or a worker commit was pushed without an accepted report`,
          );
        ctx.state.publishedSha = parentSha;
        await ctx.save();
      }
      const identity = async (variable: string) => {
        const result = await worktreeGit(["git", "var", variable], { cwd, allowFail: true });
        return result.exitCode === 0 ? /^(.+) <([^<>]+)> -?\d+ [+-]\d{4}\n?$/.exec(result.stdout) : null;
      };
      const author = await identity("GIT_AUTHOR_IDENT");
      const committer = await identity("GIT_COMMITTER_IDENT");
      if (!author?.[1] || !author[2] || !committer?.[1] || !committer[2]) return null;
      const cfg = ctx.deps.cfg;
      const request: AgentPublication = {
        parentSha,
        baseSha: ctx.run.baseSha as string,
        allow: ctx.run.allow,
        branch,
        commit: {
          message: `${commitMessage(ctx, round)}\n`,
          authorName: author[1],
          authorEmail: author[2],
          committerName: committer[1],
          committerEmail: committer[2],
        },
        repoUrl:
          ctx.repo.url && isAbsolute(ctx.repo.url) ? ctx.repo.url : `https://github.com/${ctx.repo.slug}.git`,
        expectedRemoteSha: ctx.state.publishedSha ?? null,
        discreet: repoSettings(cfg, ctx.repo.slug).discreet,
        uiUrl: cfg.uiUrl,
        privateStringsDigest: privateStringsDigest(privateEntries(ctx, cwd)),
      };
      const validation = z.object(publicationFields).safeParse(request);
      if (!validation.success) {
        ctx.log(`Worker publication field invalid: ${validation.error.issues[0]?.path.join(".")}`, "warn");
        return null;
      }
      return request;
    },
    async adopt(sha, request) {
      try {
        if (sha === request.parentSha) {
          if ((await headSha(cwd)) !== sha || !(await clean()))
            throw new Error("Coordinator HEAD or worktree changed during worker session");
          return;
        }
        if ((await headSha(cwd)) === sha) {
          await verifyWorkerCommit(ctx.deps.cfg.paths, ctx.repo, cwd, { ...request, sha }, ctx.signal);
          if ((await headSha(cwd)) !== sha || !(await clean()))
            throw new Error("Coordinator HEAD or worktree changed during worker adoption");
        } else {
          await adoptWorkerCommit(ctx.deps.cfg.paths, ctx.repo, cwd, { ...request, sha }, ctx.signal);
        }
      } catch (error) {
        throw new NeedsHumanError(
          `Cannot adopt worker commit ${sha} for round ${round}: ${redactCredentials((error as Error).message)}`,
        );
      }
      ctx.state.publishedSha = sha;
      ctx.state.workerCommitRound = round;
      await ctx.save("worker-commit-adopted");
    },
  };
}

async function implementStage(ctx: RunContext, round: number): Promise<void> {
  const cwd = ctx.state.worktreePath as string;
  const gates = assertDistinctGateNames(ctx.state.gatesConfig as GateConfig);
  const baseSha = ctx.run.baseSha as string;
  const merge = ctx.state.conflictRound === round;
  const previousHead = ctx.state.preRebaseHead;
  if (merge) {
    if (!previousHead || ctx.state.pendingRebaseSha !== baseSha)
      throw new Error("Missing expected merge state for resolution round");
    if ((await headSha(cwd)) !== previousHead) {
      const sha = await validateMerge(cwd, previousHead, baseSha);
      ctx.state.implementedRound = round;
      ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: sha }, ctx.state);
      return;
    }
    await requireMerge(cwd, previousHead, baseSha);
  }
  await ctx.stage(
    "implement",
    async (stage) => {
      ctx.state.completedChecks = undefined;
      if (ctx.state.implementationReadyRound !== round) {
        const current = ctx.state.implementer;
        const escalate = current && ctx.state.roundsOnImplementer >= ROUNDS_PER_IMPLEMENTER;
        let constraints: RouteConstraints = current
          ? {
              prefer:
                current.effort === undefined
                  ? (current.targetId ?? current.modelId)
                  : { modelId: current.modelId, effort: current.effort },
              preferPolicyRevision: current.policyRevision,
            }
          : {};
        if (escalate) {
          // Prefer a stronger model; otherwise any model not tried yet; otherwise keep going as-is.
          const options: RouteConstraints[] = [
            { minTier: Math.min(5, current.tier + 1), exclude: ctx.state.triedImplementers },
            { exclude: ctx.state.triedImplementers },
            {},
          ];
          constraints = ctx.run.models?.implement
            ? { exclude: ctx.state.triedImplementers }
            : (options.find(
                (c) =>
                  ctx.deps.router.route("implement", ctx.complexity, ctx.routingConstraints(c)).candidates
                    .length,
              ) ?? {});
          ctx.log(`Escalating implementer beyond ${current.modelId}`, "warn", { constraints });
          ctx.state.roundsOnImplementer = 0;
        }
        const { result, target } = await ctx.invoke({
          role: "implement",
          stage,
          mode: "edit",
          complexity: ctx.complexity,
          constraints,
          ...(!merge &&
          !reviewRound(ctx) &&
          !ctx.run.deliveryBranch &&
          !ctx.run.prUrl &&
          ctx.state.flow !== "verify-change" &&
          ctx.repo.kind === "github" &&
          ctx.run.branch &&
          ctx.run.baseSha
            ? { publication: workerPublication(ctx, cwd, round) }
            : {}),
          prompt: implementPrompt({
            prompt:
              merge && ctx.state.reviewResolution
                ? (reviewRound(ctx)?.owner.prompt ?? ctx.run.prompt)
                : ctx.run.prompt,
            spec: merge && ctx.state.reviewResolution ? null : (ctx.state.spec ?? null),
            gates,
            baseline: ctx.state.baseline ?? null,
            baseSha: ctx.state.verification?.baseSha ?? baseSha,
            externalChange: ctx.state.flow === "verify-change",
            round: !merge && ctx.state.reviewResolution?.sha ? round - 2 : round,
            feedback:
              [
                ctx.state.feedback,
                ...(ctx.state.lastAudit ?? [])
                  .filter(
                    (f) =>
                      f.severity === "warn" &&
                      ["root-hidden-addition", "large-text-addition"].includes(f.rule),
                  )
                  .map((f) => `Advisory [${f.rule}] ${f.file}: ${f.detail}`),
              ]
                .filter(Boolean)
                .join("\n\n") || null,
            hasHoldout: ctx.state.flow !== "verify-change" && profile(ctx) !== "quick",
            resolution: merge,
          }),
        });
        if (
          !ctx.state.triedImplementers.some(
            (ref) =>
              (typeof ref === "string" ? ref : formatTarget(ref.modelId, ref.effort)) ===
              (target.targetId ?? target.modelId),
          )
        )
          ctx.state.triedImplementers.push({ modelId: target.modelId, effort: target.effort ?? null });
        ctx.state.implementerReport = result.finalText;
        ctx.artifact(`implement-${round}.md`, "report", result.finalText || "(no report)");
        ctx.state.implementerIssue =
          result.status === "ok"
            ? null
            : `${result.status}${result.error ? `: ${result.error}` : ""}`.slice(0, 500);
        if (result.status !== "ok") ctx.log(`Implementer ended with ${result.status}`, "warn");
        ctx.state.implementationReadyRound = round;
        delete ctx.state.agentJob;
        await ctx.save("implementation-ready");
      }
      ctx.checkCancelled();
      const terminationError = processScope.getStore()?.terminationError;
      if (terminationError) {
        // An unkillable writer or failed inspection needs a human: retrying another
        // round alongside processes whose shutdown is unconfirmed is unsafe.
        ctx.state.feedback = redactGateOutput(
          `${ctx.state.implementerIssue ?? "Invocation ended"}\n${terminationError.message}`,
        );
        ctx.state.needsHumanReason = terminationError.message;
        await ctx.save();
        throw new NeedsHumanError(`Implement round ${round} failed: ${terminationError.message}`);
      }
      const sha =
        merge && previousHead
          ? await completeMerge(cwd, previousHead, baseSha, mergeMessage(ctx, baseSha), commitIdentity(ctx))
          : await commitAll(cwd, commitMessage(ctx, round));
      ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: sha ?? (await headSha(cwd)) });
      ctx.state.implementedRound = round;
      await ctx.save("implementation-committed");
      return {
        summary: `${ctx.state.implementer?.modelId}: ${ctx.state.implementerIssue ?? "ok"}; ${sha ?? (ctx.state.workerCommitRound === round ? ctx.run.headSha : "no changes")}`,
        value: undefined,
      };
    },
    round,
  );
}

/**
 * A verifier never runs on a model that raised its candidates. It prefers a vendor that neither
 * raised them nor implemented the change, then the implementer's, then a raising vendor (not the
 * implementer's first), and the implementer's own model last; that outranks free-first billing.
 */
export function verifierConstraints(
  avoidVendors: string[],
  avoidModels: string[],
  implementer?: { vendor: string; modelId: string },
): RouteConstraints {
  return {
    avoidVendor: avoidVendors,
    excludeModels: avoidModels,
    excludedBecause: "raised a candidate it would verify",
    ...(implementer ? { preferNotVendor: [implementer.vendor], preferNotModels: [implementer.modelId] } : {}),
    independenceFirst: true,
  };
}

/** Returns true when every gate passes. */
async function oneRound(
  ctx: RunContext,
  round: number,
  holdout: Promise<Error | null> | null,
): Promise<boolean> {
  const cwd = ctx.state.worktreePath as string;
  const gates = assertDistinctGateNames(ctx.state.gatesConfig as GateConfig);
  const baseSha = ctx.state.verification?.baseSha ?? (ctx.run.baseSha as string);
  const privateStrings = () => privateEntries(ctx, cwd);
  const changeDiff = () =>
    diffSince(cwd, baseSha, undefined, ctx.state.flow === "verify-change", privateStrings());
  const resolution = ctx.state.conflictRound === round;
  const reviewSettings = () => {
    const reviewMode =
      ctx.state.reviewMode ??
      (ctx.state.lastReview?.mode === "panel" ||
      ctx.state.reviewHistory?.some((entry) => entry.panelReview !== undefined || entry.scope !== undefined)
        ? "panel"
        : ctx.deps.cfg.reviewMode);
    const system =
      ctx.deps.reviewSystem ??
      configuredReviewSystem({ ...ctx.deps.cfg, reviewMode }, profile(ctx), ctx.state.reviewLenses);
    // A gate-failed round reviews nothing; replays retain the same panel number.
    const panelReview =
      system.mode === "panel" && !resolution
        ? Math.max(
            0,
            ...(ctx.state.reviewHistory ?? []).filter((e) => e.round < round).map((e) => e.panelReview ?? 0),
          ) + 1
        : undefined;
    if (panelReview && panelReview > PANEL_REVIEWS)
      throw new NeedsHumanError(
        `Panel review limit reached (R${PANEL_REVIEWS}); not implementing again. Last feedback:\n${ctx.state.feedback ?? ""}`,
      );
    const panelRules: PanelReview | undefined =
      resolution && system.mode === "panel" ? "resolution" : panelReview;
    return { system, panelReview, panelRules };
  };
  let { system, panelReview, panelRules } = reviewSettings();

  // --- implement (skipped when resuming a round whose implementation already landed)
  if (round >= 0 && ctx.state.implementedRound !== round) await implementStage(ctx, round);
  const ciRound = reviewRound(ctx);
  if (ciRound?.kind === "ci" && (await headSha(cwd)) === ciRound.reviewedSha) {
    ctx.state.needsHumanReason =
      redactCredentials(ctx.state.implementerReport ?? "")
        .trim()
        .slice(0, 2000) || "CI fix round made no change";
    await ctx.save("needs-human");
    throw new NeedsHumanError(ctx.state.needsHumanReason);
  }
  if (resolution) {
    if (!ctx.state.preRebaseHead || ctx.state.pendingRebaseSha !== baseSha)
      throw new Error("Missing expected merge state for resolution checks");
    await validateMerge(cwd, ctx.state.preRebaseHead, baseSha);
    const trees = await worktreeGit(["git", "rev-parse", "HEAD^{tree}", `${baseSha}^{tree}`], { cwd });
    const [headTree, baseTree] = trees.stdout.trim().split("\n");
    if (headTree === baseTree) {
      const owner = reviewRound(ctx)?.owner;
      const base = (owner ? owner.baseBranch : ctx.run.baseBranch) ?? ctx.repo.defaultBranch;
      ctx.state.terminalReason = `the resolution leaves no change against ${base}`;
      ctx.state.needsHumanReason = undefined;
      await ctx.save();
      throw new NeedsHumanError(ctx.state.terminalReason);
    }
  }

  // --- gates
  // Reused round results and resumed runs need fresh evidence of local setup.
  let localSetupReady = false;
  const checks = ctx.stage(
    "gates",
    (stage) =>
      gateSlotScope(
        gateCommandScope(ctx, "gates", "initial", cwd, async () => {
          const events = {
            ...gateEvents(ctx),
            onLocalSetup: () => {
              localSetupReady = true;
            },
          };
          const checkedSha = await headSha(cwd);
          ctx.state.gateEvidence = undefined;
          let reusable = true;
          const confirm = (run: GateRun) => {
            if (run.sha !== checkedSha || run.trackedClean !== true) {
              reusable = false;
              ctx.log(
                redactGateOutput(
                  `Gate evidence withheld: ${run.provenanceError ?? "execution provenance could not be confirmed for the checked commit"}`,
                ),
                "warn",
              );
            }
            return run;
          };
          let cmp: GateComparison[];
          let testScripts: Record<string, string> = {};
          let baseTimeout = false;
          try {
            const env = gateEnv();
            if ((await resumeGateExecution(ctx, "gates", "initial", cwd, env))?.kind !== "inplace")
              await checkoutCommitted(cwd, undefined, Boolean(ctx.state.implementerIssue));
            const docs = await docsOnlyGates(cwd, gates, baseSha, checkedSha);
            ctx.event({
              runId: ctx.run.id,
              type: "gate",
              level: "info",
              message: `Gate selection: ${JSON.stringify(redactGateData(docs.selection))}`,
              data: docs.selection,
            });
            testScripts = pickScripts(readPackageJson(cwd), gateScriptNames(gates));
            const reused = await reusableAgentGate(ctx, cwd, checkedSha);
            const activeGates = reused
              ? { ...docs.gates, checks: docs.gates.checks.filter((c) => c.name !== "test") }
              : docs.gates;
            const execute = (purpose: string) =>
              !reused || activeGates.setup.length || activeGates.checks.length
                ? runGateExecution(ctx, "gates", purpose, cwd, activeGates, events, env).then(confirm)
                : gateProvenance(cwd, ctx.signal, checkedSha).then((provenance) =>
                    confirm({ setupOk: true, setup: [], checks: [], ...provenance }),
                  );
            const insertReused = (run: GateRun): GateRun =>
              reused && run.setupOk
                ? {
                    ...run,
                    checks: gates.checks.flatMap((c) => {
                      const result =
                        c.name === "test" ? reused.result : findGateCounterpart(c, gates.checks, run.checks);
                      return result ? [result] : [];
                    }),
                  }
                : run;
            if (reused)
              ctx.event({
                runId: ctx.run.id,
                type: "gate",
                level: reused.result.ok ? "info" : "warn",
                message: `test: reused factory gate execution ${reused.result.reused.executionId} (tree ${reused.result.reused.treeHash.slice(0, 12)})`,
                data: reused.result,
              });
            let after = insertReused(await execute("initial"));
            ctx.checkCancelled();
            baseTimeout = after.checks.some(
              (r) =>
                r.timedOut &&
                findGateCounterpart(r, after.checks, ctx.state.baseline?.checks ?? [])?.timedOut,
            );
            const failed = after.checks.filter((r) => !r.ok);
            const timeoutOnly = after.setupOk && failed.length > 0 && failed.every((r) => r.timedOut);
            if (timeoutOnly && !baseTimeout) {
              const first = after;
              ctx.artifact(`gates-timeout-${round}.json`, "gates", JSON.stringify(redactGateData(first)));
              ctx.log(
                `Gate checks timed out; re-running gates (timeout re-runs: ${(ctx.state.gateTimeoutReruns ?? 0) + 1})`,
                "warn",
              );
              // The re-run starts from the committed tree too, not from what the first attempt left behind.
              localSetupReady = false;
              await checkoutCommitted(cwd, undefined, Boolean(ctx.state.implementerIssue));
              after = insertReused(await execute("timeout"));
              ctx.checkCancelled();
              after = {
                ...after,
                checks: after.checks.map((r) => {
                  const original = findGateCounterpart(r, after.checks, first.checks);
                  return {
                    ...(original?.timedOut && !r.reused ? validateRetry(r, original, checkedSha, after) : r),
                    firstAttempt: r.reused ? r.firstAttempt : original,
                  };
                }),
              };
            }
            const changed = (await changeDiff()).files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
            if (!reused) after = docs.annotate(after);
            // Retry before discarding, so a check sees the same build output as its first attempt.
            cmp = compareGates(ctx.state.baseline ?? null, after).map((c) => ({
              ...c,
              firstAttempt: c.result.firstAttempt?.ok ? undefined : c.result.firstAttempt,
            }));
            if (reused) {
              cmp = cmp.map((c) => (c.name === "test" ? reused : c));
              if (!cmp.some((c) => c.name === "test")) cmp.push(reused);
            }
            if (!baseTimeout)
              cmp = await retryRegressions(
                cmp,
                cwd,
                docs.gates,
                changed,
                ctx.signal,
                events.onWait,
                (retry, options) =>
                  runGateExecution(
                    ctx,
                    "gates",
                    options?.targeted ? "regression-retry-targeted" : "regression-retry",
                    cwd,
                    retry,
                    {
                      onWait: events.onWait,
                      skipGateSlot: options?.skipGateSlot,
                      fallbackSetup: docs.gates.setup,
                      onLocalSetup:
                        retry.setup.length === gates.setup.length ? events.onLocalSetup : undefined,
                    },
                  ).then(confirm),
                ctx.deps.gateExecutor?.freshCheckoutFor?.(ctx.repo.slug),
              );
            ctx.checkCancelled();
            baseTimeout ||= after.checks.some(
              (r) =>
                r.timedOut &&
                findGateCounterpart(r, after.checks, ctx.state.baseline?.checks ?? [])?.timedOut,
            );
          } finally {
            // Gates may have produced files (build output, formatter fixes); don't let them leak into the diff.
            if (ctx.state.gateExecution?.handle.kind !== "inplace")
              await discardChanges(cwd).catch((error: unknown) => {
                if (ctx.state.implementerIssue && error instanceof CommandError)
                  throw new WorktreeCleanError(error.message, { cause: error });
                throw error;
              });
          }
          for (const c of cmp.filter((c) => c.firstAttempt)) {
            ctx.event({
              runId: ctx.run.id,
              type: "gate",
              level: "warn",
              message: `${c.name} retry: ${c.result.timedOut ? "timed out again" : c.result.ok ? (c.firstAttempt?.timedOut ? "pass after timeout" : "pass (flaky, not blocking)") : "FAIL again"}${c.result.targetedRetry ? ` (targeted: ${c.firstAttempt?.failedFiles?.length ?? 0} files${c.result.targetedRetry.ok || (c.result.targetedRetry.timedOut && !confinementFailed(c.result.targetedRetry)) ? ", then full retry" : ""})` : ""}`,
              data: { flaky: c.verdict === "flaky", firstAttempt: c.firstAttempt, retry: c.result },
            });
          }
          ctx.state.lastGates = cmp;
          const paths = (await changeDiff()).files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
          const canonicalPaths = paths.flatMap((path) => {
            const canonical = canonicalTestFile(path, cwd);
            return canonical && canonical !== path ? [path, canonical] : [path];
          });
          const changedFiles =
            canonicalPaths.length <= 10_000 &&
            canonicalPaths.every((path) => path.length <= 2000 && redactGateOutput(path) === path)
              ? canonicalPaths
              : undefined;
          ctx.state.gateEvidence =
            reusable && (await headSha(cwd)) === checkedSha
              ? {
                  stageId: stage.id,
                  sha: checkedSha,
                  baseSha,
                  changedFiles,
                  checks: cmp.map((check) => ({
                    ...check,
                    testCommand: gateTestCommand(check.result.command, testScripts),
                  })),
                }
              : undefined;
          ctx.artifact(`gates-${round}.json`, "gates", JSON.stringify(redactGateData(cmp), null, 2));
          if (baseTimeout) {
            await ctx.save();
            throw new NeedsHumanError("gate timed out on the base revision too");
          }
          const blocking = cmp.filter((c) => c.blocking).map((c) => c.name);
          const flaky = cmp.filter((c) => c.verdict === "flaky").map((c) => c.name);
          return {
            summary: blocking.length
              ? `blocking: ${blocking.join(", ")}`
              : `${cmp.length} checks ok${flaky.length ? `, flaky: ${flaky.join(", ")}` : ""}`,
            value: cmp,
          };
        }),
      )(),
    round,
  );
  const comparison = await checks.catch(async (error: unknown) => {
    ctx.checkCancelled();
    if (!(error instanceof WorktreeCleanError) || !ctx.state.implementerIssue) throw error;
    ctx.state.feedback = redactPrivate(
      redactGateOutput(
        `### Your previous session ended early\n${ctx.state.implementerIssue}\n\nWorktree cleanup failed after retry:\n${error.message}`,
      ),
      privateStrings(),
    );
    ctx.log(ctx.state.feedback, "warn");
    await ctx.save();
    return null;
  });
  if (comparison === null) return false;

  // --- audit
  const diff = await changeDiff();
  const audit: AuditFinding[] = await ctx.stage(
    "audit",
    async () => {
      const findings = auditDiff(diff, {
        configDir: ctx.deps.cfg.paths.configDir,
        // Already-pushed author edits are advisory; repairs are audited independently below.
        allow: ctx.state.verification ? [...(ctx.run.allow ?? []), "workflows"] : (ctx.run.allow ?? []),
        taskClass: ctx.state.verification && ctx.run.taskClass === "question" ? null : ctx.run.taskClass,
        protectedPaths: gates.protectedPaths,
        toolCommands: ctx.state.toolCommands,
        gateScripts: {
          before: ctx.state.verification
            ? pickScripts(
                await readFileAt(
                  cwd,
                  await mergeBase(cwd, ctx.state.verification.baseSha, ctx.state.verification.headSha),
                  "package.json",
                ),
                gateScriptNames(gates),
              )
            : (ctx.state.baselineScripts ?? {}),
          after: pickScripts(readPackageJson(cwd), gateScriptNames(gates)),
        },
      });
      if (ctx.state.verification) {
        const repairs = await diffSince(
          cwd,
          ctx.state.verification.headSha,
          undefined,
          false,
          privateStrings(),
        );
        if (repairs.files.length)
          findings.push(
            ...auditDiff(repairs, {
              configDir: ctx.deps.cfg.paths.configDir,
              allow: ctx.run.allow ?? [],
              taskClass: ctx.run.taskClass,
              protectedPaths: gates.protectedPaths,
              gateScripts: {
                before: pickScripts(
                  await readFileAt(cwd, ctx.state.verification.headSha, "package.json"),
                  gateScriptNames(gates),
                ),
                after: pickScripts(readPackageJson(cwd), gateScriptNames(gates)),
              },
            }).map((finding) => ({ ...finding, detail: `Repair: ${finding.detail}` })),
          );
      }
      ctx.state.lastAudit = findings;
      for (const f of findings) {
        ctx.event({
          runId: ctx.run.id,
          type: "audit",
          level: f.severity === "block" ? "error" : "warn",
          message: `[${f.rule}] ${f.file ? `${f.file}: ` : ""}${f.detail}`,
          data: f,
        });
      }
      ctx.artifact("diff.patch", "diff", diff.patch);
      const blocks = findings.filter((f) => f.severity === "block").length;
      return {
        summary: `+${diff.added}/-${diff.removed} in ${diff.files.length} files; ${blocks} blocking, ${findings.length - blocks} warnings`,
        value: findings,
      };
    },
    round,
  );

  const gateFeedback = formatGateFeedback(comparison, gates);
  const auditFeedback = formatAuditFeedback(audit);
  if (gateFeedback || auditFeedback) {
    // Don't spend reviewer tokens on work that fails deterministic checks.
    const issue = ctx.state.implementerIssue
      ? `### Your previous session ended early\n${ctx.state.implementerIssue}\nKeep the next attempt focused and finish by running the checks.`
      : "";
    ctx.state.feedback = [issue, gateFeedback, auditFeedback].filter(Boolean).join("\n\n");
    ctx.state.feedback = redactPrivate(redactGateOutput(ctx.state.feedback), privateStrings());
    await ctx.save();
    ctx.log(
      comparison.some((c) => c.blocking && c.result.timedOut)
        ? "Gate checks timed out; sending timeout feedback to implementer"
        : "Deterministic checks failed; sending feedback to implementer",
      "warn",
    );
    return false;
  }

  const concurrent = profile(ctx) !== "quick" && ctx.state.flow !== "verify-change" && !resolution;
  // Cached/resumed or remote gates are not evidence of an install in the reader's worktree.
  // A matching preview already prepares this checkout before the concurrent readers start.
  const previewWillSetup =
    concurrent && ctx.state.previewConfig && needsPreview(ctx.state.previewConfig, diff);
  let readerSetup: Promise<void> | undefined;
  const prepareLocal = () =>
    (readerSetup ??= (async () => {
      if (localSetupReady) return;
      try {
        await prepareReaderCheckout(cwd, gates.setup, ctx.signal);
        localSetupReady = true;
      } catch (error) {
        ctx.checkCancelled();
        throw new ReaderSetupError(redactGateOutput((error as Error).message));
      }
    })());
  // --- review
  if (ctx.state.lastReview && !ctx.state.reviewHistory?.length)
    throw new NeedsHumanError("Previous review has no round history; cannot classify later findings");
  const earlierReviews = (ctx.state.reviewHistory ?? []).filter((entry) => entry.round < round);
  const findingsReviews = earlierReviews.filter((entry) => entry.sha !== ctx.state.reviewResolution?.sha);
  const priorReview = findingsReviews.at(-1);
  const reviewedSha = await headSha(cwd);
  // R2 and R3 review only the fixes since the previous review. A conflict-resolution review, like a
  // single one, sees the change against the new base, so upstream-only files never appear.
  const previousReview = priorReview
    ? {
        sha: priorReview.sha,
        findings: priorReview.blocking,
      }
    : undefined;
  const reviewText = (text: string) => redactPrivate(redactGateOutput(text), privateStrings());
  const firstParentRange = `${ctx.state.preRebaseHead}..${reviewedSha}`;
  const firstParentFiles = resolution ? ctx.state.conflictFiles : undefined;
  const firstParentDiff = firstParentFiles?.length
    ? await Promise.all(
        [[], ["--stat"]].map((options) =>
          worktreeGit(
            [
              "git",
              "--literal-pathspecs",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...options,
              firstParentRange,
              "--",
              ...firstParentFiles,
            ],
            { cwd },
          ).then(({ stdout }) => reviewText(stdout)),
        ),
      )
    : undefined;
  const reviewStage = (ctx.stage<Review>).bind(
    ctx,
    "review",
    async (stage) => {
      ({ system, panelReview, panelRules } = reviewSettings());
      if (ctx.state.reviewMode === undefined) {
        ctx.state.reviewMode = system.mode;
        await ctx.save();
      }
      const fixSha = panelReview && panelReview > 1 ? priorReview?.sha : undefined;
      const reviewDiff = fixSha ? await diffSince(cwd, fixSha) : diff;
      const scope: ReviewScope | undefined =
        system.mode !== "panel"
          ? undefined
          : fixSha
            ? { kind: "fix", range: `${fixSha}..${reviewedSha}` }
            : {
                kind: resolution ? "resolution" : "full",
                range: `${baseSha}${ctx.state.flow === "verify-change" ? "..." : ".."}${reviewedSha}`,
              };
      const sameVendorAllowed =
        system.mode === "single" &&
        ctx.state.flow !== "verify-change" &&
        ctx.deps.cfg.reviewAvoidImplementerVendor === false;
      ctx.log(
        system.mode === "panel"
          ? "review: panel finder family rules"
          : sameVendorAllowed
            ? "review: same-vendor allowed by config"
            : "review: avoiding implementer's vendor",
      );
      // A replay on the same commit (e.g. after a restart) keeps follow-ups it may not repeat.
      const replayed = (ctx.state.reviewHistory ?? []).find(
        (e) => e.round === round && e.sha === reviewedSha,
      );
      const input: ReviewInput = {
        timeoutMs: readingTimeout(reviewDiff.added + reviewDiff.removed),
        replayedFollowUps: replayed?.followUps,
        system,
        ...(panelRules ? { panelReview: panelRules } : {}),
        ...(ctx.state.implementer ? { implementerModel: ctx.state.implementer.modelId } : {}),
        prompt: {
          prompt:
            resolution && ctx.state.reviewResolution
              ? (reviewRound(ctx)?.owner.prompt ?? ctx.run.prompt)
              : ctx.run.prompt,
          spec: resolution && ctx.state.reviewResolution ? null : (ctx.state.spec ?? null),
          baseSha,
          stat: reviewDiff.stat,
          ...(ctx.state.flow === "verify-change" ? { patch: reviewDiff.patch } : {}),
          gates: comparison,
          audit,
          implementerReport: ctx.state.implementerReport ?? "",
          implementerReportMode: system.implementerReport,
          externalChange: ctx.state.flow === "verify-change",
          dependencyUpdate:
            ctx.run.taskClass === "dependency_update" || ctx.run.requestedBy === "dependabot[bot]",
          previous: previousReview && {
            ...previousReview,
            ...(fixSha ? { resolved: resolvedPriorFindings(findingsReviews) } : {}),
          },
          headSha: reviewedSha,
          resolution,
          firstParentPatch: firstParentDiff?.[0],
          firstParentStat: firstParentDiff?.[1],
          firstParentRange,
          firstParentFiles: firstParentFiles?.map(reviewText),
          ...(fixSha && panelReview ? { fixReview: panelReview } : {}),
        },
      };
      // The concurrent pair owns cleanup of the production worktree; shadows own their checkout.
      const call = async (
        request: ReviewRequest | VerifierRequest,
        constraints: RouteConstraints,
        prefer: string | undefined,
        deadline?: number,
      ) => {
        const invoked = await ctx.invoke({
          role: "review",
          stage,
          mode: "readonly",
          readerSetup: gates.setup,
          prepareLocal: invokeGuard.getStore() ? undefined : prepareLocal,
          complexity: profile(ctx) === "deep" ? "large" : ctx.complexity,
          constraints: { ...constraints, ...(prefer ? { prefer } : {}) },
          ...request,
          ...(deadline ? { deadline } : {}),
          shadow: invokeGuard.getStore(),
          checkout:
            ctx.repo.kind === "github" && ctx.run.branch && constraints.billing !== "free_only"
              ? { parentSha: reviewedSha, baseSha, branch: ctx.run.branch }
              : undefined,
          requireStructured: true,
        });
        if (!ctx.parallelChecks || invokeGuard.getStore())
          await discardChanges(invokeGuard.getStore()?.cwd ?? cwd);
        return invoked;
      };
      const reviewDeps: ShadowDeps = (system) => {
        const shadow = invokeGuard.getStore();
        return {
          skipAny: !!shadow,
          invoke: async (request, index) => {
            const finder = system.finders[index];
            const vendor = ctx.state.implementer?.vendor;
            const constraints: RouteConstraints = {
              ...(finder?.family === "implementer"
                ? { preferVendor: vendor }
                : !shadow && sameVendorAllowed && system.mode === "single"
                  ? {}
                  : { avoidVendor: vendor }),
              ...(finder?.local ? { billing: "free_only" as const } : {}),
            };
            // One deadline covers a local finder's slot waits and fallbacks; past it, the panel skips it.
            const deadline = finder?.local ? Date.now() + request.timeoutMs : undefined;
            try {
              return await call(request, constraints, finder?.target, deadline);
            } catch (error) {
              if ((shadow || (finder?.local && !ctx.run.models?.review)) && error instanceof NoCapacityError)
                throw new FinderSkipped(error.message);
              throw error;
            }
          },
          verify: (request, avoidVendors, avoidModels) => {
            const constraints = verifierConstraints(avoidVendors, avoidModels, ctx.state.implementer);
            // A preempted shadow verifier leaves its batch unverified; the panel goes on.
            const skip = (error: unknown): never => {
              throw error instanceof Preempted ? new FinderSkipped(error.message) : error;
            };
            if (!system.verifier?.targets || (ctx.run.models?.review && !shadow))
              return call(request, constraints, system.verifier?.target).catch(skip);
            // Picked per batch, as evals do, and offered alone: a routed fallback could share its vendor.
            const exclusions: string[] = [];
            const listed = system.verifier.targets.flatMap((target) => {
              const { model, targetId } = ctx.deps.router.resolve(target);
              const reason = originExclusion(model, ctx.deps.router.excludeOrigins);
              if (reason) {
                exclusions.push(`${targetId}: ${reason}`);
                return [];
              }
              return [{ vendor: model.vendor, modelId: model.id, targetId }];
            });
            if (!listed.length && exclusions.length) throw new NoCapacityError(exclusions.join("; "));
            const identity = ctx.deps.router.checkpointIdentity;
            const only = pickVerifier(listed, avoidVendors, avoidModels, identity).targetId;
            return call(request, { ...constraints, only }, undefined).catch(skip);
          },
          warn: (message) => ctx.log(message, "warn"),
        };
      };
      const reviewed = runReview(reviewDeps(system), input);
      const shadowDone =
        ctx.deps.cfg.reviewShadow === "panel" && system.mode === "single"
          ? shadowReview(
              ctx,
              { round, baseSha, reviewedSha, profile: profile(ctx), input },
              reviewDeps,
              reviewed,
            ).catch((error) => ctx.log(`Shadow panel: ${error}`, "warn"))
          : undefined;
      // A failed production review still waits for the shadow (its grace is 0 then) before the stage fails.
      const { target, output, decision, panel } = await reviewed.catch(async (error: unknown) => {
        await shadowDone;
        throw error;
      });
      if (!decision) {
        await shadowDone;
        throw output.error;
      }
      // The model's verdict is kept for inspection only; control flow uses the derived one.
      const { review: r, modelVerdict, blocking, followUps } = decision;
      ctx.state.reviewHistory = [
        ...earlierReviews,
        {
          round,
          sha: reviewedSha,
          blocking,
          followUps,
          ...(panelReview ? { panelReview } : {}),
          ...(scope ? { scope } : {}),
        },
      ];
      ctx.state.reviewFollowUps = [
        ...new Map(
          ctx.state.reviewHistory.flatMap((entry) =>
            entry.followUps.map((f) => [reviewFindingKey(f), f] as const),
          ),
        ).values(),
      ];
      const sameVendor = target.vendor === ctx.state.implementer?.vendor;
      if (sameVendor && !sameVendorAllowed)
        ctx.log("Review done by the implementer's vendor (no other vendor available)", "warn");
      ctx.state.lastReview = { ...r, modelId: target.modelId };
      ctx.state.reviewedSha = reviewedSha;
      await ctx.save();
      // Panel artifacts are numbered by review (R1-R3), single ones by implementation round.
      ctx.artifact(
        scope?.kind === "resolution" ? "review-resolution.json" : `review-${panelReview ?? round}.json`,
        "review",
        JSON.stringify(
          {
            ...r,
            modelVerdict,
            model: target.modelId,
            round,
            ...(panelReview ? { panelReview } : {}),
            ...(scope ? { scope } : {}),
            reviewedSha,
            blocking,
            ...(panel ? { panel } : {}),
          },
          null,
          2,
        ),
      );
      await shadowDone;
      const serious = blocking.length;
      return {
        summary: `${r.verdict} by ${target.modelId}: ${serious} blocking, ${r.findings.length - serious} nonblocking`,
        value: r,
      };
    },
    round,
  );

  const rejectReview = async (review: Review, verifyFeedback = ""): Promise<boolean> => {
    const reviewFeedback =
      review.verdict === "request_changes"
        ? formatReviewFeedback(
            blockingReviewFindings(review, previousReview?.findings, panelRules, system.causalAttribution),
            review.mode === "panel",
          )
        : "";
    if (review.verdict === "request_changes") {
      ctx.state.feedback = redactGateOutput(
        [reviewFeedback || `### Code review requested changes\n${review.summary}`, verifyFeedback]
          .filter(Boolean)
          .join("\n\n"),
      );
      await ctx.save();
      // Never a fourth panel review: what still blocks goes to a human with a draft PR.
      if (panelReview && panelReview >= PANEL_REVIEWS)
        throw new NeedsHumanError(
          `Still blocking after panel review R${panelReview}:\n${ctx.state.feedback}`,
        );
      return false;
    }

    return true;
  };
  if (!concurrent && !(await rejectReview(await reviewStage()))) return false;

  // --- verify acceptance criteria (standard/deep)
  if (
    (resolution && ctx.state.reviewResolution) ||
    ctx.state.flow === "verify-change" ||
    profile(ctx) === "quick"
  ) {
    ctx.state.lastVerify = null;
    if (ctx.state.flow !== "verify-change") await recordVerified(ctx, reviewedSha);
    return true;
  }
  if (holdout) {
    const failure = await holdout;
    if (failure) throw failure;
  }
  if (!ctx.state.holdout) throw new NeedsHumanError("Holdout scenarios are unavailable");
  const previewConfig = ctx.state.previewConfig ?? null;
  let preview: Preview | null = null;
  const stopPreview = async () => {
    await preview?.stop();
  };
  try {
    const verifiedSha = await headSha(cwd);
    const checkVerifiedHead = async () => {
      if ((await headSha(cwd)) !== verifiedSha)
        throw new NeedsHumanError(
          "Commit changed during verification; gate evidence cannot cover the new HEAD",
        );
    };
    const gateEvidence = ctx.state.gateEvidence;
    const usableGates = () => {
      const stage = gateEvidence ? ctx.store.getStage(gateEvidence.stageId) : null;
      return stage?.runId === ctx.run.id && stage.name === "gates" && stage.status === "succeeded"
        ? gateEvidence
        : undefined;
    };
    const resolveVerify = (value: Verify) =>
      normalizeVerify(
        applyGateEvidence(
          value,
          ctx.state.spec as Spec,
          ctx.state.holdout as Holdout,
          verifiedSha,
          usableGates(),
          ctx.state.baseline,
        ),
        ctx.state.spec as Spec,
        ctx.state.holdout as Holdout,
        ctx.run.prompt,
      );
    const preparePreview = async () => {
      if (!preview && previewConfig && needsPreview(previewConfig, diff)) {
        preview = await ctx.stage(
          "preview",
          async () => {
            if (!localSetupReady && gates.setup.length) {
              const setup = await runLocalGates(
                cwd,
                { ...gates, checks: [] },
                ctx.signal,
                gateEvents(ctx, "preview setup"),
              );
              ctx.checkCancelled();
              if (!setup.setupOk) {
                const failed = setup.setup.find((result) => !result.ok);
                throw new ReaderSetupError(
                  redactGateOutput(
                    `Preview setup failed: $ ${failed?.command ?? "setup"}\n${failed?.failures ?? ""}\n${failed?.output ?? "No setup result"}`,
                  ),
                );
              }
              localSetupReady = true;
            }
            const server = await startPreview(cwd, previewConfig, ctx.signal);
            preview = server; // Retain ownership if the stage completion checkpoint is interrupted.
            ctx.log(`Preview ready at ${server.url}`);
            return { summary: `ready at ${server.url}`, value: server };
          },
          round,
        );
        ctx.previewUrl = preview.url;
      }
    };
    const prepareVerification = async () => {
      try {
        if (!previewWillSetup) await prepareLocal();
        await preparePreview();
      } catch (error) {
        // Preparation precedes both concurrent readers, but belongs to local verification.
        if (error instanceof ReaderSetupError)
          return ctx.stage(
            "verify",
            async () => {
              throw error;
            },
            round,
          );
        throw error;
      }
    };
    const verifyAttempt = async (attempt: number, excludeModels: string[] = []): Promise<Verify> => {
      await prepareVerification();
      return ctx.stage(
        "verify",
        async (stage) => {
          const { result, target } = await ctx.invoke({
            role: "verify",
            allowLocalBinding: true,
            stage,
            mode: "readonly",
            complexity: ctx.complexity,
            constraints: { avoidVendor: ctx.state.implementer?.vendor, excludeModels },
            timeoutMs: readingTimeout(diff.added + diff.removed, 25),
            prompt: (allowLocalBinding) =>
              verifyPrompt({
                allowLocalBinding,
                prompt: ctx.run.prompt,
                spec: ctx.state.spec as Spec,
                holdout: ctx.state.holdout as Holdout,
                baseSha,
                checks: usableGates()?.sha === verifiedSha ? gateEvidence?.checks : undefined,
              }),
            jsonSchema: toStrictJsonSchema(VerifySchema),
            schema: VerifySchema,
            requireStructured: true,
            privateSession: true,
            redactHoldout: true,
          });
          if (!ctx.parallelChecks) await discardChanges(cwd);
          await checkVerifiedHead();
          const modelOutput = VerifySchema.parse(result.structured);
          const v = resolveVerify(modelOutput);
          ctx.state.lastVerify = { ...v, modelId: target.modelId };
          ctx.state.verifyResults = [
            ...(ctx.state.verifyResults ?? []),
            { ...v, modelId: target.modelId, round, attempt, sha: verifiedSha, modelOutput },
          ];
          await ctx.save();
          const publicSources = await ctx.publicHoldoutSources();
          ctx.artifact(
            attempt === 0 ? `verify-${round}.json` : `verify-${round}-retry.json`,
            "verify",
            preDeliveryVerifyArtifact(
              { ...v, modelId: target.modelId, round, attempt, sha: verifiedSha },
              ctx.state.spec as Spec,
              ctx.state.holdout as Holdout,
              publicSources,
            ),
          );
          const met = v.criteria.filter((c) => c.status === "met").length;
          const blocked = v.criteria.filter((c) => c.status === "blocked").length;
          return {
            summary: `${v.overall}: ${met}/${v.criteria.length} criteria met${blocked ? `, ${blocked} blocked` : ""} (${target.modelId})`,
            value: v,
          };
        },
        round,
      );
    };
    const previous = (ctx.state.verifyResults ?? []).filter(
      (v) => v.round === round && (!v.sha || v.sha === verifiedSha),
    );
    const recorded = concurrent ? undefined : previous.at(-1);
    const original = recorded?.modelOutput ?? recorded;
    let verify: Verify;
    if (concurrent) {
      await prepareVerification();
      ctx.parallelChecks = true;
      let results: [PromiseSettledResult<Review>, PromiseSettledResult<Verify>];
      try {
        try {
          results = await Promise.allSettled([reviewStage(), verifyAttempt(0)]);
        } finally {
          ctx.parallelChecks = false;
          await discardChanges(cwd);
        }
        // Fixed error precedence, independent of completion order. Both stages have settled.
        if (results[0].status === "rejected") throw results[0].reason;
        ctx.checkCancelled();
        if (results[1].status === "rejected") {
          const error: unknown = results[1].reason;
          if (
            results[0].value.verdict !== "request_changes" ||
            error instanceof CancelledError ||
            error instanceof SimulatedTermination ||
            (error instanceof Error && error.message.startsWith("Commit changed during verification"))
          )
            throw error;
        }
      } catch (error) {
        // A reader or cleanup error must not hide a commit moved by its sibling.
        if (
          !(error instanceof CancelledError || error instanceof SimulatedTermination) &&
          !(
            error instanceof NeedsHumanError && error.message.startsWith("Commit changed during verification")
          )
        )
          await checkVerifiedHead();
        throw error;
      }
      await checkVerifiedHead();
      if (results[1].status === "rejected") {
        ctx.log(
          redactHoldoutText(
            redactCredentials(
              `Verification failure ignored after review requested changes: ${results[1].reason}`,
            ),
            ctx.state.holdout,
            await ctx.publicHoldoutSources(),
          ),
          "warn",
        );
        await rejectReview(results[0].value);
        return false;
      }
      verify = results[1].value;
      const feedback = formatVerifyFeedback(
        verify,
        ctx.state.spec ?? null,
        ctx.state.holdout,
        await ctx.publicHoldoutSources(),
        ctx.run.prompt,
      ).replace("### Checks not met", "### Acceptance criteria not yet met (verify)");
      if (!(await rejectReview(results[0].value, feedback))) return false;
    } else {
      verify = original ? resolveVerify(VerifySchema.parse(original)) : await verifyAttempt(0);
    }
    if (recorded) {
      Object.assign(recorded, verify);
      ctx.state.lastVerify = { ...verify, modelId: recorded.modelId };
      await ctx.save();
      ctx.artifact(
        recorded.attempt === 1 ? `verify-${round}-retry.json` : `verify-${round}.json`,
        "verify",
        preDeliveryVerifyArtifact(
          { ...recorded, attempt: recorded.attempt ?? 0 },
          ctx.state.spec as Spec,
          ctx.state.holdout,
          await ctx.publicHoldoutSources(),
        ),
      );
    }
    const publicSources = await ctx.publicHoldoutSources();
    if (blockedOnly(verify)) {
      const stop = async (routing = ""): Promise<never> => {
        const evidence = verify.criteria
          .filter((c) => c.status === "blocked")
          .map((c, index) =>
            rowKind(c.id, ctx.state.spec ?? null, ctx.state.holdout) === "unknown"
              ? `unknown-${index + 1}: private evidence withheld`
              : `${c.id}: ${discreetModelText(c.evidence, repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet)}`,
          )
          .join("\n");
        const rawDetail = `${ENVIRONMENT_BLOCKED}\n${evidence}${routing ? `\n${routing}` : ""}`;
        const detail = redactHoldoutText(rawDetail, ctx.state.holdout as Holdout, publicSources);
        ctx.store.recordOwnerDiagnostic(
          {
            runId: ctx.run.id,
            kind: "run-error",
            text: `${ENVIRONMENT_BLOCKED}\n${verify.criteria
              .filter((c) => c.status === "blocked")
              .map((c) => `${c.id}: ${c.evidence}`)
              .join("\n")}${routing ? `\n${routing}` : ""}`,
          },
          detail,
        );
        ctx.state.terminalReason = detail;
        // Recorded apart from the retry reservation: an exhausted retry leaves no attempt row behind.
        ctx.state.needsHumanReason = detail;
        await ctx.save();
        throw new NeedsHumanError(detail);
      };
      if (previous.some((v) => v.attempt === 1)) await stop();
      // A reserved retry that never recorded a result was interrupted; resume it, don't grant another.
      if (ctx.state.environmentRetryRound === round)
        ctx.log("Resuming interrupted verification retry", "warn");
      ctx.state.environmentRetryRound = round;
      await ctx.save();
      const firstModel = concurrent
        ? ctx.state.lastVerify?.modelId
        : (previous.find((v) => v.attempt !== 1) ?? ctx.state.lastVerify)?.modelId;
      try {
        verify = await verifyAttempt(1, firstModel ? [firstModel] : []);
      } catch (error) {
        if (error instanceof NoCapacityError) await stop(error.message);
        throw error;
      }
      if (blockedOnly(verify)) await stop();
    }
    if (verify.overall !== "pass") {
      ctx.state.feedback = formatVerifyFeedback(
        verify,
        ctx.state.spec ?? null,
        ctx.state.holdout,
        publicSources,
        ctx.run.prompt,
      );
      await ctx.save();
      return false;
    }
    await recordVerified(ctx, await headSha(cwd));
    return true;
  } finally {
    ctx.previewUrl = undefined;
    await stopPreview();
  }
}

// ---------------------------------------------------------------------------
// deliver

class DeliveryHeadError extends NeedsHumanError {}

/** Only the current checked round's environment-blocked verdict permits unverified publication. */
function environmentBlockedRound(ctx: RunContext): boolean {
  const verify = ctx.state.verifyResults?.at(-1);
  return (
    !!reviewRound(ctx) &&
    !!ctx.state.terminalReason?.startsWith(ENVIRONMENT_BLOCKED) &&
    ctx.state.terminalReason === ctx.state.needsHumanReason &&
    !!ctx.state.lastVerify &&
    blockedOnly(ctx.state.lastVerify) &&
    verify?.round === ctx.state.round &&
    !!verify.sha &&
    verify.sha === ctx.state.reviewedSha &&
    blockedOnly(verify)
  );
}

/** Only round evidence, or a factory merge already validated and gated, authorizes delivery. */
async function assertDeliveryHead(ctx: RunContext, head: string): Promise<void> {
  const expected = ctx.state.reviewedSha;
  const gates = ctx.state.gateEvidence;
  const stage = gates && ctx.store.getStage(gates.stageId);
  const reason = `Delivery refused: expected checked SHA ${expected ?? "missing"}, actual HEAD ${head}`;
  if (
    !expected ||
    gates?.sha !== expected ||
    stage?.runId !== ctx.run.id ||
    stage.name !== "gates" ||
    stage.round !== ctx.state.round ||
    stage.status !== "succeeded" ||
    (ctx.state.flow !== "verify-change" &&
      ctx.state.lastVerifiedSha !== expected &&
      !environmentBlockedRound(ctx)) ||
    gates.checks.some((c) => c.blocking) ||
    ctx.state.lastReview?.verdict !== "approve" ||
    !ctx.state.lastAudit ||
    ctx.state.lastAudit.some((f) => f.severity === "block")
  )
    throw new DeliveryHeadError(`${reason}; missing or inconsistent passing round evidence`);
  if (ctx.state.pendingRebaseSha && head === ctx.state.preRebaseHead) {
    try {
      const cwd = ctx.state.worktreePath as string;
      const path = (await mergeGit(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"])).stdout.trim();
      if (!path) throw new Error("Missing MERGE_HEAD path");
      try {
        const mergeHead = readFileSync(resolve(cwd, path), "utf8").replace(/\n$/, "");
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeHead) || mergeHead !== ctx.state.pendingRebaseSha)
          throw new Error("Unexpected MERGE_HEAD contents");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch {
      ctx.checkCancelled();
      throw new DeliveryHeadError(`${reason}; invalid or unreadable pending MERGE_HEAD`);
    }
  }
  if (head === expected) return;
  if (environmentBlockedRound(ctx)) throw new DeliveryHeadError(reason);
  for (let current = head; current !== expected; ) {
    const recorded = ctx.state.deliveryMerges?.find((m) => m.sha === current);
    if (recorded && (recorded.runId !== ctx.run.id || recorded.reviewedSha !== expected))
      throw new DeliveryHeadError(reason);
    const pending = current === head ? ctx.state.pendingRebaseSha : undefined;
    // Legacy completed merges recorded their authorization in the run's head/base pair.
    const base = recorded?.base ?? pending ?? (current === ctx.run.headSha ? ctx.run.baseSha : null);
    const before = recorded?.head ?? (pending ? ctx.state.preRebaseHead : expected);
    if (!base || !before) throw new DeliveryHeadError(reason);
    // Only an uncommitted pending merge may retain MERGE_HEAD at the current HEAD.
    const inProgress = pending && current === ctx.state.preRebaseHead;
    try {
      const sha = await validateMerge(
        ctx.state.worktreePath as string,
        before,
        base,
        current === head && !inProgress ? "HEAD" : current,
      );
      if (sha !== current) throw new DeliveryHeadError(reason);
    } catch {
      ctx.checkCancelled();
      throw new DeliveryHeadError(reason);
    }
    if (!recorded && !pending) {
      ctx.state.deliveryMerges ??= [];
      ctx.state.deliveryMerges.push({
        runId: ctx.run.id,
        reviewedSha: expected,
        sha: current,
        head: before,
        base,
      });
    }
    current = before; // Pending merges still go through post-merge gates before pushing.
  }
}

async function recordVerified(ctx: RunContext, sha: string): Promise<void> {
  ctx.state.lastVerifiedSha = sha;
  ctx.state.lastVerifiedEvidence = {
    lastVerify: ctx.state.lastVerify,
    lastGates: ctx.state.lastGates,
    lastReview: ctx.state.lastReview,
    lastAudit: ctx.state.lastAudit,
    // The panel schedule in the report must match the verified review; later rounds replace (never
    // mutate) the history array, so the reference stays a faithful snapshot.
    ...(ctx.state.lastReview?.mode === "panel" ? { reviewHistory: ctx.state.reviewHistory } : {}),
  };
  await ctx.save();
}

const deliveryBudgets = new WeakMap<RunContext, { round: number; budget: GitHubBudget }>();

/**
 * One in-memory GitHub retry budget per delivery attempt, fallback draft included. A resumed
 * delivery runs in a new context and so starts fresh: downtime never counts against it.
 */
function deliveryBudget(ctx: RunContext): GitHubBudget {
  const held = deliveryBudgets.get(ctx);
  if (held?.round === ctx.state.round) return held.budget;
  const budget = { leftMs: githubRetry.budgetMs };
  deliveryBudgets.set(ctx, { round: ctx.state.round, budget });
  return budget;
}

function privateEntries(ctx: RunContext, cwd: string) {
  const { configDir, repos, work } = ctx.deps.cfg.paths;
  return loadPrivateStrings(configDir, [cwd, ctx.repo.localPath, repos, work]);
}

function publicationText(ctx: RunContext, text: string): string {
  return sanitizePublication(
    redactCredentials(text),
    publicationWorktree(ctx.state),
    ctx.deps.cfg.paths.home,
  );
}

function githubUnavailable(error: unknown): boolean {
  return (
    error instanceof GitHubUnavailableError ||
    (error instanceof Error && error.cause instanceof GitHubUnavailableError)
  );
}

async function checkWorkflowPublication(ctx: RunContext, sha: string): Promise<void> {
  const base = ctx.state.verification?.headSha ?? ctx.run.baseSha;
  if (!base) throw new DeliveryHeadError("Workflow publication check requires a recorded base");
  try {
    await assertWorkflowPublication(
      ctx.state.worktreePath as string,
      base,
      sha,
      ctx.run.allow,
      ctx.deps.cfg.paths.configDir,
      ctx.signal,
    );
  } catch (error) {
    ctx.checkCancelled();
    throw new DeliveryHeadError((error as Error).message);
  }
}

/** Check outgoing and visible text; `pr` also checks the title, branch and published range. */
async function checkPublication(
  ctx: RunContext,
  body: string,
  pr?: { sha: string; title: string; branch?: string },
  location = pr ? "PR body" : "PR comment",
) {
  const cwd = ctx.state.worktreePath as string;
  if (pr) await checkWorkflowPublication(ctx, pr.sha);
  try {
    const entries = privateEntries(ctx, cwd);
    if (repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet) {
      if (hasFactoryMark(body, ctx.run.id, ctx.deps.cfg.uiUrl))
        throw new DiscreetError(`Discreet mode blocked factory marks in ${location}`);
      if (pr && hasFactoryMark(pr.title, ctx.run.id, ctx.deps.cfg.uiUrl))
        throw new DiscreetError("Discreet mode blocked factory marks in PR title");
    }
    checkPublicationText(body, location, entries);
    if (!pr) return;
    checkPublicationText(pr.title, "PR title", entries);
    const branch =
      pr.branch ?? reviewRound(ctx)?.grant.owner.branch ?? ctx.run.deliveryBranch ?? ctx.run.branch;
    checkPublicationText(branch ?? "", "Branch name", entries);
    if (!branch || !ctx.run.baseSha) throw new Error("Missing publication branch or base");
    const range = await deliveryPublicationRange(
      ctx.repo,
      cwd,
      branch,
      ctx.run.baseSha,
      pr.sha,
      ctx.signal,
      deliveryBudget(ctx),
      repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet
        ? { runId: ctx.run.id, published: !!ctx.run.prUrl || !!ctx.run.deliveryBranch || !!reviewRound(ctx) }
        : undefined,
    );
    if (repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet)
      await checkDiscreetCommits(
        cwd,
        range,
        `refs/remotes/origin/${reviewRound(ctx)?.owner.baseBranch ?? (ctx.run.deliveryBranch ? ctx.repo.defaultBranch : ctx.run.baseBranch)}`,
        ctx.run.id,
        ctx.deps.cfg.uiUrl,
      );
    await checkPrivateRange(cwd, range, entries);
    const findings = auditDiff(await diffSince(cwd, ctx.run.baseSha as string, undefined, false, entries), {
      configDir: ctx.deps.cfg.paths.configDir,
      taskClass: ctx.run.taskClass,
      protectedPaths: [],
    });
    const hit = findings.find((f) => f.rule === "private-string");
    if (hit) throw new PrivateError(hit.detail);
  } catch (error) {
    if (
      githubUnavailable(error) ||
      error instanceof CancelledError ||
      ctx.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    const reason =
      error instanceof PrivateError || error instanceof DiscreetError
        ? error.message
        : "Private-string check blocked";
    throw new NeedsHumanError(reason);
  }
}

function deliveryIdentity(ctx: RunContext, headSha = ctx.run.headSha): PullRequestIdentity | undefined {
  return repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet
    ? { headSha: headSha ?? "", prUrl: ctx.run.prUrl }
    : undefined;
}

async function reconcilePublication(ctx: RunContext, cwd: string, budget: GitHubBudget): Promise<void> {
  const pending = ctx.state.publishingSha;
  if (!pending) return;
  const remote = await remoteBranchSha(ctx.repo, cwd, ctx.run.branch as string, ctx.signal, budget);
  if (remote === pending) ctx.state.publishedSha = pending;
  ctx.state.publishingSha = undefined;
  await ctx.save("delivery-reconciled");
}

export async function renderDeliveryReport(
  ...[ctx, success, verifiedFailure]: Parameters<typeof buildReportArtifacts>
) {
  const cwd = ctx.state.worktreePath,
    base = ctx.state.verification?.baseSha ?? ctx.run.baseSha;
  const mode = ctx.state.flow === "verify-change" ? "merge-base" : "two-dot";
  let head = "HEAD",
    redact = redactCredentials;
  if (!cwd || !base) ctx.state.sizeReport = { unavailable: !cwd ? "No worktree" : "No base SHA" };
  else
    try {
      const entries = privateEntries(ctx, cwd);
      redact = (text) => redactPrivate(text, entries);
      head = await headSha(cwd);
      const measured = await measureSize(cwd, base, head, mode, ctx.state.gatesConfig?.docs);
      const stated = statedBudget(ctx.run.prompt, redact);
      ctx.state.sizeReport = redactGateData({ ...measured, stated });
    } catch (error) {
      ctx.state.sizeReport = { base, head, mode, error: redact(redactCredentials(String(error))) };
    }
  ctx.store.setRunState(ctx.run.id, ctx.state);
  return buildReportArtifacts(ctx, success, verifiedFailure);
}

async function deliverVerifiedDraft(
  ctx: RunContext,
  sha: string,
  stage: string,
  reason: string,
): Promise<void> {
  ctx.checkCancelled();
  if (ctx.state.deliveryComplete) return;
  assertExistingBranchDelivery(ctx.repo, ctx.run, reviewRound(ctx)?.grant);
  const cwd = ctx.state.worktreePath;
  const branch = ctx.run.branch;
  const base = ctx.run.baseBranch;
  if (!cwd || !branch || !base) throw new Error("Missing verified draft delivery details");
  const rendered = await renderDeliveryReport(ctx, false, { sha, stage, reason, base });
  const body = publicationText(ctx, stripReportManifest(rendered.report));
  saveReport(ctx, rendered);
  ctx.checkCancelled();
  await checkPublication(ctx, body, { sha, title: draftTitle(ctx), branch });
  // The failed delivery may have opened its PR without hearing back, and its spent budget would
  // keep the draft below from finding it.
  if (!ctx.run.prUrl) {
    const found = await findPullRequest(ctx.repo, branch, cwd, ctx.signal, deliveryIdentity(ctx, sha));
    if (found) ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: found });
  }
  ctx.checkCancelled();
  const budget = deliveryBudget(ctx);
  await reconcilePublication(ctx, cwd, budget);
  ctx.state.publishingSha = sha;
  await ctx.save("delivery-publishing");
  await pushBranch(ctx.repo, cwd, branch, sha, ctx.signal, budget, ctx.state.publishedSha ?? null);
  ctx.state.publishedSha = sha;
  ctx.state.publishingSha = undefined;
  await ctx.save("delivery-pushed");
  ctx.checkCancelled();
  const url = await createPullRequest(ctx.repo, {
    branch,
    base,
    title: draftTitle(ctx),
    body,
    cwd,
    draft: true,
    identity: deliveryIdentity(ctx, sha),
    signal: ctx.signal,
    budget,
  });
  await ctx.save("delivery-pr-created");
  ctx.checkCancelled();
  ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: url });
  ctx.state.deliveryComplete = true;
  await ctx.save("delivery-complete");
  ctx.log(`Verified-work draft PR: ${url}`);
}

/**
 * Pushes a round onto its PR under the PR's lock. On every attempt, after every await, the round's
 * record and owner as stored now must still be the grant this delivery started with, and agree with
 * the run as stored now; the PR as seen now must be open, here, on the owner's branch, at the
 * reviewed head (or at `head`, when this delivery already pushed it). The round is recorded as
 * delivered before its section is added to the PR body.
 */
async function deliverReviewRound(
  ctx: RunContext,
  review: ReviewRoundRecord,
  cwd: string,
  head: string,
  gh: GhRunner,
  budget: GitHubBudget,
): Promise<void> {
  const { prUrl, reviewedSha } = review;
  const branch = review.grant.owner.branch as string;
  const stored = () => {
    const fresh = reviewRound(ctx);
    if (
      fresh?.prUrl !== prUrl ||
      fresh.kind !== review.kind ||
      fresh.reviewedSha !== reviewedSha ||
      fresh.owner.id !== review.owner.id ||
      fresh.owner.branch !== branch
    )
      throw new Error("existing-branch delivery refused: the round's record changed during delivery");
    const run = ctx.store.getRun(ctx.run.id) ?? {};
    assertExistingBranchDelivery(ctx.repo, run, fresh.grant);
    return { grant: fresh.grant, run };
  };
  await withPrLock(prUrl, async () => {
    const pr = await readPrHead(gh, prUrl, ctx.signal);
    const deliveredSha = ctx.store.reviewRound(ctx.run.id)?.deliveredSha;
    if (deliveredSha) {
      head = deliveredSha;
      stored();
    } else {
      if (review.kind === "conflict" && pr.isDraft) throw new Error("the PR is draft");
      if ((review.kind === "conflict" || review.kind === "ci") && pr.autoMerge)
        await gh(["pr", "merge", prUrl, "--disable-auto"], ctx.signal);
      const remote = await remoteBranchSha(ctx.repo, cwd, branch, ctx.signal, budget);
      const pushed = remote === head;
      const { grant, run } = stored();
      assertFactoryBranchPush(ctx.repo, run, grant, pr, remote, pushed ? head : reviewedSha);
      // An earlier attempt's push: record it, ending any push mark that attempt left behind.
      if (pushed) ctx.store.endPrPush(prUrl, head);
      else {
        // A barrier around the push: lookups from before it, or made while it runs, cannot record a
        // head or an approval afterwards, even if the push lands but its acknowledgement is lost.
        ctx.store.beginPrPush(prUrl, head, ctx.run.id);
        let landed: string | null = head;
        try {
          await pushExistingBranch(ctx.repo, cwd, branch, reviewedSha, ctx.signal, budget, head);
        } catch (error) {
          // An uncertain outcome: what the remote holds decides.
          landed = await remoteBranchSha(ctx.repo, cwd, branch, ctx.signal, budget).catch(() => null);
          if (landed !== head) throw error;
        } finally {
          ctx.store.endPrPush(prUrl, landed);
        }
      }
      stored();
      ctx.store.markRoundDelivered(ctx.run.id, head);
      await ctx.save("round-delivered");
    }
    const blocked = environmentBlockedRound(ctx);
    if (blocked || review.kind === "conflict" || review.kind === "ci") {
      const { marker, includes: hasMarker } = deliveryMarker(
        review.kind,
        ctx.run.id,
        repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet,
      );
      const comments = JSON.parse((await gh(["pr", "view", prUrl, "--json", "comments"], ctx.signal)) || "{}")
        .comments as { body?: string }[] | undefined;
      if (!comments?.some((comment) => hasMarker(comment.body))) {
        const failure = ctx.store.ciFixFailure(ctx.run.id);
        if (review.kind === "ci" && !failure) throw new Error("Missing CI fix failure record");
        let text = redactGateOutput(
          review.kind === "ci"
            ? `${marker}\nCI fix for the following quoted, untrusted failure:\n${promptJson(failure && { check: failure.check, line: failure.line }).replace(/</g, "\\u003c")}\nFixed at ${head}: ${discreetModelText(ctx.state.implementerReport ?? ctx.run.title, repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet)}`
            : review.kind === "conflict"
              ? `${marker}\nMerged base ${ctx.state.reviewBaseSha}. Conflicted files: ${promptJson(ctx.state.conflictFiles ?? [])}.\nConflict resolved at ${head}; approve the new head to land.`
              : `${marker}\nRound ${review.round} published at ${head}.`,
        );
        if (blocked) {
          const publicSources = await ctx.publicHoldoutSources();
          const rows = (ctx.state.lastVerify?.criteria ?? [])
            .filter((c) => c.status === "blocked")
            .map((c, index) => {
              if (rowKind(c.id, ctx.state.spec ?? null, ctx.state.holdout) === "unknown")
                return `🚧 blocked unknown-${index + 1}: private evidence withheld`;
              const evidence = publicationText(
                ctx,
                redactGateOutput(
                  redactHoldoutText(
                    discreetModelText(c.evidence, repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet),
                    ctx.state.holdout as Holdout,
                    publicSources,
                  ),
                ),
              ).slice(0, 300);
              return `🚧 blocked ${c.id}: ${evidence}`;
            });
          // Keep checked-head evidence ahead of quoted requests; the full report is a run artifact.
          text = publicationText(
            ctx,
            redactGateOutput(
              `${marker}\nRound ${review.round} published at ${head}.\n${ENVIRONMENT_BLOCKED}${repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet ? "" : `\nFull report: ${ctx.deps.cfg.uiUrl}/runs/${ctx.run.id}`}\n\n${rows.join("\n")}`,
            ),
          ).slice(0, 60_000);
        }
        text = publicationText(ctx, text);
        await checkPublication(ctx, text, { sha: head, title: ctx.run.title });
        await gh(["pr", "comment", prUrl, "--body-file", "-"], ctx.signal, text);
      }
      return;
    }
    const { includes: hasMarker, text: section } = roundSection(
      ctx.run.id,
      review.round,
      redactGateData(review.findings),
      repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet,
    );
    const text = publicationText(ctx, section);
    if (!hasMarker(pr.body)) {
      const body = publicationText(ctx, pr.body + text);
      await checkPublication(ctx, text, undefined, "PR round section");
      await checkPublication(ctx, body, undefined, "PR body");
      await gh(["pr", "edit", prUrl, "--body-file", "-"], ctx.signal, body);
    }
  });
}

async function deliver(ctx: RunContext, success: boolean): Promise<void> {
  ctx.checkCancelled();
  if (ctx.state.deliveryComplete) return;
  // Before any delivery path is chosen: a review round only ever takes its own.
  const review = reviewRound(ctx);
  const blocked = !success && environmentBlockedRound(ctx);
  assertExistingBranchDelivery(ctx.repo, ctx.run, review?.grant);
  if (ctx.run.deliveryBranch && !review && ctx.run.baseSha !== ctx.run.sourceRef?.headSha)
    throw new Error("PR delivery base does not match the verified webhook head");
  const deliverStage = async () => {
    const cwd = ctx.state.worktreePath as string;
    const budget = deliveryBudget(ctx);
    if (ctx.repo.kind === "github" && !ctx.run.deliveryBranch && !review)
      await reconcilePublication(ctx, cwd, budget);
    const runner = ctx.deps.gh ?? runGh;
    const gh: GhRunner = (args, signal, stdin) =>
      withGitHubRetry(async () => (await runner(args, signal, stdin, ctx.repo.slug)) ?? "", {
        budget,
        signal,
      });
    if (
      success &&
      ctx.repo.kind === "github" &&
      !ctx.run.deliveryBranch &&
      !review &&
      (ctx.run.prUrl || ctx.store.listStages(ctx.run.id).filter((s) => s.name === "deliver").length > 1)
    ) {
      const identity = deliveryIdentity(ctx);
      const recordedUrl = identity
        ? await withGitHubRetry(
            () => findPullRequest(ctx.repo, ctx.run.branch as string, cwd, ctx.signal, identity),
            { budget, signal: ctx.signal },
          )
        : ctx.run.prUrl;
      if (identity && recordedUrl && !ctx.run.prUrl)
        ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: recordedUrl });
      const raw =
        identity && !recordedUrl
          ? "null"
          : await gh(
              recordedUrl
                ? ["pr", "view", recordedUrl, "--repo", ctx.repo.slug, "--json", "state,url"]
                : [
                    "pr",
                    "list",
                    "--repo",
                    ctx.repo.slug,
                    "--head",
                    ctx.run.branch as string,
                    "--state",
                    "all",
                    "--json",
                    "state,url",
                  ],
              ctx.signal,
            );
      const data: unknown = JSON.parse(raw || "null");
      const candidates: unknown[] = Array.isArray(data) ? data : [data];
      const pr = candidates.find(
        (pr) => !identity || (!!pr && typeof pr === "object" && "url" in pr && pr.url === recordedUrl),
      );
      if (pr && typeof pr === "object" && "state" in pr && pr.state === "MERGED") {
        if (!("url" in pr) || typeof pr.url !== "string" || !pr.url)
          throw new Error("Merged PR lookup did not return a URL");
        ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: pr.url, merged: true });
        saveReport(ctx, await renderDeliveryReport(ctx, true));
        ctx.state.deliveryComplete = true;
        await ctx.save("delivery-complete");
        return { summary: `PR ${pr.url} — merged`, value: undefined };
      }
    }
    if (ctx.state.conflictRound !== undefined) {
      if (!ctx.state.preRebaseHead) throw new Error("Missing pre-merge HEAD at delivery");
      await validateMerge(cwd, ctx.state.preRebaseHead, ctx.run.baseSha as string);
      ctx.state.pendingRebaseSha = undefined;
      ctx.state.preRebaseGates = undefined;
      await ctx.save();
    }
    if (ctx.state.verification) {
      await discardChanges(cwd);
      if (!success) {
        saveReport(ctx, await renderDeliveryReport(ctx, false));
        return { summary: "PR verification needs human review; no push", value: undefined };
      }
      if (!(await diffSince(cwd, ctx.state.verification.headSha)).files.length) {
        ctx.run = ctx.store.updateRun(ctx.run.id, {
          headSha: await headSha(cwd),
          prUrl: `https://github.com/${ctx.repo.slug}/pull/${ctx.run.sourceRef?.number}`,
        });
        const rendered = await renderDeliveryReport(ctx, true);
        const report = rendered.report;
        if (!ctx.state.verdictCommentPosted) {
          const { marker, includes: hasMarker } = deliveryMarker(
            "verification",
            ctx.run.id,
            repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet,
          );
          ctx.checkCancelled();
          const comments = [
            "api",
            `repos/${ctx.repo.slug}/issues/${ctx.run.sourceRef?.number}/comments`,
            "--paginate",
            "--jq",
            ".[].body",
          ];
          const comment = ["pr", "comment", String(ctx.run.sourceRef?.number), "--repo", ctx.repo.slug];
          let confirmingHead = false;
          await withGitHubRetry(
            async () => {
              confirmingHead = false;
              // A pending post (an earlier attempt that failed late, or one whose checkpoint was
              // lost) may already exist remotely: look for its marker before posting again.
              if (ctx.state.verdictCommentPending && hasMarker((await runner(comments, ctx.signal)) ?? ""))
                return;
              ctx.state.verdictCommentPending = true;
              await ctx.save("verification-comment-pending");
              ctx.checkCancelled();
              let reason: string | undefined;
              try {
                const current = await runner(
                  [
                    "pr",
                    "view",
                    String(ctx.run.sourceRef?.number),
                    "--repo",
                    ctx.repo.slug,
                    "--json",
                    "headRefOid",
                  ],
                  ctx.signal,
                );
                const data: unknown = JSON.parse(current ?? "null");
                if (
                  !data ||
                  typeof data !== "object" ||
                  !("headRefOid" in data) ||
                  typeof data.headRefOid !== "string" ||
                  !/^[a-fA-F0-9]{40}$/.test(data.headRefOid)
                )
                  throw new Error("PR head lookup did not return a valid SHA");
                const verifiedSha = ctx.state.reviewedSha;
                if (!verifiedSha || ctx.run.headSha !== verifiedSha)
                  reason = "Stale PR verification: worktree does not match the reviewed commit";
                else if (data.headRefOid !== verifiedSha)
                  reason = `superseded: PR head moved from ${verifiedSha} to ${data.headRefOid}`;
              } catch (error) {
                if (error instanceof InjectedFault || error instanceof SimulatedTermination) throw error;
                ctx.checkCancelled();
                confirmingHead = true;
                throw error;
              }
              if (reason) {
                ctx.state.terminalReason = reason;
                ctx.state.needsHumanReason = undefined;
                saveReport(ctx, await renderDeliveryReport(ctx, false));
                await ctx.save("verification-stale");
                throw reason.startsWith("superseded:") ? new CancelledError() : new Error(reason);
              }
              ctx.checkCancelled();
              const body = publicationText(ctx, `${marker}\n${stripReportManifest(report)}`);
              await checkPublication(ctx, body);
              await runner([...comment, "--body", body], ctx.signal);
            },
            { budget, signal: ctx.signal },
          ).catch(async (error: unknown) => {
            if (error instanceof InjectedFault || error instanceof SimulatedTermination) throw error;
            ctx.checkCancelled();
            if (!confirmingHead) throw error;
            const reason = `Unable to confirm PR head before verdict: ${(error as Error).message}`;
            ctx.state.terminalReason = reason;
            ctx.state.needsHumanReason = undefined;
            saveReport(ctx, await renderDeliveryReport(ctx, false));
            await ctx.save("verification-stale");
            throw new Error(reason);
          });
          ctx.checkCancelled();
          ctx.state.verdictCommentPosted = true;
          await ctx.save("verification-comment-posted");
        }
        saveReport(ctx, rendered);
        ctx.state.deliveryComplete = true;
        await ctx.save("delivery-complete");
        return { summary: `Verified existing PR: ${ctx.run.prUrl}`, value: undefined };
      }
      if (!ctx.run.deliveryBranch)
        throw new NeedsHumanError("PR repairs require authorized existing-branch delivery");
    }
    // Pending clean merges must be validated before any cleanup or generic commit.
    const sha =
      ctx.state.pendingRebaseSha || ctx.state.conflictRound !== undefined
        ? null
        : await commitAll(cwd, commitMessage(ctx));
    let head = sha ?? (await headSha(cwd));
    await checkWorkflowPublication(ctx, head);
    if (success || blocked || ctx.state.phase === "deliver") await assertDeliveryHead(ctx, head);
    ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: head });
    if (success && ctx.repo.kind === "github" && !ctx.run.deliveryBranch && !review) {
      const baseBranch = ctx.run.baseBranch as string;
      const fetched = await fetchBase(ctx.deps.cfg.paths, ctx.repo, baseBranch, ctx.signal, budget);
      const recorded = ctx.run.baseSha as string;
      const note = (why: string) => {
        ctx.state.rebaseNote = `Not merged with the latest ${baseBranch}: ${why}. Delivered on ${(ctx.run.baseSha as string).slice(0, 8)}.`;
        ctx.event({
          runId: ctx.run.id,
          type: "status",
          level: "warn",
          message: ctx.state.rebaseNote,
        });
      };
      if (fetched !== recorded || ctx.state.pendingRebaseSha) {
        if (ctx.state.conflictRound !== undefined && !ctx.state.pendingRebaseSha)
          note("the base advanced again after the conflict-resolution round");
        else if (!ctx.state.pendingRebaseSha && !(await isAncestor(cwd, recorded, fetched)))
          note("the base branch no longer descends from the recorded base");
        else if (
          (await mergeForDelivery(ctx, cwd, ctx.state.pendingRebaseSha ?? fetched, head)) === "conflict"
        )
          return { summary: `merge conflicted; resolution round ${ctx.state.round}`, value: undefined };
      }
      if (!ctx.state.rebaseNote && !(await isAncestor(cwd, ctx.run.baseSha as string, await headSha(cwd))))
        note("the branch does not contain the recorded base");
    }
    const rendered = await renderDeliveryReport(ctx, success);
    const body = publicationText(ctx, stripReportManifest(rendered.report));
    const title = success ? ctx.run.title : draftTitle(ctx);
    // Failed existing-branch rounds only retain a local report; they publish no commits or PR text.
    if (success || blocked || !(review || ctx.run.deliveryBranch))
      await checkPublication(ctx, body, { sha: await headSha(cwd), title });
    head = await headSha(cwd);
    if (success || blocked || ctx.state.phase === "deliver") await assertDeliveryHead(ctx, head);

    const publish = () => {
      saveReport(ctx, rendered);
      if (ctx.state.holdout) {
        ctx.artifact("holdout-scenarios.json", "holdout", JSON.stringify(ctx.state.holdout, null, 2));
        for (const result of ctx.state.verifyResults ?? [])
          ctx.artifact(
            result.attempt === 1 ? `verify-${result.round}-retry.json` : `verify-${result.round}.json`,
            "verify",
            JSON.stringify({ ...result, modelOutput: undefined }, null, 2),
          );
      }
    };

    if (ctx.repo.kind !== "github") {
      await pushBranch(ctx.repo, cwd, ctx.run.branch as string, head, ctx.signal);
      publish();
      ctx.state.deliveryComplete = true;
      await ctx.save("delivery-complete");
      ctx.log(`Local repo: work is on branch ${ctx.run.branch}`);
      return { summary: `branch ${ctx.run.branch} ready in ${ctx.repo.localPath}`, value: undefined };
    }
    if (review || ctx.run.deliveryBranch) {
      publish();
      if (!success && !blocked) return { summary: "PR update needs human review; no push", value: undefined };
      ctx.checkCancelled();
      if (review) await deliverReviewRound(ctx, review, cwd, head, gh, budget);
      else if (ctx.run.deliveryBranch) {
        // A remote already at `head` is this delivery's own earlier push.
        if ((await remoteBranchSha(ctx.repo, cwd, ctx.run.deliveryBranch, ctx.signal, budget)) !== head)
          await pushExistingBranch(
            ctx.repo,
            cwd,
            ctx.run.deliveryBranch,
            ctx.run.baseSha as string,
            ctx.signal,
            budget,
            head,
          );
        if (ctx.run.sourceRef?.kind === "pull_request" && typeof ctx.run.sourceRef.number === "number")
          ctx.run = ctx.store.updateRun(ctx.run.id, {
            prUrl: `https://github.com/${ctx.repo.slug}/pull/${ctx.run.sourceRef.number}`,
          });
      }
      ctx.state.deliveryComplete = true;
      await ctx.save("delivery-complete");
      const branch = review?.grant.owner.branch ?? ctx.run.deliveryBranch;
      return { summary: `updated existing PR branch ${branch}`, value: undefined };
    }
    ctx.checkCancelled();
    ctx.state.publishingSha = head;
    await ctx.save("delivery-publishing");
    if (
      !ctx.state.githubWait ||
      ctx.state.publishedSha !== head ||
      (await remoteBranchSha(ctx.repo, cwd, ctx.run.branch as string, ctx.signal, budget)) !== head
    )
      await pushBranch(
        ctx.repo,
        cwd,
        ctx.run.branch as string,
        head,
        ctx.signal,
        budget,
        ctx.state.publishedSha ?? null,
      );
    ctx.state.publishedSha = head;
    ctx.state.publishingSha = undefined;
    await ctx.save("delivery-pushed");
    ctx.checkCancelled();
    const url = await createPullRequest(ctx.repo, {
      branch: ctx.run.branch as string,
      base: ctx.run.baseBranch as string,
      title,
      body,
      cwd,
      draft: !success,
      identity: deliveryIdentity(ctx, head),
      signal: ctx.signal,
      budget,
    });
    await ctx.save("delivery-pr-created");
    ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: url });
    publish();
    ctx.log(`Pull request: ${url}`);
    if (!success) {
      ctx.state.deliveryComplete = true;
      await ctx.save("delivery-complete");
      return { summary: `draft for human: ${url}`, value: undefined };
    }

    const policy = ctx.state.gatesConfig?.merge ?? ctx.repo.mergePolicy;
    let summary = `PR ${url}`;
    if (policy === "auto") {
      ctx.checkCancelled();
      const outcome = await mergePullRequest(
        url,
        cwd,
        ctx.run.headSha as string,
        ctx.signal,
        budget,
        privateEntries(ctx, cwd),
      );
      if (outcome === "merged") ctx.run = ctx.store.updateRun(ctx.run.id, { merged: true });
      summary += ` — ${outcome === "merged" ? "merged" : outcome === "auto" ? "auto-merge enabled" : `merge failed (left open)${outcome === "unavailable" ? ": GitHub unavailable" : ""}`}`;
      ctx.log(summary, outcome === "failed" || outcome === "unavailable" ? "warn" : "info");
    } else {
      summary += ` — left open (merge policy: ${policy})`;
    }
    ctx.state.deliveryComplete = true;
    await ctx.save("delivery-complete");
    return { summary, value: undefined };
  };
  await ctx.stage("deliver", deliverStage, 0, false, success);
}

/**
 * Review and verify have to read the whole change: 20 minutes (25 for verify) plus 2 minutes per
 * 100 changed lines, capped at an hour. A timeout throws away a partial review, so err long.
 */
export function readingTimeout(changedLines: number, baseMinutes = 20): number {
  return Math.min(60, baseMinutes + Math.ceil(changedLines / 100) * 2) * 60_000;
}

function readPackageJson(dir: string): string | null {
  const path = join(dir, "package.json");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export type { RunState };

class MergeRegressedError extends Error {}

function finalizePostMergeRejection(ctx: RunContext, reason: string): RunStatus {
  // Rollback and draft reporting await Git operations after publishing needs_human.
  // Keep any terminal decision recorded meanwhile; the read and write must stay synchronous.
  const current = ctx.store.getRun(ctx.run.id);
  if (current && current.status !== "needs_human" && TERMINAL_STATUSES.includes(current.status))
    return current.status;
  return ctx.store.updateRun(ctx.run.id, {
    status: "needs_human",
    error: reason.slice(0, 2000),
    finishedAt: Date.now(),
  }).status;
}

async function rollbackRejectedMerge(ctx: RunContext): Promise<never> {
  const rejected = ctx.state.postMergeRejection;
  const cwd = ctx.state.worktreePath;
  if (!rejected || !cwd) throw new Error("Missing rejected post-merge rollback details");
  await mergeGit(cwd, ["reset", "--hard", rejected.head]);
  await mergeGit(cwd, ["clean", "-fdq"]);
  ctx.state.lastGates = ctx.state.preRebaseGates ?? ctx.state.lastGates;
  ctx.state.pendingRebaseSha = undefined;
  ctx.state.preRebaseGates = undefined;
  ctx.state.preRebaseHead = undefined;
  ctx.state.needsHumanReason = rejected.reason;
  ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: rejected.head }, ctx.state);
  throw new NeedsHumanError(rejected.reason);
}

/** Merge the pinned base, retaining the previously gated head for regression fallback. */
async function mergeForDelivery(
  ctx: RunContext,
  cwd: string,
  fetched: string,
  head: string,
): Promise<"conflict" | "done"> {
  // Audit against the new base's scripts, never the implementer's merged working tree.
  ctx.state.baselineScripts = pickScripts(
    await readFileAt(cwd, fetched, "package.json"),
    gateScriptNames(ctx.state.gatesConfig as GateConfig),
  );
  if (!ctx.state.pendingRebaseSha) {
    ctx.state.pendingRebaseSha = fetched;
    ctx.state.postMergeGates = undefined;
    ctx.state.preRebaseGates = ctx.state.lastGates ?? [];
    ctx.state.preRebaseHead = head;
    await ctx.save();
  }
  const before = ctx.state.preRebaseHead;
  if (!before) throw new Error("Missing pre-merge HEAD");
  const env = gateEnv();
  const resuming = (await resumeGateExecution(ctx, "gates", "rebase", cwd, env))?.kind === "inplace";
  // A merge committed before a restart is only validated below, never prepared again.
  const merging = (await headSha(cwd)) === before;
  const conflicts = merging ? await prepareMerge(cwd, before, fetched) : [];
  if (conflicts.length) {
    ctx.state.conflictFiles = conflicts;
    ctx.state.round++;
    ctx.state.conflictRound = ctx.state.round;
    ctx.state.completedChecks = undefined;
    ctx.state.implementationReadyRound = undefined;
    ctx.state.feedback = redactGateOutput(
      `The factory started a merge of base ${fetched}. Resolve the conflict markers in these files, preserving both intents; do not run Git (including staging or committing):\n${conflicts.map((p) => `- ${p}`).join("\n")}`,
    );
    ctx.state.phase = "loop";
    ctx.state.githubWait = undefined;
    ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: fetched, headSha: before }, ctx.state);
    return "conflict";
  }
  if (merging) await completeMerge(cwd, before, fetched, mergeMessage(ctx, fetched), commitIdentity(ctx));
  await validateMerge(cwd, before, fetched);
  if (!resuming) await checkoutCommitted(cwd);
  const previous = ctx.state.preRebaseGates ?? [];
  const sha = await headSha(cwd);
  const saved = ctx.state.postMergeGates;
  if (
    !saved ||
    saved.sha !== sha ||
    saved.base !== fetched ||
    saved.head !== before ||
    saved.round !== ctx.state.round
  ) {
    ctx.state.postMergeGates = {
      sha,
      base: fetched,
      head: before,
      round: ctx.state.round,
      // Bound coordinator confirmation slot wait and execution from this merge attempt's start.
      deadline:
        Date.now() +
        (ctx.state.gatesConfig?.checks.reduce(
          (sum, c) => sum + (c.timeoutSec ?? 900),
          ctx.state.gatesConfig.setup.length * 900,
        ) ?? 900) *
          3_000,
    };
    await ctx.save();
  }
  const attempt = ctx.state.postMergeGates;
  if (!attempt) throw new Error("Missing post-merge attempt");
  const postMergeScope = <T>(fn: () => Promise<T>) =>
    gateSlotScope(gateCommandScope(ctx, "gates", "rebase", cwd, fn));
  try {
    await ctx.stage(
      "gates",
      postMergeScope(async () => {
        const docs = await docsOnlyGates(
          cwd,
          assertDistinctGateNames(ctx.state.gatesConfig as GateConfig),
          fetched,
          sha,
        );
        const checked =
          attempt.result ??
          (await (async () => {
            const workers = new Map<string, string | null | undefined>();
            const execute = (purpose: string, gates: GateConfig, hooks: GateHooks = gateEvents(ctx)) =>
              runGateExecution(ctx, "gates", purpose, cwd, gates, hooks, env, (handle, run) => {
                const worker = postMergeWorker(ctx, handle);
                for (const check of [...gates.checks, ...run.setup]) workers.set(check.name, worker);
              });
            ctx.event({
              runId: ctx.run.id,
              type: "gate",
              level: "info",
              message: `Post-merge gate selection: ${JSON.stringify(redactGateData(docs.selection))}`,
              data: docs.selection,
            });
            const timeoutOnly = (run: GateRun) =>
              run.setupOk &&
              ![...run.setup, ...run.checks].some(confinementFailed) &&
              run.checks.some((r) => r.timedOut) &&
              run.checks.every((r) => r.ok || r.timedOut || r.docsOnly?.mode === "skipped");
            let after = await execute("rebase", docs.gates);
            ctx.checkCancelled();
            if (timeoutOnly(after)) {
              const first = after;
              ctx.artifact(
                `gates-rebase-timeout-${ctx.state.round}.json`,
                "gates",
                JSON.stringify(redactGateData(first)),
              );
              await checkoutCommitted(cwd);
              after = await execute("timeout", docs.gates);
              ctx.checkCancelled();
              after.checks = after.checks.map((r) => {
                const original = findGateCounterpart(r, after.checks, first.checks);
                return {
                  ...(original?.timedOut ? validateRetry(r, original, sha, after) : r),
                  firstAttempt: original,
                };
              });
            }
            // A check fixed by the implementation must stay fixed after merging, even when
            // it failed on the original base. Persist that regression in the evidence too.
            const reference = previous.length
              ? { setupOk: true, setup: [], checks: previous.map((c) => c.result) }
              : (ctx.state.baseline ?? null);
            after = docs.annotate(after);
            const initial = compareGates(reference, after).map((c) => ({
              ...c,
              firstAttempt: c.result.firstAttempt?.ok ? undefined : c.result.firstAttempt,
              ...(c.result.firstAttempt?.timedOut
                ? {
                    retryOriginal: compareGates(reference, {
                      setupOk: true,
                      setup: [],
                      checks: [c.result.firstAttempt],
                    }).map(({ verdict, blocking }) => ({ verdict, blocking }))[0],
                  }
                : {}),
            }));
            const events = gateEvents(ctx);
            const comparison = await retryRegressions(
              initial,
              cwd,
              docs.gates,
              [],
              ctx.signal,
              events.onWait,
              (retry, options) =>
                execute(options?.targeted ? "regression-retry-targeted" : "regression-retry", retry, {
                  ...events,
                  skipGateSlot: options?.skipGateSlot,
                  fallbackSetup: docs.gates.setup,
                }),
              ctx.deps.gateExecutor?.freshCheckoutFor?.(ctx.repo.slug),
              (c) => isSlowRegression(c, initial, reference?.checks ?? []),
            );
            ctx.checkCancelled();
            for (const c of comparison) {
              if (!c.firstAttempt || c.result === initial.find((before) => before.name === c.name)?.result)
                continue;
              const before = findGateCounterpart(c, comparison, reference?.checks ?? []);
              if (!before) continue;
              ctx.event({
                runId: ctx.run.id,
                type: "gate",
                level: "warn",
                message: `${c.name} post-merge re-check: ran ${(c.firstAttempt.durationMs / before.durationMs).toFixed(1)}x its pre-merge time (${c.firstAttempt.durationMs / 1000}s vs ${before.durationMs / 1000}s): ${c.verdict === "flaky" ? "pass (flaky, not blocking)" : "FAIL again"}`,
                data: { flaky: c.verdict === "flaky", firstAttempt: c.firstAttempt, retry: c.result },
              });
            }
            attempt.result = redactGateData({
              setupOk: after.setupOk,
              timedOut: timeoutOnly(after),
              comparison: redactPostMergeComparisons(comparison, Object.fromEntries(workers)),
            });
            await ctx.save("post-merge-confirmation-pending");
            return attempt.result;
          })());
        ctx.checkCancelled();
        const { setupOk, timedOut, comparison } = checked;
        await confirmPostMerge(ctx, cwd, docs.gates, comparison, attempt.deadline, sha, () =>
          ctx.save("post-merge-confirmed"),
        );
        ctx.checkCancelled();
        for (const c of comparison) {
          const confirmation = c.coordinatorConfirmation;
          if (confirmation)
            ctx.log(
              `${c.name} post-merge coordinator confirmation (${confirmation.worker ?? "unknown worker"}): ${confirmation.reason}`,
              "warn",
            );
        }
        await mergeGit(cwd, ["reset", "--hard", "HEAD"]);
        await mergeGit(cwd, ["clean", "-fdq"]);
        ctx.state.lastGates = comparison;
        await ctx.save();
        ctx.artifact(
          `gates-rebase-${ctx.state.round}.json`,
          "gates",
          JSON.stringify(redactGateData(comparison), null, 2),
        );
        const regressed =
          !setupOk ||
          comparison.some((c) => c.blocking) ||
          previous.some((c) => {
            const current = findGateCounterpart(c, previous, comparison)?.result;
            return c.result.ok && current?.docsOnly?.mode !== "skipped" && !current?.ok;
          });
        if (regressed)
          throw new MergeRegressedError(
            (timedOut ? "post-merge gate timed out" : "post-merge gates regressed") +
              comparison
                .filter((c) => c.blocking && c.coordinatorConfirmation)
                .map((c) => {
                  const confirmation = c.coordinatorConfirmation;
                  return `\n${c.name} coordinator confirmation (${confirmation?.worker ?? "unknown worker"}): ${confirmation?.reason}\n${confirmation?.result ? formatGateOutput(confirmation.result, 9_000) : ""}`;
                })
                .join(""),
          );
        return { summary: `${comparison.length} post-merge checks ok`, value: undefined };
      }),
      ctx.state.round,
    );
  } catch (error) {
    if (!(error instanceof MergeRegressedError)) throw error;
    ctx.state.postMergeRejection = {
      reason: redactGateOutput(`${error.message} after merging onto ${fetched.slice(0, 8)}`),
      sha,
      base: fetched,
      head: before,
      round: ctx.state.round,
    };
    ctx.state.needsHumanReason = ctx.state.postMergeRejection.reason;
    ctx.run = ctx.store.updateRun(
      ctx.run.id,
      { status: "needs_human", error: ctx.state.needsHumanReason.slice(0, 2000), finishedAt: Date.now() },
      ctx.state,
    );
    return rollbackRejectedMerge(ctx);
  }
  const merged = await validateMerge(cwd, before, fetched);
  if (ctx.state.reviewedSha) {
    ctx.state.deliveryMerges ??= [];
    ctx.state.deliveryMerges.push({
      runId: ctx.run.id,
      reviewedSha: ctx.state.reviewedSha,
      sha: merged,
      head: before,
      base: fetched,
    });
  }
  ctx.state.pendingRebaseSha = undefined;
  ctx.state.preRebaseGates = undefined;
  ctx.state.preRebaseHead = undefined;
  ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: fetched, headSha: await headSha(cwd) }, ctx.state);
  return "done";
}
