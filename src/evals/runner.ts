import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EvalRun, EvalTrial } from "../core/types.ts";
import { createEvalWorktree, type EvalLabels, pinnedTree, snapshotTopLevel } from "../git/repos.ts";
import { createScratch, removeScratch, withScratch } from "../harness/scratch.ts";
import { selectHarness } from "../harness/select.ts";
import { type AgentResult, emptyUsage, extractJson } from "../harness/types.ts";
import type { EngineDeps } from "../pipeline/context.ts";
import { FACTORY_PREAMBLE } from "../pipeline/prompts.ts";
import { type ReviewRequest, runReview } from "../pipeline/review.ts";
import { toStrictJsonSchema } from "../pipeline/schemas.ts";
import { effortTransportError, parseTarget, recordEffort, recordedTarget } from "../router/targets.ts";
import { cacheKey } from "./cache.ts";
import {
  type AnyCaseFile,
  defaultCasePath,
  type EvalCase,
  EvalRequestSchema,
  hiddenContents,
  type ImplementCase,
  loadRoleCases,
  type TriageCase,
  validateRequest,
} from "./cases.ts";
import {
  failedImplement,
  gradeImplement,
  implementRetryPrompt,
  nextImplementTarget,
  prepareImplement,
} from "./implement.ts";
import { gradeCase, prepareCase, schemaFor, seedContent, storedSchemaFor } from "./prepare.ts";
import { type EvalReport, type StatsOptions, summarize } from "./stats.ts";

/** Where Limitless keeps eval datasets; pins whose history touches these are rejected. */
const LABEL_PATHS = ["evals/triage", "evals/review", "evals/verify", "evals/implement"];

export interface EvalRegradeResult {
  regraded: number;
  /** Regraded trials whose grade differs from the stored one. */
  changed: number;
  skipped: { caseId: string; modelId: string; trial: number; reason: string }[];
}

