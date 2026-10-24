import { z } from "zod";
import { type Config, repoSettings } from "../config.ts";
import type { Run } from "../core/types.ts";
import { linkedIssues, type Store } from "../db/store.ts";
import { loadPrivateStrings } from "../gates/private.ts";
import { checkPublicationText } from "../gates/publication.ts";
import { redactCredentials } from "../util/proc.ts";
import type { GhRunner } from "./github.ts";

export const lifecycleManaged = (cfg: Partial<Pick<Config, "githubQueue">>, repo: string) =>
  !!cfg.githubQueue?.trusted.length &&
  cfg.githubQueue.repos.some((r) => r.toLowerCase() === repo.toLowerCase());
const labels = ["limitless:in-progress", "limitless:needs-you", "limitless:failed"] as const;

const desiredLabel = (run: Run) =>
  run.merged
    ? "none"
    : run.status === "needs_human"
      ? labels[1]
      : run.status === "failed"
        ? labels[2]
        : run.status === "cancelled" ||
            (["succeeded", "resolved"].includes(run.status) && (!run.prUrl || run.prClosedUnmerged))
          ? "none"
          : labels[0];

/** Polling owns these effects, independently of pipeline state_json and webhook delivery. */
export async function reconcileIssueLifecycle(
  store: Store,
  cfg: Config,
  gh: GhRunner,
  signal: AbortSignal,
  log: (s: string) => void,
): Promise<void> {
  const runs = store.issueLifecycleRuns();
  const latest = new Map<string, string>();
  const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
  for (const run of runs)
    for (const issue of linkedIssues(run)) latest.set(key(issue.repo, issue.number), run.id);
  for (const snapshot of runs) {
    if (signal.aborted) return;
    for (const { repo, number } of linkedIssues(snapshot)) {
      if (!lifecycleManaged(cfg, repo)) continue;
      const path = `repos/${repo}/issues/${number}`;
      const call = (args: string[]) => gh(["api", ...args], signal, undefined, repo);
      const state = (effect: string) => store.issueLifecycleEffect(snapshot.id, repo, number, effect);
      const save = (effect: string, value: string) =>
        store.setIssueLifecycleEffect(snapshot.id, repo, number, effect, value);
      const failure = (error: unknown) => {
        if (!signal.aborted)
          log(redactCredentials(`Issue lifecycle ${repo}#${number} run ${snapshot.id}: ${String(error)}`));
      };
      // Re-read after each issue: the pipeline may have advanced while GitHub was awaited.
      let run = store.getRun(snapshot.id);
      if (!run) continue;
      if (latest.get(key(repo, number)) === run.id && state("labels") !== desiredLabel(run)) {
        try {
          const current = z
            .array(z.array(z.object({ name: z.string() })))
            .parse(JSON.parse(String(await call([`${path}/labels?per_page=100`, "--paginate", "--slurp"]))))
            .flat()
            .map((l) => l.name);
          run = store.getRun(snapshot.id);
          if (!run) continue;
          const target = desiredLabel(run);
          for (const label of labels) {
            if (signal.aborted) return;
            run = store.getRun(snapshot.id);
            if (!run || desiredLabel(run) !== target) break;
            const add = label === target;
            const effect = `label:${label}:${add}`;
            if (current.includes(label) === add) {
              if (state(effect) === "pending") save(effect, "done");
              continue;
            }
            save(effect, "pending");
            try {
              await call(
                add
                  ? [`${path}/labels`, "-X", "POST", "-f", `labels[]=${label}`]
                  : [`${path}/labels/${encodeURIComponent(label)}`, "-X", "DELETE"],
              );
            } catch (error) {
              if (add || !/\bHTTP 404\b/.test(String(error))) throw error;
            }
            save(effect, "done");
          }
          run = store.getRun(snapshot.id);
          // Keep a cursor for the complete set so finished history needs no GitHub reads.
          if (run && desiredLabel(run) === target) save("labels", target);
        } catch (error) {
          failure(error);
        }
      }
      run = store.getRun(snapshot.id);
      if (!run) continue;
      const events: [string, string][] = [["started", `started: ${cfg.uiUrl}/runs/${run.id}`]];
      if (run.prUrl) events.push(["pr", `opened ${run.prUrl}`]);
      if (run.status === "needs_human")
        events.push(["needs_human", `needs you: ${run.error ?? "see the factory UI."}`]);
      if (run.status === "failed") events.push(["failed", `failed: ${run.error ?? "see the factory UI."}`]);
      if (run.status === "cancelled")
        events.push([
          "cancelled",
          `was cancelled${run.error?.startsWith("cancelled by ") ? " by the owner" : ""}.`,
        ]);
      for (const [event, text] of events) {
        if (signal.aborted) return;
        const effect = `comment:${event}`;
        if (state(effect) === "done") continue;
        if (repoSettings(cfg, repo).discreet) {
          save(effect, "done");
          continue;
        }
        try {
          const marker = `<!-- limitless-lifecycle:${run.id}:${event} -->`;
          if (state(effect) === "pending") {
            const comments = z
              .array(z.array(z.object({ body: z.string() })))
              .parse(
                JSON.parse(String(await call([`${path}/comments?per_page=100`, "--paginate", "--slurp"]))),
              )
              .flat();
            if (comments.some((c) => c.body.includes(marker))) {
              save(effect, "done");
              continue;
            }
          }
          let body = `${marker}\n${redactCredentials(`Limitless run ${run.id} ${text}`)}`;
          try {
            const worktree = store.getRunState<{ worktreePath?: string }>(run.id)?.worktreePath;
            checkPublicationText(
              body,
              "Issue lifecycle comment",
              loadPrivateStrings(cfg.paths.configDir, [
                worktree,
                store.getRepo(run.repoId)?.localPath,
                cfg.paths.repos,
                cfg.paths.work,
              ]),
            );
          } catch {
            body = `${marker}\nLimitless run ${run.id} ${event === "needs_human" ? "needs you" : event}: see the factory UI.`;
            log(
              redactCredentials(
                `Issue lifecycle run ${run.id}: comment text replaced by private-string policy`,
              ),
            );
          }
          if (signal.aborted) return;
          save(effect, "pending");
          await call([`${path}/comments`, "-X", "POST", "-f", `body=${body}`]);
          save(effect, "done");
        } catch (error) {
          failure(error);
          break;
        }
      }
    }
  }
}
