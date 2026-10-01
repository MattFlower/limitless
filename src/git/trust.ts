import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sh } from "../util/proc.ts";

/** Candidate-controlled settings that would run its code or hide changes from factory git calls. */
export const HARDENED = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.attributesFile=/dev/null",
] as const;
/** Diff and log output must come from git itself, never a configured driver. */
export const RAW_DIFF = ["--no-ext-diff", "--no-textconv"] as const;

/** Every factory git call goes through here; options (env, signal, timeout, ...) pass through unchanged. */
export function git(args: string[], opts: Parameters<typeof sh>[1]) {
  return sh(["git", ...HARDENED, ...args], opts);
}

/** Factory-owned git metadata of one checkout, captured before any agent or repository code ran. */
export interface GitTrust {
  gitDir: string;
  commonDir: string;
  /** Contents of a linked worktree's `.git` file and its `commondir`; null for a standalone repo. */
  dotGit: string | null;
  commondir: string | null;
  config: string;
  /** A linked worktree's own `config.worktree` (null when absent), effective with extensions.worktreeConfig. */
  configWorktree: string | null;
  /** A factory-maintained copy of a shared cache's config, read at restore time instead of `config`. */
  sharedConfig?: string;
  attributes: string | null;
  /** Hooks and info/attributes belong to the factory and are emptied (not a user's own repository). */
  owned: boolean;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Replace (never write through) a file, so a candidate symlink or directory there is discarded. */
function put(path: string, content: string | null) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (content === null ? !stat : stat?.isFile() && read(path) === content) return;
  rmSync(path, { recursive: true, force: true });
  if (content === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Reset a factory-owned repository's config, and empty its hooks and info/attributes. */
export function restoreOwned(commonDir: string, config: string): void {
  put(join(commonDir, "config"), config);
  put(join(commonDir, "info", "attributes"), null);
  rmSync(join(commonDir, "hooks"), { recursive: true, force: true });
  mkdirSync(join(commonDir, "hooks"));
}

export async function captureTrust(cwd: string, owned: boolean, sharedConfig?: string): Promise<GitTrust> {
  const rev = async (flag: string) =>
    realpathSync(resolve(cwd, (await git(["rev-parse", flag], { cwd })).stdout.trim()));
  const gitDir = await rev("--absolute-git-dir");
  const commonDir = await rev("--git-common-dir");
  const linked = gitDir !== commonDir;
  const config = read(join(commonDir, "config"));
  if (config === null) throw new Error(`git config unreadable in ${commonDir}`);
  return {
    gitDir,
    commonDir,
    dotGit: linked ? read(join(cwd, ".git")) : null,
    commondir: linked ? read(join(gitDir, "commondir")) : null,
    config,
    configWorktree: read(join(gitDir, "config.worktree")),
    ...(sharedConfig ? { sharedConfig } : {}),
    attributes: owned ? null : read(join(commonDir, "info", "attributes")),
    owned,
  };
}

/**
 * Put back the factory's git metadata before the factory inspects, stages or cleans a checkout:
 * config, hooks, info/attributes and index flags that would hide tracked edits from status and commit.
 */
export async function restoreTrust(cwd: string, trust: GitTrust, signal?: AbortSignal): Promise<void> {
  const dotGit = join(cwd, ".git");
  if (trust.dotGit === null) {
    const stat = lstatSync(dotGit, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || realpathSync(dotGit) !== trust.gitDir)
      throw new Error(`git metadata of ${cwd} was replaced`);
  } else {
    put(dotGit, trust.dotGit);
    put(join(trust.gitDir, "commondir"), trust.commondir);
  }
  const config = trust.sharedConfig ? read(trust.sharedConfig) : trust.config;
  if (config === null) throw new Error(`trusted git config missing: ${trust.sharedConfig}`);
  put(join(trust.gitDir, "config.worktree"), trust.configWorktree);
  if (trust.owned) restoreOwned(trust.commonDir, config);
  else {
    put(join(trust.commonDir, "config"), config);
    put(join(trust.commonDir, "info", "attributes"), trust.attributes);
  }
  const entries = (await git(["ls-files", "-v", "-z"], { cwd, signal })).stdout.split("\0").filter(Boolean);
  // Lowercase tags are assume-unchanged, S/s skip-worktree. update-index honours only one such flag per call.
  for (const [flag, test] of [
    ["--no-assume-unchanged", /^[a-z]/],
    ["--no-skip-worktree", /^[sS]/],
  ] as const) {
    const paths = entries.filter((entry) => test.test(entry)).map((entry) => entry.slice(2));
    if (paths.length)
      await git(["update-index", "-z", flag, "--stdin"], { cwd, signal, stdin: paths.join("\0") });
  }
}

const trusted = new Map<string, GitTrust | Error>();

/** Register a checkout's trusted state; an Error makes every later restoration fail with it. */
export function trustCheckout(cwd: string, trust: GitTrust | Error): void {
  trusted.set(resolve(cwd), trust);
}

export function forgetCheckout(cwd: string): void {
  trusted.delete(resolve(cwd));
}

/** Restore a registered checkout. `required` fails for unregistered ones (grading needs a baseline). */
export async function restoreCheckout(cwd: string, signal?: AbortSignal, required = false): Promise<void> {
  const trust = trusted.get(resolve(cwd));
  if (trust instanceof Error) throw trust;
  if (trust) await restoreTrust(cwd, trust, signal);
  else if (required) throw new Error(`no trusted git state recorded for ${cwd}`);
}

export function saveTrust(file: string, trust: GitTrust): void {
  writeFileSync(file, JSON.stringify(trust));
}

export function loadTrust(file: string): GitTrust | Error {
  const text = read(file);
  if (text === null) return new Error(`trusted git state missing: ${file}`);
  try {
    const trust = JSON.parse(text) as GitTrust;
    if (
      typeof trust.config !== "string" ||
      !(typeof trust.configWorktree === "string" || trust.configWorktree === null) ||
      typeof trust.gitDir !== "string" ||
      typeof trust.commonDir !== "string"
    )
      throw new Error("incomplete");
    return trust;
  } catch (error) {
    return new Error(`trusted git state unusable: ${file}: ${(error as Error).message}`);
  }
}
