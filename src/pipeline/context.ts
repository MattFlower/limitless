import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { Config } from "../config.ts";
import type {
  Complexity,
  Invocation,
  ModelSelection,
  Repo,
  RepoReviewLens,
  ReviewSystem,
  Role,
  Run,
  RunEvent,
  RunRole,
  Stage,
  StageName,
} from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { AuditFinding } from "../gates/audit.ts";
import type { GateConfig } from "../gates/detect.ts";
import type { GateComparison, GateRun } from "../gates/run.ts";
import { worktreeGit } from "../git/command.ts";
import { discardChanges, headSha } from "../git/repos.ts";
import type { DecisionTask } from "../harness/decisions.ts";
import { withScratch } from "../harness/scratch.ts";
import { selectHarness } from "../harness/select.ts";
import { parseFakeStream } from "../harness/stream-fault.ts";
import type { AgentEvent, AgentResult, AgentSpec, Harness, ModelTarget } from "../harness/types.ts";
import type { GhRunner } from "../integrations/github.ts";
import type { ProviderTracker } from "../router/providers.ts";
import type { RouteConstraints, RouteDecision, Router } from "../router/router.ts";
import { formatTarget, recordEffort } from "../router/targets.ts";
import { redactCredentialData } from "../util/proc.ts";
import { type FaultInjector, type FaultPlan, injectorFor, SimulatedTermination } from "./faults.ts";
import type { GateEvidence } from "./gate-evidence.ts";
import type { PreviewConfig } from "./preview.ts";
import { FACTORY_PREAMBLE, redactHoldoutText } from "./prompts.ts";
import type { Holdout, Review, ReviewScope, Spec, Triage, Verify } from "./schemas.ts";
import { renderSpec } from "./schemas.ts";

export interface EngineDeps {
  confinement?: import("../harness/sandbox.ts").ConfinementBackend;
  faults?: FaultPlan;
  gh?: GhRunner;
  cfg: Config;
  store: Store;
  /** Limitless build (git SHA), part of the baseline cache key; unknown disables the cache. */
  buildSha?: string;
  router: Router;
  tracker: ProviderTracker;
  harnesses: Record<string, Harness>;
  /** Overrides the production review system (`single`, from `[review]`); tests run panels this way. */
  reviewSystem?: ReviewSystem;
}

export type Phase = "prepare" | "triage" | "clarify" | "spec" | "loop" | "deliver" | "done";

/** Everything a run needs to resume after a restart. Persisted as runs.state_json. */
export interface RunState {
  parked?: boolean;
  flow?: "build" | "verify-change";
  verification?: { baseSha: string; headSha: string; initialComplete?: boolean };
  /** A review round's chosen base tip, saved before it is merged into the PR branch. */
  reviewBaseSha?: string;
  verdictCommentPosted?: boolean;
  verdictCommentPending?: boolean;
  phase: Phase;
  worktreePath?: string;
  gatesConfig?: GateConfig;
  previewConfig?: PreviewConfig | null;
  /** `[review] lenses` from the base commit, read at prepare in panel mode only (else single stays). */
  reviewLenses?: RepoReviewLens[];
  /** The shadow panel's base lenses, read at prepare with `[review] shadow = "panel"`, or why they could not be. */
  shadowLenses?: RepoReviewLens[] | { error: string };
  baseline?: GateRun | null;
  /** The baseline came from the per-base-commit cache instead of executing at prepare. */
  baselineCached?: boolean;
  triage?: Triage;
  spec?: Spec | null;
  specAuthorVendor?: string;
  holdout?: Holdout;
  holdoutStatus?: "generating" | "complete";
  holdoutModelId?: string;
  holdoutSameVendor?: boolean;
  answers: string[];
  round: number;
  implementer?: {
    policyRevision?: string;
    targetId?: string;
    effort?: ModelSelection["effort"];
    modelId: string;
    tier: number;
    vendor: string;
  };
  roundsOnImplementer: number;
  triedImplementers: (string | ModelSelection)[];
  implementerReport?: string;
  /** Why the last implementer session ended badly (timeout, loop, error), fed back next round. */
  implementerIssue?: string | null;
  /** Round whose implementation has been committed; resuming skips straight to its checks. */
  implementedRound?: number;
  implementationReadyRound?: number;
  completedChecks?: { round: number; sha?: string; values: Partial<Record<StageName, unknown>> };
  deliveryComplete?: boolean;
  /** Pinned delivery merge target (legacy field name); gates must pass before this becomes run.baseSha. */
  pendingRebaseSha?: string;
  preRebaseGates?: GateComparison[];
  /** Expected first merge parent; also the fallback head if clean-merge gates regress. */
  preRebaseHead?: string;
  /** Commit that last passed verify, or an approving quick review after deterministic checks. */
  lastVerifiedSha?: string;
  /** Passing evidence retained if a later resolution round fails; panel runs keep the review history with it. */
  lastVerifiedEvidence?: Pick<
    RunState,
    "lastVerify" | "lastGates" | "lastReview" | "lastAudit" | "reviewHistory"
  >;
  /** Why delivery went ahead without rebasing onto the latest base (shown in the report). */
  rebaseNote?: string;
  /** The single extra implementation round allowed after a conflicting delivery merge. */
  conflictRound?: number;
  /** package.json scripts the gates depend on, as they were on the base branch. */
  baselineScripts?: Record<string, string>;
  feedback: string | null;
  lastGates?: GateComparison[];
  gateEvidence?: GateEvidence;
  gateTimeoutReruns?: number;
  lastAudit?: AuditFinding[];
  lastReview?: Review & { modelId: string };
  reviewedSha?: string;
  /** Replace a replayed round; earlier entries remain the source of review context. */
  reviewHistory?: {
    round: number;
    sha: string;
    blocking: Review["findings"];
    followUps: Review["findings"];
    /** Panel only: which review (1-3) this was; counted apart from implementation rounds. Absent for a conflict-resolution review. */
    panelReview?: number;
    /** Panel only: the diff this review covered. */
    scope?: ReviewScope;
  }[];
  reviewFollowUps?: Review["findings"];
  lastVerify?: (Verify & { modelId: string }) | null;
  verifyResults?: (Verify & {
    modelId: string;
    round: number;
    attempt?: number;
    sha?: string;
    /** Parsed verifier output, before engine substitution; retained privately for restart. */
    modelOutput?: Verify;
  })[];
  /** Round whose retry is reserved; a restart resumes it, and a recorded attempt 1 ends retrying. */
  environmentRetryRound?: number;
  terminalReason?: string;
  /** Verdict awaiting its draft PR; a restart resumes that delivery instead of re-entering the loop. */
  needsHumanReason?: string;
  toolCommands: string[];
}

