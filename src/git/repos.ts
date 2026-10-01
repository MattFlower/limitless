import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Paths } from "../config.ts";
import type { Repo } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { CommandError, sh } from "../util/proc.ts";
import {
  captureShared,
  captureTrust,
  forgetCheckout,
  type GitTrust,
  git,
  RAW_DIFF,
  restoreCheckout,
  restoreShared,
  trustCheckout,
  trustedConfigPath,
  trustedWorktreeConfigPath,
} from "./trust.ts";

export { trustedAttributesPath, trustedConfigPath } from "./trust.ts";

const NO_PUSH = "no-push://limitless-agents-cannot-push";

/** Retry policy for GitHub and remote git (tests shorten it). */
export const githubRetry = { attempts: 3, budgetMs: 60_000, baseDelayMs: 5_000 };
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
        throw new GitHubUnavailableError(`GitHub unavailable: ${(error as Error).message}`);
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
const remoteSh = (cmd: string[], opts: RemoteOpts) => withGitHubRetry(() => sh(cmd, opts), opts);
// Pushes from a checkout read its config (insteadOf, push options): restore the factory's first.
const remoteGit = async (args: string[], opts: RemoteOpts) => {
  await restoreCheckout(opts.cwd, opts.signal);
  return withGitHubRetry(() => git(args, opts), opts);
};

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

/** Resolve "owner/name", a GitHub URL, or a local path into a registered repo. */
export async function resolveRepo(store: Store, input: string): Promise<Repo> {
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
    const head = await git(["symbolic-ref", "--short", "HEAD"], { cwd: path, allowFail: true });
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
  const view = await remoteSh(["gh", "repo", "view", slug, "--json", "defaultBranchRef,sshUrl"], {
    cwd: process.cwd(),
  });
  const info = JSON.parse(view.stdout) as { defaultBranchRef: { name: string } | null; sshUrl: string };
  return store.upsertRepo({
    slug,
    kind: "github",
    url: info.sshUrl,
    localPath: null,
    defaultBranch: info.defaultBranchRef?.name ?? "main",
    mergePolicy: "auto",
  });
}

export function cachePath(paths: Paths, repo: Repo): string {
  if (repo.kind === "local") return repo.localPath as string;
  return join(paths.repos, `${repo.slug.replace("/", "__")}.git`);
}

/** Where the factory keeps its trusted copies of a repository's shared git config and attributes. */
export function trustedKey(paths: Paths, repo: Repo): string {
  return repo.kind === "github" ? cachePath(paths, repo) : join(paths.repos, repo.slug.replace("/", "__"));
}

const cacheLocks = new Map<string, Promise<unknown>>();

/** Serialize work on one repo cache (clone/fetch/worktree add) across concurrent runs. */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  cacheLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (cacheLocks.get(key) === next) cacheLocks.delete(key);
  }
}

/** Make sure a fresh bare mirror exists (GitHub repos) and is fetched. */
export async function ensureCache(paths: Paths, repo: Repo, signal?: AbortSignal): Promise<string> {
  const cache = cachePath(paths, repo);
  if (repo.kind === "local") return cache;
  return withRepoLock(cache, async () => {
    signal?.throwIfAborted();
    if (!existsSync(cache)) {
      mkdirSync(paths.repos, { recursive: true });
      // Clone to a temporary path and rename, so a crash never leaves a half-configured cache.
      const tmp = `${cache}.tmp-${process.pid}-${Date.now()}`;
      try {
        await git(["clone", "--bare", repo.url as string, tmp], {
          cwd: paths.repos,
          timeoutMs: 600_000,
          signal,
        });
        await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], {
          cwd: tmp,
          signal,
        });
        // The factory's own fresh clone is the trusted baseline for this cache's config.
        copyFileSync(join(tmp, "config"), trustedConfigPath(cache));
        renameSync(tmp, cache);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    await restoreCache(cache, repo.url as string);
    // Agents run inside worktrees of this repo; make any push attempt from them fail.
    await git(["config", "remote.origin.pushurl", NO_PUSH], { cwd: cache });
    copyFileSync(join(cache, "config"), trustedConfigPath(cache));
    await git(["fetch", "origin", "--prune"], { cwd: cache, timeoutMs: 300_000, signal });
    return cache;
  });
}

