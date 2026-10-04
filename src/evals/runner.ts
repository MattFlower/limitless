import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EVAL_CONCURRENCY, type EvalRun, type EvalTrial } from "../core/types.ts";
import { Semaphore } from "../gates/slots.ts";
import { createEvalWorktree, type EvalLabels, pinnedTree, snapshotTopLevel } from "../git/repos.ts";
import { confinementScope, seatbeltBackend } from "../harness/sandbox.ts";
import { createScratch, removeScratch, withScratch } from "../harness/scratch.ts";
import { selectHarness } from "../harness/select.ts";
import {
  type AgentResult,
  type AgentSpec,
  emptyUsage,
  extractJson,
  type ModelTarget,
} from "../harness/types.ts";
import type { EngineDeps } from "../pipeline/context.ts";
import { FACTORY_PREAMBLE } from "../pipeline/prompts.ts";
import {
  combined,
  FinderSkipped,
  mapVerifier,
  panelIdentity,
  pickVerifier,
  type ReviewRequest,
  runReview,
  type VerifierRequest,
} from "../pipeline/review.ts";
import { StoredReviewSchema, toStrictJsonSchema } from "../pipeline/schemas.ts";
import { effortTransportError, parseTarget, recordEffort, recordedTarget } from "../router/targets.ts";
import { redactCredentials } from "../util/proc.ts";
import { cacheKey, reviewSystemHash } from "./cache.ts";
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
import { gradeReview } from "./graders/review.ts";
import {
  failedImplement,
  gradeImplement,
  implementRetryPrompt,
  nextImplementTarget,
  prepareImplement,
  RETRY_FEEDBACK_GRADE,
} from "./implement.ts";
import { gradeCase, prepareCase, schemaFor, seedContent, storedSchemaFor } from "./prepare.ts";
import { replayFinders, validateReplay } from "./replay.ts";
import { type EvalReport, type StatsOptions, summarize } from "./stats.ts";

/** The abort reason of `eval cancel`; any other abort is a daemon shutdown. */
const CANCELLED = "cancelled";
const stopReason = (signal: AbortSignal) => (signal.reason === CANCELLED ? CANCELLED : "daemon shutdown");

type SwitchChain = NonNullable<EvalTrial["details"]["switchChain"]>;
/** What `eval resume` replays: the explicit request and each implement case's frozen switch chain. */
interface StoredEvalRequest {
  request: Record<string, unknown>;
  switchChains?: Record<string, SwitchChain>;
}
/** What `eval resume` continues from. */
interface ResumeFrom {
  from: string;
  switchChains?: Record<string, SwitchChain>;
}
const trialKey = (trial: EvalTrial) =>
  JSON.stringify([trial.caseId, recordedTarget(trial), trial.trial, trial.details.system ?? null]);

/** Where Limitless keeps eval datasets; pins whose history touches these are rejected. */
const LABEL_PATHS = ["evals/triage", "evals/review", "evals/verify", "evals/implement"];

/** A stored trial graded against its case's current labels; null when its output no longer parses. */
function regraded(
  item: Exclude<EvalCase, ImplementCase>,
  trial: EvalTrial,
  causalAttribution = false,
): EvalTrial | null {
  const output = storedSchemaFor(item).safeParse(trial.output);
  if (!output.success) return null;
  const grade = gradeCase(item, output.data, causalAttribution);
  return { ...trial, pass: grade.pass, score: grade.score, details: { ...trial.details, grade } };
}

export interface EvalRegradeResult {
  regraded: number;
  /** Regraded trials whose grade differs from the stored one. */
  changed: number;
  skipped: { caseId: string; modelId: string; trial: number; reason: string }[];
}

interface TrialCoordination {
  /** Takes this run's and every eval's per-provider cap, before the tracker slot; one release. */
  slot: (provider: string) => Promise<() => void>;
  /** Publishes the trial's cache key and waits for earlier trials that share it. */
  keyed: (key: string) => Promise<void>;
}

