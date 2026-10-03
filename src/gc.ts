import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import type { Repo, Run } from "./core/types.ts";
import type { Store } from "./db/store.ts";
import { FEED_RETENTION_DAYS } from "./feed.ts";
import { BASELINE_CACHE_TTL_MS } from "./gates/cache.ts";
import { worktreeGit } from "./git/command.ts";
import { cachePath, withRepoLock, worktreeOwner } from "./git/repos.ts";
import { sh } from "./util/proc.ts";

const DAY = 86_400_000;

export interface GcResult {
  dryRun: boolean;
  worktrees: string[];
  logs: string[];
  metadata: string[];
  debugEvents: number;
  baselineCache: number;
  feedItems: number;
  errors: string[];
}

function child(root: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`unsafe run id: ${id}`);
  const path = resolve(root, id);
  if (!path.startsWith(resolve(root) + sep)) throw new Error(`path outside ${root}: ${path}`);
  return path;
}

function canonical(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return join(canonical(dirname(path)), basename(path));
    throw error;
  }
}

function worktreePaths(porcelain: string): Set<string> {
  return new Set(
    porcelain
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => canonical(line.slice("worktree ".length))),
  );
}

function prunablePaths(porcelain: string): string[] {
  return porcelain.split("\n\n").flatMap((entry) => {
    const lines = entry.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "));
    return path && lines.some((line) => line.startsWith("prunable "))
      ? [canonical(path.slice("worktree ".length))]
      : [];
  });
}

function due(run: Run, now: number, days: number): boolean {
  return run.finishedAt !== null && run.finishedAt <= now - days * DAY;
}

