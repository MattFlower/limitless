import { join } from "node:path";
import { isTransient } from "../git/repos.ts";
import { CommandError, redactCredentials, sh } from "../util/proc.ts";

export class WorkerUpdateError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly restored = true,
    readonly restoredRelease?: string,
  ) {
    super(message);
  }
}

export async function updateWorker(
  target: string,
  options: {
    cwd?: string;
    command?: typeof sh;
    exec?: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null;
    signal?: AbortSignal;
  } = {},
) {
  const command = options.command ?? sh;
  const cwd = options.cwd ?? join(import.meta.dir, "../..");
  let stage = "validate";
  const run = async (args: string[], cleanup = false) => {
    if (!cleanup) options.signal?.throwIfAborted();
    const result = await command(args, {
      cwd,
      signal: cleanup ? undefined : options.signal,
      timeoutMs: 30_000,
      redactOutput: true,
    });
    if (!cleanup) options.signal?.throwIfAborted();
    return result;
  };
  let original: string | undefined,
    installed = false;
  try {
    const exec = options.exec === undefined ? process.execve : options.exec;
    if (typeof exec !== "function") throw new Error("Process replacement is unavailable");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target))
      throw new Error("Invalid coordinator release: expected a full commit SHA");
    stage = "fetch";
    await run(["git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    stage = "ancestry";
    try {
      if ((await run(["git", "rev-parse", "--verify", `${target}^{commit}`])).stdout.trim() !== target)
        throw new WorkerUpdateError(
          `Coordinator release ${target} is not a commit reachable from origin/main`,
        );
      await run(["git", "merge-base", "--is-ancestor", target, "refs/remotes/origin/main"]);
    } catch (error) {
      if (
        error instanceof CommandError &&
        !error.timedOut &&
        [1, 128].includes(error.exitCode ?? -1) &&
        !gitLock(error)
      )
        throw new WorkerUpdateError(
          `Coordinator release ${target} is not a commit reachable from origin/main`,
        );
      throw error;
    }
    stage = "checkout";
    original = (await run(["git", "rev-parse", "HEAD"])).stdout.trim();
    await run(["git", "checkout", "--detach", target]);
    stage = "install";
    installed = true;
    await run([process.execPath, "install", "--frozen-lockfile"]);
    stage = "exec";
    options.signal?.throwIfAborted();
    exec(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
  } catch (error) {
    const failures: string[] = [];
    // Cleanup has independent timeouts and no cancelled attempt signal.
    if (original) {
      try {
        if ((await run(["git", "rev-parse", "HEAD"], true)).stdout.trim() !== original)
          await run(["git", "checkout", "--detach", original], true);
      } catch (restore) {
        failures.push(`restoring original HEAD failed: ${String(restore)}`);
      }
      if (installed && !failures.length) {
        try {
          await run([process.execPath, "install", "--frozen-lockfile"], true);
        } catch (restore) {
          failures.push(`restoring original dependencies failed: ${String(restore)}`);
        }
      }
    }
    const details = [String(error), ...failures];
    const limit = Math.floor(3800 / details.length);
    throw new WorkerUpdateError(
      details.map((text) => redactCredentials(text).slice(0, limit)).join("; "),
      !failures.length &&
        ["fetch", "ancestry", "checkout"].includes(stage) &&
        (gitLock(error) || (stage === "fetch" && isTransient(error))),
      !failures.length,
      installed && !failures.length ? original : undefined,
    );
  }
}

function gitLock(error: unknown) {
  return (
    error instanceof CommandError &&
    [1, 128].includes(error.exitCode ?? -1) &&
    /^(?:fatal: |error: cannot lock ref '[^'\n]+': )Unable to create '[^\n]+\.lock': File exists\.?$/m.test(
      error.stderr,
    )
  );
}
