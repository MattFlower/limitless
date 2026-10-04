import { TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { sh } from "../util/proc.ts";
import type { GhRunner } from "./github.ts";

export interface GitHubPrState {
  url: string;
  state: string;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
}

export type GitHubPrClient = ((url: string) => Promise<GitHubPrState | null>) & {
  fresh?: GitHubPrClient | null; // null for cache-only clients
  beginPass?: () => void;
  observed?: (url: string) => boolean;
};

export const RECONCILE_REQUEST_CAP = 25;
const passes = new WeakMap<
  Store,
  {
    cursor: string;
    checked: Map<string, number>;
    retries: Map<string, { failures: number; at: number }>;
  }
>();

export const getGitHubPr: GitHubPrClient = async (url) => {
  const { stdout } = await sh(["gh", "pr", "view", url, "--json", "url,state,mergedAt,mergedBy"], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  return JSON.parse(stdout) as GitHubPrState;
};

export async function reconcileMergedRuns(
  store: Store,
  client: GitHubPrClient,
  log: (message: string) => void = console.warn,
  now: () => number = Date.now,
): Promise<void> {
  let pass = passes.get(store);
  if (!pass) {
    pass = { cursor: "", checked: new Map(), retries: new Map() };
    passes.set(store, pass);
  }
  client.beginPass?.();
  const runs = store
    .listRuns({
      status: ["needs_human", "succeeded", "resolved", "failed", "cancelled"],
      limit: Number.MAX_SAFE_INTEGER,
    })
    .filter(
      (run) =>
        !["failed", "cancelled"].includes(run.status) ||
        (run.prUrl &&
          !run.deliveryBranch &&
          run.sourceRef?.kind !== "pull_request" &&
          store.githubPrExpired(run.prUrl, now())),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const start = runs.findIndex((run) => run.id > pass.cursor);
  const ordered = start < 0 ? runs : [...runs.slice(start), ...runs.slice(0, start)];
  const expired = new Set(
    ordered.flatMap((r) => (r.prUrl && store.githubPrExpired(r.prUrl, now()) ? [r.prUrl] : [])),
  );
  ordered.sort(
    (a, b) =>
      Number(expired.has(a.prUrl ?? "")) - Number(expired.has(b.prUrl ?? "")) ||
      (expired.has(a.prUrl ?? "")
        ? (pass.checked.get(a.prUrl ?? "") ?? Infinity) - (pass.checked.get(b.prUrl ?? "") ?? Infinity)
        : 0),
  );
  const overdue = new Set(
    ordered.flatMap((run) =>
      run.prUrl &&
      client.fresh !== null &&
      expired.has(run.prUrl) &&
      (!run.merged || run.status === "needs_human") &&
      pass.checked.has(run.prUrl) &&
      now() >= (pass.checked.get(run.prUrl) ?? 0) + 86_400_000 &&
      (pass.retries.get(run.prUrl)?.at ?? 0) <= now()
        ? [run.prUrl]
        : [],
    ),
  );
  let calls = 0;
  const results = new Map<string, GitHubPrState | null>();
  const failed = new Set<string>();
  for (const run of ordered) {
    if (!run.prUrl || (run.merged && run.status !== "needs_human")) continue;
    if (failed.has(run.prUrl)) continue;
    if (expired.has(run.prUrl) && !results.has(run.prUrl)) {
      if (!pass.checked.has(run.prUrl)) pass.checked.set(run.prUrl, now());
      if (now() < (pass.checked.get(run.prUrl) ?? 0) + 86_400_000) continue;
      if (client.fresh === null) continue;
    }
    if ((pass.retries.get(run.prUrl)?.at ?? 0) > now()) continue;
    // Keep the final slot available for an overdue probe even under a full healthy backlog.
    const cap = RECONCILE_REQUEST_CAP - Number(!expired.has(run.prUrl) && overdue.size > 0);
    if (!results.has(run.prUrl) && calls >= cap) continue;
    try {
      if (!results.has(run.prUrl)) {
        calls++;
        overdue.delete(run.prUrl);
        if (!expired.has(run.prUrl)) pass.cursor = run.id;
        if (!expired.has(run.prUrl)) pass.checked.set(run.prUrl, now());
        results.set(run.prUrl, await (expired.has(run.prUrl) ? (client.fresh ?? client) : client)(run.prUrl));
      }
      const pr = results.get(run.prUrl);
      if (!pr || pr.url !== run.prUrl) {
        if (expired.has(run.prUrl) || !client.observed?.(run.prUrl))
          throw new Error("No matching PR observation");
        continue;
      }
      if (expired.has(run.prUrl)) pass.checked.set(run.prUrl, now());
      pass.retries.delete(run.prUrl);
      if (store.getRun(run.id)?.prUrl !== pr.url) continue;
      const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
      if (pr.state === "MERGED" && Number.isFinite(mergedAt)) {
        store.resolveMergedRun(run.id, pr.mergedBy?.login ?? null, mergedAt);
      } else if ((pr.state === "CLOSED" || pr.state === "OPEN") && !store.getRun(run.id)?.merged) {
        const closed = pr.state === "CLOSED";
        store.observeGithubPrState(pr.url, pr.state, now());
        if (closed && !pr.mergedAt && run.status === "needs_human") {
          const resolution = { kind: "pr_closed", ref: pr.url, by: "github" } as const;
          store.resolveRun(run.id, resolution, { from: ["needs_human"], patch: { prClosedUnmerged: true } });
        } else if (run.prClosedUnmerged !== closed) store.updateRun(run.id, { prClosedUnmerged: closed });
      }
    } catch (error) {
      failed.add(run.prUrl);
      const failures = (pass.retries.get(run.prUrl)?.failures ?? 0) + 1;
      pass.retries.set(run.prUrl, {
        failures,
        at: failures < 2 ? 0 : now() + Math.min(60_000 * 2 ** (failures - 2), 900_000),
      });
      log(`GitHub PR check failed for ${run.id}: ${String(error)}`);
    }
  }
  store.reconcileWaitingRuns();
}

/** Factory-side comments for GitHub-originated runs. */
export function startGitHubNotifier(
  store: Store,
  gh: GhRunner,
  log: (message: string) => void = console.warn,
  client: GitHubPrClient = getGitHubPr,
): () => void {
  const seen = new Set<string>();
  let stopped = false;
  let checking = false;
  let pending = false;
  const check = async () => {
    if (stopped) return;
    if (checking) {
      pending = true;
      return;
    }
    checking = true;
    try {
      await reconcileMergedRuns(store, client, log);
    } finally {
      checking = false;
      if (pending) {
        pending = false;
        void check();
      }
    }
  };
  const timer = setInterval(() => void check(), 5 * 60_000);
  void check();
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind !== "run") return;
    const run = msg.run;
    if (
      run.prUrl &&
      (run.status === "needs_human" || (["succeeded", "resolved"].includes(run.status) && !run.merged))
    )
      void check();
    const ref = run.sourceRef;
    if (
      run.source !== "github" ||
      !ref ||
      (ref.kind !== "issue" && ref.kind !== "pull_request") ||
      typeof ref.repo !== "string" ||
      typeof ref.number !== "number"
    )
      return;
    // A resolution follows the terminal comment already posted for needs_human or failed.
    if (run.status === "resolved") return;
    if (ref.kind === "pull_request" && run.status === "cancelled" && run.error?.startsWith("superseded:"))
      return;
    const terminal = TERMINAL_STATUSES.includes(run.status);
    if (terminal && store.getRunState<{ verdictCommentPosted?: boolean }>(run.id)?.verdictCommentPosted)
      return;
    if (run.status !== "queued" && !terminal) return;
    // PR verification runs (they carry the PR base) answer with a single evidence comment instead.
    if (!terminal && ref.kind === "pull_request" && typeof ref.baseSha === "string") return;
    const key = `${run.id}:${terminal ? "terminal" : "created"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const body = terminal
      ? `Limitless run ${run.id} finished: **${run.status}**.\nPR: ${run.prUrl ?? "none"}\nCost: $${run.costUsd.toFixed(2)} (${run.costEquivUsd.toFixed(2)} subscription equivalent).`
      : `Limitless run created: ${run.id}`;
    void gh([
      ref.kind === "issue" ? "issue" : "pr",
      "comment",
      String(ref.number),
      "--repo",
      ref.repo,
      "--body",
      body,
    ]).catch((error: unknown) => log(`GitHub comment failed for ${run.id}: ${String(error)}`));
  });
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
}
