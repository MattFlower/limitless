import { readdirSync } from "node:fs";
import type { ResolvedProfile, RunStatus } from "../core/types.ts";
import { type AuditFinding, auditDiff } from "../gates/audit.ts";
import { detectGates, type GateConfig } from "../gates/detect.ts";
import { compareGates, runGates } from "../gates/run.ts";
import {
  commitAll,
  createPullRequest,
  createWorktree,
  diffSince,
  discardChanges,
  ensureCache,
  headSha,
  mergePullRequest,
  pushBranch,
  removeWorktree,
} from "../git/repos.ts";
import type { RouteConstraints } from "../router/router.ts";
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
  implementPrompt,
  reviewPrompt,
  specPrompt,
  triagePrompt,
  verifyPrompt,
} from "./prompts.ts";
import { buildReport } from "./report.ts";
import {
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
    if (ctx.state.phase === "prepare") await prepare(ctx);
    if (ctx.state.phase === "triage") await triage(ctx);
    if (ctx.state.phase === "clarify") await clarify(ctx);
    if (ctx.state.phase === "spec") await spec(ctx);
    if (ctx.state.phase === "loop") await buildLoop(ctx);
    if (ctx.state.phase === "deliver") await deliver(ctx, true);
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
    if (e instanceof NeedsHumanError && ctx.state.worktreePath) {
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
  await ctx.stage("prepare", async () => {
    const { cfg, store } = ctx.deps;
    await ensureCache(cfg.paths, ctx.repo);
    const base = ctx.run.baseBranch ?? ctx.repo.defaultBranch;
    const wt = await createWorktree(cfg.paths, ctx.repo, ctx.run.id, ctx.run.title, base);
    ctx.state.worktreePath = wt.path;
    ctx.run = store.updateRun(ctx.run.id, { baseBranch: base, baseSha: wt.baseSha, branch: wt.branch });
    const gates = detectGates(wt.path);
    ctx.state.gatesConfig = gates;
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
    return readdirSync(path)
      .filter((f) => f !== ".git")
      .slice(0, 60)
      .join("  ");
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
      requireStructured: true,
      maxToolCalls: 15,
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
  const maxRounds = Math.max(1, ctx.deps.cfg.maxRounds) + ROUNDS_PER_IMPLEMENTER;
  while (ctx.state.round < maxRounds) {
    ctx.checkCancelled();
    const round = ctx.state.round;
    const passed = await oneRound(ctx, round);
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
}

/** Returns true when every gate passes. */
async function oneRound(ctx: RunContext, round: number): Promise<boolean> {
  const cwd = ctx.state.worktreePath as string;
  const gates = ctx.state.gatesConfig as GateConfig;
  const baseSha = ctx.run.baseSha as string;

  // --- implement
  await ctx.stage(
    "implement",
    async (stage) => {
      const current = ctx.state.implementer;
      const escalate = current && ctx.state.roundsOnImplementer >= ROUNDS_PER_IMPLEMENTER;
      let constraints: RouteConstraints = current ? { prefer: current.modelId } : {};
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
        }),
      });
      ctx.state.implementer = { modelId: target.modelId, tier: target.tier, vendor: target.vendor };
      if (!ctx.state.triedImplementers.includes(target.modelId))
        ctx.state.triedImplementers.push(target.modelId);
      ctx.state.implementerReport = result.finalText;
      ctx.store.putArtifact(ctx.run.id, `implement-${round}.md`, "report", result.finalText || "(no report)");
      const sha = await commitAll(
        cwd,
        `limitless: ${ctx.run.title} (round ${round + 1})\n\nRun: ${ctx.run.id}`,
      );
      if (sha) ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: sha });
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
    ctx.state.feedback = [gateFeedback, auditFeedback].filter(Boolean).join("\n\n");
    ctx.save();
    ctx.log("Deterministic checks failed; sending feedback to implementer", "warn");
    return false;
  }

  // --- review (a different vendor than the implementer)
  const review: Review = await ctx.stage(
    "review",
    async (stage) => {
      const { result, target } = await ctx.invoke({
        role: "review",
        stage,
        mode: "readonly",
        complexity: profile(ctx) === "deep" ? "large" : ctx.complexity,
        constraints: { avoidVendor: ctx.state.implementer?.vendor },
        prompt: reviewPrompt({
          prompt: ctx.run.prompt,
          spec: ctx.state.spec ?? null,
          baseSha,
          stat: diff.stat,
          gates: comparison,
          audit,
          implementerReport: ctx.state.implementerReport ?? "",
        }),
        jsonSchema: toStrictJsonSchema(ReviewSchema),
        requireStructured: true,
      });
      await discardChanges(cwd);
      const r = ReviewSchema.parse(result.structured);
      const sameVendor = target.vendor === ctx.state.implementer?.vendor;
      if (sameVendor) ctx.log("Review done by the implementer's vendor (no other vendor available)", "warn");
      ctx.state.lastReview = { ...r, modelId: target.modelId };
      ctx.store.putArtifact(
        ctx.run.id,
        `review-${round}.json`,
        "review",
        JSON.stringify({ ...r, model: target.modelId }, null, 2),
      );
      const serious = r.findings.filter((f) => f.severity === "blocker" || f.severity === "major").length;
      return {
        summary: `${r.verdict} by ${target.modelId}: ${serious} blocking, ${r.findings.length - serious} minor`,
        value: r,
      };
    },
    round,
  );

  const reviewFeedback = review.verdict === "request_changes" ? formatReviewFeedback(review) : "";
  if (review.verdict === "request_changes") {
    ctx.state.feedback = reviewFeedback || `### Code review requested changes\n${review.summary}`;
    ctx.save();
    return false;
  }

  // --- verify acceptance criteria (standard/deep)
  if (profile(ctx) === "quick" || !ctx.state.spec?.acceptance_criteria.length) {
    ctx.state.lastVerify = null;
    return true;
  }
  const verify: Verify = await ctx.stage(
    "verify",
    async (stage) => {
      const { result, target } = await ctx.invoke({
        role: "verify",
        stage,
        mode: "readonly",
        complexity: ctx.complexity,
        constraints: { avoidVendor: ctx.state.implementer?.vendor },
        prompt: verifyPrompt({ prompt: ctx.run.prompt, spec: ctx.state.spec as Spec, baseSha }),
        jsonSchema: toStrictJsonSchema(VerifySchema),
        requireStructured: true,
      });
      await discardChanges(cwd);
      const v = VerifySchema.parse(result.structured);
      // Never trust "pass" if any criterion is not met.
      if (v.criteria.some((c) => c.status !== "met")) v.overall = "fail";
      ctx.state.lastVerify = { ...v, modelId: target.modelId };
      ctx.store.putArtifact(
        ctx.run.id,
        `verify-${round}.json`,
        "verify",
        JSON.stringify({ ...v, model: target.modelId }, null, 2),
      );
      const met = v.criteria.filter((c) => c.status === "met").length;
      return {
        summary: `${v.overall}: ${met}/${v.criteria.length} criteria met (${target.modelId})`,
        value: v,
      };
    },
    round,
  );
  if (verify.overall !== "pass") {
    ctx.state.feedback = formatVerifyFeedback(verify, ctx.state.spec ?? null);
    ctx.save();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// deliver

async function deliver(ctx: RunContext, success: boolean): Promise<void> {
  await ctx.stage("deliver", async () => {
    const cwd = ctx.state.worktreePath as string;
    const sha = await commitAll(cwd, `limitless: ${ctx.run.title}\n\nRun: ${ctx.run.id}`);
    const head = sha ?? (await headSha(cwd));
    ctx.run = ctx.store.updateRun(ctx.run.id, { headSha: head });
    const report = buildReport(ctx, success);
    ctx.store.putArtifact(ctx.run.id, "report.md", "report", report);

    if (ctx.repo.kind !== "github") {
      ctx.log(`Local repo: work is on branch ${ctx.run.branch}`);
      return { summary: `branch ${ctx.run.branch} ready in ${ctx.repo.localPath}`, value: undefined };
    }
    await pushBranch(ctx.repo, cwd, ctx.run.branch as string);
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
    ctx.log(`Pull request: ${url}`);
    if (!success) return { summary: `draft for human: ${url}`, value: undefined };

    const policy = ctx.state.gatesConfig?.merge ?? ctx.repo.mergePolicy;
    let summary = `PR ${url}`;
    if (policy === "auto") {
      const outcome = await mergePullRequest(url, cwd);
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

export type { RunState };
