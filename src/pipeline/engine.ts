import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertExistingBranchDelivery, isBranchName } from "../core/delivery.ts";
import type { ResolvedProfile, RunStatus } from "../core/types.ts";
import { type AuditFinding, auditDiff } from "../gates/audit.ts";
import {
  BASELINE_CACHE_TTL_MS,
  baselineCacheKey,
  cacheableBaseline,
  gateEnvDigest,
  lockfileHash,
  singleFlight,
} from "../gates/cache.ts";
import { detectGates, type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import {
  compareGates,
  type GateComparison,
  type GateHooks,
  type GateRun,
  gateEnv,
  retryBaselineFailures,
  retryRegressions,
  runGates,
} from "../gates/run.ts";
import { completeMerge, mergeGit, prepareMerge, requireMerge, validateMerge } from "../git/merge.ts";
import {
  commitAll,
  createPullRequest,
  createWorktree,
  diffSince,
  discardChanges,
  ensureCache,
  exportCommit,
  fetchBase,
  findPullRequest,
  formatTopLevel,
  type GitHubBudget,
  githubRetry,
  headSha,
  isAncestor,
  mergePullRequest,
  pushBranch,
  pushExistingBranch,
  readFileAt,
  remoteBranchSha,
  removeWorktree,
  resetTo,
  withGitHubRetry,
} from "../git/repos.ts";
import { type GhRunner, runGh } from "../integrations/github.ts";
import type { RouteConstraints } from "../router/router.ts";
import { formatTarget } from "../router/targets.ts";
import {
  CancelledError,
  type EngineDeps,
  NeedsHumanError,
  NoCapacityError,
  ParkedError,
  RunContext,
  type RunState,
} from "./context.ts";
import { InjectedFault, SimulatedTermination } from "./faults.ts";
import { needsPreview, type Preview, readPreviewConfig, startPreview } from "./preview.ts";
import {
  formatAuditFeedback,
  formatGateFeedback,
  formatReviewFeedback,
  formatVerifyFeedback,
  holdoutPrompt,
  implementPrompt,
  redactHoldoutText,
  specPrompt,
  triagePrompt,
  verifyPrompt,
} from "./prompts.ts";
import { buildReport } from "./report.ts";
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
import { configuredReviewSystem, readReviewLenses } from "./review-system.ts";
import {
  type Holdout,
  HoldoutSchema,
  type Review,
  type ReviewScope,
  renderSpec,
  type Spec,
  SpecSchema,
  TriageSchema,
  toStrictJsonSchema,
  type Verify,
  VerifySchema,
} from "./schemas.ts";
import { createSnapshotParent } from "./snapshots.ts";
import { triageDecisions } from "./triage-decisions.ts";
import {
  blockedOnly,
  ENVIRONMENT_BLOCKED,
  normalizeVerify,
  preDeliveryVerifyArtifact,
} from "./verification.ts";

const ROUNDS_PER_IMPLEMENTER = 2;

/** Execute (or resume) one run to completion. Never throws. */
export async function executeRun(
  deps: EngineDeps,
  runId: string,
  signal: AbortSignal,
  isDraining: () => boolean = () => false,
): Promise<RunStatus> {
  const run = deps.store.getRun(runId);
  if (!run) return "failed";
  const repo = deps.store.getRepo(run.repoId);
  if (!repo) {
    deps.store.updateRun(runId, { status: "failed", error: "repo not found", finishedAt: Date.now() });
    return "failed";
  }
  const ctx = new RunContext(deps, run, repo, signal, isDraining);
  ctx.state.parked = false;
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
    // Recheck persisted provenance on resume, including runs created before this guard existed.
    assertExistingBranchDelivery(ctx.repo, ctx.run);
    if (ctx.state.needsHumanReason) throw new NeedsHumanError(ctx.state.needsHumanReason);
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
    if (!signal.aborted && (e instanceof SimulatedTermination || ctx.termination)) return "running";
    if (e instanceof InjectedFault && !signal.aborted) {
      ctx.log(`Run interrupted: ${e.message}; re-queued to resume`, "warn");
      deps.store.updateRun(runId, { status: "queued", stage: null });
      return "queued";
    }
    const cancelled = (): RunStatus => {
      deps.store.updateRun(runId, { status: "cancelled", finishedAt: Date.now() });
      ctx.log("Run cancelled", "warn");
      return "cancelled";
    };
    if (e instanceof CancelledError || signal.aborted) return cancelled();
    if (e instanceof ParkedError) {
      ctx.state.parked = true;
      ctx.run = deps.store.updateRun(runId, { status: "queued", stage: null }, ctx.state);
      ctx.log(`Run parked at phase "${ctx.state.phase}" for deploy`);
      return "queued";
    }
    const verifiedSha = ctx.state.lastVerifiedSha;
    const verifiedFailure =
      verifiedSha &&
      ctx.repo.kind === "github" &&
      !ctx.run.deliveryBranch &&
      (!ctx.run.prUrl || !!ctx.state.needsHumanReason) &&
      (ctx.state.phase === "deliver" || ctx.state.conflictRound !== undefined);
    const needsHuman = e instanceof NeedsHumanError || e instanceof NoCapacityError || !!verifiedFailure;
    const message = (e as Error).message;
    const failureStage =
      ctx.state.conflictRound !== undefined
        ? "conflict resolution"
        : message.includes("post-merge gates")
          ? "post-merge gates"
          : ctx.run.stage === "deliver"
            ? "delivery merge"
            : (ctx.run.stage ?? "delivery merge");
    ctx.log(`Run ${needsHuman ? "needs a human" : "failed"}: ${message}`, "error", {
      stack: (e as Error).stack,
    });
    if (verifiedFailure) {
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
        ctx.log(`Could not open verified-work draft PR: ${(err as Error).message}`, "warn");
      }
    } else if (
      e instanceof NeedsHumanError &&
      ctx.state.worktreePath &&
      ctx.state.conflictRound === undefined &&
      !ctx.state.pendingRebaseSha
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
        ctx.log(`Could not open draft PR: ${(err as Error).message}`, "warn");
      }
    }
    const status: RunStatus = needsHuman ? "needs_human" : "failed";
    deps.store.updateRun(runId, { status, error: message.slice(0, 2000), finishedAt: Date.now() });
    return status;
  }
}

