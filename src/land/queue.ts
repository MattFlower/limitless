import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Config, type Paths, repoSettings } from "../config.ts";
import { isBranchName } from "../core/delivery.ts";
import type { LandEntry, Repo, Run } from "../core/types.ts";
import { ACTIVE_LAND_STATES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { detectGates } from "../gates/detect.ts";
import { executeGate, type GateExecutor } from "../gates/executor.ts";
import { formatGateOutput } from "../gates/failures.ts";
import { findGateCounterpart, redactGateOutput } from "../gates/output.ts";
import { loadPrivateStrings } from "../gates/private.ts";
import { publicationWorktree, sanitizePublication } from "../gates/publication.ts";
import { confinementFailed, type GateResult, retryFailures } from "../gates/run.ts";
import { gateSlotScope } from "../gates/slots.ts";
import { cacheGit, worktreeGitScope } from "../git/command.ts";
import { completeMerge, prepareMerge } from "../git/merge.ts";
import {
  addDetachedWorktree,
  checkPrivatePublication,
  disableAutoMerge,
  ensureCache,
  exportCommit,
  fetchBase,
  headSha,
  isAncestor,
  mergePullRequest,
  pushExistingBranch,
  remoteBranchSha,
  removeWorktree,
  squashTitle,
  withGitHubRetry,
} from "../git/repos.ts";
import { type ReadPolicyOptions, readPolicyScope } from "../harness/read-policy.ts";
import { type ConfinementBackend, confinementScope } from "../harness/sandbox.ts";
import { ciDecision, headMoved } from "../integrations/ci-classifier.ts";
import { type GhRunner, runGh } from "../integrations/github.ts";
import {
  ciRunsSchema,
  type GitHubPrView,
  getGitHubCiRuns,
  getGitHubPr,
} from "../integrations/github-notifier.ts";
import {
  type GitHubClient,
  ghClient,
  normalizePr,
  OBSERVE_QUERY,
  type PrSnapshot,
  savedSnapshot,
} from "../integrations/github-poller.ts";
import { processConflictTriggers } from "../pipeline/conflict-round.ts";
import type { RunState } from "../pipeline/context.ts";
import { checkDiscreetCommits, hasFactoryMark } from "../pipeline/markers.ts";
import { renderReportArtifacts, verifiedFailureState } from "../pipeline/report.ts";
import { stripReportManifest } from "../pipeline/report-privacy.ts";
import { redactCredentials } from "../util/proc.ts";

/** A land the factory will not retry: the operator has to look at it. */
export class LandBlocked extends Error {}
class LandConflict extends LandBlocked {}
class LandApprovalStopped extends Error {}
class LandClaimLost extends Error {}

/** What one observation says about the PR the entry is landing. */
export interface LandObservation {
  head: string;
  state: string;
  /** The CI rollup state: "SUCCESS", "FAILURE", "PENDING", "EXPECTED" or null (no checks). */
  ci: string | null;
  failing: string[];
  statusNames?: string[];
  truncated?: boolean;
  mergedBy?: { login: string } | null;
  mergedAt?: string | null;
}

/** Only current review evidence on the approved commit can authorize this operator gate. */
export function hasOtherApproval(snapshot: PrSnapshot, factoryLogin: string | null, sha: string): boolean {
  const reviews = snapshot.reviewEvidence ?? [];
  const authorized = (r: NonNullable<PrSnapshot["reviewEvidence"]>[number]) =>
    r.authorType === "User" && r.canPush === true && typeof r.login === "string" && !!r.login.trim();
  return (
    snapshot.reviewEvidenceComplete === true &&
    !!factoryLogin?.trim() &&
    !reviews.some((r) => authorized(r) && r.state === "CHANGES_REQUESTED") &&
    reviews.some(
      (r) =>
        authorized(r) &&
        r.state === "APPROVED" &&
        r.login?.toLowerCase() !== factoryLogin.toLowerCase() &&
        r.commit === sha,
    )
  );
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
  gateExecutor?: GateExecutor;
  store: Store;
  paths: Paths;
  cfg?: Pick<Config, "repos"> & Partial<Pick<Config, "uiUrl" | "dependabotRouting">>;
  readPolicy?: ReadPolicyOptions;
  /** GitHub polling is on: read the poller's saved observations instead of calling `gh` every cycle. */
  polling?: boolean;
  requiresApproval?: ReadonlySet<string>;
  client?: LandPrClient;
  gh?: GhRunner;
  github?: GitHubClient;
  ciReruns?: boolean;
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
/** A claim has to be this quiet before another queue may take the entry it holds. */
const CLAIM_STALE_MS = 30_000;
const MERGE_METADATA_TIMEOUT_MS = 30_000;

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
  private readonly waiting = new Map<number, { controller: AbortController; work: Promise<void> }>();
  private readonly repump = new Set<string>();
  private conflictStartup?: { controller: AbortController; work: Promise<void> };
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
    if (!this.conflictStartup) {
      const controller = new AbortController();
      const work = processConflictTriggers(this.store, this.now, this.deps.gh, controller.signal).catch(
        (error: unknown) => {
          if (!controller.signal.aborted) this.log(redactCredentials(`[conflict] ${String(error)}`));
        },
      );
      this.conflictStartup = { controller, work };
    }
    if (!this.workers.size) this.store.releaseLandClaims(this.owner);
    for (const entry of this.store.listLandEntries({ active: true })) {
      if (entry.state === "waiting_approval") this.watchApproval(entry);
      else this.pump(entry.repo);
    }
  }

  /** Abort in-flight git, gates and `gh` calls; entries keep their state for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.conflictStartup?.controller.abort();
    for (const wait of this.waiting.values()) wait.controller.abort();
    for (const controller of this.inFlight.values()) controller.abort();
    await this.conflictStartup?.work;
    this.conflictStartup = undefined;
    await Promise.all([...this.waiting.values()].map((wait) => wait.work));
    if (!this.workers.size) return;
    await Promise.all([...this.workers.values()].map((worker) => worker.catch(() => undefined)));
    this.store.releaseLandClaims(this.owner);
  }

  list(runId?: string): LandEntry[] {
    if (runId !== undefined) {
      const run = this.store.getRun(runId);
      if (!run) throw new Error("run not found");
      const entry = this.store.latestLandEntry(run.id, run.prUrl);
      return entry ? [entry] : [];
    }
    return this.store.listLandEntries({ limit: 100 });
  }

  /**
   * Queue a land for a run id, a pull request URL or a pull request number. The approval is the
   * PR's recorded review approval; `sha` names one explicitly and must be the PR's current head.
   */
  async request(input: { target: string; sha?: string }): Promise<LandEntry> {
    const run = this.store.getRun(input.target) ?? this.store.runForPr(this.prRef(input.target));
    if (!run) return this.requestUnowned(input);
    const repo = this.store.getRepoBySlug(run.repoSlug);
    if (repo?.kind !== "github") throw new Error("run is not on a GitHub repository");
    if (!run.prUrl) throw new Error("run has no pull request");
    this.store.assertNoRoundInFlight(run.prUrl);
    const observed = this.savedReport(run.prUrl);
    if (observed && observed.state !== "OPEN") throw new Error(`pull request is ${observed.state}`);
    this.approval(run.prUrl, input.sha, observed?.head);
    const headBranch = run.deliveryBranch ?? run.branch;
    if (!headBranch) throw new Error("run has no delivery branch");
    let baseBranch = "";
    let blocked: string | undefined;
    try {
      baseBranch = await this.resolveBase(run, run.prUrl, headBranch);
    } catch (error) {
      if (!(error instanceof LandBlocked)) throw error;
      blocked = error.message;
    }
    // A GitHub lookup may have been overtaken by a new head or review verdict.
    const current = this.savedReport(run.prUrl);
    if (current && current.state !== "OPEN") throw new Error(`pull request is ${current.state}`);
    const approved = this.approval(run.prUrl, input.sha, current?.head);
    const entry = this.store.createLandEntry({
      runId: run.id,
      repo: repo.slug,
      prUrl: run.prUrl,
      baseBranch,
      headBranch,
      approvedSha: approved,
    });
    this.store.landFeed("land.queued", entry, `land queued at ${approved.slice(0, 12)}`, {
      state: entry.state,
    });
    if (blocked) {
      this.block(entry.id, blocked);
      return this.store.getLandEntry(entry.id) ?? entry;
    }
    this.pump(entry.repo);
    return entry;
  }

  private async requestUnowned(input: { target: string; sha?: string }): Promise<LandEntry> {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9]\d*$/.exec(input.target);
    if (!match) throw new Error("run not found");
    const repo = this.store.getRepoBySlug(match[1] ?? "");
    if (repo?.kind !== "github")
      throw new Error(`repository ${match[1]} is not a configured GitHub repository`);
    if (!input.sha?.trim()) throw new Error("a pull request no factory run opened needs --sha <full sha>");
    const json = await (this.deps.gh ?? runGh)([
      "pr",
      "view",
      input.target,
      "--json",
      "url,state,headRefOid,headRefName,baseRefName,title,isCrossRepository",
    ]);
    const pr = z
      .object({
        url: z.string(),
        state: z.string(),
        headRefOid: z.string(),
        headRefName: z.string(),
        baseRefName: z.string(),
        title: z.string(),
        isCrossRepository: z.boolean(),
      })
      .parse(JSON.parse(String(json)));
    if (pr.url !== input.target) throw new Error("pull request URL differs from the requested URL");
    if (pr.state !== "OPEN") throw new Error(`pull request is ${pr.state}`);
    if (pr.isCrossRepository) throw new Error("cross-repository pull requests cannot be landed");
    if (!pr.title.trim()) throw new Error("missing merge subject");
    if (!isBranchName(pr.headRefName)) throw new Error("invalid PR head branch");
    if (!isBranchName(pr.baseRefName) || pr.baseRefName === pr.headRefName)
      throw new Error("cannot determine PR base branch: no valid base distinct from the head branch");
    this.store.assertNoRoundInFlight(pr.url);
    const approved = this.approval(pr.url, input.sha, pr.headRefOid);
    const entry = this.store.createLandEntry({
      runId: null,
      title: pr.title,
      repo: repo.slug,
      prUrl: pr.url,
      baseBranch: pr.baseRefName,
      headBranch: pr.headRefName,
      approvedSha: approved,
    });
    this.store.landFeed("land.queued", entry, `land queued at ${approved.slice(0, 12)}`, {
      state: entry.state,
    });
    this.pump(entry.repo);
    return entry;
  }

  /** Round delivery targets the PR head; only its owning run can supply the PR base. */
  private async resolveBase(run: Run | null, prUrl: string, headBranch: string, signal?: AbortSignal) {
    const round = run && this.store.reviewRound(run.id);
    const owner = round?.owner ?? (run?.sourceRef?.kind === "review-round" ? null : run);
    const valid = (branch: unknown): branch is string =>
      typeof branch === "string" && isBranchName(branch) && branch !== headBranch;
    if (owner?.sourceRef?.kind !== "review-round" && valid(owner?.baseBranch)) return owner.baseBranch;
    try {
      const json = await (this.deps.gh ?? runGh)(["pr", "view", prUrl, "--json", "baseRefName"], signal);
      const view = z.object({ baseRefName: z.string() }).safeParse(JSON.parse(String(json)));
      if (view.success && valid(view.data.baseRefName)) return view.data.baseRefName;
    } catch {
      signal?.throwIfAborted();
    }
    throw new LandBlocked(
      "cannot determine PR base branch: owning run and GitHub provide no valid base distinct from the head branch",
    );
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
    this.waiting.get(id)?.controller.abort();
    this.finish(id, "cancelled", "cancelled");
    return true;
  }

  private isActive(entry: LandEntry): boolean {
    return ACTIVE_LAND_STATES.includes(entry.state);
  }

  /** Drain this repository's queue: claim the next entry and land it, until there is none. */
  private pump(repo: string): void {
    if (this.stopped) return;
    if (draining.has(repo)) {
      if (draining.get(repo) === this) this.repump.add(repo);
      return;
    }
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
        if (this.repump.delete(repo)) this.pump(repo);
      });
  }

  private async process(entry: LandEntry): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(entry.id, controller);
    const signal = controller.signal;
    const set = this.deps.clock?.set ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.deps.clock?.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const beat = (): void => {
      if (!this.store.ownsLandClaim(entry.id, this.owner)) {
        controller.abort();
        return;
      }
      const current = this.store.getLandEntry(entry.id);
      if (current && !this.isActive(current)) return;
      if (!this.store.heartbeatLandClaim(entry.id, this.owner, this.now())) controller.abort();
      else heartbeat = set(beat, CLAIM_STALE_MS / 3);
    };
    let heartbeat = set(beat, CLAIM_STALE_MS / 3);
    // `checking` re-runs the checks from the start, like a `queued` entry.
    const work = () =>
      readPolicyScope.run(this.deps.readPolicy, () =>
        worktreeGitScope.run(true, () => this.land(entry, signal)),
      );
    try {
      await (this.deps.confinement ? confinementScope.run(this.deps.confinement, work) : work());
    } catch (error) {
      // A cancel or a shutdown aborts on purpose: the entry keeps its state for the next start.
      if (controller.signal.aborted || error instanceof LandClaimLost) return;
      clear(heartbeat);
      const blocked = this.store.transaction(() => {
        if (!this.store.ownsLandClaim(entry.id, this.owner)) return false;
        this.block(entry.id, (error as Error).message, error instanceof LandConflict);
        return true;
      });
      if (!blocked) return;
      await processConflictTriggers(this.store, this.now, this.deps.gh, signal).catch((error: unknown) => {
        if (!signal.aborted) this.log(redactCredentials(`[conflict] ${String(error)}`));
      });
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
    // Claims reset merging to checking; any recorded push may have merged before a restart.
    if (entry.pushedSha) {
      const fresh = await this.mergeMetadata(entry.prUrl, signal);
      signal.throwIfAborted();
      this.assertClaim(entry.id);
      if (fresh?.url === entry.prUrl && fresh.state === "CLOSED")
        throw new LandBlocked("PR was closed without merging");
      if (!fresh || fresh.url !== entry.prUrl || !["OPEN", "MERGED"].includes(fresh.state))
        throw new LandBlocked("cannot confirm current GitHub merge state");
      if (fresh.state === "MERGED") {
        this.landed(entry, repo, entry.pushedSha, { ...fresh, head: fresh.headRefOid ?? "" });
        await this.discard(repo, this.worktreePath(entry));
        return;
      }
      if (!fresh.headRefOid) throw new LandBlocked("PR head is missing");
      if (headMoved(fresh.headRefOid ?? "", entry.pushedSha, entry.approvedSha))
        throw new LandBlocked("head moved after approval");
    }
    const preflight = z.object({
      url: z.literal(entry.prUrl),
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      isDraft: z.boolean(),
      headRefOid: z.string().nullish(),
      mergedBy: z.object({ login: z.string() }).nullish(),
      mergedAt: z.string().nullish(),
    });
    let fresh: z.infer<typeof preflight>;
    try {
      const json = await withGitHubRetry(
        async () =>
          (this.deps.gh ?? runGh)(
            ["pr", "view", entry.prUrl, "--json", "url,state,isDraft,headRefOid,mergedBy,mergedAt"],
            signal,
          ),
        { signal },
      );
      fresh = preflight.parse(JSON.parse(String(json)));
    } catch (error) {
      throw new LandBlocked(`cannot inspect current GitHub PR metadata: ${String(error)}`);
    }
    signal.throwIfAborted();
    this.assertClaim(entry.id);
    if (fresh.state === "CLOSED") throw new LandBlocked("PR was closed without merging");
    // A PR merged outside the queue is recorded as landed when it merged the approved head.
    if (fresh.state === "MERGED") {
      this.landed(entry, repo, entry.approvedSha, {
        ...fresh,
        head: fresh.headRefOid ?? "",
        ci: null,
        failing: [],
      });
      await this.discard(repo, this.worktreePath(entry));
      return;
    }
    // Approval does not publish a draft as ready for review.
    if (fresh.isDraft) throw new LandBlocked("PR is a draft");
    if (!fresh.headRefOid) throw new LandBlocked("PR head is missing");
    if (headMoved(fresh.headRefOid, entry.pushedSha ?? entry.approvedSha, entry.approvedSha))
      throw new LandBlocked("head moved after approval");
    if (this.deps.requiresApproval?.has(entry.repo.toLowerCase())) {
      const evidence = await this.approvalEvidence(entry, signal);
      signal.throwIfAborted();
      this.assertClaim(entry.id);
      this.checkApprovalHead(entry, evidence.seen);
      if (evidence.seen?.state === "MERGED") {
        this.landed(entry, repo, entry.pushedSha ?? entry.approvedSha, {
          ...evidence.seen,
          head: evidence.seen.headRefOid,
          failing: evidence.seen.failing.map((f) => f.name),
        });
        return;
      }
      if (!this.qualifies(entry, evidence)) {
        this.parkApproval(entry, signal, evidence.seen);
        return;
      }
    }
    if (!entry.baseBranch || entry.baseBranch === entry.headBranch) {
      const baseBranch = await this.resolveBase(run, entry.prUrl, entry.headBranch, signal);
      signal.throwIfAborted();
      // Checks recorded against the head as its own base do not cover the resolved base.
      entry = this.owned(entry.id, () =>
        this.store.updateLandEntry(entry.id, { baseBranch, pushedSha: null, ciRerun: null }),
      );
    }
    const ownerId = run?.sourceRef?.kind === "review-round" ? run.sourceRef.runId : run?.id;
    const owner = typeof ownerId === "string" ? this.store.getRun(ownerId) : null;
    const title = run ? owner?.title : entry.title;
    if (!title?.trim()) throw new LandBlocked("missing merge subject");
    const subject = squashTitle(title, entry.prUrl);
    // The claim already moved the entry into `checking` and counted this attempt.
    this.log(`[land] ${entry.id}: checking ${entry.prUrl} at ${entry.approvedSha.slice(0, 12)}`);
    const cache = await ensureCache(this.deps.paths, repo, signal);
    const cwd = await this.checkout(entry, repo, cache, entry.pushedSha ?? entry.approvedSha, signal);
    try {
      const baseSha = await fetchBase(this.deps.paths, repo, entry.baseBranch, signal);
      let head = entry.pushedSha;
      let body = "";
      if (!head) {
        head = await this.mergeBase(cwd, entry, baseSha);
        await this.checks(entry, cwd, baseSha, signal);
        body = await this.checkPublication(entry, run, cwd, baseSha, head, subject);
        if (head !== entry.approvedSha) await this.pushApproved(entry, cwd, repo, head, signal);
        // Recorded either way: with it, a resume waits for this commit instead of checking again.
        const waiting = this.owned(entry.id, () => {
          signal.throwIfAborted();
          if (this.store.getLandEntry(entry.id)?.state !== "checking") return false;
          this.store.updateLandEntry(entry.id, { pushedSha: head, state: "waiting_ci" });
          return true;
        });
        if (!waiting) return;
      }
      if (entry.pushedSha) body = await this.checkPublication(entry, run, cwd, baseSha, head, subject);
      const ci = await this.awaitCi(entry, head, signal);
      if (ci !== "green") return this.landed(entry, repo, head, ci);
      await this.merge(entry, repo, cwd, head, subject, body, signal);
    } finally {
      await this.discard(repo, cwd);
    }
  }

  private qualifies(entry: LandEntry, evidence: { seen: PrSnapshot | null; login: string | null }): boolean {
    const { seen, login } = evidence;
    return (
      !!seen &&
      seen.requestSeq === this.store.githubReview(entry.prUrl)?.requestSeq &&
      (seen.state === "MERGED" ||
        (seen.state === "OPEN" &&
          (hasOtherApproval(seen, login, entry.approvedSha) ||
            (!!entry.pushedSha && hasOtherApproval(seen, login, entry.pushedSha)))))
    );
  }

  private checkApprovalHead(entry: LandEntry, seen: PrSnapshot | null): void {
    if (!seen || seen.state === "MERGED") return;
    if (seen.state === "CLOSED") throw new LandBlocked("PR was closed without merging");
    if (seen.isDraft) throw new LandBlocked("PR is a draft");
    if (headMoved(seen.headRefOid, entry.pushedSha ?? entry.approvedSha, entry.approvedSha))
      throw new LandBlocked("head moved after approval");
  }

  /** Fresh direct evidence at claim and immediately before merge; saved evidence only while parked. */
  private async approvalEvidence(entry: LandEntry, signal: AbortSignal, saved = false) {
    const client = this.deps.github ?? ghClient;
    try {
      const identity = await client("user", undefined, signal);
      const parsed = z.object({ login: z.string().trim().min(1) }).safeParse(identity.body);
      const login = identity.status === 200 && parsed.success ? parsed.data.login : null;
      if (saved) {
        const seen = this.store.githubReview(entry.prUrl);
        if (
          seen?.url !== entry.prUrl ||
          !seen.requestSeq ||
          seen.requestSeq <= (entry.approvalWaitRequestSeq ?? Infinity)
        )
          return { login, seen: null };
        if (seen.reviewEvidenceComplete) return { login, seen };
        // A newer, truncated poll can wake the wait, but only complete direct evidence releases it.
      }
      const { requestSeq, observations } = this.store.transaction(() => ({
        requestSeq: this.store.nextGithubObservationSeq(),
        observations: this.store.githubReviewObservationCount(entry.prUrl),
      }));
      const pr = await client(
        `repos/${entry.repo}/pulls/${entry.prUrl.split("/").at(-1)}`,
        undefined,
        signal,
      );
      if (pr.status !== 200) return { login, seen: null };
      const id = z.object({ node_id: z.string() }).parse(pr.body).node_id;
      const response = await client("graphql", { query: OBSERVE_QUERY, variables: { ids: [id] } }, signal);
      const data = z
        .object({
          data: z.object({ nodes: z.array(z.unknown()).length(1) }),
          errors: z.array(z.unknown()).nullish(),
        })
        .safeParse(response.body);
      if (response.status !== 200 || !data.success || data.data.errors?.length) return { login, seen: null };
      const raw = data.data.data.nodes[0];
      const seen = normalizePr(raw, id);
      const page = z
        .object({
          latestOpinionatedReviews: z.object({
            nodes: z.array(z.object({}).passthrough()),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          }),
        })
        .safeParse(raw);
      if (!seen || seen.url !== entry.prUrl || !page.success) return { login, seen: null };
      // Pages are not an atomic review snapshot: a review can be dismissed between reads.
      seen.requestSeq = requestSeq;
      const overlapped = this.store.transaction(() => {
        const changed = observations !== this.store.githubReviewObservationCount(entry.prUrl);
        this.store.saveGithubReview(entry.prUrl, seen);
        return changed;
      });
      return { login, seen, overlapped };
    } catch (error) {
      signal.throwIfAborted();
      this.log(redactCredentials(`[land] ${entry.id}: approval observation pending: ${String(error)}`));
      return { login: null, seen: null };
    }
  }

  private approvalReason(entry: LandEntry, seen: PrSnapshot | null): string {
    return seen?.reviewEvidenceComplete === false
      ? "Review evidence is incomplete because pagination is required"
      : `Another GitHub account must approve ${entry.approvedSha}`;
  }

  private parkApproval(
    entry: LandEntry,
    signal: AbortSignal,
    seen: PrSnapshot | null,
    reason = this.approvalReason(entry, seen),
  ): void {
    const waiting = this.owned(entry.id, () => {
      signal.throwIfAborted();
      const parked = this.store.updateLandEntry(entry.id, {
        state: "waiting_approval",
        reason,
        approvalWaitStartedAt: this.now(),
        approvalWaitRequestSeq: this.store.nextGithubObservationSeq(),
      });
      this.store.landFeed(
        "land.waiting_approval",
        parked,
        reason,
        { state: parked.state, reason },
        `${entry.id}:${entry.attempts}`,
      );
      return parked;
    });
    this.watchApproval(waiting);
  }

  /** Parked entries have no claim and never occupy a repository's worker or running slot. */
  private watchApproval(entry: LandEntry): void {
    if (this.stopped || this.waiting.has(entry.id)) return;
    const controller = new AbortController();
    const { signal } = controller;
    const work = (async () => {
      for (;;) {
        signal.throwIfAborted();
        const current = this.store.releaseLandApproval(entry.id, entry.approvalWaitStartedAt ?? 0, false);
        if (
          current?.state !== "waiting_approval" ||
          current.approvalWaitRequestSeq !== entry.approvalWaitRequestSeq
        )
          return;
        const snapshot = this.store.githubPrData(entry.prUrl);
        const required = this.deps.requiresApproval?.has(entry.repo.toLowerCase());
        const evidence = required
          ? await this.approvalEvidence(entry, signal, this.deps.polling !== false)
          : null;
        signal.throwIfAborted();
        const released = this.store.transaction(() => {
          const still = this.store.releaseLandApproval(entry.id, entry.approvalWaitStartedAt ?? 0, false);
          if (
            still?.state !== "waiting_approval" ||
            still.approvalWaitRequestSeq !== entry.approvalWaitRequestSeq
          )
            return null;
          try {
            this.checkApprovalHead(entry, evidence?.seen ?? null);
          } catch (error) {
            if (!(error instanceof LandBlocked)) throw error;
            this.block(entry.id, error.message);
            return null;
          }
          const reason = this.approvalReason(entry, evidence?.seen ?? null);
          if (evidence?.seen && still.reason !== reason) {
            const waiting = this.store.updateLandEntry(entry.id, { reason });
            this.store.landFeed(
              "land.waiting_approval",
              waiting,
              reason,
              { state: waiting.state, reason },
              `${entry.id}:${still.approvalWaitRequestSeq}:${reason}`,
            );
          }
          return this.store.releaseLandApproval(
            entry.id,
            entry.approvalWaitStartedAt ?? 0,
            !required || (!!evidence && this.qualifies(entry, evidence)),
          );
        });
        if (released?.state === "queued") {
          this.pump(entry.repo);
          return;
        }
        if (this.store.getLandEntry(entry.id)?.state !== "waiting_approval") return;
        await this.ciWake(entry, signal, snapshot);
      }
    })()
      .catch((error: unknown) => {
        if (!signal.aborted) this.log(redactCredentials(`[land] ${entry.id}: ${String(error)}`));
      })
      .finally(() => this.waiting.delete(entry.id));
    this.waiting.set(entry.id, { controller, work });
  }

  /** A PR that already merged is recorded, never merged again. */
  private landed(entry: LandEntry, repo: Repo, sha: string, observation: LandObservation | null): void {
    if (observation?.state === "MERGED" && observation.head !== sha)
      throw new LandBlocked("merged PR head is missing or differs from the pushed SHA");
    const at = observation?.mergedAt ? Date.parse(observation.mergedAt) : NaN;
    const mergedBy = observation?.state === "MERGED" ? (observation.mergedBy?.login ?? null) : null;
    const mergedAt = observation?.state === "MERGED" && Number.isFinite(at) ? at : null;
    this.owned(entry.id, () => {
      const current = this.store.getLandEntry(entry.id);
      if (current && this.isActive(current))
        this.finish(
          entry.id,
          "landed",
          `${current.reason?.startsWith("flaky:") ? `${current.reason}; ` : ""}merged ${sha.slice(0, 12)}`,
        );
      this.store.resolveMergedPr(repo.id, entry.prUrl, mergedBy, mergedAt, this.now());
    });
    this.log(`[land] ${entry.id}: merged ${entry.prUrl}`);
  }

  /** The approved head, with the base merged in when it is not already an ancestor. */
  private async mergeBase(cwd: string, entry: LandEntry, baseSha: string): Promise<string> {
    if (await isAncestor(cwd, baseSha, entry.approvedSha)) return entry.approvedSha;
    const conflicts = await prepareMerge(cwd, entry.approvedSha, baseSha);
    if (conflicts.length) throw new LandConflict(`conflicts with ${entry.baseBranch}`);
    return completeMerge(
      cwd,
      entry.approvedSha,
      baseSha,
      `${repoSettings(this.deps.cfg ?? {}, entry.repo).discreet ? "Merge" : "limitless: merge"} base ${baseSha}`,
      repoSettings(this.deps.cfg ?? {}, entry.repo).discreet ? "operator" : "factory",
    );
  }

  /** The repository's checks, taken from the base commit so the PR cannot weaken them. */
  private async checks(entry: LandEntry, cwd: string, baseSha: string, signal: AbortSignal): Promise<void> {
    const log = entry.runId
      ? join(this.deps.paths.runs, entry.runId, `land-${entry.id}.log`)
      : join(this.deps.paths.home, "land", `land-${entry.id}.log`);
    const base = `${cwd}-base`;
    try {
      rmSync(base, { recursive: true, force: true });
      mkdirSync(base, { recursive: true });
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, `# land ${entry.id} ${entry.prUrl} at ${entry.approvedSha}\n`);
      await exportCommit(cwd, baseSha, base, signal);
      const gates = detectGates(base);
      const request = {
        repo: entry.repo,
        cwd,
        baseSha,
        headSha: await headSha(cwd),
        gates,
        priority: "ship" as const,
      };
      const hooks = {
        holder: "land",
        onResult: (r: GateResult) =>
          appendFileSync(
            log,
            redactGateOutput(`\n$ ${r.command}\n${r.failures ? formatGateOutput(r, 9_000) : r.output}\n`),
          ),
      };
      await gateSlotScope(async () => {
        const run = await executeGate(request, signal, hooks, this.deps.gateExecutor);
        signal.throwIfAborted();
        this.owned(entry.id, () => this.store.updateLandEntry(entry.id, { logPath: log }));
        const selected = run.setupOk
          ? run.checks.flatMap((original) => {
              const check = findGateCounterpart(original, run.checks, gates.checks);
              return check?.run === original.command ? [{ check, original }] : [];
            })
          : [];
        const retries = await retryFailures(
          selected,
          cwd,
          gates,
          signal,
          undefined,
          (retry, options) => {
            appendFileSync(log, "\n# targeted retry\n");
            return executeGate(
              { ...request, gates: retry, skipGateSlot: options?.skipGateSlot },
              signal,
              hooks,
              this.deps.gateExecutor,
            );
          },
          true,
          this.deps.gateExecutor?.freshCheckoutFor?.(entry.repo),
        );
        signal.throwIfAborted();
        const failed = [...run.setup, ...run.checks].filter((c) => {
          const result = retries.get(c) ?? c;
          return !result.ok || result.timedOut || confinementFailed(result);
        });
        if (failed.length) throw new LandBlocked(`${failed.map((c) => c.name).join(", ")} failed (${log})`);
        if (retries.size) {
          const reason = redactGateOutput(
            `flaky: ${[...retries.keys()].map((c) => `${c.name} (${c.failedFiles?.join(", ")})`).join("; ")}`,
          );
          this.owned(entry.id, () => {
            this.store.updateLandEntry(entry.id, { reason });
            if (entry.runId)
              this.store.addEvent({
                runId: entry.runId,
                type: "gate",
                level: "warn",
                message: redactGateOutput(`Land ${entry.id} ${reason}`),
              });
          });
        }
      })();
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
    this.owned(entry.id, () => {
      signal.throwIfAborted();
      if (remote !== entry.approvedSha) throw new LandBlocked("head moved after approval");
      this.store.updateLandEntry(entry.id, { pushedSha: head });
    });
    await pushExistingBranch(repo, cwd, entry.headBranch, entry.approvedSha, signal, undefined, head, () =>
      this.assertClaim(entry.id),
    );
  }

  /**
   * Wait for CI on exactly `sha`. Every saved PR observation moves the wait;
   * the fallback read covers a restart and polling off. A head that moved after we saw ours blocks
   * at once, and a transient failure is re-run once.
   */
  private async awaitCi(
    entry: LandEntry,
    sha: string,
    signal: AbortSignal,
  ): Promise<"green" | LandObservation> {
    const deadline = this.now() + (this.deps.ciTimeoutMs ?? DEFAULTS.ciTimeoutMs);
    const rerun = entry.ciRerun ? ciRunsSchema.parse(JSON.parse(entry.ciRerun)) : null;
    // GitHub may still report the approved head while our base merge propagates.
    const unexpectedHead = (head?: string) => !!head && headMoved(head, sha, entry.approvedSha);
    for (;;) {
      signal.throwIfAborted();
      this.assertClaim(entry.id);
      const snapshot = this.store.githubPrData(entry.prUrl);
      const saved = savedSnapshot(snapshot);
      // The approved head can lag our push; any other head must block before a read can stall.
      if (saved?.state !== "MERGED" && unexpectedHead(saved?.headRefOid))
        throw new LandBlocked("head moved after approval");
      const since = this.store.prHead(entry.prUrl)?.version ?? 0;
      const seen = await this.observe(entry.prUrl, signal, sha);
      this.assertClaim(entry.id);
      if (seen?.state === "MERGED") return seen;
      if (unexpectedHead(seen?.head)) throw new LandBlocked("head moved after approval");
      if (rerun) {
        const current = await getGitHubCiRuns(entry.repo, sha, signal, this.deps.gh);
        const attempts = rerun.map((old) => current.find((run) => run.databaseId === old.databaseId));
        if (
          attempts.some(
            (run, i) => !run || run.attempt <= (rerun?.[i]?.attempt ?? 0) || run.status !== "completed",
          )
        ) {
          if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
          await this.ciWake(entry, signal, snapshot);
          continue;
        }
        if (attempts.some((run) => run?.conclusion !== "success"))
          throw new LandBlocked(`CI failed: ${seen?.failing.join(", ") || "rerun"}`);
      }
      if (rerun && seen?.ci !== "SUCCESS") {
        if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
        await this.ciWake(entry, signal, snapshot);
        continue;
      }
      if (seen?.head === sha && seen.ci && !UNSETTLED_CI.has(seen.ci)) {
        const outstanding = this.store
          .ciFailures(entry.prUrl, sha)
          .some((f) => f.outcome === "rerunning" || f.outcome === "rerun_requested");
        if (seen.ci === "SUCCESS" && !outstanding) return "green";
        if (
          !this.owned(entry.id, () => this.store.observePrHead(entry.prUrl, sha, since)) &&
          unexpectedHead(this.store.prHead(entry.prUrl)?.sha)
        )
          throw new LandBlocked("head moved after approval");
        const inspection = new AbortController();
        const inspectionSignal = AbortSignal.any([signal, inspection.signal]);
        const current = () => {
          if (!this.store.ownsLandClaim(entry.id, this.owner)) {
            this.inFlight.get(entry.id)?.abort();
            return false;
          }
          return !inspectionSignal.aborted && !unexpectedHead(this.store.prHead(entry.prUrl)?.sha);
        };
        const snap: PrSnapshot = {
          ...(saved?.headRefOid === sha ? saved : {}),
          id: saved?.id ?? "",
          url: entry.prUrl,
          headRefOid: sha,
          state: seen.state,
          mergeable: null,
          mergeStateStatus: null,
          updatedAt: "",
          mergedAt: null,
          mergedBy: null,
          activity: { review: [], review_comment: [], comment: [] },
          ci: seen.ci,
          failing: seen.failing.map((name) => ({ name, url: null })),
          statusNames: seen.statusNames ?? saved?.statusNames,
          truncated: seen.truncated ?? saved?.truncated,
        };
        const pr = {
          url: entry.prUrl,
          repo: entry.repo,
          runId: entry.runId,
          nodeId: null,
          data: null,
          delivered: 1,
        };
        const before = this.store.ciFailures(entry.prUrl, sha).filter((f) => f.rerunJob).length;
        let decision: Awaited<ReturnType<typeof ciDecision>> | undefined;
        const checkHead = () => {
          const observed = this.savedReport(entry.prUrl);
          if (!current() || (observed?.state !== "MERGED" && unexpectedHead(observed?.head)))
            inspection.abort(new LandBlocked("head moved after approval"));
        };
        const unsubscribe = this.store.subscribe((msg) => {
          if (msg.kind === "github_pr" && msg.url === entry.prUrl) checkHead();
        });
        try {
          checkHead();
          decision = await ciDecision(
            this.store,
            pr,
            snap,
            (_repo, path, body) => (this.deps.github ?? ghClient)(path, body, inspectionSignal),
            this.deps.ciReruns !== false && !rerun,
            current,
            current,
            "land",
            entry.approvedSha,
            current,
          );
          this.assertClaim(entry.id);
        } catch (error) {
          signal.throwIfAborted();
          if (inspection.signal.aborted) throw inspection.signal.reason;
          this.log(`[land] ${entry.id}: CI inspection pending: ${String(error)}`);
        } finally {
          unsubscribe();
        }
        if (decision?.state === "head_moved" || !current()) {
          signal.throwIfAborted();
          throw new LandBlocked("head moved after approval");
        }
        if (this.store.ciFailures(entry.prUrl, sha).filter((f) => f.rerunJob).length > before)
          this.log(`[land] ${entry.id}: transient CI failure; re-running`);
        if (decision?.state === "green") return "green";
        if (decision?.state === "failed")
          throw new LandBlocked(`CI failed: ${seen.failing.join(", ") || "unknown check"}`);
      }
      if (this.now() >= deadline) throw new LandBlocked("CI did not finish");
      await this.ciWake(entry, signal, snapshot);
    }
  }

  /** Resolves on the next observation for this PR, the fallback tick, or an abort. */
  private ciWake(entry: LandEntry, signal: AbortSignal, snapshot: string | null): Promise<void> {
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
      if (signal.aborted || this.store.githubPrData(entry.prUrl) !== snapshot) done();
      else signal.addEventListener("abort", done, { once: true });
    });
  }

  private async merge(
    entry: LandEntry,
    repo: Repo,
    cwd: string,
    sha: string,
    subject: string,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    const guard = async () => {
      this.assertClaim(entry.id);
      if (!this.deps.requiresApproval?.has(entry.repo.toLowerCase())) return;
      let evidence: Awaited<ReturnType<LandQueue["approvalEvidence"]>>;
      let reads = 0;
      do {
        // Request-start order cannot order observations that complete while this read is in flight.
        evidence = await this.approvalEvidence({ ...entry, pushedSha: sha }, signal);
        signal.throwIfAborted();
        this.assertClaim(entry.id);
        reads++;
      } while (evidence.overlapped && reads < 3);
      if (evidence.overlapped) {
        this.parkApproval(
          entry,
          signal,
          evidence.seen,
          "Review state changed during the final approval check",
        );
        throw new LandApprovalStopped();
      }
      this.checkApprovalHead({ ...entry, pushedSha: sha }, evidence.seen);
      if (evidence.seen?.state === "MERGED") {
        this.landed(entry, repo, sha, {
          ...evidence.seen,
          head: evidence.seen.headRefOid,
          failing: evidence.seen.failing.map((f) => f.name),
        });
        throw new LandApprovalStopped();
      }
      if (!this.qualifies({ ...entry, pushedSha: sha }, evidence)) {
        this.parkApproval(entry, signal, evidence.seen);
        throw new LandApprovalStopped();
      }
    };
    const merging = this.owned(entry.id, () => {
      signal.throwIfAborted();
      this.store.assertNoRoundInFlight(entry.prUrl);
      // A resumed entry keeps its pushed SHA but the claim moves it back to checking.
      const expected = entry.pushedSha ? "checking" : "waiting_ci";
      if (this.store.getLandEntry(entry.id)?.state !== expected) return false;
      this.store.updateLandEntry(entry.id, { state: "merging", pushedSha: sha });
      return true;
    });
    if (!merging) return;
    // A land never arms auto-merge: it would let a later push land without the factory checking it,
    // and the squash message is what was reviewed rather than whatever the PR says today.
    let failure: string | undefined;
    const outcome = await mergePullRequest(
      entry.prUrl,
      cwd,
      sha,
      signal,
      undefined,
      this.publication(entry, cwd),
      {
        subject,
        body,
        auto: false,
        guard,
        onFailure: (reason) => {
          failure = reason;
        },
      },
    ).catch((error: unknown) => {
      if (error instanceof LandApprovalStopped) return null;
      throw error;
    });
    if (outcome === null) return;
    signal.throwIfAborted();
    this.assertClaim(entry.id);
    if (outcome !== "merged") {
      await disableAutoMerge(entry.prUrl, cwd, signal).catch(() => undefined);
      throw new LandBlocked(failure ?? (outcome === "unavailable" ? "GitHub unavailable" : "merge failed"));
    }
    this.landed(entry, repo, sha, null);
    const observed = await this.mergeMetadata(entry.prUrl, signal);
    if (observed?.state !== "MERGED" || observed.url !== entry.prUrl) return;
    const at = observed.mergedAt ? Date.parse(observed.mergedAt) : NaN;
    this.owned(entry.id, () =>
      this.store.resolveMergedPr(
        repo.id,
        entry.prUrl,
        observed.mergedBy?.login ?? null,
        Number.isFinite(at) ? at : null,
        this.now(),
      ),
    );
  }

  private async mergeMetadata(url: string, signal: AbortSignal): Promise<GitHubPrView | null> {
    const controller = new AbortController();
    const bounded = AbortSignal.any([signal, controller.signal]);
    const set = this.deps.clock?.set ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.deps.clock?.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const timer = set(() => controller.abort(), MERGE_METADATA_TIMEOUT_MS);
    const aborted = Promise.withResolvers<null>();
    const onAbort = () => aborted.resolve(null);
    bounded.addEventListener("abort", onAbort, { once: true });
    try {
      if (bounded.aborted) return null;
      return await Promise.race([
        (this.deps.client ?? getGitHubPr)(url, bounded).catch(() => null),
        aborted.promise,
      ]);
    } finally {
      clear(timer);
      bounded.removeEventListener("abort", onAbort);
    }
  }

  // ---- helpers -------------------------------------------------------------

  private assertClaim(id: number): void {
    if (!this.store.ownsLandClaim(id, this.owner)) {
      this.inFlight.get(id)?.abort();
      throw new LandClaimLost();
    }
  }

  /** No await may separate ownership validation from a worker's durable write. */
  private owned<T>(id: number, write: () => T): T {
    return this.store.transaction(() => {
      this.assertClaim(id);
      return write();
    });
  }

  private reportBody(run: Run): string {
    const repo = this.store.getRepo(run.repoId);
    const discreet = repoSettings(this.deps.cfg ?? {}, repo?.slug ?? "").discreet;
    const state = this.store.getRunState<RunState>(run.id);
    if (discreet && !state)
      throw new LandBlocked("Discreet mode cannot render squash body: missing run state");
    const worktree = publicationWorktree(state ?? {});
    const success = run.status === "succeeded";
    // A needs-human owner's PR is landable once fixed; describe it as the run left it.
    const verifiedFailure =
      !success && state?.lastVerifiedSha
        ? {
            sha: state.lastVerifiedSha,
            stage: run.stage ?? "deliver",
            reason: state.needsHumanReason ?? run.error ?? run.status,
            base: run.baseBranch ?? repo?.defaultBranch ?? "",
          }
        : undefined;
    const report = discreet
      ? renderReportArtifacts(
          {
            discreet: true,
            success,
            ...(verifiedFailure ? { verifiedFailure } : {}),
            runId: run.id,
            runUrl: "",
            prompt: run.prompt,
            state: verifiedFailure && state ? verifiedFailureState(state) : (state ?? {}),
            invocations: this.store.listInvocations(run.id),
            totals: { costUsd: run.costUsd, costEquivUsd: run.costEquivUsd },
            models: run.models,
            freeFirstRouting:
              run.requestedBy === "dependabot[bot]" && this.deps.cfg?.dependabotRouting === "free_first",
            signalWarnings: this.store.countEvents(run.id, "signal_attempt"),
            ...(run.sourceRef?.kind === "issue" &&
            run.sourceRef.repo === repo?.slug &&
            typeof run.sourceRef.number === "number"
              ? { closesIssue: run.sourceRef.number }
              : {}),
          },
          (text) => sanitizePublication(redactCredentials(text), worktree, this.deps.paths.home),
        ).report
      : (this.store.getArtifact(run.id, "report.md") ?? "");
    const body = sanitizePublication(
      redactCredentials(stripReportManifest(report)),
      worktree,
      this.deps.paths.home,
    );
    if (discreet && hasFactoryMark(body, run.id, this.deps.cfg?.uiUrl))
      throw new LandBlocked("Discreet mode blocked factory marks in squash body");
    return body;
  }

  private async checkPublication(
    entry: LandEntry,
    run: Run | null,
    cwd: string,
    base: string,
    head: string,
    subject: string,
  ) {
    if (repoSettings(this.deps.cfg ?? {}, entry.repo).discreet) {
      if (hasFactoryMark(subject, run?.id ?? "", this.deps.cfg?.uiUrl))
        throw new LandBlocked("Discreet mode blocked factory marks in squash title");
      try {
        await checkDiscreetCommits(
          cwd,
          `${entry.approvedSha}..${head}`,
          base,
          run?.id ?? "",
          this.deps.cfg?.uiUrl,
        );
      } catch (error) {
        throw new LandBlocked(`Discreet mode publication blocked: ${String(error)}`);
      }
    }
    const body = run ? this.reportBody(run) : "";
    await checkPrivatePublication(cwd, this.publication(entry, cwd), {
      squash: {
        base,
        head,
        title: subject,
        body,
      },
      // Select the factory's merge itself, never traverse either parent's existing history.
      ...(head !== entry.approvedSha ? { commits: `${head}^!` } : {}),
    });
    return body;
  }

  private publication(entry: LandEntry, cwd: string) {
    const { configDir, repos, work } = this.deps.paths;
    const entries = loadPrivateStrings(configDir, [
      cwd,
      this.store.getRepoBySlug(entry.repo)?.localPath,
      repos,
      work,
    ]);
    return entries;
  }

  private context(entry: LandEntry): { repo: Repo; run: Run | null } {
    const run = entry.runId ? this.store.getRun(entry.runId) : null;
    const repo = this.store.getRepoBySlug(entry.repo);
    if (entry.runId && !run) throw new Error(`run ${entry.runId} is gone`);
    if (!repo) throw new Error(`repository ${entry.repo} is gone`);
    return { repo, run };
  }

  private worktreePath(entry: LandEntry): string {
    return join(this.deps.paths.work, `land-${entry.id}-${entry.attempts}`);
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
    const legacy = `land-${entry.id}`;
    mkdirSync(this.deps.paths.work, { recursive: true });
    for (const name of readdirSync(this.deps.paths.work)) {
      const base = name.endsWith("-base");
      const checkout = base ? name.slice(0, -5) : name;
      const attempt = checkout.startsWith(`${legacy}-`) ? checkout.slice(legacy.length + 1) : "";
      if (checkout !== legacy && (!/^\d+$/.test(attempt) || Number(attempt) >= entry.attempts)) continue;
      this.assertClaim(entry.id);
      const stale = join(this.deps.paths.work, name);
      if (base) rmSync(stale, { recursive: true, force: true });
      else await this.discard(repo, stale);
    }
    this.assertClaim(entry.id);
    try {
      await addDetachedWorktree(cache, sha, path, signal);
    } catch (error) {
      // A crashed attempt leaves the cache's registration behind; prune it and try once more.
      signal.throwIfAborted();
      this.log(`[land] retrying checkout of ${sha.slice(0, 12)} after ${String(error)}`);
      await cacheGit(["git", "worktree", "prune"], { cwd: cache, allowFail: true });
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
          statusNames: snapshot.statusNames,
          truncated: snapshot.truncated,
          mergedBy: snapshot.mergedBy,
          mergedAt: snapshot.mergedAt,
        }
      : null;
  }

  /** The saved observation when polling is on, `gh pr view` otherwise; cancellable either way. */
  private async observe(url: string, signal: AbortSignal, sha: string): Promise<LandObservation | null> {
    const saved = this.deps.polling === false ? null : this.savedReport(url);
    if (saved && (saved.head === sha || saved.state === "MERGED")) return saved;
    const pr = await (this.deps.client ?? getGitHubPr)(url, signal);
    return pr
      ? {
          head: pr.headRefOid ?? "",
          state: pr.state,
          ci: pr.ci ?? null,
          failing: pr.failing,
          statusNames: pr.statusNames,
          truncated: pr.truncated,
          mergedBy: pr.mergedBy,
          mergedAt: pr.mergedAt,
        }
      : null;
  }

  private block(id: number, reason: string, conflict = false): void {
    reason = redactCredentials(reason).slice(0, 2000);
    const current = this.store.getLandEntry(id);
    if (!current || !this.isActive(current)) return;
    this.log(`[land] ${id} blocked: ${reason}`);
    const entry = this.store.db.transaction(() => {
      const blocked = this.finish(id, "blocked", reason);
      if (conflict && blocked.runId)
        this.store.recordConflictTrigger(blocked.prUrl, blocked.approvedSha, "land", this.now(), id);
      return blocked;
    })();
    this.store.landFeed("land.blocked", entry, reason, { reason, pushedSha: entry.pushedSha });
  }

  private finish(id: number, state: LandEntry["state"], reason: string): LandEntry {
    const entry = this.store.updateLandEntry(id, { state, reason });
    if (state === "landed") this.store.landFeed("land.landed", entry, reason);
    return entry;
  }
}
