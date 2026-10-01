import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentEnv } from "../util/proc.ts";
import { git, RAW_DIFF, restoreCheckout } from "./trust.ts";

/** All merge lifecycle operations share hook suppression, identity and the agent's scrubbed env. */
export function mergeGit(cwd: string, args: string[], allowFail = false) {
  return git(["-c", "commit.gpgSign=false", ...args], {
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
  await restoreCheckout(cwd);
  if ((await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim() !== head) {
    await validateMerge(cwd, head, base);
    return [];
  }
  if (!(await mergeHead(cwd))) {
    // Two-way markers only, so conflicts are labelled exactly `HEAD` and the base sha.
    const result = await mergeGit(
      cwd,
      ["-c", "merge.conflictStyle=merge", "merge", "--no-ff", "--no-commit", "--", base],
      true,
    );
    if (result.exitCode !== 0) {
      const unmerged = await mergeGit(cwd, ["ls-files", "-u"]);
      if (!(await mergeHead(cwd)) || !unmerged.stdout)
        throw new Error(`Merge preparation failed: ${result.stderr || result.stdout}`);
    }
  }
  await requireMerge(cwd, head, base);
  return (await mergeGit(cwd, ["diff", ...RAW_DIFF, "--name-only", "--diff-filter=U", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/**
 * Conflict markers git generated and the resolver left behind, found by content rather than diff
 * output (binary attributes and modify/delete conflicts have no usable diff). `>>>>>>> <base>`
 * cannot occur in either parent, since a commit never contains its own sha. `<<<<<<< HEAD` lines
 * are allowed only up to the count already present in a parent, so fixtures and docs that show
 * markers don't block. Bare `=======` is ignored because it is also a setext heading.
 */
async function leftoverMarkers(cwd: string, head: string, base: string, path: string): Promise<boolean> {
  const file = join(cwd, path);
  if (!existsSync(file) || !lstatSync(file).isFile()) return false;
  const text = readFileSync(file).toString("latin1");
  const theirs = new RegExp(`^>{7} ${base}$`, "m");
  if (theirs.test(text)) return true;
  const ours = /^<{7} HEAD$/gm;
  const inParent = async (rev: string) =>
    count((await mergeGit(cwd, ["cat-file", "blob", `${rev}:${path}`], true)).stdout, ours);
  return count(text, ours) > Math.max(await inParent(head), await inParent(base));
}

/** Never use commitAll: even a resolution identical to the first parent needs a merge commit. */
export async function completeMerge(cwd: string, head: string, base: string): Promise<string> {
  await restoreCheckout(cwd);
  await requireMerge(cwd, head, base);
  const list = async (args: string[]) => (await mergeGit(cwd, args)).stdout.split("\0").filter(Boolean);
  // The file-only resolver leaves the unmerged index intact, including across restarts.
  const unmerged = await list(["diff", ...RAW_DIFF, "--name-only", "--diff-filter=U", "-z"]);
  const untracked = await list(["ls-files", "-z", "--others", "--exclude-standard"]);
  const edited = (await list(["diff", ...RAW_DIFF, "--name-only", "--diff-filter=MT", "-z"])).filter(
    (path) => !unmerged.includes(path),
  );
  const markers: string[] = [];
  for (const path of [...untracked, ...unmerged, ...edited])
    if (await leftoverMarkers(cwd, head, base, path)) markers.push(path);
  if (markers.length) throw new Error(`Unresolved conflict markers: ${markers.join(", ")}`);
  await mergeGit(cwd, ["add", "-A"]);
  if ((await mergeGit(cwd, ["ls-files", "-u"])).stdout)
    throw new Error("Merge index still contains unmerged entries");
  await requireMerge(cwd, head, base);
  await mergeGit(cwd, ["commit", "-q", "-m", `limitless: merge base ${base}`]);
  return validateMerge(cwd, head, base);
}
