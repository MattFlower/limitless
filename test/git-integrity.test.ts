import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { worktreeGit, worktreeGitScope } from "../src/git/command.ts";
import { completeMerge, prepareMerge } from "../src/git/merge.ts";
import {
  commitAll,
  diffSince,
  discardChanges,
  headSha,
  pushBranch,
  readFileAt,
  resetTo,
} from "../src/git/repos.ts";
import { sh } from "../src/util/proc.ts";

let dir: string;
let seed: string;
let work: string;
let base: string;
const original = 'test("ok", () => {});\n';
const edited = 'test.skip("ok", () => {});\n';
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
const factory = (...args: string[]) => worktreeGit(["git", ...args], { cwd: work });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-integrity-"));
  seed = join(dir, "seed");
  work = join(dir, "work");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  await git(seed, "config", "user.name", "Test");
  await git(seed, "config", "user.email", "test@example.com");
  for (const file of ["sample.test.ts", "flag.test.ts", "assume.test.ts"])
    writeFileSync(join(seed, file), original);
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "base");
  base = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  await git(seed, "worktree", "add", "-qb", "worker", work, base);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function audited(files = ["sample.test.ts"]) {
  const diff = await diffSince(work, base);
  expect(diff.patch).toContain(`+${edited.trim()}`);
  expect(diff.added).toBeGreaterThanOrEqual(files.length);
  const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  for (const file of files) {
    expect(diff.stat).toContain(file);
    expect(diff.files.some((entry) => entry.path === file)).toBe(true);
    expect(findings.some((finding) => finding.rule === "test-skipped" && finding.file === file)).toBe(true);
    expect(await readFileAt(work, "HEAD", file)).toBe(edited);
  }
}

test("diff, log, names and statistics ignore external diff, textconv and global attributes", async () => {
  const marker = join(dir, "diff-ran");
  const blind = join(dir, "blind.sh");
  writeFileSync(blind, `#!/bin/sh\ntouch '${marker}'\nprintf 'hidden\\n'\n`, { mode: 0o755 });
  await git(work, "config", "diff.external", blind);
  await git(work, "config", "diff.blind.textconv", blind);
  const attributes = resolve(
    work,
    (await git(work, "rev-parse", "--git-path", "info/attributes")).stdout.trim(),
  );
  writeFileSync(attributes, "*.test.ts diff=blind\n");
  const globalAttributes = join(dir, "attributes");
  writeFileSync(globalAttributes, "*.test.ts -diff\n");
  await git(work, "config", "core.attributesFile", globalAttributes);
  for (const file of ["sample.test.ts", "flag.test.ts"]) writeFileSync(join(work, file), edited);
  await commitAll(work, "factory edit");
  await audited(["sample.test.ts", "flag.test.ts"]);
  expect((await factory("log", "-p", "-1")).stdout).toContain(`+${edited.trim()}`);
  expect(existsSync(marker)).toBe(false);
  // The same repository settings blind an ordinary diff.
  expect((await git(work, "diff", `${base}..HEAD`)).stdout).not.toContain("test.skip(");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  await git(work, "config", "--unset", "diff.external");
  expect((await git(work, "diff", `${base}..HEAD`)).stdout).not.toContain("test.skip(");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  await audited(["sample.test.ts", "flag.test.ts"]);
  expect(existsSync(marker)).toBe(false);
});

test("replacement commits cannot blind factory inspection or the audit", async () => {
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "edit");
  const head = await headSha(work);
  await git(work, "replace", head, base);
  expect((await git(work, "diff", `${base}..HEAD`)).stdout).toBe("");
  expect((await git(work, "show", "HEAD:sample.test.ts")).stdout).toBe(original);
  await audited();
  expect((await factory("log", "-p", "-1")).stdout).toContain("test.skip(");
});

