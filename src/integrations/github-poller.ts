import type { GitHubFeedKind, TrackedPr } from "../core/types.ts";
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
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    ... on CheckRun { name conclusion url: detailsUrl }
    ... on StatusContext { name: context state url: targetUrl } } } } } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  reviews(last: 10) { nodes { id createdAt updatedAt comments(last: 10) { nodes { id createdAt updatedAt } } } }
  comments(last: 10) { nodes { id createdAt updatedAt } } } } }`;
// Activity pages hold the newest few items so an edit to a recent older one still moves the marker.

type Conn<T> = { nodes?: (T | null)[] } | null | undefined;
type Activity = { id: string; createdAt?: string; updatedAt: string }; // createdAt: absent only in old markers
type Context = { name?: string; conclusion?: string | null; state?: string; url?: string | null };
const REQUIRED = ["id", "url", "headRefOid", "state", "mergeable", "mergeStateStatus", "updatedAt"] as const;
type Base = Record<(typeof REQUIRED)[number], string> & GitHubPrState & { reviewDecision: string | null };
type GqlPr = Base & {
  commits?: Conn<{ commit?: { statusCheckRollup?: { state: string; contexts?: Conn<Context> } | null } }>;
  reviews?: Conn<Activity & { comments?: Conn<Activity> }>;
  comments?: Conn<Activity>;
  latestReviews?: Conn<{ state: string; author?: { login: string } | null }>;
};
/** A PR's normalized state; `failing` is reduced and sorted so reordering is not a change. */
const MERGE = ["mergeable", "mergeStateStatus"] as const; // null until GitHub reports other than UNKNOWN
type Known = Omit<Base, (typeof MERGE)[number]> & Record<(typeof MERGE)[number], string | null>;
export type PrSnapshot = Known & {
  ci: string | null;
  failing: { name: string; url: string | null }[];
  truncated?: boolean; // all 100 fetched check contexts were used, so there may be more
  reviews?: string[]; // `login:state` of each reviewer's latest review
  reviewComments?: Record<string, string[]>; // each review connection has its own oldest-first order
  activity: Record<"review" | "review_comment" | "comment", string[]>;
};
type Saved = PrSnapshot & { revision: number; unknown: number; nudged: string | null };
const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const nodes = <T>(c: Conn<T>): T[] => (c?.nodes ?? []).filter((n): n is T => n !== null);
/** Every item as `createdAt@updatedAt@id`, in page (oldest first) order. */
const mark = (a: Activity) => `${a.createdAt ?? a.updatedAt}@${a.updatedAt}@${a.id}`;
const newest = (items: Activity[]) => items.map(mark);
/**
 * A known id with another updatedAt was edited; an unknown one that follows a known item on the page,
 * or was created after every known item, was added. A deletion, or an older item it lets the page
 * backfill (even one created in the same second as the newest known), never qualifies.
 */
const fresh = (m: string, before: string[], old: string[]) => {
  const part = (s: string, i: number) => s.split("@")[i] ?? "";
  const known = (x: string) => old.find((o) => o.endsWith(x.slice(x.lastIndexOf("@"))));
  const prior = known(m);
  if (prior) return part(prior, 1) !== part(m, 1);
  return before.some(known) || old.every((o) => part(o, 0) < part(m, 0));
};
const saved = (data: string | null | undefined) => {
  const s = data ? (JSON.parse(data) as Saved) : null;
  // Snapshots from before this format kept only each category's newest item, as `id@updatedAt` or null;
  // such an item counts as created at its last update, so items created since are new.
  for (const [k, v] of Object.entries(s?.activity ?? {}) as [keyof Saved["activity"], unknown][])
    if (s && !Array.isArray(v))
      s.activity[k] = typeof v === "string" ? [v.replace(/^(.*)@(.*)$/, "$2@$2@$1")] : [];
  return s;
};

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
    truncated: nodes(rollup?.contexts).length >= 100 || undefined,
    reviews: nodes(latestReviews).map((r) => `${r.author?.login ?? "ghost"}:${r.state}`),
    reviewComments: Object.fromEntries(all.map((r) => [r.id, newest(nodes(r.comments))])),
    activity: {
      review: newest(all),
      review_comment: newest(all.flatMap((r) => nodes(r.comments))),
      comment: newest(nodes(comments)),
    },
  };
}

type Change = { kind: GitHubFeedKind; key: string; data: Record<string, unknown>; summary: string };
const OUTCOME: Record<string, string> = { SUCCESS: "passed", FAILURE: "failed", ERROR: "failed" };
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
  if (next.mergeable === "CONFLICTING" && prev?.mergeable !== "CONFLICTING") add("pr.conflicting");
  if (next.mergeStateStatus === "BEHIND" && prev?.mergeStateStatus !== "BEHIND") add("pr.behind");
  for (const review of next.reviews ?? [])
    if (prev?.reviews && !prev.reviews.includes(review) && /:(APPROVED|CHANGES_REQUESTED)$/.test(review))
      add("pr.review", review, { review });
  for (const [category, value] of Object.entries(next.activity)) {
    const pages = category === "review_comment" ? next.reviewComments : undefined;
    if (
      prev &&
      Object.entries(pages ?? { [category]: value }).some(([id, markers]) => {
        const old =
          (pages ? prev.reviewComments?.[id] : undefined) ??
          prev.activity[category as keyof Saved["activity"]];
        return markers.some((m, i) => fresh(m, markers.slice(0, i), old));
      })
    )
      add("pr.comment", category, { category });
  }
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
  const retry = res.headers.get("retry-after"); // delta-seconds or an HTTP date
  const until = retry && (/^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry));
  if (until && until > now) return until;
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
  if (res.headers.get("x-ratelimit-remaining") === "0") return reset > now ? reset : 0;
  const text = JSON.stringify(res.status === 200 ? errorsOf(res) : res.body);
  return res.status === 429 || retry !== null || /rate limit|RATE_LIMITED/i.test(text) ? 0 : null;
}
const pullPath = (pr: TrackedPr) => `repos/${pr.repo}/pulls/${pr.url.slice(pr.url.lastIndexOf("/") + 1)}`;
const headOf = (pr: TrackedPr | undefined) => saved(pr?.data)?.headRefOid ?? null;

const closed = (pr: TrackedPr) => saved(pr.data)?.state === "CLOSED";
const backoff = (failures: number, base = 60_000) => Math.min(base * 2 ** failures, 900_000);
/** Merge reconciliation's PR client while polling: the poller's observations for PRs it tracks, else `fallback`. */
export function observedPrs(store: Store, fallback?: GitHubPrClient): GitHubPrClient {
  return async (url) => {
    const pr = saved(store.githubPrData(url));
    if (!fallback || pr?.state === "MERGED" || store.githubTracked().some((p) => p.url === url)) return pr;
    return fallback(url);
  };
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
  const blocks = new Map<string, { until: number; failures: number }>();
  const abort = new AbortController();
  let [cooldownUntil, failures, running, stopped, settled] = [0, 0, false, false, false];
  let [retryAt, crashes, first] = [0, 0, ""];
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Null during a rate-limit (or access-block) cooldown, which every request honours. */
  const call = async (repo: string, path: string, body?: unknown): Promise<GitHubResponse | null> => {
    if (stopped || now() < cooldownUntil || now() < (blocks.get(repo)?.until ?? 0)) return null;
    const res = await client(path, body, abort.signal);
    const until = limitedUntil(res, now());
    const access = until === null && accessProblem(res, repo);
    if (until === null && (!access || access.reason === "not_found")) {
      failures = 0;
      blocks.delete(repo);
      return res;
    }
    const n = blocks.get(repo)?.failures ?? 0; // any other refusal blocks only this repository
    if (until === null) blocks.set(repo, { until: now() + backoff(n), failures: n + 1 });
    else cooldownUntil = until || now() + backoff(failures++);
    if (until !== null) log(`GitHub rate limit: paused until ${new Date(cooldownUntil).toISOString()}`);
    if (access) store.setGithubAccess(repo, access);
    return null;
  };

  /** Saves the observation; returns the mergeability nudge's response (null: not sent) or undefined. */
  const record = async (pr: TrackedPr, snap: PrSnapshot) => {
    const prev = saved(pr.data);
    const head = snap.headRefOid;
    const same = prev?.headRefOid === head;
    const unknown = snap.mergeable !== "UNKNOWN" ? 0 : same ? (prev?.unknown ?? 0) + 1 : 1;
    // Mergeability is per head; UNKNOWN is no observation, so this head's last known value stands.
    if (prev && !same) for (const k of MERGE) prev[k] = null;
    for (const k of MERGE) if (snap[k] === "UNKNOWN") snap[k] = prev?.[k] ?? null;
    const nudge = unknown >= 3 && prev?.nudged !== head;
    const changes = diffPr(prev, snap);
    const revision = (prev?.revision ?? 0) + (changes.length ? 1 : 0);
    const items = changes.map((c) => {
      const key = `${pr.url}:${head}:${/conflicting|behind/.test(c.kind) ? "" : revision}:${c.key}`;
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
    const resolved = prs.filter((p) => p.nodeId);
    for (let known = resolved.splice(0, 100); known.length; known = resolved.splice(0, 100)) {
      const ids = known.map((p) => p.nodeId);
      const res = await call(repo, "graphql", { query: OBSERVE_QUERY, variables: { ids } });
      if (!res) return;
      // An access failure of the whole query (SSO, IP allow list, HTTP 404) says nothing about any PR.
      const access = accessProblem(res, repo);
      if (access) store.setGithubAccess(repo, access, headOf(known[0]));
      const found = (res.body as { data?: { nodes?: unknown } } | null)?.data?.nodes;
      // Partial data is never trusted; only unresolvable node ids (NOT_FOUND) leave the rest usable.
      const failed = access || res.status !== 200 || errorsOf(res).some((e) => e.type !== "NOT_FOUND");
      if (failed || !Array.isArray(found) || found.length !== known.length)
        return log(`GitHub observation of ${repo} failed with HTTP ${res.status}`);
      for (const [i, pr] of known.entries()) {
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
  /** Each repository with tracked PRs and when it is next due; delivered PRs use the fast cadence. */
  const plan = () =>
    [...Map.groupBy(store.githubTracked(), (pr) => pr.repo)].map(([repo, prs]) => {
      const interval = prs.some((p) => p.delivered && !closed(p)) ? 15_000 : normal;
      const key = (p: TrackedPr) => (closed(p) ? p.url : repo); // open PRs share a deadline and a query
      const last = (k: string) => observedAt.get(k) ?? -Infinity;
      // A PR also keeps its own time, so closing or reopening it never makes it due at once.
      const at = (p: TrackedPr) =>
        closed(p) ? last(p.url) + 600_000 : Math.max(last(p.url), last(repo)) + interval;
      const due = Math.max(blocks.get(repo)?.until ?? 0, Math.min(...prs.map(at)));
      return { repo, key, due, prs: prs.filter((p) => at(p) <= now()) };
    });
  const schedule = () => {
    if (stopped) return;
    clear(timer);
    let next = now() + 60_000;
    try {
      next = Math.max(cooldownUntil, retryAt || Math.min(...plan().map((r) => r.due)));
    } catch (e) {
      log(`GitHub poll scheduling failed: ${String(e)}`);
    }
    timer = stopped || next === Infinity ? undefined : set(() => void tick(), Math.max(0, next - now()));
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const order = plan().sort((a, b) => Number(a.repo <= first) - Number(b.repo <= first));
      first = order[0]?.repo ?? ""; // round robin: the next pass starts after this one's first repository
      for (const { repo, prs, due, key } of order) {
        if (stopped || due > now() || now() < cooldownUntil) continue;
        await observe(repo, prs).catch((e: unknown) => log(`GitHub poll of ${repo} failed: ${String(e)}`));
        // A repository a rate limit interrupted is due again as soon as the cooldown ends.
        if (now() >= cooldownUntil) for (const pr of prs) observedAt.set(pr.url, now()).set(key(pr), now());
      }
      if (settled) await reconcileMergedRuns(store, observedPrs(store), log);
      [settled, crashes, retryAt] = [false, 0, 0];
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
export function githubDoctor(problems: ReturnType<Store["githubAccessProblems"]>): string[] {
  if (!problems.length) return ["GitHub access: ok"];
  return problems.flatMap((p) => [
    `GitHub access problem in ${p.repo} since ${new Date(p.since).toISOString()}: ${p.detail}`,
    "  Fix: sign in to your identity provider (SSO), then run `gh auth refresh`.",
    ...(p.reason === "ip" ? ["  Or connect from a network or VPN on the organization's IP allow list."] : []),
  ]);
}
