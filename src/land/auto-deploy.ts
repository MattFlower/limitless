import type { Store } from "../db/store.ts";
import { redactCredentials } from "../util/proc.ts";

export type DeployResult = { ok: true } | { ok: false; reason: string };
type Attempt = { sha: string; landId: number; time: number };
type DeployState = {
  handled: number;
  attempt: Attempt | null;
  blocked: (Attempt & { reason: string }) | null;
};
export interface AutoDeployDeps {
  store: Store;
  afterLand: "off" | "when_idle";
  activeRunIds: () => readonly string[];
  selfRepo: () => Promise<string>;
  mainSha: () => Promise<string>;
  bootSha: string;
  deploy: (sha: string) => Promise<DeployResult>;
  now: () => number;
  timer: { set: (tick: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  log: (reason: string) => void;
}

/** One durable attempt per batch of self landings. A restart reconciles an interrupted attempt. */
export class AutoDeploy {
  private running = false;
  private stopped = false;
  private reconciled = false;
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
    try {
      // Snapshot before resolving origin: landings during a slow or failed lookup remain pending.
      this.initialLandings ??= this.deps.store.latestMainLandings();
      await this.evaluate();
    } catch (error) {
      this.deps.log(redactCredentials(`Automatic deploy: ${String(error)}`));
    } finally {
      this.running = false;
    }
  }

  private idle(): boolean {
    return (
      this.deps.activeRunIds().length === 0 && this.deps.store.listLandEntries({ active: true }).length === 0
    );
  }

  private async evaluate(): Promise<void> {
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
    if (!this.reconciled) {
      if (state.attempt) {
        const attempt = state.attempt;
        state.attempt = null;
        if (d.bootSha !== attempt.sha) {
          const reason = redactCredentials(
            `Deploy of ${attempt.sha} did not restart successfully; running ${d.bootSha}`,
          );
          state.blocked = { ...attempt, time: d.now(), reason };
          save(state);
          d.store.deployFeed("deploy.failed", repo, attempt.sha, attempt.landId, reason);
        }
      }
      save(state);
      this.reconciled = true;
    }
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
    if (sha === d.bootSha) {
      save(state);
      return;
    }
    const attempt = { sha, landId, time: d.now() };
    state.attempt = attempt;
    save(state);
    d.store.deployFeed("deploy.started", repo, sha, landId, `Deploying ${sha} after landing`);
    let result: DeployResult;
    try {
      result = await d.deploy(sha);
    } catch (error) {
      result = { ok: false, reason: String(error) };
    }
    if (this.stopped) return;
    state = read();
    if (
      state.blocked ||
      state.attempt?.sha !== sha ||
      state.attempt.landId !== landId ||
      state.attempt.time !== attempt.time
    )
      return;
    state.attempt = null;
    if (!result.ok) {
      const reason = redactCredentials(result.reason);
      state.blocked = { ...attempt, time: d.now(), reason };
      save(state);
      d.store.deployFeed("deploy.failed", repo, sha, landId, `Deploy failed: ${reason}`);
    } else save(state);
  }
}