export class EvalRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopping = false;
  constructor(
    private readonly deps: EngineDeps,
    private readonly casePath?: string,
  ) {
    deps.store.recoverEvals();
  }

  submit(input: unknown): EvalRun {
    if (this.stopping) throw new Error("daemon is stopping");
    // Reject unsupported roles before accessing any dataset or repository.
    const parsed = EvalRequestSchema.parse(input);
    const file = loadRoleCases(parsed.role, this.casePath);
    for (const item of file.cases)
      if ("defects" in item) seedContent(item, this.casePath ?? defaultCasePath(parsed.role));
    const { request, cases } = validateRequest(input, file, this.deps.router);
    const trials: EvalTrial[] = [];
    for (const modelId of request.models)
      for (const item of cases)
        for (let trial = 0; trial < request.k; trial++)
          trials.push({
            evalRunId: "",
            caseId: item.id,
            modelId: parseTarget(modelId).modelId,
            effort: recordEffort(this.deps.router.resolve(modelId).effort),
            trial,
            cacheKey: "",
            harness: "",
            status: "queued",
            output: null,
            pass: null,
            score: null,
            details:
              "hidden" in item
                ? {
                    complexity: item.complexity,
                    ...(request.strategy === "switch"
                      ? {
                          switchChain: this.deps.router
                            .policyTargets("implement", item.complexity)
                            .sort((a, b) => a.tier - b.tier)
                            .filter((target, i, targets) => i === 0 || target.tier !== targets[i - 1]?.tier),
                        }
                      : {}),
                  }
                : {},
            costUsd: 0,
            costEquivUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            createdAt: Date.now(),
          });
    const run = this.deps.store.createEvalRun(request, trials);
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(run, file, cases, request.cache, controller.signal))
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { controller, done });
    return run;
  }

  report(id: string, options?: StatsOptions): EvalReport | null {
    const run = this.deps.store.getEvalRun(id);
    if (!run) return null;
    const trials = this.deps.store.listEvalTrials(id);
    const cascadeFallback = run.role === "triage" ? this.deps.router.decisionFallback("triage") : undefined;
    return { run, summaries: summarize(run, trials, { cascadeFallback, ...options }), trials };
  }

  /**
   * Recomputes a finished review eval's stored grades from its stored outputs against the current
   * labels. Grading is deterministic, so this needs no model calls, cache hits or spend. Trials
   * whose case left the dataset or whose output no longer parses keep their stored grade.
   */
  regrade(id: string): EvalRegradeResult | null {
    const run = this.deps.store.getEvalRun(id);
    if (!run) return null;
    if (run.role !== "review") throw new Error(`only review evals can be regraded; ${id} is ${run.role}`);
    if (run.status === "queued" || run.status === "running" || this.active.has(id))
      throw new Error(`eval ${id} is still ${run.status}; regrade it once it finishes`);
    const cases = new Map(
      loadRoleCases("review", this.casePath).cases.flatMap((item) =>
        "defects" in item ? [[item.id, item] as const] : [],
      ),
    );
    const result: EvalRegradeResult = { regraded: 0, changed: 0, skipped: [] };
    for (const trial of this.deps.store.listEvalTrials(id)) {
      if (trial.status !== "ok" || !trial.details.grade?.review) continue;
      const item = cases.get(trial.caseId);
      const output = item && storedSchemaFor(item).safeParse(trial.output);
      if (!item || !output?.success) {
        result.skipped.push({
          caseId: trial.caseId,
          modelId: recordedTarget(trial),
          trial: trial.trial,
          reason: item ? "stored output fails the review schema" : "case is no longer in the dataset",
        });
        continue;
      }
      const grade = gradeCase(item, output.data);
      result.regraded++;
      if (JSON.stringify(grade) !== JSON.stringify(trial.details.grade)) result.changed++;
      this.deps.store.recordEvalTrial({
        ...trial,
        pass: grade.pass,
        score: grade.score,
        details: { ...trial.details, grade },
      });
    }
    return result;
  }

  async wait(id: string): Promise<void> {
    await this.active.get(id)?.done;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.all([...this.active.values()].map((entry) => entry.done));
  }

  private async execute(
    run: EvalRun,
    file: AnyCaseFile,
    cases: EvalCase[],
    cache: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { store, router } = this.deps;
    store.updateEvalRun(run.id, "running");
    const trees = new Map<string, Promise<string>>();
    const implementations = new Map<string, ReturnType<typeof prepareImplement>>();
    const implementFor = (item: ImplementCase, cwd: string) => {
      const key = JSON.stringify([item.id, item.base]);
      let prepared = implementations.get(key);
      if (!prepared) {
        prepared = prepareImplement(item, cwd, signal);
        implementations.set(key, prepared);
      }
      return prepared;
    };
    const treeFor = (item: TriageCase, labels: EvalLabels) => {
      const key = JSON.stringify([item.repo, item.snapshot === true]);
      let tree = trees.get(key);
      if (!tree) {
        const sha = file.role === "triage" ? file.repos[item.repo] : undefined;
        if (!sha) throw new Error(`missing pin: ${item.repo}`);
        tree = item.snapshot
          ? this.snapshotTree(item.repo, sha, labels, signal)
          : pinnedTree(this.deps.cfg.paths, store, item.repo, sha);
        trees.set(key, tree);
      }
      return tree;
    };
    try {
      const casePath = this.casePath ?? defaultCasePath(run.role);
      const hidden = new Map(
        file.cases.flatMap((item) =>
          "hidden" in item ? [[item.id, hiddenContents(item, casePath)] as const] : [],
        ),
      );
      const labels: EvalLabels = {
        paths: run.role === "implement" ? ["evals/implement"] : LABEL_PATHS,
        contents: [
          readFileSync(casePath, "utf8"),
          ...[...hidden.values()].flatMap((files) => files.map((f) => f.content)),
          ...file.cases.flatMap((item) => ("defects" in item ? (seedContent(item, casePath) ?? []) : [])),
        ],
      };
      const groups = new Map<string, string[]>();
      for (const modelId of run.models) {
        const provider = router.model(parseTarget(modelId).modelId)?.provider ?? "unknown";
        const group = groups.get(provider) ?? [];
        group.push(modelId);
        groups.set(provider, group);
      }
      // One deterministic stream per provider; all capacity still comes from the shared tracker.
      const outcomes = await Promise.allSettled(
        [...groups.values()].map(async (models) => {
          for (const modelId of models)
            for (const item of cases) {
              for (const trial of store
                .listEvalTrials(run.id)
                .filter((t) => recordedTarget(t) === modelId && t.caseId === item.id)) {
                await this.trial(
                  run,
                  trial,
                  item,
                  treeFor,
                  implementFor,
                  labels,
                  cache,
                  signal,
                  hidden.get(item.id),
                );
              }
            }
        }),
      );
      const failed = outcomes.find((result) => result.status === "rejected");
      if (signal.aborted) throw new Error("eval interrupted by daemon shutdown");
      if (failed?.status === "rejected") throw failed.reason;
      store.updateEvalRun(run.id, store.evalSpend(run.id) >= run.maxUsd ? "budget_exhausted" : "completed");
    } catch (error) {
      store.interruptEval(run.id, (error as Error).message);
    }
  }

  /** Triage reads only a top-level listing; in snapshot mode it comes from a checked snapshot. */
  private async snapshotTree(slug: string, sha: string, labels: EvalLabels, signal: AbortSignal) {
    const { cfg, store } = this.deps;
    mkdirSync(cfg.paths.runs, { recursive: true });
    const directory = mkdtempSync(join(cfg.paths.runs, "eval-"));
    try {
      return await snapshotTopLevel(cfg.paths, store, slug, sha, join(directory, "snapshot"), signal, labels);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async trial(
    run: EvalRun,
    trial: EvalTrial,
    item: EvalCase,
    treeFor: (item: TriageCase, labels: EvalLabels) => Promise<string>,
    implementFor: (item: ImplementCase, cwd: string) => ReturnType<typeof prepareImplement>,
    labels: EvalLabels,
    cache: boolean,
    signal: AbortSignal,
    hidden: ReturnType<typeof hiddenContents> = [],
  ): Promise<void> {
    const { store, router, tracker, harnesses, cfg } = this.deps;
    const rounds = run.rounds ?? 1;
    const strategy = run.strategy ?? "retry";
    let roundStarted = 0;
    const interruptRound = (reason: string) => {
      const last = trial.details.rounds?.at(-1);
      if (last?.pass === null) {
        const elapsed = Date.now() - roundStarted;
        trial.durationMs += elapsed - last.durationMs;
        Object.assign(last, { status: signal.aborted ? "cancelled" : "error", reason, durationMs: elapsed });
      }
    };
    const skip = (reason: string, preserveRound = false) => {
      if (!preserveRound) interruptRound(reason);
      const interrupted = rounds > 1 && (trial.details.roundsUsed ?? 0) > 0;
      store.recordEvalTrial({
        ...trial,
        status: interrupted ? "error" : "skipped",
        details: {
          ...trial.details,
          ...("hidden" in item ? { roundsUsed: trial.details.roundsUsed ?? 0, stopReason: reason } : {}),
          reason,
          ...(interrupted
            ? {
                interrupted: true,
                stopReason: reason,
                grade: trial.details.grade ?? failedImplement("error", reason),
              }
            : {}),
        },
      });
    };
    const budget = () => store.evalSpend(run.id) >= run.maxUsd;
    if (signal.aborted) return skip("daemon shutdown");
    const model = router.model(trial.modelId);
    if (!model) return skip("model no longer in catalog");
    trial.details.provider = model.provider;
    const eligible = () => {
      const reason = tracker.unavailableReason(target.provider);
      return (
        (reason === "at reserve limit"
          ? (tracker.budgetUnavailableReason(target.provider) ?? reason)
          : reason) ?? tracker.modelUnavailableReason(target.modelId)
      );
    };
    if (budget()) return skip("eval budget exhausted");
    if (!tracker.def(model.provider)) return skip("unknown provider");
    // Legacy queued trials (null) and "default" both leave the backend effort unset.
    const effort = trial.effort === null || trial.effort === "default" ? undefined : trial.effort;
    if (effort !== undefined && !model.supportedEfforts.includes(effort))
      return skip("saved effort no longer supported by catalog");
    const transport = effortTransportError(
      run.role,
      { model, effort, targetId: recordedTarget(trial) },
      tracker.def(model.provider),
    );
    if (transport) return skip(transport);
    let target = router.toTarget(model, effort ?? null);
    let { harnessName, noTools } = selectHarness(run.role, target);
    trial.harness = harnessName;
    if (harnessName === "decisions") trial.details.decisionConfidence = cfg.triageDecisionConfidence;
    let release: (() => void) | undefined;
    let directory: string | undefined;
    let scratch: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      // Inside the try: a missing pin or failed snapshot fails this case's preparation, not the run.
      const tree = "gold" in item && "prompt" in item ? await treeFor(item, labels) : "";
      mkdirSync(cfg.paths.runs, { recursive: true });
      directory = mkdtempSync(join(cfg.paths.runs, "eval-"));
      const cwd = "gold" in item && "prompt" in item ? directory : join(directory, "worktree");
      const patch =
        "defects" in item ? seedContent(item, this.casePath ?? defaultCasePath(run.role)) : undefined;
      // Snapshot cases replace the pinned history, so every base-relative step uses its base.
      let effective = item;
      if (!("gold" in item && "prompt" in item)) {
        const checkout = await createEvalWorktree(
          cfg.paths,
          store,
          item.repo,
          item.base,
          "hidden" in item ? item.base : item.head,
          cwd,
          signal,
          labels,
          item.snapshot === true,
        );
        cleanup = checkout;
        if (item.snapshot) effective = { ...item, base: checkout.base };
      }
      const preparationStarted = Date.now();
      const implementation = "hidden" in effective ? await implementFor(effective, cwd) : undefined;
      const prepared =
        "hidden" in effective
          ? implementation
          : await prepareCase(
              effective,
              cwd,
              tree,
              patch,
              signal,
              cfg.reviewImplementerReport,
              cfg.triageDecisionConfidence,
            );
      if (!prepared) throw new Error("missing trial preparation");
      const preparationMs = Date.now() - preparationStarted;
      let { prompt } = prepared;
      const { timeoutMs } = prepared;
      const reviewInput = "review" in prepared ? prepared.review : undefined;
      const decisionTask = "decisionTask" in prepared ? prepared.decisionTask : undefined;
      const schema = "hidden" in item ? undefined : schemaFor(item);
      const jsonSchema = schema ? toStrictJsonSchema(schema) : undefined;
      const repository =
        "gold" in item && "prompt" in item
          ? item.snapshot
            ? { snapshot: true }
            : undefined
          : {
              role: run.role,
              repo: item.repo,
              base: item.base,
              ...("hidden" in item
                ? {
                    caseSource: item.source,
                    prompt: item.prompt,
                    spec: item.spec,
                    complexity: item.complexity,
                    hidden: item.hidden,
                    files: hidden.map((f) => ({
                      path: f.path,
                      mode: f.mode,
                      hash: new Bun.CryptoHasher("sha256").update(f.content).digest("hex"),
                    })),
                  }
                : { head: item.head, input: item.input }),
              patch,
              ...(item.snapshot ? { snapshot: true } : {}),
              source:
                store.getRepoBySlug(item.repo)?.url ?? store.getRepoBySlug(item.repo)?.localPath ?? item.repo,
            };
      trial.cacheKey = cacheKey(
        model.id,
        harnessName,
        prompt,
        FACTORY_PREAMBLE,
        jsonSchema ?? {},
        trial.trial,
        rounds > 1
          ? { ...repository, rounds, strategy, version: 2, switchChain: trial.details.switchChain }
          : repository,
        trial.effort,
      );
      if (signal.aborted) return skip("daemon shutdown");
      if (budget()) return skip("eval budget exhausted");
      // Decision calls cost ~$0.0001 and keep their declined status only when executed.
      if (cache && harnessName !== "decisions")
        for (const source of store.cachedEvalTrials(trial.cacheKey)) {
          const output =
            "hidden" in item
              ? { success: true, data: source.output }
              : storedSchemaFor(item).safeParse(source.output);
          if (!output?.success) continue;
          const grade = "hidden" in item ? source.details.grade : gradeCase(item, output.data);
          if (!grade) continue;
          store.recordEvalTrial({
            ...trial,
            status: "ok",
            harness: source.harness,
            output: output.data,
            pass: grade.pass,
            score: grade.score,
            details: {
              ...("hidden" in item ? source.details : {}),
              ...trial.details,
              grade,
              cache: source.details.cache ?? {
                evalRunId: source.evalRunId,
                caseId: source.caseId,
                costUsd: source.costUsd,
                costEquivUsd: source.costEquivUsd,
                tokensIn: source.tokensIn,
                tokensOut: source.tokensOut,
                durationMs: source.durationMs,
              },
            },
          });
          return;
        }
      const toolCommands: string[] = [];
      let sessionId: string | undefined;
      if (rounds > 1) scratch = createScratch(cwd);
      for (let round = 0; round < rounds; round++) {
        if (signal.aborted) return skip("daemon shutdown");
        if (budget()) return skip("eval budget exhausted");
        ({ harnessName, noTools } = selectHarness(run.role, target));
        const harness = harnesses[harnessName];
        if (!harness) return skip(`No harness registered for ${harnessName}`);
        const reason = eligible();
        if (reason)
          return skip(strategy === "switch" && round > 0 ? `Switch target unavailable: ${reason}` : reason);
        release = await tracker.acquire(target.provider, signal);
        if (signal.aborted) return skip("daemon shutdown");
        if (budget()) return skip("eval budget exhausted");
        const afterWait = eligible();
        if (afterWait) return skip(afterWait);
        if (round === 0) trial.createdAt = Date.now();
        roundStarted = Date.now();
        trial.harness = harnessName;
        store.recordEvalTrial({ ...trial, status: "running" });
        let result: AgentResult;
        let resumeFailed = false;
        const before = { ...trial };
        for (let attempt = 0; ; attempt++) {
          try {
            const logPath = join(directory, "trial.log");
            const invoke = (scratchDir?: string, request = { prompt, jsonSchema, schema, timeoutMs }) =>
              harness({
                scratchDir,
                ...(sessionId ? { resumeSessionId: sessionId } : {}),
                cwd,
                ...request,
                decisionTask,
                systemAppend: FACTORY_PREAMBLE,
                target,
                mode: "hidden" in item ? "edit" : "readonly",
                noTools,
                privateSession: run.role === "verify",
                idleTimeoutMs: 10 * 60_000,
                maxToolCalls: "hidden" in item ? 400 : 150,
                signal,
                logPath,
                onEvent: (event) => {
                  if (
                    event.type === "tool_call" &&
                    event.input &&
                    typeof event.input === "object" &&
                    "command" in event.input &&
                    typeof event.input.command === "string"
                  )
                    toolCommands.push(event.input.command);
                  if (event.type === "rate_limit") tracker.observeWindows(target.provider, event.windows);
                },
              });
            const send = (request?: ReviewRequest) =>
              noTools
                ? invoke(undefined, request)
                : scratch
                  ? invoke(scratch, request)
                  : withScratch(cwd, (dir) => invoke(dir, request));
            // First-round review cases go through the pipeline's review entry point.
            result = reviewInput
              ? (
                  await runReview(
                    { invoke: async (request) => ({ result: await send(request) }) },
                    reviewInput,
                  )
                ).result
              : await send();
          } catch (error) {
            result = {
              status: signal.aborted ? "cancelled" : "error",
              finalText: "",
              structured: null,
              sessionId: null,
              usage: emptyUsage(),
              numTurns: 0,
              costUsd: 0,
              costEquivUsd: 0,
              error: (error as Error).message,
              quota: null,
            };
          }
          trial.costUsd += result.costUsd;
          trial.costEquivUsd += result.costEquivUsd;
          trial.tokensIn += result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
          trial.tokensOut += result.usage.output;
          if (sessionId && attempt === 0 && result.status === "error" && !signal.aborted) {
            resumeFailed = true;
            sessionId = undefined;
            store.recordEvalTrial({ ...trial, status: "running" });
            if (!budget()) continue;
          }
          break;
        }
        release?.();
        release = undefined;
        trial.output = "hidden" in item ? result.finalText : result.structured;
        const roundEvidence = {
          round,
          harness: harnessName,
          resumeFailed,
          provider: target.provider,
          modelId: target.modelId,
          effort: recordEffort(target.effort),
          status: result.status,
          pass: null as boolean | null,
          reason: result.error,
          costUsd: trial.costUsd - before.costUsd,
          costEquivUsd: trial.costEquivUsd - before.costEquivUsd,
          tokensIn: trial.tokensIn - before.tokensIn,
          tokensOut: trial.tokensOut - before.tokensOut,
          durationMs: Date.now() - roundStarted,
        };
        if ("hidden" in item) {
          trial.details.rounds ??= [];
          trial.details.rounds.push(roundEvidence);
          trial.details.roundsUsed = round + 1;
          trial.durationMs = Date.now() - trial.createdAt + preparationMs;
          store.recordEvalTrial({ ...trial, status: "running" });
        }
        if (result.quota) tracker.observeWindows(target.provider, result.quota.windows);
        tracker.record(target.provider, result.status, {
          error: result.error,
          exhaustedUntil: result.quota?.exhaustedUntil,
          ...(result.modelCooldownMs === undefined
            ? {}
            : { modelCooldown: { modelId: target.modelId, ms: result.modelCooldownMs } }),
        });
        if (
          result.status !== "ok" &&
          /model[^.]{0,80}(is not supported|not found|does not exist|not available)|unknown model|invalid model|model_not_found/i.test(
            result.error ?? "",
          )
        )
          tracker.blockModel(target.modelId, result.error ?? "model rejected");
        if (signal.aborted) return skip("daemon shutdown");
        const output = schema?.safeParse(result.structured ?? extractJson(result.finalText));
        // A declined decision answer is still graded; details.invocationStatus records the escalation.
        const answered = result.status === "ok" || result.status === "declined";
        const ok = answered && ("hidden" in item || output?.success === true);
        const grade =
          "hidden" in effective && implementation
            ? result.status === "ok"
              ? await gradeImplement(
                  effective,
                  cwd,
                  hidden,
                  implementation,
                  toolCommands,
                  signal,
                  round + 1 < rounds,
                )
              : failedImplement(result.status === "timeout" ? "timeout" : "error", result.error ?? undefined)
            : ok && output?.success && !("hidden" in item)
              ? gradeCase(item, output.data)
              : undefined;
        if (
          result.status === "ok" &&
          (grade?.implement?.reason === "error" || grade?.implement?.reason === "timeout")
        )
          roundEvidence.status = grade.implement.reason;
        roundEvidence.reason =
          (roundEvidence.status !== "ok" ? (grade?.implement?.error ?? result.error) : null) ??
          grade?.implement?.reason ??
          result.error;
        roundEvidence.durationMs = Date.now() - roundStarted;
        if (round > 0 && roundEvidence.status !== "ok" && roundEvidence.status !== "timeout") {
          trial.durationMs = Date.now() - trial.createdAt + preparationMs;
          return skip("operational failure", true);
        }
        roundEvidence.pass = grade?.pass ?? false;
        trial = {
          ...trial,
          status:
            ok && grade?.implement?.reason !== "error" && grade?.implement?.reason !== "timeout"
              ? "ok"
              : "error",
          output: "hidden" in item ? result.finalText : output?.success ? output.data : result.structured,
          pass: grade ? grade.pass : false,
          score: grade ? grade.score : 0,
          details: {
            ...trial.details,
            grade,
            invocationStatus: result.status,
            reason:
              grade?.implement?.reason ??
              (ok
                ? undefined
                : (result.error ??
                  (output?.success
                    ? result.status
                    : `Invalid ${run.role} output: ${output?.error.message}`))),
          },
          durationMs: Date.now() - trial.createdAt + ("hidden" in item ? preparationMs : 0),
        };
        const taskFailure =
          grade?.implement && ["gates", "audit", "hidden_tests"].includes(grade.implement.reason ?? "");
        trial.details.stopReason = grade?.pass
          ? "success"
          : !taskFailure
            ? "operational failure"
            : "round limit";
        if (taskFailure && round + 1 < rounds && "hidden" in effective && implementation && grade) {
          const next = nextImplementTarget(router, trial.details.switchChain, target, strategy);
          if (next) {
            store.recordEvalTrial({ ...trial, status: "running" });
            prompt = implementRetryPrompt(effective, implementation, grade, round + 1);
            sessionId = strategy === "switch" ? undefined : (result.sessionId ?? undefined);
            target = next;
            continue;
          }
          trial.details.stopReason = "strategy exhausted";
        }
        store.recordEvalTrial(trial);
        break;
      }
    } catch (error) {
      if (signal.aborted) return skip("daemon shutdown");
      if (trial.details.grade) return skip((error as Error).message);
      interruptRound((error as Error).message);
      store.recordEvalTrial({
        ...trial,
        status: "error",
        pass: false,
        score: 0,
        details: {
          ...trial.details,
          preparationFailed: !trial.details.roundsUsed,
          ...("hidden" in item
            ? { roundsUsed: trial.details.roundsUsed ?? 0, stopReason: "operational failure" }
            : {}),
          reason: (error as Error).message,
          ...("hidden" in item ? { grade: failedImplement("error", (error as Error).message) } : {}),
        },
      });
    } finally {
      release?.();
      if (scratch) removeScratch(scratch);
      try {
        await cleanup?.();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}
