import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfinementError } from "../harness/read-policy.ts";
import { invocationScratch, sh } from "../util/proc.ts";

export { ConfinementError };

type Options = Parameters<typeof sh>[1];
export interface GitConfinement {
  wrap(cmd: string[], opts: Options): Promise<string[]>;
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
      if (platform !== "darwin" || !existsSync(executable))
        throw new ConfinementError("Git confinement requires macOS sandbox-exec");
      const env = { ...(opts.env ?? process.env) } as Record<string, string>;
      const binary = Bun.which(cmd[0] ?? "git", { PATH: env.PATH ?? "/usr/bin:/bin", cwd: opts.cwd });
      if (!binary) throw new ConfinementError("Cannot resolve git for confinement");
      const git = realpathSync(binary);
      const scratch = realpathSync(invocationScratch.getStore() ?? env.TMPDIR ?? tmpdir());
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
      const admin =
        env.GIT_DIR ??
        cmd.find((arg) => arg.startsWith("--git-dir="))?.slice(10) ??
        (lstatSync(join(opts.cwd, ".git"), { throwIfNoEntry: false })?.isDirectory()
          ? join(opts.cwd, ".git")
          : opts.cwd);
      const writes = [
        ...new Set(
          [
            env.GIT_WORK_TREE ?? opts.cwd,
            admin,
            env.GIT_COMMON_DIR ?? admin,
            scratch,
            ...(env.TMPDIR ? [env.TMPDIR] : []),
          ].map((path) => realpathSync(resolve(opts.cwd, path))),
        ),
      ];
      const profile = gitProfile(binaries, execPath, writes);
      // A separate repository-free probe distinguishes apply failures from git's own stderr/errors.
      await check(profile, ["--version"]);
      return [executable, "-p", profile, git, `--exec-path=${execPath}`, ...cmd.slice(1)];
    },
  };
}
export const gitBackend = { default: seatbeltGit() };
export const gitSh: typeof sh = async (cmd, opts) => {
  let wrapped: string[];
  try {
    wrapped = await (gitConfinement.getStore() ?? gitBackend.default).wrap(cmd, opts);
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (error instanceof ConfinementError) throw error;
    throw new ConfinementError("Cannot prepare Git confinement");
  }
  return sh(wrapped, opts);
};
