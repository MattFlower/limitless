import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentEnv } from "../util/proc.ts";
import { worktreeGit, worktreeGitScope } from "./command.ts";

/** All merge lifecycle operations share hook suppression, identity and the agent's scrubbed env. */
export function mergeGit(cwd: string, args: string[], allowFail = false, stdin?: string) {
  return worktreeGit(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    allowFail,
    stdin,
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

/** Keep the original conflicts outside the index, including in linked worktrees and on resume. */
async function mergePaths(cwd: string, head: string, base: string, paths: string[]): Promise<string[]> {
  const file = resolve(
    cwd,
    (await mergeGit(cwd, ["rev-parse", "--git-path", "limitless-merge-paths"])).stdout.trim(),
  );
  const [savedHead, savedBase, ...savedPaths] = existsSync(file)
    ? readFileSync(file, "utf8").split("\0")
    : [];
  const original = savedHead === head && savedBase === base ? savedPaths : [];
  const all = [...new Set([...original, ...paths])];
  if (savedHead !== head || savedBase !== base || all.length !== original.length)
    writeFileSync(file, [head, base, ...all].join("\0"));
  return all;
}

/** Resume an existing preparation without resetting its index or worktree edits. */
export async function prepareMerge(cwd: string, head: string, base: string): Promise<string[]> {
  if ((await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim() !== head) {
    await validateMerge(cwd, head, base);
    return [];
  }
  if (!(await mergeHead(cwd))) {
    // Keep two-way markers; Git may append paths to labels or use custom marker sizes.
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
  const paths = (await mergeGit(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
  await mergePaths(cwd, head, base, paths);
  return paths;
}

function markerCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.match(/^(?:<{7,}|={7,}|>{7,})(?: [^\r\n]*)?\r?$/gm) ?? []) {
    const marker = line.replace(/\r$/, "");
    // Bare separators also occur as standalone setext headings.
    if (!/^=+$/.test(marker)) counts.set(marker, (counts.get(marker) ?? 0) + 1);
  }
  return counts;
}

/**
 * Conflict markers git generated and the resolver left behind, found by content rather than diff
 * output (binary attributes and modify/delete conflicts have no usable diff). Allow each marker
 * up to the combined parent counts minus the common ancestor count, so independent additions
 * of fixtures and docs that show markers don't block.
 */
async function leftoverMarkers(
  cwd: string,
  head: string,
  base: string,
  mergeBase: string,
  path: string,
): Promise<boolean> {
  const file = join(cwd, path);
  if (!existsSync(file) || !lstatSync(file).isFile()) return false;
  const markers = markerCounts(readFileSync(file, "utf8"));
  if (!markers.size) return false;
  const inParent = async (rev: string) =>
    markerCounts((await mergeGit(cwd, ["cat-file", "blob", `${rev}:${path}`], true)).stdout);
  const ours = await inParent(head);
  const theirs = await inParent(base);
  const ancestor = await inParent(mergeBase);
  return [...markers].some(
    ([marker, n]) => n > (ours.get(marker) ?? 0) + (theirs.get(marker) ?? 0) - (ancestor.get(marker) ?? 0),
  );
}

/** Never use commitAll: even a resolution identical to the first parent needs a merge commit. */
export async function completeMerge(cwd: string, head: string, base: string): Promise<string> {
  await requireMerge(cwd, head, base);
  const mergeBase = (await mergeGit(cwd, ["merge-base", "HEAD", "MERGE_HEAD"])).stdout.trim();
  const list = async (args: string[]) => (await mergeGit(cwd, args)).stdout.split("\0").filter(Boolean);
  const unmerged = await mergePaths(
    cwd,
    head,
    base,
    await list(["diff", "--name-only", "--diff-filter=U", "-z"]),
  );
  const untracked = await list(["ls-files", "-z", "--others", "--exclude-standard"]);
  const edited = (await list(["diff", "--name-only", "--diff-filter=MT", "-z"])).filter(
    (path) => !unmerged.includes(path),
  );
  const touched = await list(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`]);
  const staged = await list(["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  const markers: string[] = [];
  for (const path of new Set([...untracked, ...unmerged, ...edited, ...touched, ...staged]))
    if (await leftoverMarkers(cwd, head, base, mergeBase, path)) markers.push(path);
  if (markers.length) throw new Error(`Unresolved conflict markers: ${markers.join(", ")}`);
  await mergeGit(cwd, ["add", "-A"]);
  if ((await mergeGit(cwd, ["ls-files", "-u"])).stdout)
    throw new Error("Merge index still contains unmerged entries");
  if (worktreeGitScope.getStore() !== false) {
    // HEAD alone lacks ignored files brought in by the base or staged during resolution.
    const tracked = new Set([
      ...(await list(["ls-files", "-z", "--cached"])),
      ...(await list(["ls-tree", "-r", "-z", "--name-only", "MERGE_HEAD"])),
    ]);
    const present = [...tracked].filter((path) => lstatSync(join(cwd, path), { throwIfNoEntry: false }));
    const index = await mergeGit(cwd, ["rev-parse", "--git-path", "index"]);
    rmSync(resolve(cwd, index.stdout.trim()), { force: true });
    await mergeGit(cwd, ["read-tree", "HEAD"]);
    await mergeGit(cwd, ["add", "-A"]);
    if (present.length)
      await mergeGit(
        cwd,
        ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"],
        false,
        present.map((path) => `:(literal)${path}\0`).join(""),
      );
  }
  await requireMerge(cwd, head, base);
  await mergeGit(cwd, ["commit", "-q", "-m", `limitless: merge base ${base}`]);
  return validateMerge(cwd, head, base);
}
