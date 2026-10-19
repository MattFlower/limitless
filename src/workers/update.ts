import { join } from "node:path";
import { sh } from "../util/proc.ts";

export async function updateWorker(
  target: string,
  options: {
    cwd?: string;
    command?: typeof sh;
    exec?: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
    signal?: AbortSignal;
  } = {},
) {
  const command = options.command ?? sh;
  const cwd = options.cwd ?? join(import.meta.dir, "../..");
  const run = (args: string[]) => command(args, { cwd, signal: options.signal, redactOutput: true });
  let original: string | undefined;
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target))
      throw new Error("Invalid coordinator release: expected a full commit SHA");
    await run(["git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    try {
      if ((await run(["git", "rev-parse", "--verify", `${target}^{commit}`])).stdout.trim() !== target)
        throw new Error("Not a commit");
      await run(["git", "merge-base", "--is-ancestor", target, "refs/remotes/origin/main"]);
    } catch {
      throw new Error(`Coordinator release ${target} is not a commit reachable from origin/main`);
    }
    original = (await run(["git", "rev-parse", "HEAD"])).stdout.trim();
    await run(["git", "checkout", "--detach", target]);
    await run([process.execPath, "install", "--frozen-lockfile"]);
    const exec = options.exec ?? process.execve;
    if (!exec) throw new Error("Process replacement is unavailable");
    exec(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
  } catch (error) {
    // Roll back even if a command completed just before cancellation was observed.
    if (original) {
      try {
        if (
          (await command(["git", "rev-parse", "HEAD"], { cwd, redactOutput: true })).stdout.trim() !==
          original
        )
          await command(["git", "checkout", "--detach", original], { cwd, redactOutput: true });
      } catch (restore) {
        throw new Error(`${String(error)}; restoring original HEAD failed: ${String(restore)}`);
      }
    }
    throw error;
  }
}
