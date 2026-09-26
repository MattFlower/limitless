import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Complexity, Invocation, Repo, Role, Run, RunEvent, Stage, StageName } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { AuditFinding } from "../gates/audit.ts";
import type { GateConfig } from "../gates/detect.ts";
import type { GateComparison, GateRun } from "../gates/run.ts";
import type { AgentEvent, AgentResult, Harness, ModelTarget } from "../harness/types.ts";
import type { ProviderTracker } from "../router/providers.ts";
import type { RouteConstraints, Router } from "../router/router.ts";
import { FACTORY_PREAMBLE } from "./prompts.ts";
import type { Review, Spec, Triage, Verify } from "./schemas.ts";

export interface EngineDeps {
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
  baseline?: GateRun | null;
  triage?: Triage;
  spec?: Spec | null;
  answers: string[];
  round: number;
  implementer?: { modelId: string; tier: number; vendor: string };
  roundsOnImplementer: number;
  triedImplementers: string[];
  implementerReport?: string;
  feedback: string | null;
  lastGates?: GateComparison[];
  lastAudit?: AuditFinding[];
  lastReview?: Review & { modelId: string };
  lastVerify?: (Verify & { modelId: string }) | null;
  toolCommands: string[];
}

const MODEL_REJECTED =
  /model[^.]{0,80}(is not supported|not found|does not exist|not available)|unknown model|invalid model|model_not_found/i;

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
  readonly runDir: string;
  state: RunState;

  constructor(
    readonly deps: EngineDeps,
    public run: Run,
    readonly repo: Repo,
    readonly signal: AbortSignal,
  ) {
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

  save(): void {
    this.store.setRunState(this.run.id, this.state);
  }

  setPhase(phase: Phase): void {
    this.state.phase = phase;
    this.save();
  }

  log(message: string, level: RunEvent["level"] = "info", data?: unknown): void {
    this.store.addEvent({ runId: this.run.id, type: "log", level, message, data });
  }

  checkCancelled(): void {
    if (this.signal.aborted) throw new CancelledError();
  }

  /** Run a stage with bookkeeping; the callback returns a one-line summary. */
  async stage<T>(
    name: StageName,
    fn: (stage: Stage) => Promise<{ summary: string; value: T }>,
    round = 0,
  ): Promise<T> {
    this.checkCancelled();
    this.run = this.store.updateRun(this.run.id, { stage: name });
    const stage = this.store.startStage(this.run.id, name, round);
    try {
      const { summary, value } = await fn(stage);
      this.store.finishStage(stage.id, "succeeded", summary);
      return value;
    } catch (e) {
      const cancelled = e instanceof CancelledError || this.signal.aborted;
      this.store.finishStage(
        stage.id,
        cancelled ? "cancelled" : "failed",
        (e as Error).message.slice(0, 500),
      );
      throw cancelled ? new CancelledError() : e;
    }
  }

  /**
   * Route a role to a model and run it, falling back across candidates when a provider is out of
   * quota or unavailable. Task-level failures are returned to the caller, not retried here.
   */
  async invoke(opts: InvokeOptions): Promise<InvokeOutcome> {
    const { router, tracker, store, harnesses } = this.deps;
    const tried: string[] = [...(opts.constraints?.exclude ?? [])];
    let lastFailure: string | null = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      this.checkCancelled();
      const decision = router.route(opts.role, opts.complexity, { ...opts.constraints, exclude: tried });
      const target = decision.candidates[0];
      if (!target) {
        const why = decision.skipped.map((s) => `${s.modelId} (${s.reason})`).join(", ");
        throw new NoCapacityError(
          `No model available for ${opts.role}${lastFailure ? ` after: ${lastFailure}` : ""}. Skipped: ${why || "none configured"}`,
        );
      }
      tried.push(target.modelId);
      const harness = harnesses[target.harness];
      if (!harness) throw new Error(`No harness registered for ${target.harness}`);

      const release = await tracker.acquire(target.provider, this.signal);
      const invocation = store.createInvocation({
        runId: this.run.id,
        stageId: opts.stage.id,
        role: opts.role,
        harness: target.harness,
        provider: target.provider,
        model: target.model,
        modelId: target.modelId,
      });
      this.log(`${opts.role}: using ${target.modelId}`, "info", {
        invocationId: invocation.id,
        skipped: decision.skipped,
      });
      let result: AgentResult;
      try {
        result = await harness({
          cwd: this.state.worktreePath ?? this.runDir,
          prompt: opts.prompt,
          systemAppend: [opts.systemAppend, FACTORY_PREAMBLE].filter(Boolean).join("\n\n"),
          target,
          mode: opts.mode,
          ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUTS[opts.role],
          idleTimeoutMs: opts.idleTimeoutMs ?? 10 * 60_000,
          maxToolCalls: opts.maxToolCalls ?? (opts.mode === "edit" ? 400 : 150),
          signal: this.signal,
          logPath: join(this.runDir, `inv-${invocation.id}.log`),
          onEvent: (ev) => this.onAgentEvent(invocation.id, ev, opts.role),
        });
      } catch (e) {
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
        error: result.error,
        finishedAt: Date.now(),
      });
      if (result.quota?.windows) tracker.observeWindows(target.provider, result.quota.windows);
      tracker.record(target.provider, result.status, {
        exhaustedUntil: result.quota?.exhaustedUntil ?? null,
        error: result.error,
      });
      this.run = store.refreshRunTotals(this.run.id);

      if (result.status === "cancelled" || this.signal.aborted) throw new CancelledError();
      if (result.status !== "ok" && MODEL_REJECTED.test(result.error ?? "")) {
        // A configuration problem with this model (e.g. not on the plan), not a task failure.
        tracker.blockModel(target.modelId, result.error ?? "rejected");
        lastFailure = `${target.modelId}: ${result.error ?? ""}`.slice(0, 300);
        this.log(`${target.modelId} rejected by provider; blocking it for 24h and falling back`, "warn", {
          error: result.error,
        });
        continue;
      }
      if (result.status === "quota" || result.status === "unavailable") {
        lastFailure = `${target.modelId}: ${result.status} (${result.error ?? ""})`.slice(0, 300);
        this.log(`${target.modelId} ${result.status}; falling back`, "warn", { error: result.error });
        continue;
      }
      if (opts.requireStructured && (result.status !== "ok" || result.structured === null)) {
        lastFailure = `${target.modelId}: ${result.error ?? "no structured output"}`.slice(0, 300);
        this.log(`${target.modelId} failed to produce structured output; trying next model`, "warn", {
          error: result.error,
        });
        continue;
      }
      return { result, target, invocation: updated };
    }
    throw new NoCapacityError(`Gave up routing ${opts.role}: ${lastFailure ?? "no candidates"}`);
  }

  private onAgentEvent(invocationId: number, ev: AgentEvent, role: Role): void {
    const runId = this.run.id;
    const add = (
      type: RunEvent["type"],
      message: string,
      data?: unknown,
      level: RunEvent["level"] = "info",
    ) => this.store.addEvent({ runId, invocationId, type, level, message, data });
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