/**
 * Agents can write a GitHub cache's config, hooks and info/attributes through their worktrees: put
 * the factory's back before any cache operation (under the repo lock). An existing cache without a
 * trusted copy (e.g. one cloned by an older release) gets its config rebuilt from the factory's
 * inputs, never adopted from the live file.
 */
async function restoreCache(cache: string, url: string): Promise<void> {
  const trusted = trustedConfigPath(cache);
  if (!existsSync(trusted)) {
    const tmp = `${cache}.config-${process.pid}-${Date.now()}`;
    try {
      await git(["init", "-q", "--bare", tmp], { cwd: dirname(cache) });
      for (const [key, value] of [
        ["remote.origin.url", url],
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["remote.origin.pushurl", NO_PUSH],
      ] as const)
        await git(["config", "-f", join(tmp, "config"), key, value], { cwd: tmp });
      copyFileSync(join(tmp, "config"), trusted);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  restoreShared(cache, cache, true);
}

/**
 * A user's local repository shares its config and info/attributes with every factory worktree, so an
 * agent in one run can change what the next run's checkout runs and snapshots. The factory keeps its
 * own copies from the first worktree it creates and restores them before every later one. Without
 * copies, the live files count as the user's only while no factory worktree exists; with one, an
 * agent may already have written them, and no trusted input remains to rebuild them from.
 */
async function restoreLocal(paths: Paths, cache: string, key: string): Promise<void> {
  const metadata = async (flag: string) =>
    realpathSync(resolve(cache, (await git(["rev-parse", flag], { cwd: cache })).stdout.trim()));
  const common = await metadata("--git-common-dir");
  const gitDir = await metadata("--absolute-git-dir");
  if (
    !existsSync(trustedConfigPath(key)) ||
    !existsSync(trustedWorktreeConfigPath(key)) ||
    (gitDir !== common && !existsSync(trustedWorktreeConfigPath(key, gitDir)))
  ) {
    const under = (path: string) => {
      try {
        return realpathSync(path).startsWith(realpathSync(paths.work) + sep);
      } catch {
        return false;
      }
    };
    const active = (await git(["worktree", "list", "--porcelain"], { cwd: cache })).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter(under);
    if (active.length)
      throw new Error(
        `no trusted git state for ${cache} while factory worktrees exist (remove them first): ${active.join(", ")}`,
      );
    captureShared(common, key, gitDir);
  }
  restoreShared(common, key, false, gitDir);
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
  /** Factory git state captured when the worktree was created; absent when an existing one is reused. */
  trust?: GitTrust;
}

export async function createWorktree(
  paths: Paths,
  repo: Repo,
  runId: string,
  title: string,
  baseBranch: string,
): Promise<Worktree> {
  const cache = cachePath(paths, repo);
  const path = join(paths.work, runId);
  const branch = `limitless/${runId}-${slugify(title, 30)}`;
  const baseRef = repo.kind === "github" ? `origin/${baseBranch}` : baseBranch;
  if (existsSync(path)) {
    // Resuming an interrupted run: reuse the worktree as-is.
    const head = await git(["rev-parse", "HEAD"], { cwd: path });
    const base = await git(["rev-parse", baseRef], { cwd: cache });
    return { path, branch, baseSha: base.stdout.trim() || head.stdout.trim() };
  }
  return withRepoLock(cache, async () => {
    // The shared repository's metadata is the factory's again before the checkout runs with it.
    const key = trustedKey(paths, repo);
    if (repo.kind === "github") await restoreCache(cache, repo.url as string);
    else await restoreLocal(paths, cache, key);
    const base = await git(["rev-parse", baseRef], { cwd: cache });
    await git(["worktree", "add", "-b", branch, path, base.stdout.trim()], { cwd: cache });
    // A user's local repository keeps its own hooks; GitHub caches are the factory's throughout.
    const trust = await captureTrust(path, repo.kind === "github", key);
    return { path, branch, baseSha: base.stdout.trim(), trust };
  });
}

export async function removeWorktree(paths: Paths, repo: Repo, path: string): Promise<void> {
  forgetCheckout(path);
  if (!existsSync(path)) return;
  await git(["worktree", "remove", "--force", path], { cwd: cachePath(paths, repo), allowFail: true });
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], { cwd })).stdout.trim();
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
    if (repo.kind === "github") await restoreCache(cache, repo.url as string);
    await remoteGit(["fetch", "origin", `+${ref}:refs/remotes/origin/${branch}`], {
      cwd: cache,
      timeoutMs: 300_000,
      signal,
      budget,
    });
    return (await git(["rev-parse", `refs/remotes/origin/${branch}`], { cwd: cache, signal })).stdout.trim();
  });
}