const MODEL_REJECTED =
  /model[^.]{0,80}(is not supported|not found|does not exist|not available)|unknown model|invalid model|model_not_found/i;
const MAX_PUBLIC_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_SOURCE_FILES = 2_000;

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Stages after gates within a round: a round runs through them before a drain can park it. */
const UNPARKABLE: ReadonlySet<StageName> = new Set<StageName>(["audit", "review", "preview", "verify"]);

export class ParkedError extends Error {
  constructor() {
    super("parked for deploy");
  }
}

export class NeedsHumanError extends Error {}

export class NoCapacityError extends Error {}

/** A production call took this shadow call's provider slot. */
export class Preempted extends NoCapacityError {
  constructor() {
    super("preempted");
  }
}

/** Shadow work carries its own cancellation, checkout and invocation ledger. */
export const invokeGuard = new AsyncLocalStorage<{
  stop(p: string): string | undefined;
  ids: number[];
  signal: AbortSignal;
  cwd?: string;
}>();

export interface InvokeOptions {
  role: Role;
  stage: Stage;
  prompt: string;
  mode: "edit" | "readonly";
  complexity: Complexity;
  constraints?: RouteConstraints;
  jsonSchema?: Record<string, unknown>;
  systemAppend?: string;
  timeoutMs?: number;
  /** Epoch ms by which the whole call ends, slot waits and fallbacks included; then NoCapacityError. */
  deadline?: number;
  idleTimeoutMs?: number;
  maxToolCalls?: number;
  /** Retry a failed structured-output call once on the next candidate. */
  requireStructured?: boolean;
  /** Validates structured output; invalid output counts as a failed call (next candidate). */
  schema?: ZodType;
  /** No public or raw output: events are dropped and the CLI log keeps only its structure. */
  privateOutput?: boolean;
  /** Prevent the CLI from persisting a private prompt in its own session store. */
  privateSession?: boolean;
  /** Redact holdout content from observable verifier events and transcripts. */
  redactHoldout?: boolean;
  /** Run in this directory instead of the worktree (e.g. a base-commit snapshot). */
  cwd?: string;
  /** Paths a tool-enabled reader must not read (see AgentSpec.denyRead). */
  denyRead?: string[];
  /** Tools read only the cwd and scratch (see AgentSpec.confineReads). */
  confineReads?: boolean;
  noTools?: boolean;
  /** Typed questions for decision models; a decline falls through to the next candidate. */
  decisionTask?: DecisionTask;
  shadow?: ReturnType<typeof invokeGuard.getStore>;
}

export interface InvokeOutcome {
  result: AgentResult;
  target: ModelTarget;
  invocation: Invocation;
}

/** Every string in a private CLI log line; numbers, booleans and the JSON shape remain. */
export const withholdText = (text: string): string => (text ? "[private]" : text);

const DEFAULT_TIMEOUTS: Record<Role, number> = {
  triage: 5 * 60_000,
  summarize: 5 * 60_000,
  chat: 5 * 60_000,
  spec: 15 * 60_000,
  plan: 20 * 60_000,
  plan_review: 15 * 60_000,
  holdout: 15 * 60_000,
  implement: 60 * 60_000,
  review: 20 * 60_000,
  verify: 25 * 60_000,
};

