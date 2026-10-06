import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paths } from "../config.ts";
import type { LandEntry, Repo, Run } from "../core/types.ts";
import { ACTIVE_LAND_STATES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { detectGates } from "../gates/detect.ts";
import { checkPrivateText, loadPrivateStrings } from "../gates/private.ts";
import { runGates } from "../gates/run.ts";
import { worktreeGit } from "../git/command.ts";
import { completeMerge, prepareMerge } from "../git/merge.ts";
import {
  addDetachedWorktree,
  checkPrivateRange,
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
import { type GhRunner, runGh } from "../integrations/github.ts";
import {
  ciRunsSchema,
  type GitHubPrView,
  getGitHubCiRuns,
  getGitHubPr,
} from "../integrations/github-notifier.ts";
import { savedSnapshot } from "../integrations/github-poller.ts";

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

/** The `gh pr view` client a land reads its CI from when polling is off. */
export type LandPrClient = (url: string, signal?: AbortSignal) => Promise<GitHubPrView | null>;

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
  gh?: GhRunner;
  clock?: LandClock;
  /** How often CI is looked at while a land waits; 15s, like a delivered PR's poll. */
  ciPollMs?: number;
  /** How long a land waits for CI before it gives up. */
  ciTimeoutMs?: number;
  confinement?: ConfinementBackend;
  log?: (message: string) => void;
}

const DEFAULTS = { ciPollMs: 15_000, ciTimeoutMs: 60 * 60_000 };
/** The poller's verdicts, as feed items; they are what moves a CI wait. */
const CI_FEED = new Set(["pr.ci_passed", "pr.ci_failed"]);
const UNSETTLED_CI = new Set(["PENDING", "EXPECTED"]);
/**
 * Checks whose failures are the infrastructure's rather than the change's: one rerun, then block.
 * #353 replaces this with a policy over the whole run; it is deliberately a short explicit list.
 */
const TRANSIENT_CI =
  /flaky|network|timed? ?out|timeout|cancel|beacon|startup|action required|infrastructure/i;
/** A claim has to be this quiet before another queue may take the entry it holds. */
const CLAIM_STALE_MS = 30_000;

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
  private readonly owner = randomUUID();

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

  /** Resume unowned or expired claims, then wait for new requests. */
  start(): void {
    this.stopped = false;
    if (!this.workers.size) this.store.releaseLandClaims(this.owner);
    for (const entry of this.store.listLandEntries({ active: true })) this.pump(entry.repo);
  }

  /** Abort in-flight git, gates and `gh` calls; entries keep their state for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort();
    await Promise.all([...this.workers.values()].map((worker) => worker.catch(() => undefined)));
    this.store.releaseLandClaims(this.owner);
  }

  list(): LandEntry[] {
    return this.store.listLandEntries({ limit: 100 });
  }

  /**
   * Queue a land for a run id, a pull request URL or a pull request number. The approval is the
   * PR's recorded review approval; `sha` names one explicitly and must be the PR's current head.
   */
  request(input: { target: string; sha?: string }): LandEntry {
    const run = this.store.getRun(input.target) ?? this.store.runForPr(this.prRef(input.target));
    if (!run) throw new Error("run not found");
    const repo = this.store.getRepoBySlug(run.repoSlug);
    if (repo?.kind !== "github") throw new Error("run is not on a GitHub repository");
    if (!run.prUrl) throw new Error("run has no pull request");
    const observed = this.savedReport(run.prUrl);
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
      if (!head || head !== given) throw new Error("sha is not the pull request's current head");
      return given;
    }
    const approval = this.store.approvalFor(prUrl);
    if (!approval) throw new Error("no review approval for this pull request");
    if (approval.stale) throw new Error("review approval is stale: the head moved after it");
    return approval.sha;
  }

  /** A PR URL as given, or the bare number in `#12`/`12`; a run id is looked up first anyway. */
  private prRef(target: string): string {
    return target.match(/(?:^|#)\d+$/)?.[0].replace(/^#/, "") ?? target;
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
        const entry = this.store.claimLandEntry(repo, CLAIM_STALE_MS, this.owner, this.now());
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
    const set = this.deps.clock?.set ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.deps.clock?.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const beat = (): void => {
      if (!this.store.heartbeatLandClaim(entry.id, this.owner, this.now())) controller.abort();
      else heartbeat = set(beat, CLAIM_STALE_MS / 3);
    };
    let heartbeat = set(beat, CLAIM_STALE_MS / 3);
    // `checking` re-runs the checks from the start, like a `queued` entry.
    const work = () => this.land(entry, signal);
    try {
      await (this.deps.confinement ? confinementScope.run(this.deps.confinement, work) : work());
    } catch (error) {
      // A cancel or a shutdown aborts on purpose: the entry keeps its state for the next start.
      if (controller.signal.aborted) return;
      this.block(entry.id, (error as Error).message);
    } finally {
      clear(heartbeat);
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
      const baseSha = await fetchBase(this.deps.paths, repo, entry.baseBranch, signal);
      let head = entry.pushedSha;
      if (!head) {
        head = await this.mergeBase(cwd, entry, baseSha);
        await this.checks(entry, cwd, baseSha, signal);
        await checkPrivateRange(cwd, `${baseSha}..${head}`, this.publication(entry, run, cwd));
        if (head !== entry.approvedSha) await this.pushApproved(entry, cwd, repo, head, signal);
        // Recorded either way: with it, a resume waits for this commit instead of checking again.
        this.store.updateLandEntry(entry.id, { pushedSha: head, state: "waiting_ci" });
      }
      if (entry.pushedSha)
        await checkPrivateRange(cwd, `${baseSha}..${head}`, this.publication(entry, run, cwd));
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
  private async checks(entry: LandEntry, cwd: string, baseSha: string, signal: AbortSignal): Promise<void> {
    const log = join(this.deps.paths.runs, entry.runId, `land-${entry.id}.log`);
    const base = `${cwd}-base`;
    try {
      rmSync(base, { recursive: true, force: true });
      mkdirSync(base, { recursive: true });
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, `# land ${entry.id} ${entry.prUrl} at ${entry.approvedSha}\n`);
      await exportCommit(cwd, baseSha, base, signal);
      // The gate slot comes from runGates itself: one lease, never a second one on top.
      const run = await runGates(cwd, detectGates(base), signal, {
        holder: "land",
        onResult: (r) => appendFileSync(log, `\n$ ${r.command}\n${r.output}\n`),
      });
      this.store.updateLandEntry(entry.id, { logPath: log });
      const failed = run.setupOk ? run.checks.filter((c) => !c.ok) : run.setup.filter((c) => !c.ok);
      if (failed.length) throw new LandBlocked(`${failed.map((c) => c.name).join(", ")} failed (${log})`);
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
    await pushExistingBranch(repo, cwd, entry.headBranch, entry.approvedSha, signal, undefined, head);
  }

  /**
   * Wait for CI on exactly `sha`. Every saved PR observation moves the wait;
   * the fallback read covers a restart and polling off. A head that moved after we saw ours blocks
   * at once, and a transient failure is re-run once.
   */
  private async awaitCi(entry: LandEntry, sha: string, signal: AbortSignal): Promise<"green" | "merged"> {
    const deadline = this.now() + (this.deps.ciTimeoutMs ?? DEFAULTS.ciTimeoutMs);
    let rerun = entry.ciRerun ? ciRunsSchema.parse(JSON.parse(entry.ciRerun)) : null;
    for (;;) {
      signal.throwIfAborted();
      const seen = await this.observe(entry.prUrl, signal, sha);
      if (seen?.state === "MERGED") return "merged";
      if (seen?.head && seen.head !== sha) throw new LandBlocked("head moved after approval");
      if (rerun) {
        const current = await getGitHubCiRuns(entry.repo, sha, signal, this.deps.gh);
        const attempts = rerun.map((old) => current.find((run) => run.databaseId === old.databaseId));
        if (
          attempts.some(
            (run, i) => !run || run.attempt <= (rerun?.[i]?.attempt ?? 0) || run.status !== "completed",
          )
        ) {
          if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
          await this.ciWake(entry, signal);
          continue;
        }
        if (attempts.some((run) => run?.conclusion !== "success"))
          throw new LandBlocked(`CI failed: ${seen?.failing.join(", ") || "rerun"}`);
      }
      if (rerun && seen?.ci !== "SUCCESS") {
        if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
        await this.ciWake(entry, signal);
        continue;
      }
      if (seen?.head === sha && seen.ci && !UNSETTLED_CI.has(seen.ci)) {
        if (seen.ci === "SUCCESS") return "green";
        if (!rerun && seen.failing.length > 0 && seen.failing.every((n) => TRANSIENT_CI.test(n))) {
          const runs = await getGitHubCiRuns(entry.repo, sha, signal, this.deps.gh);
          rerun = runs.filter(
            (run) =>
              run.status === "completed" &&
              ["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(
                run.conclusion ?? "",
              ),
          );
          if (!rerun.length) throw new LandBlocked("CI has no failed workflow to rerun");
          // Persist before requesting: a crash must never request a second rerun for this land.
          this.store.updateLandEntry(entry.id, { ciRerun: JSON.stringify(rerun) });
          for (const run of rerun)
            await (this.deps.gh ?? runGh)(
              ["run", "rerun", String(run.databaseId), "--failed", "--repo", entry.repo],
              signal,
            );
          this.log(`[land] ${entry.id}: transient CI failure; re-running`);
          await this.ciWake(entry, signal);
          continue;
        }
        throw new LandBlocked(`CI failed: ${seen.failing.join(", ") || "unknown check"}`);
      }
      if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
      await this.ciWake(entry, signal);
    }
  }

  /** Resolves on the next observation for this PR, the fallback tick, or an abort. */
  private ciWake(entry: LandEntry, signal: AbortSignal): Promise<void> {
    const set = this.deps.clock?.set ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.deps.clock?.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    return new Promise((resolve) => {
      const id = set(() => done(), this.deps.ciPollMs ?? DEFAULTS.ciPollMs);
      const unsubscribe = this.store.subscribe((msg) => {
        if (
          (msg.kind === "github_pr" && msg.url === entry.prUrl) ||
          (msg.kind === "feed" && CI_FEED.has(msg.item.kind) && msg.item.data.url === entry.prUrl)
        )
          done();
      });
      function done() {
        clear(id);
        unsubscribe();
        signal.removeEventListener("abort", done);
        resolve();
      }
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
  }

  private async merge(
    entry: LandEntry,
    run: Run,
    cwd: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.store.updateLandEntry(entry.id, { state: "merging", pushedSha: sha });
    // A land never arms auto-merge: it would let a later push land without the factory checking it,
    // and the squash message is what was reviewed rather than whatever the PR says today.
    const outcome = await mergePullRequest(
      entry.prUrl,
      cwd,
      sha,
      signal,
      undefined,
      this.publication(entry, run, cwd),
      {
        title: run.title ?? "",
        body: this.store.getArtifact(run.id, "report.md") ?? "",
        auto: false,
      },
    );
    if (outcome !== "merged") {
      await disableAutoMerge(entry.prUrl, cwd, signal).catch(() => undefined);
      throw new LandBlocked(outcome === "unavailable" ? "GitHub unavailable" : "merge failed");
    }
    this.landed(entry, run, sha);
  }

  // ---- helpers -------------------------------------------------------------

  private publication(entry: LandEntry, run: Run, cwd: string) {
    const { configDir, repos, work } = this.deps.paths;
    const entries = loadPrivateStrings(configDir, [
      cwd,
      this.store.getRepoBySlug(entry.repo)?.localPath,
      repos,
      work,
    ]);
    if (!run.title?.trim()) throw new LandBlocked("missing merge subject");
    checkPrivateText(
      `${run.title} (#${entry.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? ""})`,
      "Merge subject",
      entries,
    );
    checkPrivateText(this.store.getArtifact(run.id, "report.md") ?? "", "Merge body", entries);
    checkPrivateText(entry.headBranch, "Branch name", entries);
    return entries;
  }

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

  /** The poller's saved observation, or null when it holds nothing usable. */
  private savedReport(url: string): LandObservation | null {
    const snapshot = savedSnapshot(this.store.githubPrData(url));
    return snapshot
      ? {
          head: snapshot.headRefOid,
          state: snapshot.state,
          ci: snapshot.ci,
          failing: snapshot.failing.map((f) => f.name),
        }
      : null;
  }

  /** The saved observation when polling is on, `gh pr view` otherwise; cancellable either way. */
  private async observe(url: string, signal: AbortSignal, sha: string): Promise<LandObservation | null> {
    const saved = this.deps.polling === false ? null : this.savedReport(url);
    if (saved && (saved.head === sha || saved.state === "MERGED")) return saved;
    const pr = await (this.deps.client ?? getGitHubPr)(url, signal);
    return pr ? { head: pr.headRefOid ?? "", state: pr.state, ci: pr.ci ?? null, failing: pr.failing } : null;
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
