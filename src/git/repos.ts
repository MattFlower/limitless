import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { type Config, type Paths, repoSettings } from "../config.ts";
import { isBranchName } from "../core/delivery.ts";
import type { AuditAllowance, Repo } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { AgentJobRequest } from "../db/workers.ts";
import {
  attributeRules,
  auditDiff,
  INERT_MEDIA_PATH,
  newlyHidden,
  SOURCE_PATH,
  unquote,
} from "../gates/audit.ts";
import { isForbiddenFormat, isInertMedia, MEDIA_LIMIT } from "../gates/media.ts";
import type { PrivateStrings } from "../gates/private.ts";
import * as privacy from "../gates/private.ts";
import { checkPublicationText } from "../gates/publication.ts";
import { withScratch } from "../harness/scratch.ts";
import { rethrowClaimControl } from "../integrations/claim-errors.ts";
import type { GhRunner } from "../integrations/github.ts";
import { GitHubIdentityError, githubSh, githubUrlRepo } from "../integrations/github-identity.ts";
import { checkDiscreetBranch, DiscreetError } from "../pipeline/markers.ts";
import {
  CommandError,
  ProcessTerminationError,
  processCleanupStore,
  processScope,
  recoverProcessCleanups,
  redactCredentials,
  registeredCredentials,
  sh,
} from "../util/proc.ts";
import {
  cacheGit,
  emptyTreeId,
  NO_BIG_FILES,
  recordWorktree,
  stageAll,
  worktreeGit,
  worktreeGitScope,
} from "./command.ts";
import { type CommitIdentity, mergeGit } from "./merge.ts";

const BRANCH_PUSH = ["git", "push", "--no-follow-tags"];
const NO_PUSH = "no-push://limitless-agents-cannot-push";

/** Retry policy for GitHub and remote git (tests shorten it). */
export const githubRetry = { attempts: 3, budgetMs: 60_000, baseDelayMs: 5_000 };
export { githubWait } from "./github-wait.ts";
/**
 * In-memory GitHub time shared by every call in one delivery attempt. It only drains while a
 * remote command or a backoff pause runs, so local work in between never eats into it. It bounds
 * retries and their waits only: a call's first attempt always runs and keeps its own timeout.
 */
export interface GitHubBudget {
  leftMs: number;
}
export class GitHubUnavailableError extends Error {}
/** A retryable outcome that is not a failed command, e.g. a PR lookup lagging behind its create. */
class RetryableError extends Error {}
/** Keep a caller guard failure out of retry and outcome classification. */
class GitHubGuardError extends Error {}

// Every pattern contains a space, which a branch name cannot, so echoed refs never look transient.
const TRANSIENT = [
  /\bHTTP (5\d\d|429)\b/i,
  /error connecting to /i,
  /non-200 OK status code: (5\d\d|429)\b/i,
  /unable to access .*(Failed to connect|timed out|Recv failure|returned error: (5\d\d|429))/i,
  /could not resolve host/i,
  /ssh: connect to host .*(timed out|refused|unreachable)/i,
  /kex_exchange_identification: |connection (reset|closed) by /i,
  /i\/o timeout|TLS handshake timeout/i,
  /(early|unexpected) EOF|": EOF\b/i,
];

/** Only a failed command's timeout or its stderr count; 4xx and anything else are final. */
export function isTransient(error: unknown): boolean {
  return error instanceof CommandError && (error.timedOut || TRANSIENT.some((re) => re.test(error.stderr)));
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The single retry layer for GitHub and remote git: callers must never retry on top of it. */
export async function withGitHubRetry<T>(
  call: () => Promise<T>,
  opts: { budget?: GitHubBudget; signal?: AbortSignal } = {},
): Promise<T> {
  const budget = opts.budget ?? { leftMs: githubRetry.budgetMs };
  const charged = async <R>(work: () => Promise<R>): Promise<R> => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      budget.leftMs -= Date.now() - started;
    }
  };
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    // Every call's first attempt runs, as on main: a slow or hung earlier call must not cost later
    // calls (or the fallbacks) their one try. The budget only decides whether to retry.
    if (attempt > 1 && budget.leftMs <= 0)
      throw new GitHubUnavailableError("GitHub unavailable: delivery retry budget exhausted");
    try {
      return await charged(call);
    } catch (error) {
      if (!(isTransient(error) || error instanceof RetryableError) || opts.signal?.aborted) throw error;
      const delay = githubRetry.baseDelayMs * 3 ** (attempt - 1);
      if (attempt >= githubRetry.attempts || delay >= budget.leftMs)
        throw new GitHubUnavailableError(`GitHub unavailable: ${(error as Error).message}`, { cause: error });
      await charged(() => pause(delay, opts.signal));
    }
  }
}

type RemoteOpts = {
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  budget?: GitHubBudget;
};
const remoteSh = (cmd: string[], opts: RemoteOpts, guard?: () => void, repo?: string) =>
  withGitHubRetry(
    () =>
      cmd[0] === "git"
        ? cacheGit(cmd, opts, () => {
            try {
              guard?.();
            } catch (cause) {
              throw new GitHubGuardError("Push guard refused", { cause });
            }
          })
        : githubSh(cmd, opts, repo),
    opts,
  ).catch((error) => {
    if (error instanceof GitHubGuardError) throw error.cause;
    throw error;
  });

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "task"
  );
}

