import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentEnv, sh } from "../util/proc.ts";

/** All merge lifecycle operations share hook suppression, identity and the agent's scrubbed env. */
export function mergeGit(cwd: string, args: string[], allowFail = false) {
  return sh(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    allowFail,
    env: agentEnv({
      GIT_AUTHOR_NAME: "Limitless",
      GIT_AUTHOR_EMAIL: "limitless@localhost",
      GIT_COMMITTER_NAME: "Limitless",
      GIT_COMMITTER_EMAIL: "limitless@localhost",
      GIT_MERGE_AUTOEDIT: "no",
    }),
  });
}

async function mergeHead(cwd: string): Promise<string> {
  return (await mergeGit(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], true)).stdout.trim();
}

export async function validateMerge(cwd: string, head: string, base: string): Promise<string> {
  const [sha = "", ...parents] = (await mergeGit(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout
    .trim()
    .split(/\s+/);
  if (parents.length < 2 || parents[0] !== head || !parents.includes(base))
    throw new Error(`Invalid merge ancestry: HEAD must have parents ${head} and ${base}`);
  if (await mergeHead(cwd)) throw new Error("Completed merge still has MERGE_HEAD");
  return sha;
}

export async function requireMerge(cwd: string, head: string, base: string): Promise<void> {
  if ((await mergeHead(cwd)) !== base) throw new Error(`Missing or unexpected MERGE_HEAD: expected ${base}`);
  if ((await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim() !== head)
    throw new Error(`Merge HEAD changed: expected pre-merge commit ${head}`);
}

/** Resume an existing preparation without resetting its index or worktree edits. */
export async function prepareMerge(cwd: string, head: string, base: string): Promise<string[]> {
  if ((await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim() !== head) {
    await validateMerge(cwd, head, base);
    return [];
  }
  if (!(await mergeHead(cwd))) {
    const result = await mergeGit(cwd, ["merge", "--no-ff", "--no-commit", "--", base], true);
    if (result.exitCode !== 0) {
      const unmerged = await mergeGit(cwd, ["ls-files", "-u"]);
      if (!(await mergeHead(cwd)) || !unmerged.stdout)
        throw new Error(`Merge preparation failed: ${result.stderr || result.stdout}`);
    }
  }
  await requireMerge(cwd, head, base);
  return (await mergeGit(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
}

/** Never use commitAll: even a resolution identical to the first parent needs a merge commit. */
export async function completeMerge(cwd: string, head: string, base: string): Promise<string> {
  await requireMerge(cwd, head, base);
  const paths = (await mergeGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
  const markers = [...new Set(paths)].filter((path) => {
    const file = join(cwd, path);
    return (
      existsSync(file) &&
      lstatSync(file).isFile() &&
      /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?: |\r?$)/m.test(readFileSync(file, "utf8"))
    );
  });
  if (markers.length) throw new Error(`Unresolved conflict markers: ${markers.join(", ")}`);
  await mergeGit(cwd, ["add", "-A"]);
  if ((await mergeGit(cwd, ["ls-files", "-u"])).stdout)
    throw new Error("Merge index still contains unmerged entries");
  await requireMerge(cwd, head, base);
  await mergeGit(cwd, ["commit", "-q", "-m", `limitless: merge base ${base}`]);
  return validateMerge(cwd, head, base);
}
