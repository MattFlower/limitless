import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.ts";
import { redactCredentials } from "../util/proc.ts";
import { completedDeployResult, type DeployJobStatus } from "./deploy-process.ts";

export type DeployResult = ({ ok: true; reason?: string } | { ok: false; reason: string }) & {
  exitCode?: number;
  filterExitCode?: number;
};
/** `job` names the deploy process so a restarted daemon can remove a finished one it left behind. */
type Attempt = { sha: string; landId: number; time: number; job?: string };
type DeployState = {
  handled: number;
  attempt: Attempt | null;
  blocked: (Attempt & { reason: string }) | null;
  lastDeployed?: string;
  lastOutcome?: DeployResult;
  pendingRemoval?: string[];
};
export interface AutoDeployDeps {
  store: Store;
  afterLand: "off" | "when_idle";
  activeRunIds: () => readonly string[];
  selfRepo: () => Promise<string>;
  mainSha: () => Promise<string>;
  bootSha: string;
  deploy: (sha: string, job: string) => Promise<DeployResult>;
  jobStatus: (job: string, time: number) => Promise<DeployJobStatus>;
  /** Called after recording the outcome; false leaves the job queued for removal. */
  cleanup: (job: string) => Promise<boolean>;
  now: () => number;
  timer: { set: (tick: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  log: (reason: string) => void;
}

/** One durable attempt per batch of self landings. A restart reconciles an interrupted attempt. */
export class AutoDeploy {
  private running = false;
  private stopped = false;
  private interval: unknown;
  private repo: string | undefined;
  private initialLandings: Record<string, number> | undefined;

  constructor(private readonly deps: AutoDeployDeps) {}

  start(): void {
    if (this.deps.afterLand === "off" || this.stopped || this.interval !== undefined) return;
    this.interval = this.deps.timer.set(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval !== undefined) this.deps.timer.clear(this.interval);
    this.interval = undefined;
    // The deploy process deliberately survives shutdown; its persisted attempt is reconciled at boot.
  }

  async tick(): Promise<void> {
    if (this.deps.afterLand === "off" || this.running || this.stopped) return;
    this.running = true;
    let pending: { completion: Promise<void> } | undefined;
    try {
      // Snapshot before resolving origin: landings during a slow or failed lookup remain pending.
      this.initialLandings ??= this.deps.store.latestMainLandings();
      pending = await this.evaluate();
    } catch (error) {
      this.deps.log(redactCredentials(`Automatic deploy: ${String(error)}`));
    } finally {
      this.running = false;
    }
    await pending?.completion.catch((error: unknown) => {
      this.deps.log(redactCredentials(`Automatic deploy: ${String(error)}`));
    });
  }

  private idle(): boolean {
    return (
      this.deps.activeRunIds().length === 0 && this.deps.store.listLandEntries({ active: true }).length === 0
    );
  }

  private async evaluate(): Promise<{ completion: Promise<void> } | undefined> {
    const d = this.deps;
    const repo = this.repo ?? (await d.selfRepo());
    if (this.stopped) return;
    this.repo = repo;
    const key = `deploy.after_land:${repo}`;
    const latest = () => d.store.latestSelfLanding(repo);
    const read = () =>
      d.store.getSetting<DeployState>(key, {
        handled: this.initialLandings?.[repo] ?? 0,
        attempt: null,
        blocked: null,
      });
    const save = (state: DeployState) => d.store.setSetting(key, state);
    let state = read();
    const matches = (current: Attempt | null, attempt: Attempt) =>
      current?.sha === attempt.sha &&
      current.landId === attempt.landId &&
      current.time === attempt.time &&
      current.job === attempt.job;
    const finish = (attempt: Attempt, result: DeployResult) => {
      const current = read();
      if (this.stopped || current.blocked || !matches(current.attempt, attempt)) return;
      current.attempt = null;
      current.lastOutcome = {
        ...result,
        ...(result.reason ? { reason: redactCredentials(result.reason) } : {}),
      };
      if (attempt.job)
        current.pendingRemoval = [...new Set([...(current.pendingRemoval ?? []), attempt.job])];
      if (!result.ok) {
        const reason = redactCredentials(result.reason);
        current.blocked = { ...attempt, time: d.now(), reason };
        d.store.transaction(() => {
          save(current);
          d.store.deployFeed(
            "deploy.failed",
            repo,
            attempt.sha,
            attempt.landId,
            `Deploy of ${attempt.sha} failed: ${reason}`,
          );
        });
      } else {
        current.lastDeployed = attempt.sha;
        save(current);
      }
    };
    const cleanup = async () => {
      for (const job of read().pendingRemoval ?? []) {
        try {
          const removed = await d.cleanup(job);
          if (this.stopped) return;
          if (removed) {
            const current = read();
            current.pendingRemoval = (current.pendingRemoval ?? []).filter((value) => value !== job);
            save(current);
          }
        } catch (error) {
          d.log(redactCredentials(`Automatic deploy cleanup: ${String(error)}`));
        }
      }
    };
    const attempt = state.attempt;
    if (attempt) {
      const status = attempt.job
        ? await d.jobStatus(attempt.job, attempt.time)
        : { kind: "missing" as const, reason: "Deploy attempt has no recorded job id" };
      if (this.stopped) return;
      if (status.kind === "done") {
        finish(attempt, completedDeployResult(status));
      } else if (status.kind !== "running") finish(attempt, { ok: false, reason: status.reason });
    }
    await cleanup();
    if (this.stopped) return;
    state = read();
    const landId = latest();
    if (state.blocked && landId > state.blocked.landId) {
      state.blocked = null;
      save(state);
    }
    if (state.blocked || state.attempt || landId <= state.handled || !this.idle()) return;
    const sha = await d.mainSha();
    if (this.stopped) return;
    state = read();
    // A landing during resolution needs a fresh main observation, and new work can delay deployment.
    if (state.blocked || state.attempt || state.handled >= landId || latest() !== landId || !this.idle())
      return;
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Cannot resolve self repository main SHA");
    state.handled = landId;
    if (sha === d.bootSha || sha === state.lastDeployed) {
      save(state);
      return;
    }
    const nextAttempt = { sha, landId, time: d.now(), job: randomUUID() };
    state.attempt = nextAttempt;
    save(state);
    d.store.deployFeed("deploy.started", repo, sha, landId, `Deploying ${sha} after landing`);
    // Let later ticks reconcile the durable attempt while the launching daemon waits for its job.
    const completion = (async () => {
      let result: DeployResult;
      try {
        result = await d.deploy(sha, nextAttempt.job);
      } catch (error) {
        result = { ok: false, reason: String(error) };
      }
      finish(nextAttempt, result);
      if (!this.stopped) await cleanup();
    })();
    return { completion };
  }
}
