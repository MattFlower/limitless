import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Paths } from "../config.ts";
import type { Repo } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { sh } from "../util/proc.ts";

const NO_PUSH = "no-push://limitless-agents-cannot-push";

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
  const view = await sh(["gh", "repo", "view", slug, "--json", "defaultBranchRef,sshUrl"], {
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

/** Make sure a fresh bare mirror exists (GitHub repos) and is fetched. */
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
        await sh(["git", "clone", "--bare", repo.url as string, tmp], {
          cwd: paths.repos,
          timeoutMs: 600_000,
          signal,
        });
        await sh(["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], {
          cwd: tmp,
          signal,
        });
        renameSync(tmp, cache);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    // Agents run inside worktrees of this repo; make any push attempt from them fail.
    await sh(["git", "config", "remote.origin.pushurl", NO_PUSH], { cwd: cache });
    await sh(["git", "fetch", "origin", "--prune"], { cwd: cache, timeoutMs: 300_000, signal });
    return cache;
  });
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
  const baseRef = repo.kind === "github" ? `origin/${baseBranch}` : baseBranch;
  if (existsSync(path)) {
    // Resuming an interrupted run: reuse the worktree as-is.
    const head = await sh(["git", "rev-parse", "HEAD"], { cwd: path });
    const base = await sh(["git", "rev-parse", baseRef], { cwd: cache });
    return { path, branch, baseSha: base.stdout.trim() || head.stdout.trim() };
  }
  return withRepoLock(cache, async () => {
    const base = await sh(["git", "rev-parse", baseRef], { cwd: cache });
    await sh(["git", "worktree", "add", "-b", branch, path, base.stdout.trim()], { cwd: cache });
    return { path, branch, baseSha: base.stdout.trim() };
  });
}

export async function removeWorktree(paths: Paths, repo: Repo, path: string): Promise<void> {
  if (!existsSync(path)) return;
  await sh(["git", "worktree", "remove", "--force", path], { cwd: cachePath(paths, repo), allowFail: true });
}

export async function headSha(cwd: string): Promise<string> {
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
}

export async function fetchBase(
  paths: Paths,
  repo: Repo,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const cache = cachePath(paths, repo);
  return withRepoLock(cache, async () => {
    const ref = `refs/heads/${branch}`;
    await sh(["git", "fetch", "origin", `+${ref}:refs/remotes/origin/${branch}`], {
      cwd: cache,
      timeoutMs: 300_000,
      signal,
    });
    return (
      await sh(["git", "rev-parse", `refs/remotes/origin/${branch}`], { cwd: cache, signal })
    ).stdout.trim();
  });
}

export async function readFileAt(
  cwd: string,
  revision: string,
  path: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const entry = await sh(["git", "ls-tree", "--name-only", revision, "--", path], { cwd, env });
  if (!entry.stdout.trim()) return null;
  return (await sh(["git", "show", `${revision}:${path}`], { cwd, env })).stdout;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await sh(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    allowFail: true,
  });
  return result.exitCode === 0;
}