export class EvalRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopping = false;
  /** Per-provider cap shared by all eval runs, so production work keeps a slot where the provider has two or more. */
  private readonly evalSlots = new Map<string, Semaphore>();
  /** Requested concurrency of each executing run, which sizes `evalSlots`. */
  private readonly executing = new Map<string, number>();
  constructor(
    private readonly deps: EngineDeps,
    private readonly casePath?: string,
  ) {
    deps.store.recoverEvals();
  }

  submit(input: unknown, resume?: ResumeFrom): EvalRun {
    if (this.stopping) throw new Error("daemon is stopping");
    // Reject unsupported roles before accessing any dataset or repository.
    const parsed = EvalRequestSchema.parse(input);
    const file = loadRoleCases(parsed.role, this.casePath);
    for (const item of file.cases)
      if ("defects" in item) seedContent(item, this.casePath ?? defaultCasePath(parsed.role));
    const { request, cases } = validateRequest(input, file, this.deps.router, this.deps.cfg.reviewRosters);
    if (request.replayFinders)
      validateReplay(
        this.deps.store,
        request.replayFinders,
        request.systems ?? [],
        (id) => this.deps.router.model(parseTarget(id).modelId)?.vendor,
      );
    // The selected cases, resolved targets and expanded systems, so a resume replays exactly these
    // trials; an unset effort is stored as `@default` so today's model default cannot change it.
    const explicit = (target = "") =>
      parseTarget(target).effort === undefined ? `${target}@default` : target;
    const replay = {
      ...parsed,
      caseIds: cases.map((item) => item.id),
      ...(parsed.systems
        ? {
            systems: request.systems?.map((system) => ({
              ...system,
              finders: system.finders.map((finder) => ({ ...finder, target: explicit(finder.target) })),
              ...(system.verifier ? { verifier: mapVerifier(system.verifier, explicit) } : {}),
            })),
          }
        : { models: request.models.map((target) => explicit(target)) }),
    };
    const trials: EvalTrial[] = [];
    const candidates =
      request.systems?.map((system) => ({ modelId: system.finders[0]?.target ?? "", system: system.name })) ??
      request.models.map((modelId) => ({ modelId, system: undefined }));
    for (const { modelId, system } of candidates)
      for (const item of cases)
        for (let trial = 0; trial < request.k; trial++)
          trials.push({
            evalRunId: "",
            caseId: item.id,
            modelId: parseTarget(modelId).modelId,
            // A resolved target names its effort unless it is unset; never re-resolve today's default.
            effort:
              parseTarget(modelId).effort === undefined
                ? "default"
                : recordEffort(this.deps.router.resolve(modelId).effort),
            trial,
            cacheKey: "",
            harness: "",
            status: "queued",
            output: null,
            pass: null,
            score: null,
            details:
              system !== undefined
                ? { system }
                : "hidden" in item
                  ? {
                      complexity: item.complexity,
                      ...(request.strategy === "switch"
                        ? {
                            // A resume keeps its predecessor's chain, which is part of the cache key.
                            switchChain:
                              resume?.switchChains?.[item.id] ??
                              this.deps.router
                                .policyTargets("implement", item.complexity)
                                .sort((a, b) => a.tier - b.tier)
                                .filter(
                                  (target, i, targets) => i === 0 || target.tier !== targets[i - 1]?.tier,
                                ),
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
    // The resume chain's finished trials, latest first. A trial copies one only if its cache key is
    // unchanged, so a resumed eval never mixes versions; preparation failures run again.
    const predecessors = new Map<string, EvalTrial>();
    for (let id = resume?.from; id; id = this.deps.store.getEvalRun(id)?.resumedFrom)
      for (const trial of this.deps.store.listEvalTrials(id))
        if ((trial.status === "ok" || trial.status === "error") && !trial.details.preparationFailed)
          if (!predecessors.has(trialKey(trial))) predecessors.set(trialKey(trial), trial);
    const switchChains = Object.fromEntries(
      trials.flatMap((t) => (t.details.switchChain ? [[t.caseId, t.details.switchChain]] : [])),
    );
    const stored: StoredEvalRequest = {
      request: replay,
      ...(trials.some((t) => t.details.switchChain) ? { switchChains } : {}),
    };
    const run = this.deps.store.createEvalRun(request, trials, stored, resume?.from);
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(run, file, cases, request.cache, controller.signal, predecessors))
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { controller, done });
    return run;
  }

  /**
   * Resubmits an interrupted or failed eval's stored request unchanged as a new linked run that
   * copies finished trials whose cache key is unchanged, regraded; the rest run again.
   */
  resume(id: string): EvalRun | null {
    const run = this.deps.store.getEvalRun(id);
    if (!run) return null;
    if (this.active.has(id) || run.status === "queued" || run.status === "running")
      throw new Error(`eval ${id} is still ${run.status}; cancel it before resuming`);
    if (run.resumedBy) throw new Error(`eval ${id} was already resumed as ${run.resumedBy}`);
    if (run.status !== "interrupted" && run.status !== "failed")
      throw new Error(`eval ${id} is ${run.status}; only interrupted or failed evals can be resumed`);
    // Written only by `submit`, so its shape is trusted; the request itself is revalidated below.
    const stored = this.deps.store.evalRequest(id) as StoredEvalRequest | null;
    if (!stored?.request)
      throw new Error(
        `eval ${id} predates stored eval requests and cannot be reconstructed; submit it again`,
      );
    if (stored.request.cache === false)
      throw new Error(`eval ${id} ran with the cache disabled; submit it again for a fresh measurement`);
    try {
      for (const [caseId, chain] of Object.entries(stored.switchChains ?? {}))
        for (const target of chain)
          try {
            this.deps.router.resolveFor("implement", target);
          } catch (error) {
            throw new Error(
              `case ${caseId} switch chain target ${target.modelId}: ${(error as Error).message}`,
            );
          }
      return this.submit(stored.request, { from: id, switchChains: stored.switchChains });
    } catch (error) {
      throw new Error(`cannot resume eval ${id}: ${(error as Error).message}`);
    }
  }

  /** Stops scheduling an eval's trials; in-flight trials abort and the run ends interrupted. */
  async cancel(id: string): Promise<EvalRun | null> {
    const run = this.deps.store.getEvalRun(id);
    const entry = this.active.get(id);
    if (!run) return null;
    if (!entry) throw new Error(`eval ${id} is ${run.status}, not running`);
    entry.controller.abort(CANCELLED);
    await entry.done;
    return this.deps.store.getEvalRun(id);
  }

  report(id: string, options?: StatsOptions): EvalReport | null {
    const run = this.deps.store.getEvalRun(id);
    if (!run) return null;
    const trials = this.deps.store.listEvalTrials(id);
    const cascadeFallback = run.role === "triage" ? this.deps.router.decisionFallback("triage") : undefined;
    const reviewCases =
      run.role === "review"
        ? loadRoleCases("review", this.casePath).cases.flatMap((item) => ("defects" in item ? [item] : []))
        : [];
    const labels = { reviewCases, reviewGrader: gradeReview };
    return { run, summaries: summarize(run, trials, { cascadeFallback, ...labels, ...options }), trials };
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
      const updated =
        item &&
        regraded(item, trial, run.systems?.find((s) => s.name === trial.details.system)?.causalAttribution);
      if (!item || !updated) {
        result.skipped.push({
          caseId: trial.caseId,
          modelId: recordedTarget(trial),
          trial: trial.trial,
          reason: item ? "stored output fails the review schema" : "case is no longer in the dataset",
        });
        continue;
      }
      result.regraded++;
      if (JSON.stringify(updated.details.grade) !== JSON.stringify(trial.details.grade)) result.changed++;
      this.deps.store.recordEvalTrial(updated);
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

  /** Evals leave one of a provider's slots to production (none to spare when its max is 1). */
  private evalLimit(provider: string, concurrency: number): number {
    return Math.max(1, Math.min(concurrency, (this.deps.tracker.def(provider)?.maxConcurrent ?? 1) - 1));
  }

  private resizeEvalSlots(): void {
    const largest = Math.max(1, ...this.executing.values());
    for (const [provider, semaphore] of this.evalSlots) semaphore.setLimit(this.evalLimit(provider, largest));
  }

  private evalSlot(provider: string): Semaphore {
    let semaphore = this.evalSlots.get(provider);
    if (!semaphore) {
      semaphore = new Semaphore(this.evalLimit(provider, Math.max(1, ...this.executing.values())));
      this.evalSlots.set(provider, semaphore);
    }
    return semaphore;
  }

  private async execute(
    run: EvalRun,
    file: AnyCaseFile,
    cases: EvalCase[],
    cache: boolean,
    signal: AbortSignal,
    predecessors: Map<string, EvalTrial>,
  ): Promise<void> {
    this.executing.set(run.id, run.concurrency ?? DEFAULT_EVAL_CONCURRENCY);
    this.resizeEvalSlots();
    try {
      await confinementScope.run(this.deps.confinement ?? seatbeltBackend, () =>
        this.executeRun(run, file, cases, cache, signal, predecessors),
      );
    } finally {
      this.executing.delete(run.id);
      this.resizeEvalSlots();
    }
  }

  private async executeRun(
    run: EvalRun,
    file: AnyCaseFile,
    cases: EvalCase[],
    cache: boolean,
    signal: AbortSignal,
    predecessors: Map<string, EvalTrial>,
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
      const recorded = store.listEvalTrials(run.id);
      const concurrency = run.concurrency ?? DEFAULT_EVAL_CONCURRENCY;
      const providerLimit = (provider: string) => this.evalLimit(provider, concurrency);
      // Caps this run's invocations per provider, including panel members and switched retry
      // rounds that leave the trial's starting provider group, then the cap shared by all evals.
      const gates = new Map<string, Semaphore>();
      const slot = async (provider: string) => {
        let gate = gates.get(provider);
        if (!gate) {
          gate = new Semaphore(providerLimit(provider));
          gates.set(provider, gate);
        }
        const own = await gate.acquire(signal);
        try {
          const shared = await this.evalSlot(provider).acquire(signal);
          return () => {
            shared();
            own();
          };
        } catch (error) {
          own();
          throw error;
        }
      };
      // Each provider starts its trials in a fixed order, up to `limit` at once. Every invocation
      // still acquires a slot from the shared tracker, and each trial checks the eval budget before
      // it starts, so trials already in flight can overshoot `maxUsd` by at most limit - 1 trials
      // per provider. Trial identity and cache keys never depend on completion order.
      const outcomes = await Promise.allSettled(
        [...groups.entries()].map(async ([provider, models]) => {
          const queue = models.flatMap((modelId) =>
            cases.flatMap((item) =>
              recorded
                .filter((t) => t.status === "queued" && recordedTarget(t) === modelId && t.caseId === item.id)
                .map((trial) => ({ trial, item })),
            ),
          );
          const limit = providerLimit(provider);
          // Resolved with each trial's cache key (null if it never got one) and when it finishes.
          const keys = queue.map(() => Promise.withResolvers<string | null>());
          const finished = queue.map(() => Promise.withResolvers<void>());
          let next = 0;
          let failed = false;
          const worker = async () => {
            while (!failed && !signal.aborted) {
              const index = next++;
              const entry = queue[index];
              if (!entry) return;
              // A trial waits for every earlier trial with its cache key, so cache reuse sees the
              // same sources as the sequential order regardless of which trial finishes first.
              const coordination: TrialCoordination = {
                slot,
                keyed: async (key) => {
                  keys[index]?.resolve(key);
                  for (let i = 0; i < index; i++)
                    if ((await keys[i]?.promise) === key) await finished[i]?.promise;
                },
              };
              try {
                await this.trial(
                  run,
                  entry.trial,
                  entry.item,
                  treeFor,
                  implementFor,
                  labels,
                  cache,
                  signal,
                  coordination,
                  hidden.get(entry.item.id),
                  predecessors.get(trialKey(entry.trial)),
                );
              } catch (error) {
                // Like the sequential stream: an unexpected failure stops this provider's new trials.
                failed = true;
                throw error;
              } finally {
                keys[index]?.resolve(null);
                finished[index]?.resolve();
              }
            }
          };
          const results = await Promise.allSettled(Array.from({ length: limit }, worker));
          const rejected = results.find((result) => result.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
        }),
      );
      const failed = outcomes.find((result) => result.status === "rejected");
      if (signal.aborted) throw new Error("eval aborted");
      if (failed?.status === "rejected") throw failed.reason;
      store.updateEvalRun(run.id, store.evalSpend(run.id) >= run.maxUsd ? "budget_exhausted" : "completed");
    } catch (error) {
      if (signal.aborted)
        store.interruptEval(
          run.id,
          signal.reason === CANCELLED ? "eval cancelled" : "eval interrupted by daemon shutdown",
        );
      else store.interruptEval(run.id, (error as Error).message, "failed");
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
    coordination: TrialCoordination,
    hidden: ReturnType<typeof hiddenContents> = [],
    predecessor?: EvalTrial,
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
      const started = rounds > 1 && (trial.details.roundsUsed ?? 0) > 0;
      // A cancel or shutdown leaves the trial unscored; its rounds and spend remain as evidence.
      const interrupted = started && !signal.aborted;
      const { grade, ...details } = trial.details;
      store.recordEvalTrial({
        ...trial,
        status: interrupted ? "error" : "skipped",
        ...(signal.aborted ? { pass: null, score: null } : {}),
        details: {
          ...details,
          ...(grade && !signal.aborted ? { grade } : {}),
          ...("hidden" in item ? { roundsUsed: trial.details.roundsUsed ?? 0, stopReason: reason } : {}),
          reason,
          ...(started ? { interrupted: true, stopReason: reason } : {}),
          ...(interrupted ? { grade: grade ?? failedImplement("error", reason) } : {}),
        },
      });
    };
    const budget = () => store.evalSpend(run.id) >= run.maxUsd;
    if (signal.aborted) return skip(stopReason(signal));
    const system =
      trial.details.system === undefined
        ? undefined
        : run.systems?.find((s) => s.name === trial.details.system);
    if (trial.details.system !== undefined && !system) return skip("review system missing from eval run");
    const model = router.model(trial.modelId);
    if (!model) return skip("model no longer in catalog");
    trial.details.provider = model.provider;
    const unavailable = (to: ModelTarget) => {
      const reason = tracker.unavailableReason(to.provider);
      return (
        (reason === "at reserve limit" ? (tracker.budgetUnavailableReason(to.provider) ?? reason) : reason) ??
        tracker.modelUnavailableReason(to.modelId)
      );
    };
    const replayId = (store.evalRequest(run.id) as StoredEvalRequest | null)?.request.replayFinders;
    const eligible = () => (typeof replayId === "string" ? null : unavailable(target));
    // A copy costs nothing, so the budget is checked once its cache key is known.
    if (!predecessor && budget()) return skip("eval budget exhausted");
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
      const replay =
        typeof replayId === "string" && system
          ? replayFinders(store, replayId, system, item.id, trial.trial)
          : undefined;
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
              system?.implementerReport,
              cfg.triageDecisionConfidence,
            );
      if (!prepared) throw new Error("missing trial preparation");
      const preparationMs = Date.now() - preparationStarted;
      let { prompt } = prepared;
      const { timeoutMs } = prepared;
      const reviewInput =
        "review" in prepared && prepared.review
          ? { ...prepared.review, ...(system ? { system } : {}) }
          : undefined;
      const decisionTask = "decisionTask" in prepared ? prepared.decisionTask : undefined;
      // Panel targets beyond the trial's own (its first finder) are pinned in the system. A bare
      // target is an unset effort, which today's model default must not restore (as for the trial).
      const pinned = (id = "") => {
        const { model: pinnedModel, effort: pinnedEffort } = router.resolve(
          parseTarget(id).effort === undefined ? { modelId: id, effort: null } : id,
        );
        return router.toTarget(pinnedModel, pinnedEffort ?? null);
      };
      const panelTargets =
        system?.mode === "panel"
          ? {
              finders: system.finders.slice(1).map((f) => pinned(f.target)),
              verifiers: (system.verifier?.targets ?? [system.verifier?.target]).map((t) => pinned(t)),
            }
          : undefined;
      // A replay makes no finder calls, so it waits on its verifiers instead of the trial's target:
      // an unavailable one skips the trial (resumable) rather than failing it.
      const gate = () =>
        typeof replayId === "string"
          ? ((panelTargets?.verifiers ?? []).map(unavailable).find(Boolean) ?? null)
          : eligible();
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
              ...(replay ? { replay: replay.identity } : {}),
              ...(system ? { reviewSystem: reviewSystemHash(system) } : {}),
              ...(system?.mode === "panel" ? { panel: panelIdentity(system.causalAttribution) } : {}),
              patch,
              ...(item.snapshot ? { snapshot: true } : {}),
              source:
                store.getRepoBySlug(item.repo)?.url ?? store.getRepoBySlug(item.repo)?.localPath ?? item.repo,
            };
      // Every target the trial may call, resolved now: later rounds' targets, then panel members.
      const targets: (ModelTarget | null)[] = [target];
      for (let last = targets.at(-1); last && targets.length < rounds; last = targets.at(-1)) {
        try {
          targets.push(nextImplementTarget(router, trial.details.switchChain, last, strategy) ?? null);
        } catch {
          targets.push(null);
        }
      }
      if (panelTargets) targets.push(...panelTargets.finders, ...panelTargets.verifiers);
      trial.cacheKey = cacheKey(
        model.id,
        harnessName,
        prompt,
        FACTORY_PREAMBLE,
        jsonSchema ?? {},
        trial.trial,
        rounds > 1
          ? {
              ...repository,
              rounds,
              strategy,
              version: 2,
              switchChain: trial.details.switchChain,
              // Every later round's prompt template, which the initial prompt never renders and
              // which may branch on the round number.
              retryPrompts:
                "hidden" in effective && implementation
                  ? Array.from({ length: rounds - 1 }, (_, round) =>
                      [failedImplement("error"), RETRY_FEEDBACK_GRADE].map((grade) =>
                        implementRetryPrompt(effective, implementation, grade, round + 1),
                      ),
                    )
                  : null,
            }
          : repository,
        trial.effort,
        targets.map(
          (to) => to && [to.provider, to.model, selectHarness(run.role, to).harnessName, to.effort ?? null],
        ),
      );
      if (predecessor?.cacheKey === trial.cacheKey) {
        const copy =
          predecessor.status === "ok" && !("hidden" in item)
            ? (regraded(item, predecessor, system?.causalAttribution) ?? predecessor)
            : predecessor;
        return store.recordEvalTrial({
          ...copy,
          evalRunId: run.id,
          details: { ...copy.details, resumedFrom: copy.details.resumedFrom ?? copy.evalRunId },
        });
      }
      if (cache) await coordination.keyed(trial.cacheKey);
      if (signal.aborted) return skip(stopReason(signal));
      if (budget()) return skip("eval budget exhausted");
      // Decision calls cost ~$0.0001 and keep their declined status only when executed.
      if (cache && harnessName !== "decisions")
        for (const source of store.cachedEvalTrials(trial.cacheKey)) {
          const output =
            "hidden" in item
              ? { success: true, data: source.output }
              : storedSchemaFor(item).safeParse(source.output);
          if (!output?.success) continue;
          const grade =
            "hidden" in item ? source.details.grade : gradeCase(item, output.data, system?.causalAttribution);
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
              // A reused trial spends no tokens of its own, so its cache split follows the tokensIn
              // it records (zero here); inheriting the source's would report more cache than prompt.
              cacheReadTokens: trial.details.cacheReadTokens ?? 0,
              cacheWriteTokens: trial.details.cacheWriteTokens ?? 0,
              ...(source.details.fast === undefined ? {} : { fast: source.details.fast }),
              ...(source.details.verifiers ? { verifiers: source.details.verifiers } : {}),
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
      for (let round = 0; round < rounds; round++) {
        if (scratch) removeScratch(scratch);
        scratch = undefined;
        if (signal.aborted) return skip(stopReason(signal));
        if (budget()) return skip("eval budget exhausted");
        ({ harnessName, noTools } = selectHarness(run.role, target));
        const harness = harnesses[harnessName];
        if (!harness) return skip(`No harness registered for ${harnessName}`);
        const reason = gate();
        if (reason)
          return skip(strategy === "switch" && round > 0 ? `Switch target unavailable: ${reason}` : reason);
        const runSlot = replay ? () => {} : await coordination.slot(target.provider);
        release = runSlot;
        const trackerSlot = replay ? () => {} : await tracker.acquire(target.provider, signal);
        release = () => {
          trackerSlot();
          runSlot();
        };
        if (signal.aborted) return skip(stopReason(signal));
        if (budget()) return skip("eval budget exhausted");
        const afterWait = gate();
        if (afterWait) return skip(afterWait);
        if (rounds > 1 || "hidden" in item) scratch = createScratch(cwd);
        if (round === 0) trial.createdAt = Date.now();
        roundStarted = Date.now();
        trial.harness = harnessName;
        store.recordEvalTrial({ ...trial, status: "running" });
        let result: AgentResult;
        // The trial target's own call within a panel review, recorded against its provider.
        let own: AgentResult | undefined;
        const observe = (to: ModelTarget, outcome: AgentResult) => {
          if (outcome.quota) tracker.observeWindows(to.provider, outcome.quota.windows);
          tracker.record(to.provider, outcome.status, {
            error: outcome.error,
            exhaustedUntil: outcome.quota?.exhaustedUntil,
            ...(outcome.modelCooldownMs === undefined
              ? {}
              : { modelCooldown: { modelId: to.modelId, ms: outcome.modelCooldownMs } }),
          });
          if (
            outcome.status !== "ok" &&
            /model[^.]{0,80}(is not supported|not found|does not exist|not available)|unknown model|invalid model|model_not_found/i.test(
              outcome.error ?? "",
            )
          )
            tracker.blockModel(to.modelId, outcome.error ?? "model rejected");
        };
        let resumeFailed = false;
        const before = { ...trial };
        for (let attempt = 0; ; attempt++) {
          own = undefined;
          // Panel calls that returned, so spend survives a later member's failure.
          const spent: AgentResult[] = [];
          try {
            const logPath = join(directory, "trial.log");
            const invoke = (
              scratchDir?: string,
              request: Pick<AgentSpec, "prompt" | "jsonSchema" | "schema" | "timeoutMs"> = {
                prompt,
                jsonSchema,
                schema,
                timeoutMs,
              },
              to = { target, harness, noTools },
              log = logPath,
            ) => {
              const fast = tracker.isFast(to.target.provider);
              if (to.target.modelId === target.modelId) trial.details.fast = fast;
              return to.harness({
                fast,
                scratchDir,
                ...(sessionId ? { resumeSessionId: sessionId } : {}),
                cwd,
                ...request,
                decisionTask,
                systemAppend: FACTORY_PREAMBLE,
                target: to.target,
                mode: "hidden" in item ? "edit" : "readonly",
                noTools: to.noTools,
                privateSession: run.role === "verify",
                idleTimeoutMs: 10 * 60_000,
                maxToolCalls: "hidden" in item ? 400 : 150,
                signal,
                logPath: log,
                onEvent: (event) => {
                  if (
                    event.type === "tool_call" &&
                    event.input &&
                    typeof event.input === "object" &&
                    "command" in event.input &&
                    typeof event.input.command === "string"
                  )
                    toolCommands.push(event.input.command);
                  if (event.type === "rate_limit") tracker.observeWindows(to.target.provider, event.windows);
                },
              });
            };
            const send = (
              request?: ReviewRequest | VerifierRequest,
              to = { target, harness, noTools },
              log = logPath,
            ) =>
              to.noTools
                ? invoke(undefined, request, to, log)
                : scratch
                  ? invoke(scratch, request, to, log)
                  : withScratch(cwd, (dir) => invoke(dir, request, to, log));
            // Panel members run in parallel, so each call logs (and keeps a schema file) of its own.
            let verifications = 0;
            // Never hold one provider's slot while waiting for another panel member's provider.
            const sendTo = async (request: ReviewRequest | VerifierRequest, to: ModelTarget, log: string) => {
              const picked = selectHarness(run.role, to);
              const agent = harnesses[picked.harnessName];
              if (!agent) throw new Error(`No harness registered for ${picked.harnessName}`);
              const check = () => {
                if (signal.aborted) throw new Error("daemon shutdown");
                const reason = unavailable(to);
                if (reason) throw new Error(`${to.provider} unavailable: ${reason}`);
              };
              check();
              const releaseEval = await coordination.slot(to.provider);
              try {
                const releaseOther = await tracker.acquire(to.provider, signal);
                try {
                  // Quota, a circuit breaker or the reserve may have closed the provider during the wait.
                  check();
                  const sent = await send(
                    request,
                    { target: to, harness: agent, noTools: picked.noTools },
                    `${logPath}.${log}`,
                  );
                  spent.push(sent);
                  observe(to, sent);
                  return { result: sent, target: to };
                } finally {
                  releaseOther();
                }
              } finally {
                releaseEval();
              }
            };
            // First-round review cases go through the pipeline's review entry point.
            result = reviewInput
              ? (
                  await runReview(
                    {
                      invoke: async (request, finder) => {
                        if (replay) {
                          release?.();
                          release = undefined;
                          const stored = replay.invoke(finder);
                          const to = finder === 0 ? target : panelTargets?.finders[finder - 1];
                          if (!to || !stored.vendor)
                            throw new Error(`replay finder ${finder} identity missing`);
                          return { result: stored.result, target: { ...to, vendor: stored.vendor } };
                        }
                        const to = finder > 0 ? panelTargets?.finders[finder - 1] : undefined;
                        // As in production, a local finder that cannot run is skipped, not a failed panel.
                        if (to)
                          return sendTo(request, to, `finder-${finder}`).catch((error: Error) => {
                            if (signal.aborted || !system?.finders[finder]?.local) throw error;
                            throw new FinderSkipped(error.message);
                          });
                        try {
                          own = await send(request);
                          spent.push(own);
                        } finally {
                          if (panelTargets) {
                            release?.();
                            release = undefined;
                          }
                        }
                        return { result: own, target };
                      },
                      verify: async (request, avoidVendors, avoidModels, candidates) => {
                        if (!panelTargets) throw new Error("review system has no verifier");
                        // A shared vendor is allowed and recorded by the panel, as in production.
                        const identity = this.deps.router.checkpointIdentity;
                        const to = pickVerifier(panelTargets.verifiers, avoidVendors, avoidModels, identity);
                        const { modelId, effort } = to;
                        trial.details.verifiers ??= [];
                        trial.details.verifiers.push({ modelId, effort: recordEffort(effort), candidates });
                        return sendTo(request, to, `verifier-${++verifications}`);
                      },
                    },
                    reviewInput,
                  )
                ).result
              : await send();
          } catch (error) {
            const failure: AgentResult = {
              status: signal.aborted ? "cancelled" : "error",
              finalText: "",
              structured: null,
              sessionId: null,
              usage: emptyUsage(),
              numTurns: 0,
              costUsd: 0,
              costEquivUsd: 0,
              error: redactCredentials((error as Error).message),
              quota: null,
            };
            result = spent.length ? combined(spent, failure, null) : failure;
          }
          trial.costUsd += result.costUsd;
          trial.costEquivUsd += result.costEquivUsd;
          trial.tokensIn += result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
          trial.tokensOut += result.usage.output;
          trial.details.cacheReadTokens = (trial.details.cacheReadTokens ?? 0) + result.usage.cacheRead;
          trial.details.cacheWriteTokens = (trial.details.cacheWriteTokens ?? 0) + result.usage.cacheWrite;
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
        // A panel's combined result carries its last call's status; the trial's own call is recorded here.
        if (!replay) observe(target, own ?? result);
        if (signal.aborted) return skip(stopReason(signal));
        // A panel's result is its derived review, whose verification fields only the stored schema keeps;
        // anything without the panel's mark (e.g. one member's raw review) is not a panel result.
        const output = (
          system?.mode === "panel"
            ? StoredReviewSchema.refine((r) => r.mode === "panel", "not a derived panel review")
            : schema
        )?.safeParse(result.structured ?? extractJson(result.finalText));
        // A declined decision answer is still graded; details.invocationStatus records the escalation.
        const answered = result.status === "ok" || result.status === "declined";
        const ok = answered && ("hidden" in item || output?.success === true);
        const grade =
          "hidden" in effective && implementation
            ? result.status === "ok"
              ? await gradeImplement(effective, cwd, hidden, implementation, toolCommands, signal)
              : failedImplement(result.status === "timeout" ? "timeout" : "error", result.error ?? undefined)
            : ok && output?.success && !("hidden" in item)
              ? gradeCase(item, output.data, system?.causalAttribution)
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
      if (signal.aborted) return skip(stopReason(signal));
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
