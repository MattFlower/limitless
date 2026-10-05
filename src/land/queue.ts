import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../config.ts";
import type { LandEntry, Repo, Run } from "../core/types.ts";
import { ACTIVE_LAND_STATES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { detectGates } from "../gates/detect.ts";
import { runGates } from "../gates/run.ts";
import { worktreeGit } from "../git/command.ts";
import { completeMerge, prepareMerge } from "../git/merge.ts";
import {
  addDetachedWorktree,
  disableAutoMerge,
  ensureCache,
  exportCommit,
  fetchBase,
  isAncestor,
  mergePullRequest,
  pushExistingBranch,
  remoteBranchSha,
  removeWorktree,
} from "../git/repos.ts";
import { type ConfinementBackend, confinementScope } from "../harness/sandbox.ts";
import { type GitHubPrView, getGitHubPr } from "../integrations/github-notifier.ts";

/** A land the factory will not retry: the operator has to look at it. */
export class LandBlocked extends Error {}

/** What one observation says about the PR the entry is landing. */
export interface LandObservation {
  head: string;
  state: string;
  /** The CI rollup state: "SUCCESS", "FAILURE", "PENDING", "EXPECTED" or null (no checks). */
  ci: string | null;
  failing: string[];
}

/** The poller's saved snapshot, the `gh` fallback, or whatever a test injects. */
export type LandPrClient = (url: string) => Promise<GitHubPrView | null>;

/** An injected clock and timers, so CI waits and timeouts never need real sleeps. */
export interface LandClock {
  now: () => number;
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

export interface LandDeps {
  store: Store;
  paths: Paths;
  /** GitHub polling is on: read the poller's saved observations instead of calling `gh` every cycle. */
  polling?: boolean;
  client?: LandPrClient;
  clock?: LandClock;
  /** How often CI is looked at while a land waits; 15s, like a delivered PR's poll. */
  ciPollMs?: number;
  /** How long a land waits for CI before it gives up. */
  ciTimeoutMs?: number;
  confinement?: ConfinementBackend;
  log?: (message: string) => void;
}

const DEFAULTS = { ciPollMs: 15_000, ciTimeoutMs: 60 * 60_000 };
/** A claim has to be this quiet before another queue may take the entry it holds. */
const CLAIM_STALE_MS = 30_000;

/** The saved poller observation, or null when it holds nothing usable. */
function saved(url: string | null): LandObservation | null {
  if (!url) return null;
  let data: {
    headRefOid?: unknown;
    state?: unknown;
    ci?: unknown;
    failing?: unknown;
  };
  try {
    data = JSON.parse(url) as typeof data;
  } catch {
    return null;
  }
  if (typeof data.headRefOid !== "string" || typeof data.state !== "string") return null;
  const failing = Array.isArray(data.failing) ? data.failing : [];
  return {
    head: data.headRefOid,
    state: data.state,
    ci: typeof data.ci === "string" ? data.ci : null,
    failing: failing.flatMap((f) =>
      typeof (f as { name?: unknown })?.name === "string" ? [(f as { name: string }).name] : [],
    ),
  };
}

/**
 * Which queue is draining each repository in this process. The store's claim is the durable half of
 * ownership; this keeps two queue objects in one daemon off the same rows.
 */
const draining = new Map<string, LandQueue>();

/**
 * The land queue: one approved pull request at a time per repository. Each entry merges the base in,
 * runs the repository's land checks on the result, pushes that commit with a lease on the approved
 * head, waits for CI on exactly that commit and squash-merges with the head pinned.
 */
export class LandQueue {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<number, AbortController>();
  private stopped = false;

  constructor(private readonly deps: LandDeps) {}

  private get store(): Store {
    return this.deps.store;
  }
  private get log(): (message: string) => void {
    return this.deps.log ?? console.warn;
  }
  private get now(): () => number {
    return this.deps.clock?.now ?? Date.now;
  }

  /** Take over whatever the previous daemon left in flight, then wait for new requests. */
  start(): void {
    this.stopped = false;
    this.store.releaseLandClaims();
    for (const entry of this.store.listLandEntries({ active: true })) this.pump(entry.repo);
  }

  /** Abort in-flight git, gates and `gh` calls; entries keep their state for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort();
    await Promise.all([...this.workers.values()].map((worker) => worker.catch(() => undefined)));
  }

  list(): LandEntry[] {
    return this.store.listLandEntries({ limit: 100 });
  }

  /**
   * Queue a land for `runId`. The approval is the PR's recorded review approval; `sha` names one
   * explicitly instead and must be the PR's current head.
   */
  request(input: { runId: string; sha?: string }): LandEntry {
    const run = this.store.getRun(input.runId);
    if (!run) throw new Error("run not found");
    const repo = this.store.getRepoBySlug(run.repoSlug);
    if (repo?.kind !== "github") throw new Error("run is not on a GitHub repository");
    if (!run.prUrl) throw new Error("run has no pull request");
    const observed = this.deps.polling === false ? null : saved(this.store.githubPrData(run.prUrl));
    if (observed && observed.state !== "OPEN") throw new Error(`pull request is ${observed.state}`);
    const approved = this.approval(run.prUrl, input.sha, observed?.head);
    const headBranch = run.deliveryBranch ?? run.branch;
    if (!headBranch) throw new Error("run has no delivery branch");
    const entry = this.store.createLandEntry({
      runId: run.id,
      repo: repo.slug,
      prUrl: run.prUrl,
      baseBranch: run.baseBranch ?? repo.defaultBranch,
      headBranch,
      approvedSha: approved,
    });
    this.store.landFeed("land.queued", entry, `land queued at ${approved.slice(0, 12)}`, {
      state: entry.state,
    });
    this.pump(entry.repo);
    return entry;
  }

  /** The approval that may land: the recorded review approval, or an explicit head that is the PR's. */
  private approval(prUrl: string, sha: string | undefined, head: string | undefined): string {
    const given = sha?.trim();
    if (given) {
      if (!/^[a-fA-F0-9]{40}$/.test(given)) throw new Error("sha must be a full commit id");
      if (head && head !== given) throw new Error("sha is not the pull request's current head");
      return given;
    }
    const approval = this.store.approvalFor(prUrl);
    if (!approval) throw new Error("no review approval for this pull request");
    if (approval.stale) throw new Error("review approval is stale: the head moved after it");
    return approval.sha;
  }

  cancel(id: number): boolean {
    const entry = this.store.getLandEntry(id);
    if (!entry || !this.isActive(entry)) return false;
    this.inFlight.get(id)?.abort();
    this.finish(id, "cancelled", "cancelled");
    return true;
  }

  private isActive(entry: LandEntry): boolean {
    return ACTIVE_LAND_STATES.includes(entry.state);
  }

  /** Drain this repository's queue: claim the next entry and land it, until there is none. */
  private pump(repo: string): void {
    if (this.stopped || draining.has(repo)) return;
    draining.set(repo, this);
    const worker = (async () => {
      for (;;) {
        if (this.stopped) return;
        // The claim is a store transaction, so this repository has exactly one land at a time.
        const entry = this.store.claimLandEntry(repo, CLAIM_STALE_MS);
        if (!entry) return;
        await this.process(entry);
      }
    })();
    this.workers.set(repo, worker);
    void worker
      .catch((error: unknown) => this.log(`[land] ${repo}: ${String(error)}`))
      .finally(() => {
        this.workers.delete(repo);
        if (draining.get(repo) === this) draining.delete(repo);
      });
  }

  private async process(entry: LandEntry): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(entry.id, controller);
    const signal = controller.signal;
    // `checking` re-runs the checks from the start, like a `queued` entry.
    const work = () => this.land(entry, signal);
    try {
      await (this.deps.confinement ? confinementScope.run(this.deps.confinement, work) : work());
    } catch (error) {
      // A cancel or a shutdown aborts on purpose: the entry keeps its state for the next start.
      if (controller.signal.aborted) return;
      this.block(entry.id, (error as Error).message);
    } finally {
      this.inFlight.delete(entry.id);
    }
  }

  // ---- the land itself -----------------------------------------------------

  /**
   * One checkout for a first attempt and for a resume. `pushed_sha` is the entry's progress: with it
   * recorded, this queue already pushed that commit and has only CI and the merge left. A crash
   * between the push and the `waiting_ci` update therefore resumes instead of pushing the factory's
   * own merge commit again, which the lease would refuse as a head that moved after approval.
   */
  private async land(entry: LandEntry, signal: AbortSignal): Promise<void> {
    const { repo, run } = this.context(entry);
    // The claim already moved the entry into `checking` and counted this attempt.
    this.log(`[land] ${entry.id}: checking ${entry.prUrl} at ${entry.approvedSha.slice(0, 12)}`);
    const cache = await ensureCache(this.deps.paths, repo, signal);
    const cwd = await this.checkout(entry, repo, cache, entry.pushedSha ?? entry.approvedSha, signal);
    try {
      let head = entry.pushedSha;
      if (!head) {
        const baseSha = await fetchBase(this.deps.paths, repo, entry.baseBranch, signal);
        head = await this.mergeBase(cwd, entry, baseSha);
        await this.checks(cwd, baseSha, signal);
        if (head !== entry.approvedSha) await this.pushApproved(entry, cwd, repo, head, signal);
        // Recorded either way: with it, a resume waits for this commit instead of checking again.
        this.store.updateLandEntry(entry.id, { pushedSha: head, state: "waiting_ci" });
      }
      if ((await this.awaitCi(entry, head, signal)) === "merged") return this.landed(entry, run, head);
      await this.merge(entry, run, cwd, head, signal);
    } finally {
      await this.discard(repo, cwd);
    }
  }

  /** A PR that already merged is recorded, never merged again. */
  private landed(entry: LandEntry, run: Run, sha: string): void {
    this.store.updateRun(run.id, { merged: true });
    this.finish(entry.id, "landed", `merged ${sha.slice(0, 12)}`);
    this.log(`[land] ${entry.id}: merged ${entry.prUrl}`);
  }

  /** The approved head, with the base merged in when it is not already an ancestor. */
  private async mergeBase(cwd: string, entry: LandEntry, baseSha: string): Promise<string> {
    if (await isAncestor(cwd, baseSha, entry.approvedSha)) return entry.approvedSha;
    const conflicts = await prepareMerge(cwd, entry.approvedSha, baseSha);
    if (conflicts.length) throw new LandBlocked(`conflicts with ${entry.baseBranch}`);
    return completeMerge(cwd, entry.approvedSha, baseSha);
  }

  /** The repository's checks, taken from the base commit so the PR cannot weaken them. */
  private async checks(cwd: string, baseSha: string, signal: AbortSignal): Promise<void> {
    const base = `${cwd}-base`;
    try {
      rmSync(base, { recursive: true, force: true });
      mkdirSync(base, { recursive: true });
      await exportCommit(cwd, baseSha, base, signal);
      const cfg = detectGates(base);
      const run = await runGates(cwd, cfg, signal);
      const failed = run.setupOk ? run.checks.filter((c) => !c.ok) : run.setup.filter((c) => !c.ok);
      if (failed.length) throw new LandBlocked(`${failed.map((c) => c.name).join(", ")} failed`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  /** Push the merge commit under a lease on the approved head: never overwrite anyone else's push. */
  private async pushApproved(
    entry: LandEntry,
    cwd: string,
    repo: Repo,
    head: string,
    signal: AbortSignal,
  ): Promise<void> {
    const remote = await remoteBranchSha(repo, cwd, entry.headBranch, signal);
    if (remote !== entry.approvedSha) throw new LandBlocked("head moved after approval");
    this.store.updateLandEntry(entry.id, { pushedSha: head });
    await pushExistingBranch(repo, cwd, entry.headBranch, entry.approvedSha, signal);
  }

  /** Wait for CI on exactly `sha`; nothing else counts as the green that lets the merge happen. */
  private async awaitCi(entry: LandEntry, sha: string, signal: AbortSignal): Promise<"green" | "merged"> {
    const pollMs = this.deps.ciPollMs ?? DEFAULTS.ciPollMs;
    const deadline = this.now() + (this.deps.ciTimeoutMs ?? DEFAULTS.ciTimeoutMs);
    for (;;) {
      signal.throwIfAborted();
      const seen = await this.observe(entry);
      if (seen && seen.state === "MERGED") return "merged";
      if (seen?.head === sha) {
        // Only SUCCESS is green; a rollup that is not there yet means the push has no checks yet.
        if (seen.ci === "SUCCESS") return "green";
        if (seen.ci && seen.ci !== "PENDING" && seen.ci !== "EXPECTED")
          throw new LandBlocked(`CI failed: ${seen.failing.join(", ") || "unknown check"}`);
      }
      if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
      await this.sleep(pollMs, signal);
    }
  }

  private async merge(
    entry: LandEntry,
    run: Run,
    cwd: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.store.updateLandEntry(entry.id, { state: "merging", pushedSha: sha });
    // A land never arms auto-merge: it would let a later push land without the factory checking it.
    const outcome = await mergePullRequest(entry.prUrl, cwd, undefined, signal, undefined, {
      expectedHead: sha,
      auto: false,
    });
    if (outcome !== "merged") {
      await disableAutoMerge(entry.prUrl, cwd, signal).catch(() => undefined);
      throw new LandBlocked(outcome === "unavailable" ? "GitHub unavailable" : "merge failed");
    }
    this.landed(entry, run, sha);
  }

  // ---- helpers -------------------------------------------------------------

  private context(entry: LandEntry): { repo: Repo; run: Run } {
    const run = this.store.getRun(entry.runId);
    const repo = this.store.getRepoBySlug(entry.repo);
    if (!run) throw new Error(`run ${entry.runId} is gone`);
    if (!repo) throw new Error(`repository ${entry.repo} is gone`);
    return { repo, run };
  }

  private worktreePath(entry: LandEntry): string {
    return join(this.deps.paths.work, `land-${entry.id}`);
  }

  /** A detached checkout of `sha`; the hardened git wrapper needs its record before PR code runs. */
  private async checkout(
    entry: LandEntry,
    repo: Repo,
    cache: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<string> {
    const path = this.worktreePath(entry);
    await removeWorktree(this.deps.paths, repo, path); // a previous attempt's linked worktree
    rmSync(path, { recursive: true, force: true });
    try {
      await addDetachedWorktree(cache, sha, path, signal);
    } catch (error) {
      // A crashed attempt leaves the cache's registration behind; prune it and try once more.
      signal.throwIfAborted();
      this.log(`[land] retrying checkout of ${sha.slice(0, 12)} after ${String(error)}`);
      await worktreeGit(["git", "worktree", "prune"], { cwd: cache, allowFail: true });
      await addDetachedWorktree(cache, sha, path, signal);
    }
    return path;
  }

  private async discard(repo: Repo, cwd: string): Promise<void> {
    await removeWorktree(this.deps.paths, repo, cwd).catch((error: unknown) =>
      this.log(`[land] worktree ${cwd} not removed: ${String(error)}`),
    );
    rmSync(cwd, { recursive: true, force: true });
  }

  private async observe(entry: LandEntry): Promise<LandObservation | null> {
    const fromPoller = this.deps.polling === false ? null : saved(this.store.githubPrData(entry.prUrl));
    if (fromPoller) return fromPoller;
    const pr = await (this.deps.client ?? getGitHubPr)(entry.prUrl);
    if (!pr) return null;
    return {
      head: pr.headRefOid ?? "",
      state: pr.state,
      ci: pr.ci ?? null,
      failing: pr.failing ?? [],
    };
  }

  /** A cancellable wait on the injected clock, never a bare sleep. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    const set: LandClock["set"] = this.deps.clock?.set ?? ((fn, delay) => setTimeout(fn, delay));
    const clear: LandClock["clear"] =
      this.deps.clock?.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    return new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        clear(id as never);
        reject(signal.reason);
      };
      const id = set(done, ms);
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private block(id: number, reason: string): void {
    const current = this.store.getLandEntry(id);
    if (!current || !this.isActive(current)) return;
    this.log(`[land] ${id} blocked: ${reason}`);
    const entry = this.finish(id, "blocked", reason);
    this.store.landFeed("land.blocked", entry, reason, { reason, pushedSha: entry.pushedSha });
  }

  private finish(id: number, state: LandEntry["state"], reason: string): LandEntry {
    const entry = this.store.updateLandEntry(id, { state, reason });
    if (state === "landed") this.store.landFeed("land.landed", entry, reason);
    return entry;
  }
}
