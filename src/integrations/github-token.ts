import { type ProcResult, registerCredential, runProcess } from "../util/proc.ts";

/** Secret output must never enter sh's output-quoting error path. */
export async function githubToken(signal?: AbortSignal, run = runProcess): Promise<string> {
  let lookup: ProcResult;
  try {
    lookup = await run({
      cmd: ["gh", "auth", "token"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      timeoutMs: 30_000,
      signal,
    });
  } catch {
    throw new Error("gh auth token failed: process error");
  }
  const token = lookup.stdout.trim();
  registerCredential("GH_TOKEN", token);
  if (lookup.timedOut) throw new Error("gh auth token failed: timeout");
  if (lookup.cancelled) throw new Error("gh auth token failed: cancelled");
  if (lookup.signal) throw new Error("gh auth token failed: signal");
  if (lookup.exitCode !== 0) throw new Error("gh auth token failed: non-zero exit");
  if (lookup.truncated) throw new Error("gh auth token failed: truncated output");
  if (!token) throw new Error("gh auth token failed: empty output");
  return token;
}
