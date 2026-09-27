import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EvalRun, EvalTrial } from "../core/types.ts";
import { createEvalWorktree, type EvalLabels, pinnedTree } from "../git/repos.ts";
import { selectHarness } from "../harness/select.ts";
import { type AgentResult, emptyUsage, extractJson } from "../harness/types.ts";
import type { EngineDeps } from "../pipeline/context.ts";
import { FACTORY_PREAMBLE } from "../pipeline/prompts.ts";
import { toStrictJsonSchema } from "../pipeline/schemas.ts";
import { cacheKey } from "./cache.ts";
import {
  type AnyCaseFile,
  defaultCasePath,
  type EvalCase,
  EvalRequestSchema,
  loadRoleCases,
  validateRequest,
} from "./cases.ts";
import { gradeCase, prepareCase, schemaFor, seedContent } from "./prepare.ts";
import { type EvalReport, type StatsOptions, summarize } from "./stats.ts";

/** Where Limitless keeps eval datasets; pins whose history touches these are rejected. */
const LABEL_PATHS = ["evals/triage", "evals/review", "evals/verify"];

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
            modelId,
            trial,
            cacheKey: "",
            harness: "",
            status: "queued",
            output: null,
            pass: null,
            score: null,
            details: {},
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
    return { run, summaries: summarize(run, trials, options), trials };
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
    const treeFor = (slug: string) => {
      let tree = trees.get(slug);
      if (!tree) {
        const sha = file.role === "triage" ? file.repos[slug] : undefined;
        if (!sha) throw new Error(`missing pin: ${slug}`);
        tree = pinnedTree(this.deps.cfg.paths, store, slug, sha);
        trees.set(slug, tree);
      }
      return tree;
    };
    try {
      const casePath = this.casePath ?? defaultCasePath(run.role);
      const labels: EvalLabels = {
        paths: LABEL_PATHS,
        contents: [
          readFileSync(casePath, "utf8"),
          ...file.cases.flatMap((item) => ("defects" in item ? (seedContent(item, casePath) ?? []) : [])),
        ],
      };
      const groups = new Map<string, string[]>();
      for (const modelId of run.models) {
        const provider = router.model(modelId)?.provider ?? "unknown";
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
                .filter((t) => t.modelId === modelId && t.caseId === item.id)) {
                await this.trial(run, trial, item, treeFor, labels, cache, signal);
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

  private async trial(
    run: EvalRun,
    trial: EvalTrial,
    item: EvalCase,
    treeFor: (slug: string) => Promise<string>,
    labels: EvalLabels,
    cache: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { store, router, tracker, harnesses, cfg } = this.deps;
    const skip = (reason: string) =>
      store.recordEvalTrial({ ...trial, status: "skipped", details: { ...trial.details, reason } });
    const budget = () => store.evalSpend(run.id) >= run.maxUsd;
    if (signal.aborted) return skip("daemon shutdown");
    const model = router.model(trial.modelId);
    if (!model) return skip("model no longer in catalog");
    trial.details.provider = model.provider;
    const eligible = () => {
      const reason = tracker.unavailableReason(model.provider);
      return (
        (reason === "at reserve limit"
          ? (tracker.budgetUnavailableReason(model.provider) ?? reason)
          : reason) ?? tracker.modelUnavailableReason(model.id)
      );
    };
    if (budget()) return skip("eval budget exhausted");
    if (!tracker.def(model.provider)) return skip("unknown provider");
    const target = router.toTarget(model);
    const { harnessName, noTools } = selectHarness(run.role, target);
    trial.harness = harnessName;
    const tree = "prompt" in item ? await treeFor(item.repo) : "";
    let release: (() => void) | undefined;
    let directory: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      mkdirSync(cfg.paths.runs, { recursive: true });
      directory = mkdtempSync(join(cfg.paths.runs, "eval-"));
      const cwd = "prompt" in item ? directory : join(directory, "worktree");
      const patch =
        "defects" in item ? seedContent(item, this.casePath ?? defaultCasePath(run.role)) : undefined;
      if (!("prompt" in item))
        cleanup = await createEvalWorktree(
          cfg.paths,
          store,
          item.repo,
          item.base,
          item.head,
          cwd,
          signal,
          labels,
        );
      const { prompt, timeoutMs } = await prepareCase(item, cwd, tree, patch, signal);
      const schema = schemaFor(item);
      const jsonSchema = toStrictJsonSchema(schema);
      const repository =
        "prompt" in item
          ? undefined
          : {
              role: run.role,
              repo: item.repo,
              base: item.base,
              head: item.head,
              patch,
              input: item.input,
              source:
                store.getRepoBySlug(item.repo)?.url ?? store.getRepoBySlug(item.repo)?.localPath ?? item.repo,
            };
      trial.cacheKey = cacheKey(
        model.id,
        harnessName,
        prompt,
        FACTORY_PREAMBLE,
        jsonSchema,
        trial.trial,
        repository,
      );
      if (signal.aborted) return skip("daemon shutdown");
      if (budget()) return skip("eval budget exhausted");
      if (cache)
        for (const source of store.cachedEvalTrials(trial.cacheKey)) {
          const output = schema.safeParse(source.output);
          if (!output.success) continue;
          const grade = gradeCase(item, output.data);
          store.recordEvalTrial({
            ...trial,
            status: "ok",
            output: output.data,
            pass: grade.pass,
            score: grade.score,
            details: {
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
      const harness = harnesses[harnessName];
      if (!harness) return skip(`No harness registered for ${harnessName}`);
      const reason = eligible();
      if (reason) return skip(reason);
      release = await tracker.acquire(target.provider, signal);
      if (signal.aborted) return skip("daemon shutdown");
      if (budget()) return skip("eval budget exhausted");
      const afterWait = eligible();
      if (afterWait) return skip(afterWait);
      trial.createdAt = Date.now();
      store.recordEvalTrial({ ...trial, status: "running" });
      let result: AgentResult;
      try {
        result = await harness({
          cwd,
          prompt,
          systemAppend: FACTORY_PREAMBLE,
          target,
          mode: "readonly",
          noTools,
          jsonSchema,
          schema,
          timeoutMs,
          privateSession: run.role === "verify",
          idleTimeoutMs: 10 * 60_000,
          maxToolCalls: 150,
          signal,
          logPath: join(directory, "trial.log"),
          onEvent: (event) => {
            if (event.type === "rate_limit") tracker.observeWindows(target.provider, event.windows);
          },
        });
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
      const output = schema.safeParse(result.structured ?? extractJson(result.finalText));
      const ok = result.status === "ok" && output.success;
      const grade = ok ? gradeCase(item, output.data) : undefined;
      store.recordEvalTrial({
        ...trial,
        status: ok ? "ok" : "error",
        output: output.success ? output.data : result.structured,
        pass: grade ? grade.pass : false,
        score: grade ? grade.score : 0,
        details: {
          ...trial.details,
          grade,
          invocationStatus: result.status,
          reason: ok
            ? undefined
            : (result.error ??
              (output.success ? result.status : `Invalid ${run.role} output: ${output.error.message}`)),
        },
        costUsd: result.costUsd,
        costEquivUsd: result.costEquivUsd,
        tokensIn: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        tokensOut: result.usage.output,
        durationMs: Date.now() - trial.createdAt,
      });
      if (result.quota) tracker.observeWindows(target.provider, result.quota.windows);
      tracker.record(target.provider, result.status, {
        error: result.error,
        exhaustedUntil: result.quota?.exhaustedUntil,
      });
      if (
        result.status !== "ok" &&
        /model[^.]{0,80}(is not supported|not found|does not exist|not available)|unknown model|invalid model|model_not_found/i.test(
          result.error ?? "",
        )
      )
        tracker.blockModel(model.id, result.error ?? "model rejected");
    } catch (error) {
      if (signal.aborted) return skip("daemon shutdown");
      store.recordEvalTrial({
        ...trial,
        status: "error",
        pass: false,
        score: 0,
        details: { ...trial.details, preparationFailed: true, reason: (error as Error).message },
      });
    } finally {
      release?.();
      try {
        await cleanup?.();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}