export async function readFileAt(
  cwd: string,
  revision: string,
  path: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const entry = await git(["ls-tree", "--name-only", revision, "--", path], { cwd, env });
  if (!entry.stdout.trim()) return null;
  return (await git(["show", ...RAW_DIFF, `${revision}:${path}`], { cwd, env })).stdout;
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
  await restoreCheckout(cwd, signal);
  const index = `${dest}.index`;
  const env = { ...(process.env as Record<string, string>), GIT_INDEX_FILE: index };
  try {
    await git(["read-tree", `${sha}^{commit}`], { cwd, env, signal, timeoutMs: 300_000 });
    await git(["checkout-index", "--all", `--prefix=${dest}/`], {
      cwd,
      env,
      signal,
      timeoutMs: 300_000,
    });
  } finally {
    rmSync(index, { force: true });
  }
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    allowFail: true,
  });
  return result.exitCode === 0;
}

export async function rebaseOnto(cwd: string, baseSha: string): Promise<"clean" | "conflict"> {
  await restoreCheckout(cwd);
  const result = await git(
    ["-c", "user.name=Limitless", "-c", "user.email=limitless@localhost", "rebase", baseSha],
    {
      cwd,
      allowFail: true,
    },
  );
  if (result.exitCode === 0) return "clean";
  const state = await git(["rev-parse", "--git-path", "rebase-merge"], { cwd });
  const apply = await git(["rev-parse", "--git-path", "rebase-apply"], { cwd });
  if (!existsSync(resolve(cwd, state.stdout.trim())) && !existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error(`rebase failed: ${result.stderr || result.stdout}`);
  await git(["rebase", "--abort"], { cwd });
  if (existsSync(resolve(cwd, state.stdout.trim())) || existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error("rebase abort left worktree in rebase state");
  return "conflict";
}

export async function clearInterruptedRebase(cwd: string, expected: boolean): Promise<void> {
  const state = await git(["rev-parse", "--git-path", "rebase-merge"], { cwd });
  const apply = await git(["rev-parse", "--git-path", "rebase-apply"], { cwd });
  if (!existsSync(resolve(cwd, state.stdout.trim())) && !existsSync(resolve(cwd, apply.stdout.trim())))
    return;
  if (!expected) throw new Error("worktree has an unexpected rebase in progress");
  await git(["rebase", "--abort"], { cwd });
  if (existsSync(resolve(cwd, state.stdout.trim())) || existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error("interrupted rebase could not be aborted");
}

/** Commit everything in the worktree. Returns the new sha, or null when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await restoreCheckout(cwd);
  await git(["add", "-A"], { cwd });
  const status = await git(["status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return null;
  await git(["commit", "--no-verify", "-q", "-m", message], { cwd });
  return headSha(cwd);
}

/**
 * Put the branch, index and tracked files back to a known commit, keeping untracked files: a gate
 * retry must see its first attempt's build output but not the tracked edits the attempt made.
 */
export async function restoreTracked(cwd: string, sha: string, env?: Record<string, string>): Promise<void> {
  await restoreCheckout(cwd);
  await git(["reset", "--hard", "-q", sha], { cwd, env });
}

/** Move the worktree's branch back to a known commit, discarding everything after it. */
export async function resetTo(cwd: string, sha: string, env?: Record<string, string>): Promise<void> {
  await restoreTracked(cwd, sha, env);
  await git(["clean", "-fdq"], { cwd, env });
}

/**
 * Throw away any uncommitted changes (used after read-only stages), and any commits past `head`, the
 * recorded sha a read-only agent may have moved the branch from. `env` matters when the checkout's
 * git config is untrusted: filters and drivers run with it. Nothing is written to a clean checkout,
 * so concurrent readers (panel finders) sharing it do not collide on the index lock.
 */
export async function discardChanges(
  cwd: string,
  env?: Record<string, string>,
  head = "HEAD",
): Promise<boolean> {
  await restoreCheckout(cwd);
  const status = await git(["status", "--porcelain"], { cwd, env });
  if (!status.stdout.trim() && (head === "HEAD" || (await headSha(cwd)) === head)) return false;
  await git(["reset", "--hard", "-q", head], { cwd, env });
  await git(["clean", "-fdq"], { cwd, env });
  return true;
}

export interface DiffFile {
  status: string; // git name-status code: A, M, D, R100, C75, ...
  path: string; // new path
  from?: string; // old path for renames/copies
}

export interface DiffInfo {
  patch: string;
  files: DiffFile[];
  stat: string;
  added: number;
  removed: number;
}

/** `head` names the recorded commit under audit: repository code may have moved HEAD since. */
export async function diffSince(
  cwd: string,
  baseSha: string,
  env?: Record<string, string>,
  threeDot = false,
  head = "HEAD",
): Promise<DiffInfo> {
  await restoreCheckout(cwd);
  const range = `${baseSha}${threeDot ? "..." : ".."}${head}`;
  const [patch, names, stat, numstat] = await Promise.all([
    git(["diff", ...RAW_DIFF, range], { cwd, env }),
    git(["diff", ...RAW_DIFF, "--name-status", range], { cwd, env }),
    git(["diff", ...RAW_DIFF, "--stat", range], { cwd, env }),
    git(["diff", ...RAW_DIFF, "--numstat", range], { cwd, env }),
  ]);
  let added = 0;
  let removed = 0;
  for (const line of numstat.stdout.split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  const files = parseNameStatus(names.stdout);
  return { patch: patch.stdout, files, stat: stat.stdout, added, removed };
}

export function parseNameStatus(text: string): DiffFile[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status = "", a = "", b] = l.split("\t");
      return b !== undefined ? { status, path: b, from: a } : { status, path: a };
    });
}

export async function pushBranch(
  repo: Repo,
  cwd: string,
  branch: string,
  sha = "HEAD",
  signal?: AbortSignal,
  budget?: GitHubBudget,
): Promise<void> {
  if (repo.kind !== "github" || !repo.url) return;
  await remoteGit(["push", "--force-with-lease", repo.url, `${sha}:refs/heads/${branch}`], {
    cwd,
    timeoutMs: 300_000,
    signal,
    budget,
  });
}

export async function remoteBranchSha(
  repo: Repo,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
): Promise<string | null> {
  if (repo.kind !== "github" || !repo.url) return null;
  const remote = await remoteGit(["ls-remote", repo.url, `refs/heads/${branch}`], {
    cwd,
    signal,
    budget,
  });
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
): Promise<void> {
  if (repo.kind !== "github" || !repo.url) throw new Error("existing PR delivery requires a GitHub repo");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/"))
    throw new Error("invalid PR head branch");
  const ref = `refs/heads/${branch}`;
  const remote = await remoteGit(["ls-remote", repo.url, ref], { cwd, signal, budget });
  if (remote.stdout.split("\t")[0] !== baseSha) throw new Error("PR head moved since the run started");
  const ancestor = await git(["merge-base", "--is-ancestor", baseSha, "HEAD"], {
    cwd,
    allowFail: true,
    signal,
  });
  if (ancestor.exitCode !== 0) throw new Error("run result is not a descendant of the PR head");
  await remoteGit(["push", `--force-with-lease=${ref}:${baseSha}`, repo.url, `HEAD:${ref}`], {
    cwd,
    timeoutMs: 300_000,
    signal,
    budget,
  });
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
  },
): Promise<string> {
  const { cwd, signal } = opts;
  // A final lookup failure means "none found", as before; transient ones retry the attempt.
  const find = () =>
    sh(prLookup(repo, opts.branch), { cwd, signal }).then(
      (r) => r.stdout.trim(),
      (e) => (isTransient(e) || signal?.aborted ? Promise.reject(e) : ""),
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
    const res = await sh(args, { cwd, stdin: opts.body, signal }).catch(async (e) => {
      if (!(e instanceof CommandError && e.stderr.includes("already exists"))) throw e;
      reportedExisting = true;
      const again = await find();
      if (!again) throw lagging();
      existing = true;
      return { stdout: again };
    });
    return res.stdout.trim().split("\n").pop() ?? "";
  }, opts);
  if (!url.startsWith("http")) throw new Error(`gh pr create returned unexpected output: ${url}`);
  if (existing)
    await remoteSh(["gh", "pr", "edit", url, "--body-file", "-"], { ...opts, stdin: opts.body }).catch(
      (e) => {
        if (signal?.aborted) throw e;
      },
    );
  return url;
}