export class RunContext {
  private readonly interruption = new AbortController();
  readonly signal: AbortSignal;
  termination?: SimulatedTermination;
  private readonly stageContext = new AsyncLocalStorage<Stage>();
  private readonly faults: FaultInjector;
  private holdoutPublicSources?: { round: number; sources: Promise<string> };
  private foregroundStageDepth = 0;
  private readonly pinnedStages = new Map<number, string[]>();
  readonly runDir: string;
  previewUrl?: string;
  state: RunState;

  get freeFirstRouting(): boolean {
    return this.run.requestedBy === "dependabot[bot]" && this.deps.cfg.dependabotRouting === "free_first";
  }

  routingConstraints(constraints: RouteConstraints = {}): RouteConstraints {
    return this.freeFirstRouting
      ? { ...constraints, billing: constraints.billing ?? "free_first" }
      : constraints;
  }

  constructor(
    readonly deps: EngineDeps,
    public run: Run,
    readonly repo: Repo,
    signal: AbortSignal,
    readonly isDraining: () => boolean = () => false,
    readonly drainEvents?: EventTarget,
  ) {
    this.signal = AbortSignal.any([signal, this.interruption.signal]);
    this.faults = injectorFor(deps.faults);
    this.runDir = join(deps.cfg.paths.runs, run.id);
    mkdirSync(this.runDir, { recursive: true });
    this.state = deps.store.getRunState<RunState>(run.id) ?? {
      flow: run.sourceRef?.kind === "pull_request" ? "verify-change" : "build",
      phase: "prepare",
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    };
  }

  get store(): Store {
    return this.deps.store;
  }

  get complexity(): Complexity {
    return this.state.triage?.complexity ?? this.run.complexity ?? "small";
  }

  publicHoldoutSources(): Promise<string> {
    // Each implementation round may add identifiers that are now safe to show in feedback.
    if (this.holdoutPublicSources?.round !== this.state.round) {
      this.holdoutPublicSources = {
        round: this.state.round,
        sources: this.readPublicHoldoutSources(),
      };
    }
    return this.holdoutPublicSources.sources;
  }

  private async readPublicHoldoutSources(): Promise<string> {
    // Platform error names are public diagnostics, including on environment-blocked checks.
    const identifiers = new Set<string>(Object.keys(constants.errno));
    const cwd = this.state.worktreePath;
    if (cwd) {
      try {
        const { stdout } = await worktreeGit(["git", "ls-files", "-z"], { cwd });
        const files = stdout.split("\0").filter(Boolean);
        let bytesRead = 0;
        for (const file of files.slice(0, MAX_PUBLIC_SOURCE_FILES)) {
          try {
            const path = join(cwd, file);
            const stat = await lstat(path);
            if (!stat.isFile() || stat.size > 256_000) continue;
            if (bytesRead + stat.size > MAX_PUBLIC_SOURCE_BYTES) break;
            bytesRead += stat.size;
            const content = await readFile(path, "utf8");
            if (content.includes("\0")) continue;
            for (const identifier of `${file} ${content}`.match(/[A-Za-z_$][\w$]*/g) ?? [])
              identifiers.add(identifier);
          } catch {
            // A tracked path can disappear while the verifier is running.
          }
        }
      } catch {
        // Request and specification still provide the public-source exemption.
      }
    }
    return [this.run.prompt, this.state.spec ? renderSpec(this.state.spec) : "", ...identifiers].join("\n");
  }

  async save(checkpoint?: string): Promise<void> {
    if (this.deps.faults) {
      const stage = this.stageContext.getStore();
      await this.faults.hit(
        "store:save",
        { runId: this.run.id, stage: stage?.name, round: this.state.round, checkpoint },
        this.signal,
      );
      this.checkCancelled();
    }
    this.store.setRunState(this.run.id, this.state);
  }

  async setPhase(phase: Phase): Promise<void> {
    this.state.phase = phase;
    if (phase === "done") this.state.completedChecks = undefined;
    await this.save();
  }

  log(message: string, level: RunEvent["level"] = "info", data?: unknown): void {
    this.store.addEvent({ runId: this.run.id, type: "log", level, message, data });
  }

  checkCancelled(): void {
    if (this.termination) throw this.termination;
    if (this.signal.aborted) throw new CancelledError();
  }