type MergePolicy = Repo["mergePolicy"];
/** Resolve "owner/name", a GitHub URL, or a local path into a registered repo. */
export async function resolveRepo(store: Store, input: string, merge: MergePolicy = "auto"): Promise<Repo> {
  const trimmed = input.trim();
  const existing = store.getRepoBySlug(trimmed);
  if (existing) return existing;

  if (isAbsolute(trimmed) || trimmed.startsWith("~") || trimmed.startsWith(".")) {
    const path = resolve(trimmed.replace(/^~/, process.env.HOME ?? "~"));
    if (!existsSync(join(path, ".git"))) throw new Error(`${path} is not a git repository`);
    const existing = store.listRepos().find((r) => r.kind === "local" && r.localPath === path);
    if (existing) return existing;
    // Two different directories can share a basename; disambiguate with a short path hash.
    let slug = `local/${basename(path)}`;
    if (store.getRepoBySlug(slug)) {
      slug = `local/${basename(path)}-${new Bun.CryptoHasher("sha256").update(path).digest("hex").slice(0, 6)}`;
    }
    // The user owns this registration source; no agent writes it here.
    const head = await sh(["git", "symbolic-ref", "--short", "HEAD"], { cwd: path, allowFail: true });
    return store.upsertRepo({
      slug,
      kind: "local",
      url: null,
      localPath: path,
      defaultBranch: head.stdout.trim() || "main",
      mergePolicy: "none",
    });
  }

  const m = trimmed.match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse repo "${input}". Use owner/name or a local path.`);
  const slug = `${m[1]}/${m[2]}`;
  const found = store.getRepoBySlug(slug);
  if (found) return found;
  const view = await remoteSh(
    ["gh", "repo", "view", slug, "--json", "defaultBranchRef,sshUrl"],
    { cwd: process.cwd() },
    undefined,
    slug,
  );
  const info = JSON.parse(view.stdout) as { defaultBranchRef: { name: string } | null; sshUrl: string };
  return store.upsertRepo({
    slug,
    kind: "github",
    url: info.sshUrl,
    localPath: null,
    defaultBranch: info.defaultBranchRef?.name ?? "main",
    mergePolicy: merge,
  });
}

export function cachePath(paths: Paths, repo: Repo): string {
  if (repo.kind === "local") return join(paths.repos, `local-${repo.id}.git`);
  return join(paths.repos, `${repo.slug.replace("/", "__")}.git`);
}

const cacheLocks = new Map<string, Promise<unknown>>();

/** Serialize work on one repo cache (clone/fetch/worktree add) across concurrent runs. */
export async function withRepoLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(path);
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const store = processScope.getStore()?.cleanups ?? processCleanupStore.getStore();
      if (store) {
        try {
          const records = store
            .listProcessCleanups()
            .filter((row) => lockKey(row.directory) === lockKey(path));
          await recoverProcessCleanups(store, records);
        } catch (error) {
          if (error instanceof ProcessTerminationError) throw error;
          throw new ProcessTerminationError(
            `${ProcessTerminationError.prefix}: repository cache cleanup: ${redactCredentials((error as Error).message)}`,
            { cause: error },
          );
        }
      }
      return fn();
    });
  cacheLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (cacheLocks.get(key) === next) cacheLocks.delete(key);
  }
}

/** Symlinked and real spellings of one repository must share a lock, even before it exists. */
function lockKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(lockKey(parent), basename(path));
  }
}

/** Make sure a factory-owned bare clone exists and is fetched. */
export async function ensureCache(paths: Paths, repo: Repo, signal?: AbortSignal): Promise<string> {
  const cache = cachePath(paths, repo);
  return withRepoLock(cache, () => refreshCache(paths, repo, signal));
}

async function refreshCache(paths: Paths, repo: Repo, signal?: AbortSignal): Promise<string> {
  const cache = cachePath(paths, repo);
  signal?.throwIfAborted();
  if (!existsSync(cache)) {
    mkdirSync(paths.repos, { recursive: true });
    // Clone to a temporary path and rename, so a crash never leaves a half-configured cache.
    const tmp = `${cache}.tmp-${process.pid}-${Date.now()}`;
    try {
      if (repo.kind === "local") {
        // Not `git clone`: config conditional on the new git directory (includeIf) can define hooks
        // that clone, and even init, would run before any lookup could see them. A bare skeleton
        // git already recognises lets every command, init included, discover and blank those hooks.
        // The fetch below fills it, so it owns its objects (source gc cannot break retained runs);
        // the empty template keeps init.templateDir hooks out.
        for (const dir of ["objects", "refs"]) mkdirSync(join(tmp, dir), { recursive: true });
        writeFileSync(join(tmp, "HEAD"), "ref: refs/heads/main\n");
        // Unlike clone, init doesn't adopt the source's hash (a SHA-256 source can't fetch into SHA-1).
        const format = await worktreeGit(["git", "rev-parse", "--show-object-format"], {
          cwd: repo.localPath as string,
          signal,
        });
        await cacheGit(
          ["git", "init", "-q", "--bare", "--template=", `--object-format=${format.stdout.trim()}`],
          { cwd: tmp, signal },
        );
        await cacheGit(["git", "config", "remote.origin.url", repo.localPath as string], {
          cwd: tmp,
          signal,
        });
      } else {
        await cacheGit(["git", "clone", "--bare", repo.url as string, tmp], {
          cwd: paths.repos,
          timeoutMs: 600_000,
          signal,
        });
      }
      await cacheGit(["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], {
        cwd: tmp,
        signal,
      });
      renameSync(tmp, cache);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (repo.kind === "local") {
    await cacheGit(["git", "config", "user.name", "Limitless"], { cwd: cache });
    await cacheGit(["git", "config", "user.email", "limitless@localhost"], { cwd: cache });
  }
  // Agents run inside worktrees of this repo; make any push attempt from them fail.
  await cacheGit(["git", "config", "remote.origin.pushurl", NO_PUSH], { cwd: cache });
  // Local clones mirror the source's tags, including deleted and moved ones.
  const tags = repo.kind === "local" ? ["--prune-tags", "--force"] : [];
  await cacheGit(["git", "fetch", "origin", "--prune", ...tags], {
    cwd: cache,
    timeoutMs: 300_000,
    signal,
  });
  if (repo.kind === "local") {
    // Keep bare HEAD usable without retaining copied source branches. Best-effort: the recorded
    // default branch may be gone from the source while a run's explicit base branch still exists.
    await cacheGit(["git", "update-ref", "--no-deref", "HEAD", `refs/remotes/origin/${repo.defaultBranch}`], {
      cwd: cache,
      signal,
      allowFail: true,
    });
  }
  return cache;
}

/** The owning common directory also works as a git cwd for legacy linked worktrees. */
export async function worktreeOwner(path: string): Promise<string> {
  return (
    await worktreeGit(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: path,
    })
  ).stdout.trim();
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export async function createWorktree(
  paths: Paths,
  repo: Repo,
  runId: string,
  title: string,
  baseBranch: string,
  options: { cfg?: Pick<Config, "repos">; store?: Store; gh?: GhRunner } = {},
): Promise<Worktree> {
  const cache = cachePath(paths, repo);
  const path = join(paths.work, runId);
  const stored = options.store?.getRun(runId)?.branch;
  const settings = repoSettings(options.cfg ?? {}, repo.slug);
  let branch = stored ?? `limitless/${runId}-${slugify(title, 30)}`;
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  if (existsSync(path)) {
    // The actual branch also covers a restart before prepare recorded it.
    branch =
      stored ?? (await worktreeGit(["git", "symbolic-ref", "--short", "HEAD"], { cwd: path })).stdout.trim();
    // Resuming an interrupted run: reuse the worktree as-is.
    const head = await worktreeGit(["git", "rev-parse", "HEAD"], { cwd: path });
    const owner = await worktreeOwner(path);
    const base =
      repo.kind === "local" ? head : await worktreeGit(["git", "rev-parse", baseRef], { cwd: owner });
    return { path, branch, baseSha: base.stdout.trim() || head.stdout.trim() };
  }
  return withRepoLock(cache, async () => {
    if (repo.kind === "local") await refreshCache(paths, repo);
    if (!stored && settings.discreet) {
      const refs = await worktreeGit(
        ["git", "for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/origin/"],
        { cwd: cache },
      );
      const taken = new Set(refs.stdout.trim().split("\n"));
      const recorded = new Set(
        options.store
          ?.listRuns({ repoId: repo.id, limit: Number.MAX_SAFE_INTEGER })
          .filter((r) => r.id !== runId)
          .map((r) => r.branch),
      );
      const name = `${settings.branchPrefix}${slugify(title, 30)}`;
      const gh = options.gh;
      const budget = { leftMs: githubRetry.budgetMs };
      branch = "";
      // Six candidates total; historical PRs with deleted branches must not hold the lock forever.
      for (const suffix of ["", "-2", "-3", "-4", "-5", `-${randomUUID().slice(0, 8)}`]) {
        const candidate = `${name}${suffix}`;
        if (!isBranchName(candidate)) continue;
        if (
          recorded.has(candidate) ||
          taken.has(`refs/heads/${candidate}`) ||
          taken.has(`refs/remotes/origin/${candidate}`)
        )
          continue;
        try {
          if (
            repo.kind === "github" &&
            (gh
              ? await withGitHubRetry(
                  async () =>
                    (await gh(prLookup(repo, candidate).slice(1), undefined, undefined, repo.slug)) ?? "",
                  {
                    budget,
                  },
                )
              : (await remoteSh(prLookup(repo, candidate), { cwd: cache, budget }, undefined, repo.slug))
                  .stdout
            ).trim()
          )
            continue;
        } catch (cause) {
          rethrowClaimControl(cause);
          throw new Error(`Cannot allocate branch ${name}: PR lookup failed`, { cause });
        }
        branch = candidate;
        break;
      }
      if (!branch) throw new Error(`Cannot allocate valid available branch for ${name} after six candidates`);
    }
    const base = await worktreeGit(["git", "rev-parse", baseRef], { cwd: cache });
    // Hooks are blanked where a command runs. `worktree add` would check out inside the new
    // worktree, where includes conditional on its branch or git directory can first activate
    // hooks; checking out from there instead lets the wrapper see exactly those.
    await cacheGit(["git", "worktree", "add", "--no-checkout", "-b", branch, path, base.stdout.trim()], {
      cwd: cache,
    });
    await recordWorktree(path);
    await worktreeGit(["git", "reset", "--hard", "-q"], { cwd: path });
    return { path, branch, baseSha: base.stdout.trim() };
  });
}

export async function removeWorktree(paths: Paths, repo: Repo, path: string): Promise<void> {
  if (!existsSync(path)) return;
  // The common repository is factory/user-owned; agents write only the linked checkout.
  const git = repo.kind === "github" ? cacheGit : sh;
  const cache = repo.kind === "local" ? await worktreeOwner(path) : cachePath(paths, repo);
  await withRepoLock(cache, () =>
    git(["git", "worktree", "remove", "--force", path], { cwd: cache, allowFail: true }),
  );
  rmSync(`${resolve(path)}.git-paths`, { force: true });
}

export async function headSha(cwd: string): Promise<string> {
  return (await worktreeGit(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
}

export async function fetchBase(
  paths: Paths,
  repo: Repo,
  branch: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
): Promise<string> {
  const cache = cachePath(paths, repo);
  return withRepoLock(cache, async () => {
    const ref = `refs/heads/${branch}`;
    await remoteSh(
      [
        "git",
        "fetch",
        repo.kind === "github" ? (repo.url ?? "origin") : "origin",
        `+${ref}:refs/remotes/origin/${branch}`,
      ],
      {
        cwd: cache,
        timeoutMs: 300_000,
        signal,
        budget,
      },
    );
    return (
      await worktreeGit(["git", "rev-parse", `refs/remotes/origin/${branch}`], { cwd: cache, signal })
    ).stdout.trim();
  });
}

export async function readFileAt(
  cwd: string,
  revision: string,
  path: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const entry = await worktreeGit(["git", "ls-tree", "--name-only", revision, "--", path], { cwd, env });
  if (!entry.stdout.trim()) return null;
  return (await worktreeGit(["git", "show", `${revision}:${path}`], { cwd, env })).stdout;
}

/** Extract the files of `sha` (no .git, no history, no working state) into the empty directory `dest`. */
export async function exportCommit(
  cwd: string,
  sha: string,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  // `git archive` honours export-ignore and would drop committed files; a private index checks out
  // exactly the commit's tracked files without touching the worktree's own index.
  await withScratch(cwd, async (scratch) => {
    const env = {
      ...(process.env as Record<string, string>),
      GIT_INDEX_FILE: join(scratch, "index"),
    };
    await worktreeGit(["git", "read-tree", `${sha}^{tree}`], { cwd, env, signal, timeoutMs: 300_000 });
    await worktreeGit(["git", "checkout-index", "--all", `--prefix=${dest}/`], {
      cwd,
      env,
      additionalWriteRoots: [dest],
      signal,
      timeoutMs: 300_000,
    });
  });
}

/** The tree commitAll would produce, without changing HEAD, the index or working files. */
export async function snapshotTree(cwd: string, signal?: AbortSignal): Promise<string> {
  return withScratch(cwd, async (scratch) => {
    const opts = { cwd, signal, env: { ...process.env, GIT_INDEX_FILE: join(scratch, "index") } };
    await worktreeGit(["git", "read-tree", "HEAD"], opts);
    await stageAll(opts);
    return (await worktreeGit(["git", "write-tree"], opts)).stdout.trim();
  });
}

/** Independent Git history/index for gate checks; no refs, index or admin paths are shared. */
export async function exportGateSnapshot(
  cwd: string,
  tree: string,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  const opts = { cwd, signal };
  const format = await worktreeGit(["git", "rev-parse", "--show-object-format"], opts);
  // Recognizable metadata lets hardening discover conditional hooks before init can run them.
  for (const dir of ["objects", "refs"]) mkdirSync(join(dest, ".git", dir), { recursive: true });
  writeFileSync(join(dest, ".git/HEAD"), "ref: refs/heads/snapshot\n");
  await cacheGit(["git", "init", "-q", "--template=", `--object-format=${format.stdout.trim()}`], {
    cwd: dest,
    signal,
  });
  // A synthetic child of HEAD gives describe/log the same ancestry as the eventual round commit.
  const commit = await worktreeGit(
    [
      "git",
      "-c",
      "user.name=Limitless",
      "-c",
      "user.email=limitless@localhost",
      "commit-tree",
      tree,
      "-p",
      "HEAD",
    ],
    { ...opts, stdin: "Factory gate snapshot\n" },
  );
  const references = await worktreeGit(["git", "for-each-ref", "--format=%(objectname) %(refname)"], opts);
  const refs = references.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  // Copy objects through Git, never config, hooks, alternates or hard links to session metadata.
  await worktreeGit(["git", "pack-objects", "--revs", join(dest, ".git/objects/pack/snapshot")], {
    ...opts,
    stdin: `${commit.stdout.trim()}\n${refs.map(([sha]) => sha).join("\n")}\n`,
    additionalWriteRoots: [dest],
    timeoutMs: 300_000,
  });
  await worktreeGit(["git", "update-ref", "--no-deref", "HEAD", commit.stdout.trim()], { cwd: dest, signal });
  if (refs.length)
    await worktreeGit(["git", "update-ref", "--stdin"], {
      cwd: dest,
      signal,
      stdin: refs.map(([sha, ref]) => `update ${ref} ${sha}\n`).join(""),
    });
  await exportCommit(cwd, tree, dest, signal);
  await worktreeGit(["git", "read-tree", tree], { cwd: dest, signal });
}

/** A detached checkout of `sha` at `dest` sharing `cwd`'s repository, for readers kept off the worktree. */
export async function addDetachedWorktree(cwd: string, sha: string, dest: string, signal?: AbortSignal) {
  await cacheGit(["git", "worktree", "add", "--no-checkout", "--detach", dest, sha], {
    cwd: await worktreeOwner(cwd),
    signal,
    timeoutMs: 300_000,
  });
  await recordWorktree(dest);
  await worktreeGit(["git", "reset", "--hard", "-q", sha], { cwd: dest, signal });
}

export async function mergeBase(cwd: string, base: string, head: string): Promise<string> {
  return (await worktreeGit(["git", "merge-base", base, head], { cwd })).stdout.trim();
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await worktreeGit(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    allowFail: true,
  });
  return result.exitCode === 0;
}

export async function rebaseOnto(
  cwd: string,
  baseSha: string,
  identity: CommitIdentity = "factory",
): Promise<"clean" | "conflict"> {
  const result = await mergeGit(cwd, ["rebase", baseSha], true, undefined, identity);
  if (result.exitCode === 0) return "clean";
  const state = await worktreeGit(["git", "rev-parse", "--git-path", "rebase-merge"], { cwd });
  const apply = await worktreeGit(["git", "rev-parse", "--git-path", "rebase-apply"], { cwd });
  if (!existsSync(resolve(cwd, state.stdout.trim())) && !existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error(`rebase failed: ${result.stderr || result.stdout}`);
  await worktreeGit(["git", "rebase", "--abort"], { cwd });
  if (existsSync(resolve(cwd, state.stdout.trim())) || existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error("rebase abort left worktree in rebase state");
  return "conflict";
}

export async function clearInterruptedRebase(cwd: string, expected: boolean): Promise<void> {
  const state = await worktreeGit(["git", "rev-parse", "--git-path", "rebase-merge"], { cwd });
  const apply = await worktreeGit(["git", "rev-parse", "--git-path", "rebase-apply"], { cwd });
  if (!existsSync(resolve(cwd, state.stdout.trim())) && !existsSync(resolve(cwd, apply.stdout.trim())))
    return;
  if (!expected) throw new Error("worktree has an unexpected rebase in progress");
  await worktreeGit(["git", "rebase", "--abort"], { cwd });
  if (existsSync(resolve(cwd, state.stdout.trim())) || existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error("interrupted rebase could not be aborted");
}

/**
 * The commit unpublished iteration history builds on: the newest first-parent merge above the
 * published boundary, else the boundary. HEAD when the boundary is not its ancestor, so nothing
 * is replaced.
 */
export async function iterationBoundary(
  cwd: string,
  boundary: string,
  signal?: AbortSignal,
): Promise<string> {
  const head = await headSha(cwd);
  if (!(await isAncestor(cwd, boundary, head))) return head;
  const args = ["git", "rev-list", "--first-parent", "--merges", "-n", "1", `${boundary}..HEAD`];
  return (await worktreeGit(args, { cwd, signal })).stdout.trim() || boundary;
}

function iterationPrefix(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid iteration run id");
  return `refs/limitless/iterations/${runId}/`;
}

export async function iterationRefs(cwd: string, runId: string) {
  const result = await worktreeGit(
    ["git", "for-each-ref", "--format=%(refname) %(objectname)", iterationPrefix(runId)],
    { cwd },
  );
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = ""] = line.split(" ");
      return { ref, sha };
    });
}

export async function removeIterationRefs(paths: Paths, repo: Repo, runId: string): Promise<void> {
  const source =
    repo.kind === "local" && repo.localPath && existsSync(repo.localPath) ? repo.localPath : null;
  // The user owns the registered source, which may itself be a linked worktree without a sidecar.
  const owner =
    source &&
    (
      await sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: source })
    ).stdout.trim();
  for (const cwd of [cachePath(paths, repo), owner]) {
    if (!cwd || !existsSync(cwd)) continue;
    for (const { ref } of await iterationRefs(cwd, runId))
      await worktreeGit(["git", "update-ref", "-d", ref], { cwd });
  }
}

/** Commit everything. With a boundary, replace the iteration history above it with one commit. */
export async function commitAll(
  cwd: string,
  message: string,
  options: {
    env?: Record<string, string>;
    signal?: AbortSignal;
    verbatim?: boolean;
    boundary?: string;
    runId?: string;
  } = {},
): Promise<string | null> {
  const opts = { cwd, env: options.env, signal: options.signal };
  if (worktreeGitScope.getStore() !== false) {
    const index = await worktreeGit(["git", "rev-parse", "--git-path", "index"], opts);
    rmSync(resolve(cwd, index.stdout.trim()), { force: true });
    await worktreeGit(["git", "read-tree", "HEAD"], opts);
  }
  await stageAll(opts);
  const status = await worktreeGit(["git", "status", "--porcelain"], opts);
  const head = options.boundary ? await headSha(cwd) : "";
  const parent = options.boundary ? await iterationBoundary(cwd, options.boundary, options.signal) : head;
  if (head !== parent) {
    const parents = await worktreeGit(["git", "rev-list", "--parents", "-n", "1", head], opts);
    // An unchanged iteration, or a restart after the update below, reuses the existing commit.
    if (!status.stdout.trim() && parents.stdout.trim() === `${head} ${parent}`) return null;
    if (!options.runId) throw new Error("Missing iteration run id");
    const prefix = iterationPrefix(options.runId);
    const history = await worktreeGit(["git", "rev-list", `${parent}..${head}`], opts);
    // Keep every replaced SHA before HEAD moves, including legacy intermediate iterations.
    for (const sha of history.stdout.trim().split("\n").filter(Boolean))
      await worktreeGit(["git", "update-ref", `${prefix}${sha}`, sha], opts);
    const tree = (await worktreeGit(["git", "write-tree"], opts)).stdout.trim();
    const sha = (
      await worktreeGit(["git", "commit-tree", tree, "-p", parent, "-m", message], opts)
    ).stdout.trim();
    // One atomic ref update, so a restart sees either the old history or the replacement.
    await worktreeGit(["git", "update-ref", "HEAD", sha, head], opts);
    return sha;
  }
  if (!status.stdout.trim()) return null;
  await worktreeGit(
    [
      "git",
      "commit",
      "--no-verify",
      "-q",
      ...(options.verbatim ? ["--cleanup=verbatim", "-F", "-"] : ["-m", message]),
    ],
    { ...opts, ...(options.verbatim ? { stdin: message } : {}) },
  );
  return headSha(cwd);
}

/** Fetch and verify the exact, coordinator-authored worker commit. */
export async function verifyWorkerCommit(
  paths: Paths,
  repo: Repo,
  cwd: string,
  {
    branch,
    parentSha,
    sha,
    commit,
  }: { branch: string; parentSha: string; sha: string; commit: NonNullable<AgentJobRequest["commit"]> },
  signal?: AbortSignal,
): Promise<void> {
  if ((await fetchBase(paths, repo, branch, signal)) !== sha)
    throw new Error("Worker branch tip is not the reported commit");
  const raw = await worktreeGit(["git", "--no-replace-objects", "cat-file", "commit", sha], {
    cwd,
    signal,
    encoding: "latin1",
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw.stdout, "latin1"));
  } catch {
    throw new Error("Worker commit is not valid UTF-8");
  }
  const split = text.indexOf("\n\n");
  const headers = text.slice(0, split).split("\n");
  if (
    split < 0 ||
    headers.length !== 4 ||
    !/^tree [a-f0-9]+$/.test(headers[0] ?? "") ||
    headers[1] !== `parent ${parentSha}`
  )
    throw new Error("Worker commit headers are not adoptable");
  for (const [index, field, name, email] of [
    [2, "author", commit.authorName, commit.authorEmail],
    [3, "committer", commit.committerName, commit.committerEmail],
  ] as const) {
    const identity = /^(author|committer) (.+) <([^<>]+)> -?\d+ [+-]\d{4}$/.exec(headers[index] ?? "");
    if (!identity || identity[1] !== field || identity[2] !== name || identity[3] !== email)
      throw new Error("Worker commit identity mismatch");
  }
  if (text.slice(split + 2) !== commit.message) throw new Error("Worker commit message mismatch");
}

/** Adopt only the exact, coordinator-authored shape published on the worker branch. */
export async function adoptWorkerCommit(
  paths: Paths,
  repo: Repo,
  cwd: string,
  {
    branch,
    parentSha,
    sha,
    commit,
  }: { branch: string; parentSha: string; sha: string; commit: NonNullable<AgentJobRequest["commit"]> },
  signal?: AbortSignal,
): Promise<void> {
  await verifyWorkerCommit(paths, repo, cwd, { branch, parentSha, sha, commit }, signal);
  if ((await headSha(cwd)) !== parentSha) throw new Error("Worker adoption HEAD is not parentSha");
  if (
    (await worktreeGit(["git", "status", "--porcelain", "--untracked-files=all"], { cwd, signal })).stdout !==
    ""
  )
    throw new Error("Worker adoption worktree is dirty");
  signal?.throwIfAborted();
  await worktreeGit(["git", "reset", "--hard", "-q", sha], { cwd, signal });
}

/** Move the worktree's branch back to a known commit, discarding everything after it. */
export async function resetTo(cwd: string, sha: string): Promise<void> {
  await worktreeGit(["git", "reset", "--hard", "-q", sha], { cwd });
  await worktreeGit(["git", "clean", "-fdq"], { cwd });
}

/**
 * Exactly the committed tree for gates, even when status looks clean: a fresh index drops
 * skip-worktree and assume-unchanged flags, and `-x` removes ignored payloads (including
 * info/exclude ones) along with dependencies, which gate setup installs again.
 */
export async function checkoutCommitted(
  cwd: string,
  env?: Record<string, string>,
  retryClean = false,
): Promise<void> {
  const index = await worktreeGit(["git", "rev-parse", "--git-path", "index"], { cwd, env });
  rmSync(resolve(cwd, index.stdout.trim()), { force: true });
  await worktreeGit(["git", "reset", "--hard", "-q", "HEAD"], { cwd, env });
  await worktreeGit(["git", "clean", "-ffdxq"], { cwd, env }, retryClean);
}

/** Throw away any uncommitted changes (used after read-only stages). */
/** `env` matters when the checkout's git config is untrusted: filters and drivers run with it. */
export async function discardChanges(cwd: string, env?: Record<string, string>): Promise<boolean> {
  // Parallel panel finders inspect the same Git admin directory. An optional status refresh
  // races those checks with transient index locks/hard links; read the index without updating it.
  const status = await worktreeGit(["git", "--no-optional-locks", "status", "--porcelain"], { cwd, env });
  if (!status.stdout.trim()) return false;
  await worktreeGit(["git", "reset", "--hard", "-q", "HEAD"], { cwd, env });
  await worktreeGit(["git", "clean", "-fdq"], { cwd, env });
  return true;
}

export interface DiffFile {
  status: string; // git name-status code: A, M, D, R100, C75, ...
  path: string; // new path
  from?: string; // old path for renames/copies
}

export interface DiffInfo {
  patch: string;
  /** Private-string entries found in changed content the patch shows as binary. */
  privateHits?: { path: string; entry: number }[];
  files: DiffFile[];
  stat: string;
  added: number;
  removed: number;
  gitlinks?: string[];
  attributePatch?: string;
  /** Text paths each exemptable attribute rule matches at base or head, keyed by rule. */
  attributeMatches?: Record<string, string[]>;
  /** Effective attributes of every changed path at base and head. */
  attributes?: { path: string; base: Record<string, string>; head: Record<string, string> }[];
  /** Newly hidden changed paths that are text at base or head. */
  textPaths?: string[];
  attributeErrors?: string[];
  binaryPaths?: string[];
  binaryErrors?: string[];
  headTextPaths?: string[];
  headTextSizes?: Record<string, number>;
  baseHiddenDirs?: string[];
  existingRuleKeys?: Record<string, string[]>;
  attributeUnmatched?: string[];
}

/** Text a reviewer can read in a diff: strict UTF-8 without control bytes beyond whitespace. */
function reviewableText(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const byte of bytes)
    if (byte === 0x7f || (byte < 0x20 && ![9, 10, 12, 13].includes(byte))) return false;
  return true;
}

export async function diffSince(
  cwd: string,
  baseSha: string,
  env?: Record<string, string>,
  threeDot = false,
  privateStrings: PrivateStrings = [],
): Promise<DiffInfo> {
  const range = `${baseSha}${threeDot ? "..." : ".."}HEAD`;
  // Committed .gitmodules settings must not hide gitlinks from audit inputs.
  const diff = (...args: string[]) =>
    worktreeGit(["git", "diff", "--ignore-submodules=none", ...args], { cwd, env });
  const [patch, names, stat, numstat, raw] = await Promise.all([
    diff(range),
    diff("--name-status", "-M", range),
    diff("--stat", range),
    diff("--numstat", range),
    diff("--raw", "-z", "--no-renames", "--no-abbrev", range),
  ]);
  let added = 0;
  let removed = 0;
  for (const line of numstat.stdout.split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  const files = parseNameStatus(names.stdout);
  const gitlinks: string[] = [];
  const blobs = new Map<string, string>();
  const origins = new Map(files.map((file) => [file.path, file.from]));
  const changes: { path: string; from?: string; modeRequiresAllowance: boolean }[] = [];
  const entries = raw.stdout.split("\0");
  // The raw diff has no renames: a rename's source is a deletion carrying the original mode.
  const deletedModes = new Map<string, string>();
  for (let i = 0; i + 1 < entries.length; i += 2)
    if (entries[i]?.split(" ").at(-1)?.startsWith("D"))
      deletedModes.set(entries[i + 1] ?? "", entries[i]?.split(" ")[0] ?? "");
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [rawOldMode, newMode] = entries[i]?.split(" ") ?? [];
    if (entries[i]?.split(" ")[1] === "160000") gitlinks.push(entries[i + 1] ?? "");
    const status = entries[i]?.split(" ").at(-1) ?? "";
    const path = entries[i + 1] ?? "";
    if (status.startsWith("D")) continue;
    blobs.set(path, entries[i]?.split(" ")[3] ?? "");
    const from = origins.get(path);
    const oldMode = (from && from !== path ? deletedModes.get(from) : undefined) ?? rawOldMode;
    changes.push({
      path,
      ...(from ? { from } : status.startsWith("A") ? {} : { from: path }),
      // Any executable bit, and any mode transition of an existing path (gaining or losing it).
      modeRequiresAllowance: newMode === "100755" || (oldMode !== ":000000" && oldMode !== `:${newMode}`),
    });
  }
  const revision = threeDot ? await mergeBase(cwd, baseSha, "HEAD") : baseSha;
  // Most rounds add no hidden paths; avoid another tree walk on every ordinary audit.
  const tree = files.some((f) => f.status.startsWith("A") && /^\.(?!github\/)[^/]+\//.test(f.path))
    ? await worktreeGit(["git", "ls-tree", "-r", "--name-only", "-z", revision], { cwd, env })
    : { stdout: "" };
  const baseHiddenDirs = [
    ...new Set(tree.stdout.split("\0").flatMap((path) => path.match(/^(\.[^/]+)\//)?.[1] ?? [])),
  ];
  const inspection = await attributeInfo(cwd, env, range, revision, changes);
  const privateHits: { path: string; entry: number }[] = [];
  if (privateStrings.length) {
    // Binary content is absent from the patch; stream each blob rather than forcing a text diff.
    const ids = [...blobs].filter(([path]) => !gitlinks.includes(path)).map(([, oid]) => oid);
    const hits = await blobPrivateEntries(cwd, env, ids, privateStrings);
    const numstatZ = await diff("--numstat", "-z", "--no-renames", range);
    for (const line of numstatZ.stdout.split("\0")) {
      const path = line.match(/^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/)?.[1];
      const blob = path === undefined ? undefined : blobs.get(path);
      if (path !== undefined && blob && !/^0+$/.test(blob))
        for (const entry of hits.filter(([id]) => id === blob).map(([, entry]) => entry))
          privateHits.push({ path, entry });
    }
  }
  return {
    patch: patch.stdout,
    files,
    stat: stat.stdout,
    added,
    removed,
    gitlinks,
    privateHits,
    baseHiddenDirs,
    ...inspection,
  };
}

export async function blobPrivateEntries(
  cwd: string,
  env: Record<string, string> | undefined,
  blobs: string[],
  privateStrings: PrivateStrings,
): Promise<[string, number][]> {
  const ids = [...new Set(blobs.filter((id) => !/^0*$/.test(id)))];
  // Inspect the object that will be published, never a local replacement.
  const batch = ["git", "--no-replace-objects", "cat-file", "--batch"];
  const opts = { cwd, env, stdin: ids.map((id) => `${id}\n`).join(""), timeoutMs: attributeLimits.timeoutMs };
  const { stdout } = await worktreeGit(batch, { ...opts, encoding: "latin1" });
  const decoder = new TextDecoder();
  const found: [string, number][] = [];
  let at = 0;
  for (const id of ids) {
    const end = stdout.indexOf("\n", at);
    const header = stdout.slice(at, end);
    const size = Number(/ blob (\d+)$/.exec(header)?.[1]);
    if (end < 0 || header !== `${id} blob ${size}` || stdout[end + size + 1] !== "\n")
      throw new privacy.PrivateError("Cannot inspect binary blob; publication blocked");
    const text = decoder.decode(Buffer.from(stdout.slice(end + 1, end + 1 + size), "latin1"));
    at = end + size + 2;
    const lfs = lfsPointer(text);
    const content = lfs ? text + (await lfsPayload(cwd, env, lfs)) : text.includes("\0") ? text : "";
    for (const { entry } of privacy.privateMatches(content, privateStrings)) found.push([id, entry]);
  }
  return [...found];
}

/** The local payload of an LFS pointer. Payloads are never fetched, so a missing one blocks. */
async function lfsPayload(cwd: string, env: Record<string, string> | undefined, pointer: string) {
  const bytes = await localLfsPayload(cwd, env, pointer);
  if (bytes) return bytes.toString("utf8");
  throw new privacy.PrivateError("Cannot inspect local LFS payload; publication blocked");
}

async function localLfsPayload(cwd: string, env: Record<string, string> | undefined, pointer: string) {
  const oid = pointer.match(/^oid sha256:([a-f0-9]{64})$/m)?.[1] ?? "";
  const common = await worktreeGit(["git", "rev-parse", "--git-common-dir"], { cwd, env });
  const path = resolve(cwd, common.stdout.trim(), "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  const stat = await fs.promises.stat(path).catch(() => undefined);
  if (!stat?.isFile() || stat.size !== Number(pointer.match(/^size (\d+)$/m)?.[1])) return undefined;
  const bytes = await fs.promises.readFile(path).catch(() => undefined);
  if (bytes && pointer.endsWith(`oid sha256:${Bun.SHA256.hash(bytes, "hex")}\nsize ${bytes.length}\n`))
    return bytes;
  return undefined;
}

/** Fixed diagnostic limits; the aggregate refusal remains authoritative on exhaustion. */
export const publicationDiagnosisLimits = { steps: 1_000, bytes: 8 * 1024 * 1024, timeoutMs: 5_000 };

/** Inspect only the commits and squash content this step publishes. */
export async function checkPrivatePublication(
  cwd: string,
  entries: PrivateStrings,
  input: {
    commits?: string;
    squash?: { base: string; head: string; title: string; body: string };
    staged?: boolean;
  },
) {
  const { commits: range, squash, staged } = input;
  let revisions: string[] = [];
  if (squash) checkPublicationText(`${squash.title}\n${squash.body}`, "PR text", entries);
  const log = [
    "git",
    "--no-replace-objects",
    "-c",
    "i18n.logOutputEncoding=UTF-8",
    "log",
    "--encoding=UTF-8",
  ];
  if (range) {
    const identities = await worktreeGit([...log, "-z", "--format=%an%x00%ae%x00%cn%x00%ce", range], {
      cwd,
    });
    const fields = ["author name", "author email", "committer name", "committer email"];
    identities.stdout.split("\0").forEach((value, i) => {
      checkPublicationText(value, `Published commit ${fields[i % 4]}`, entries);
    });
    const commits = await worktreeGit(["git", "--no-replace-objects", "rev-list", "--reverse", range], {
      cwd,
    });
    revisions = commits.stdout.trim().split("\n").filter(Boolean);
    for (const sha of revisions) {
      const raw = await worktreeGit(["git", "--no-replace-objects", "cat-file", "commit", sha], {
        cwd,
        encoding: "latin1",
      });
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw.stdout, "latin1"));
      } catch {
        throw new privacy.PrivateError("Published commit is not valid UTF-8; publication blocked");
      }
      const headers = text.slice(0, text.indexOf("\n\n"));
      if ([...headers.matchAll(/^encoding (.*)$/gm)].some((match) => !/^UTF-8$/i.test(match[1] ?? "")))
        throw new privacy.PrivateError("Published commit encoding must be UTF-8; publication blocked");
      checkPublicationText(text, `Published commit object ${sha}`, entries);
    }
  }
  const flags = "--raw -z --no-abbrev --full-index -p --text --no-renames -U0 --ignore-submodules=none".split(
    " ",
  );
  const diagnose = async (error: unknown, blob?: [string, number]): Promise<never> => {
    // Keep the aggregate scan authoritative; recover file context only after a decoding refusal.
    if (!blob && (error as Error).message !== privacy.privateReason("Published content", 0)) throw error;
    let refusal = error;
    let { steps, bytes } = publicationDiagnosisLimits;
    const deadline = Date.now() + publicationDiagnosisLimits.timeoutMs;
    const spend = () => {
      if (--steps < 0 || Date.now() >= deadline) throw error;
    };
    const protectedNames = [...entries, ...registeredCredentials().map((value) => ({ value, entry: 1 }))];
    const name = (path: string) => {
      path = stripVTControlCharacters(path);
      try {
        checkPublicationText(path, "filename", protectedNames);
        return privacy.redactPrivate(redactCredentials(path), entries);
      } catch {
        return "[redacted filename]";
      }
    };
    const refuse = (location: string, path: string, entry: number): never => {
      const filename = name(path);
      spend();
      refusal = new privacy.PrivateError(privacy.privateReason(`${location}: ${filename}`, entry));
      throw refusal;
    };
    const pair = (from = "", to = "") => `${from.replace(/^0+$/, "0")}:${to.replace(/^0+$/, "0")}`;
    function* contexts() {
      for (const sha of revisions)
        yield [`Published commit ${sha}`, [...log, "-m", "--no-walk", "--format=", sha]] as const;
      if (squash)
        yield [
          `Published revision ${squash.head}`,
          ["git", "diff", `${squash.base}..${squash.head}`],
        ] as const;
      if (staged) yield ["Published staged content", ["git", "diff", "--cached"]] as const;
    }
    try {
      for (const [location, args] of contexts()) {
        spend();
        // One U0 patch per revision excludes unchanged blob content from diagnosis.
        const { stdout } = await worktreeGit([...args, ...flags], {
          cwd,
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        bytes -= Buffer.byteLength(stdout);
        if (bytes < 0) throw error;
        const paths = new Map<string, { files: string[]; next: number }>();
        for (const match of stdout.matchAll(/:\d+ \d+ (\w+) (\w+) [A-Z]\0([^\0]+)\0/g)) {
          spend();
          const path = match[3] ?? "";
          const key = pair(match[1], match[2]);
          const group = paths.get(key) ?? { files: [], next: 0 };
          group.files.push(path);
          paths.set(key, group);
          if (blob && match[2] === blob[0]) refuse(location, path, blob[1]);
        }
        for (const section of blob ? [] : stdout.split(/(?<=[\n\0])(?=diff --git )/).slice(1)) {
          spend();
          const ids = /^index (\w+)\.\.(\w+)/m.exec(section);
          const group = ids && paths.get(pair(ids[1], ids[2]));
          const path = group?.files[group.next++];
          if (path) {
            try {
              checkPublicationText(section, "section", []);
            } catch {
              refuse(location, path, 0);
            }
          }
        }
      }
    } catch {
      // Attribution is best effort; command failures and exhausted budgets keep the original refusal.
    }
    throw refusal;
  };
  const blobs: string[] = [];
  for (const args of [
    ...(range ? [[...log, "-m", "--format=%B", range]] : []),
    ...(squash ? [["git", "diff", `${squash.base}..${squash.head}`]] : []),
    ...(staged ? [["git", "diff", "--cached"]] : []),
  ]) {
    const { stdout } = await worktreeGit([...args, ...flags], { cwd });
    try {
      checkPublicationText(stdout, "Published content", entries);
    } catch (error) {
      await diagnose(error);
    }
    for (const match of stdout.matchAll(/:\d+ (?!160000)\d+ \w+ (\w+) [A-Z]\0/g)) blobs.push(match[1] ?? "");
  }
  const hit = (await blobPrivateEntries(cwd, undefined, blobs, entries))[0];
  if (hit) await diagnose(new privacy.PrivateError(privacy.privateReason("Published blob", hit[1])), hit);
}

/** Checks raw commits and patches (and optionally the index), not the net diff. */
export async function checkPrivateRange(cwd: string, range: string, entries: PrivateStrings, staged = false) {
  await checkPrivatePublication(cwd, entries, { commits: range, staged });
}

export function squashTitle(title: string, pr: string): string {
  const number = pr.match(/(?:\/pull\/|^)(\d+)$/)?.[1];
  return number ? `${title} (#${number})` : title;
}

/** A missing remote branch or a rewrite publishes the full branch range again. */
export async function publicationRange(
  cwd: string,
  base: string,
  head: string,
  remoteHead: string | null,
): Promise<string> {
  if (remoteHead) {
    await worktreeGit(["git", "cat-file", "-e", `${remoteHead}^{commit}`], { cwd });
    const ancestry = await worktreeGit(["git", "merge-base", "--is-ancestor", remoteHead, head], {
      cwd,
      allowFail: true,
    });
    if (ancestry.exitCode === 0) return `${remoteHead}..${head}`;
    if (ancestry.exitCode !== 1)
      throw new privacy.PrivateError("Cannot inspect remote ancestry; publication blocked");
  }
  return `${base}..${head}`;
}

export async function deliveryPublicationRange(
  repo: Repo,
  cwd: string,
  branch: string,
  base: string,
  head: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
  discreet?: { runId: string; published: boolean },
): Promise<string> {
  const url = repo.kind === "local" ? repo.localPath : repo.url;
  if (!url) throw new privacy.PrivateError("Cannot inspect destination branch; publication blocked");
  const opts = { cwd, signal, budget };
  const marked = discreet && checkDiscreetBranch(branch, discreet.runId, true);
  const remote = await remoteSh(["git", "ls-remote", url, `refs/heads/${branch}`], opts).catch((error) => {
    rethrowClaimControl(error);
    if (marked && !signal?.aborted)
      throw new DiscreetError("Discreet mode cannot establish branch-name publication status");
    throw error;
  });
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] || null;
  if (marked && remoteHead && remote.stdout.trim() !== `${remoteHead}\trefs/heads/${branch}`)
    throw new DiscreetError("Discreet mode cannot establish branch-name publication status");
  if (discreet) checkDiscreetBranch(branch, discreet.runId, !!remoteHead || discreet.published);
  if (remoteHead) {
    if (!/^[a-f0-9]{40,64}$/.test(remoteHead)) throw new privacy.PrivateError("Cannot inspect remote head");
    // An unknown object is not evidence of a rewrite; fetch it before deciding ancestry.
    const object = await worktreeGit(["git", "cat-file", "-e", `${remoteHead}^{commit}`], {
      cwd,
      signal,
      allowFail: true,
    });
    if (object.exitCode !== 0) await remoteSh(["git", "fetch", "--no-tags", url, remoteHead], opts);
  }
  return publicationRange(cwd, base, head, remoteHead);
}

