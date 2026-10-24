import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { landlockCommand, launcherFiles, PAYLOAD_ENV } from "../harness/landlock.ts";
import { ConfinementError } from "../harness/read-policy.ts";
import {
  CommandError,
  invocationScratch,
  ProcessTerminationError,
  processScope,
  redactCredentials,
  sh,
} from "../util/proc.ts";

export { ConfinementError };

export type GitOptions = Parameters<typeof sh>[1] & {
  /** Existing write roots chosen by the caller for this invocation, never by repository config. */
  additionalWriteRoots?: string[];
};
/** A command that must also start with its own environment and cwd instead of the caller's. */
export interface GitLaunch {
  cmd: string[];
  env: Record<string, string>;
  cwd: string;
}
export interface GitConfinement<Launch extends string[] | GitLaunch = string[] | GitLaunch> {
  wrap(cmd: string[], opts: GitOptions): Promise<Launch>;
}
/** Explicit injection only; production has no environment/configuration selector. */
export const gitConfinement = new AsyncLocalStorage<GitConfinement>();
const sandbox = "/usr/bin/sandbox-exec";
const BWRAP = "/usr/bin/bwrap";

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

/** The git binary and environment to confine; repository/environment config never picks an executable. */
function resolveGit(cmd: string[], opts: GitOptions) {
  const env = { ...(opts.env ?? process.env) } as Record<string, string>;
  const binary = Bun.which(cmd[0] ?? "git", { PATH: env.PATH ?? "/usr/bin:/bin", cwd: opts.cwd });
  if (!binary) throw new ConfinementError("Cannot resolve git for confinement");
  const git = realpathSync(binary);
  const privateScratch = invocationScratch.getStore();
  if (!privateScratch) throw new ConfinementError("Missing private Git scratch");
  const scratch = realpathSync(privateScratch);
  // Never let repository/environment configuration choose an executable allowance.
  delete env.GIT_EXEC_PATH;
  return { env, git, scratch };
}

/** The work tree, admin and common directories this command addresses, plus its scratch. */
function gitWrites(cmd: string[], opts: GitOptions, env: Record<string, string>, scratch: string): string[] {
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
  return [
    ...new Set(
      [
        globals.findLast((arg) => arg.startsWith("--work-tree="))?.slice(12) ?? env.GIT_WORK_TREE ?? opts.cwd,
        admin,
        env.GIT_COMMON_DIR ?? admin,
        scratch,
        ...(opts.additionalWriteRoots ?? []),
      ].map((path) => realpathSync(resolve(opts.cwd, path))),
    ),
  ];
}

export function seatbeltGit(
  platform = process.platform,
  executable = sandbox,
  run = sh,
): GitConfinement<string[]> {
  const installations = new Map<string, Promise<{ binaries: string[]; execPath: string }>>();
  return {
    async wrap(cmd, opts) {
      opts.signal?.throwIfAborted();
      if (opts.additionalWriteRoots?.some((path) => !isAbsolute(path)))
        throw new ConfinementError("Additional Git write roots must be absolute paths");
      if (platform !== "darwin" || !existsSync(executable))
        throw new ConfinementError("Git confinement requires macOS sandbox-exec");
      const { env, git, scratch } = resolveGit(cmd, opts);
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
      const writes = gitWrites(cmd, opts, env, scratch);
      const profile = gitProfile(binaries, execPath, writes);
      return [executable, "-p", profile, git, `--exec-path=${execPath}`, ...cmd.slice(1)];
    },
  };
}
/** The ELF interpreter the kernel loads for `path`: Landlock checks execute access on it as well. */
export function elfInterpreter(path: string): string | undefined {
  const elf = readFileSync(path);
  if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1)
    throw new ConfinementError("Git confinement requires a 64-bit little-endian ELF git");
  const [offset, size, count] = [Number(elf.readBigUInt64LE(32)), elf.readUInt16LE(54), elf.readUInt16LE(56)];
  for (let i = 0; i < count; i++) {
    const header = offset + i * size;
    if (elf.readUInt32LE(header) !== 3) continue; // PT_INTERP
    const start = Number(elf.readBigUInt64LE(header + 8));
    const name = elf.toString("latin1", start, start + Number(elf.readBigUInt64LE(header + 32)));
    return realpathSync(name.split("\0")[0] ?? "");
  }
  return undefined;
}

const within = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * `gitProfile` on Linux: no network, writes only to `writes`, execute only git, its helpers and loader,
 * and no Unix sockets. bwrap starts the launcher from "/"; the launcher confines itself before it enters
 * `cwd` and execs git with the payload's environment.
 */
