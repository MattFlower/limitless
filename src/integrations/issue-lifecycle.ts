import { z } from "zod";
import { type Config, repoSettings } from "../config.ts";
import type { Run } from "../core/types.ts";
import { linkedIssues, type Store } from "../db/store.ts";
import { loadPrivateStrings } from "../gates/private.ts";
import { checkPublicationText, publicationWorktree, sanitizePublication } from "../gates/publication.ts";
import { redactCredentials } from "../util/proc.ts";
import type { GhRunner } from "./github.ts";
import { githubIdentity } from "./github-identity.ts";

export const lifecycleManaged = (cfg: Partial<Pick<Config, "githubQueue">>, repo: string) =>
  !!cfg.githubQueue?.trusted.length &&
  cfg.githubQueue.repos.some((r) => r.toLowerCase() === repo.toLowerCase());
const labels = ["limitless:in-progress", "limitless:needs-you", "limitless:failed"] as const;
const eventOrder = ["started", "pr", "needs_human", "failed", "cancelled"] as const;
export const ISSUE_LIFECYCLE_CALL_CAP = 50;
export type IssueLifecycleOptions = { identity?: typeof githubIdentity; maxCalls?: number };
const cursors = new WeakMap<Store, string>();
const sessions = new WeakMap<AbortSignal, Set<string>>();
const exhausted = Symbol("lifecycle call budget exhausted");

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
  opts: IssueLifecycleOptions = {},
): Promise<void> {
  let remaining = opts.maxCalls ?? ISSUE_LIFECYCLE_CALL_CAP;
  let freshLabels = sessions.get(signal);
  if (!freshLabels) {
    freshLabels = new Set();
    sessions.set(signal, freshLabels);
  }
  const call = (repo: string | undefined, args: string[], before?: () => void) => {
    if (signal.aborted || remaining <= 0) throw exhausted;
    remaining--;
    before?.();
    return gh(["api", ...args], signal, undefined, repo);
  };
  const logFailure = (run: Run, repo: string, number: number, error: unknown) => {
    if (!signal.aborted && error !== exhausted)
      log(redactCredentials(`Issue lifecycle ${repo}#${number} run ${run.id}: ${String(error)}`));
  };
  const checkBody = (run: Run, body: string) => {
    const worktree = publicationWorktree(store.getRunState(run.id) ?? {});
    const roots = [...worktree, store.getRepo(run.repoId)?.localPath ?? ""];
    const checked = sanitizePublication(redactCredentials(body), roots, cfg.paths.home);
    checkPublicationText(
      checked,
      "Issue lifecycle comment",
      loadPrivateStrings(cfg.paths.configDir, [...roots, cfg.paths.repos, cfg.paths.work]),
    );
    return checked;
  };
  const observe = (run: Run, repo: string, number: number) => {
    const effects = new Map(store.issueLifecycleEffects(run.id, repo, number).map((e) => [e.effect, e]));
    const save = (effect: string, state: string, details = {}) => {
      store.setIssueLifecycleEffect(run.id, repo, number, effect, state, details);
    };
    const link = `${cfg.uiUrl}/runs/${run.id}`;
    const events = new Map<string, string>([["started", `started: see ${link}.`]]);
    if (run.prUrl) {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9][0-9]*\/?$/.exec(run.prUrl);
      const pr = match?.[1]?.toLowerCase() === repo.toLowerCase() ? ` ${run.prUrl}` : "";
      events.set("pr", `opened a PR${pr}: see ${link}.`);
    }
    if (run.status === "needs_human") events.set("needs_human", `needs you: see ${link}.`);
    if (run.status === "failed") events.set("failed", `failed: see ${link}.`);
    if (run.status === "cancelled") events.set("cancelled", `was cancelled: see ${link}.`);
    for (const [event, text] of events) {
      const effect = `comment:${event}`;
      if (effects.has(effect)) continue;
      if (repoSettings(cfg, repo).discreet) {
        save(effect, "done");
        continue;
      }
      try {
        const body = checkBody(
          run,
          `<!-- limitless-lifecycle:${run.id}:${event} -->\nLimitless run ${run.id} ${text}`,
        );
        save(effect, "pending", { body });
      } catch (error) {
        save(effect, "done");
        logFailure(run, repo, number, error);
      }
    }
    if (!effects.has("labels")) save("labels", "pending");
  };
  const runs = store.issueLifecycleRuns();
  // Persist every observation before any delivery, even when the call budget is exhausted.
  for (const run of runs) {
    store.transaction(() => {
      for (const { repo, number } of linkedIssues(run))
        if (lifecycleManaged(cfg, repo)) observe(run, repo, number);
      store.observeIssueLifecycle(run);
    });
  }
  const work = runs.flatMap((snapshot) =>
    linkedIssues(snapshot)
      .filter(({ repo }) => lifecycleManaged(cfg, repo))
      .flatMap((issue) =>
        ["labels", ...eventOrder].map((effect) => ({
          snapshot,
          ...issue,
          effect,
          key: JSON.stringify([snapshot.id, issue.repo.toLowerCase(), issue.number, effect]),
        })),
      ),
  );
  const start = work.findIndex((w) => w.key === cursors.get(store)) + 1;
  const ordered = [...work.slice(start), ...work.slice(0, start)];
  const postingLogin = async (repo: string) => {
    const identity = await (opts.identity ?? githubIdentity)(repo);
    if (identity.kind === "app") return identity.botLogin;
    // Look up the owner only when the POST can follow in this poll.
    if (remaining < 2) throw exhausted;
    return z.object({ login: z.string() }).parse(JSON.parse(String(await call(undefined, ["user"])))).login;
  };
  for (const { snapshot, repo, number, effect: task, key } of ordered) {
    if (signal.aborted || remaining <= 0) return;
    cursors.set(store, key);
    const path = `repos/${repo}/issues/${number}`;
    const save = (effect: string, state: string, details = {}) =>
      store.setIssueLifecycleEffect(snapshot.id, repo, number, effect, state, details);
    const finishLabels = (target: string) =>
      store.transaction(() => {
        for (const e of store.issueLifecycleEffects(snapshot.id, repo, number))
          if (e.effect.startsWith("label:") && e.state === "pending") save(e.effect, "done");
        save("labels", target);
      });
    let run = store.getRun(snapshot.id);
    if (!run) continue;
    if (task !== "labels") observe(run, repo, number);
    const effects = new Map(store.issueLifecycleEffects(run.id, repo, number).map((e) => [e.effect, e]));
    if (task === "labels") {
      try {
        if (effects.get("labels")?.state !== desiredLabel(run)) {
          if (!store.issueLifecycleOwnsLabels(run, repo, number)) finishLabels(desiredLabel(run));
          else {
            let plan = effects.get("labels")?.body
              ? z
                  .object({
                    target: z.string(),
                    page: z.number(),
                    current: z.array(z.string()),
                  })
                  .parse(JSON.parse(effects.get("labels")?.body ?? ""))
              : null;
            // Only unfinished pagination survives a budget pause; completed snapshots need a refresh.
            if (plan?.target !== desiredLabel(run) || !freshLabels.has(key)) {
              plan = { target: desiredLabel(run), page: 1, current: [] };
              freshLabels.add(key);
            }
            while (plan.page) {
              // Leave the last page and a write together for the next poll.
              if (plan.page > 1 && remaining < 2) throw exhausted;
              const current = z
                .array(z.object({ name: z.string() }))
                .parse(
                  JSON.parse(String(await call(repo, [`${path}/labels?per_page=100&page=${plan.page}`]))),
                );
              plan.current.push(...current.map((l) => l.name));
              plan.page = current.length === 100 ? plan.page + 1 : 0;
              save("labels", "pending", { body: JSON.stringify(plan) });
            }
            freshLabels.delete(key);
            run = store.getRun(snapshot.id);
            if (!run) continue;
            observe(run, repo, number);
            const target = desiredLabel(run);
            plan.target = target;
            save("labels", "pending", { body: JSON.stringify(plan) });
            for (const label of labels) {
              if (signal.aborted) return;
              run = store.getRun(snapshot.id);
              if (!run || desiredLabel(run) !== target || !store.issueLifecycleOwnsLabels(run, repo, number))
                break;
              const add = label === target;
              const effect = `label:${label}:${add}`;
              if (plan.current.includes(label) === add) continue;
              save(effect, "pending");
              try {
                await call(
                  repo,
                  add
                    ? [`${path}/labels`, "-X", "POST", "-f", `labels[]=${label}`]
                    : [`${path}/labels/${encodeURIComponent(label)}`, "-X", "DELETE"],
                );
              } catch (error) {
                if (add || !/\bHTTP 404\b/.test(String(error))) throw error;
              }
              plan.current = plan.current.filter((l) => l !== label);
              if (add) plan.current.push(label);
              store.transaction(() => {
                save(effect, "done");
                save("labels", "pending", { body: JSON.stringify(plan) });
              });
              freshLabels.delete(key);
            }
            run = store.getRun(snapshot.id);
            if (
              run &&
              desiredLabel(run) === target &&
              labels.every((l) => plan.current.includes(l) === (l === target))
            ) {
              finishLabels(target);
              freshLabels.delete(key);
            }
          }
        }
      } catch (error) {
        if (error === exhausted) {
          return;
        }
        freshLabels.delete(key);
        logFailure(snapshot, repo, number, error);
      }
      continue;
    }
    const effect = `comment:${task}`;
    const pending = effects.get(effect);
    if (pending?.state !== "pending") continue;
    if (repoSettings(cfg, repo).discreet) {
      save(effect, "done");
      continue;
    }
    try {
      let body: string;
      try {
        if (!pending.body) throw new Error("missing lifecycle comment body");
        body = checkBody(run, pending.body);
      } catch (error) {
        save(effect, "done");
        logFailure(run, repo, number, error);
        continue;
      }
      if (pending.page) {
        const marker = body.split("\n")[0] ?? "";
        let page = pending.page;
        while (page) {
          const comments = z
            .array(
              z.object({
                id: z.number(),
                body: z.string(),
                user: z.object({ login: z.string() }).nullable(),
              }),
            )
            .parse(JSON.parse(String(await call(repo, [`${path}/comments?per_page=100&page=${page}`]))));
          const found = comments.find((c) => c.user?.login === pending.login && c.body.includes(marker));
          if (found) {
            save(effect, "done", { commentId: found.id });
            break;
          }
          page = comments.length === 100 ? page + 1 : 0;
          save(effect, "pending", { page });
        }
        if (page) continue; // A matching factory comment was found.
      }
      const login = await postingLogin(repo);
      if (!login) throw new Error("cannot identify lifecycle comment author");
      save(effect, "pending", { body, login });
      const created = z.object({ id: z.number().int().positive() }).parse(
        JSON.parse(
          String(
            await call(repo, [`${path}/comments`, "-X", "POST", "-f", `body=${body}`], () => {
              save(effect, "pending", { body, login, page: 1 });
            }),
          ),
        ),
      );
      save(effect, "done", { commentId: created.id });
    } catch (error) {
      if (error === exhausted) {
        return;
      }
      logFailure(run, repo, number, error);
    }
  }
}