function lfsPointer(text: string): string | null {
  const normalized = text.trim().replaceAll("\r\n", "\n").replaceAll(/\n\n+/g, "\n");
  if (!/^(?:version https?:|oid sha256:|ext-\d-)/.test(normalized)) return null;
  const extensions = normalized.match(/^ext-.*$/gm) ?? [];
  const priorities = extensions.map((line) => line.slice(4, 5));
  const validExtensions = extensions.every((line) => /^ext-\d-\w[^ ]* sha256:[a-f0-9]{64}$/.test(line));
  const core = normalized.replaceAll(/^ext-.*\n/gm, "");
  const match =
    /^version (?:https:\/\/(?:git-lfs|hawser)\.github\.com\/spec\/v1|http:\/\/git-media\.io\/v\/2)\noid sha256:([a-f0-9]{64})\nsize (\+?\d+)$/.exec(
      core,
    );
  if (
    !match?.[1] ||
    !Number.isSafeInteger(Number(match[2])) ||
    !validExtensions ||
    new Set(priorities).size !== priorities.length ||
    /\nsize [^\n]+\n/.test(normalized)
  )
    throw new privacy.PrivateError("Malformed LFS pointer; publication blocked");
  return `oid sha256:${match[1]}\nsize ${Number(match[2])}\n`;
}
/** Deadline for attribute queries and content classification; missing it blocks the audit. */
export const attributeLimits = { timeoutMs: 60_000 };

