import { version } from "../package.json";
import { Concierge } from "./concierge.ts";
import type { Config } from "./config.ts";
import type { CreateRunRequest, Question, Run } from "./core/types.ts";
import { Store } from "./db/store.ts";
import { type EvalPolicyResponse, generatePolicy, selectEvidence } from "./evals/policy.ts";
import { EvalRunner } from "./evals/runner.ts";
import { evalSettings } from "./evals/settings.ts";
import { summarize } from "./evals/stats.ts";
import { gateSlots } from "./gates/slots.ts";
import { collectGarbage, type GcResult } from "./gc.ts";
import { resolveRepo } from "./git/repos.ts";
import { runClaude } from "./harness/claude.ts";
import { runCodex } from "./harness/codex.ts";
import { runDecisions } from "./harness/decisions.ts";
import { runLlm } from "./harness/llm.ts";
import type { Harness } from "./harness/types.ts";
import type { EngineDeps } from "./pipeline/context.ts";
import { checkRosterTargets, productionReviewSystem } from "./pipeline/review-system.ts";
import {
  DEFAULT_POLICY,
  MODELS,
  type ModelDef,
  type Policy,
  PROVIDERS,
  type ProviderDef,
} from "./router/catalog.ts";
import { loadPolicy } from "./router/policy.ts";
import { ProviderTracker } from "./router/providers.ts";
import { Router } from "./router/router.ts";
import { Scheduler } from "./scheduler.ts";
import { SshTunnels } from "./util/ssh-tunnel.ts";

export interface FactoryOptions {
  faults?: EngineDeps["faults"];
  bootSha?: string;
  evalCasePath?: string;
  /** Explicit overlay location; the daemon supplies its application checkout's path. */
  policyPath?: string;
  harnesses?: Record<string, Harness>;
  providers?: ProviderDef[];
  models?: ModelDef[];
  policy?: Policy;
  store?: Store;
  cleanup?: (dryRun: boolean) => Promise<GcResult>;
  gcTimer?: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clear: (timer: ReturnType<typeof setInterval>) => void;
  };
  clock?: () => number;
  fetch?: typeof fetch;
  providerTimer?: { set: typeof setInterval; clear: typeof clearInterval };
  healthFetch?: typeof fetch;
}

/** The factory service: one instance per daemon, shared by the HTTP API, CLI, Discord and MCP. */
export class Factory {
  readonly store: Store;
  readonly policy: Policy;
  readonly models: ModelDef[];
  readonly evalSettings: ReturnType<typeof evalSettings>;
  readonly evals: EvalRunner;
  readonly concierge: Concierge;
  readonly tracker: ProviderTracker;
  readonly router: Router;
  readonly scheduler: Scheduler;
  readonly deps: EngineDeps;
  readonly startedAt = Date.now();
  readonly bootId = crypto.randomUUID();
  readonly bootSha: string;
  private readonly tunnels = new SshTunnels((msg) => console.warn(`[tunnel] ${msg}`));
  private readonly providerDefs: ProviderDef[];
  private readonly cleanup: (dryRun: boolean) => Promise<GcResult>;
  private readonly gcTimer: NonNullable<FactoryOptions["gcTimer"]>;
  private gcInterval: ReturnType<typeof setInterval> | null = null;
  private gcInFlight: Promise<GcResult> | null = null;

  constructor(
    readonly cfg: Config,
    opts: FactoryOptions = {},
  ) {
    this.bootSha = opts.bootSha ?? "unknown";
    gateSlots.setLimit(cfg.maxConcurrentGates);
    this.models = opts.models ?? MODELS;
    this.evalSettings = evalSettings(cfg.raw);
    this.providerDefs = (opts.providers ?? PROVIDERS).map((provider) => ({
      ...provider,
      maxConcurrent: cfg.providerMaxConcurrent[provider.id] ?? provider.maxConcurrent,
    }));
    checkRosterTargets(cfg, this.models, this.providerDefs, (message) => console.warn(message));
    this.policy =
      opts.policy ??
      (opts.policyPath === undefined
        ? DEFAULT_POLICY
        : loadPolicy(opts.policyPath, this.models, this.providerDefs));
    this.store = opts.store ?? new Store(cfg.paths.db);
    this.cleanup = opts.cleanup ?? ((dryRun) => collectGarbage(this.store, cfg, { dryRun }));
    this.gcTimer = opts.gcTimer ?? { set: setInterval, clear: clearInterval };
    this.tracker = new ProviderTracker(
      this.providerDefs,
      this.store,
      cfg.reserves,
      cfg.secrets,
      { openrouter: cfg.openrouterBudgetUsd },
      opts.clock,
      opts.fetch,
      opts.providerTimer,
      opts.healthFetch,
    );
    this.router = new Router(this.tracker, this.policy, this.models, cfg.preferProviders);
    this.tracker.setRoutingDescription((provider, exhausted) =>
      this.router.describeFallback(provider, exhausted),
    );
    this.deps = {
      cfg,
      faults: opts.faults,
      store: this.store,
      buildSha: opts.bootSha,
      router: this.router,
      tracker: this.tracker,
      harnesses: Object.fromEntries(
        Object.entries(
          opts.harnesses ?? {
            claude: runClaude,
            codex: runCodex,
            llm: runLlm,
            decisions: runDecisions,
          },
        ).map(([name, harness]) => [
          name,
          (async (spec) => {
            const fast = spec.fast ?? this.tracker.isFast(spec.target.provider);
            const result = await harness({ ...spec, fast });
            this.tracker.observeFast(spec.target.provider, fast, result);
            return result;
          }) satisfies Harness,
        ]),
      ),
    };
    this.evals = new EvalRunner(this.deps, opts.evalCasePath);
    this.scheduler = new Scheduler(this.deps, cfg.maxConcurrentRuns);
    this.concierge = new Concierge(this);
  }

