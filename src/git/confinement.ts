import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfinementError } from "../harness/read-policy.ts";
import { CommandError, invocationScratch, ProcessTerminationError, processScope, sh } from "../util/proc.ts";

export { ConfinementError };

export type GitOptions = Parameters<typeof sh>[1] & {
  /** Existing write roots chosen by the caller for this invocation, never by repository config. */
  additionalWriteRoots?: string[];
};
export interface GitConfinement {
  wrap(cmd: string[], opts: GitOptions): Promise<string[]>;
}
/** Explicit injection only; production has no environment/configuration selector. */
export const gitConfinement = new AsyncLocalStorage<GitConfinement>();
const sandbox = "/usr/bin/sandbox-exec";

export function gitProfile(binaries: string[], execPath: string | undefined, writes: string[]): string {
  const paths = (values: string[], kind: string) =>
    values
      .map((path) => {
        if (/["\\]/.test(path) || [...path].some((char) => char < " " || char.charCodeAt(0) === 127))
          throw new ConfinementError("Unusual Git confinement path");
        return `(${kind} "${path}")`;
      })
      .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec)",
    `(allow process-exec ${paths(binaries, "literal")} ${execPath ? paths([execPath], "subpath") : ""})`,
    "(deny file-write*)",
    `(allow file-write* ${paths(writes, "subpath")} (literal "/dev/null"))`,
    "(deny signal)",
    "(allow signal (target self) (target same-sandbox))",
  ].join("\n");
}

export function seatbeltGit(platform = process.platform, executable = sandbox, run = sh): GitConfinement {
  const installations = new Map<string, Promise<{ binaries: string[]; execPath: string }>>();
  return {
    async wrap(cmd, opts) {
      opts.signal?.throwIfAborted();
      if (opts.additionalWriteRoots?.some((path) => !isAbsolute(path)))
        throw new ConfinementError("Additional Git write roots must be absolute paths");
      if (platform !== "darwin" || !existsSync(executable))
        throw new ConfinementError("Git confinement requires macOS sandbox-exec");
      const env = { ...(opts.env ?? process.env) } as Record<string, string>;
      const binary = Bun.which(cmd[0] ?? "git", { PATH: env.PATH ?? "/usr/bin:/bin", cwd: opts.cwd });
      if (!binary) throw new ConfinementError("Cannot resolve git for confinement");
      const git = realpathSync(binary);
      const privateScratch = invocationScratch.getStore();
      if (!privateScratch) throw new ConfinementError("Missing private Git scratch");
      const scratch = realpathSync(privateScratch);
      // Never let repository/environment configuration choose an executable allowance.
      delete env.GIT_EXEC_PATH;
      const check = async (profile: string, args: string[]) => {
        const result = await run([executable, "-p", profile, git, ...args], {
          ...opts,
          env,
          allowFail: true,
          stdin: undefined,
        });
        if (result.exitCode !== 0) throw new ConfinementError("Cannot apply Git confinement");
        return result.stdout.trim();
      };
      let installation = installations.get(git);
      if (!installation) {
        installation = (async () => {
          const binaries = [git];
          if (git === "/usr/bin/git") {
            const developer = await run(["/usr/bin/xcode-select", "-p"], { ...opts, env, cwd: scratch });
            binaries.push(realpathSync(join(developer.stdout.trim(), "usr/bin/git")));
          }
          const execPath = realpathSync(await check(gitProfile(binaries, undefined, []), ["--exec-path"]));
          return { binaries, execPath };
        })();
        installations.set(git, installation);
        installation.catch(() => installations.delete(git));
      }
      const { binaries, execPath } = await installation;
      // Git's global directory options override the environment; the last option wins.
      const globals: string[] = [];
      for (let i = 1; cmd[i]?.startsWith("-"); i++) {
        const arg = cmd[i] ?? "";
        if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(arg)) i++;
        else globals.push(arg);
      }
      const admin =
        globals.findLast((arg) => arg.startsWith("--git-dir="))?.slice(10) ??
        env.GIT_DIR ??
        (lstatSync(join(opts.cwd, ".git"), { throwIfNoEntry: false })?.isDirectory()
          ? join(opts.cwd, ".git")
          : opts.cwd);
      const writes = [
        ...new Set(
          [
            globals.findLast((arg) => arg.startsWith("--work-tree="))?.slice(12) ??
              env.GIT_WORK_TREE ??
              opts.cwd,
            admin,
            env.GIT_COMMON_DIR ?? admin,
            scratch,
            ...(opts.additionalWriteRoots ?? []),
          ].map((path) => realpathSync(resolve(opts.cwd, path))),
        ),
      ];
      const profile = gitProfile(binaries, execPath, writes);
      return [executable, "-p", profile, git, `--exec-path=${execPath}`, ...cmd.slice(1)];
    },
  };
}
export const gitBackend = { default: seatbeltGit() };
// Both are specific to sandbox-exec; Git's own failures must retain their normal classification.
function checkApply(result: { exitCode: number | null; stderr: string }): void {
  if (
    result.exitCode === 71 &&
    result.stderr.replace(/^sandbox-exec: /, "").startsWith("sandbox_" + "apply: Operation not permitted")
  )
    throw new ConfinementError("Cannot apply Git confinement");
}
export const gitSh = async (cmd: string[], opts: GitOptions): ReturnType<typeof sh> => {
  const inherited = invocationScratch.getStore();
  const scratch = inherited ?? mkdtempSync(join(tmpdir(), "limitless-git-"));
  const scope = processScope.getStore();
  if (!inherited) scope?.scratchDirs.add(scratch);
  let unconfirmed = false;
  try {
    return await invocationScratch.run(scratch, async () => {
      opts = { ...opts, env: { ...(opts.env ?? process.env), TMPDIR: scratch } };
      let wrapped: string[];
      try {
        wrapped = await (gitConfinement.getStore() ?? gitBackend.default).wrap(cmd, opts);
      } catch (error) {
        if (error instanceof ProcessTerminationError) throw error;
        opts.signal?.throwIfAborted();
        if (error instanceof ConfinementError) throw error;
        throw new ConfinementError("Cannot prepare Git confinement");
      }
      try {
        const result = await sh(wrapped, opts);
        checkApply(result);
        return result;
      } catch (error) {
        if (error instanceof CommandError) checkApply(error);
        throw error;
      }
    });
  } catch (error) {
    unconfirmed = error instanceof ProcessTerminationError;
    throw error;
  } finally {
    if (!inherited && !unconfirmed && !scope?.terminationError) {
      rmSync(scratch, { recursive: true, force: true });
      scope?.scratchDirs.delete(scratch);
    }
  }
};
