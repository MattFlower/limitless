import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedItem, RunStatus } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { GitHubClient, GitHubResponse } from "../src/integrations/github-poller.ts";
import { startGitHubPoller } from "../src/integrations/github-poller.ts";
import { waitClock } from "./wait-clock.ts";

export const SHA = "a".repeat(40);
export const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
export const respond = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): GitHubResponse => ({
  status,
  headers: new Headers(headers),
  body,
});

/** A GraphQL `PullRequest` node as the observation query returns it. */
export function prNode(repo: string, n: number) {
  return {
    id: `PR_${repo}_${n}`,
    url: url(repo, n),
    headRefOid: SHA,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null as string | null,
    updatedAt: "2026-10-03T00:00:00Z",
    mergedAt: null as string | null,
    mergedBy: null as { login: string } | null,
    commits: { nodes: [{ commit: { statusCheckRollup: null as unknown } }] },
    reviews: { nodes: [] as unknown[] },
    comments: { nodes: [] as unknown[] },
    latestReviews: { nodes: [] as { state: string; author: { login: string } | null }[] },
  };
}
export type PrNode = ReturnType<typeof prNode>;

/** Rejects once `signal` aborts, as fetch does. */
const aborted = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * Fake GitHub: serves PR nodes by id and REST pulls by number; `next` overrides the next responses and
 * `deny` answers every request for a repository.
 */
export function fakeGitHub(now: () => number = Date.now) {
  const nodes = new Map<string, PrNode>();
  const calls: { path: string; ids?: string[] }[] = [];
  const times: number[] = [];
  const signals: AbortSignal[] = [];
  const next: (GitHubResponse | Error)[] = [];
  const restNext: (GitHubResponse | Error)[] = [];
  const deny = new Map<string, () => GitHubResponse>();
  let inFlight = 0;
  let maxInFlight = 0;
  const client: GitHubClient = async (path, body, signal) => {
    const ids = (body as { variables?: { ids?: string[] } } | undefined)?.variables?.ids;
    calls.push(ids ? { path, ids } : { path });
    times.push(now());
    if (signal) signals.push(signal);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      await Promise.race([fake.hold ?? Promise.resolve(), aborted(signal)]);
    } finally {
      inFlight--;
    }
    const repo = ids ? ids[0]?.split("_")[1] : path.match(/^repos\/([^/]+\/[^/]+)\//)?.[1];
    const denied = repo && deny.get(repo);
    if (denied) return denied();
    const queued = (path === "graphql" ? undefined : restNext.shift()) ?? next.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    if (ids) return respond(200, { data: { nodes: ids.map((id) => nodes.get(id) ?? null) } });
    const match = path.match(/^repos\/(.+)\/pulls\/(\d+)$/);
    const node = [...nodes.values()].find((n) => match && n.url === url(match[1] ?? "", Number(match[2])));
    return node ? respond(200, { node_id: node.id }) : respond(404, { message: "Not Found" });
  };
  const fake = {
    /** While set, requests wait on it (a deferred response). */
    hold: null as Promise<void> | null,
    nodes,
    calls,
    times,
    signals,
    deny,
    next,
    /** Overrides for REST calls only, consumed before `next`. */
    restNext,
    client,
    get maxInFlight() {
      return maxInFlight;
    },
    get inFlight() {
      return inFlight;
    },
    add(repo: string, n: number) {
      const node = prNode(repo, n);
      nodes.set(node.id, node);
      return node;
    },
    graphql: () => calls.filter((c) => c.path === "graphql"),
    rest: () => calls.filter((c) => c.path !== "graphql"),
  };
  return fake;
}

/** A temporary store with GitHub repositories, a fake GitHub and a fake clock driving the poller. */
export function pollerHarness(repos = ["o/r"]) {
  const dir = mkdtempSync(join(tmpdir(), "github-poller-"));
  const path = join(dir, "db.sqlite");
  const clock = waitClock();
  const gh = fakeGitHub(clock.now);
  const logs: string[] = [];
  let stop = () => {};
  const h = {
    dir,
    gh,
    clock,
    logs,
    store: new Store(path),
    seen: 0,
    repo(slug: string) {
      return (
        h.store.getRepoBySlug(slug) ??
        h.store.upsertRepo({
          slug,
          kind: "github",
          url: null,
          localPath: null,
          defaultBranch: "main",
          mergePolicy: "pr",
        })
      );
    },
    /** A run that opened `repo#n` (and the PR on fake GitHub). */
    factoryPr(repo: string, n: number, status: RunStatus = "succeeded") {
      if (![...gh.nodes.values()].some((node) => node.url === url(repo, n))) gh.add(repo, n);
      const run = h.store.createRun(h.repo(repo), { repo, prompt: `pr ${n}` });
      h.store.updateRun(run.id, { prUrl: url(repo, n), status });
      return run;
    },
    node: (repo: string, n: number) => gh.nodes.get(`PR_${repo}_${n}`) as PrNode,
    start(seconds?: number) {
      stop = startGitHubPoller(h.store, {
        client: gh.client,
        seconds,
        log: (m) => logs.push(m),
        clock: {
          now: clock.now,
          set: clock.timer.set as unknown as typeof setTimeout,
          clear: clock.timer.clear as unknown as typeof clearTimeout,
        },
      });
      return () => stop();
    },
    async advance(ms: number) {
      await clock.advance(ms);
      // Macrotask turns drain the poller's promise chains; a 1 ms timer would only add wall time.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    },
    /** Feed items written since the previous call. */
    fresh(): FeedItem[] {
      const items = h.store.readFeed({ after: h.seen, limit: 1000 }).items;
      h.seen = items.at(-1)?.id ?? h.seen;
      return items.filter((i) => i.kind.startsWith("pr.") || i.kind.startsWith("github."));
    },
    reopen() {
      stop();
      h.store.close();
      h.store = new Store(path);
    },
    close() {
      stop();
      h.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const slug of repos) h.repo(slug);
  return h;
}
