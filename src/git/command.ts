import { AsyncLocalStorage } from "node:async_hooks";
import { CommandError, sh } from "../util/proc.ts";

/** Local pipeline runs retain their existing git behavior; each run has its own scope. */
export const worktreeGitScope = new AsyncLocalStorage<boolean>();
let gitVersion: Promise<void> | undefined;

/** Factory commands in agent-controlled worktrees, without changing any config files. */
export async function worktreeGit(cmd: string[], opts: Parameters<typeof sh>[1]) {
  if (worktreeGitScope.getStore() === false) return sh(cmd, opts);
  opts.signal?.throwIfAborted();
  gitVersion ??= sh(["git", "--version"], { ...opts, allowFail: false }).then(({ stdout }) => {
    const version = stdout.match(/^git version (\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 40))
      throw new Error(`Limitless requires Git >= 2.40 for --attr-source; found ${stdout.trim()}`);
  });
  await gitVersion;
  let command = 1;
  while (cmd[command] === "-c") command += 2;
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
  // Config lookup cannot run hooks; errors other than "no matching keys" must fail closed.
  const hooks = await sh([...prefix, "config", "--null", "--name-only", "--get-regexp", "^hook\\."], {
    ...opts,
    allowFail: false,
  }).catch((error: unknown) => {
    if (error instanceof CommandError && error.exitCode === 1) return { stdout: "" };
    throw error;
  });
  // --config-env splits at the last '=', so hook subsection names may themselves contain '='.
  for (const key of new Set(hooks.stdout.split("\0").filter(Boolean)))
    prefix.push(`--config-env=${key}=LIMITLESS_GIT_EMPTY_HOOK`);
  const env = { ...(opts.env ?? (process.env as Record<string, string>)), LIMITLESS_GIT_EMPTY_HOOK: "" };
  const inspection = ["diff", "log"].includes(cmd[command] ?? "");
  if (inspection) prefix.push("--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  const flags = inspection ? ["--no-ext-diff", "--no-textconv"] : [];
  return sh([...prefix, ...cmd.slice(command, command + 1), ...flags, ...cmd.slice(command + 1)], {
    ...opts,
    env,
  });
}
