import { TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { checkPrivateText, loadPrivateStrings } from "../gates/private.ts";
import { sh } from "../util/proc.ts";
import type { GhRunner } from "./github.ts";

export interface GitHubPrState {
  url: string;
  state: string;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
}

export type GitHubPrClient = (url: string) => Promise<GitHubPrState | null>;

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
): Promise<void> {
  for (const run of store.listRuns({
    status: ["needs_human", "succeeded"],
    limit: Number.MAX_SAFE_INTEGER,
  })) {
    if (!run.prUrl || (run.merged && run.status === "succeeded")) continue;
    try {
      const pr = await client(run.prUrl);
      if (!pr || pr.url !== run.prUrl || store.getRun(run.id)?.prUrl !== pr.url) continue;
      const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
      if (pr.state === "MERGED" && Number.isFinite(mergedAt)) {
        if (run.status === "needs_human")
          store.resolveMergedRun(run.id, pr.mergedBy?.login ?? null, mergedAt);
        else store.updateRun(run.id, { merged: true, mergedBy: pr.mergedBy?.login ?? null, mergedAt });
      } else if ((pr.state === "CLOSED" || pr.state === "OPEN") && !store.getRun(run.id)?.merged) {
        const closed = pr.state === "CLOSED";
        if (run.prClosedUnmerged !== closed) store.updateRun(run.id, { prClosedUnmerged: closed });
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
  configDir?: string,
  roots: string[] = [],
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
    if (run.prUrl && (run.status === "needs_human" || (run.status === "succeeded" && !run.merged)))
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
    try {
      const entries = loadPrivateStrings(configDir, [
        process.cwd(),
        ...roots,
        store.getRunState<{ worktreePath?: string }>(run.id)?.worktreePath ?? process.cwd(),
        store.getRepo(run.repoId)?.localPath ?? process.cwd(),
      ]);
      checkPrivateText(body, "Factory comment", entries);
    } catch {
      log("Factory comment blocked by private-string policy");
      return;
    }
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
