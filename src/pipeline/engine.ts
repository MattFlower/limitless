import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertExistingBranchDelivery } from "../core/delivery.ts";
import type { ResolvedProfile, RunStatus } from "../core/types.ts";
import { type AuditFinding, auditDiff } from "../gates/audit.ts";
import { detectGates, type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import { compareGates, runGates } from "../gates/run.ts";
import {
  clearInterruptedRebase,
  commitAll,
  createPullRequest,
  createWorktree,
  diffSince,
  discardChanges,
  ensureCache,
  fetchBase,
  formatTopLevel,
  headSha,
  isAncestor,
  mergePullRequest,
  pushBranch,
  pushExistingBranch,
  readFileAt,
  rebaseOnto,
  removeWorktree,
  resetTo,
} from "../git/repos.ts";
import type { RouteConstraints } from "../router/router.ts";
import { formatTarget } from "../router/targets.ts";
import {
  CancelledError,
  type EngineDeps,
  NeedsHumanError,
  NoCapacityError,
  RunContext,
  type RunState,
} from "./context.ts";
import {
  formatAuditFeedback,
  formatGateFeedback,
  formatReviewFeedback,
  formatVerifyFeedback,
  holdoutPrompt,
  implementPrompt,
  redactHoldoutText,
  reviewPrompt,
  specPrompt,
  triagePrompt,
  verifyPrompt,
} from "./prompts.ts";
import { buildReport } from "./report.ts";
import { blockingReviewFindings, reviewFindingKey, reviewVerdict } from "./review.ts";
import {
  type Holdout,
  HoldoutSchema,
  LaterReviewSchema,
  type Review,
  ReviewSchema,
  renderSpec,
  type Spec,
  SpecSchema,
  TriageSchema,
  toStrictJsonSchema,
  type Verify,
  VerifySchema,
} from "./schemas.ts";
import { blockedOnly, ENVIRONMENT_BLOCKED, normalizeVerify } from "./verification.ts";

const ROUNDS_PER_IMPLEMENTER = 2;

/** Execute (or resume) one run to completion. Never throws. */
export async function executeRun(deps: EngineDeps, runId: string, signal: AbortSignal): Promise<RunStatus> {
  const run = deps.store.getRun(runId);
  if (!run) return "failed";
  const repo = deps.store.getRepo(run.repoId);
  if (!repo) {
    deps.store.updateRun(runId, { status: "failed", error: "repo not found", finishedAt: Date.now() });
    return "failed";
  }
  const ctx = new RunContext(deps, run, repo, signal);
  ctx.run = deps.store.updateRun(runId, {
    status: "running",
    error: null,
    ...(run.startedAt ? {} : { startedAt: Date.now() }),
  });
  if (ctx.state.phase !== "prepare") ctx.log(`Resuming at phase "${ctx.state.phase}"`, "warn");

  try {
    // Recheck persisted provenance on resume, including runs created before this guard existed.
    assertExistingBranchDelivery(ctx.repo, ctx.run);
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
    ctx.setPhase("done");
    ctx.run = deps.store.updateRun(runId, { status: "succeeded", stage: null, finishedAt: Date.now() });
    ctx.log("Run succeeded");
    return "succeeded";
  } catch (e) {
    if (e instanceof CancelledError || signal.aborted) {
      deps.store.updateRun(runId, { status: "cancelled", finishedAt: Date.now() });
      ctx.log("Run cancelled", "warn");
      return "cancelled";
    }
    const needsHuman = e instanceof NeedsHumanError || e instanceof NoCapacityError;
    const message = (e as Error).message;
    ctx.log(`Run ${needsHuman ? "needs a human" : "failed"}: ${message}`, "error", {
      stack: (e as Error).stack,
    });
    if (
      e instanceof NeedsHumanError &&
      ctx.state.worktreePath &&
      ctx.state.conflictRound === undefined &&
      !ctx.state.pendingRebaseSha
    ) {
      // Surface the unfinished work as a draft PR so a human can pick it up.
      try {
        await deliver(ctx, false);
      } catch (err) {
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

async function prepare(ctx: RunContext): Promise<void> {
  assertExistingBranchDelivery(ctx.repo, ctx.run);
  await ctx.stage("prepare", async () => {
    const { cfg, store } = ctx.deps;
    await ensureCache(cfg.paths, ctx.repo);
    const base = ctx.run.baseBranch ?? ctx.repo.defaultBranch;
    const wt = await createWorktree(cfg.paths, ctx.repo, ctx.run.id, ctx.run.title, base);
    if (ctx.run.deliveryBranch && ctx.run.sourceRef?.headSha !== wt.baseSha)
      throw new Error("PR head moved before preparation");
    ctx.state.worktreePath = wt.path;
    ctx.run = store.updateRun(ctx.run.id, { baseBranch: base, baseSha: wt.baseSha, branch: wt.branch });
    const gates = detectGates(wt.path);
    ctx.state.gatesConfig = gates;
    ctx.state.baselineScripts = pickScripts(readPackageJson(wt.path), gateScriptNames(gates));
    ctx.log(
      `Gates (${gates.source}): ${[...gates.setup, ...gates.checks.map((c) => c.run)].join(" | ") || "none"}`,
    );
    ctx.state.baseline =
      gates.setup.length || gates.checks.length ? await runGates(wt.path, gates, ctx.signal) : null;
    ctx.checkCancelled();
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
    }
    ctx.setPhase("triage");
    const failing = baseline ? baseline.checks.filter((c) => !c.ok).map((c) => c.name) : [];
    return {
      summary: `worktree ${wt.branch}; ${gates.checks.length} checks${failing.length ? `, failing on base: ${failing.join(", ")}` : ""}`,
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
    const { result, target } = await ctx.invoke({
      role: "triage",
      stage,
      mode: "readonly",
      complexity: "small",
      prompt: triagePrompt({
        repoSlug: ctx.repo.slug,
        prompt: ctx.run.prompt,
        tree: topLevel(ctx.state.worktreePath as string),
      }),
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
    const questions = profile !== "quick" && t.ambiguity === "high" ? t.blocking_questions : [];
    if (questions.length) {
      for (const q of questions) ctx.store.askQuestion(ctx.run.id, q);
      ctx.setPhase("clarify");
    } else {
      ctx.setPhase(profile === "quick" ? "loop" : "spec");
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
    ctx.setPhase(ctx.run.resolvedProfile === "quick" ? "loop" : "spec");
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
      ctx.save();
      await waitForAnswers(ctx);
      ctx.state.answers = ctx.store
        .listQuestions(ctx.run.id)
        .map((q) => `Q: ${q.question}\n  A: ${q.answer}`);
      s.assumptions.push(...ctx.state.answers);
    }
    ctx.state.spec = s;
    ctx.state.specAuthorVendor = target.vendor;
    ctx.setPhase("loop");
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
  const maxRounds =
    ctx.state.conflictRound !== undefined
      ? ctx.state.conflictRound + 1
      : Math.max(1, ctx.deps.cfg.maxRounds) + ROUNDS_PER_IMPLEMENTER;
  const holdout =
    profile(ctx) === "quick" || ctx.state.holdoutStatus === "complete"
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
        ctx.setPhase("deliver");
        return;
      }
      ctx.state.round++;
      ctx.state.roundsOnImplementer++;
      ctx.save();
    }
    throw new NeedsHumanError(
      `Still failing after ${ctx.state.round} implementation rounds. Last feedback:\n${ctx.state.feedback ?? ""}`,
    );
  } finally {
    if (holdout) await holdout;
  }
}

async function authorHoldout(ctx: RunContext): Promise<void> {
  await ctx.stage(
    "holdout",
    async (stage) => {
      ctx.state.holdoutStatus = "generating";
      ctx.save();
      const { result, target } = await ctx.invoke({
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
        isolatedCwd: true,
        noTools: true,
        maxToolCalls: 0,
      });
      ctx.state.holdout = HoldoutSchema.parse(result.structured);
      ctx.state.holdoutModelId = target.modelId;
      ctx.state.holdoutSameVendor = target.vendor === ctx.state.specAuthorVendor;
      ctx.state.holdoutStatus = "complete";
      ctx.save();
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
  await ctx.stage(
    "implement",
    async (stage) => {
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
          options.find((c) => ctx.deps.router.route("implement", ctx.complexity, c).candidates.length) ?? {};
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
          baseSha,
          round,
          feedback: ctx.state.feedback,
          hasHoldout: profile(ctx) !== "quick",
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
      ctx.store.putArtifact(ctx.run.id, `implement-${round}.md`, "report", result.finalText || "(no report)");
      const sha = await commitAll(
        cwd,
        `limitless: ${ctx.run.title} (round ${round + 1})\n\nRun: ${ctx.run.id}`,
      );
      if (sha) ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: sha });
      ctx.save();
      ctx.state.implementerIssue =
        result.status === "ok"
          ? null
          : `${result.status}${result.error ? `: ${result.error}` : ""}`.slice(0, 500);
      ctx.state.implementedRound = round;
      ctx.save();
      if (result.status !== "ok") {
        ctx.log(`Implementer ended with ${result.status}: ${result.error ?? ""}`, "warn");
      }
      return {
        summary: `${target.modelId}: ${result.status}${sha ? `, committed ${sha.slice(0, 8)}` : ", no changes"}`,
        value: undefined,
      };
    },
    round,
  );
}

/** Returns true when every gate passes. */
async function oneRound(
  ctx: RunContext,
  round: number,
  holdout: Promise<Error | null> | null,
): Promise<boolean> {
  const cwd = ctx.state.worktreePath as string;
  const gates = ctx.state.gatesConfig as GateConfig;
  const baseSha = ctx.run.baseSha as string;

  // --- implement (skipped when resuming a round whose implementation already landed)
  if (ctx.state.implementedRound !== round) await implementStage(ctx, round);

  // --- gates
  const comparison = await ctx.stage(
    "gates",
    async () => {
      const after = await runGates(cwd, gates, ctx.signal, (r) =>
        ctx.store.addEvent({
          runId: ctx.run.id,
          type: "gate",
          level: r.ok ? "info" : "warn",
          message: `${r.name}: ${r.ok ? "pass" : "FAIL"} (${Math.round(r.durationMs / 1000)}s)`,
          data: r,
        }),
      );
      ctx.checkCancelled();
      // Gates may have produced files (build output, formatter fixes); don't let them leak into the diff.
      await discardChanges(cwd);
      const cmp = compareGates(ctx.state.baseline ?? null, after);
      ctx.state.lastGates = cmp;
      ctx.store.putArtifact(ctx.run.id, `gates-${round}.json`, "gates", JSON.stringify(cmp, null, 2));
      const blocking = cmp.filter((c) => c.blocking).map((c) => c.name);
      return {
        summary: blocking.length ? `blocking: ${blocking.join(", ")}` : `${cmp.length} checks ok`,
        value: cmp,
      };
    },
    round,
  );

  // --- audit
  const diff = await diffSince(cwd, baseSha);
  const audit: AuditFinding[] = await ctx.stage(
    "audit",
    async () => {
      const findings = auditDiff(diff, {
        taskClass: ctx.run.taskClass,
        protectedPaths: gates.protectedPaths,
        toolCommands: ctx.state.toolCommands,
        gateScripts: {
          before: ctx.state.baselineScripts ?? {},
          after: pickScripts(readPackageJson(cwd), gateScriptNames(gates)),
        },
      });
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
    ctx.save();
    ctx.log("Deterministic checks failed; sending feedback to implementer", "warn");
    return false;
  }

  // --- review (a different vendor than the implementer)
  if (ctx.state.lastReview && !ctx.state.reviewHistory?.length)
    throw new NeedsHumanError("Previous review has no round history; cannot classify later findings");
  const earlierReviews = (ctx.state.reviewHistory ?? []).filter((entry) => entry.round < round);
  const priorReview = earlierReviews.at(-1);
  const previousReview = priorReview ? { sha: priorReview.sha, findings: priorReview.blocking } : undefined;
  const reviewedSha = await headSha(cwd);
  const review: Review = await ctx.stage(
    "review",
    async (stage) => {
      const { result, target } = await ctx.invoke({
        role: "review",
        stage,
        mode: "readonly",
        complexity: profile(ctx) === "deep" ? "large" : ctx.complexity,
        constraints: { avoidVendor: ctx.state.implementer?.vendor },
        timeoutMs: readingTimeout(diff.added + diff.removed),
        prompt: reviewPrompt({
          prompt: ctx.run.prompt,
          spec: ctx.state.spec ?? null,
          baseSha,
          stat: diff.stat,
          gates: comparison,
          audit,
          implementerReport: ctx.state.implementerReport ?? "",
          previous: previousReview,
          headSha: reviewedSha,
        }),
        jsonSchema: toStrictJsonSchema(previousReview ? LaterReviewSchema : ReviewSchema),
        schema: previousReview ? LaterReviewSchema : ReviewSchema,
        requireStructured: true,
      });
      await discardChanges(cwd);
      const parsed: Review = (previousReview ? LaterReviewSchema : ReviewSchema).parse(result.structured);
      // The model's verdict is kept for inspection only; control flow uses the derived one.
      const modelVerdict = parsed.verdict;
      const r: Review = { ...parsed, verdict: reviewVerdict(parsed, previousReview?.findings) };
      const blocking = blockingReviewFindings(r, previousReview?.findings);
      const followUps = previousReview ? r.findings.filter((f) => !blocking.includes(f)) : [];
      ctx.state.reviewHistory = [...earlierReviews, { round, sha: reviewedSha, blocking, followUps }];
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
      ctx.save();
      ctx.store.putArtifact(
        ctx.run.id,
        `review-${round}.json`,
        "review",
        JSON.stringify({ ...r, modelVerdict, model: target.modelId, round, reviewedSha, blocking }, null, 2),
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
      ? formatReviewFeedback(blockingReviewFindings(review, previousReview?.findings))
      : "";
  if (review.verdict === "request_changes") {
    ctx.state.feedback = reviewFeedback || `### Code review requested changes\n${review.summary}`;
    ctx.save();
    return false;
  }

  // --- verify acceptance criteria (standard/deep)
  if (profile(ctx) === "quick") {
    ctx.state.lastVerify = null;
    return true;
  }
  if (holdout) {
    const failure = await holdout;
    if (failure) throw failure;
  }
  if (!ctx.state.holdout) throw new NeedsHumanError("Holdout scenarios are unavailable");
  const verifyAttempt = async (attempt: number, excludeModels: string[] = []): Promise<Verify> =>
    ctx.stage(
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
        );
        ctx.state.lastVerify = { ...v, modelId: target.modelId };
        ctx.state.verifyResults = [
          ...(ctx.state.verifyResults ?? []),
          { ...v, modelId: target.modelId, round, attempt },
        ];
        ctx.save();
        const publicSources = await ctx.publicHoldoutSources();
        ctx.store.putArtifact(
          ctx.run.id,
          attempt === 0 ? `verify-${round}.json` : `verify-${round}-retry.json`,
          "verify",
          JSON.stringify(
            { ...v, modelId: target.modelId, round, attempt },
            (_key, value: unknown) =>
              typeof value === "string"
                ? redactHoldoutText(value, ctx.state.holdout as Holdout, publicSources)
                : value,
            2,
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
  const previous = (ctx.state.verifyResults ?? []).filter((v) => v.round === round);
  let verify = previous.at(-1) ?? (await verifyAttempt(0));
  const publicSources = await ctx.publicHoldoutSources();
  if (blockedOnly(verify)) {
    const stop = (routing = ""): never => {
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
      ctx.save();
      throw new NeedsHumanError(detail);
    };
    if (ctx.state.environmentRetryRound === round || previous.some((v) => v.attempt === 1)) stop();
    ctx.state.environmentRetryRound = round;
    ctx.save();
    const firstModel = ctx.state.lastVerify?.modelId;
    try {
      verify = await verifyAttempt(1, firstModel ? [firstModel] : []);
    } catch (error) {
      if (error instanceof NoCapacityError) stop(error.message);
      throw error;
    }
    if (blockedOnly(verify)) stop();
  }
  if (verify.overall !== "pass") {
    ctx.state.feedback = formatVerifyFeedback(
      verify,
      ctx.state.spec ?? null,
      ctx.state.holdout,
      publicSources,
    );
    ctx.save();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// deliver

async function deliver(ctx: RunContext, success: boolean): Promise<void> {
  assertExistingBranchDelivery(ctx.repo, ctx.run);
  if (ctx.run.deliveryBranch && ctx.run.baseSha !== ctx.run.sourceRef?.headSha)
    throw new Error("PR delivery base does not match the verified webhook head");
  await ctx.stage("deliver", async () => {
    const cwd = ctx.state.worktreePath as string;
    await clearInterruptedRebase(cwd, Boolean(ctx.state.pendingRebaseSha));
    // A stopped post-rebase check may have left generated files or formatter edits behind.
    if (ctx.state.pendingRebaseSha) await discardChanges(cwd);
    const sha = await commitAll(cwd, `limitless: ${ctx.run.title}\n\nRun: ${ctx.run.id}`);
    const head = sha ?? (await headSha(cwd));
    ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: head });
    if (success && ctx.repo.kind === "github" && !ctx.run.deliveryBranch) {
      const baseBranch = ctx.run.baseBranch as string;
      const fetched = await fetchBase(ctx.deps.cfg.paths, ctx.repo, baseBranch);
      const recorded = ctx.run.baseSha as string;
      // A restart can find the base moved again mid-rebase; retarget the newest tip.
      if (ctx.state.pendingRebaseSha && ctx.state.pendingRebaseSha !== fetched) {
        ctx.state.pendingRebaseSha = fetched;
        ctx.save();
      }
      // Rebasing is best-effort: it avoids conflicting PRs, but never blocks delivering work that
      // passed every gate on its recorded base.
      const note = (why: string) => {
        ctx.state.rebaseNote = `Not rebased onto the latest ${baseBranch}: ${why}. Delivered on ${(ctx.run.baseSha as string).slice(0, 8)}.`;
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
        else if ((await rebaseForDelivery(ctx, cwd, baseBranch, fetched, head, note)) === "conflict")
          return { summary: `rebase conflicted; resolution round ${ctx.state.round}`, value: undefined };
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
      if (!success) return { summary: "PR update needs human review; no push", value: undefined };
      ctx.checkCancelled();
      await pushExistingBranch(ctx.repo, cwd, ctx.run.deliveryBranch, ctx.run.baseSha as string);
      if (ctx.run.sourceRef?.kind === "pull_request" && typeof ctx.run.sourceRef.number === "number") {
        ctx.run = ctx.store.updateRun(ctx.run.id, {
          prUrl: `https://github.com/${ctx.repo.slug}/pull/${ctx.run.sourceRef.number}`,
        });
      }
      await removeWorktree(ctx.deps.cfg.paths, ctx.repo, cwd);
      return { summary: `updated existing PR branch ${ctx.run.deliveryBranch}`, value: undefined };
    }
    ctx.checkCancelled();
    await pushBranch(ctx.repo, cwd, ctx.run.branch as string);
    ctx.checkCancelled();
    const title = success ? ctx.run.title : `[needs human] ${ctx.run.title}`;
    const url = await createPullRequest(ctx.repo, {
      branch: ctx.run.branch as string,
      base: ctx.run.baseBranch as string,
      title,
      body: report,
      cwd,
      draft: !success,
    });
    ctx.run = ctx.store.updateRun(ctx.run.id, { prUrl: url });
    publish();
    ctx.log(`Pull request: ${url}`);
    if (!success) return { summary: `draft for human: ${url}`, value: undefined };

    const policy = ctx.state.gatesConfig?.merge ?? ctx.repo.mergePolicy;
    let summary = `PR ${url}`;
    if (policy === "auto") {
      ctx.checkCancelled();
      const outcome = await mergePullRequest(url, cwd, ctx.run.title);
      if (outcome === "merged") ctx.run = ctx.store.updateRun(ctx.run.id, { merged: true });
      summary += ` — ${outcome === "merged" ? "merged" : outcome === "auto" ? "auto-merge enabled" : "merge failed (left open)"}`;
      ctx.log(summary, outcome === "failed" ? "warn" : "info");
    } else {
      summary += ` — left open (merge policy: ${policy})`;
    }
    await removeWorktree(ctx.deps.cfg.paths, ctx.repo, cwd);
    return { summary, value: undefined };
  });
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

class RebaseRegressedError extends Error {}

/**
 * Rebase the run branch onto the base's new tip and re-run the gates. A conflict schedules one
 * resolution round ("conflict"); a regression restores the pre-rebase head, which passed every gate
 * on its recorded base, and notes why it was not rebased.
 */
async function rebaseForDelivery(
  ctx: RunContext,
  cwd: string,
  baseBranch: string,
  fetched: string,
  head: string,
  note: (why: string) => void,
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
    ctx.save();
  }
  if (!(await isAncestor(cwd, fetched, await headSha(cwd)))) {
    const outcome = await rebaseOnto(cwd, fetched);
    if (outcome === "conflict") {
      ctx.state.preRebaseHead = undefined;
      ctx.state.pendingRebaseSha = undefined;
      ctx.state.preRebaseGates = undefined;
      ctx.state.round++;
      ctx.state.conflictRound = ctx.state.round;
      ctx.state.feedback = `The base branch advanced. Merge origin/${baseBranch} into this branch with \`git merge origin/${baseBranch}\`, resolve conflicts preserving both intents, and rerun the repository checks.`;
      ctx.state.phase = "loop";
      ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: fetched, headSha: await headSha(cwd) }, ctx.state);
      return "conflict";
    }
  }
  const previous = ctx.state.preRebaseGates ?? [];
  try {
    await ctx.stage(
      "gates",
      async () => {
        const after = await runGates(cwd, ctx.state.gatesConfig as GateConfig, ctx.signal, (r) =>
          ctx.store.addEvent({
            runId: ctx.run.id,
            type: "gate",
            level: r.ok ? "info" : "warn",
            message: `${r.name}: ${r.ok ? "pass" : "FAIL"} (${Math.round(r.durationMs / 1000)}s)`,
            data: r,
          }),
        );
        ctx.checkCancelled();
        await discardChanges(cwd);
        // A check fixed by the implementation must stay fixed after rebasing, even when
        // it failed on the original base. Persist that regression in the evidence too.
        const comparison = compareGates(
          previous.length
            ? { setupOk: true, setup: [], checks: previous.map((c) => c.result) }
            : (ctx.state.baseline ?? null),
          after,
        );
        ctx.state.lastGates = comparison;
        ctx.save();
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
        if (regressed) throw new RebaseRegressedError("post-rebase gates regressed");
        return { summary: `${comparison.length} post-rebase checks ok`, value: undefined };
      },
      ctx.state.round,
    );
  } catch (error) {
    if (!(error instanceof RebaseRegressedError)) throw error;
    await resetTo(cwd, ctx.state.preRebaseHead ?? head);
    ctx.state.lastGates = previous;
    ctx.state.pendingRebaseSha = undefined;
    ctx.state.preRebaseGates = undefined;
    ctx.state.preRebaseHead = undefined;
    ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: await headSha(cwd) }, ctx.state);
    note(`checks regressed after rebasing onto ${fetched.slice(0, 8)}`);
    ctx.save();
    return "done";
  }
  ctx.state.pendingRebaseSha = undefined;
  ctx.state.preRebaseGates = undefined;
  ctx.state.preRebaseHead = undefined;
  ctx.run = ctx.store.updateRun(ctx.run.id, { baseSha: fetched, headSha: await headSha(cwd) }, ctx.state);
  return "done";
}
