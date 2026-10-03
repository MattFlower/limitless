import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Paths } from "../config.ts";
import type { Repo } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { attributeRules, newlyHidden } from "../gates/audit.ts";
import { CommandError, sh } from "../util/proc.ts";
import { emptyHookFlags, NO_BIG_FILES, worktreeGit, worktreeGitScope } from "./command.ts";

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
const remoteSh = (cmd: string[], opts: RemoteOpts) =>
  withGitHubRetry(() => (cmd[0] === "git" ? worktreeGit(cmd, opts) : sh(cmd, opts)), opts);

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
  if (repo.kind === "local") return join(paths.repos, `local-${repo.id}.git`);
  return join(paths.repos, `${repo.slug.replace("/", "__")}.git`);
}

const cacheLocks = new Map<string, Promise<unknown>>();

/** Serialize work on one repo cache (clone/fetch/worktree add) across concurrent runs. */
export async function withRepoLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(path);
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
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
        await worktreeGit(
          ["git", "init", "-q", "--bare", "--template=", `--object-format=${format.stdout.trim()}`],
          { cwd: tmp, signal },
        );
        await worktreeGit(["git", "config", "remote.origin.url", repo.localPath as string], {
          cwd: tmp,
          signal,
        });
      } else {
        await worktreeGit(["git", "clone", "--bare", repo.url as string, tmp], {
          cwd: paths.repos,
          timeoutMs: 600_000,
          signal,
        });
      }
      await worktreeGit(["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], {
        cwd: tmp,
        signal,
      });
      renameSync(tmp, cache);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (repo.kind === "local") {
    await worktreeGit(["git", "config", "user.name", "Limitless"], { cwd: cache });
    await worktreeGit(["git", "config", "user.email", "limitless@localhost"], { cwd: cache });
  }
  // Agents run inside worktrees of this repo; make any push attempt from them fail.
  await worktreeGit(["git", "config", "remote.origin.pushurl", NO_PUSH], { cwd: cache });
  // Local clones mirror the source's tags, including deleted and moved ones.
  const tags = repo.kind === "local" ? ["--prune-tags", "--force"] : [];
  await worktreeGit(["git", "fetch", "origin", "--prune", ...tags], {
    cwd: cache,
    timeoutMs: 300_000,
    signal,
  });
  if (repo.kind === "local") {
    // Keep bare HEAD usable without retaining copied source branches. Best-effort: the recorded
    // default branch may be gone from the source while a run's explicit base branch still exists.
    await worktreeGit(
      ["git", "update-ref", "--no-deref", "HEAD", `refs/remotes/origin/${repo.defaultBranch}`],
      { cwd: cache, signal, allowFail: true },
    );
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
): Promise<Worktree> {
  const cache = cachePath(paths, repo);
  const path = join(paths.work, runId);
  const branch = `limitless/${runId}-${slugify(title, 30)}`;
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  if (existsSync(path)) {
    // Resuming an interrupted run: reuse the worktree as-is.
    const head = await worktreeGit(["git", "rev-parse", "HEAD"], { cwd: path });
    const owner = await worktreeOwner(path);
    const base =
      repo.kind === "local" ? head : await worktreeGit(["git", "rev-parse", baseRef], { cwd: owner });
    return { path, branch, baseSha: base.stdout.trim() || head.stdout.trim() };
  }
  return withRepoLock(cache, async () => {
    if (repo.kind === "local") await refreshCache(paths, repo);
    const base = await worktreeGit(["git", "rev-parse", baseRef], { cwd: cache });
    // Hooks are blanked where a command runs. `worktree add` would check out inside the new
    // worktree, where includes conditional on its branch or git directory can first activate
    // hooks; checking out from there instead lets the wrapper see exactly those.
    await worktreeGit(["git", "worktree", "add", "--no-checkout", "-b", branch, path, base.stdout.trim()], {
      cwd: cache,
    });
    await worktreeGit(["git", "reset", "--hard", "-q"], { cwd: path });
    return { path, branch, baseSha: base.stdout.trim() };
  });
}

export async function removeWorktree(paths: Paths, repo: Repo, path: string): Promise<void> {
  if (!existsSync(path)) return;
  const git = repo.kind === "github" ? worktreeGit : sh;
  const cache = repo.kind === "local" ? await worktreeOwner(path) : cachePath(paths, repo);
  await withRepoLock(cache, () =>
    git(["git", "worktree", "remove", "--force", path], { cwd: cache, allowFail: true }),
  );
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
    await remoteSh(["git", "fetch", "origin", `+${ref}:refs/remotes/origin/${branch}`], {
      cwd: cache,
      timeoutMs: 300_000,
      signal,
      budget,
    });
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
  const index = `${dest}.index`;
  const env = { ...(process.env as Record<string, string>), GIT_INDEX_FILE: index };
  try {
    await worktreeGit(["git", "read-tree", `${sha}^{commit}`], { cwd, env, signal, timeoutMs: 300_000 });
    await worktreeGit(["git", "checkout-index", "--all", `--prefix=${dest}/`], {
      cwd,
      env,
      signal,
      timeoutMs: 300_000,
    });
  } finally {
    rmSync(index, { force: true });
  }
}