async function attributeInfo(
  cwd: string,
  env: Record<string, string> | undefined,
  range: string,
  base: string,
  changes: { path: string; from?: string; modeRequiresAllowance: boolean }[],
): Promise<Partial<DiffInfo>> {
  // Attribute files must be inspected even if binary or renamed into place.
  const pathspecs = [":(icase).gitattributes", ":(icase)**/.gitattributes"];
  const attributePatch = (
    await worktreeGit(["git", "diff", "--text", "--no-renames", range, "--", ...pathspecs], { cwd, env })
  ).stdout;
  const timeoutMs = attributeLimits.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const git = (args: string[], stdin?: string) =>
    worktreeGit(["git", ...args], { cwd, env, timeoutMs: Math.max(1, deadline - Date.now()), stdin });
  const attributesAt = async (tree: string, paths: string[]) => {
    if (!paths.length) return new Map<string, Record<string, string>>();
    const names = ["diff", "binary", "text", "filter", "merge", "linguist-generated"];
    const query = await git(["check-attr", `--source=${tree}`, "-z", "--stdin", ...names], paths.join("\0"));
    const out = query.stdout.split("\0");
    const result = new Map<string, Record<string, string>>();
    for (let i = 0; i + 2 < out.length; i += 3) {
      const path = out[i] ?? "";
      result.set(path, { ...result.get(path), [out[i + 1] ?? ""]: out[i + 2] ?? "" });
    }
    return result;
  };
  // Git supplies an initial classification; verify apparent text across the complete blob.
  // The empty attribute source prevents repository attributes from deciding what is text.
  // The empty tree's id depends on the repository's object format (SHA-1 or SHA-256).
  let emptyTree: Promise<string> | undefined;
  const emptyTreeOf = () =>
    (emptyTree ??= emptyTreeId({ cwd, env, timeoutMs: Math.max(1, deadline - Date.now()) }));
  const matches = new Set<string>();
  const headPointers = new Map<string, string>();
  const contents = new Map<
    string,
    { pointer: string | null; forbidden: boolean; binary: boolean; reviewable: boolean; size: number }
  >();
  const scratch = mkdtempSync(join(tmpdir(), "limitless-classify-"));
  let indexes = 0;
  const scratchGit = (args: string[], stdin?: string, index = join(scratch, "index")) =>
    worktreeGit(["git", `--git-dir=${scratch}`, ...args], {
      cwd: scratch,
      env: { ...(env ?? (process.env as Record<string, string>)), GIT_INDEX_FILE: index, GIT_WORK_TREE: cwd },
      timeoutMs: Math.max(1, deadline - Date.now()),
      stdin,
    });
  /** `raw` is every text path; `text` excludes LFS pointers standing in for binary files. */
  const textAt = async (tree: string, pathspecs: string[], seen = matches) => {
    const raw = new Set<string>();
    const blobs = new Map<string, string>();
    if (!pathspecs.length) return { raw, text: raw, blobs };
    const empty = await emptyTreeOf();
    // A fresh index per query lets classifications run concurrently.
    const index = join(scratch, `index-${indexes++}`);
    const specs = `${pathspecs.join("\0")}\0`;
    // --no-refresh: a refresh re-hashes worktree files, running their clean filters.
    await scratchGit(
      ["reset", "-q", "--no-refresh", tree, "--pathspec-from-file=-", "--pathspec-file-nul"],
      specs,
      index,
    );
    const flags = ["--cached", "--raw", "--numstat", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff"];
    const args = [`--attr-source=${empty}`, "-c", NO_BIG_FILES, "diff", ...flags, "--no-textconv", empty];
    const out = await scratchGit(args, undefined, index);
    rmSync(index, { force: true });
    // Raw entries (blob id, then path) precede the numstat entries. Looking blobs up by id
    // avoids a tree walk per `tree:path`, which dominates audits of many thousand files.
    const entries = out.stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const blob = entries[i]?.match(/^:\d+ (\d+) \S+ (\S+) /);
      if (blob?.[2]) {
        const path = entries[++i] ?? "";
        // Gitlinks name commits in another repository, not blobs we can inspect here.
        if (blob[1] !== "160000") blobs.set(path, blob[2]);
        continue;
      }
      const match = entries[i]?.match(/^(\d+|-)\t(?:\d+|-)\t([\s\S]+)$/);
      if (match?.[2] && blobs.has(match[2])) {
        seen.add(match[2]);
        if (match[1] !== "-") raw.add(match[2]);
      }
    }
    // Inspect bytes with length framing: a blob may contain embedded NULs or multi-byte text.
    const candidates = [...raw];
    const input = candidates.map((path) => `${blobs.get(path)}\n`).join("");
    const sizes = candidates.length
      ? (await git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], input)).stdout.split("\n")
      : [];
    const sized = candidates.map((path, i) => {
      const [oid = "", bytes] = (sizes[i] ?? "").split(" ");
      const size = Number(bytes);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Cannot inspect blob size");
      return { path, oid, size };
    });
    const unread = [...new Map(sized.map((entry) => [entry.oid, entry])).values()].filter(
      ({ oid }) => !contents.has(oid),
    );
    while (unread.length) {
      const batch = [];
      let bytes = 0;
      do {
        const next = unread.shift();
        if (!next) break;
        batch.push(next);
        bytes += next.size;
      } while (unread.length && bytes + (unread[0]?.size ?? 0) < MEDIA_LIMIT);
      const result = await worktreeGit(["git", "cat-file", "--batch", "-Z"], {
        cwd,
        env,
        encoding: "latin1",
        stdin: batch.map(({ oid }) => `${oid}\0`).join(""),
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      let at = 0;
      for (const { oid, size } of batch) {
        const end = result.stdout.indexOf("\0", at);
        if (result.stdout.slice(at, end) !== `${oid} blob ${size}` || result.stdout[end + size + 1] !== "\0")
          throw new Error("Cannot inspect complete blob");
        const bytes = Buffer.from(result.stdout.slice(end + 1, end + 1 + size), "latin1");
        contents.set(oid, {
          size,
          pointer: size < 1024 ? lfsPointer(bytes.toString("utf8")) : null,
          forbidden: isForbiddenFormat("", bytes),
          // Hex avoids classifying this source as the PDF signature it detects.
          binary: bytes.includes(0) || bytes.includes(Buffer.from("255044462d", "hex")),
          reviewable: reviewableText(bytes),
        });
        at = end + size + 2;
      }
      if (at !== result.stdout.length) throw new Error("Unexpected blob batch output");
    }
    for (const { path, oid } of sized) {
      if (contents.get(oid)?.forbidden || contents.get(oid)?.binary || /\.pdf$/i.test(path)) raw.delete(path);
    }
    const text = new Set(raw);
    for (const { path, oid } of sized) {
      const pointer = contents.get(oid)?.pointer;
      if (pointer) {
        if (tree === "HEAD") headPointers.set(path, pointer);
        if (!SOURCE_PATH.test(path)) text.delete(path);
      }
    }
    return { raw, text, blobs };
  };
  const textAtEither = async (pathspecs: string[], seen: Set<string>) => {
    const [before, after] = await Promise.all([
      textAt(base, pathspecs, seen),
      textAt("HEAD", pathspecs, seen),
    ]);
    return [...new Set([...before.text, ...after.text])];
  };
  try {
    mkdirSync(join(scratch, "refs"));
    const [head, objectsPath] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--git-path", "objects"]),
      emptyTreeOf(),
    ]);
    writeFileSync(join(scratch, "HEAD"), head.stdout);
    const objects = resolve(cwd, objectsPath.stdout.trim());
    mkdirSync(join(scratch, "objects", "info"), { recursive: true });
    writeFileSync(join(scratch, "objects", "info", "alternates"), `${objects}\n`);
    writeFileSync(
      join(scratch, "config"),
      `[core]\nattributesFile = /dev/null\nrepositoryformatversion = 1\n[extensions]\nobjectformat = ${base.length === 64 ? "sha256" : "sha1"}\n`,
    );
    // Attributes of a path edited in place only differ when an attribute file changed too.
    const queried = attributePatch ? changes : changes.filter((change) => change.from !== change.path);
    const literal = (paths: (string | undefined)[]) =>
      paths.flatMap((p) => (p === undefined ? [] : [`:(literal)${p}`]));
    const rules = attributeRules(attributePatch).filter((rule) => rule.exemptable);
    const keys = [...new Map(rules.map((rule) => [rule.key, rule.pathspec])).entries()];
    // Independent queries run concurrently; each classification uses its own scratch index.
    // Compare the same head path in both trees, even when that path did not exist at base.
    const sources = queried.map((change) => change.path);
    const audit = ["diff", "--ignore-submodules=none", "--no-ext-diff", "--no-textconv", range];
    const [before, after, beforeText, afterText, found, patch] = await Promise.all([
      attributesAt(base, [...new Set(sources)]),
      attributesAt("HEAD", sources),
      textAt(base, literal(changes.map((c) => c.from))),
      textAt("HEAD", literal(changes.map((c) => c.path))),
      Promise.all(
        keys.map(async ([key, pathspec]) => {
          const seen = new Set<string>();
          return { key, text: await textAtEither([pathspec], seen), seen };
        }),
      ),
      emptyTreeOf().then((empty) => scratchGit([`--attr-source=${empty}`, ...audit])),
    ]);
    const baseOf = (from?: string) => (from === undefined ? undefined : before.get(from)) ?? {};
    const attributes = queried.map(({ path }) => ({
      path,
      base: baseOf(path),
      head: after.get(path) ?? {},
    }));
    const hidden = queried.filter(({ path }) => newlyHidden(baseOf(path), after.get(path) ?? {}).length);
    const newPaths = new Set(queried.map((change) => change.path));
    const existingRules = async () => {
      if (!attributes.some(({ base }) => newlyHidden({}, base).length)) return [];
      const rulePatch = await scratchGit(["diff", "--text", await emptyTreeOf(), base, "--", ...pathspecs]);
      return Promise.all(
        attributeRules(rulePatch.stdout).map(async (rule) => ({
          label: `${rule.file}: ${rule.pattern} ${rule.attributes}`,
          paths: (await textAt("HEAD", [rule.pathspec], new Set())).raw,
        })),
      );
    };
    const existing = await existingRules();
    const inert = new Set<string>();
    const eligible = changes.filter(
      ({ path, from }) =>
        matches.has(path) &&
        (!afterText.raw.has(path) || headPointers.has(path)) &&
        INERT_MEDIA_PATH.test(path) &&
        !beforeText.text.has(from ?? ""),
    );
    for (const { path } of eligible) {
      const pointer = headPointers.get(path);
      if (pointer) {
        const size = Number(pointer.match(/^size (\d+)$/m)?.[1]);
        if (size > 0 && size <= MEDIA_LIMIT) {
          const bytes = await localLfsPayload(cwd, env, pointer);
          if (bytes && isInertMedia(path, bytes)) inert.add(path);
        }
        continue;
      }
      const oid = afterText.blobs.get(path);
      if (!oid) continue;
      const size = Number((await git(["cat-file", "-s", oid])).stdout.trim());
      // Large or unreadable media remains opaque; never validate a truncated subprocess tail.
      if (!Number.isSafeInteger(size) || size <= 0 || size > MEDIA_LIMIT) continue;
      const result = await worktreeGit(["git", "cat-file", "blob", oid], {
        cwd,
        env,
        encoding: "latin1",
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (result.stdout.length === size && isInertMedia(path, Buffer.from(result.stdout, "latin1")))
        inert.add(path);
    }
    // Hidden paths are a subset of the changes classified above.
    const textPaths = hidden
      .filter(
        ({ path, from }) => afterText.text.has(path) || (from !== undefined && beforeText.text.has(from)),
      )
      .map((change) => change.path);
    const binaryPaths = changes
      .filter(
        ({ path, from, modeRequiresAllowance }) =>
          // An executable bit or mode change needs an allowance unless the path holds plain,
          // reviewable text (a script); media and opaque bytes, NUL-free or not, still do.
          (modeRequiresAllowance &&
            (INERT_MEDIA_PATH.test(path) || !contents.get(afterText.blobs.get(path) ?? "")?.reviewable)) ||
          (matches.has(path) &&
            (!afterText.raw.has(path) || headPointers.has(path)) &&
            (beforeText.text.has(from ?? "") || !inert.has(path))),
      )
      .map((c) => c.path);
    const attributeMatches: Record<string, string[]> = {};
    const attributeUnmatched: string[] = [];
    for (const { key, text, seen } of found) {
      attributeMatches[key] = text;
      if (!seen.size) attributeUnmatched.push(key);
    }
    const existingRuleKeys: Record<string, string[]> = {};
    for (const { label, paths } of existing)
      for (const path of paths)
        if (newPaths.has(path)) existingRuleKeys[path] = [...(existingRuleKeys[path] ?? []), label];
    return {
      patch: patch.stdout,
      attributePatch,
      attributes,
      textPaths,
      headTextPaths: [...afterText.text],
      headTextSizes: Object.fromEntries(
        [...afterText.text]
          .filter((path) => contents.get(afterText.blobs.get(path) ?? "")?.reviewable)
          .map((path) => [path, contents.get(afterText.blobs.get(path) ?? "")?.size ?? 0]),
      ),
      existingRuleKeys,
      attributeMatches,
      binaryPaths,
      attributeUnmatched,
    };
  } catch (error) {
    const message = error instanceof CommandError ? error.stderr.trim() : String(error);
    const reason = Date.now() >= deadline ? `timed out after ${timeoutMs} ms` : message.split("\n")[0];
    return {
      attributePatch,
      attributeErrors: [`attribute inspection ${reason}`],
      binaryErrors: [`Binary content inspection failed: ${reason}. Content could not be classified.`],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Remove classification scratch left by a crashed audit; recent audits may still be running. */
export function sweepClassificationScratch(root = tmpdir(), now = Date.now()): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("limitless-classify-")) continue;
    try {
      const path = join(root, entry.name);
      if (fs.statSync(path).mtimeMs < now - 3_600_000) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another process removed it, or a shared temporary directory belongs to another user.
    }
  }
}