  /** Run a stage with bookkeeping; the callback returns a one-line summary. */
  async stage<T>(
    name: StageName,
    fn: (stage: Stage) => Promise<{ summary: string; value: T }>,
    round = 0,
    background = false,
    parkOnDrain = true,
  ): Promise<T> {
    this.checkCancelled();
    const cacheable =
      !background && this.state.phase === "loop" && ["gates", "audit", "review"].includes(name);
    const cache = this.state.completedChecks;
    const checkSha =
      cacheable && this.state.worktreePath ? await headSha(this.state.worktreePath) : undefined;
    if (cacheable && cache?.round === round && cache.sha === checkSha && Object.hasOwn(cache.values, name))
      return cache.values[name] as T;
    // Keep a round together when draining, even if no check checkpoint exists yet.
    if (parkOnDrain && !UNPARKABLE.has(name) && this.foregroundStageDepth === 0 && this.isDraining())
      throw new ParkedError();
    if (!background) this.run = this.store.updateRun(this.run.id, { stage: name });
    const stage = this.store.startStage(this.run.id, name, round);
    // Parallel holdout work must not suppress foreground drain boundaries.
    if (!background) this.foregroundStageDepth++;
    try {
      const context = { runId: this.run.id, stage: name, round };
      const { summary, value } = await this.stageContext.run(stage, async () => {
        await this.faults.hit(`stage:${name}:before`, context, this.signal);
        this.checkCancelled();
        const output = await fn(stage);
        await this.faults.hit(`stage:${name}:after`, context, this.signal);
        this.checkCancelled();
        if (cacheable) {
          if (this.state.completedChecks?.round !== round || this.state.completedChecks.sha !== checkSha)
            this.state.completedChecks = { round, sha: checkSha, values: {} };
          this.state.completedChecks.values[name] = output.value;
          await this.save();
        }
        return output;
      });
      const chain = this.pinnedStages.get(stage.id);
      this.store.finishStage(
        stage.id,
        "succeeded",
        summary + (chain ? `; pinned chain: ${chain.join(", ")}` : ""),
      );
      return value;
    } catch (e) {
      if (e instanceof SimulatedTermination) {
        this.termination = e;
        this.interruption.abort();
      }
      const cancelled =
        e instanceof CancelledError || e instanceof SimulatedTermination || this.signal.aborted;
      const chain = this.pinnedStages.get(stage.id);
      this.store.finishStage(
        stage.id,
        cancelled ? "cancelled" : "failed",
        (e as Error).message.slice(0, 500) + (chain ? `; pinned chain: ${chain.join(", ")}` : ""),
      );
      throw cancelled && !(e instanceof SimulatedTermination) ? new CancelledError() : e;
    } finally {
      if (!background) this.foregroundStageDepth--;
    }
  }