export async function rebaseOnto(cwd: string, baseSha: string): Promise<"clean" | "conflict"> {
  const result = await sh(
    ["git", "-c", "user.name=Limitless", "-c", "user.email=limitless@localhost", "rebase", baseSha],
    {
      cwd,
      allowFail: true,
    },
  );
  if (result.exitCode === 0) return "clean";
  const state = await sh(["git", "rev-parse", "--git-path", "rebase-merge"], { cwd });
  const apply = await sh(["git", "rev-parse", "--git-path", "rebase-apply"], { cwd });
  if (!existsSync(resolve(cwd, state.stdout.trim())) && !existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error(`rebase failed: ${result.stderr || result.stdout}`);
  await sh(["git", "rebase", "--abort"], { cwd });
  if (existsSync(resolve(cwd, state.stdout.trim())) || existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error("rebase abort left worktree in rebase state");
  return "conflict";
}

export async function clearInterruptedRebase(cwd: string, expected: boolean): Promise<void> {
  const state = await sh(["git", "rev-parse", "--git-path", "rebase-merge"], { cwd });
  const apply = await sh(["git", "rev-parse", "--git-path", "rebase-apply"], { cwd });
  if (!existsSync(resolve(cwd, state.stdout.trim())) && !existsSync(resolve(cwd, apply.stdout.trim())))
    return;
  if (!expected) throw new Error("worktree has an unexpected rebase in progress");
  await sh(["git", "rebase", "--abort"], { cwd });
  if (existsSync(resolve(cwd, state.stdout.trim())) || existsSync(resolve(cwd, apply.stdout.trim())))
    throw new Error("interrupted rebase could not be aborted");
}

/** Commit everything in the worktree. Returns the new sha, or null when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await sh(["git", "add", "-A"], { cwd });
  const status = await sh(["git", "status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return null;
  await sh(["git", "commit", "--no-verify", "-q", "-m", message], { cwd });
  return headSha(cwd);
}

/** Move the worktree's branch back to a known commit, discarding everything after it. */
export async function resetTo(cwd: string, sha: string): Promise<void> {
  await sh(["git", "reset", "--hard", "-q", sha], { cwd });
  await sh(["git", "clean", "-fdq"], { cwd });
}

/** Throw away any uncommitted changes (used after read-only stages). */
/** `env` matters when the checkout's git config is untrusted: filters and drivers run with it. */
export async function discardChanges(cwd: string, env?: Record<string, string>): Promise<boolean> {
  const status = await sh(["git", "status", "--porcelain"], { cwd, env });
  if (!status.stdout.trim()) return false;
  await sh(["git", "reset", "--hard", "-q", "HEAD"], { cwd, env });
  await sh(["git", "clean", "-fdq"], { cwd, env });
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

export async function diffSince(
  cwd: string,
  baseSha: string,
  env?: Record<string, string>,
  threeDot = false,
): Promise<DiffInfo> {
  const range = `${baseSha}${threeDot ? "..." : ".."}HEAD`;
  const [patch, names, stat, numstat] = await Promise.all([
    sh(["git", "diff", range], { cwd, env }),
    sh(["git", "diff", "--name-status", range], { cwd, env }),
    sh(["git", "diff", "--stat", range], { cwd, env }),
    sh(["git", "diff", "--numstat", range], { cwd, env }),
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
): Promise<void> {
  if (repo.kind !== "github" || !repo.url) return;
  await sh(["git", "push", "--force-with-lease", repo.url, `${sha}:refs/heads/${branch}`], {
    cwd,
    timeoutMs: 300_000,
    signal,
  });
}

export async function remoteBranchSha(
  repo: Repo,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (repo.kind !== "github" || !repo.url) return null;
  const remote = await sh(["git", "ls-remote", repo.url, `refs/heads/${branch}`], { cwd, signal });
  return remote.stdout.split("\t")[0] || null;
}

/** Update an existing PR head only if it still points at the commit we prepared from. */
export async function pushExistingBranch(
  repo: Repo,
  cwd: string,
  branch: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<void> {
  if (repo.kind !== "github" || !repo.url) throw new Error("existing PR delivery requires a GitHub repo");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/"))
    throw new Error("invalid PR head branch");
  const ref = `refs/heads/${branch}`;
  const remote = await sh(["git", "ls-remote", repo.url, ref], { cwd, signal });
  if (remote.stdout.split("\t")[0] !== baseSha) throw new Error("PR head moved since the run started");
  const ancestor = await sh(["git", "merge-base", "--is-ancestor", baseSha, "HEAD"], {
    cwd,
    allowFail: true,
    signal,
  });
  if (ancestor.exitCode !== 0) throw new Error("run result is not a descendant of the PR head");
  await sh(["git", "push", `--force-with-lease=${ref}:${baseSha}`, repo.url, `HEAD:${ref}`], {
    cwd,
    timeoutMs: 300_000,
    signal,
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
  },
): Promise<string> {
  const existing = await sh(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repo.slug,
      "--head",
      opts.branch,
      "--state",
      "all",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ],
    { cwd: opts.cwd, allowFail: true, signal: opts.signal },
  );
  if (existing.stdout.trim()) {
    await sh(["gh", "pr", "edit", existing.stdout.trim(), "--body-file", "-"], {
      cwd: opts.cwd,
      stdin: opts.body,
      allowFail: true,
      signal: opts.signal,
    });
    return existing.stdout.trim();
  }
  const res = await sh(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      repo.slug,
      "--head",
      opts.branch,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body-file",
      "-",
      ...(opts.draft ? ["--draft"] : []),
    ],
    { cwd: opts.cwd, stdin: opts.body, signal: opts.signal },
  );
  const url = res.stdout.trim().split("\n").pop() ?? "";
  if (!url.startsWith("http")) throw new Error(`gh pr create returned unexpected output: ${res.stdout}`);
  return url;
}

/** Merge now if possible; if branch protection requires checks, enable auto-merge instead. */
export async function mergePullRequest(
  prUrl: string,
  cwd: string,
  title?: string,
  signal?: AbortSignal,
): Promise<"merged" | "auto" | "failed"> {
  // Squash with the PR title as the subject, not the first round's commit message.
  const number = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const subject = title ? ["--subject", number ? `${title} (#${number})` : title] : [];
  const now = await sh(["gh", "pr", "merge", prUrl, "--squash", "--delete-branch", ...subject], {
    cwd,
    allowFail: true,
    signal,
  });
  if (now.exitCode === 0) return "merged";
  const auto = await sh(["gh", "pr", "merge", prUrl, "--squash", "--auto", "--delete-branch", ...subject], {
    cwd,
    allowFail: true,
    signal,
  });
  return auto.exitCode === 0 ? "auto" : "failed";
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
  const cleanup = async () => rmSync(path, { recursive: true, force: true });
  let pins: [string, string] = [base, head];
  try {
    await withRepoLock(cache, async () => {
      signal.throwIfAborted();
      const opts = { cwd: cache, signal };
      const bare = await sh(["git", "rev-parse", "--is-bare-repository"], opts);
      if (bare.stdout.trim() !== "true") throw new Error(`eval repository cache is not bare: ${cache}`);
      const exists = async (sha: string) =>
        (await sh(["git", "cat-file", "-e", `${sha}^{commit}`], { ...opts, allowFail: true })).exitCode === 0;
      if (!(await exists(base)) || !(await exists(head))) {
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
    const opts = { cwd: path, signal };
    await rejectContamination(path, labels, signal);
    await sh(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", pins[1]], opts);
    for (const ref of ["refs/eval/base", "refs/eval/head"]) await sh(["git", "update-ref", "-d", ref], opts);
    await sh(["git", "reflog", "expire", "--expire=now", "--all"], opts);
    return Object.assign(cleanup, { base: pins[0] });
  } catch (error) {
    await cleanup();
    throw error;
  }
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
