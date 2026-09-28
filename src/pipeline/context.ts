import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ZodType } from "zod";
import type { Config } from "../config.ts";
import type {
  Complexity,
  Invocation,
  ModelSelection,
  Repo,
  Role,
  Run,
  RunEvent,
  Stage,
  StageName,
} from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { AuditFinding } from "../gates/audit.ts";
import type { GateConfig } from "../gates/detect.ts";
import type { GateComparison, GateRun } from "../gates/run.ts";
import { discardChanges } from "../git/repos.ts";
import { parseFakeStream } from "../harness/fake.ts";
import { withScratch } from "../harness/scratch.ts";
import { selectHarness } from "../harness/select.ts";
import type { AgentEvent, AgentResult, AgentSpec, Harness, ModelTarget } from "../harness/types.ts";
import type { ProviderTracker } from "../router/providers.ts";
import type { RouteConstraints, Router } from "../router/router.ts";
import { recordEffort } from "../router/targets.ts";
import { type FaultInjector, type FaultPlan, injectorFor, SimulatedTermination } from "./faults.ts";
import type { PreviewConfig } from "./preview.ts";
import { FACTORY_PREAMBLE, redactHoldoutText } from "./prompts.ts";
import type { Holdout, Review, Spec, Triage, Verify } from "./schemas.ts";
import { renderSpec } from "./schemas.ts";

export interface EngineDeps {
  faults?: FaultPlan;
  cfg: Config;
  store: Store;
  router: Router;
  tracker: ProviderTracker;
  harnesses: Record<string, Harness>;
}

export type Phase = "prepare" | "triage" | "clarify" | "spec" | "loop" | "deliver" | "done";

/** Everything a run needs to resume after a restart. Persisted as runs.state_json. */
export interface RunState {
  phase: Phase;
  worktreePath?: string;
  gatesConfig?: GateConfig;
  previewConfig?: PreviewConfig | null;
  baseline?: GateRun | null;
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
  /** Agent output saved before the idempotent commit operation. */
  implementationReadyRound?: number;
  completedChecks?: { round: number; values: Partial<Record<StageName, unknown>> };
  deliveryComplete?: boolean;
  /** Delivery rebase target; gates must pass before this becomes run.baseSha. */
  pendingRebaseSha?: string;
  preRebaseGates?: GateComparison[];
  /** Head before the delivery rebase; delivery falls back to it if the rebase regresses checks. */
  preRebaseHead?: string;
  /** Why delivery went ahead without rebasing onto the latest base (shown in the report). */
  rebaseNote?: string;
  /** The single extra implementation round allowed after a conflicting delivery rebase. */
  conflictRound?: number;
  /** package.json scripts the gates depend on, as they were on the base branch. */
  baselineScripts?: Record<string, string>;
  feedback: string | null;
  lastGates?: GateComparison[];
  lastAudit?: AuditFinding[];
  lastReview?: Review & { modelId: string };
  reviewedSha?: string;
  /** Replace a replayed round; earlier entries remain the source of review context. */
  reviewHistory?: {
    round: number;
    sha: string;
    blocking: Review["findings"];
    followUps: Review["findings"];
  }[];
  reviewFollowUps?: Review["findings"];
  lastVerify?: (Verify & { modelId: string }) | null;
  verifyResults?: (Verify & { modelId: string; round: number; attempt?: number })[];
  /** Round whose retry is reserved; a restart resumes it, and a recorded attempt 1 ends retrying. */
  environmentRetryRound?: number;
  terminalReason?: string;
  /** Verdict awaiting its draft PR; a restart resumes that delivery instead of re-entering the loop. */
  needsHumanReason?: string;
  toolCommands: string[];
}

const MODEL_REJECTED =
  /model[^.]{0,80}(is not supported|not found|does not exist|not available)|unknown model|invalid model|model_not_found/i;
const execFileAsync = promisify(execFile);
const MAX_PUBLIC_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_SOURCE_FILES = 2_000;

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

export class NeedsHumanError extends Error {}

export class NoCapacityError extends Error {}

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
  idleTimeoutMs?: number;
  maxToolCalls?: number;
  /** Retry a failed structured-output call once on the next candidate. */
  requireStructured?: boolean;
  /** Validates structured output; invalid output counts as a failed call (next candidate). */
  schema?: ZodType;
  /** Run without repository access or public/raw event output. */
  privateOutput?: boolean;
  /** Prevent the CLI from persisting a private prompt in its own session store. */
  privateSession?: boolean;
  /** Redact holdout content from observable verifier events and transcripts. */
  redactHoldout?: boolean;
  isolatedCwd?: boolean;
  noTools?: boolean;
}