export function parseNameStatus(text: string): DiffFile[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status = "", a = "", b] = l.split("\t").map((p) => (p.startsWith('"') ? (unquote(p) ?? p) : p));
      return b !== undefined ? { status, path: b, from: a } : { status, path: a };
    });
}

/** Inspect the exact candidate independently of missing or stale round audit evidence. */
export async function assertWorkflowPublication(
  cwd: string,
  base: string,
  sha: string,
  allow: readonly AuditAllowance[] = [],
  configDir?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (allow.includes("workflows")) return;
  const names = await worktreeGit(["git", "diff", "--name-status", "--no-renames", base, sha, "--"], {
    cwd,
    signal,
  });
  const finding = auditDiff(
    { files: parseNameStatus(names.stdout), patch: "", stat: "", added: 0, removed: 0 },
    { configDir, taskClass: null, protectedPaths: [] },
  ).find((finding) => finding.rule === "ci-config");
  if (finding) throw new Error(`[ci-config] ${finding.file}: ${finding.detail}`);
}

/** Export exact commits without executing a transport in the candidate repository. */
export async function withGitBundle<T>(
  cwd: string,
  revisions: string[],
  signal: AbortSignal | undefined,
  use: (bundle: string) => Promise<T>,
  destination?: string,
): Promise<T> {
  return withScratch(cwd, async (scratch) => {
    const shallowPath = (
      await worktreeGit(["git", "rev-parse", "--git-path", "shallow"], { cwd, signal })
    ).stdout.trim();
    const boundaryFile = resolve(cwd, shallowPath);
    const boundaries = existsSync(boundaryFile)
      ? fs.readFileSync(boundaryFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const exclusions: string[] = [];
    for (const boundary of boundaries) {
      if (
        !/^[a-f0-9]{40,64}$/.test(boundary) ||
        !destination ||
        (
          await worktreeGit(["git", "cat-file", "-e", `${boundary}^{commit}`], {
            cwd: destination,
            signal,
            allowFail: true,
          })
        ).exitCode !== 0
      )
        throw new Error(`Cannot transfer shallow repository ${cwd}: destination lacks boundary history`);
      exclusions.push(`^${boundary}`);
    }
    const refs = revisions.map(() => `refs/limitless-transfer/${randomUUID()}`);
    try {
      for (const [i, ref] of refs.entries())
        await worktreeGit(["git", "update-ref", ref, revisions[i] ?? ""], { cwd, signal });
      const bundle = join(scratch, "transfer.bundle");
      try {
        await worktreeGit(["git", "bundle", "create", bundle, ...refs, ...exclusions], {
          cwd,
          signal,
          timeoutMs: 300_000,
        });
      } catch (error) {
        if (boundaries.length && error instanceof CommandError)
          throw new Error(`Cannot transfer shallow repository ${cwd}: cannot build bundle`, { cause: error });
        throw error;
      }
      return await use(bundle);
    } finally {
      for (const ref of refs) await worktreeGit(["git", "update-ref", "-d", ref], { cwd });
    }
  });
}

const BUNDLE_FETCH = [
  ...["git", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch"],
  ...["--no-tags", "--no-write-fetch-head", "--no-recurse-submodules"],
];

/**
 * Remote transport never runs in the checkout, whose config could rewrite the URL to a helper. A
 * recorded worktree's common directory is the factory cache and already holds its commits; any
 * other checkout exports `sha` through a confined bundle into a fresh factory-owned repository.
 */
async function withTransportRepo<T>(
  cwd: string,
  sha: string | null,
  signal: AbortSignal | undefined,
  use: (transport: string) => Promise<T>,
): Promise<T> {
  const record = `${resolve(cwd)}.git-paths`;
  if (existsSync(record)) {
    const [, , common] = z
      .tuple([z.string(), z.string(), z.string()])
      .parse(JSON.parse(fs.readFileSync(record, "utf8")));
    const present = ["git", "cat-file", "-e", `${sha}^{commit}`];
    if (!sha || (await cacheGit(present, { cwd: common, signal, allowFail: true })).exitCode === 0)
      return use(common);
  }
  const format = await worktreeGit(["git", "rev-parse", "--show-object-format"], { cwd, signal });
  return withScratch(cwd, async (scratch) => {
    const transport = join(scratch, "transport.git");
    const init = ["git", "init", "-q", "--bare", "--template=", `--object-format=${format.stdout.trim()}`];
    await cacheGit([...init, transport], { cwd: scratch, signal });
    if (sha)
      await withGitBundle(
        cwd,
        [sha],
        signal,
        (bundle) =>
          cacheGit([...BUNDLE_FETCH, bundle, `${sha}:refs/heads/transfer`], {
            cwd: transport,
            signal,
            timeoutMs: 300_000,
          }),
        transport,
      );
    return use(transport);
  });
}

export async function pushBranch(
  repo: Repo,
  cwd: string,
  branch: string,
  sha = "HEAD",
  signal?: AbortSignal,
  budget?: GitHubBudget,
  expected: string | null = null,
): Promise<void> {
  if (repo.kind === "local") {
    if (!repo.localPath) throw new Error("local repository path is missing");
    // Legacy worktrees already own the delivered branch in the source repository.
    if ((await worktreeOwner(cwd)) === (await worktreeOwner(repo.localPath))) return;
    // An earlier push may have landed before its delivery was recorded; the user may have built on it.
    const head = (await worktreeGit(["git", "rev-parse", `${sha}^{commit}`], { cwd, signal })).stdout.trim();
    if (await isAncestor(repo.localPath, head, `refs/heads/${branch}`)) return;
    const source = repo.localPath;
    await withGitBundle(
      cwd,
      [head],
      signal,
      async (bundle) => {
        // Bundle transport is internal to git. Fetch refuses a checked-out destination branch,
        // and the branch-only refspec transfers neither tags nor notes.
        await worktreeGit([...BUNDLE_FETCH, bundle, `${head}:refs/heads/${branch}`], {
          cwd: source,
          signal,
          timeoutMs: 300_000,
        });
      },
      source,
    );
    return;
  }
  const url = repo.url;
  if (!url) return;
  const head = (await worktreeGit(["git", "rev-parse", `${sha}^{commit}`], { cwd, signal })).stdout.trim();
  const ref = `refs/heads/${branch}`;
  try {
    await withTransportRepo(cwd, head, signal, (transport) =>
      remoteSh([...BRANCH_PUSH, `--force-with-lease=${ref}:${expected ?? ""}`, url, `${head}:${ref}`], {
        cwd: transport,
        timeoutMs: 300_000,
        signal,
        budget,
      }),
    );
  } catch (error) {
    rethrowClaimControl(error);
    if (
      (await remoteBranchSha(repo, cwd, branch, signal, budget).catch((error) => {
        rethrowClaimControl(error);
        return null;
      })) !== head
    )
      throw error;
  }
}

export async function remoteBranchSha(
  repo: Repo,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
): Promise<string | null> {
  const url = repo.url;
  if (repo.kind !== "github" || !url) return null;
  const remote = await withTransportRepo(cwd, null, signal, (transport) =>
    remoteSh(["git", "ls-remote", url, `refs/heads/${branch}`], { cwd: transport, signal, budget }),
  );
  return remote.stdout.split("\t")[0] || null;
}

/** Update an existing PR head only if it still points at the commit we prepared from. */
export async function pushExistingBranch(
  repo: Repo,
  cwd: string,
  branch: string,
  baseSha: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
  sha = "HEAD",
  guard?: () => void,
): Promise<void> {
  const url = repo.url;
  if (repo.kind !== "github" || !url) throw new Error("existing PR delivery requires a GitHub repo");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/"))
    throw new Error("invalid PR head branch");
  const ref = `refs/heads/${branch}`;
  const head = (await worktreeGit(["git", "rev-parse", `${sha}^{commit}`], { cwd, signal })).stdout.trim();
  await withTransportRepo(cwd, head, signal, async (transport) => {
    const remote = await remoteSh(["git", "ls-remote", url, ref], { cwd: transport, signal, budget });
    if (remote.stdout.split("\t")[0] !== baseSha) throw new Error("PR head moved since the run started");
    const ancestor = await worktreeGit(["git", "merge-base", "--is-ancestor", baseSha, head], {
      cwd,
      allowFail: true,
      signal,
    });
    if (ancestor.exitCode !== 0) throw new Error("run result is not a descendant of the PR head");
    await remoteSh(
      [...BRANCH_PUSH, `--force-with-lease=${ref}:${baseSha}`, url, `${head}:${ref}`],
      { cwd: transport, timeoutMs: 300_000, signal, budget },
      guard,
    );
  });
}

function isHttpUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

export interface PullRequestIdentity {
  headSha: string;
  prUrl?: string | null;
}

/** Reusable branch names alone cannot identify a delivery's PR. */
export function matchesPullRequest(
  pr: unknown,
  identity: PullRequestIdentity,
): pr is { url: string; headRefOid?: unknown } {
  return (
    !!pr &&
    typeof pr === "object" &&
    "url" in pr &&
    typeof pr.url === "string" &&
    (identity.prUrl
      ? pr.url === identity.prUrl
      : !!identity.headSha && "headRefOid" in pr && pr.headRefOid === identity.headSha)
  );
}

export function lookupUrl(raw: string, identity?: PullRequestIdentity): string {
  if (!identity) return raw.trim();
  const prs: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(prs)) throw new Error("PR lookup did not return a list");
  const matches = prs.filter((pr) => matchesPullRequest(pr, identity));
  if (matches.length > 1) throw new Error(`several pull requests share head ${identity.headSha}`);
  return matches[0]?.url ?? "";
}

/** A recorded URL is authoritative; branch/SHA recovery must enumerate every PR state. */
async function lookupIdentityPr(
  repo: Repo,
  branch: string,
  cwd: string,
  identity: PullRequestIdentity,
  signal?: AbortSignal,
): Promise<string> {
  if (identity.prUrl) {
    const res = await githubSh(
      ["gh", "pr", "view", identity.prUrl, "--repo", repo.slug, "--json", "url,headRefOid"],
      { cwd, signal, timeoutMs: 15_000 },
      repo.slug,
    );
    const pr: unknown = JSON.parse(res.stdout || "null");
    if (!matchesPullRequest(pr, identity) || !isHttpUrl(pr.url))
      throw new Error("Cannot establish recorded PR identity; replacement creation blocked");
    return pr.url;
  }
  if (!/^[a-f0-9]{40,64}$/.test(identity.headSha))
    throw new Error("Cannot recover PR without an expected head SHA; creation blocked");
  const head = encodeURIComponent(`${repo.slug.split("/")[0]}:${branch}`);
  const res = await githubSh(
    ["gh", "api", "--paginate", "--slurp", `repos/${repo.slug}/pulls?head=${head}&state=all&per_page=100`],
    { cwd, signal, timeoutMs: 15_000 },
    repo.slug,
  );
  // gh follows the Link headers to completion; a failed later page fails the whole command.
  const pages = z
    .array(
      z.array(
        z.object({
          html_url: z.string().refine(isHttpUrl),
          head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }),
        }),
      ),
    )
    .min(1)
    .safeParse(JSON.parse(res.stdout || "null"));
  if (!pages.success) throw new Error("Cannot establish complete PR lookup; creation blocked");
  return lookupUrl(
    JSON.stringify(pages.data.flat().map((pr) => ({ url: pr.html_url, headRefOid: pr.head.sha }))),
    identity,
  );
}