  /**
   * Route a role to a model and run it, falling back across candidates when a provider is out of
   * quota or unavailable. Task-level failures are returned to the caller, not retried here.
   */
  async invoke(opts: InvokeOptions): Promise<InvokeOutcome> {
    const { router, tracker, store, harnesses } = this.deps;
    const { shadow } = opts;
    const chain = shadow ? undefined : this.run.models?.[opts.role as RunRole];
    const failures = new Map<string, string>();
    const health = shadow ? undefined : tracker;
    const signal = shadow?.signal ?? this.signal;
    const tried: (string | ModelSelection)[] = [...(opts.constraints?.exclude ?? [])];
    const busy = new Set<string>();
    let waitMs = 0;
    let lastFailure: string | null = null;
    const specIdRetried = new Set<string>();
    const exhaustPinned = (decision: RouteDecision, deadline = false): never => {
      const skipped = [
        ...decision.skipped,
        ...decision.candidates.map((target) => ({
          modelId: target.targetId ?? target.modelId,
          reason:
            busy.has(target.provider) ||
            (tracker.status(target.provider)?.inFlight ?? 0) >=
              (tracker.status(target.provider)?.maxConcurrent ?? Infinity)
              ? "busy until the deadline"
              : "invocation deadline expired",
        })),
      ];
      const message = `No model available for ${opts.role}; pinned chain: ${chain?.join(", ")}. Skipped: ${skipped.map((s) => `${s.modelId} (${failures.get(s.modelId) ?? s.reason})`).join(", ")}.${deadline ? " Invocation deadline expired." : ""} Retry with another chain or resolve this run.`;
      store.askQuestion(this.run.id, message);
      throw new NoCapacityError(message);
    };
    // An unsure (not question-needing) decline beats failing the stage when nothing else answers.
    let lastResort: InvokeOutcome | null = null;
    const useLastResort = (outcome: InvokeOutcome, why: string) => {
      this.log(
        `${why}; using the declined answer from ${outcome.target.targetId ?? outcome.target.modelId}`,
        "warn",
      );
      return outcome;
    };

    const left = () => (opts.deadline === undefined ? Number.POSITIVE_INFINITY : opts.deadline - Date.now());
    for (let attempt = 0; attempt < (chain ? Infinity : 6); attempt++) {
      this.checkCancelled();
      if (signal.aborted) throw new CancelledError();
      if (!chain && left() <= 0)
        throw new NoCapacityError(
          `Timed out routing ${opts.role}${lastFailure ? ` after: ${lastFailure}` : ""}`,
        );
      const revision = router.policyRevision;
      const cellRevision = router.cellRevision(opts.role, opts.complexity);
      const decision = router.route(
        opts.role,
        opts.complexity,
        this.routingConstraints({
          ...opts.constraints,
          exclude: tried,
          ...(chain ? { chain, ...(opts.role === "verify" ? { excludeModels: undefined } : {}) } : {}),
        }),
        !shadow,
      );
      if (chain && left() <= 0) exhaustPinned(decision, true);
      const candidates = decision.candidates;
      let target =
        candidates.find((t) => {
          const status = tracker.status(t.provider);
          return !busy.has(t.provider) || (status && status.inFlight < status.maxConcurrent);
        }) ?? candidates[0];
      if (!target && lastResort && !chain)
        return useLastResort(lastResort, `No other model for ${opts.role}`);
      if (!target) {
        if (chain) exhaustPinned(decision);
        const why = decision.skipped.map((s) => `${s.modelId} (${s.reason})`).join(", ");
        if (opts.privateOutput) throw new NoCapacityError(`No model available for ${opts.role}`);
        throw new NoCapacityError(
          `No model available for ${opts.role}${lastFailure ? ` after: ${lastFailure}` : ""}. Skipped: ${why || "none configured"}`,
        );
      }
      // With no alternative left, contention waits until a slot opens or the invocation deadline.
      const providers = [...new Set(candidates.map((t) => t.provider))];
      const allBusy = providers.every((id) => busy.has(id));
      const seconds = providers.length > 1 && !allBusy ? this.deps.cfg.waitBudgetS[opts.role] : undefined;
      const budget = Math.min((seconds ?? Infinity) * 1000, left());
      let waitingAt: number | null = null;
      const onWait = (provider: string, ahead: number) => {
        waitingAt ??= tracker.now();
        this.log(
          `waiting for ${provider} slot (${ahead} ahead), up to ${Number.isFinite(budget) ? `${Math.ceil(budget / 1000)}s` : "unbounded"}`,
        );
      };
      const limit = Number.isFinite(budget) ? budget : undefined;
      // Only this call: a production call that needs its slot aborts it, not the rest of the shadow.
      const preempted = new AbortController();
      const callSignal = shadow ? AbortSignal.any([signal, preempted.signal]) : signal;
      // Decided when the preemption lands: the grace may expire before the aborted call settles.
      let cause: Preempted | undefined;
      const preempt = () => {
        if (!signal.aborted) cause = new Preempted();
        preempted.abort();
      };
      let admission: { provider: string; release: () => void } | null;
      if (shadow) {
        // A shadow call never waits: it takes a spare slot now, or the member is skipped.
        const free = tracker.tryAcquire(target.provider, preempt);
        if (!free) throw new NoCapacityError(`${target.provider}: no free slot`);
        admission = { provider: target.provider, release: free };
      } else {
        const provider = target.provider;
        const admissionSignal = AbortSignal.any([this.signal, revision]);
        admission = await (allBusy
          ? tracker.acquireFirst(providers, admissionSignal, limit, onWait)
          : tracker
              .acquire(provider, admissionSignal, busy.has(provider) ? 0 : limit, (ahead) =>
                onWait(provider, ahead),
              )
              .then((release) => release && { provider, release })
        ).catch((error: unknown) => {
          this.checkCancelled();
          if (revision.aborted) return null;
          throw error;
        });
      }
      const release = admission?.release;
      if (admission) target = candidates.find((t) => t.provider === admission.provider) ?? target;
      waitMs += waitingAt === null ? 0 : Math.max(0, tracker.now() - waitingAt);
      if (this.signal.aborted || left() <= 0) {
        release?.();
        this.checkCancelled();
        if (chain) exhaustPinned(decision, true);
        throw new NoCapacityError(`${target.targetId ?? target.modelId}: busy until the deadline`);
      }
      if (revision.aborted) {
        release?.();
        busy.clear();
        attempt--;
        continue;
      }
      if (!release) {
        busy.add(target.provider);
        attempt--;
        continue;
      }
      const ready = shadow ? tracker.isAvailable(target.provider) : await tracker.preflight(target.provider);
      if (revision.aborted) {
        release();
        busy.clear();
        attempt--;
        continue;
      }
      if (!ready || tracker.modelUnavailableReason(target.modelId)) {
        release();
        tried.push({ modelId: target.modelId, effort: target.effort ?? null });
        attempt--;
        lastFailure = `${target.targetId ?? target.modelId}: no capacity after provider refresh`;
        failures.set(
          target.targetId ?? target.modelId,
          tracker.unavailableReason(target.provider) ??
            tracker.modelUnavailableReason(target.modelId) ??
            "no capacity after provider refresh",
        );
        continue;
      }
      if (this.signal.aborted) release();
      this.checkCancelled();
      const guard = shadow;
      const stopped = guard?.stop(target.provider);
      if (stopped) {
        release();
        throw new NoCapacityError(stopped);
      }
      const { harnessName, noTools } = selectHarness(opts.role, target, opts.noTools);
      const harness = harnesses[harnessName];
      if (!harness) {
        release();
        throw new Error(`No harness registered for ${harnessName}`);
      }
      tried.push({ modelId: target.modelId, effort: target.effort ?? null });
      const previousImplementer = this.state.implementer;
      if (opts.role === "implement") {
        this.state.implementer = {
          policyRevision: cellRevision,
          modelId: target.modelId,
          targetId: target.targetId,
          effort: target.effort ?? null,
          tier: target.tier,
          vendor: target.vendor,
        };
        try {
          await this.save();
        } catch (error) {
          this.state.implementer = previousImplementer;
          release();
          throw error;
        }
      }
      const invocation = store.createInvocation({
        waitMs,
        fast: tracker.isFast(target.provider),
        runId: this.run.id,
        stageId: opts.stage.id,
        role: shadow ? "review_shadow" : opts.role,
        harness: harnessName,
        provider: target.provider,
        model: target.model,
        modelId: target.modelId,
        effort: recordEffort(target.effort),
      });
      guard?.ids.push(invocation.id);
      this.log(`${opts.role}: using ${target.targetId ?? target.modelId}`, "info", {
        invocationId: invocation.id,
        skipped: decision.skipped,
      });
      if (chain) {
        this.pinnedStages.set(opts.stage.id, chain);
        const c = opts.constraints;
        const avoidedVendor = [c?.avoidVendor ?? [], c?.preferNotVendor ?? []].flat().includes(target.vendor);
        const avoidedModel = [
          ...(c?.preferNotModels ?? []),
          ...(opts.role === "verify" ? (c?.excludeModels ?? []) : []),
        ].some((id) => router.checkpointIdentity(id) === router.checkpointIdentity(target.modelId));
        if (avoidedVendor || avoidedModel)
          this.log(
            `${opts.role} used ${opts.role === "holdout" ? "the spec author's" : "the implementer's"} vendor/checkpoint (${target.vendor}, ${target.targetId ?? target.modelId}) because this run pinned it`,
            "warn",
          );
      }
      let dispatched = false;
      const dispatch = () => {
        // Persist tried history without yielding between recording it and starting the harness.
        if (
          opts.role === "implement" &&
          !this.state.triedImplementers.some(
            (ref) =>
              (typeof ref === "string" ? ref : formatTarget(ref.modelId, ref.effort)) === target.targetId,
          )
        ) {
          this.state.triedImplementers.push({ modelId: target.modelId, effort: target.effort ?? null });
          store.setRunState(this.run.id, this.state);
        }
        dispatched = true;
      };
      let result: AgentResult;
      const privateDir = opts.privateOutput ? mkdtempSync(join(tmpdir(), "limitless-private-")) : null;
      const publicSources = opts.redactHoldout && this.state.holdout ? await this.publicHoldoutSources() : "";
      const redact =
        opts.redactHoldout && this.state.holdout
          ? (value: string) => redactHoldoutText(value, this.state.holdout as Holdout, publicSources)
          : undefined;
      try {
        const spec: AgentSpec = {
          fast: invocation.fast,
          cwd: opts.cwd ?? shadow?.cwd ?? this.state.worktreePath ?? this.runDir,
          prompt: opts.prompt,
          systemAppend: [opts.systemAppend, FACTORY_PREAMBLE].filter(Boolean).join("\n\n"),
          target,
          mode: opts.mode,
          ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
          ...(opts.schema ? { schema: opts.schema } : {}),
          ...(opts.decisionTask ? { decisionTask: opts.decisionTask } : {}),
          timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUTS[opts.role], left())),
          idleTimeoutMs: opts.idleTimeoutMs ?? 10 * 60_000,
          maxToolCalls: opts.maxToolCalls ?? (opts.mode === "edit" ? 400 : 150),
          ...(opts.denyRead ? { denyRead: opts.denyRead } : {}),
          ...(opts.confineReads ? { confineReads: true } : {}),
          noTools,
          privateSession: opts.privateOutput || opts.privateSession,
          // The private log sits in the shared temporary directory while a parallel implementer
          // runs as the same user, so it never holds the private text itself.
          redactOutput: opts.privateOutput ? withholdText : redact,
          signal: callSignal,
          logPath: join(privateDir ?? this.runDir, `inv-${invocation.id}.log`),
          onEvent: opts.privateOutput
            ? () => {}
            : (ev) => {
                this.onAgentEvent(invocation.id, ev, opts.role, redact);
              },
        };
        const faultContext = {
          runId: this.run.id,
          stage: opts.stage.name,
          round: opts.stage.round,
          role: opts.role,
          modelId: target.modelId,
          invocationId: invocation.id,
        };
        // Invocation row/slot exist; stream faults replace input via the real CLI parsers.
        await this.faults.hit("harness:invoke", faultContext, this.signal);
        this.checkCancelled();
        const stream = await this.faults.hit("harness:stream", faultContext, this.signal);
        this.checkCancelled();
        // Saving state, preparing redaction and fault hooks can also yield before the model call.
        if (revision.aborted) {
          store.updateInvocation(invocation.id, {
            status: "cancelled",
            error: "routing changed before model call",
            finishedAt: Date.now(),
          });
          tried.pop();
          busy.clear();
          attempt--;
          continue;
        }
        if (stream) {
          dispatch();
          result = parseFakeStream(stream, spec.onEvent);
        } else if (!noTools) {
          // Every tool-enabled call is confined to its cwd plus a scratch this call owns.
          result = await withScratch(spec.cwd, (scratchDir) => {
            dispatch();
            return harness({ ...spec, scratchDir });
          });
        } else {
          dispatch();
          result = await harness(spec);
        }
      } catch (e) {
        if (e instanceof SimulatedTermination) {
          this.termination = e;
          this.interruption.abort();
        }
        result = {
          status: "error",
          finalText: "",
          structured: null,
          sessionId: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          numTurns: 0,
          costUsd: 0,
          costEquivUsd: 0,
          error: (e as Error).message,
          quota: null,
        };
      } finally {
        if (!dispatched && revision.aborted && opts.role === "implement") {
          this.state.implementer = previousImplementer;
          store.setRunState(this.run.id, this.state);
        }
        release();
        if (privateDir) rmSync(privateDir, { recursive: true, force: true });
        const checkout = shadow?.cwd ?? this.state.worktreePath;
        if ((opts.role === "review" || opts.role === "verify") && checkout) await discardChanges(checkout);
      }
      if (callSignal.aborted)
        result = { ...result, status: "cancelled", error: this.termination?.message ?? "cancelled" };
      if (opts.requireStructured && result.status === "ok" && result.structured === null)
        result = { ...result, status: "error", error: "missing structured output" };
      let invalidSpecId = "";
      if (
        opts.schema &&
        (result.status === "ok" || result.status === "declined") &&
        result.structured !== null
      ) {
        const parsed = opts.schema.safeParse(result.structured);
        if (!parsed.success)
          invalidSpecId = parsed.error.issues.find((i) => i.message.startsWith("Invalid id "))?.message ?? "";
        result = parsed.success
          ? { ...result, structured: parsed.data }
          : {
              ...result,
              status: "error",
              structured: null,
              error: `structured output failed validation: ${parsed.error.message.slice(0, 500)}`,
            };
      }

