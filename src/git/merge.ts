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
  // The file-only resolver leaves the unmerged index intact, including across restarts, so the
  // worktree-vs-index diff is exactly the resolver's edits. Only markers it introduced block;
  // unrelated docs and marker fixtures already in either parent do not. Each opening, ancestor or
  // closing line counts on its own so a partially removed block is still caught; bare `=======`
  // is ignored because it is also a setext heading.
  const list = async (args: string[]) => (await mergeGit(cwd, args)).stdout.split("\0").filter(Boolean);
  const marker = /^(<{7,}|\|{7,}|>{7,})( |$)/;
  const markerLines = (text: string) => text.split("\n").filter((line) => marker.test(line));
  const unmerged = new Set(await list(["diff", "--name-only", "--diff-filter=U", "-z"]));
  const untracked = await list(["ls-files", "-z", "--others", "--exclude-standard"]);
  const edited = await list(["diff", "--name-only", "--diff-filter=MT", "-z"]);
  const markers: string[] = [];
  for (const path of [...unmerged, ...untracked]) {
    const file = join(cwd, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const contents = readFileSync(file);
    if (contents.includes(0)) continue;
    const known = new Set<string>();
    if (unmerged.has(path))
      for (const stage of [2, 3]) {
        const side = await mergeGit(cwd, ["show", `:${stage}:${path}`], true);
        if (side.exitCode === 0) for (const line of markerLines(side.stdout)) known.add(line);
      }
    if (markerLines(contents.toString("utf8")).some((line) => !known.has(line))) markers.push(path);
  }
  for (const path of edited.filter((p) => !unmerged.has(p))) {
    const diff = await mergeGit(cwd, [
      "diff",
      "-U0",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      `:(literal)${path}`,
    ]);
    if (/^\+(<{7,}|\|{7,}|>{7,})( |$)/m.test(diff.stdout)) markers.push(path);
  }
  if (markers.length) throw new Error(`Unresolved conflict markers: ${markers.join(", ")}`);
  await mergeGit(cwd, ["add", "-A"]);
  if ((await mergeGit(cwd, ["ls-files", "-u"])).stdout)
    throw new Error("Merge index still contains unmerged entries");
  await requireMerge(cwd, head, base);
  await mergeGit(cwd, ["commit", "-q", "-m", `limitless: merge base ${base}`]);
  return validateMerge(cwd, head, base);
}