export async function createPullRequest(
  repo: Repo,
  opts: {
    branch: string;
    base: string;
    title: string;
    body: string;
    cwd: string;
    draft?: boolean;
    signal?: AbortSignal;
    budget?: GitHubBudget;
    identity?: PullRequestIdentity;
  },
): Promise<string> {
  const { cwd, signal } = opts;
  // Legacy lookups retain their absence fallback; identity-aware failures block creation.
  const find = () =>
    opts.identity
      ? lookupIdentityPr(repo, opts.branch, cwd, opts.identity, signal)
      : githubSh(prLookup(repo, opts.branch), { cwd, signal }, repo.slug).then(
          (r) => lookupUrl(r.stdout, opts.identity),
          (e) => {
            rethrowClaimControl(e);
            return e instanceof GitHubIdentityError || isTransient(e) || signal?.aborted
              ? Promise.reject(e)
              : "";
          },
        );
  let existing = false;
  let reportedExisting = false;
  // Look up before every create: a 5xx or timeout can hide a PR that was in fact opened.
  const url = await withGitHubRetry(async () => {
    const found = await find();
    if (found) {
      existing = true;
      return found;
    }
    // GitHub said the PR exists but the lookup lags behind it: retry the lookup, not the create.
    const lagging = () => new RetryableError(`a PR for ${opts.branch} already exists but was not found`);
    if (reportedExisting) throw lagging();
    const create = ["gh", "pr", "create", "--repo", repo.slug, "--head", opts.branch, "--base", opts.base];
    const args = [...create, "--title", opts.title, "--body-file", "-", ...(opts.draft ? ["--draft"] : [])];
    const res = await githubSh(args, { cwd, stdin: opts.body, signal }, repo.slug).catch(async (e) => {
      if (!(e instanceof CommandError && e.stderr.includes("already exists"))) throw e;
      reportedExisting = true;
      const again = await find();
      if (!again) throw lagging();
      existing = true;
      return { stdout: again };
    });
    return res.stdout.trim().split("\n").pop() ?? "";
  }, opts);
  if (!isHttpUrl(url)) throw new Error(`gh pr create returned unexpected output: ${url}`);
  if (existing)
    await remoteSh(
      ["gh", "pr", "edit", url, "--body-file", "-"],
      { ...opts, stdin: opts.body },
      undefined,
      repo.slug,
    ).catch((e) => {
      rethrowClaimControl(e);
      if (e instanceof GitHubIdentityError || signal?.aborted) throw e;
    });
  return url;
}