export interface InvokeOutcome {
  result: AgentResult;
  target: ModelTarget;
  invocation: Invocation;
}

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
  readonly runDir: string;
  previewUrl?: string;
  state: RunState;

  get freeFirstRouting(): boolean {
    return this.run.requestedBy === "dependabot[bot]" && this.deps.cfg.dependabotRouting === "free_first";
  }

  routingConstraints(constraints: RouteConstraints = {}): RouteConstraints {
    return this.freeFirstRouting ? { ...constraints, billing: "free_first" } : constraints;
  }

  constructor(
    readonly deps: EngineDeps,
    public run: Run,
    readonly repo: Repo,
    signal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([signal, this.interruption.signal]);
    this.faults = injectorFor(deps.faults);
    this.runDir = join(deps.cfg.paths.runs, run.id);
    mkdirSync(this.runDir, { recursive: true });
    this.state = deps.store.getRunState<RunState>(run.id) ?? {
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
        const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
          cwd,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        });
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
  ): Promise<T> {
    this.checkCancelled();
    const cacheable =
      !background && this.state.phase === "loop" && ["gates", "audit", "review"].includes(name);
    const cache = this.state.completedChecks;
    if (cacheable && cache?.round === round && Object.hasOwn(cache.values, name))
      return cache.values[name] as T;
    if (!background) this.run = this.store.updateRun(this.run.id, { stage: name });
    const stage = this.store.startStage(this.run.id, name, round);
    try {
      // Before: row exists, callback has not run. After: callback returned, completion not recorded.
      const context = { runId: this.run.id, stage: name, round };
      const { summary, value } = await this.stageContext.run(stage, async () => {
        await this.faults.hit(`stage:${name}:before`, context, this.signal);
        this.checkCancelled();
        const output = await fn(stage);
        await this.faults.hit(`stage:${name}:after`, context, this.signal);
        this.checkCancelled();
        if (cacheable) {
          if (this.state.completedChecks?.round !== round) this.state.completedChecks = { round, values: {} };
          this.state.completedChecks.values[name] = output.value;
          await this.save();
        }
        return output;
      });
      this.store.finishStage(stage.id, "succeeded", summary);
      return value;
    } catch (e) {
      if (e instanceof SimulatedTermination) {
        this.termination = e;
        this.interruption.abort();
      }
      const cancelled =
        e instanceof CancelledError || e instanceof SimulatedTermination || this.signal.aborted;
      this.store.finishStage(
        stage.id,
        cancelled ? "cancelled" : "failed",
        (e as Error).message.slice(0, 500),
      );
      throw cancelled && !(e instanceof SimulatedTermination) ? new CancelledError() : e;
    }
  }

  /**
   * Route a role to a model and run it, falling back across candidates when a provider is out of
   * quota or unavailable. Task-level failures are returned to the caller, not retried here.
   */
  async invoke(opts: InvokeOptions): Promise<InvokeOutcome> {
    const { router, tracker, store, harnesses } = this.deps;
    const tried: (string | ModelSelection)[] = [...(opts.constraints?.exclude ?? [])];
    let lastFailure: string | null = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      this.checkCancelled();
      const decision = router.route(
        opts.role,
        opts.complexity,
        this.routingConstraints({ ...opts.constraints, exclude: tried }),
      );
      const target = decision.candidates[0];
      if (!target) {
        const why = decision.skipped.map((s) => `${s.modelId} (${s.reason})`).join(", ");
        if (opts.privateOutput) throw new NoCapacityError(`No model available for ${opts.role}`);
        throw new NoCapacityError(
          `No model available for ${opts.role}${lastFailure ? ` after: ${lastFailure}` : ""}. Skipped: ${why || "none configured"}`,
        );
      }
      tried.push({ modelId: target.modelId, effort: target.effort ?? null });
      const { harnessName, noTools } = selectHarness(opts.role, target, opts.noTools);
      const harness = harnesses[harnessName];
      if (!harness) throw new Error(`No harness registered for ${harnessName}`);

      const release = await tracker.acquire(target.provider, this.signal);
      if (!(await tracker.preflight(target.provider)) || tracker.modelUnavailableReason(target.modelId)) {
        release();
        lastFailure = `${target.targetId ?? target.modelId}: no capacity after provider refresh`;
        continue;
      }
      if (opts.role === "implement") {
        this.state.implementer = {
          modelId: target.modelId,
          targetId: target.targetId,
          effort: target.effort ?? null,
          tier: target.tier,
          vendor: target.vendor,
        };
        try {
          await this.save();
        } catch (error) {
          release();
          throw error;
        }
      }
      const invocation = store.createInvocation({
        runId: this.run.id,
        stageId: opts.stage.id,
        role: opts.role,
        harness: harnessName,
        provider: target.provider,
        model: target.model,
        modelId: target.modelId,
        effort: recordEffort(target.effort),
      });
      this.log(`${opts.role}: using ${target.targetId ?? target.modelId}`, "info", {
        invocationId: invocation.id,
        skipped: decision.skipped,
      });
      let result: AgentResult;
      const privateDir = opts.privateOutput ? mkdtempSync(join(tmpdir(), "limitless-private-")) : null;
      const publicSources = opts.redactHoldout && this.state.holdout ? await this.publicHoldoutSources() : "";
      const redact =
        opts.redactHoldout && this.state.holdout
          ? (value: string) => redactHoldoutText(value, this.state.holdout as Holdout, publicSources)
          : undefined;
      try {
        const spec: AgentSpec = {
          cwd: opts.isolatedCwd ? (privateDir as string) : (this.state.worktreePath ?? this.runDir),
          prompt: opts.prompt,
          systemAppend: [opts.systemAppend, FACTORY_PREAMBLE].filter(Boolean).join("\n\n"),
          target,
          mode: opts.mode,
          ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
          ...(opts.schema ? { schema: opts.schema } : {}),
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUTS[opts.role],
          idleTimeoutMs: opts.idleTimeoutMs ?? 10 * 60_000,
          maxToolCalls: opts.maxToolCalls ?? (opts.mode === "edit" ? 400 : 150),
          noTools,
          privateSession: opts.privateOutput || opts.privateSession,
          redactOutput: redact,
          signal: this.signal,
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
        if (stream) result = parseFakeStream(stream, spec.onEvent);
        else if (opts.mode === "readonly" && !noTools) {
          result = await withScratch(spec.cwd, (scratchDir) => harness({ ...spec, scratchDir }));
        } else result = await harness(spec);
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
        release();
        if (privateDir) rmSync(privateDir, { recursive: true, force: true });
        if ((opts.role === "review" || opts.role === "verify") && this.state.worktreePath)
          await discardChanges(this.state.worktreePath);
      }
      if (this.signal.aborted) result = { ...result, status: "cancelled", error: "cancelled" };
      if (opts.requireStructured && result.status === "ok" && result.structured === null)
        result = { ...result, status: "error", error: "missing structured output" };
      if (opts.schema && result.status === "ok" && result.structured !== null) {
        const parsed = opts.schema.safeParse(result.structured);
        result = parsed.success
          ? { ...result, structured: parsed.data }
          : {
              ...result,
              status: "error",
              structured: null,
              error: `structured output failed validation: ${parsed.error.message.slice(0, 500)}`,
            };
      }

      const updated = store.updateInvocation(invocation.id, {
        status: result.status,
        costUsd: result.costUsd,
        costEquivUsd: result.costEquivUsd,
        inputTokens: result.usage.input + result.usage.cacheWrite,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead,
        numTurns: result.numTurns,
        sessionId: result.sessionId,
        error:
          opts.privateOutput && result.error
            ? "private invocation failed"
            : result.error && redact
              ? redact(result.error)
              : result.error,
        finishedAt: Date.now(),
      });
      if (result.quota?.windows) tracker.observeWindows(target.provider, result.quota.windows);
      tracker.record(target.provider, result.status, {
        exhaustedUntil: result.quota?.exhaustedUntil ?? null,
        error:
          opts.privateOutput && result.error
            ? "private invocation failed"
            : result.error && redact
              ? redact(result.error)
              : result.error,
      });
      this.run = store.refreshRunTotals(this.run.id);

      if (this.termination) throw this.termination;
      if (result.status === "cancelled" || this.signal.aborted) throw new CancelledError();
      if (result.status !== "ok" && MODEL_REJECTED.test(result.error ?? "")) {
        // A configuration problem with this model (e.g. not on the plan), not a task failure.
        tracker.blockModel(
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