export function gitBwrapArgs(executables: string[], writes: string[], cwd: string, bwrap = BWRAP): string[] {
  if ([...executables, ...writes, cwd].some((path) => [...path].some((c) => c < " " || c === "\x7f")))
    throw new ConfinementError("Unusual Git confinement path");
  // The launcher reads its own files before it confines anything; bind back any the private mounts hide.
  const launcher = launcherFiles()
    .map((path) => realpathSync(path))
    .filter((path) => ["/run", "/tmp"].some((hidden) => within(hidden, path)));
  return [
    bwrap,
    ...["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-net", "--unshare-uts"],
    ...["--unshare-cgroup-try", "--die-with-parent", "--new-session", "--ro-bind", "/", "/"],
    ...["--dev", "/dev", "--proc", "/proc", "--perms", "0755", "--tmpfs", "/run", "--tmpfs", "/tmp"],
    ...launcher.flatMap((path) => ["--ro-bind", path, path]),
    ...[...writes].sort((a, b) => a.length - b.length).flatMap((path) => ["--bind", path, path]),
    ...["--remount-ro", "/run", "--chdir", "/"],
    ...landlockCommand(0),
    ...["--git", cwd, ...executables, "--"],
  ];
}

const MAX_PAYLOAD_ENV = 100_000;
/** bwrap and the launcher start from "/" with one variable the launcher consumes: no LD_* reaches them. */
function trustedLaunch(env: Record<string, string>) {
  const payload = JSON.stringify(env);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_ENV)
    throw new ConfinementError("The confined Git command's environment is too large to stage");
  return { env: { PATH: "/usr/bin:/bin", [PAYLOAD_ENV]: payload }, cwd: "/" };
}

export function bwrapGit(platform = process.platform, bwrap = BWRAP, run = sh): GitConfinement<GitLaunch> {
  const installations = new Map<string, Promise<string[]>>();
  return {
    async wrap(cmd, opts) {
      opts.signal?.throwIfAborted();
      if (opts.additionalWriteRoots?.some((path) => !isAbsolute(path)))
        throw new ConfinementError("Additional Git write roots must be absolute paths");
      if (platform !== "linux" || !existsSync(bwrap))
        throw new ConfinementError("Git confinement requires Linux bubblewrap");
      const { env, git, scratch } = resolveGit(cmd, opts);
      const launch = trustedLaunch(env);
      let installation = installations.get(git);
      if (!installation) {
        installation = (async () => {
          const loader = elfInterpreter(git);
          const base = [git, ...(loader ? [loader] : [])];
          // Cached for every later caller, so no caller's environment may shape it.
          const result = await run([...gitBwrapArgs(base, [scratch], scratch, bwrap), git, "--exec-path"], {
            ...opts,
            ...trustedLaunch({ PATH: "/usr/bin:/bin" }),
            allowFail: true,
            stdin: undefined,
          });
          if (result.exitCode !== 0)
            throw new ConfinementError(
              `Cannot apply Git confinement; it needs bubblewrap with user namespaces and Landlock: ${redactCredentials(result.stderr.trim().split("\n")[0] ?? "")}`,
            );
          return [...base, realpathSync(result.stdout.trim())];
        })();
        installations.set(git, installation);
        installation.catch(() => installations.delete(git));
      }
      const executables = await installation;
      const execPath = executables.at(-1) ?? "";
      const args = gitBwrapArgs(executables, gitWrites(cmd, opts, env, scratch), resolve(opts.cwd), bwrap);
      return { cmd: [...args, git, `--exec-path=${execPath}`, ...cmd.slice(1)], ...launch };
    },
  };
}
export const gitBackend = { default: process.platform === "linux" ? bwrapGit() : seatbeltGit() };
// Specific to sandbox-exec, bwrap and the launcher; Git's own failures must retain their normal classification.
export function checkApply(
  result: { exitCode: number | null; stderr: string },
  platform: string = process.platform,
): void {
  if (
    (result.exitCode === 71 &&
      result.stderr
        .replace(/^sandbox-exec: /, "")
        .startsWith("sandbox_" + "apply: Operation not permitted")) ||
    (platform === "linux" && result.exitCode !== 0 && /^(bwrap|landlock): /.test(result.stderr))
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
      let launch: { cmd: string[]; env?: Record<string, string>; cwd?: string };
      try {
        const wrapped = await (gitConfinement.getStore() ?? gitBackend.default).wrap(cmd, opts);
        launch = Array.isArray(wrapped) ? { cmd: wrapped } : wrapped;
      } catch (error) {
        if (error instanceof ProcessTerminationError) throw error;
        opts.signal?.throwIfAborted();
        if (error instanceof ConfinementError) throw error;
        throw new ConfinementError("Cannot prepare Git confinement");
      }
      try {
        const result = await sh(launch.cmd, {
          ...opts,
          env: launch.env ?? opts.env,
          cwd: launch.cwd ?? opts.cwd,
        });
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
