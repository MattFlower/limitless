import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Repo } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { collectGarbage } from "../src/gc.ts";
import { worktreeGit, worktreeGitScope } from "../src/git/command.ts";
import { completeMerge, prepareMerge } from "../src/git/merge.ts";
import {
  commitAll,
  createWorktree,
  diffSince,
  discardChanges,
  ensureCache,
  headSha,
  pushBranch,
  readFileAt,
  removeWorktree,
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

test("committed -diff attributes cannot hide skipped tests, while 500 KB binaries stay compact", async () => {
  writeFileSync(join(work, ".gitattributes"), "*.ts -diff\n*.png diff\n");
  await commitAll(work, "attributes");
  const before = await headSha(work);
  const binary = Buffer.alloc(500_000, 0x61);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).copy(binary);
  writeFileSync(join(work, "a.png"), binary);
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "binary and test edit");
  expect((await git(work, "diff", before, "HEAD", "--", "sample.test.ts")).stdout).not.toContain(
    "test.skip(",
  );
  const diff = await diffSince(work, before);
  const binaryPatch = diff.patch.split("diff --git a/sample.test.ts")[0] ?? "";
  expect(binaryPatch.trim().split("\n").at(-1)).toBe("Binary files /dev/null and b/a.png differ");
  expect(binaryPatch).not.toContain("@@");
  expect(diff.patch.length).toBeLessThan(1_000);
  expect((await factory("log", "-p", "-1")).stdout).toContain("Binary files /dev/null and b/a.png differ");
  expect((await factory("log", "-p", "-1")).stdout.length).toBeLessThan(2_000);
  await audited();
});

test("Git version is checked once and unsupported versions fail before repository commands", async () => {
  const bin = join(dir, "bin");
  const calls = join(dir, "git-calls");
  mkdirSync(bin);
  const script = `import { worktreeGit } from ${JSON.stringify(resolve("src/git/command.ts"))};
    for (let i = 0; i < 2; i++) await worktreeGit(["git", "diff"], { cwd: ${JSON.stringify(work)} });`;
  for (const version of ["2.39.9", "1.99.0", "unknown", "2.40.0", "2.54.0 (Apple Git-1)", "3.0.0"]) {
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in\n--version) printf 'git version ${version}\\n';;\n*--get-regexp*) exit 1;;\nesac\n`,
      { mode: 0o755 },
    );
    const result = await sh([process.execPath, "-e", script], {
      cwd: work,
      env: { ...(process.env as Record<string, string>), PATH: bin },
      allowFail: true,
    });
    const commands = readFileSync(calls, "utf8").trim().split("\n");
    expect(commands.filter((cmd) => cmd === "--version")).toHaveLength(1);
    if (["2.39.9", "1.99.0", "unknown"].includes(version)) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("requires Git >= 2.40 for --attr-source");
      expect(commands).toEqual(["--version"]);
    } else {
      expect(result.exitCode).toBe(0);
      expect(commands.filter((cmd) => cmd.includes("--attr-source="))).toHaveLength(2);
    }
    rmSync(calls);
  }
});

test("shared cache hooks from an earlier run cannot execute during fetch, worktree lifecycle or GC", async () => {
  const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "config") });
  const store = new Store(cfg.paths.db);
  try {
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: seed,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const cache = await ensureCache(cfg.paths, repo);
    const first = await createWorktree(cfg.paths, repo, "first", "first", "main");
    const marker = join(dir, "cache-hook-ran");
    for (const event of ["reference-transaction", "post-checkout", "post-index-change"]) {
      await git(first.path, "config", `hook.${event}.command`, `echo '${event}' >> '${marker}'`);
      await git(first.path, "config", `hook.${event}.event`, event);
      await git(first.path, "config", `hook.${event}.enabled`, "true");
    }
    const config = readFileSync(join(cache, "config"));
    writeFileSync(join(seed, "next.txt"), "next\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "advance origin");
    const tip = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
    await ensureCache(cfg.paths, repo);
    expect(existsSync(marker)).toBe(false);
    const second = await createWorktree(cfg.paths, repo, "second", "second", "main");
    expect(second.baseSha).toBe(tip);
    expect(await headSha(second.path)).toBe(tip);
    expect(await createWorktree(cfg.paths, repo, "second", "second", "main")).toEqual(second);
    expect(existsSync(marker)).toBe(false);
    await removeWorktree(cfg.paths, repo, second.path);
    expect(existsSync(second.path)).toBe(false);
    for (const missing of [false, true]) {
      const run = store.createRun(repo, { repo: repo.slug, prompt: "gc" });
      store.updateRun(run.id, { status: "succeeded", finishedAt: 0 });
      const tree = await createWorktree(cfg.paths, repo, run.id, "gc", "main");
      if (missing) rmSync(tree.path, { recursive: true, force: true });
      const result = await collectGarbage(store, cfg);
      expect(result.errors).toEqual([]);
      expect(existsSync(tree.path)).toBe(false);
      expect(missing ? result.metadata.length : result.worktrees.length).toBe(1);
    }
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(cache, "config"))).toEqual(config);
    // Prove the configured hook is executable on Git versions supporting config hooks.
    const version = (await git(cache, "--version")).stdout.match(/(\d+)\.(\d+)/);
    if (version && (Number(version[1]) > 2 || Number(version[2]) >= 54)) {
      await git(cache, "hook", "run", "post-checkout");
      expect(readFileSync(marker, "utf8")).toContain("post-checkout");
    }
  } finally {
    store.close();
  }
});

test("conflict-resolution commits rebuild the linked index and include skip-worktree edits", async () => {
  writeFileSync(join(seed, "sample.test.ts"), "theirs\n");
  writeFileSync(join(seed, "base-only.txt"), "from base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "base conflict");
  const nextBase = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "sample.test.ts"), "ours\n");
  const head = await commitAll(work, "worker conflict");
  if (!head) throw new Error("expected worker commit");
  expect(await prepareMerge(work, head, nextBase)).toEqual(["sample.test.ts"]);
  writeFileSync(join(work, "sample.test.ts"), "resolved\n");
  await git(work, "update-index", "--skip-worktree", "flag.test.ts");
  writeFileSync(join(work, "flag.test.ts"), edited);
  await git(work, "add", "-A");
  expect((await git(work, "show", ":flag.test.ts")).stdout).toBe(original);
  const seedIndex = readFileSync(join(seed, ".git/index"));
  const merged = await completeMerge(work, head, nextBase);
  expect((await factory("rev-list", "--parents", "-n", "1", "HEAD")).stdout.trim()).toBe(
    `${merged} ${head} ${nextBase}`,
  );
  expect(await readFileAt(work, "HEAD", "sample.test.ts")).toBe("resolved\n");
  expect(await readFileAt(work, "HEAD", "flag.test.ts")).toBe(edited);
  expect(await readFileAt(work, "HEAD", "base-only.txt")).toBe("from base\n");
  expect(readFileSync(join(seed, ".git/index"))).toEqual(seedIndex);
});

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
