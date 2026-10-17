import { strict as assert } from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CommandError, sh } from "../util/proc.ts";
import { gitSh } from "./confinement.ts";
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
  // Resets and checkouts must not enter nested repositories with independent filters.
  "-c",
  "submodule.recurse=false",
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
  // Only the factory has written this repository; record paths before exposing it to an agent.
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
  // implement commits), so Git may rename or remove its own lock file between the listing and lstat.
  // Only these top-level locks may vanish: Git creates them exclusively, so one recreated after the
  // check makes Git refuse rather than read it. Any other missing entry (including reftable data that
  // happens to end in .lock) still fails. The inspection validates the directory as it is when it
  // runs; only factory Git writes here, and a concurrent writer could change it after this returns.
  const disposable = /^(?:HEAD|ORIG_HEAD|index)\.lock$/;
  const inspect = (path: string) => {
    const lock = dirname(path) === admin && disposable.test(basename(path));
    const stat = lstatSync(path, { throwIfNoEntry: !lock });
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
export const worktreeGit = (cmd: string[], opts: Parameters<typeof sh>[1], retryClean = false) =>
  runGit(cmd, opts, retryClean, gitSh);

/** Only factory-owned repositories and remote transports; never a checkout dirty check. */
export const cacheGit = (cmd: string[], opts: Parameters<typeof sh>[1]) => runGit(cmd, opts, false, sh);

async function runGit(
  cmd: string[],
  opts: Parameters<typeof sh>[1],
  retryClean: boolean,
  execute: typeof sh,
) {
  const run = async (cmd: string[], opts: Parameters<typeof sh>[1]) => {
    try {
      return await execute(cmd, opts);
    } catch (error) {
      if (
        !retryClean ||
        cmd.at(-2) !== "clean" ||
        cmd.at(-1) !== "-ffdxq" ||
        !(error instanceof CommandError)
      )
        throw error;
      try {
        return await execute(cmd, opts);
      } catch (retryError) {
        if (!(retryError instanceof CommandError)) throw retryError;
        throw new WorktreeCleanError(retryError.message, { cause: retryError });
      }
    }
  };
  if (worktreeGitScope.getStore() === false) {
    execute = sh;
    return run(cmd, opts);
  }
  opts.signal?.throwIfAborted();
  opts = { ...opts, env: trustedEnv(opts.cwd, opts.env ?? (process.env as Record<string, string>)) };
  // Not bound to the first caller's signal: an aborted first call must not fail every later one.
  gitVersion ??= execute(["git", "--version"], { ...opts, signal: undefined, allowFail: false })
    .then(({ stdout }) => {
      const version = stdout.match(/^git version (\d+)\.(\d+)/);
      if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 40))
        throw new Error(`Limitless requires Git >= 2.40 for --attr-source; found ${stdout.trim()}`);
    })
    .catch((error) => {
      gitVersion = undefined;
      throw error;
    });
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
  const { hooks, emptyTree } = await harden(prefix, opts, () => hookKeys(prefix, opts, execute), execute);
  prefix.push(...hookFlags(hooks));
  // Signing and signature display run gpg or ssh-keygen, which the confinement profile denies.
  prefix.push("-c", "commit.gpgSign=false", "-c", "log.showSignature=false");
  const env = {
    ...(opts.env ?? (process.env as Record<string, string>)),
    LIMITLESS_GIT_EMPTY_HOOK: "",
  };
  if (
    ["merge", "rebase"].includes(cmd[command] ?? "") &&
    !cmd.slice(command + 1).some((arg) => arg === "--abort" || arg === "--quit")
  ) {
    try {
      await refusePopulatedRepositories(
        prefix,
        { ...opts, env },
        cmd.slice(command + 1).filter((arg) => !arg.startsWith("-")),
        execute,
      );
    } catch (error) {
      // Let callers classify failed Git inspection; safety refusals still throw with allowFail.
      if (!opts.allowFail || !(error instanceof CommandError)) throw error;
      return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
    }
  }
  const inspection = ["diff", "log"].includes(cmd[command] ?? "");
  if (inspection) {
    // Attributes from the empty tree, whose id depends on the repository's object format.
    const empty = emptyTree ?? (await hashEmptyTree(prefix, { ...opts, env }, execute));
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
  // Nested repositories have their own filters, which parent config discovery cannot suppress.
  // Explicit commit-range --ignore-submodules=none flags below still expose gitlinks to the audit.
  if (["status", "diff"].includes(cmd[command] ?? "")) flags.push("--ignore-submodules=dirty");
  return run([...prefix, ...cmd.slice(command, command + 1), ...flags, ...cmd.slice(command + 1)], {
    ...opts,
    env,
  });
}