/** A detached checkout of `sha` at `dest` sharing `cwd`'s repository, for readers kept off the worktree. */
export async function addDetachedWorktree(cwd: string, sha: string, dest: string, signal?: AbortSignal) {
  await sh(["git", "worktree", "add", "--detach", dest, sha], { cwd, signal, timeoutMs: 300_000 });
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

export async function rebaseOnto(cwd: string, baseSha: string): Promise<"clean" | "conflict"> {
  const result = await worktreeGit(
    ["git", "-c", "user.name=Limitless", "-c", "user.email=limitless@localhost", "rebase", baseSha],
    {
      cwd,
      allowFail: true,
    },
  );
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

/** Commit everything in the worktree. Returns the new sha, or null when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  if (worktreeGitScope.getStore() !== false) {
    const index = await worktreeGit(["git", "rev-parse", "--git-path", "index"], { cwd });
    rmSync(resolve(cwd, index.stdout.trim()), { force: true });
    await worktreeGit(["git", "read-tree", "HEAD"], { cwd });
  }
  await worktreeGit(["git", "add", "-A"], { cwd });
  const status = await worktreeGit(["git", "status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return null;
  await worktreeGit(["git", "commit", "--no-verify", "-q", "-m", message], { cwd });
  return headSha(cwd);
}

/** Move the worktree's branch back to a known commit, discarding everything after it. */
export async function resetTo(cwd: string, sha: string): Promise<void> {
  await worktreeGit(["git", "reset", "--hard", "-q", sha], { cwd });
  await worktreeGit(["git", "clean", "-fdq"], { cwd });
}

/** Throw away any uncommitted changes (used after read-only stages). */
/** `env` matters when the checkout's git config is untrusted: filters and drivers run with it. */
export async function discardChanges(cwd: string, env?: Record<string, string>): Promise<boolean> {
  const status = await worktreeGit(["git", "status", "--porcelain"], { cwd, env });
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
}

export async function diffSince(
  cwd: string,
  baseSha: string,
  env?: Record<string, string>,
  threeDot = false,
): Promise<DiffInfo> {
  const range = `${baseSha}${threeDot ? "..." : ".."}HEAD`;
  // Committed .gitmodules settings must not hide gitlinks from audit inputs.
  const diff = (...args: string[]) =>
    worktreeGit(["git", "diff", "--ignore-submodules=none", ...args], { cwd, env });
  const [patch, names, stat, numstat, raw] = await Promise.all([
    diff(range),
    diff("--name-status", range),
    diff("--stat", range),
    diff("--numstat", range),
    diff("--raw", "-z", "--no-renames", range),
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
  const changes: { path: string; from?: string }[] = [];
  const entries = raw.stdout.split("\0");
  for (let i = 0; i + 1 < entries.length; i += 2) {
    if (entries[i]?.split(" ")[1] === "160000") gitlinks.push(entries[i + 1] ?? "");
    const status = entries[i]?.split(" ").at(-1) ?? "";
    const path = entries[i + 1] ?? "";
    if (status.startsWith("D")) continue;
    changes.push({ path, ...(status.startsWith("A") ? {} : { from: path }) });
  }
  const revision = threeDot ? await mergeBase(cwd, baseSha, "HEAD") : baseSha;
  const inspection = await attributeInfo(cwd, env, range, revision, changes);
  return { patch: patch.stdout, files, stat: stat.stdout, added, removed, gitlinks, ...inspection };
}

const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize \d+\n$/;
/** Deadline for attribute queries and content classification; missing it blocks the audit. */
export const attributeLimits = { timeoutMs: 60_000 };

async function attributeInfo(
  cwd: string,
  env: Record<string, string> | undefined,
  range: string,
  base: string,
  changes: { path: string; from?: string }[],
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
  // Text means no NUL in the first 8,000 bytes. The explicit empty attribute source applies
  // even where worktreeGit is unhardened, so the run's own attributes cannot classify content.
  // The empty tree's id depends on the repository's object format (SHA-1 or SHA-256).
  let emptyTree: string | undefined;
  const textAt = async (tree: string, pathspecs: string[]) => {
    const text = new Set<string>();
    if (!pathspecs.length) return text;
    emptyTree ??= (await git(["hash-object", "-t", "tree", "--stdin"], "")).stdout.trim();
    const EMPTY_TREE = emptyTree;
    const args = ["--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", EMPTY_TREE, tree];
    const out = await git([
      `--attr-source=${EMPTY_TREE}`,
      "-c",
      NO_BIG_FILES,
      "diff",
      ...args,
      "--",
      ...pathspecs,
    ]);
    for (const entry of out.stdout.split("\0")) {
      const match = entry.match(/^(\d+)\t\d+\t([\s\S]+)$/);
      if (match?.[2]) text.add(match[2]);
    }
    // A Git LFS pointer, which `git lfs` commits for a tracked file, stands for binary content.
    const candidates = [...text].filter((path) => !path.includes("\n"));
    if (candidates.length) {
      const objects = candidates.map((path) => `${tree}:${path}\n`).join("");
      const sizes = (await git(["cat-file", "--batch-check=%(objectsize)"], objects)).stdout.split("\n");
      for (const [i, path] of candidates.entries()) {
        const size = Number(sizes[i]);
        if (!(size > 0 && size <= 200)) continue;
        if (LFS_POINTER.test((await git(["cat-file", "-p", `${tree}:${path}`])).stdout)) text.delete(path);
      }
    }
    return text;
  };
  const textAtEither = async (pathspecs: string[]) => [
    ...new Set([...(await textAt(base, pathspecs)), ...(await textAt("HEAD", pathspecs))]),
  ];
  try {
    // Attributes of a path edited in place only differ when an attribute file changed too.
    const queried = attributePatch ? changes : changes.filter((change) => change.from !== change.path);
    // Compare the same head path in both trees, even when that path did not exist at base.
    const sources = queried.map((change) => change.path);
    const [before, after] = await Promise.all([
      attributesAt(base, [...new Set(sources)]),
      attributesAt(
        "HEAD",
        queried.map((change) => change.path),
      ),
    ]);
    const baseOf = (from?: string) => (from === undefined ? undefined : before.get(from)) ?? {};
    const attributes = queried.map(({ path }) => ({
      path,
      base: baseOf(path),
      head: after.get(path) ?? {},
    }));
    const hidden = queried.filter(({ path }) => newlyHidden(baseOf(path), after.get(path) ?? {}).length);
    const literal = (paths: (string | undefined)[]) =>
      paths.flatMap((p) => (p === undefined ? [] : [`:(literal)${p}`]));
    const [textBefore, textAfter] = await Promise.all([
      textAt(base, literal(hidden.map((change) => change.from))),
      textAt("HEAD", literal(hidden.map((change) => change.path))),
    ]);
    const textPaths = hidden
      .filter(({ path, from }) => textAfter.has(path) || (from !== undefined && textBefore.has(from)))
      .map((change) => change.path);
    const attributeMatches: Record<string, string[]> = {};
    for (const rule of attributeRules(attributePatch))
      if (rule.exemptable) attributeMatches[rule.key] ??= await textAtEither([rule.pathspec]);
    return { attributePatch, attributes, textPaths, attributeMatches };
  } catch (error) {
    const reason = Date.now() >= deadline ? `timed out after ${timeoutMs} ms` : String(error).split("\n")[0];
    return { attributePatch, attributeErrors: [`attribute inspection ${reason}`] };
  }
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
  if (repo.kind === "local") {
    if (!repo.localPath) throw new Error("local repository path is missing");
    // Legacy worktrees already own the delivered branch in the source repository.
    if ((await worktreeOwner(cwd)) === (await worktreeOwner(repo.localPath))) return;
    // An earlier push may have landed before its delivery was recorded; the user may have built on it.
    const head = (await worktreeGit(["git", "rev-parse", `${sha}^{commit}`], { cwd, signal })).stdout.trim();
    if (await isAncestor(repo.localPath, head, `refs/heads/${branch}`)) return;
    // core.hooksPath doesn't cover config-defined hooks; blank the ones the source repository sees.
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
    const receiveHooks = (await emptyHookFlags(["git"], { cwd: repo.localPath, signal }))
      .map(quote)
      .join(" ");
    await worktreeGit(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--no-verify",
        // An explicit refspec doesn't disable push.followTags; deleted source tags must stay deleted.
        "--no-follow-tags",
        `--receive-pack=git -c core.hooksPath=/dev/null -c receive.denyCurrentBranch=refuse -c receive.autogc=false ${receiveHooks} receive-pack`,
        repo.localPath,
        `${sha}:refs/heads/${branch}`,
      ],
      {
        cwd,
        timeoutMs: 300_000,
        signal,
        env: { ...(process.env as Record<string, string>), LIMITLESS_GIT_EMPTY_HOOK: "" },
      },
    );
    return;
  }
  if (!repo.url) return;
  await remoteSh(["git", "push", "--force-with-lease", repo.url, `${sha}:refs/heads/${branch}`], {
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
  const remote = await remoteSh(["git", "ls-remote", repo.url, `refs/heads/${branch}`], {
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
  const remote = await remoteSh(["git", "ls-remote", repo.url, ref], { cwd, signal, budget });
  if (remote.stdout.split("\t")[0] !== baseSha) throw new Error("PR head moved since the run started");
  const ancestor = await worktreeGit(["git", "merge-base", "--is-ancestor", baseSha, "HEAD"], {
    cwd,
    allowFail: true,
    signal,
  });
  if (ancestor.exitCode !== 0) throw new Error("run result is not a descendant of the PR head");
  await remoteSh(["git", "push", `--force-with-lease=${ref}:${baseSha}`, repo.url, `HEAD:${ref}`], {
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
    const bare = await sh(["git", "rev-parse", "--is-bare-repository"], { cwd: cache });
    if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
    const check = () => sh(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: cache, allowFail: true });
    if ((await check()).exitCode !== 0) {
      await sh(["git", "fetch", "origin", sha], { cwd: cache, timeoutMs: 300_000 });
      if ((await check()).exitCode !== 0) throw new Error(`pinned commit ${sha} missing in ${slug}`);
    }
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
  const cleanup = async () => rmSync(path, { recursive: true, force: true });
  try {
    const pins = await stageEvalRepo(paths, store, slug, base, head, path, signal, labels, snapshot);
    const opts = { cwd: path, signal };
    await sh(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", pins[1]], opts);
    for (const ref of ["refs/eval/base", "refs/eval/head"]) await sh(["git", "update-ref", "-d", ref], opts);
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
    const [, head] = await stageEvalRepo(paths, store, slug, sha, sha, path, signal, labels, true);
    const tree = await sh(["git", "ls-tree", "--name-only", "-z", head], { cwd: path, signal });
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
    const opts = { cwd: cache, signal };
    const bare = await sh(["git", "rev-parse", "--is-bare-repository"], opts);
    if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
    const exists = async (sha: string) =>
      (await sh(["git", "cat-file", "-e", `${sha}^{commit}`], { ...opts, allowFail: true })).exitCode === 0;
    const missing = async () => {
      const absent: string[] = [];
      for (const sha of new Set([base, head])) if (!(await exists(sha))) absent.push(sha);
      return absent;
    };
    let absent = await missing();
    if (snapshot && absent.length) {
      // Like pinnedTree: fetch the exact pins, which may be reachable only from a tag.
      await sh(["git", "fetch", "origin", ...absent], { ...opts, timeoutMs: 300_000, allowFail: true });
      absent = await missing();
    }
    if (absent.length) {
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
      if (!(await exists(sha))) throw new Error(`pinned commit ${sha} missing in ${slug}`);
    signal.throwIfAborted();
    // A standalone repo holding only history reachable from the pins: a linked worktree
    // would share the cache's refs and objects, exposing later fixes and labeled datasets.
    mkdirSync(path, { recursive: true });
    await sh(["git", "init", "-q", path], opts);
    if (snapshot) pins = await pushSnapshot(cache, base, head, path, signal);
    else await sh(["git", "push", "-q", path, `${base}:refs/eval/base`, `${head}:refs/eval/head`], opts);
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
    await sh(["git", "init", "-q", staging], { cwd: cache, signal });
    const objects = (
      await sh(["git", "rev-parse", "--git-path", "objects"], { cwd: cache, signal })
    ).stdout.trim();
    writeFileSync(join(staging, ".git/objects/info/alternates"), `${resolve(cache, objects)}\n`);
    const opts = {
      cwd: staging,
      signal,
      env: { ...(process.env as Record<string, string>), ...SNAPSHOT_ENV },
    };
    const commit = async (sha: string, message: string, parent?: string) => {
      await sh(["git", "read-tree", `${sha}^{tree}`], opts);
      await sh(["git", "rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", "evals/"], opts);
      const tree = (await sh(["git", "write-tree"], opts)).stdout.trim();
      const args = ["git", "-c", "i18n.commitEncoding=UTF-8", "commit-tree", "--no-gpg-sign", tree];
      return (await sh([...args, ...(parent ? ["-p", parent] : []), "-m", message], opts)).stdout.trim();
    };
    const snapshotBase = await commit(base, "Snapshot base");
    const snapshotHead = await commit(head, "Snapshot head", snapshotBase);
    await sh(
      ["git", "push", "-q", path, `${snapshotBase}:refs/eval/base`, `${snapshotHead}:refs/eval/head`],
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
