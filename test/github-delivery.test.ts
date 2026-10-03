import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { pushExistingBranch } from "../src/git/repos.ts";
import { sh } from "../src/util/proc.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let dir: string;
let bare: string;
let work: string;
let repo: Repo;
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "github-delivery-"));
  bare = join(dir, "remote.git");
  work = join(dir, "work");
  mkdirSync(work);
  await git(dir, "init", "-q", "--bare", bare);
  await git(work, "init", "-q", "-b", "main");
  await git(work, "config", "user.name", "Test");
  await git(work, "config", "user.email", "test@example.com");
  writeFileSync(join(work, "file.txt"), "base\n");
  await git(work, "add", ".");
  await git(work, "commit", "-qm", "base");
  await git(work, "checkout", "-qb", "dependabot/npm/pkg-2");
  await git(work, "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2");
  repo = {
    id: "r",
    slug: "MattFlower/limitless",
    kind: "github",
    url: bare,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
    createdAt: Date.now(),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("pushes verified descendant only to existing head and refuses moved head", async () => {
  const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "file.txt"), "fixed\n");
  await git(work, "add", ".");
  await git(work, "commit", "-qm", "fix");
  await pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base);
  const updated = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  expect((await git(work, "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).stdout).toContain(updated);
  expect((await git(work, "ls-remote", bare, "refs/heads/main")).stdout).toBe("");
  await expect(pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base)).rejects.toThrow("moved");
});