/** Internal merge/rebase dirty checks cannot safely inspect agent-created repositories. */
async function refusePopulatedRepositories(
  git: string[],
  opts: Parameters<typeof sh>[1],
  targets: string[],
  execute: typeof sh,
): Promise<void> {
  const index = await execute([...git, "ls-files", "--stage", "-z"], { ...opts, allowFail: false });
  let entries = index.stdout;
  for (const revision of new Set(["HEAD", ...targets]))
    entries += (await execute([...git, "ls-tree", "-r", "-z", revision], { ...opts, allowFail: false }))
      .stdout;
  const gitlinks = new Set(
    entries
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );
  // Output is decoded as UTF-8: a name with invalid bytes no longer names the path git inspects.
  if ([...gitlinks].some((path) => path.includes("\uFFFD")))
    throw new Error("Cannot inspect the checkout for nested repositories");
  for (const path of gitlinks) {
    let populated: boolean;
    try {
      const full = join(opts.cwd, path);
      populated =
        statSync(full, { throwIfNoEntry: false })?.isDirectory() === true &&
        (lstatSync(join(full, ".git"), { throwIfNoEntry: false }) !== undefined ||
          readdirSync(full).length > 0);
    } catch {
      throw new Error("Cannot inspect the checkout for nested repositories");
    }
    if (populated) throw new Error("Cannot run merge or rebase with a populated nested repository");
  }
}

/** Stage paths directly: `add` otherwise runs status inside unchanged populated repositories. */
export async function stageAll(opts: Parameters<typeof sh>[1], forcePaths: string[] = []): Promise<void> {
  if (worktreeGitScope.getStore() === false) {
    await worktreeGit(["git", "add", "-A"], opts);
    return;
  }
  // Remove obsolete paths before adding replacements; update-index cannot traverse a new symlink
  // or stage a directory in place of the old file. diff-files honors the index's skip/assume flags.
  const deleted = await worktreeGit(
    ["git", "diff-files", "--ignore-submodules=dirty", "--diff-filter=D", "--name-only", "-z"],
    opts,
  );
  const removed = new Set(deleted.stdout.split("\0").filter(Boolean));
  const files = await worktreeGit(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-v", "-z"],
    opts,
  );
  // Preserve add's skip-worktree/assume-unchanged promises; strip tags and repository trailing slashes.
  const paths = files.stdout
    .split("\0")
    .filter((entry) => entry.length > 0 && !/^[a-zS] /.test(entry))
    .filter((entry) => entry.startsWith("? ") || !removed.has(entry.slice(2)))
    .map((entry) => entry.slice(2).replace(/\/$/, ""));
  if (deleted.stdout)
    await worktreeGit(["git", "update-index", "--force-remove", "-z", "--stdin"], {
      ...opts,
      stdin: deleted.stdout,
    });
  // A file replaced by a repository may be absent from diff-files when submodules are ignored.
  // update-index only recognizes the replacement as a gitlink after the old entry is removed.
  for (const path of new Set([...paths, ...removed]))
    if (
      existsSync(join(opts.cwd, path)) &&
      lstatSync(join(opts.cwd, path), { throwIfNoEntry: false })?.isDirectory() &&
      lstatSync(join(opts.cwd, path, ".git"), { throwIfNoEntry: false })
    ) {
      await worktreeGit(["git", "update-index", "--force-remove", "--", path], opts);
      paths.push(path);
    }
  const input = [...new Set([...paths, ...forcePaths.filter((path) => !removed.has(path))])].join("\0");
  if (input)
    await worktreeGit(["git", "update-index", "--add", "--remove", "--replace", "-z", "--stdin"], {
      ...opts,
      stdin: `${input}\0`,
    });
}

/** The empty tree's id in `opts.cwd`'s object format, as `worktreeGit` passes it to `--attr-source`. */
export async function emptyTreeId(opts: Parameters<typeof sh>[1]): Promise<string> {
  const execute = gitSh;
  if (worktreeGitScope.getStore() === false) return hashEmptyTree(["git"], opts, sh);
  opts = { ...opts, env: trustedEnv(opts.cwd, opts.env ?? (process.env as Record<string, string>)) };
  const prefix = ["git", ...HARDENING];
  const { emptyTree } = await harden(prefix, opts, () => hookKeys(prefix, opts, execute), execute);
  return emptyTree ?? hashEmptyTree(prefix, opts);
}

async function hashEmptyTree(
  git: string[],
  opts: Parameters<typeof sh>[1],
  execute = gitSh,
): Promise<string> {
  const empty = await execute([...git, "hash-object", "-t", "tree", "--stdin"], {
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

async function hookKeys(git: string[], opts: Parameters<typeof sh>[1], execute = gitSh): Promise<string[]> {
  // Config lookup cannot run hooks; errors other than "no matching keys" must fail closed.
  const hooks = await execute(
    [...git, "config", "--null", "--name-only", "--get-regexp", "^(hook|filter)\\."],
    {
      ...opts,
      allowFail: false,
    },
  ).catch((error: unknown) => {
    if (error instanceof CommandError && error.exitCode === 1) return { stdout: "" };
    throw error;
  });
  return hooks.stdout.split("\0").filter(Boolean);
}

// --config-env splits at the last '=', so hook subsection names may themselves contain '='.
const hookFlags = (keys: string[]) =>
  [...new Set(keys)].map((key) => `--config-env=${key}=LIMITLESS_GIT_EMPTY_HOOK`);
