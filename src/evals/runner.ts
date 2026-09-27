import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EvalRun, EvalTrial } from "../core/types.ts";
import { createEvalWorktree, type EvalLabels, pinnedTree } from "../git/repos.ts";
import { withScratch } from "../harness/scratch.ts";
import { selectHarness } from "../harness/select.ts";
import { type AgentResult, emptyUsage, extractJson } from "../harness/types.ts";
import type { EngineDeps } from "../pipeline/context.ts";
import { FACTORY_PREAMBLE } from "../pipeline/prompts.ts";
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
  validateRequest,
} from "./cases.ts";
import { failedImplement, gradeImplement, prepareImplement } from "./implement.ts";
import { gradeCase, prepareCase, schemaFor, seedContent } from "./prepare.ts";
import { type EvalReport, type StatsOptions, summarize } from "./stats.ts";

/** Where Limitless keeps eval datasets; pins whose history touches these are rejected. */
const LABEL_PATHS = ["evals/triage", "evals/review", "evals/verify", "evals/implement"];

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
            details: "hidden" in item ? { complexity: item.complexity } : {},
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

  private async trial(
    run: EvalRun,
    trial: EvalTrial,
    item: EvalCase,
    treeFor: (slug: string) => Promise<string>,
    implementFor: (item: ImplementCase, cwd: string) => ReturnType<typeof prepareImplement>,
    labels: EvalLabels,
    cache: boolean,
    signal: AbortSignal,
    hidden: ReturnType<typeof hiddenContents> = [],
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
    const target = router.toTarget(model, effort ?? null);
    const { harnessName, noTools } = selectHarness(run.role, target);
    trial.harness = harnessName;
    const tree = "gold" in item && "prompt" in item ? await treeFor(item.repo) : "";
    let release: (() => void) | undefined;
    let directory: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      mkdirSync(cfg.paths.runs, { recursive: true });
      directory = mkdtempSync(join(cfg.paths.runs, "eval-"));
      const cwd = "gold" in item && "prompt" in item ? directory : join(directory, "worktree");
      const patch =
        "defects" in item ? seedContent(item, this.casePath ?? defaultCasePath(run.role)) : undefined;
      if (!("gold" in item && "prompt" in item))
        cleanup = await createEvalWorktree(
          cfg.paths,
          store,
          item.repo,
          item.base,
          "hidden" in item ? item.base : item.head,
          cwd,
          signal,
          labels,
        );
      const preparationStarted = Date.now();
      const implementation = "hidden" in item ? await implementFor(item, cwd) : undefined;
      const prepared = "hidden" in item ? implementation : await prepareCase(item, cwd, tree, patch, signal);
      if (!prepared) throw new Error("missing trial preparation");
      const preparationMs = Date.now() - preparationStarted;
      const { prompt, timeoutMs } = prepared;
      const schema = "hidden" in item ? undefined : schemaFor(item);
      const jsonSchema = schema ? toStrictJsonSchema(schema) : undefined;
      const repository =
        "gold" in item && "prompt" in item
          ? undefined
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
        repository,
        trial.effort,
      );
      if (signal.aborted) return skip("daemon shutdown");
      if (budget()) return skip("eval budget exhausted");
      if (cache)
        for (const source of store.cachedEvalTrials(trial.cacheKey)) {
          const output =
            "hidden" in item ? { success: true, data: source.output } : schema?.safeParse(source.output);
          if (!output?.success) continue;
          const grade = "hidden" in item ? source.details.grade : gradeCase(item, output.data);
          if (!grade) continue;
          store.recordEvalTrial({
            ...trial,
            status: "ok",
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
      const toolCommands: string[] = [];
      try {
        const logPath = join(directory, "trial.log");
        const invoke = (scratchDir?: string) =>
          harness({
            scratchDir,
            cwd,
            prompt,
            systemAppend: FACTORY_PREAMBLE,
            target,
            mode: "hidden" in item ? "edit" : "readonly",
            noTools,
            jsonSchema,
            schema,
            timeoutMs,
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
        result = noTools ? await invoke() : await withScratch(cwd, invoke);
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
      trial.costUsd = result.costUsd;
      trial.costEquivUsd = result.costEquivUsd;
      trial.tokensIn = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
      trial.tokensOut = result.usage.output;
      trial.output = "hidden" in item ? result.finalText : result.structured;
      if ("hidden" in item) store.recordEvalTrial({ ...trial, status: "running" });
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
      if (signal.aborted) return skip("daemon shutdown");
      const output = schema?.safeParse(result.structured ?? extractJson(result.finalText));
      const ok = result.status === "ok" && ("hidden" in item || output?.success === true);
      const grade =
        "hidden" in item && implementation
          ? result.status === "ok"
            ? await gradeImplement(item, cwd, hidden, implementation, toolCommands, signal)
            : failedImplement(result.status === "timeout" ? "timeout" : "error", result.error ?? undefined)
          : ok && output?.success && !("hidden" in item)
            ? gradeCase(item, output.data)
            : undefined;
      store.recordEvalTrial({
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
                (output?.success ? result.status : `Invalid ${run.role} output: ${output?.error.message}`))),
        },
        costUsd: result.costUsd,
        costEquivUsd: result.costEquivUsd,
        tokensIn: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        tokensOut: result.usage.output,
        durationMs: Date.now() - trial.createdAt + ("hidden" in item ? preparationMs : 0),
      });
    } catch (error) {
      if (signal.aborted) return skip("daemon shutdown");
      store.recordEvalTrial({
        ...trial,
        status: "error",
        pass: false,
        score: 0,
        details: {
          ...trial.details,
          preparationFailed: true,
          reason: (error as Error).message,
          ...("hidden" in item ? { grade: failedImplement("error", (error as Error).message) } : {}),
        },
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
