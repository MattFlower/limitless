import type { GitHubFeedKind, TrackedPr } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { sh } from "../util/proc.ts";
import { type GitHubPrClient, type GitHubPrState, reconcileMergedRuns } from "./github-notifier.ts";

export type GitHubResponse = { status: number; headers: Headers; body: unknown };
/** One authenticated GitHub API call: a GraphQL POST when `body` is given, else a REST GET. */
export type GitHubClient = (path: string, body?: unknown) => Promise<GitHubResponse>;

/** Uses the gh CLI's OAuth token (read per request, so refreshes apply), so no webhook or App is needed. */
export const ghClient: GitHubClient = async (path, body) => {
  const token = (await sh(["gh", "auth", "token"], { cwd: process.cwd(), timeoutMs: 30_000 })).stdout.trim();
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

export const OBSERVE_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest {
  id url headRefOid state mergeable mergeStateStatus reviewDecision updatedAt mergedAt mergedBy { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    ... on CheckRun { name conclusion url: detailsUrl }
    ... on StatusContext { name: context state url: targetUrl } } } } } } }
  reviews(last: 10) { nodes { id updatedAt comments(last: 10) { nodes { id updatedAt } } } }
  comments(last: 10) { nodes { id updatedAt } } } } }`;
// Activity pages hold the newest few items so an edit to a recent older one still moves the marker.

type Conn<T> = { nodes?: (T | null)[] } | null | undefined;
type Activity = { id: string; updatedAt: string };
type Context = { name?: string; conclusion?: string | null; state?: string; url?: string | null };
const REQUIRED = ["id", "url", "headRefOid", "state", "mergeable", "mergeStateStatus", "updatedAt"] as const;
type Base = Record<(typeof REQUIRED)[number], string> & GitHubPrState & { reviewDecision: string | null };
type GqlPr = Base & {
  commits?: Conn<{ commit?: { statusCheckRollup?: { state: string; contexts?: Conn<Context> } | null } }>;
  reviews?: Conn<Activity & { comments?: Conn<Activity> }>;
  comments?: Conn<Activity>;
};
/** A PR's normalized state; collections are reduced and sorted so reordering is not a change. */
export type PrSnapshot = Base & {
  ci: string | null;
  failing: { name: string; url: string | null }[];
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

/** Null unless `node` is a complete PullRequest (with the expected id, when given). */
export function normalizePr(node: unknown, id?: string | null): PrSnapshot | null {
  const pr = node as GqlPr | null;
  if (!pr || REQUIRED.some((k) => typeof pr[k] !== "string") || (id && pr.id !== id)) return null;
  const { commits, reviews, comments, ...base } = pr;
  const rollup = nodes(commits).at(-1)?.commit?.statusCheckRollup ?? null;
  const all = nodes(reviews);
  const failing = nodes(rollup?.contexts).flatMap((x) =>
    x.name && FAILING.has(x.conclusion ?? x.state ?? "") ? [{ name: x.name, url: x.url ?? null }] : [],
  );
  return {
    ...base,
    ci: rollup?.state ?? null,
    failing: failing.sort((a, b) => a.name.localeCompare(b.name)),
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
    const names = next.failing.map((f) => f.name).join(", ") || "unknown";
    if (ci === "passed") add("pr.ci_passed");
    else add("pr.ci_failed", "", { failing: next.failing }, `Failing ${at}: ${names}`);
  }
  if (next.mergeable === "CONFLICTING" && prev?.mergeable !== "CONFLICTING") add("pr.conflicting");
  if (next.mergeStateStatus === "BEHIND" && prev?.mergeStateStatus !== "BEHIND") add("pr.behind");
  const decision = next.reviewDecision;
  if (prev && decision !== prev.reviewDecision && /^(APPROVED|CHANGES_REQUESTED)$/.test(decision ?? ""))
    add("pr.review", String(decision), { decision });
  for (const [category, value] of Object.entries(next.activity))
    if (prev && value && value !== prev.activity[category as keyof PrSnapshot["activity"]])
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
  if (res.status === 404) return { reason: "not_found", detail: `The gh token cannot see ${subject}` };
  return null;
}
const isLimited = (res: GitHubResponse) =>
  [403, 429].includes(res.status) || /secondary rate limit|RATE_LIMITED/i.test(JSON.stringify(errorsOf(res)));
const pullPath = (pr: TrackedPr) => `repos/${pr.repo}/pulls/${pr.url.slice(pr.url.lastIndexOf("/") + 1)}`;
const headOf = (pr: TrackedPr | undefined) => saved(pr?.data)?.headRefOid ?? null;

/** Merge reconciliation's PR client while polling: the poller's last observations, never a GitHub read. */
export function observedPrs(store: Store): GitHubPrClient {
  return async (url) => saved(store.githubPrData(url));
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
  let [cooldownUntil, failures, running, stopped, settled] = [0, 0, false, false, false];
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Null during a rate-limit (or access-block) cooldown, which every request honours. */
  const call = async (repo: string, path: string, body?: unknown): Promise<GitHubResponse | null> => {
    if (stopped || now() < cooldownUntil) return null;
    const res = await client(path, body);
    if (!isLimited(res)) {
      failures = 0;
      return res;
    }
    const retry = Number(res.headers.get("retry-after"));
    cooldownUntil = now() + (retry > 0 ? retry * 1000 : Math.min(60_000 * 2 ** failures++, 900_000));
    const access = accessProblem(res, repo);
    if (access) store.setGithubAccess(repo, access);
    return null;
  };

  /** Saves the observation; returns the mergeability nudge's response (null: not sent) or undefined. */
  const record = async (pr: TrackedPr, snap: PrSnapshot) => {
    const prev = saved(pr.data);
    const head = snap.headRefOid;
    const same = prev?.headRefOid === head && prev.mergeable === "UNKNOWN";
    const unknown = snap.mergeable !== "UNKNOWN" ? 0 : same ? (prev?.unknown ?? 0) + 1 : 1;
    const nudge = unknown >= 3 && prev?.nudged !== head;
    const changes = diffPr(prev, snap);
    const revision = (prev?.revision ?? 0) + (changes.length ? 1 : 0);
    const items = changes.map((c) => {
      const key = `${pr.url}:${head}:${revision}:${c.key}`;
      return { ...c, runId: pr.runId, repo: pr.repo, data: { ...c.data, url: pr.url, head }, key };
    });
    const save = (nudged: string | null, feed = items) => {
      const data = JSON.stringify({ ...snap, revision, unknown, nudged } satisfies Saved);
      store.saveGithubPr({ ...pr, data }, snap.state !== "OPEN", feed);
    };
    save(unknown ? (prev?.nudged ?? null) : null);
    settled ||= snap.state !== "OPEN";
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
    if (known.length) {
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
      const interval = prs.some((p) => p.delivered) ? 15_000 : normal;
      return { repo, prs, due: (observedAt.get(repo) ?? -Infinity) + interval };
    });
  const schedule = () => {
    clear(timer);
    const next = Math.max(cooldownUntil, Math.min(...plan().map((r) => r.due)));
    timer = stopped || next === Infinity ? undefined : set(() => void tick(), Math.max(0, next - now()));
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const { repo, prs, due } of plan()) {
        if (stopped || due > now() || now() < cooldownUntil) continue;
        await observe(repo, prs).catch((e: unknown) => log(`GitHub poll of ${repo} failed: ${String(e)}`));
        // A repository a rate limit interrupted is due again as soon as the cooldown ends.
        if (now() >= cooldownUntil) observedAt.set(repo, now());
      }
      if (settled) await reconcileMergedRuns(store, observedPrs(store), log);
      settled = false;
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
    clear(timer);
    unsubscribe();
  };
}

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
