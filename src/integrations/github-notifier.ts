import { TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { sh } from "../util/proc.ts";
import type { GhRunner } from "./github.ts";

export interface GitHubPrState {
  url: string;
  state: string;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
  /** The head the client saw; a client that reports only state leaves it undefined. */
  headRefOid?: string;
}

/** `gh pr view`'s full report: the head and the CI rollup the land queue waits on. */
export interface GitHubPrView extends GitHubPrState {
  ci: string | null;
  failing: string[];
}

export type GitHubPrClient = (url: string) => Promise<GitHubPrState | null>;

// The poller keeps its own copy for GraphQL contexts; `gh pr view` reports the rollup the same way.
const CI_FAILURES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

type GhPrView = GitHubPrView & {
  statusCheckRollup?: {
    state?: string;
    contexts?: { name?: string; conclusion?: string; state?: string }[];
  } | null;
};

export const getGitHubPr = async (url: string): Promise<GitHubPrView> => {
  const { stdout } = await sh(
    ["gh", "pr", "view", url, "--json", "url,state,mergedAt,mergedBy,headRefOid,statusCheckRollup"],
    { cwd: process.cwd(), timeoutMs: 30_000 },
  );
  const view = JSON.parse(stdout) as GhPrView;
  const contexts = view.statusCheckRollup?.contexts ?? [];
  return {
    url: view.url,
    state: view.state,
    mergedAt: view.mergedAt,
    mergedBy: view.mergedBy,
    headRefOid: view.headRefOid,
    ci: view.statusCheckRollup?.state ?? null,
    failing: contexts.filter((c) => CI_FAILURES.has(c.conclusion ?? c.state ?? "")).map((c) => c.name ?? ""),
  };
};

export async function reconcileMergedRuns(
  store: Store,
  client: GitHubPrClient,
  log: (message: string) => void = console.warn,
): Promise<void> {
  for (const run of store.listRuns({
    status: ["needs_human", "succeeded", "resolved"],
    limit: Number.MAX_SAFE_INTEGER,
  })) {
    if (!run.prUrl || (run.merged && run.status !== "needs_human")) continue;
    try {
      const pr = await client(run.prUrl);
      if (!pr || pr.url !== run.prUrl || store.getRun(run.id)?.prUrl !== pr.url) continue;
      const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
      if (pr.state === "MERGED" && Number.isFinite(mergedAt)) {
        store.resolveMergedRun(run.id, pr.mergedBy?.login ?? null, mergedAt);
      } else if ((pr.state === "CLOSED" || pr.state === "OPEN") && !store.getRun(run.id)?.merged) {
        const closed = pr.state === "CLOSED";
        if (closed && !pr.mergedAt && run.status === "needs_human") {
          const resolution = { kind: "pr_closed", ref: pr.url, by: "github" } as const;
          store.resolveRun(run.id, resolution, { from: ["needs_human"], patch: { prClosedUnmerged: true } });
        } else if (run.prClosedUnmerged !== closed) store.updateRun(run.id, { prClosedUnmerged: closed });
      }
    } catch (error) {
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
