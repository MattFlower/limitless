import { strict as assert } from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CommandError, sh } from "../util/proc.ts";
import { harden } from "./hardening.ts";

/** Each pipeline run has its own scope; `false` opts out of the hardened git wrapper. */
export const worktreeGitScope = new AsyncLocalStorage<boolean>();
let gitVersion: Promise<void> | undefined;
/** Large files are otherwise reported as binary whatever their content. */
export const NO_BIG_FILES = "core.bigFileThreshold=9223372036854775807";
const SEPARATE_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const HARDENING = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.useReplaceRefs=false",
  // A forged commit-graph or pack bitmap could change which parents a scan sees or what a push sends.
  "-c",
  "core.commitGraph=false",
  "-c",
  "pack.useBitmaps=false",
];

/** Recorded before candidate execution; the sidecar is outside the writable checkout. */
export async function recordWorktree(cwd: string): Promise<void> {
  const cmd = ["git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"];
  const r = await sh(cmd, { cwd });
  const dirs = [cwd, ...r.stdout.trim().split("\n")].map((p) => realpathSync(p));
  writeFileSync(`${resolve(cwd)}.git-paths`, JSON.stringify(dirs));
}

// Planted grafts or shallow files could hide ancestry from scans that get pushed. "/dev/null/none"
// can't exist, so it disables grafts without git's deprecation hint for an existing graft file.
const NO_PARENT_REWRITES = { GIT_GRAFT_FILE: "/dev/null/none", GIT_SHALLOW_FILE: "" };
function trustedEnv(cwd: string, env: Record<string, string>) {
  const record = `${resolve(cwd)}.git-paths`;
  if (!existsSync(record)) {
    if (lstatSync(join(cwd, ".git"), { throwIfNoEntry: false })?.isDirectory() === false)
      throw new Error("Missing trusted Git paths");
    return { ...env, ...NO_PARENT_REWRITES };
  }
  const path = z.string().startsWith("/");
  const [work, admin, common] = z.tuple([path, path, path]).parse(JSON.parse(readFileSync(record, "utf8")));
  const unsafe = "Unsafe worktree Git administration";
  // Factory commands can share a worktree concurrently (the holdout exports its base snapshot while
  // implement commits), so Git may rename or remove its own lock file (HEAD.lock, index.lock) between
  // the listing and lstat. An entry that is gone cannot be used; everything still present is checked.
  const inspect = (path: string) => {
    const stat = lstatSync(path, { throwIfNoEntry: path === admin });
    if (!stat) return;
    assert(path === admin || !/\/config(?:\.worktree)?$/.test(path), unsafe);
    assert(stat.isDirectory() || (stat.isFile() && stat.nlink === 1), unsafe);
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(admin);
  assert(realpathSync(cwd) === work && lstatSync(admin).isDirectory(), unsafe);
  for (const [name, target] of Object.entries({ commondir: common, gitdir: join(work, ".git") }))
    assert(resolve(admin, readFileSync(join(admin, name), "utf8").trim()) === target, unsafe);
  return { ...env, GIT_DIR: admin, GIT_COMMON_DIR: common, GIT_WORK_TREE: work, ...NO_PARENT_REWRITES };
}

export class WorktreeCleanError extends Error {}

/** Factory commands in agent-controlled worktrees, without changing any config files. */
export async function worktreeGit(cmd: string[], opts: Parameters<typeof sh>[1], retryClean = false) {
  const run = async (cmd: string[], opts: Parameters<typeof sh>[1]) => {
    try {
      return await sh(cmd, opts);
    } catch (error) {
      if (
        !retryClean ||
        cmd.at(-2) !== "clean" ||
        cmd.at(-1) !== "-ffdxq" ||
        !(error instanceof CommandError)
      )
        throw error;
      try {
        return await sh(cmd, opts);
      } catch (retryError) {
        if (!(retryError instanceof CommandError)) throw retryError;
        throw new WorktreeCleanError(retryError.message, { cause: retryError });
      }
    }
  };
  if (worktreeGitScope.getStore() === false) return run(cmd, opts);
  opts.signal?.throwIfAborted();
  opts = { ...opts, env: trustedEnv(opts.cwd, opts.env ?? (process.env as Record<string, string>)) };
  // Not bound to the first caller's signal: an aborted first call must not fail every later one.
  gitVersion ??= sh(["git", "--version"], { ...opts, signal: undefined, allowFail: false }).then(
    ({ stdout }) => {
      const version = stdout.match(/^git version (\d+)\.(\d+)/);
      if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 40))
        throw new Error(`Limitless requires Git >= 2.40 for --attr-source; found ${stdout.trim()}`);
    },
  );
  await gitVersion;
  let command = 1;
  // Leading global options stay before the injected ones: `-c key=value` pairs and single-token
  // `--opt=value` forms only. An option taking a separate value would swallow an injected flag.
  while (cmd[command]?.startsWith("-")) {
    if (SEPARATE_VALUE_OPTIONS.has(cmd[command] ?? ""))
      throw new Error(`worktreeGit: pass ${cmd[command]} as a single --opt=value token`);
    command += cmd[command] === "-c" ? 2 : 1;
  }
  const prefix = [...cmd.slice(0, command), ...HARDENING];
  // Discover includes, worktree, global, system and environment config with the same options.
  const { hooks, emptyTree } = await harden(prefix, opts, () => hookKeys(prefix, opts));
  prefix.push(...hookFlags(hooks));
  const env = { ...(opts.env ?? (process.env as Record<string, string>)), LIMITLESS_GIT_EMPTY_HOOK: "" };
  const inspection = ["diff", "log"].includes(cmd[command] ?? "");
  if (inspection) {
    // Attributes from the empty tree, whose id depends on the repository's object format.
    const empty = emptyTree ?? (await hashEmptyTree(prefix, { ...opts, env }));
    prefix.push(`--attr-source=${empty}`);
    // Patch text is parsed by the audit, so repository config must not change its format.
    const canonical = ["color.ui=never", "color.diff=never", "diff.submodule=short", NO_BIG_FILES].concat(
      ["noprefix", "mnemonicPrefix", "relative"].map((key) => `diff.${key}=false`),
    );
    prefix.push(...canonical.flatMap((c) => ["-c", c]));
  }
  const indicators = ["new=+", "old=-", "context= "].map((value) => `--output-indicator-${value}`);
  const format = ["--no-color", "--src-prefix=a/", "--dst-prefix=b/", ...indicators];
  const flags = inspection ? ["--no-ext-diff", "--no-textconv", ...format] : [];
  return run([...prefix, ...cmd.slice(command, command + 1), ...flags, ...cmd.slice(command + 1)], {
    ...opts,
    env,
  });
}