const prLookup = (repo: Repo, branch: string, identity?: PullRequestIdentity) => [
  ...["gh", "pr", "list", "--repo", repo.slug, "--head", branch, "--state", "all"],
  ...(identity ? ["--json", "url,headRefOid"] : ["--json", "url", "--jq", ".[0].url"]),
];

/**
 * One short lookup for this branch's PR, outside any retry budget: used before a fallback, which
 * may have no budget left, so a PR that was in fact created still gets recorded.
 */
export async function findPullRequest(
  repo: Repo,
  branch: string,
  cwd: string,
  signal?: AbortSignal,
  identity?: PullRequestIdentity,
): Promise<string | null> {
  if (identity) return (await lookupIdentityPr(repo, branch, cwd, identity, signal)) || null;
  const res = await githubSh(
    prLookup(repo, branch, identity),
    {
      cwd,
      signal,
      timeoutMs: 15_000,
      allowFail: true,
    },
    repo.slug,
  ).catch((e) => {
    rethrowClaimControl(e);
    if (e instanceof GitHubIdentityError || signal?.aborted) throw e;
    return null;
  });
  const url = res?.exitCode === 0 ? lookupUrl(res.stdout, identity) : "";
  return isHttpUrl(url) ? url : null;
}

/**
 * Merge now if possible; if branch protection requires checks, enable auto-merge instead.
 * `expectedHead` pins the merge to the commit the factory checked (`--match-head-commit`), `body`
 * is the squash message the factory reviewed, and `auto: false` never arms auto-merge, which would
 * let a later push land unchecked.
 */
export async function mergePullRequest(
  prUrl: string,
  cwd: string,
  sha: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
  entries: PrivateStrings = privacy.loadPrivateStrings(undefined, [cwd]),
  opts: {
    body?: string;
    title?: string;
    subject?: string;
    auto?: boolean;
    guard?: () => void | Promise<void>;
    onFailure?: (reason: string) => void;
  } = {},
): Promise<"merged" | "auto" | "failed" | "unavailable"> {
  const repo = githubUrlRepo(prUrl);
  // After a transient failure or timeout the merge may still have landed. Until a state lookup
  // settles that, every attempt reconciles first; a failed lookup retries like any other call.
  let unsure = false;
  let blocked = false;
  const verifiedState = (input: unknown) => {
    const data = z.object({ state: z.enum(["OPEN", "MERGED"]), headRefOid: z.string() }).parse(input);
    if (!/^[a-f0-9]{40,64}$/.test(sha) || data.headRefOid !== sha) throw new Error("PR head moved");
    return data.state;
  };
  const landed = async () => {
    blocked = true;
    const view = ["gh", "pr", "view", prUrl, "--json", "state,headRefOid"];
    const merged =
      verifiedState(JSON.parse((await githubSh(view, { cwd, signal }, repo)).stdout)) === "MERGED";
    unsure = false;
    blocked = false;
    return merged;
  };
  const merge = (extra: string[]) =>
    withGitHubRetry(
      async () => {
        if (unsure && (await landed())) return "merged" as const;
        blocked = true;
        const view = ["gh", "pr", "view", prUrl, "--json", "title,body,headRefOid,state"];
        const input: unknown = JSON.parse((await githubSh(view, { cwd, signal }, repo)).stdout);
        if (verifiedState(input) === "MERGED") return "merged" as const;
        const schema = z.object({ title: z.string().min(1), body: z.string(), headRefOid: z.string() });
        const data = schema.parse(input);
        const rawTitle = opts.subject ?? opts.title ?? data.title;
        if (!rawTitle.trim()) throw new Error("missing merge subject");
        const title = opts.subject ?? squashTitle(rawTitle, prUrl);
        const body = opts.body ?? data.body;
        checkPublicationText(`${title}\n${body}`, "PR text", entries);
        blocked = false;
        const subject =
          opts.body !== undefined
            ? ["--match-head-commit", sha, "--subject", title, "--body-file", "-"]
            : ["--subject", title, "--body", body, "--match-head-commit", sha];
        const cmd = ["gh", "pr", "merge", prUrl, "--squash", ...extra, "--delete-branch", ...subject];
        try {
          await opts.guard?.();
        } catch (cause) {
          throw new GitHubGuardError("Merge guard refused", { cause });
        }
        return githubSh(cmd, { cwd, signal, stdin: body }, repo).then(
          () => "ok" as const,
          async (e) => {
            if (signal?.aborted || !isTransient(e)) throw e;
            unsure = true;
            if (await landed()) return "merged" as const;
            throw e;
          },
        );
      },
      { budget, signal },
    ).catch((e) => {
      rethrowClaimControl(e);
      if (e instanceof GitHubGuardError) throw e.cause;
      if (e instanceof GitHubIdentityError || signal?.aborted) throw e;
      const cause = e instanceof GitHubUnavailableError ? (e.cause ?? e) : e;
      const detail =
        cause instanceof CommandError ? cause.stderr || cause.stdout || cause.message : String(cause);
      opts.onFailure?.(redactCredentials(`merge failed: ${detail}`).slice(0, 2000));
      return e instanceof GitHubUnavailableError ? ("unavailable" as const) : ("failed" as const);
    });
  const now = await merge([]);
  if (now === "ok" || now === "merged") return "merged";
  if (blocked || opts.auto === false) return now;
  // As on main, fall back to auto-merge; it shares the budget and reconciles an unsure merge first.
  const auto = await merge(["--auto"]);
  if (auto === "merged") return "merged";
  if (auto === "ok") return "auto";
  return now === "unavailable" || auto === "unavailable" ? "unavailable" : "failed";
}

/** Turn off a PR's auto-merge, so no later push can land without the factory checking it. */
export async function disableAutoMerge(prUrl: string, cwd: string, signal?: AbortSignal): Promise<void> {
  await githubSh(
    ["gh", "pr", "merge", prUrl, "--disable-auto"],
    { cwd, signal, allowFail: true },
    githubUrlRepo(prUrl),
  );
}