test("rebuilding a linked worktree index defeats forged stat data, skip-worktree and assume-unchanged", async () => {
  const cleanBlob = (await git(work, "rev-parse", "HEAD:sample.test.ts")).stdout.trim();
  writeFileSync(join(work, "sample.test.ts"), edited);
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(work, "sample.test.ts"), past, past);
  await git(work, "-c", "index.version=2", "add", "sample.test.ts");
  const editedBlob = (await git(work, "rev-parse", ":sample.test.ts")).stdout.trim();
  const indexPath = resolve(work, (await git(work, "rev-parse", "--git-path", "index")).stdout.trim());
  expect(indexPath).not.toBe(join(seed, ".git/index"));
  const index = readFileSync(indexPath);
  const offset = index.indexOf(Buffer.from(editedBlob, "hex"));
  expect(offset).toBeGreaterThan(12);
  // Keep the edited file's complete stat cache, but claim its content is the clean HEAD blob.
  Buffer.from(cleanBlob, "hex").copy(index, offset);
  createHash("sha1")
    .update(index.subarray(0, -20))
    .digest()
    .copy(index, index.length - 20);
  writeFileSync(indexPath, index);
  await git(work, "update-index", "--skip-worktree", "flag.test.ts");
  await git(work, "update-index", "--assume-unchanged", "assume.test.ts");
  for (const file of ["flag.test.ts", "assume.test.ts"]) writeFileSync(join(work, file), edited);
  await git(work, "add", "-A");
  expect((await git(work, "status", "--porcelain")).stdout).toBe("");
  expect((await git(work, "show", ":sample.test.ts")).stdout).toBe(original);
  const seedIndex = readFileSync(join(seed, ".git/index"));
  expect(await commitAll(work, "factory rebuild")).not.toBeNull();
  expect(readFileSync(join(seed, ".git/index"))).toEqual(seedIndex);
  await audited(["sample.test.ts", "flag.test.ts", "assume.test.ts"]);
  expect(await commitAll(work, "no changes")).toBeNull();
  rmSync(indexPath);
  expect(await commitAll(work, "missing index")).toBeNull();
});

