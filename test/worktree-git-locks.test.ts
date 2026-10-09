import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordWorktree, worktreeGit } from "../src/git/command.ts";
import { sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

// These tests drive real git; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let dir: string;
let work: string;
let base: string;
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
const factory = (...args: string[]) => worktreeGit(["git", ...args], { cwd: work });

const seedRepo = seeded(async (root) => {
  const repo = join(root, "seed");
  mkdirSync(repo);
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "file.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  return (await git(repo, "rev-parse", "HEAD")).stdout.trim();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "worktree-git-locks-"));
  work = join(dir, "work");
  base = (await seedRepo(dir)).value;
  await git(join(dir, "seed"), "worktree", "add", "-qb", "worker", work, base);
  await recordWorktree(work);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a lock file another factory command releases mid-inspection is not unsafe; a linked one still is", async () => {
  const admin = (await git(work, "rev-parse", "--absolute-git-dir")).stdout.trim();
  const lock = join(admin, "HEAD.lock");
  const lstat = fs.lstatSync;
  // The concurrent command finishes after the listing and before lstat, as a commit renames HEAD.lock.
  const released = spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: fs.StatOptions) => {
    if (path === lock) rmSync(lock, { force: true });
    return lstat(path, options);
  }) as typeof fs.lstatSync);
  try {
    writeFileSync(lock, `${base}\n`);
    expect((await factory("rev-parse", "HEAD")).stdout.trim()).toBe(base);
  } finally {
    released.mockRestore();
  }
  writeFileSync(join(dir, "outside"), "linked");
  linkSync(join(dir, "outside"), lock);
  await expect(factory("rev-parse", "HEAD")).rejects.toThrow("Unsafe worktree Git administration");
});

test.each([
  ["config.worktree", "config.worktree"],
  ["a nested .lock entry such as reftable data", "reftable/reference-data.lock"],
])("any other admin entry that vanishes mid-inspection still fails: %s", async (_label, name) => {
  const admin = (await git(work, "rev-parse", "--absolute-git-dir")).stdout.trim();
  const entry = join(admin, name);
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, "[core]\n");
  const lstat = fs.lstatSync;
  // A writer could delete it before lstat and recreate it as a link afterwards, so it isn't skipped.
  const vanished = spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: fs.StatOptions) => {
    if (path === entry) rmSync(entry, { force: true });
    return lstat(path, options);
  }) as typeof fs.lstatSync);
  try {
    await expect(factory("rev-parse", "HEAD")).rejects.toThrow("ENOENT");
  } finally {
    vanished.mockRestore();
  }
});