/** Same stable top-level representation used in pipeline and eval prompts. */
export function formatTopLevel(entries: string[]): string {
  return entries
    .filter((entry) => entry !== ".git")
    .sort()
    .slice(0, 60)
    .join("  ");
}

/** Read only an exact commit from the bare cache; no worktree or default-branch fallback. */
export async function pinnedTree(paths: Paths, store: Store, slug: string, sha: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !/^[a-fA-F0-9]{40}$/.test(sha))
    throw new Error("invalid repository pin");
  const registered = store.getRepoBySlug(slug);
  const repo: Repo = {
    id: slug,
    slug,
    kind: "github",
    url: registered?.url ?? `https://github.com/${slug}.git`,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
    createdAt: 0,
  };
  const cache = cachePath(paths, repo);
  if (!existsSync(cache)) await ensureCache(paths, repo);
  return withRepoLock(cache, async () => {
    // Only the factory writes this cache/staging repository, before any candidate runs.
    const bare = await sh(["git", "rev-parse", "--is-bare-repository"], { cwd: cache });
    if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
    // Only the factory writes this cache/staging repository, before any candidate runs.
    const check = () => sh(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: cache, allowFail: true });
    if ((await check()).exitCode !== 0) {
      // Only the factory writes this cache/staging repository, before any candidate runs.
      await sh(["git", "fetch", "origin", sha], { cwd: cache, timeoutMs: 300_000 });
      if ((await check()).exitCode !== 0) throw new Error(`pinned commit ${sha} missing in ${slug}`);
    }
    // Only the factory writes this cache/staging repository, before any candidate runs.
    const tree = await sh(["git", "ls-tree", "--name-only", "-z", sha], { cwd: cache });
    return formatTopLevel(tree.stdout.split("\0").filter(Boolean));
  });
}

/** Eval labels that must not be readable anywhere in a pinned checkout's history. */
export interface EvalLabels {
  /** Repository paths (files or directory prefixes) holding eval datasets. */
  paths: string[];
  /** Exact file contents (dataset, seed patches) that must not appear as any blob. */
  contents: (string | Uint8Array)[];
}

/** Disposable, isolated pinned eval checkout; never creates or moves a source branch. */
export async function createEvalWorktree(
  paths: Paths,
  store: Store,
  slug: string,
  base: string,
  head: string,
  path: string,
  signal: AbortSignal,
  labels: EvalLabels = { paths: [], contents: [] },
  snapshot = false,
): Promise<(() => Promise<void>) & { base: string }> {
  const cache = await evalRepositoryCache(paths, store, slug, base, head, signal);
  return createEvalWorktreeFromCache(cache, base, head, path, signal, labels, snapshot);
}

/** The same isolated checkout and contamination checks, using an already resolved cache. */
export async function createEvalWorktreeFromCache(
  cache: string,
  base: string,
  head: string,
  path: string,
  signal: AbortSignal,
  labels: EvalLabels,
  snapshot = false,
): Promise<(() => Promise<void>) & { base: string }> {
  const cleanup = async () => rmSync(path, { recursive: true, force: true });
  try {
    const pins = await stagePinnedEvalRepo(cache, base, head, path, signal, labels, snapshot);
    const opts = { cwd: path, signal };
    await worktreeGit(
      ["git", "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", pins[1]],
      opts,
    );
    // Only the factory writes this eval staging repository; no candidate has run yet.
    for (const ref of ["refs/eval/base", "refs/eval/head"]) await sh(["git", "update-ref", "-d", ref], opts);
    // Only the factory writes this eval staging repository; no candidate has run yet.
    await sh(["git", "reflog", "expire", "--expire=now", "--all"], opts);
    return Object.assign(cleanup, { base: pins[0] });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Top-level listing of a checked snapshot of `sha`, read with ls-tree; `path` is removed after. */
export async function snapshotTopLevel(
  paths: Paths,
  store: Store,
  slug: string,
  sha: string,
  path: string,
  signal: AbortSignal,
  labels: EvalLabels,
): Promise<string> {
  try {
    const cache = await evalRepositoryCache(paths, store, slug, sha, sha, signal);
    const [, head] = await stagePinnedEvalRepo(cache, sha, sha, path, signal, labels, true);
    // Only the factory writes this eval staging repository; no candidate has run yet.
    const tree = await sh(["git", "ls-tree", "--name-only", "-z", head], { cwd: path, signal });
    return formatTopLevel(tree.stdout.split("\0").filter(Boolean));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

async function evalRepositoryCache(
  paths: Paths,
  store: Store,
  slug: string,
  base: string,
  head: string,
  signal: AbortSignal,
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || ![base, head].every((sha) => /^[a-fA-F0-9]{40}$/.test(sha)))
    throw new Error("invalid repository pin");
  const registered = store.getRepoBySlug(slug);
  const repo: Repo = {
    id: slug,
    slug,
    kind: "github",
    localPath: null,
    url: registered?.url ?? registered?.localPath ?? `https://github.com/${slug}.git`,
    defaultBranch: "main",
    mergePolicy: "none",
    createdAt: 0,
  };
  const cache = cachePath(paths, repo);
  signal.throwIfAborted();
  if (!existsSync(cache)) await ensureCache(paths, repo, signal);
  return cache;
}

async function stagePinnedEvalRepo(
  cache: string,
  base: string,
  head: string,
  path: string,
  signal: AbortSignal,
  labels: EvalLabels,
  snapshot: boolean,
): Promise<[string, string]> {
  if (![base, head].every((sha) => /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("invalid repository pin");
  let pins: [string, string] = [base, head];
  await withRepoLock(cache, async () => {
    signal.throwIfAborted();
    const opts = { cwd: cache, signal };
    // Only the factory writes this cache/staging repository, before any candidate runs.
    const bare = await sh(["git", "rev-parse", "--is-bare-repository"], opts);
    if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
    const exists = async (sha: string) =>
      // Only the factory writes this eval staging repository; no candidate has run yet.
      (await sh(["git", "cat-file", "-e", `${sha}^{commit}`], { ...opts, allowFail: true })).exitCode === 0;
    const missing = async () => {
      const absent: string[] = [];
      for (const sha of new Set([base, head])) if (!(await exists(sha))) absent.push(sha);
      return absent;
    };
    let absent = await missing();
    if (snapshot && absent.length) {
      // Like pinnedTree: fetch the exact pins, which may be reachable only from a tag.
      // Only the factory writes this cache/staging repository, before any candidate runs.
      await sh(["git", "fetch", "origin", ...absent], { ...opts, timeoutMs: 300_000, allowFail: true });
      absent = await missing();
    }
    if (absent.length) {
      // Only the factory writes this eval staging repository; no candidate has run yet.
      await sh(
        [
          "git",
          "fetch",
          "origin",
          "+refs/heads/*:refs/remotes/origin/*",
          "+refs/pull/*/head:refs/pull/*/head",
        ],
        { ...opts, timeoutMs: 300_000 },
      );
    }
    for (const sha of [base, head])
      if (!(await exists(sha))) throw new Error(`pinned commit ${sha} missing in repository cache`);
    signal.throwIfAborted();
    // A standalone repo holding only history reachable from the pins: a linked worktree
    // would share the cache's refs and objects, exposing later fixes and labeled datasets.
    mkdirSync(path, { recursive: true });
    // Only the factory writes this cache/staging repository, before any candidate runs.
    await sh(["git", "init", "-q", path], opts);
    if (snapshot) pins = await pushSnapshot(cache, base, head, path, signal);
    // Only the factory writes this eval staging repository; no candidate has run yet.
    else await sh([...BRANCH_PUSH, "-q", path, `${base}:refs/eval/base`, `${head}:refs/eval/head`], opts);
  });
  await rejectContamination(path, labels, signal);
  return pins;
}

/** Fixed identity and dates so the same pins always produce the same snapshot commits. */
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "Limitless",
  GIT_AUTHOR_EMAIL: "limitless@localhost",
  GIT_AUTHOR_DATE: "1000000000 +0000",
  GIT_COMMITTER_NAME: "Limitless",
  GIT_COMMITTER_EMAIL: "limitless@localhost",
  GIT_COMMITTER_DATE: "1000000000 +0000",
};

/**
 * Push two neutral commits of the pinned trees minus the top-level `evals` directory into
 * `path`, the head parented on the base even when the trees coincide. They are built in a
 * staging repository that borrows the cache's objects, so the target receives only objects
 * reachable from the snapshot. Trees go through git's index, never through decoded text, so
 * filename bytes survive unchanged.
 */
async function pushSnapshot(
  cache: string,
  base: string,
  head: string,
  path: string,
  signal: AbortSignal,
): Promise<[string, string]> {
  const staging = `${path}.snapshot`;
  rmSync(staging, { recursive: true, force: true });
  try {
    // Only the factory writes this cache/staging repository, before any candidate runs.
    await sh(["git", "init", "-q", staging], { cwd: cache, signal });
    const objects =
      // Only the factory writes this cache/staging repository, before any candidate runs.
      (await sh(["git", "rev-parse", "--git-path", "objects"], { cwd: cache, signal })).stdout.trim();
    writeFileSync(join(staging, ".git/objects/info/alternates"), `${resolve(cache, objects)}\n`);
    const opts = {
      cwd: staging,
      signal,
      env: { ...(process.env as Record<string, string>), ...SNAPSHOT_ENV },
    };
    const commit = async (sha: string, message: string, parent?: string) => {
      // Only the factory writes this eval staging repository; no candidate has run yet.
      await sh(["git", "read-tree", `${sha}^{tree}`], opts);
      // Only the factory writes this eval staging repository; no candidate has run yet.
      await sh(["git", "rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", "evals/"], opts);
      // Only the factory writes this eval staging repository; no candidate has run yet.
      const tree = (await sh(["git", "write-tree"], opts)).stdout.trim();
      const args = ["git", "-c", "i18n.commitEncoding=UTF-8", "commit-tree", "--no-gpg-sign", tree];
      // Only the factory writes this eval staging repository; no candidate has run yet.
      return (await sh([...args, ...(parent ? ["-p", parent] : []), "-m", message], opts)).stdout.trim();
    };
    const snapshotBase = await commit(base, "Snapshot base");
    const snapshotHead = await commit(head, "Snapshot head", snapshotBase);
    // Only the factory writes this eval staging repository; no candidate has run yet.
    await sh(
      [...BRANCH_PUSH, "-q", path, `${snapshotBase}:refs/eval/base`, `${snapshotHead}:refs/eval/head`],
      opts,
    );
    return [snapshotBase, snapshotHead];
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Refuse pins whose reachable history contains eval labels: removing the files from the
 * checkout would still leave them readable through `git show`/`git log`.
 */
async function rejectContamination(path: string, labels: EvalLabels, signal: AbortSignal): Promise<void> {
  const opts = { cwd: path, signal };
  if (labels.paths.length) {
    // Default history simplification skips a side branch whose labels a merge discarded
    // (e.g. `merge -s ours`), yet its objects are still copied into the checkout.
    // Only the factory writes this eval staging repository; no candidate has run yet.
    const touched = await sh(
      ["git", "rev-list", "-1", "--full-history", "refs/eval/base", "refs/eval/head", "--", ...labels.paths],
      opts,
    );
    if (touched.stdout.trim())
      throw new Error(
        `pinned history contains eval labels (${labels.paths.join(", ")}); choose earlier pins`,
      );
  }
  const oids = labels.contents.flatMap((content) => {
    if (typeof content === "string" && !content.trim()) return [];
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    return new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  });
  if (!oids.length) return;
  // Check every label in one process: repeated trials otherwise spawn once per hidden file.
  // Only the factory writes this eval staging repository; no candidate has run yet.
  const found = await sh(["git", "cat-file", "--batch-check=%(objectname)"], {
    ...opts,
    stdin: `${oids.join("\n")}\n`,
  });
  if (
    found.stdout
      .trim()
      .split("\n")
      .some((line) => !line.endsWith(" missing"))
  )
    throw new Error("pinned history contains an eval dataset or seed patch; choose earlier pins");
}