// ---------------------------------------------------------------------------
// prepare: repo cache, worktree, gate detection, baseline

function gateEvents(ctx: RunContext): Required<GateHooks> {
  return {
    onResult: (r) =>
      ctx.store.addEvent({
        runId: ctx.run.id,
        type: "gate",
        level: r.ok ? "info" : "warn",
        message: `${r.name}: ${r.ok ? "pass" : "FAIL"} (${Math.round(r.durationMs / 1000)}s)`,
        data: r,
      }),
    onWait: (slots) =>
      ctx.store.addEvent({
        runId: ctx.run.id,
        type: "gate",
        message: `Waiting for a gate slot (all ${slots} in use; limits.max_concurrent_gates)`,
      }),
  };
}

async function prepare(ctx: RunContext): Promise<void> {
  assertExistingBranchDelivery(ctx.repo, ctx.run);
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
    await ensureCache(cfg.paths, ctx.repo);
    const base = ctx.run.baseBranch ?? ctx.repo.defaultBranch;
    const reusingWorktree = existsSync(join(cfg.paths.work, ctx.run.id));
    const wt = await createWorktree(cfg.paths, ctx.repo, ctx.run.id, ctx.run.title, base);
    if (ctx.run.deliveryBranch && ctx.run.sourceRef?.headSha !== wt.baseSha)
      throw new Error("PR head moved before preparation");
    ctx.state.worktreePath = wt.path;
    const baseSha =
      reusingWorktree && ctx.state.flow !== "verify-change"
        ? (ctx.run.baseSha ?? (await headSha(wt.path)))
        : wt.baseSha;
    ctx.run = store.updateRun(ctx.run.id, { baseBranch: base, baseSha, branch: wt.branch });
    const verification = ctx.state.verification;
    if (verification) {
      ctx.run = store.updateRun(ctx.run.id, { baseSha: verification.headSha });
      await resetTo(wt.path, verification.baseSha);
    }
    await discardChanges(wt.path);
    let gates: GateConfig;
    try {
      const repoConfig = await readFileAt(wt.path, verification?.baseSha ?? baseSha, ".limitless.toml");
      ctx.state.previewConfig = readPreviewConfig(repoConfig);
      // Review lenses come from the base commit, never from the change under review.
      if (ctx.deps.cfg.reviewMode === "panel")
        ctx.state.reviewLenses = readReviewLenses(repoConfig, (message) => ctx.log(message, "warn"));
      gates = detectGates(wt.path);
      ctx.state.gatesConfig = gates;
      ctx.state.baselineScripts = pickScripts(readPackageJson(wt.path), gateScriptNames(gates));
      ctx.log(
        `Gates (${gates.source}): ${[...gates.setup, ...gates.checks.map((c) => c.run)].join(" | ") || "none"}`,
      );
      await ctx.save();
      const { onWait } = gateEvents(ctx);
      const hasGates = gates.setup.length > 0 || gates.checks.length > 0;
      const runBaseline = async (): Promise<GateRun> => {
        const run = await runGates(wt.path, gates, ctx.signal, { onWait });
        ctx.checkCancelled();
        // Retry before resetting, so a check sees the same build output as its first attempt.
        const retried = await retryBaselineFailures(run, wt.path, gates, ctx.signal, onWait);
        ctx.checkCancelled();
        return retried;
      };
      ctx.state.baselineCached = false;
      const buildSha = ctx.deps.buildSha;
      if (!hasGates) ctx.state.baseline = null;
      // Without a known build the gate environment can't be keyed: never read or write the cache.
      else if (!buildSha) ctx.state.baseline = await runBaseline();
      else {
        // Keyed by the commit actually checked out, so verify-change caches its PR base.
        const key = baselineCacheKey({
          repoId: ctx.repo.id,
          baseSha: await headSha(wt.path),
          gates,
          lockfileHash: lockfileHash(wt.path),
          bunVersion: Bun.version,
          platform: process.platform,
          arch: process.arch,
          buildSha,
          envDigest: gateEnvDigest(gateEnv(), cfg.baselineEnv),
        });
        // A bypass still runs the baseline and refreshes the entry if it passes.
        const bypass = ctx.run.noBaselineCache === true || !cfg.baselineCache;
        const baseline = async (): Promise<GateRun> => {
          const cached = bypass
            ? null
            : store.getBaselineCache<GateRun>(key, Date.now() - BASELINE_CACHE_TTL_MS);
          if (cached && cacheableBaseline(cached, gates)) {
            ctx.state.baselineCached = true;
            ctx.log(`Baseline reused from cache (${key.baseSha.slice(0, 12)})`);
            return cached;
          }
          const fresh = await runBaseline();
          // Only a passing baseline is cached; a failure (maybe flaky) must run again next time,
          // and it contradicts any cached pass for this key, so that entry goes.
          if (cacheableBaseline(fresh, gates)) store.putBaselineCache(key, fresh, ctx.run.id);
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
      if (verification) await resetTo(wt.path, verification.headSha);
      else await discardChanges(wt.path);
    }
    const baseline = ctx.state.baseline;
    if (baseline) {
      store.putArtifact(ctx.run.id, "baseline-gates.json", "gates", JSON.stringify(baseline, null, 2));
      for (const r of [...baseline.setup, ...baseline.checks]) {
        store.addEvent({
          runId: ctx.run.id,
          type: "gate",
          level: r.ok ? "info" : "warn",
          message: `baseline ${r.name}: ${r.ok ? "pass" : "FAIL"} (${Math.round(r.durationMs / 1000)}s)`,
          data: r,
        });
      }
      for (const { firstAttempt, ...retry } of baseline.checks) {
        if (!firstAttempt) continue;
        store.addEvent({
          runId: ctx.run.id,
          type: "gate",
          level: "warn",
          message: `baseline ${retry.name}: ${retry.ok ? "flaky" : "retry FAIL again"}`,
          data: { flaky: retry.ok, firstAttempt, retry },
        });
      }
    }
    await ctx.setPhase("triage");
    const failing = baseline ? baseline.checks.filter((c) => !c.ok).map((c) => c.name) : [];
    return {
      summary: `worktree ${wt.branch}; ${gates.checks.length} checks${failing.length ? `, failing on base: ${failing.join(", ")}` : ""}${ctx.state.baselineCached ? "; baseline reused from cache" : ""}`,
      value: undefined,
    };
  });
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
      title: ctx.run.title === ctx.run.prompt.split("\n")[0]?.slice(0, 80) ? t.title : ctx.run.title,
      taskClass: t.task_class,
      complexity: t.complexity,
      resolvedProfile: profile,
    });
    ctx.store.putArtifact(
      ctx.run.id,
      "triage.json",
      "triage",
      JSON.stringify({ ...t, model: target.modelId }, null, 2),
    );
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
    const cleanup = () => {
      unsubscribe();
      ctx.signal.removeEventListener("abort", onAbort);
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
    const { result, target } = await ctx.invoke({
      role: "spec",
      stage,
      mode: "readonly",
      complexity: ctx.complexity,
      prompt: specPrompt({ prompt: ctx.run.prompt, answers: ctx.state.answers }),
      jsonSchema: toStrictJsonSchema(SpecSchema),
      schema: SpecSchema,
      requireStructured: true,
      maxToolCalls: 60,
    });
    await discardChanges(ctx.state.worktreePath as string);
    const s = SpecSchema.parse(result.structured);
    ctx.store.putArtifact(ctx.run.id, "spec.md", "spec", `# ${ctx.run.title}\n\n${renderSpec(s)}\n`);
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
      : Math.max(1, ctx.deps.cfg.maxRounds) + ROUNDS_PER_IMPLEMENTER;
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
 * Run `fn` in a private export of the recorded base commit, removed afterwards whatever the outcome.
 * Holdout runs alongside implement, so it must never see the worktree the implementer is editing.
 */
async function withBaseSnapshot<T>(ctx: RunContext, fn: (dir: string) => Promise<T>): Promise<T> {
  const worktree = ctx.state.worktreePath;
  const baseSha = ctx.run.baseSha;
  if (!worktree || !baseSha) throw new Error("Holdout needs the run worktree and recorded base commit");
  const snapshot = createSnapshotParent();
  try {
    const base = join(snapshot, "base");
    mkdirSync(base);
    await exportCommit(worktree, baseSha, base, ctx.signal);
    return await fn(base);
  } finally {
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

async function implementStage(ctx: RunContext, round: number): Promise<void> {
  const cwd = ctx.state.worktreePath as string;
  const gates = ctx.state.gatesConfig as GateConfig;
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
            }
          : {};
        if (escalate) {
          // Prefer a stronger model; otherwise any model not tried yet; otherwise keep going as-is.
          const options: RouteConstraints[] = [
            { minTier: Math.min(5, current.tier + 1), exclude: ctx.state.triedImplementers },
            { exclude: ctx.state.triedImplementers },
            {},
          ];
          constraints =
            options.find(
              (c) =>
                ctx.deps.router.route("implement", ctx.complexity, ctx.routingConstraints(c)).candidates
                  .length,
            ) ?? {};
          ctx.log(`Escalating implementer beyond ${current.modelId}`, "warn", { constraints });
          ctx.state.roundsOnImplementer = 0;
        }
        const { result, target } = await ctx.invoke({
          role: "implement",
          stage,
          mode: "edit",
          complexity: ctx.complexity,
          constraints,
          prompt: implementPrompt({
            prompt: ctx.run.prompt,
            spec: ctx.state.spec ?? null,
            gates,
            baseline: ctx.state.baseline ?? null,
            baseSha: ctx.state.verification?.baseSha ?? baseSha,
            externalChange: ctx.state.flow === "verify-change",
            round,
            feedback: ctx.state.feedback,
            hasHoldout: ctx.state.flow !== "verify-change" && profile(ctx) !== "quick",
            resolution: merge,
          }),
        });
        ctx.state.implementer = {
          modelId: target.modelId,
          targetId: target.targetId,
          effort: target.effort ?? null,
          tier: target.tier,
          vendor: target.vendor,
        };
        if (
          !ctx.state.triedImplementers.some(
            (ref) =>
              (typeof ref === "string" ? ref : formatTarget(ref.modelId, ref.effort)) ===
              (target.targetId ?? target.modelId),
          )
        )
          ctx.state.triedImplementers.push({ modelId: target.modelId, effort: target.effort ?? null });
        ctx.state.implementerReport = result.finalText;
        ctx.store.putArtifact(
          ctx.run.id,
          `implement-${round}.md`,
          "report",
          result.finalText || "(no report)",
        );
        ctx.state.implementerIssue =
          result.status === "ok"
            ? null
            : `${result.status}${result.error ? `: ${result.error}` : ""}`.slice(0, 500);
        if (result.status !== "ok") ctx.log(`Implementer ended with ${result.status}`, "warn");
        ctx.state.implementationReadyRound = round;
        await ctx.save("implementation-ready");
      }
      ctx.checkCancelled();
      const sha =
        merge && previousHead
          ? await completeMerge(cwd, previousHead, baseSha)
          : await commitAll(cwd, `limitless: ${ctx.run.title} (round ${round + 1})\n\nRun: ${ctx.run.id}`);
      ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: sha ?? (await headSha(cwd)) });
      ctx.state.implementedRound = round;
      await ctx.save("implementation-committed");
      return {
        summary: `${ctx.state.implementer?.modelId}: ${ctx.state.implementerIssue ?? "ok"}; ${sha ?? "no changes"}`,
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
  const gates = ctx.state.gatesConfig as GateConfig;
  const baseSha = ctx.state.verification?.baseSha ?? (ctx.run.baseSha as string);
  const changeDiff = () => diffSince(cwd, baseSha, undefined, ctx.state.flow === "verify-change");
  const system =
    ctx.deps.reviewSystem ?? configuredReviewSystem(ctx.deps.cfg, profile(ctx), ctx.state.reviewLenses);
  const resolution = ctx.state.conflictRound === round;
  // Panel reviews are numbered apart from implementation rounds (a gate-failed round reviews nothing,
  // a replayed round keeps its number); a conflict-resolution review is outside the count.
  const panelReview =
    system.mode === "panel" && !resolution
      ? Math.max(
          0,
          ...(ctx.state.reviewHistory ?? []).filter((e) => e.round < round).map((e) => e.panelReview ?? 0),
        ) + 1
      : undefined;
  // What decides a panel review's blocking findings; a conflict-resolution review follows R2's rules.
  const panelRules: PanelReview | undefined =
    resolution && system.mode === "panel" ? "resolution" : panelReview;
  // Checked before implementing: work no review can see is not worth paying for. The worktree keeps
  // the head the last review saw, which the draft delivers.
  if (panelReview && panelReview > PANEL_REVIEWS)
    throw new NeedsHumanError(
      `Panel review limit reached (R${PANEL_REVIEWS}); not implementing again. Last feedback:\n${ctx.state.feedback ?? ""}`,
    );

  // --- implement (skipped when resuming a round whose implementation already landed)
  if (round >= 0 && ctx.state.implementedRound !== round) await implementStage(ctx, round);
  if (resolution) {
    if (!ctx.state.preRebaseHead || ctx.state.pendingRebaseSha !== baseSha)
      throw new Error("Missing expected merge state for resolution checks");
    await validateMerge(cwd, ctx.state.preRebaseHead, baseSha);
  }

  // --- gates
  const comparison = await ctx.stage(
    "gates",
    async () => {
      const events = gateEvents(ctx);
      let cmp: GateComparison[];
      try {
        await discardChanges(cwd);
        const after = await runGates(cwd, gates, ctx.signal, events);
        ctx.checkCancelled();
        const changed = (await changeDiff()).files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
        // Retry before discarding, so a check sees the same build output as its first attempt.
        cmp = await retryRegressions(
          compareGates(ctx.state.baseline ?? null, after),
          cwd,
          gates,
          changed,
          ctx.signal,
          events.onWait,
        );
        ctx.checkCancelled();
        // Gates may have produced files (build output, formatter fixes); don't let them leak into the diff.
      } finally {
        await discardChanges(cwd);
      }
      for (const c of cmp.filter((c) => c.firstAttempt)) {
        ctx.store.addEvent({
          runId: ctx.run.id,
          type: "gate",
          level: "warn",
          message: `${c.name} retry: ${c.result.ok ? "pass (flaky, not blocking)" : "FAIL again"}`,
          data: { flaky: c.result.ok, firstAttempt: c.firstAttempt, retry: c.result },
        });
      }
      ctx.state.lastGates = cmp;
      ctx.store.putArtifact(ctx.run.id, `gates-${round}.json`, "gates", JSON.stringify(cmp, null, 2));
      const blocking = cmp.filter((c) => c.blocking).map((c) => c.name);
      const flaky = cmp.filter((c) => c.verdict === "flaky").map((c) => c.name);
      return {
        summary: blocking.length
          ? `blocking: ${blocking.join(", ")}`
          : `${cmp.length} checks ok${flaky.length ? `, flaky: ${flaky.join(", ")}` : ""}`,
        value: cmp,
      };
    },
    round,
  );

  // --- audit
  const diff = await changeDiff();
  const audit: AuditFinding[] = await ctx.stage(
    "audit",
    async () => {
      const findings = auditDiff(diff, {
        taskClass: ctx.state.verification && ctx.run.taskClass === "question" ? null : ctx.run.taskClass,
        protectedPaths: gates.protectedPaths,
        toolCommands: ctx.state.toolCommands,
        gateScripts: {
          before: ctx.state.baselineScripts ?? {},
          after: pickScripts(readPackageJson(cwd), gateScriptNames(gates)),
        },
      });
      if (ctx.state.verification) {
        const repairs = await diffSince(cwd, ctx.state.verification.headSha);
        if (repairs.files.length)
          findings.push(
            ...auditDiff(repairs, {
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
        ctx.store.addEvent({
          runId: ctx.run.id,
          type: "audit",
          level: f.severity === "block" ? "error" : "warn",
          message: `[${f.rule}] ${f.file ? `${f.file}: ` : ""}${f.detail}`,
          data: f,
        });
      }
      ctx.store.putArtifact(ctx.run.id, "diff.patch", "diff", diff.patch);
      const blocks = findings.filter((f) => f.severity === "block").length;
      return {
        summary: `+${diff.added}/-${diff.removed} in ${diff.files.length} files; ${blocks} blocking, ${findings.length - blocks} warnings`,
        value: findings,
      };
    },
    round,
  );

  const gateFeedback = formatGateFeedback(comparison);
  const auditFeedback = formatAuditFeedback(audit);
  if (gateFeedback || auditFeedback) {
    // Don't spend reviewer tokens on work that fails deterministic checks.
    const issue = ctx.state.implementerIssue
      ? `### Your previous session ended early\n${ctx.state.implementerIssue}\nKeep the next attempt focused and finish by running the checks.`
      : "";
    ctx.state.feedback = [issue, gateFeedback, auditFeedback].filter(Boolean).join("\n\n");
    await ctx.save();
    ctx.log("Deterministic checks failed; sending feedback to implementer", "warn");
    return false;
  }

  // --- review (a different vendor than the implementer)
  if (ctx.state.lastReview && !ctx.state.reviewHistory?.length)
    throw new NeedsHumanError("Previous review has no round history; cannot classify later findings");
  const earlierReviews = (ctx.state.reviewHistory ?? []).filter((entry) => entry.round < round);
  const priorReview = earlierReviews.at(-1);
  const reviewedSha = await headSha(cwd);
  // R2 and R3 review only the fixes since the previous review. A conflict-resolution review, like a
  // single one, sees the change against the new base, so upstream-only files never appear.
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
  const previousReview = priorReview
    ? {
        sha: priorReview.sha,
        findings: priorReview.blocking,
        ...(fixSha ? { resolved: resolvedPriorFindings(earlierReviews) } : {}),
      }
    : undefined;
  const review: Review = await ctx.stage(
    "review",
    async (stage) => {
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
          prompt: ctx.run.prompt,
          spec: ctx.state.spec ?? null,
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
          previous: previousReview,
          headSha: reviewedSha,
          resolution,
          ...(fixSha && panelReview ? { fixReview: panelReview } : {}),
        },
      };
      // TODO: parallel panel finders share this worktree, and each call discards changes when it ends,
      // possibly while another finder still runs. Readers are read-only; single mode runs one finder.
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
          complexity: profile(ctx) === "deep" ? "large" : ctx.complexity,
          constraints: { ...constraints, ...(prefer ? { prefer } : {}) },
          ...request,
          ...(deadline ? { deadline } : {}),
          requireStructured: true,
        });
        await discardChanges(cwd);
        return invoked;
      };
      const { target, output, decision, panel } = await runReview(
        {
          invoke: async (request, index) => {
            const finder = system.finders[index];
            const vendor = ctx.state.implementer?.vendor;
            const constraints: RouteConstraints = {
              ...(finder?.family === "implementer" ? { preferVendor: vendor } : { avoidVendor: vendor }),
              ...(finder?.local ? { billing: "free_only" as const } : {}),
            };
            // One deadline covers a local finder's slot waits and fallbacks; past it, the panel skips it.
            const deadline = finder?.local ? Date.now() + request.timeoutMs : undefined;
            try {
              return await call(request, constraints, finder?.target, deadline);
            } catch (error) {
              if (finder?.local && error instanceof NoCapacityError) throw new FinderSkipped(error.message);
              throw error;
            }
          },
          verify: (request, avoidVendors, avoidModels) => {
            // A listed verifier is picked per batch, as evals do; it is preferred like a lone target.
            const listed = system.verifier?.targets?.map((target) => {
              const { model, targetId } = ctx.deps.router.resolve(target);
              return { vendor: model.vendor, modelId: model.id, targetId };
            });
            return call(
              request,
              verifierConstraints(avoidVendors, avoidModels, ctx.state.implementer),
              listed ? pickVerifier(listed, avoidVendors, avoidModels).targetId : system.verifier?.target,
            );
          },
          warn: (message) => ctx.log(message, "warn"),
        },
        input,
      );
      if (!decision) throw output.error;
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
      if (sameVendor) ctx.log("Review done by the implementer's vendor (no other vendor available)", "warn");
      ctx.state.lastReview = { ...r, modelId: target.modelId };
      ctx.state.reviewedSha = reviewedSha;
      await ctx.save();
      // Panel artifacts are numbered by review (R1-R3), single ones by implementation round.
      ctx.store.putArtifact(
        ctx.run.id,
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
      const serious = blocking.length;
      return {
        summary: `${r.verdict} by ${target.modelId}: ${serious} blocking, ${r.findings.length - serious} nonblocking`,
        value: r,
      };
    },
    round,
  );

  const reviewFeedback =
    review.verdict === "request_changes"
      ? formatReviewFeedback(
          blockingReviewFindings(review, previousReview?.findings, panelRules),
          review.mode === "panel",
        )
      : "";
  if (review.verdict === "request_changes") {
    ctx.state.feedback = reviewFeedback || `### Code review requested changes\n${review.summary}`;
    await ctx.save();
    // Never a fourth panel review: what still blocks goes to a human with a draft PR.
    if (panelReview && panelReview >= PANEL_REVIEWS)
      throw new NeedsHumanError(`Still blocking after panel review R${panelReview}:\n${ctx.state.feedback}`);
    return false;
  }

  // --- verify acceptance criteria (standard/deep)
  if (ctx.state.flow === "verify-change" || profile(ctx) === "quick") {
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
    const verifyAttempt = async (attempt: number, excludeModels: string[] = []): Promise<Verify> => {
      if (!preview && previewConfig && needsPreview(previewConfig, diff)) {
        preview = await ctx.stage(
          "preview",
          async () => {
            const server = await startPreview(cwd, previewConfig, ctx.signal);
            preview = server; // Retain ownership if the stage completion checkpoint is interrupted.
            ctx.log(`Preview ready at ${server.url}`);
            return { summary: `ready at ${server.url}`, value: server };
          },
          round,
        );
        ctx.previewUrl = preview.url;
      }
      return ctx.stage(
        "verify",
        async (stage) => {
          const { result, target } = await ctx.invoke({
            role: "verify",
            stage,
            mode: "readonly",
            complexity: ctx.complexity,
            constraints: { avoidVendor: ctx.state.implementer?.vendor, excludeModels },
            timeoutMs: readingTimeout(diff.added + diff.removed, 25),
            prompt: verifyPrompt({
              prompt: ctx.run.prompt,
              spec: ctx.state.spec as Spec,
              holdout: ctx.state.holdout as Holdout,
              baseSha,
              checks: ctx.state.lastGates,
            }),
            jsonSchema: toStrictJsonSchema(VerifySchema),
            schema: VerifySchema,
            requireStructured: true,
            privateSession: true,
            redactHoldout: true,
          });
          await discardChanges(cwd);
          const v = normalizeVerify(
            VerifySchema.parse(result.structured),
            ctx.state.spec as Spec,
            ctx.state.holdout as Holdout,
            ctx.run.prompt,
          );
          ctx.state.lastVerify = { ...v, modelId: target.modelId };
          ctx.state.verifyResults = [
            ...(ctx.state.verifyResults ?? []),
            { ...v, modelId: target.modelId, round, attempt },
          ];
          await ctx.save();
          const publicSources = await ctx.publicHoldoutSources();
          ctx.store.putArtifact(
            ctx.run.id,
            attempt === 0 ? `verify-${round}.json` : `verify-${round}-retry.json`,
            "verify",
            preDeliveryVerifyArtifact(
              { ...v, modelId: target.modelId, round, attempt },
              ctx.state.spec as Spec,
              ctx.state.holdout as Holdout,
              publicSources,
            ),
          );
          const met = v.criteria.filter((c) => c.status === "met").length;
          return {
            summary: `${v.overall}: ${met}/${v.criteria.length} criteria met (${target.modelId})`,
            value: v,
          };
        },
        round,
      );
    };
    const previous = (ctx.state.verifyResults ?? []).filter((v) => v.round === round);
    const recorded = previous.at(-1);
    let verify = recorded
      ? normalizeVerify(recorded, ctx.state.spec as Spec, ctx.state.holdout, ctx.run.prompt)
      : await verifyAttempt(0);
    if (recorded) {
      Object.assign(recorded, verify);
      ctx.state.lastVerify = { ...verify, modelId: recorded.modelId };
      await ctx.save();
    }
    const publicSources = await ctx.publicHoldoutSources();
    if (blockedOnly(verify)) {
      const stop = async (routing = ""): Promise<never> => {
        const evidence = verify.criteria
          .filter((c) => c.status === "blocked")
          .map((c) => `${c.id}: ${c.evidence}`)
          .join("\n");
        const detail = redactHoldoutText(
          `${ENVIRONMENT_BLOCKED}\n${evidence}${routing ? `\n${routing}` : ""}`,
          ctx.state.holdout as Holdout,
          publicSources,
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
      const firstModel = (previous.find((v) => v.attempt !== 1) ?? ctx.state.lastVerify)?.modelId;
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

async function deliverVerifiedDraft(
  ctx: RunContext,
  sha: string,
  stage: string,
  reason: string,
): Promise<void> {
  ctx.checkCancelled();
  if (ctx.state.deliveryComplete) return;
  const cwd = ctx.state.worktreePath;
  const branch = ctx.run.branch;
  const base = ctx.run.baseBranch;
  if (!cwd || !branch || !base) throw new Error("Missing verified draft delivery details");
  const report = buildReport(ctx, false, { sha, stage, reason, base });
  ctx.store.putArtifact(ctx.run.id, "report.md", "report", report);
  ctx.checkCancelled();
  // The failed delivery may have opened its PR without hearing back, and its spent budget would
  // keep the draft below from finding it.
  if (!ctx.run.prUrl) {
    const found = await findPullRequest(ctx.repo, branch, cwd, ctx.signal);
    if (found) ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: found });
  }
  ctx.checkCancelled();
  const budget = deliveryBudget(ctx);
  await pushBranch(ctx.repo, cwd, branch, sha, ctx.signal, budget);
  ctx.checkCancelled();
  const url = await createPullRequest(ctx.repo, {
    branch,
    base,
    title: `[needs human] ${ctx.run.title}`,
    body: report,
    cwd,
    draft: true,
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

async function deliver(ctx: RunContext, success: boolean): Promise<void> {
  ctx.checkCancelled();
  if (ctx.state.deliveryComplete) return;
  assertExistingBranchDelivery(ctx.repo, ctx.run);
  if (ctx.run.deliveryBranch && ctx.run.baseSha !== ctx.run.sourceRef?.headSha)
    throw new Error("PR delivery base does not match the verified webhook head");
  const deliverStage = async () => {
    const cwd = ctx.state.worktreePath as string;
    const budget = deliveryBudget(ctx);
    const runner = ctx.deps.gh ?? runGh;
    const gh: GhRunner = (args, signal) =>
      withGitHubRetry(async () => (await runner(args, signal)) ?? "", { budget, signal });
    if (
      success &&
      ctx.repo.kind === "github" &&
      !ctx.run.deliveryBranch &&
      (ctx.run.prUrl || ctx.store.listStages(ctx.run.id).filter((s) => s.name === "deliver").length > 1)
    ) {
      const raw = await gh(
        ctx.run.prUrl
          ? ["pr", "view", ctx.run.prUrl, "--repo", ctx.repo.slug, "--json", "state,url"]
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
      const pr = Array.isArray(data) ? data[0] : data;
      if (pr && typeof pr === "object" && "state" in pr && pr.state === "MERGED") {
        if (!("url" in pr) || typeof pr.url !== "string" || !pr.url)
          throw new Error("Merged PR lookup did not return a URL");
        ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: pr.url, merged: true });
        ctx.store.putArtifact(ctx.run.id, "report.md", "report", buildReport(ctx, true));
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
        ctx.store.putArtifact(ctx.run.id, "report.md", "report", buildReport(ctx, false));
        return { summary: "PR verification needs human review; no push", value: undefined };
      }
      if (!(await diffSince(cwd, ctx.state.verification.headSha)).files.length) {
        ctx.run = ctx.store.updateRun(ctx.run.id, {
          headSha: await headSha(cwd),
          prUrl: `https://github.com/${ctx.repo.slug}/pull/${ctx.run.sourceRef?.number}`,
        });
        const report = buildReport(ctx, true);
        ctx.store.putArtifact(ctx.run.id, "report.md", "report", report);
        if (!ctx.state.verdictCommentPosted) {
          const marker = `<!-- limitless-verification:${ctx.run.id} -->`;
          ctx.checkCancelled();
          const comments = [
            "api",
            `repos/${ctx.repo.slug}/issues/${ctx.run.sourceRef?.number}/comments`,
            "--paginate",
            "--jq",
            ".[].body",
          ];
          const comment = ["pr", "comment", String(ctx.run.sourceRef?.number), "--repo", ctx.repo.slug];
          await withGitHubRetry(
            async () => {
              // A pending post (an earlier attempt that failed late, or one whose checkpoint was
              // lost) may already exist remotely: look for its marker before posting again.
              if (ctx.state.verdictCommentPending && (await runner(comments, ctx.signal))?.includes(marker))
                return;
              ctx.state.verdictCommentPending = true;
              await ctx.save("verification-comment-pending");
              ctx.checkCancelled();
              await runner([...comment, "--body", `${marker}\n${report}`], ctx.signal);
            },
            { budget, signal: ctx.signal },
          );
          ctx.checkCancelled();
          ctx.state.verdictCommentPosted = true;
          await ctx.save("verification-comment-posted");
        }
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
        : await commitAll(cwd, `limitless: ${ctx.run.title}\n\nRun: ${ctx.run.id}`);
    const head = sha ?? (await headSha(cwd));
    ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: head });
    if (success && ctx.repo.kind === "github" && !ctx.run.deliveryBranch) {
      const baseBranch = ctx.run.baseBranch as string;
      const fetched = await fetchBase(ctx.deps.cfg.paths, ctx.repo, baseBranch, ctx.signal, budget);
      const recorded = ctx.run.baseSha as string;
      const note = (why: string) => {
        ctx.state.rebaseNote = `Not merged with the latest ${baseBranch}: ${why}. Delivered on ${(ctx.run.baseSha as string).slice(0, 8)}.`;
        ctx.store.addEvent({
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
    const report = buildReport(ctx, success);

    const publish = () => {
      ctx.store.putArtifact(ctx.run.id, "report.md", "report", report);
      if (ctx.state.holdout) {
        ctx.store.putArtifact(
          ctx.run.id,
          "holdout-scenarios.json",
          "holdout",
          JSON.stringify(ctx.state.holdout, null, 2),
        );
        for (const result of ctx.state.verifyResults ?? [])
          ctx.store.putArtifact(
            ctx.run.id,
            result.attempt === 1 ? `verify-${result.round}-retry.json` : `verify-${result.round}.json`,
            "verify",
            JSON.stringify(result, null, 2),
          );
      }
    };

    if (ctx.repo.kind !== "github") {
      publish();
      ctx.log(`Local repo: work is on branch ${ctx.run.branch}`);
      return { summary: `branch ${ctx.run.branch} ready in ${ctx.repo.localPath}`, value: undefined };
    }
    if (ctx.run.deliveryBranch) {
      publish();
      if (!success) return { summary: "PR update needs human review; no push", value: undefined };
      ctx.checkCancelled();
      if ((await remoteBranchSha(ctx.repo, cwd, ctx.run.deliveryBranch, ctx.signal, budget)) !== head)
        await pushExistingBranch(
          ctx.repo,
          cwd,
          ctx.run.deliveryBranch,
          ctx.run.baseSha as string,
          ctx.signal,
          budget,
        );
      if (ctx.run.sourceRef?.kind === "pull_request" && typeof ctx.run.sourceRef.number === "number") {
        ctx.run = ctx.store.updateRun(ctx.run.id, {
          prUrl: `https://github.com/${ctx.repo.slug}/pull/${ctx.run.sourceRef.number}`,
        });
      }
      ctx.state.deliveryComplete = true;
      await ctx.save("delivery-complete");
      return { summary: `updated existing PR branch ${ctx.run.deliveryBranch}`, value: undefined };
    }
    ctx.checkCancelled();
    await pushBranch(ctx.repo, cwd, ctx.run.branch as string, "HEAD", ctx.signal, budget);
    ctx.checkCancelled();
    const title = success ? ctx.run.title : `[needs human] ${ctx.run.title}`;
    const url = await createPullRequest(ctx.repo, {
      branch: ctx.run.branch as string,
      base: ctx.run.baseBranch as string,
      title,
      body: report,
      cwd,
      draft: !success,
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
      const outcome = await mergePullRequest(url, cwd, ctx.run.title, ctx.signal, budget);
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
    ctx.state.preRebaseGates = ctx.state.lastGates ?? [];
    ctx.state.preRebaseHead = head;
    await ctx.save();
  }
  const before = ctx.state.preRebaseHead;
  if (!before) throw new Error("Missing pre-merge HEAD");
  const conflicts = await prepareMerge(cwd, before, fetched);
  if (conflicts.length) {
    ctx.state.round++;
    ctx.state.conflictRound = ctx.state.round;
    ctx.state.completedChecks = undefined;
    ctx.state.implementationReadyRound = undefined;
    ctx.state.feedback = `The factory started a merge of base ${fetched}. Resolve the conflict markers in these files, preserving both intents; do not run Git (including staging or committing):\n${conflicts.map((p) => `- ${p}`).join("\n")}`;
    ctx.state.phase = "loop";
    ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: fetched, headSha: before }, ctx.state);
    return "conflict";
  }
  if ((await headSha(cwd)) === before) await completeMerge(cwd, before, fetched);
  await validateMerge(cwd, before, fetched);
  await mergeGit(cwd, ["reset", "--hard", "HEAD"]);
  await mergeGit(cwd, ["clean", "-fdq"]);
  const previous = ctx.state.preRebaseGates ?? [];
  try {
    await ctx.stage(
      "gates",
      async () => {
        const after = await runGates(cwd, ctx.state.gatesConfig as GateConfig, ctx.signal, gateEvents(ctx));
        ctx.checkCancelled();
        await mergeGit(cwd, ["reset", "--hard", "HEAD"]);
        await mergeGit(cwd, ["clean", "-fdq"]);
        // A check fixed by the implementation must stay fixed after merging, even when
        // it failed on the original base. Persist that regression in the evidence too.
        const comparison = compareGates(
          previous.length
            ? { setupOk: true, setup: [], checks: previous.map((c) => c.result) }
            : (ctx.state.baseline ?? null),
          after,
        );
        ctx.state.lastGates = comparison;
        await ctx.save();
        ctx.store.putArtifact(
          ctx.run.id,
          `gates-rebase-${ctx.state.round}.json`,
          "gates",
          JSON.stringify(comparison, null, 2),
        );
        const regressed =
          !after.setupOk ||
          comparison.some((c) => c.blocking) ||
          previous.some((c) => c.result.ok && !after.checks.find((r) => r.name === c.name)?.ok);
        if (regressed) throw new MergeRegressedError("post-merge gates regressed");
        return { summary: `${comparison.length} post-merge checks ok`, value: undefined };
      },
      ctx.state.round,
    );
  } catch (error) {
    if (!(error instanceof MergeRegressedError)) throw error;
    await mergeGit(cwd, ["reset", "--hard", before]);
    await mergeGit(cwd, ["clean", "-fdq"]);
    ctx.state.lastGates = previous;
    ctx.state.pendingRebaseSha = undefined;
    ctx.state.preRebaseGates = undefined;
    ctx.state.preRebaseHead = undefined;
    ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: await headSha(cwd) }, ctx.state);
    throw new NeedsHumanError(`post-merge gates regressed after merging onto ${fetched.slice(0, 8)}`);
  }
  await validateMerge(cwd, before, fetched);
  ctx.state.pendingRebaseSha = undefined;
  ctx.state.preRebaseGates = undefined;
  ctx.state.preRebaseHead = undefined;
  ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: fetched, headSha: await headSha(cwd) }, ctx.state);
  return "done";
}