/** One bounded, deterministic pass. Each item is independent so failures remain retryable. */
export async function collectGarbage(
  store: Store,
  cfg: Config,
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<GcResult> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const result: GcResult = {
    dryRun,
    worktrees: [],
    logs: [],
    metadata: [],
    debugEvents: 0,
    baselineCache: 0,
    feedItems: 0,
    errors: [],
  };
  const finished = store.finishedRuns();
  const repos = new Map(store.listRepos().map((repo) => [repo.id, repo]));
  const workRoot = resolve(cfg.paths.work);
  const runRoot = resolve(cfg.paths.runs);

  for (const run of finished) {
    const days =
      run.status === "failed" || run.status === "needs_human"
        ? cfg.retention.failedWorktreeDays
        : cfg.retention.worktreeDays;
    if (!due(run, now, days)) continue;
    const repo = repos.get(run.repoId);
    if (!repo) {
      result.errors.push(`${run.id}: registered repository missing`);
      continue;
    }
    try {
      const path = child(workRoot, run.id);
      const cache =
        repo.kind === "local" && existsSync(path) ? await worktreeOwner(path) : cachePath(cfg.paths, repo);
      const git = repo.kind === "github" ? worktreeGit : sh;
      if (repo.kind === "github" && !resolve(cache).startsWith(resolve(cfg.paths.repos) + sep)) {
        throw new Error(`repository cache outside ${cfg.paths.repos}`);
      }
      await withRepoLock(cache, async () => {
        if (!existsSync(path)) return;
        if (repo.kind === "local") {
          const owned = cachePath(cfg.paths, repo);
          if (
            canonical(cache) !== canonical(owned) &&
            (!repo.localPath || cache !== (await worktreeOwner(repo.localPath)))
          )
            throw new Error(`worktree is not registered to ${repo.slug}: ${path}`);
        }
        if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
          throw new Error(`worktree path is not a directory: ${path}`);
        }
        const listed = worktreePaths(
          (await git(["git", "worktree", "list", "--porcelain"], { cwd: cache })).stdout,
        );
        if (realpathSync(path).startsWith(realpathSync(workRoot) + sep) && listed.has(canonical(path))) {
          if (!dryRun) await git(["git", "worktree", "remove", "--force", path], { cwd: cache });
          result.worktrees.push(path);
        } else {
          throw new Error(`worktree is not registered to ${repo.slug}: ${path}`);
        }
      });
    } catch (error) {
      result.errors.push(`${run.id} worktree: ${(error as Error).message}`);
    }
  }

  // Git's dry-run mode reports the same stale entries without modifying metadata.
  const relevantRepos = new Map<string, Repo>();
  for (const run of finished) {
    const days =
      run.status === "failed" || run.status === "needs_human"
        ? cfg.retention.failedWorktreeDays
        : cfg.retention.worktreeDays;
    const repo = repos.get(run.repoId);
    if (repo && due(run, now, days)) relevantRepos.set(repo.id, repo);
  }
  const caches = [...relevantRepos.values()].flatMap((repo) =>
    [cachePath(cfg.paths, repo), ...(repo.kind === "local" && repo.localPath ? [repo.localPath] : [])]
      .filter(existsSync)
      .map((cache) => ({ repo, cache })),
  );
  for (const { repo, cache } of caches) {
    const git = repo.kind === "github" ? worktreeGit : sh;
    try {
      await withRepoLock(cache, async () => {
        const eligible = new Set(
          finished
            .filter(
              (run) =>
                run.repoId === repo.id &&
                due(
                  run,
                  now,
                  run.status === "failed" || run.status === "needs_human"
                    ? cfg.retention.failedWorktreeDays
                    : cfg.retention.worktreeDays,
                ),
            )
            .map((run) => canonical(child(workRoot, run.id))),
        );
        const listed = (await git(["git", "worktree", "list", "--porcelain"], { cwd: cache })).stdout;
        const prunable = prunablePaths(listed);
        // Only prune the source when an eligible legacy worktree left stale metadata there.
        if (cache === repo.localPath && !prunable.some((path) => eligible.has(path))) return;
        const unrelated = prunable.filter((path) => !eligible.has(path));
        if (unrelated.length)
          throw new Error(`prune would affect unrelated worktrees: ${unrelated.join(", ")}`);
        const output = await git(["git", "worktree", "prune", "--expire", "now", "--dry-run", "--verbose"], {
          cwd: cache,
        });
        const entries = `${output.stdout}\n${output.stderr}`.split("\n").filter((line) => line.trim());
        if (entries.length !== prunable.length) {
          throw new Error("prune reported metadata that could not be matched to eligible worktrees");
        }
        if (!dryRun) await git(["git", "worktree", "prune", "--expire", "now"], { cwd: cache });
        for (const entry of entries) result.metadata.push(`${repo.slug}: ${entry.trim()}`);
      });
    } catch (error) {
      result.errors.push(`${repo.slug} metadata: ${(error as Error).message}`);
    }
  }

  for (const run of finished) {
    if (!due(run, now, cfg.retention.logDays)) continue;
    try {
      const dir = child(runRoot, run.id);
      if (!existsSync(dir)) continue;
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
        throw new Error(`run directory is not a directory: ${dir}`);
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!/^inv-\d+\.log$/.test(entry.name)) continue;
        try {
          if (!entry.isFile()) throw new Error("invocation log is not a regular file");
          const path = join(dir, entry.name);
          if (!dryRun) unlinkSync(path);
          result.logs.push(path);
        } catch (error) {
          result.errors.push(`${run.id}/${entry.name}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      result.errors.push(`${run.id} logs: ${(error as Error).message}`);
    }
  }

  try {
    const cutoff = now - cfg.retention.debugEventDays * DAY;
    result.debugEvents = dryRun ? store.countOldDebugEvents(cutoff) : store.deleteOldDebugEvents(cutoff);
  } catch (error) {
    result.errors.push(`debug events: ${(error as Error).message}`);
  }

  try {
    const cutoff = now - BASELINE_CACHE_TTL_MS;
    result.baselineCache = dryRun
      ? store.countExpiredBaselineCache(cutoff)
      : store.deleteExpiredBaselineCache(cutoff);
  } catch (error) {
    result.errors.push(`baseline cache: ${(error as Error).message}`);
  }

  try {
    result.feedItems = store.pruneFeed(now - FEED_RETENTION_DAYS * DAY, dryRun);
  } catch (error) {
    result.errors.push(`feed: ${(error as Error).message}`);
  }
  return result;
}
