import type { Config } from "./config.ts";
import type { CreateRunRequest, Question, Run } from "./core/types.ts";
import { Store } from "./db/store.ts";
import { collectGarbage, type GcResult } from "./gc.ts";
import { resolveRepo } from "./git/repos.ts";
import { runClaude } from "./harness/claude.ts";
import { runCodex } from "./harness/codex.ts";
import { runLlm } from "./harness/llm.ts";
import type { Harness } from "./harness/types.ts";
import type { EngineDeps } from "./pipeline/context.ts";
import {
  DEFAULT_POLICY,
  MODELS,
  type ModelDef,
  type Policy,
  PROVIDERS,
  type ProviderDef,
} from "./router/catalog.ts";
import { ProviderTracker } from "./router/providers.ts";
import { Router } from "./router/router.ts";
import { Scheduler } from "./scheduler.ts";
import { SshTunnels } from "./util/ssh-tunnel.ts";

export interface FactoryOptions {
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
}

/** The factory service: one instance per daemon, shared by the HTTP API, CLI, Discord and MCP. */
export class Factory {
  readonly store: Store;
  readonly tracker: ProviderTracker;
  readonly router: Router;
  readonly scheduler: Scheduler;
  readonly deps: EngineDeps;
  readonly startedAt = Date.now();
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
    this.store = opts.store ?? new Store(cfg.paths.db);
    this.cleanup = opts.cleanup ?? ((dryRun) => collectGarbage(this.store, cfg, { dryRun }));
    this.gcTimer = opts.gcTimer ?? { set: setInterval, clear: clearInterval };
    this.providerDefs = opts.providers ?? PROVIDERS;
    this.tracker = new ProviderTracker(
      this.providerDefs,
      this.store,
      cfg.reserves,
      cfg.secrets,
      { openrouter: cfg.openrouterBudgetUsd },
      opts.clock,
    );
    this.router = new Router(
      this.tracker,
      opts.policy ?? DEFAULT_POLICY,
      opts.models ?? MODELS,
      cfg.preferProviders,
    );
    this.tracker.setRoutingDescription((provider, exhausted) =>
      this.router.describeFallback(provider, exhausted),
    );
    this.deps = {
      cfg,
      store: this.store,
      router: this.router,
      tracker: this.tracker,
      harnesses: opts.harnesses ?? { claude: runClaude, codex: runCodex, llm: runLlm },
    };
    this.scheduler = new Scheduler(this.deps, cfg.maxConcurrentRuns);
  }

  start(): void {
    if (this.gcInterval) return;
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
    // Only forward to servers we can actually authenticate against.
    this.tunnels.start(
      this.providerDefs
        .filter((p) => p.sshForward && this.tracker.isEnabled(p.id))
        .map((p) => p.sshForward as NonNullable<ProviderDef["sshForward"]>),
    );
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    if (this.gcInterval) this.gcTimer.clear(this.gcInterval);
    this.gcInterval = null;
    await this.gcInFlight;
    this.tunnels.stop();
    await this.scheduler.stop();
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
  async createRun(req: CreateRunRequest, verifiedGitHubWebhook = false): Promise<Run> {
    if (!req.prompt?.trim()) throw new Error("prompt is required");
    if (!req.repo?.trim()) throw new Error("repo is required");
    const repo = await resolveRepo(this.store, req.repo);
    const run = this.store.createRun(repo, req, verifiedGitHubWebhook);
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
        title: run.title,
        profile: run.profile,
        source: run.source,
        ...(run.sourceRef ? { sourceRef: run.sourceRef } : {}),
        ...(run.baseBranch ? { baseBranch: run.baseBranch } : {}),
        ...(run.deliveryBranch ? { deliveryBranch: run.deliveryBranch } : {}),
        ...(run.requestedBy ? { requestedBy: run.requestedBy } : {}),
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