  evalPolicy(evalIds?: string[]): EvalPolicyResponse {
    const evidence = this.store
      .listEvalRuns()
      .map((run) => ({ run, trials: this.store.listEvalTrials(run.id) }));
    return {
      evaluation: generatePolicy({
        evidence,
        models: this.models,
        providers: this.providerDefs,
        settings: this.evalSettings,
        evalIds,
        implementerReport: productionReviewSystem(this.cfg).implementerReport,
      }),
      implement: selectEvidence(evidence, evalIds)
        .filter((e) => e.run.role === "implement")
        .flatMap((e) =>
          summarize(e.run, e.trials)
            .filter((s) => s.modelId === e.modelId)
            .map((summary) => ({ run: e.run, summary })),
        ),
      policy: this.policy,
      models: this.models,
      providers: this.providerDefs,
      runs: evidence.map(({ run, trials }) => ({
        ...run,
        costUsd: trials.reduce((n, t) => n + t.costUsd, 0),
        costEquivUsd: trials.reduce((n, t) => n + t.costEquivUsd, 0),
      })),
    };
  }

  start(): void {
    if (this.gcInterval) return;
    this.store.daemonStarted(this.bootId, version, this.bootSha);
    // UI development against seeded data must never launch real (paid) runs.
    if (process.env.LIMITLESS_NO_SCHEDULER === "1") return;
    void this.gc()
      .then((result) => this.reportGc(result))
      .catch((error) => console.error(`[gc] ${(error as Error).message}`));
    this.gcInterval = this.gcTimer.set(() => {
      if (this.gcInFlight) return;
      void this.gc()
        .then((result) => this.reportGc(result))
        .catch((error) => console.error(`[gc] ${(error as Error).message}`));
    }, 60 * 60_000);
    this.tracker.start();
    // Only forward to servers we can actually authenticate against.
    this.tunnels.start(
      this.providerDefs
        .filter((p) => p.sshForward && this.tracker.isEnabled(p.id))
        .map((p) => p.sshForward as NonNullable<ProviderDef["sshForward"]>),
    );
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.tracker.stop();
    if (this.gcInterval) this.gcTimer.clear(this.gcInterval);
    this.gcInterval = null;
    await this.gcInFlight;
    this.tunnels.stop();
    await Promise.all([this.scheduler.stop(), this.evals.stop()]);
  }

  gc(dryRun = false): Promise<GcResult> {
    if (this.gcInFlight) throw new Error("cleanup already running");
    const pass = this.cleanup(dryRun);
    this.gcInFlight = pass;
    void pass
      .finally(() => {
        if (this.gcInFlight === pass) this.gcInFlight = null;
      })
      .catch(() => undefined);
    return pass;
  }

  private reportGc(result: GcResult): void {
    for (const error of result.errors) console.warn(`[gc] ${error}`);
  }

  /** The second argument is factory-only provenance, never deserialized from a request. */
  async createRun(
    req: CreateRunRequest,
    verifiedGitHubWebhook = false,
    chat?: { conversationId: string; proposalId: string },
  ): Promise<Run> {
    if (!req.prompt?.trim()) throw new Error("prompt is required");
    if (!req.repo?.trim()) throw new Error("repo is required");
    const repo = await resolveRepo(this.store, req.repo);
    const run = chat
      ? this.store.createChatRun(repo, req, chat.conversationId, chat.proposalId)
      : this.store.createRun(repo, req, verifiedGitHubWebhook);
    this.store.addEvent({
      runId: run.id,
      type: "log",
      message: `Run created from ${run.source}${run.requestedBy ? ` by ${run.requestedBy}` : ""}`,
    });
    return run;
  }

  cancelRun(id: string, by = "user"): boolean {
    return this.scheduler.cancel(id, by);
  }

  async retryRun(id: string): Promise<Run> {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    return this.createRun(
      {
        repo: run.repoSlug,
        prompt: run.prompt,
        dependsOn: run.dependsOn,
        title: run.title,
        profile: run.profile,
        source: run.source,
        ...(run.sourceRef ? { sourceRef: run.sourceRef } : {}),
        ...(run.baseBranch ? { baseBranch: run.baseBranch } : {}),
        ...(run.deliveryBranch ? { deliveryBranch: run.deliveryBranch } : {}),
        ...(run.requestedBy ? { requestedBy: run.requestedBy } : {}),
        ...(run.noBaselineCache ? { noBaselineCache: true } : {}),
      },
      run.githubWebhookVerified,
    );
  }

  /** Answer the given question, or every open question on the run. */
  answer(runId: string, answer: string, by = "user", questionId?: number): Question[] {
    const open = this.store
      .listQuestions(runId)
      .filter((q) => q.answer === null && (questionId === undefined || q.id === questionId));
    if (!open.length) throw new Error("no open questions on this run");
    return open.map((q) => this.store.answerQuestion(q.id, answer, by));
  }
}