/** The empty tree's id in `opts.cwd`'s object format, as `worktreeGit` passes it to `--attr-source`. */
export async function emptyTreeId(opts: Parameters<typeof sh>[1]): Promise<string> {
  if (worktreeGitScope.getStore() === false) return hashEmptyTree(["git"], opts);
  opts = { ...opts, env: trustedEnv(opts.cwd, opts.env ?? (process.env as Record<string, string>)) };
  const prefix = ["git", ...HARDENING];
  const { emptyTree } = await harden(prefix, opts, () => hookKeys(prefix, opts));
  return emptyTree ?? hashEmptyTree(prefix, opts);
}

async function hashEmptyTree(git: string[], opts: Parameters<typeof sh>[1]): Promise<string> {
  const empty = await sh([...git, "hash-object", "-t", "tree", "--stdin"], {
    ...opts,
    stdin: "",
    allowFail: false,
  });
  return empty.stdout.trim();
}

/**
 * Flags blanking every config-defined hook and filter driver git sees as `git` in `opts.cwd`; needs
 * LIMITLESS_GIT_EMPTY_HOOK="". An empty clean/smudge/process runs nothing and an empty `required`
 * is false, so what is committed or checked out is exactly the bytes, whatever attributes select.
 */
export async function emptyHookFlags(git: string[], opts: Parameters<typeof sh>[1]): Promise<string[]> {
  return hookFlags(await hookKeys(git, opts));
}

async function hookKeys(git: string[], opts: Parameters<typeof sh>[1]): Promise<string[]> {
  // Config lookup cannot run hooks; errors other than "no matching keys" must fail closed.
  const hooks = await sh([...git, "config", "--null", "--name-only", "--get-regexp", "^(hook|filter)\\."], {
    ...opts,
    allowFail: false,
  }).catch((error: unknown) => {
    if (error instanceof CommandError && error.exitCode === 1) return { stdout: "" };
    throw error;
  });
  return hooks.stdout.split("\0").filter(Boolean);
}

// --config-env splits at the last '=', so hook subsection names may themselves contain '='.
const hookFlags = (keys: string[]) =>
  [...new Set(keys)].map((key) => `--config-env=${key}=LIMITLESS_GIT_EMPTY_HOOK`);
