import { existsSync, mkdirSync, renameSync } from "node:fs";
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
export async function ensureCache(paths: Paths, repo: Repo): Promise<string> {
  const cache = cachePath(paths, repo);
  if (repo.kind === "local") return cache;
  return withRepoLock(cache, async () => {
    if (!existsSync(cache)) {
      mkdirSync(paths.repos, { recursive: true });
      // Clone to a temporary path and rename, so a crash never leaves a half-configured cache.
      const tmp = `${cache}.tmp-${process.pid}-${Date.now()}`;
      await sh(["git", "clone", "--bare", repo.url as string, tmp], { cwd: paths.repos, timeoutMs: 600_000 });
      await sh(["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: tmp });
      renameSync(tmp, cache);
    }
    // Agents run inside worktrees of this repo; make any push attempt from them fail.
    await sh(["git", "config", "remote.origin.pushurl", NO_PUSH], { cwd: cache });
    await sh(["git", "fetch", "origin", "--prune"], { cwd: cache, timeoutMs: 300_000 });
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

/** Commit everything in the worktree. Returns the new sha, or null when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await sh(["git", "add", "-A"], { cwd });
  const status = await sh(["git", "status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return null;
  await sh(["git", "commit", "--no-verify", "-q", "-m", message], { cwd });
  return headSha(cwd);
}

/** Throw away any uncommitted changes (used after read-only stages). */
export async function discardChanges(cwd: string): Promise<boolean> {
  const status = await sh(["git", "status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return false;
  await sh(["git", "reset", "--hard", "-q", "HEAD"], { cwd });
  await sh(["git", "clean", "-fdq"], { cwd });
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

export async function diffSince(cwd: string, baseSha: string): Promise<DiffInfo> {
  const [patch, names, stat, numstat] = await Promise.all([
    sh(["git", "diff", `${baseSha}..HEAD`], { cwd }),
    sh(["git", "diff", "--name-status", `${baseSha}..HEAD`], { cwd }),
    sh(["git", "diff", "--stat", `${baseSha}..HEAD`], { cwd }),
    sh(["git", "diff", "--numstat", `${baseSha}..HEAD`], { cwd }),
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

export async function pushBranch(repo: Repo, cwd: string, branch: string): Promise<void> {
  if (repo.kind !== "github" || !repo.url) return;
  await sh(["git", "push", "--force-with-lease", repo.url, `HEAD:refs/heads/${branch}`], {
    cwd,
    timeoutMs: 300_000,
  });
}

export async function createPullRequest(
  repo: Repo,
  opts: { branch: string; base: string; title: string; body: string; cwd: string; draft?: boolean },
): Promise<string> {
  const existing = await sh(
    ["gh", "pr", "list", "--repo", repo.slug, "--head", opts.branch, "--json", "url", "--jq", ".[0].url"],
    { cwd: opts.cwd, allowFail: true },
  );
  if (existing.stdout.trim()) {
    await sh(["gh", "pr", "edit", existing.stdout.trim(), "--body-file", "-"], {
      cwd: opts.cwd,
      stdin: opts.body,
      allowFail: true,
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
    { cwd: opts.cwd, stdin: opts.body },
  );
  const url = res.stdout.trim().split("\n").pop() ?? "";
  if (!url.startsWith("http")) throw new Error(`gh pr create returned unexpected output: ${res.stdout}`);
  return url;
}

/** Merge now if possible; if branch protection requires checks, enable auto-merge instead. */
export async function mergePullRequest(prUrl: string, cwd: string): Promise<"merged" | "auto" | "failed"> {
  const now = await sh(["gh", "pr", "merge", prUrl, "--squash", "--delete-branch"], { cwd, allowFail: true });
  if (now.exitCode === 0) return "merged";
  const auto = await sh(["gh", "pr", "merge", prUrl, "--squash", "--auto", "--delete-branch"], {
    cwd,
    allowFail: true,
  });
  return auto.exitCode === 0 ? "auto" : "failed";
}