      result = redactCredentialData(result);
      const updated = store.updateInvocation(invocation.id, {
        status: result.status,
        fastModeState: result.fastModeState ?? null,
        fastModeDisabledReason: result.fastModeDisabledReason ?? null,
        costUsd: result.costUsd,
        costEquivUsd: result.costEquivUsd,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead,
        cacheWriteTokens: result.usage.cacheWrite,
        numTurns: result.numTurns,
        sessionId: result.sessionId,
        // A failed confinement probe ran before the agent, so its error holds no private output.
        error:
          opts.privateOutput && result.error && result.confinement?.ok !== false
            ? "private invocation failed"
            : result.error && redact
              ? redact(result.error)
              : result.error,
        finishedAt: Date.now(),
      });
      // Shadow outcomes never reach provider health, quota telemetry or model blocks.
      if (result.quota?.windows) health?.observeWindows(target.provider, result.quota.windows);
      if (result.confinement) health?.observeConfinement(target.provider, result.confinement);
      // An unconfinable CLI is no provider failure: unconfined roles still use it.
      if (result.confinement?.ok !== false)
        health?.record(target.provider, result.status, {
          exhaustedUntil: result.quota?.exhaustedUntil ?? null,
          ...(result.modelCooldownMs === undefined
            ? {}
            : { modelCooldown: { modelId: target.modelId, ms: result.modelCooldownMs } }),
          error:
            opts.privateOutput && result.error
              ? "private invocation failed"
              : result.error && redact
                ? redact(result.error)
                : result.error,
        });
      this.run = store.refreshRunTotals(this.run.id);
      if (result.status !== "ok")
        failures.set(
          target.targetId ?? target.modelId,
          opts.privateOutput
            ? result.status
            : `${result.status}: ${redact?.(result.error ?? "already tried") ?? result.error ?? "already tried"}`,
        );