const prLookup = (repo: Repo, branch: string) => [
  ...["gh", "pr", "list", "--repo", repo.slug, "--head", branch, "--state", "all"],
  ...["--json", "url", "--jq", ".[0].url"],
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
): Promise<string | null> {
  const res = await sh(prLookup(repo, branch), { cwd, signal, timeoutMs: 15_000, allowFail: true }).catch(
    (e) => {
      if (signal?.aborted) throw e;
      return null;
    },
  );
  const url = res?.exitCode === 0 ? res.stdout.trim() : "";
  return url.startsWith("http") ? url : null;
}

/** Merge now if possible; if branch protection requires checks, enable auto-merge instead. */
export async function mergePullRequest(
  prUrl: string,
  cwd: string,
  title?: string,
  signal?: AbortSignal,
  budget?: GitHubBudget,
): Promise<"merged" | "auto" | "failed" | "unavailable"> {
  // Squash with the PR title as the subject, not the first round's commit message.
  const number = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const subject = title ? ["--subject", number ? `${title} (#${number})` : title] : [];
  // After a transient failure or timeout the merge may still have landed. Until a state lookup
  // settles that, every attempt reconciles first; a failed lookup retries like any other call.
  let unsure = false;
  const landed = async () => {
    const view = ["gh", "pr", "view", prUrl, "--json", "state", "--jq", ".state"];
    const merged = (await sh(view, { cwd, signal })).stdout.trim() === "MERGED";
    unsure = false;
    return merged;
  };
  const merge = (extra: string[]) =>
    withGitHubRetry(
      async () => {
        if (unsure && (await landed())) return "merged" as const;
        const cmd = ["gh", "pr", "merge", prUrl, "--squash", ...extra, "--delete-branch", ...subject];
        return sh(cmd, { cwd, signal }).then(
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
      if (signal?.aborted) throw e;
      return e instanceof GitHubUnavailableError ? ("unavailable" as const) : ("failed" as const);
    });
  const now = await merge([]);
  if (now === "ok" || now === "merged") return "merged";
  // As on main, fall back to auto-merge; it shares the budget and reconciles an unsure merge first.
  const auto = await merge(["--auto"]);
  if (auto === "merged") return "merged";
  if (auto === "ok") return "auto";
  return now === "unavailable" || auto === "unavailable" ? "unavailable" : "failed";
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
    await restoreCache(cache, repo.url as string);
    const bare = await git(["rev-parse", "--is-bare-repository"], { cwd: cache });
    if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
    const check = () => git(["cat-file", "-e", `${sha}^{commit}`], { cwd: cache, allowFail: true });
    if ((await check()).exitCode !== 0) {
      await git(["fetch", "origin", sha], { cwd: cache, timeoutMs: 300_000 });
      if ((await check()).exitCode !== 0) throw new Error(`pinned commit ${sha} missing in ${slug}`);
    }
    const tree = await git(["ls-tree", "--name-only", "-z", sha], { cwd: cache });
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
  const cleanup = async () => {
    forgetCheckout(path);
    rmSync(path, { recursive: true, force: true });
  };
  try {
    const pins = await stageEvalRepo(paths, store, slug, base, head, path, signal, labels, snapshot);
    const opts = { cwd: path, signal };
    await git(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", pins[1]], opts);
    for (const ref of ["refs/eval/base", "refs/eval/head"]) await git(["update-ref", "-d", ref], opts);
    await git(["reflog", "expire", "--expire=now", "--all"], opts);
    // Each checkout gets its own baseline, before baseline gates or a candidate run in it.
    trustCheckout(path, await captureTrust(path, true));
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
    const [, head] = await stageEvalRepo(paths, store, slug, sha, sha, path, signal, labels, true);
    const tree = await git(["ls-tree", "--name-only", "-z", head], { cwd: path, signal });
    return formatTopLevel(tree.stdout.split("\0").filter(Boolean));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Fill a fresh repository at `path` with the pins (or their snapshot) under refs/eval/{base,head}
 * and reject contamination; returns the commits the candidate will see.
 */
async function stageEvalRepo(
  paths: Paths,
  store: Store,
  slug: string,
  base: string,
  head: string,
  path: string,
  signal: AbortSignal,
  labels: EvalLabels,
  snapshot: boolean,
): Promise<[string, string]> {
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
  let pins: [string, string] = [base, head];
  await withRepoLock(cache, async () => {
    signal.throwIfAborted();
    await restoreCache(cache, repo.url as string);
    const opts = { cwd: cache, signal };
    const bare = await git(["rev-parse", "--is-bare-repository"], opts);
    if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
    const exists = async (sha: string) =>
      (await git(["cat-file", "-e", `${sha}^{commit}`], { ...opts, allowFail: true })).exitCode === 0;
    const missing = async () => {
      const absent: string[] = [];
      for (const sha of new Set([base, head])) if (!(await exists(sha))) absent.push(sha);
      return absent;
    };
    let absent = await missing();
    if (snapshot && absent.length) {
      // Like pinnedTree: fetch the exact pins, which may be reachable only from a tag.
      await git(["fetch", "origin", ...absent], { ...opts, timeoutMs: 300_000, allowFail: true });
      absent = await missing();
    }
    if (absent.length) {
      await git(
        ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/pull/*/head:refs/pull/*/head"],
        { ...opts, timeoutMs: 300_000 },
      );
    }
    for (const sha of [base, head])
      if (!(await exists(sha))) throw new Error(`pinned commit ${sha} missing in ${slug}`);
    signal.throwIfAborted();
    // A standalone repo holding only history reachable from the pins: a linked worktree
    // would share the cache's refs and objects, exposing later fixes and labeled datasets.
    mkdirSync(path, { recursive: true });
    await git(["init", "-q", path], opts);
    if (snapshot) pins = await pushSnapshot(cache, base, head, path, signal);
    else await git(["push", "-q", path, `${base}:refs/eval/base`, `${head}:refs/eval/head`], opts);
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
    await git(["init", "-q", staging], { cwd: cache, signal });
    const objects = (await git(["rev-parse", "--git-path", "objects"], { cwd: cache, signal })).stdout.trim();
    writeFileSync(join(staging, ".git/objects/info/alternates"), `${resolve(cache, objects)}\n`);
    const opts = {
      cwd: staging,
      signal,
      env: { ...(process.env as Record<string, string>), ...SNAPSHOT_ENV },
    };
    const commit = async (sha: string, message: string, parent?: string) => {
      await git(["read-tree", `${sha}^{tree}`], opts);
      await git(["rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", "evals/"], opts);
      const tree = (await git(["write-tree"], opts)).stdout.trim();
      const args = ["-c", "i18n.commitEncoding=UTF-8", "commit-tree", "--no-gpg-sign", tree];
      return (await git([...args, ...(parent ? ["-p", parent] : []), "-m", message], opts)).stdout.trim();
    };
    const snapshotBase = await commit(base, "Snapshot base");
    const snapshotHead = await commit(head, "Snapshot head", snapshotBase);
    await git(["push", "-q", path, `${snapshotBase}:refs/eval/base`, `${snapshotHead}:refs/eval/head`], opts);
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
    const touched = await git(
      ["rev-list", "-1", "--full-history", "refs/eval/base", "refs/eval/head", "--", ...labels.paths],
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
  const found = await git(["cat-file", "--batch-check=%(objectname)"], {
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