test("script and config hooks never execute during commit, merge, inspection, reset or delivery push", async () => {
  writeFileSync(join(seed, "base.txt"), "advance base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "advance");
  const nextBase = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  const hooks = resolve(work, (await git(work, "rev-parse", "--git-path", "hooks")).stdout.trim());
  const scriptMarker = join(dir, "script-ran");
  const configMarker = join(dir, "config-ran");
  const equalsMarker = join(dir, "equals-hook-ran");
  for (const name of [
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "post-merge",
    "post-checkout",
    "pre-push",
    "post-index-change",
  ])
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${scriptMarker}'\n`, { mode: 0o755 });
  const fsmonitor = join(dir, "fsmonitor.sh");
  writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${scriptMarker}'\nprintf 'token\\0'\n`, { mode: 0o755 });
  await git(work, "config", "core.fsmonitor", fsmonitor);
  for (const name of ["agent", "a=b"]) {
    await git(
      work,
      "config",
      `hook.${name}.command`,
      `touch '${name === "agent" ? configMarker : equalsMarker}'`,
    );
    await git(work, "config", `hook.${name}.event`, "post-commit");
    await git(work, "config", `hook.${name}.enabled`, "true");
  }
  const configPath = join(seed, ".git/config");
  const config = readFileSync(configPath);
  const version = (await git(work, "--version")).stdout.match(/(\d+)\.(\d+)/);
  if (version && (Number(version[1]) > 2 || Number(version[2]) >= 54)) {
    await git(work, "hook", "run", "post-commit");
    expect(existsSync(configMarker)).toBe(true);
    expect(existsSync(equalsMarker)).toBe(true);
    rmSync(configMarker);
    rmSync(equalsMarker);
    rmSync(scriptMarker);
  }
  for (const name of ["agent", "a=b"])
    for (const field of ["command", "event", "enabled"])
      expect((await factory("config", "--get", `hook.${name}.${field}`)).stdout).toBe("\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  const head = await commitAll(work, "factory edit");
  if (!head) throw new Error("expected edit commit");
  await audited();
  expect(await prepareMerge(work, head, nextBase)).toEqual([]);
  const merged = await completeMerge(work, head, nextBase);
  expect((await factory("rev-list", "--parents", "-n", "1", "HEAD")).stdout.trim()).toBe(
    `${merged} ${head} ${nextBase}`,
  );
  await factory("checkout", "-q", "worker");
  await resetTo(work, merged);
  writeFileSync(join(work, "untracked.txt"), "discard me\n");
  expect(await discardChanges(work)).toBe(true);
  const remote = join(dir, "remote.git");
  await git(dir, "init", "-q", "--bare", remote);
  const repo: Repo = {
    id: "r",
    slug: "owner/repo",
    kind: "github",
    url: remote,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
    createdAt: 0,
  };
  await pushBranch(repo, work, "delivered", merged);
  expect((await git(remote, "rev-parse", "refs/heads/delivered")).stdout.trim()).toBe(merged);
  expect(existsSync(scriptMarker)).toBe(false);
  expect(existsSync(configMarker)).toBe(false);
  expect(existsSync(equalsMarker)).toBe(false);
  expect(readFileSync(configPath)).toEqual(config);
});

test("effective hooks from system, global, includes and environment config are overridden without rewriting them", async () => {
  const marker = join(dir, "hook-ran");
  const system = join(dir, "system.config");
  const global = join(dir, "global.config");
  const include = join(dir, "included.config");
  const content = (name: string) =>
    `[hook "${name}"]\n command = touch '${marker}'\n event = post-commit\n enabled = true\n`;
  writeFileSync(system, content("system"));
  writeFileSync(global, `${content("global")}[include]\n path = ${include}\n`);
  writeFileSync(include, content("included"));
  await git(work, "config", "extensions.worktreeConfig", "true");
  await git(work, "config", "--worktree", "hook.worktree.command", `touch '${marker}'`);
  await git(work, "config", "--worktree", "hook.worktree.event", "post-commit");
  const worktreeConfig = resolve(
    work,
    (await git(work, "rev-parse", "--git-path", "config.worktree")).stdout.trim(),
  );
  const env = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "hook.environment.command",
    GIT_CONFIG_VALUE_0: `touch '${marker}'`,
    GIT_CONFIG_KEY_1: "hook.environment.event",
    GIT_CONFIG_VALUE_1: "post-commit",
    GIT_CONFIG_KEY_2: "hook.environment.enabled",
    GIT_CONFIG_VALUE_2: "true",
    LIMITLESS_GIT_EMPTY_HOOK: `touch '${marker}'`,
  };
  const paths = [system, global, include, worktreeConfig];
  const configs = paths.map((path) => readFileSync(path));
  for (const name of ["system", "global", "included", "environment", "worktree"]) {
    const result = await worktreeGit(["git", "config", "--get", `hook.${name}.command`], { cwd: work, env });
    expect(result.stdout).toBe("\n");
  }
  await worktreeGit(["git", "commit", "--allow-empty", "-qm", "safe"], { cwd: work, env });
  expect(existsSync(marker)).toBe(false);
  for (const [i, path] of paths.entries()) {
    const before = configs[i];
    if (!before) throw new Error("missing config snapshot");
    expect(readFileSync(path)).toEqual(before);
  }
});

test("hook discovery fails closed on invalid config and honors cancellation even with allowFail", async () => {
  const global = join(dir, "invalid.config");
  writeFileSync(global, "[invalid\n");
  const env = { ...(process.env as Record<string, string>), GIT_CONFIG_GLOBAL: global };
  const cmd = ["git", "commit", "--allow-empty", "-qm", "must not commit"];
  await expect(worktreeGit(cmd, { cwd: work, env, allowFail: true })).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(worktreeGit(cmd, { cwd: work, signal: controller.signal, allowFail: true })).rejects.toThrow();
  expect(await headSha(work)).toBe(base);
  expect(readFileSync(global, "utf8")).toBe("[invalid\n");
});

test("local pipeline scope retains original git settings and index behavior", async () => {
  await git(work, "config", "hook.agent.command", "original-command");
  await git(work, "update-index", "--skip-worktree", "sample.test.ts");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await worktreeGitScope.run(false, async () => {
    expect((await factory("config", "--get", "hook.agent.command")).stdout.trim()).toBe("original-command");
    expect(await commitAll(work, "local")).toBeNull();
  });
  expect(await commitAll(work, "github")).not.toBeNull();
  await audited();
});