      if (this.termination) throw this.termination;
      if (cause) throw cause;
      if (result.status === "cancelled" || signal.aborted) throw new CancelledError();
      if (result.status === "declined") {
        // Not a failure and not a routing attempt: each decision model declines at most once.
        const reason = opts.privateOutput
          ? "private invocation declined"
          : (redact?.(result.error ?? "") ?? result.error ?? "");
        lastFailure = `${target.targetId ?? target.modelId}: declined (${reason})`.slice(0, 300);
        this.log(`${target.targetId ?? target.modelId} declined: ${reason}; trying the next model`);
        if (result.decline?.lastResort) lastResort = { result, target, invocation: updated };
        attempt--;
        continue;
      }
      if (result.confinement?.ok === false) {
        // Checked before MODEL_REJECTED: the CLI, not the model, failed, so nothing gets blocked.
        // Never retried unconfined; each model is tried once, so this doesn't spend attempts.
        lastFailure = `${target.targetId ?? target.modelId}: ${result.error ?? ""}`.slice(0, 300);
        this.log(`${target.targetId ?? target.modelId} cannot confine reads; falling back`, "warn");
        attempt--;
        continue;
      }
      if (result.status !== "ok" && MODEL_REJECTED.test(result.error ?? "")) {
        // A configuration problem with this model (e.g. not on the plan), not a task failure.
        health?.blockModel(
          target.modelId,
          opts.privateOutput
            ? "private invocation rejected"
            : (redact?.(result.error ?? "rejected") ?? result.error ?? "rejected"),
        );
        lastFailure =
          `${target.targetId ?? target.modelId}: ${redact?.(result.error ?? "") ?? result.error ?? ""}`.slice(
            0,
            300,
          );
        this.log(
          `${target.targetId ?? target.modelId} rejected by provider; blocking it for 24h and falling back`,
          "warn",
        );
        continue;
      }
      if (result.status === "quota" || result.status === "unavailable") {
        lastFailure =
          `${target.targetId ?? target.modelId}: ${result.status} (${redact?.(result.error ?? "") ?? result.error ?? ""})`.slice(
            0,
            300,
          );
        this.log(`${target.targetId ?? target.modelId} ${result.status}; falling back`, "warn");
        continue;
      }
      if (opts.role === "spec" && invalidSpecId) {
        const id = target.targetId ?? target.modelId;
        if (!specIdRetried.has(id)) {
          specIdRetried.add(id);
          opts = { ...opts, prompt: `${opts.prompt}\n\nInvalid spec: ${invalidSpecId}\n${result.error}` };
          tried.pop();
          continue;
        }
        failures.set(id, `validation failed: ${invalidSpecId}`);
        lastFailure = `${id}: validation failed: ${invalidSpecId}`;
        this.log(`${id} returned invalid spec criterion IDs twice; trying next model`, "warn");
        continue;
      }
      if (opts.requireStructured && (result.status !== "ok" || result.structured === null)) {
        lastFailure =
          `${target.targetId ?? target.modelId}: ${redact?.(result.error ?? "no structured output") ?? result.error ?? "no structured output"}`.slice(
            0,
            300,
          );
        this.log(
          `${target.targetId ?? target.modelId} failed to produce structured output; trying next model`,
          "warn",
        );
        continue;
      }
      return { result, target, invocation: updated };
    }
    if (lastResort) return useLastResort(lastResort, `Gave up routing ${opts.role} after 6 failed attempts`);
    throw new NoCapacityError(
      opts.privateOutput
        ? `Gave up routing ${opts.role}`
        : `Gave up routing ${opts.role}: ${lastFailure ?? "no candidates"}`,
    );
  }

  private onAgentEvent(
    invocationId: number,
    ev: AgentEvent,
    role: Role,
    redact?: (value: string) => string,
  ): void {
    const runId = this.run.id;
    const add = (
      type: RunEvent["type"],
      message: string,
      data?: unknown,
      level: RunEvent["level"] = "info",
    ) =>
      this.store.addEvent({
        runId,
        invocationId,
        type,
        level,
        message: redact ? redact(message) : message,
        data:
          redact && data !== undefined
            ? JSON.parse(
                JSON.stringify(data, (_key, value: unknown) =>
                  typeof value === "string" ? redact(value) : value,
                ),
              )
            : data,
      });
    switch (ev.type) {
      case "init":
        add("status", `session ${ev.sessionId}${ev.model ? ` (${ev.model})` : ""}`, undefined, "debug");
        break;
      case "text":
        add("text", ev.text);
        break;
      case "thinking":
        add("thinking", ev.text.slice(0, 2000), undefined, "debug");
        break;
      case "tool_call": {
        const input = ev.input as Record<string, unknown> | null;
        const command = typeof input?.command === "string" ? input.command : null;
        if (command && role === "implement") this.state.toolCommands.push(command.slice(0, 500));
        add("tool_call", `${ev.name}${command ? `: ${command.slice(0, 300)}` : ""}`, {
          id: ev.id,
          input: ev.input,
        });
        break;
      }
      case "tool_result":
        add(
          "tool_result",
          ev.output.slice(0, 400),
          { id: ev.id, output: ev.output },
          ev.isError ? "warn" : "debug",
        );
        break;
      case "rate_limit":
        add("rate_limit", `rate limit ${ev.status}`, { windows: ev.windows, resetsAt: ev.resetsAt }, "debug");
        break;
      case "stderr":
        add("stderr", ev.text, undefined, "debug");
        break;
      case "status":
        add("status", ev.text);
        break;
    }
  }
}
