import type { GitHubFeedItem, GitHubFeedKind, TrackedPr } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { sh } from "../util/proc.ts";
import { reconcilePr } from "./github-notifier.ts";

export interface GitHubResponse {
  status: number;
  headers: Headers;
  body: unknown;
}
/** One authenticated GitHub API call: a GraphQL POST when `body` is given, else a REST GET. */
export type GitHubClient = (path: string, body?: unknown) => Promise<GitHubResponse>;

let token: string | null = null;
/** Uses the gh CLI's OAuth token, so no webhook or GitHub App is needed. */
export const ghClient: GitHubClient = async (path, body) => {
  token ??= (await sh(["gh", "auth", "token"], { cwd: process.cwd(), timeoutMs: 30_000 })).stdout.trim();
  const res = await fetch(`https://api.github.com/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) token = null;
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

const ACTIVITY = "nodes { id updatedAt }";
export const OBSERVE_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest {
  id url headRefOid state mergeable mergeStateStatus reviewDecision updatedAt mergedAt mergedBy { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    ... on CheckRun { name conclusion url: detailsUrl }
    ... on StatusContext { name: context state url: targetUrl } } } } } } }
  reviews(last: 1) { nodes { id updatedAt comments(last: 1) { ${ACTIVITY} } } }
  comments(last: 1) { ${ACTIVITY} } } } }`;

type Conn<T> = { nodes?: (T | null)[] } | null | undefined;
type Activity = { id: string; updatedAt: string };
type Context = { name?: string; conclusion?: string | null; state?: string; url?: string | null };
interface GqlPr {
  id?: string;
  url?: string;
  headRefOid?: string;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  updatedAt?: string;
  mergedAt?: string | null;
  mergedBy?: { login: string } | null;
  commits?: Conn<{ commit?: { statusCheckRollup?: { state: string; contexts?: Conn<Context> } | null } }>;
  reviews?: Conn<Activity & { comments?: Conn<Activity> }>;
  comments?: Conn<Activity>;
}

/** A PR's normalized state; collections are reduced and sorted so reordering is not a change. */
export interface PrSnapshot {
  head: string;
  state: string;
  mergeable: string;
  mergeState: string;
  ci: string | null;
  failing: { name: string; url: string | null }[];
  review: string | null;
  updatedAt: string;
  mergedAt: string | null;
  mergedBy: string | null;
  activity: { review: string | null; review_comment: string | null; comment: string | null };
}

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const last = <T>(c: Conn<T>): T | null => c?.nodes?.at(-1) ?? null;
const marker = (a: Activity | null | undefined) => (a ? `${a.id}@${a.updatedAt}` : null);

export function normalizePr(node: unknown): PrSnapshot | null {
  const pr = (node ?? {}) as GqlPr;
  if (!pr.id || !pr.url || !pr.headRefOid || !pr.state) return null;
  const rollup = last(pr.commits)?.commit?.statusCheckRollup ?? null;
  const contexts = (rollup?.contexts?.nodes ?? []).filter((c): c is Context => !!c?.name);
  const review = last(pr.reviews);
  return {
    head: pr.headRefOid,
    state: pr.state,
    mergeable: pr.mergeable ?? "UNKNOWN",
    mergeState: pr.mergeStateStatus ?? "UNKNOWN",
    ci: rollup?.state ?? null,
    failing: contexts
      .filter((c) => FAILING.has(c.conclusion ?? c.state ?? ""))
      .map((c) => ({ name: c.name as string, url: c.url ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    review: pr.reviewDecision ?? null,
    updatedAt: pr.updatedAt ?? "",
    mergedAt: pr.mergedAt ?? null,
    mergedBy: pr.mergedBy?.login ?? null,
    activity: {
      review: marker(review),
      review_comment: marker(last(review?.comments)),
      comment: marker(last(pr.comments)),
    },
  };
}

type Change = { kind: GitHubFeedKind; key: string; data: Record<string, unknown> };
const outcome = (s: PrSnapshot) =>
  s.ci === "SUCCESS" ? "passed" : s.ci === "FAILURE" || s.ci === "ERROR" ? "failed" : null;

/** The feed-worthy changes from `prev` to `next`; a first observation is a baseline for CI and activity. */
export function diffPr(prev: PrSnapshot | null, next: PrSnapshot): Change[] {
  const out: Change[] = [];
  const add = (kind: GitHubFeedKind, key = "", data: Record<string, unknown> = {}) =>
    out.push({ kind, key, data });
  const ci = outcome(next);
  if (prev && ci && (prev.head !== next.head || outcome(prev) !== ci))
    add(
      ci === "passed" ? "pr.ci_passed" : "pr.ci_failed",
      "",
      ci === "failed" ? { failing: next.failing } : {},
    );
  if (next.mergeable === "CONFLICTING" && prev?.mergeable !== "CONFLICTING") add("pr.conflicting");
  if (next.mergeState === "BEHIND" && prev?.mergeState !== "BEHIND") add("pr.behind");
  if (
    prev &&
    next.review !== prev.review &&
    (next.review === "APPROVED" || next.review === "CHANGES_REQUESTED")
  )
    add("pr.review", next.review, { decision: next.review });
  for (const [category, value] of Object.entries(next.activity))
    if (prev && value && value !== prev.activity[category as keyof PrSnapshot["activity"]])
      add("pr.comment", category, { category });
  if ((next.state === "MERGED" || next.state === "CLOSED") && next.state !== prev?.state)
    add(next.state === "MERGED" ? "pr.merged" : "pr.closed", "", { mergedBy: next.mergedBy });
  return out;
}

type Problem = { reason: string; detail: string };
const errorsOf = (body: unknown) => {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? JSON.stringify(errors) : "";
};

/** SSO, IP-allow-list and 404 failures are access problems, never PR changes. */
export function accessProblem(res: GitHubResponse): Problem | null {
  const text = res.status === 200 ? errorsOf(res.body) : JSON.stringify(res.body ?? "");
  if (res.headers.get("x-github-sso") || /SAML|single sign-on/i.test(text))
    return { reason: "sso", detail: "The organization requires SSO authorization for the gh token" };
  if (/IP allow list|IP address/i.test(text))
    return { reason: "ip", detail: "The organization's IP allow list blocks this network" };
  if (res.status === 404) return { reason: "not_found", detail: "A factory PR returned 404" };
  return null;
}

const isLimited = (res: GitHubResponse) =>
  res.status === 403 || res.status === 429 || /secondary rate limit|RATE_LIMITED/i.test(errorsOf(res.body));

export const FAST_SECONDS = 15;
const pullPath = (pr: TrackedPr) => `repos/${pr.repo}/pulls/${pr.url.slice(pr.url.lastIndexOf("/") + 1)}`;

export interface PollerOptions {
  client?: GitHubClient;
  seconds?: number;
  log?: (message: string) => void;
  clock?: { now: () => number; set: typeof setTimeout; clear: typeof clearTimeout };
}

/** Observes factory PRs with one serial GraphQL query per repository and writes changes to the feed. */
export function startGitHubPoller(store: Store, opts: PollerOptions = {}): () => void {
  const client = opts.client ?? ghClient;
  const log = opts.log ?? console.warn;
  const now = opts.clock?.now ?? Date.now;
  const set = opts.clock?.set ?? setTimeout;
  const clear = opts.clock?.clear ?? clearTimeout;
  const normal = Math.max(FAST_SECONDS, opts.seconds ?? 45) * 1000;
  const due = new Map<string, number>();
  let cooldownUntil = 0;
  let failures = 0;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (at: number) => {
    if (timer) clear(timer);
    timer = stopped ? null : set(() => void tick(), Math.max(0, at - now()));
  };
  /** Null once a rate limit has started a cooldown; nothing else may be sent until it ends. */
  const call = async (repo: string, path: string, body?: unknown): Promise<GitHubResponse | null> => {
    if (stopped) return null;
    const res = await client(path, body);
    if (!isLimited(res)) {
      failures = 0;
      return res;
    }
    const retry = Number(res.headers.get("retry-after"));
    const wait = retry > 0 ? retry * 1000 : Math.min(60_000 * 2 ** failures++, 900_000);
    cooldownUntil = now() + wait;
    const access = accessProblem(res);
    if (access) store.setGithubAccess(repo, { ...access, head: null });
    return null;
  };

  const record = async (pr: TrackedPr, snap: PrSnapshot): Promise<boolean> => {
    const prev = pr.snapshot ? (JSON.parse(pr.snapshot) as PrSnapshot) : null;
    const unknownPolls =
      snap.mergeable !== "UNKNOWN"
        ? 0
        : prev?.head === snap.head && prev.mergeable === "UNKNOWN"
          ? pr.unknownPolls + 1
          : 1;
    const nudge = unknownPolls >= 3 && pr.nudgedHead !== snap.head;
    // Runs reconcile before the snapshot advances, so a crash in between replays the merge.
    reconcilePr(store, {
      url: pr.url,
      state: snap.state,
      mergedAt: snap.mergedAt,
      mergedBy: snap.mergedBy ? { login: snap.mergedBy } : null,
    });
    const changes = diffPr(prev, snap);
    const revision = pr.revision + (changes.length ? 1 : 0);
    const items: GitHubFeedItem[] = changes.map((c) => ({
      kind: c.kind,
      runId: pr.runId,
      repo: pr.repo,
      title: `${c.kind}: ${pr.url}`,
      summary:
        c.kind === "pr.ci_failed"
          ? `Failing: ${snap.failing.map((f) => f.name).join(", ") || "unknown"}`
          : `${c.kind} at ${snap.head.slice(0, 12)}`,
      data: { ...c.data, url: pr.url, head: snap.head },
      key: `${pr.url}:${snap.head}:${revision}:${c.key}`,
    }));
    const terminal = snap.state === "MERGED" || snap.state === "CLOSED";
    const nudgedHead = nudge ? snap.head : unknownPolls ? pr.nudgedHead : null;
    store.saveGithubPr(
      { ...pr, snapshot: JSON.stringify(snap), revision, unknownPolls, nudgedHead, terminal },
      items,
    );
    // A REST read starts GitHub's lazy mergeability computation; the next GraphQL poll reports it.
    return !nudge || (await call(pr.repo, pullPath(pr))) !== null;
  };

  /** False when a rate limit interrupted the cycle. */
  const observe = async (repo: string, prs: TrackedPr[]): Promise<boolean> => {
    let missing: TrackedPr | null = null;
    for (const pr of prs.filter((p) => !p.nodeId)) {
      const res = await call(repo, pullPath(pr));
      if (!res) return false;
      const nodeId = (res.body as { node_id?: unknown } | null)?.node_id;
      if (res.status === 200 && typeof nodeId === "string") store.saveGithubPr({ ...pr, nodeId });
      else if (res.status === 404) missing = pr;
      pr.nodeId = typeof nodeId === "string" ? nodeId : null;
    }
    const known = prs.filter((p) => p.nodeId);
    if (known.length) {
      const res = await call(repo, "graphql", {
        query: OBSERVE_QUERY,
        variables: { ids: known.map((p) => p.nodeId) },
      });
      if (!res) return false;
      const access = accessProblem(res);
      const nodes = (res.body as { data?: { nodes?: unknown } } | null)?.data?.nodes;
      if (access || res.status !== 200 || !Array.isArray(nodes) || nodes.length !== known.length) {
        if (access) store.setGithubAccess(repo, { ...access, head: headOf(known[0]) });
        return true;
      }
      for (const [i, pr] of known.entries()) {
        const snap = normalizePr(nodes[i]);
        if (!snap) missing = pr;
        else if (!(await record(pr, snap))) return false;
      }
    }
    store.setGithubAccess(
      repo,
      missing
        ? {
            reason: "not_found",
            detail: `${missing.url} is not visible to the gh token`,
            head: headOf(missing),
          }
        : null,
    );
    return true;
  };

  const tick = async () => {
    timer = null;
    if (stopped || running) return;
    if (now() < cooldownUntil) return schedule(cooldownUntil);
    running = true;
    const byRepo = Map.groupBy(store.githubTracked(), (pr) => pr.repo);
    for (const repo of due.keys()) if (!byRepo.has(repo)) due.delete(repo);
    try {
      for (const [repo, prs] of byRepo) {
        if (stopped || (due.get(repo) ?? 0) > now()) continue;
        const ok = await observe(repo, prs).catch((error: unknown) => {
          log(`GitHub poll failed for ${repo}: ${String(error)}`);
          return true;
        });
        if (!ok) break;
        due.set(repo, now() + (prs.some((p) => p.delivered) ? FAST_SECONDS * 1000 : normal));
      }
    } finally {
      running = false;
    }
    // Repositories not yet observed (e.g. interrupted by a rate limit) are due at once.
    const next = Math.min(...[...byRepo.keys()].map((repo) => due.get(repo) ?? 0));
    if (byRepo.size) schedule(Math.max(next, cooldownUntil));
  };

  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run" && msg.run.prUrl && !running) schedule(Math.max(now(), cooldownUntil));
  });
  schedule(now());
  return () => {
    stopped = true;
    if (timer) clear(timer);
    unsubscribe();
  };
}

const headOf = (pr: TrackedPr | null | undefined) =>
  pr?.snapshot ? (JSON.parse(pr.snapshot) as PrSnapshot).head : null;

/** `limitless doctor`: persisted repository access problems and how to fix them. */
export function githubDoctor(store: Store): string[] {
  const problems = store.githubAccessProblems();
  if (!problems.length) return ["GitHub access: ok"];
  return problems.flatMap((p) => [
    `GitHub access problem in ${p.repo} since ${new Date(p.since).toISOString()}: ${p.detail}`,
    "  Fix: sign in to your identity provider (SSO), then run `gh auth refresh`.",
    ...(p.reason === "ip" ? ["  Or connect from a network or VPN on the organization's IP allow list."] : []),
  ]);
}
