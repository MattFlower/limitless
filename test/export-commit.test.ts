import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCommit } from "../src/git/repos.ts";
import { sh } from "../src/util/proc.ts";

test("exportCommit extracts every tracked file of the commit, export-ignore included", async () => {
  const root = mkdtempSync(join(tmpdir(), "export-commit-"));
  const repo = join(root, "repo");
  const dest = join(root, "dest");
  mkdirSync(repo);
  mkdirSync(dest);
  try {
    const git = (...args: string[]) => sh(["git", ...args], { cwd: repo });
    await git("init", "-q");
    writeFileSync(join(repo, ".gitattributes"), "package.json export-ignore\n");
    writeFileSync(join(repo, "package.json"), '{"scripts":{"test":"bun test"}}\n');
    await git("add", ".");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    );
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    writeFileSync(join(repo, "package.json"), "working change\n");
    writeFileSync(join(repo, "untracked.txt"), "later\n");
    await exportCommit(repo, sha, dest);
    expect(readFileSync(join(dest, "package.json"), "utf8")).toBe('{"scripts":{"test":"bun test"}}\n');
    expect(existsSync(join(dest, ".gitattributes"))).toBe(true);
    expect(existsSync(join(dest, "untracked.txt"))).toBe(false);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect((await git("status", "--porcelain")).stdout).toContain(" M package.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
