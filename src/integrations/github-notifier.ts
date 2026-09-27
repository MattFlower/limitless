import { TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { GhRunner } from "./github.ts";

/** Factory-side comments for GitHub-originated runs. */
export function startGitHubNotifier(
  store: Store,
  gh: GhRunner,
  log: (message: string) => void = console.warn,
): () => void {
  const seen = new Set<string>();
  return store.subscribe((msg) => {
    if (msg.kind !== "run") return;
    const run = msg.run;
    const ref = run.sourceRef;
    if (
      run.source !== "github" ||
      !ref ||
      (ref.kind !== "issue" && ref.kind !== "pull_request") ||
      typeof ref.repo !== "string" ||
      typeof ref.number !== "number"
    )
      return;
    const terminal = TERMINAL_STATUSES.includes(run.status);
    if (terminal && store.getRunState<{ verdictCommentPosted?: boolean }>(run.id)?.verdictCommentPosted)
      return;
    if (run.status !== "queued" && !terminal) return;
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
}
