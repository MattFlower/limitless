import type { GitHubAccessProblem, GitHubFeedKind, TrackedPr } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { sh } from "../util/proc.ts";
import { type GitHubPrClient, type GitHubPrState, reconcileMergedRuns } from "./github-notifier.ts";

export type GitHubResponse = { status: number; headers: Headers; body: unknown };
/** One authenticated GitHub API call: a GraphQL POST when `body` is given, else a REST GET. */
export type GitHubClient = (path: string, body?: unknown, signal?: AbortSignal) => Promise<GitHubResponse>;

/** Uses the gh CLI's OAuth token (read per request, so refreshes apply), so no webhook or App is needed. */
export const ghClient: GitHubClient = async (path, body, signal) => {
  const token = (await sh(["gh", "auth", "token"], { cwd: process.cwd(), timeoutMs: 30_000 })).stdout.trim();
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

export const OBSERVE_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest {
  id url headRefOid state mergeable mergeStateStatus reviewDecision updatedAt mergedAt mergedBy { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes {
    ... on CheckRun { name conclusion url: detailsUrl }
    ... on StatusContext { name: context state url: targetUrl } } } } } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  reviews(last: 10) { nodes { id updatedAt comments(last: 10) { nodes { id updatedAt } } } }
  comments(last: 10) { nodes { id updatedAt } } } } }`;
// Activity pages hold the newest few items so an edit to a recent older one still moves the marker.

type Conn<T> = { nodes?: (T | null)[]; pageInfo?: { hasNextPage?: boolean } } | null | undefined;
type Activity = { id: string; updatedAt: string };
type Context = { name?: string; conclusion?: string | null; state?: string; url?: string | null };
const REQUIRED = ["id", "url", "headRefOid", "state", "mergeable", "mergeStateStatus", "updatedAt"] as const;
type Base = Record<(typeof REQUIRED)[number], string> & GitHubPrState & { reviewDecision: string | null };
type GqlPr = Base & {
  commits?: Conn<{ commit?: { statusCheckRollup?: { state: string; contexts?: Conn<Context> } | null } }>;
  reviews?: Conn<Activity & { comments?: Conn<Activity> }>;
  comments?: Conn<Activity>;
  latestReviews?: Conn<{ state: string; author?: { login: string } | null }>;
};
/** A PR's normalized state; collections are reduced and sorted so reordering is not a change. */
export type PrSnapshot = Omit<Base, "mergeable" | "mergeStateStatus"> & {
  mergeable: string | null; // null until GitHub reports something other than UNKNOWN
  mergeStateStatus: string | null;
  ci: string | null;
  failing: { name: string; url: string | null }[];
  truncated?: boolean; // more than the 100 fetched check contexts exist
  reviews?: string[]; // sorted `login:state` of reviewers' latest approvals and change requests
  activity: Record<"review" | "review_comment" | "comment", string | null>;
};
type Saved = PrSnapshot & { revision: number; unknown: number; nudged: string | null };
const saved = (data: string | null | undefined) => (data ? (JSON.parse(data) as Saved) : null);
const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const nodes = <T>(c: Conn<T>): T[] => (c?.nodes ?? []).filter((n): n is T => n !== null);
/** `id@updatedAt` of the item created or edited last; ISO-8601 UTC timestamps order as strings. */
const newest = (items: Activity[]) => {
  const top = items.toSorted((a, b) => (a.updatedAt + a.id > b.updatedAt + b.id ? -1 : 1))[0];
  return top ? `${top.id}@${top.updatedAt}` : null;
};
const stamp = (marker: string | null | undefined) => marker?.slice(marker.lastIndexOf("@") + 1) ?? "";

/** Null unless `node` is a complete PullRequest (with the expected id, when given). */
export function normalizePr(node: unknown, id?: string | null): PrSnapshot | null {
  const pr = node as GqlPr | null;
  if (!pr || REQUIRED.some((k) => typeof pr[k] !== "string") || (id && pr.id !== id)) return null;
  const { commits, reviews, comments, latestReviews, ...base } = pr;
  const rollup = nodes(commits).at(-1)?.commit?.statusCheckRollup ?? null;
  const all = nodes(reviews);
  const failing = nodes(rollup?.contexts).flatMap((x) =>
    x.name && FAILING.has(x.conclusion ?? x.state ?? "") ? [{ name: x.name, url: x.url ?? null }] : [],
  );
  return {
    ...base,
    ci: rollup?.state ?? null,
    failing: failing.sort((a, b) => a.name.localeCompare(b.name)),
    truncated: rollup?.contexts?.pageInfo?.hasNextPage || undefined,
    reviews: nodes(latestReviews)
      .flatMap((r) => (REVIEWED.test(r.state) ? [`${r.author?.login ?? "ghost"}:${r.state}`] : []))
      .sort(),
    activity: {
      review: newest(all),
      review_comment: newest(all.flatMap((r) => nodes(r.comments))),
      comment: newest(nodes(comments)),
    },
  };
}

type Change = { kind: GitHubFeedKind; key: string; data: Record<string, unknown>; summary: string };
const OUTCOME: Record<string, string> = { SUCCESS: "passed", FAILURE: "failed", ERROR: "failed" };
const REVIEWED = /^(APPROVED|CHANGES_REQUESTED)$/;
/** Changes from `prev` to `next`; a first observation reports the head's state but baselines activity. */
export function diffPr(prev: PrSnapshot | null, next: PrSnapshot): Change[] {
  const out: Change[] = [];
  const at = `at ${next.headRefOid.slice(0, 12)}`;
  const add = (kind: GitHubFeedKind, key = "", data = {}, summary = `${kind} ${at}`) =>
    out.push({ kind, key, data, summary });
  const ci = OUTCOME[next.ci ?? ""];
  if (ci && (!prev || prev.headRefOid !== next.headRefOid || OUTCOME[prev.ci ?? ""] !== ci)) {
    const { failing, truncated } = next;
    const names = next.failing.map((f) => f.name).join(", ") || "unknown";
    if (ci === "passed") add("pr.ci_passed");
    else add("pr.ci_failed", "", { failing, truncated }, `Failing ${at}: ${names}`);
  }
  const moved = prev?.headRefOid !== next.headRefOid;
  if (next.mergeable === "CONFLICTING" && (moved || prev?.mergeable !== "CONFLICTING")) add("pr.conflicting");
  if (next.mergeStateStatus === "BEHIND" && (moved || prev?.mergeStateStatus !== "BEHIND")) add("pr.behind");
  for (const review of next.reviews ?? []) {
    const [reviewer, decision] = review.split(":");
    if (prev?.reviews && !prev.reviews.includes(review)) add("pr.review", review, { reviewer, decision });
  }
  // Only a newer or edited item is activity; a deletion that exposes an older one is not.
  for (const [category, value] of Object.entries(next.activity))
    if (prev && value && stamp(value) > stamp(prev.activity[category as keyof PrSnapshot["activity"]]))
      add("pr.comment", category, { category });
  if (next.state !== "OPEN" && next.state !== prev?.state)
    add(next.state === "MERGED" ? "pr.merged" : "pr.closed", "", { mergedBy: next.mergedBy?.login });
  return out;
}

const errorsOf = (res: GitHubResponse) => (res.body as { errors?: { type?: string }[] } | null)?.errors ?? [];
/** SSO, IP-allow-list and not-found failures for `subject` are access problems, never PR changes. */
function accessProblem(res: GitHubResponse, subject: string) {
  const text = JSON.stringify(res.status === 200 ? errorsOf(res) : (res.body ?? ""));
  if (res.headers.get("x-github-sso") || /SAML|single sign-on/i.test(text))
    return { reason: "sso", detail: "The organization requires SSO authorization for the gh token" };
  if (/IP allow list|IP address/i.test(text))
    return { reason: "ip", detail: "The organization's IP allow list blocks this network" };
  if (res.status === 401) return { reason: "auth", detail: "Bad gh token: run `gh auth refresh`" };
  if (res.status === 404) return { reason: "not_found", detail: `The gh token cannot see ${subject}` };
  if (res.status === 403) return { reason: "forbidden", detail: `The gh token is forbidden from ${subject}` };
  return null;
}
/** Null unless `res` is a rate limit; then when it ends (epoch ms), or 0 when GitHub gave no usable deadline. */
function limitedUntil(res: GitHubResponse, now: number): number | null {
  const [retry, reset] = ["retry-after", "x-ratelimit-reset"].map((h) => Number(res.headers.get(h)) * 1000);
  if (retry && retry > 0) return now + retry;
  if (res.headers.get("x-ratelimit-remaining") === "0") return reset && reset > now ? reset : 0;
  if (res.status === 429 || res.headers.has("retry-after")) return 0;
  const text = JSON.stringify(res.status === 200 ? errorsOf(res) : (res.body ?? ""));
  return /rate limit|RATE_LIMITED/i.test(text) ? 0 : null;
}
const pullPath = (pr: TrackedPr) => `repos/${pr.repo}/pulls/${pr.url.slice(pr.url.lastIndexOf("/") + 1)}`;
const headOf = (pr: TrackedPr | undefined) => saved(pr?.data)?.headRefOid ?? null;

const closed = (pr: TrackedPr) => saved(pr.data)?.state === "CLOSED";
const backoff = (failures: number, base = 60_000) => Math.min(base * 2 ** failures, 900_000);
/** Merge reconciliation's PR client while polling: the poller's observations for PRs it tracks, else `fallback`. */
export function observedPrs(store: Store, fallback?: GitHubPrClient): GitHubPrClient {
  const owned = (url: string) => !fallback || store.githubTracked().some((pr) => pr.url === url);
  return async (url) => saved(store.githubPrData(url)) ?? (owned(url) ? null : (fallback?.(url) ?? null));
}

export interface PollerOptions {
  client?: GitHubClient;
  seconds?: number;
  log?: (message: string) => void;
  clock?: { now: () => number; set: typeof setTimeout; clear: typeof clearTimeout };
}

/** Observes factory PRs with one serial GraphQL query per repository and writes changes to the feed. */
export function startGitHubPoller(store: Store, opts: PollerOptions = {}): () => void {
  const { client = ghClient, log = console.warn } = opts;
  const { now, set, clear } = opts.clock ?? { now: Date.now, set: setTimeout, clear: clearTimeout };
  const normal = Math.max(15, opts.seconds ?? 45) * 1000;
  const observedAt = new Map<string, number>();
  /** Repositories GitHub refused (401, SSO, IP allow list, other 403s), each with its own backoff. */
  const blocks = new Map<string, { until: number; failures: number }>();
  const abort = new AbortController();
  let [cooldownUntil, failures, running, stopped, settled] = [0, 0, false, false, false];
  let [retryAt, crashes, first] = [0, 0, ""];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blockedUntil = (repo: string) => blocks.get(repo)?.until ?? 0;
  /** Null during a rate-limit (or access-block) cooldown, which every request honours. */
  const call = async (repo: string, path: string, body?: unknown): Promise<GitHubResponse | null> => {
    if (stopped || now() < cooldownUntil || now() < blockedUntil(repo)) return null;
    const res = await client(path, body, abort.signal);
    if (stopped) return null;
    const until = limitedUntil(res, now());
    if (until !== null) {
      cooldownUntil = until || now() + backoff(failures++);
      log(`GitHub rate limit: polling paused until ${new Date(cooldownUntil).toISOString()}`);
      return null;
    }
    failures = 0;
    const access = accessProblem(res, repo);
    if (access && access.reason !== "not_found") {
      const n = blocks.get(repo)?.failures ?? 0;
      blocks.set(repo, { until: now() + backoff(n), failures: n + 1 });
      store.setGithubAccess(repo, access);
      return null;
    }
    blocks.delete(repo);
    return res;
  };

  /** Saves the observation; returns the mergeability nudge's response (null: not sent) or undefined. */
  const record = async (pr: TrackedPr, snap: PrSnapshot) => {
    const prev = saved(pr.data);
    const head = snap.headRefOid;
    const same = prev?.headRefOid === head;
    const unknown = snap.mergeable !== "UNKNOWN" ? 0 : same ? (prev?.unknown ?? 0) + 1 : 1;
    // UNKNOWN is a missing observation, never a state: the last known value stands.
    for (const k of ["mergeable", "mergeStateStatus"] as const)
      if (snap[k] === "UNKNOWN") snap[k] = prev?.[k] ?? null;
    // Activity markers only advance, so deleting the newest item never rewinds them.
    const marks: Record<string, string | null> = snap.activity;
    for (const [k, before] of Object.entries(prev?.activity ?? {}))
      if (before && stamp(before) >= stamp(marks[k])) marks[k] = before;
    const nudge = unknown >= 3 && prev?.nudged !== head;
    const changes = diffPr(prev, snap);
    const revision = (prev?.revision ?? 0) + (changes.length ? 1 : 0);
    const items = changes.map((c) => {
      // A conflict or a fall behind is reported once per head, whatever happened in between.
      const once = /conflicting|behind/.test(c.kind);
      const key = once ? `${pr.url}:${head}` : `${pr.url}:${head}:${revision}:${c.key}`;
      return { ...c, runId: pr.runId, repo: pr.repo, data: { ...c.data, url: pr.url, head }, key };
    });
    const save = (nudged: string | null, feed = items) => {
      const data = JSON.stringify({ ...snap, revision, unknown, nudged } satisfies Saved);
      store.saveGithubPr({ ...pr, data }, snap.state !== "OPEN", feed);
    };
    save(prev?.nudged ?? null);
    settled ||= snap.state !== (prev?.state ?? "OPEN");
    if (!nudge) return undefined;
    // A REST read starts GitHub's lazy mergeability computation; the next GraphQL poll reports it.
    // Only a sent request counts: one a cooldown or rate limit swallowed is retried next cycle.
    const res = await call(pr.repo, pullPath(pr));
    if (res) save(head, []);
    return res;
  };

  const observe = async (repo: string, prs: TrackedPr[]) => {
    let missing: TrackedPr | undefined;
    let complete = true;
    for (const pr of prs.filter((p) => !p.nodeId)) {
      const res = await call(repo, pullPath(pr));
      if (!res) return;
      const nodeId = res.status === 200 && (res.body as { node_id?: unknown } | null)?.node_id;
      if (typeof nodeId === "string") store.saveGithubPr(Object.assign(pr, { nodeId }));
      else complete = false;
      if (res.status === 404) missing ??= pr;
    }
    const known = prs.filter((p) => p.nodeId);
    // GitHub accepts at most 100 node ids per query.
    for (let start = 0; start < known.length; start += 100) {
      const batch = known.slice(start, start + 100);
      const ids = batch.map((p) => p.nodeId);
      const res = await call(repo, "graphql", { query: OBSERVE_QUERY, variables: { ids } });
      if (!res) return;
      // An access failure of the whole query (SSO, IP allow list, HTTP 404) says nothing about any PR.
      const access = accessProblem(res, repo);
      if (access) store.setGithubAccess(repo, access, headOf(batch[0]));
      const found = (res.body as { data?: { nodes?: unknown } } | null)?.data?.nodes;
      // Partial data is never trusted; only unresolvable node ids (NOT_FOUND) leave the rest usable.
      const failed = access || res.status !== 200 || errorsOf(res).some((e) => e.type !== "NOT_FOUND");
      if (failed || !Array.isArray(found) || found.length !== batch.length)
        return log(`GitHub observation of ${repo} failed with HTTP ${res.status}`);
      for (const [i, pr] of batch.entries()) {
        const snap = normalizePr(found[i], pr.nodeId);
        const nudged = snap ? await record(pr, snap) : null;
        // A nudge that failed (perhaps an access problem) must not let this cycle clear an episode.
        if (nudged === null) complete = false;
        if (found[i] === null || nudged?.status === 404) missing ??= pr;
      }
    }
    const notFound = missing && { reason: "not_found", detail: `The gh token cannot see ${missing.url}` };
    if (missing || complete) store.setGithubAccess(repo, notFound ?? null, headOf(missing));
  };
  /** Each repository's due PRs and when it is next due; closed PRs are checked every 10 minutes for a reopen. */
  const plan = () =>
    [...Map.groupBy(store.githubTracked(now()), (pr) => pr.repo)].map(([repo, prs]) => {
      const fast = prs.some((p) => p.delivered && !closed(p)) ? 15_000 : normal;
      const after = (p: TrackedPr) => (observedAt.get(p.url) ?? -Infinity) + (closed(p) ? 600_000 : fast);
      const open = Math.min(...prs.filter((p) => !closed(p)).map(after));
      const dueAt = (p: TrackedPr) => (closed(p) ? after(p) : open);
      const due = Math.max(blockedUntil(repo), Math.min(...prs.map(dueAt)));
      return { repo, due, prs: prs.filter((p) => dueAt(p) <= now()) };
    });
  const schedule = () => {
    if (stopped) return;
    clear(timer);
    let next = now() + 60_000;
    try {
      next = Math.max(cooldownUntil, retryAt, Math.min(...plan().map((r) => r.due)));
    } catch (e) {
      log(`GitHub poll scheduling failed: ${String(e)}`);
    }
    timer = next === Infinity ? undefined : set(() => void tick(), Math.max(0, next - now()));
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Round robin: each pass starts after the repository the previous pass started with.
      const repos = plan();
      const order = [...repos.filter((r) => r.repo > first), ...repos.filter((r) => r.repo <= first)];
      first = order[0]?.repo ?? "";
      for (const { repo, prs, due } of order) {
        if (stopped || due > now() || now() < cooldownUntil) continue;
        await observe(repo, prs).catch((e: unknown) => log(`GitHub poll of ${repo} failed: ${String(e)}`));
        // A repository a rate limit or block interrupted is due again as soon as that ends.
        if (now() >= cooldownUntil && now() >= blockedUntil(repo))
          for (const pr of prs) observedAt.set(pr.url, now());
      }
      if (settled) await reconcileMergedRuns(store, observedPrs(store), log);
      settled = false;
      crashes = 0;
    } catch (e) {
      log(`GitHub poll failed: ${String(e)}`);
      retryAt = now() + backoff(crashes++, 15_000);
    } finally {
      running = false;
    }
    schedule();
  };
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run" && msg.run.prUrl && !running) schedule();
  });
  schedule();
  return () => {
    stopped = true;
    abort.abort();
    clear(timer);
    unsubscribe();
  };
}

/** `limitless doctor`: persisted repository access problems and how to fix them. */
export function githubDoctor(problems: GitHubAccessProblem[]): string[] {
  if (!problems.length) return ["GitHub access: ok"];
  return problems.flatMap((p) => [
    `GitHub access problem in ${p.repo} since ${new Date(p.since).toISOString()}: ${p.detail}`,
    "  Fix: sign in to your identity provider (SSO), then run `gh auth refresh`.",
    ...(p.reason === "ip" ? ["  Or connect from a network or VPN on the organization's IP allow list."] : []),
  ]);
}
