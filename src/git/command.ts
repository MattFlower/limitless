import { AsyncLocalStorage } from "node:async_hooks";
import { CommandError, sh } from "../util/proc.ts";

/** Each pipeline run has its own scope; `false` opts out of the hardened git wrapper. */
export const worktreeGitScope = new AsyncLocalStorage<boolean>();
let gitVersion: Promise<void> | undefined;
/** Large files are otherwise reported as binary whatever their content. */
export const NO_BIG_FILES = "core.bigFileThreshold=9223372036854775807";
const SEPARATE_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

/** Factory commands in agent-controlled worktrees, without changing any config files. */
export async function worktreeGit(cmd: string[], opts: Parameters<typeof sh>[1]) {
  if (worktreeGitScope.getStore() === false) return sh(cmd, opts);
  opts.signal?.throwIfAborted();
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
  const prefix = [
    ...cmd.slice(0, command),
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
  ];
  // Discover includes, worktree, global, system and environment config with the same options.
  prefix.push(...(await emptyHookFlags(prefix, opts)));
  const env = { ...(opts.env ?? (process.env as Record<string, string>)), LIMITLESS_GIT_EMPTY_HOOK: "" };
  const inspection = ["diff", "log"].includes(cmd[command] ?? "");
  if (inspection) {
    // Attributes from the empty tree, whose id depends on the repository's object format.
    const empty = await sh([...prefix, "hash-object", "-t", "tree", "--stdin"], {
      ...opts,
      env,
      stdin: "",
      allowFail: false,
    });
    prefix.push(`--attr-source=${empty.stdout.trim()}`);
    // Patch text is parsed by the audit, so repository config must not change its format.
    const canonical = ["color.ui=never", "color.diff=never", "diff.submodule=short", NO_BIG_FILES].concat(
      ["noprefix", "mnemonicPrefix", "relative"].map((key) => `diff.${key}=false`),
    );
    prefix.push(...canonical.flatMap((c) => ["-c", c]));
  }
  const indicators = ["new=+", "old=-", "context= "].map((value) => `--output-indicator-${value}`);
  const format = ["--no-color", "--src-prefix=a/", "--dst-prefix=b/", ...indicators];
  const flags = inspection ? ["--no-ext-diff", "--no-textconv", ...format] : [];
  return sh([...prefix, ...cmd.slice(command, command + 1), ...flags, ...cmd.slice(command + 1)], {
    ...opts,
    env,
  });
}

/**
 * Flags blanking every config-defined hook and filter driver git sees as `git` in `opts.cwd`; needs
 * LIMITLESS_GIT_EMPTY_HOOK="". An empty clean/smudge/process runs nothing and an empty `required`
 * is false, so what is committed or checked out is exactly the bytes, whatever attributes select.
 */
export async function emptyHookFlags(git: string[], opts: Parameters<typeof sh>[1]): Promise<string[]> {
  // Config lookup cannot run hooks; errors other than "no matching keys" must fail closed.
  const hooks = await sh([...git, "config", "--null", "--name-only", "--get-regexp", "^(hook|filter)\\."], {
    ...opts,
    allowFail: false,
  }).catch((error: unknown) => {
    if (error instanceof CommandError && error.exitCode === 1) return { stdout: "" };
    throw error;
  });
  // --config-env splits at the last '=', so hook subsection names may themselves contain '='.
  return [...new Set(hooks.stdout.split("\0").filter(Boolean))].map(
    (key) => `--config-env=${key}=LIMITLESS_GIT_EMPTY_HOOK`,
  );
}
