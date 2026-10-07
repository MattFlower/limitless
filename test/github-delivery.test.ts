import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Repo } from "../src/core/types.ts";
import { pushBranch, pushExistingBranch } from "../src/git/repos.ts";
import { sh } from "../src/util/proc.ts";
import { plantPushConfig } from "./push-config.ts";

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
    url: pathToFileURL(bare).href,
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
  const updated = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  // Publication scans `updated`; a later local HEAD must not change what gets pushed.
  writeFileSync(join(work, "file.txt"), "unscanned change\n");
  await git(work, "commit", "-qam", "unscanned");
  await pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base, undefined, undefined, updated);
  expect((await git(work, "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).stdout).toContain(updated);
  expect((await git(work, "ls-remote", bare, "refs/heads/main")).stdout).toBe("");
  await expect(pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base)).rejects.toThrow("moved");
});

test("delivery retains the implicit lease's refusal to overwrite an existing branch", async () => {
  const branch = "dependabot/npm/pkg-2";
  await git(work, "remote", "add", "origin", bare);
  await git(work, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
  await git(work, "commit", "--allow-empty", "-qm", "approved");
  const approved = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  const markers = await plantPushConfig(work, dir, pathToFileURL(bare).href);
  await expect(pushBranch(repo, work, branch, approved)).rejects.toThrow("stale info");
  expect((await git(bare, "rev-parse", `refs/heads/${branch}`)).stdout.trim()).toBe(
    (await git(work, "rev-parse", `${approved}^`)).stdout.trim(),
  );
  expect(markers()).toEqual([]);
});

test.each(["remote", "existing", "local"])(
  "%s delivery ignores checkout push commands, tags and notes",
  async (kind) => {
    const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    writeFileSync(join(work, "file.txt"), "changed\n");
    await git(work, "commit", "-qam", "safe change");
    const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    await git(work, "config", "push.followTags", "true");
    await git(work, "tag", "-am", "synthetic tag", "secret-host.example");
    await git(work, "notes", "add", "-m", "synthetic note");
    writeFileSync(join(work, "file.txt"), "unscanned change\n");
    await git(work, "commit", "-qam", "unscanned");
    const markers = await plantPushConfig(work, dir, kind === "local" ? bare : pathToFileURL(bare).href);
    await git(work, "config", "extensions.worktreeConfig", "true");
    await git(work, "config", "--worktree", "core.sshCommand", "false");
    const branch = kind === "existing" ? "dependabot/npm/pkg-2" : "delivered";
    if (kind === "existing") await pushExistingBranch(repo, work, branch, base, undefined, undefined, head);
    else
      await pushBranch(
        kind === "local" ? { ...repo, kind: "local", localPath: bare } : repo,
        work,
        branch,
        head,
      );
    expect(markers()).toEqual([]);
    expect((await git(bare, "rev-parse", `refs/heads/${branch}`)).stdout.trim()).toBe(head);
    expect((await git(bare, "for-each-ref", "refs/tags", "refs/notes")).stdout).toBe("");
  },
);

test("delivery preserves the object format and selected SHA in a SHA-256 repository", async () => {
  const source = join(dir, "sha256");
  const remote = join(dir, "sha256.git");
  await git(dir, "init", "-q", "--object-format=sha256", source);
  await git(dir, "init", "-q", "--bare", "--object-format=sha256", remote);
  await git(source, "commit", "-qm", "selected", "--allow-empty");
  const sha = (await git(source, "rev-parse", "HEAD")).stdout.trim();
  await git(source, "commit", "-qm", "unscanned", "--allow-empty");
  const destination = pathToFileURL(remote).href;
  const markers = await plantPushConfig(source, dir, destination);
  await pushBranch({ ...repo, url: destination }, source, "delivered", sha);
  expect((await git(remote, "rev-parse", "refs/heads/delivered")).stdout.trim()).toBe(sha);
  expect(markers()).toEqual([]);
});

test("push keeps system/global credentials and gitdir-conditional SSH, and refuses broken trusted config", async () => {
  const original = { ...process.env };
  const gitBin = Bun.which("git");
  if (!gitBin) throw new Error("missing git");
  const global = join(dir, "global.config");
  const system = join(dir, "system.config");
  const included = join(dir, "trusted.config");
  const credentials = join(dir, "credentials");
  const captured = join(dir, "captured");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const configure = (file: string, key: string, value: string) =>
    sh([gitBin, "config", "--file", file, "--add", key, value], { cwd: work });
  const systemHelper = `!f() { echo system >> '${credentials}'; }; f`;
  const globalHelper = `!f() { echo global >> '${credentials}'; printf 'username=test\\npassword=value\\n'; }; f`;
  await configure(system, "credential.helper", systemHelper);
  await configure(system, "core.sshCommand", "trusted-system-ssh");
  await configure(global, "credential.helper", globalHelper);
  await configure(global, "includeIf.gitdir:**/work/.git.path", included);
  await configure(included, "core.sshCommand", "trusted-global-ssh");
  await configure(included, "credential.https://trusted.invalid.helper", "trusted-url-helper");
  const markers = await plantPushConfig(work, dir, pathToFileURL(bare).href);
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("push")) {
  const options = args.slice(0, args.indexOf("push"));
  const config = spawnSync(${JSON.stringify(gitBin)}, [...options, "config", "--list", "--show-scope", "--includes"], { encoding: "utf8" });
  writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args, config: config.stdout }));
  const credential = spawnSync(${JSON.stringify(gitBin)}, [...options, "credential", "fill"], { input: "protocol=https\\nhost=example.invalid\\n\\n", encoding: "utf8" });
  if (credential.status !== 0 || !credential.stdout.includes("password=value")) process.exit(91);
}
const result = spawnSync(${JSON.stringify(gitBin)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  try {
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_CONFIG_SYSTEM = system;
    delete process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_COUNT = "0";
    delete process.env.GIT_CONFIG_PARAMETERS;
    process.env.PATH = `${bin}:${original.PATH}`;
    const sha = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    await pushBranch(repo, work, "trusted", sha);
    expect((await git(bare, "rev-parse", "refs/heads/trusted")).stdout.trim()).toBe(sha);
    expect(readFileSync(credentials, "utf8")).toBe("system\nglobal\n");
    expect(markers()).toEqual([]);
    const effective: { args: string[]; config: string } = JSON.parse(readFileSync(captured, "utf8"));
    expect(effective.args).toEqual(
      expect.arrayContaining([
        "protocol.ext.allow=never",
        "extensions.worktreeConfig=false",
        "core.sshCommand=trusted-global-ssh",
      ]),
    );
    expect(effective.config).toContain(`system\tcredential.helper=${systemHelper}`);
    expect(effective.config).toContain(`global\tcredential.helper=${globalHelper}`);
    expect(effective.config).toContain(
      "global\tcredential.https://trusted.invalid.helper=trusted-url-helper",
    );
    expect(effective.config).not.toContain("push-attacks");
    await sh([gitBin, "config", "--file", included, "--unset", "core.sshCommand"], { cwd: work });
    await pushBranch(repo, work, "system-ssh", sha);
    const systemOptions: { args: string[] } = JSON.parse(readFileSync(captured, "utf8"));
    expect(systemOptions.args).toContain("core.sshCommand=trusted-system-ssh");
    rmSync(captured);
    writeFileSync(system, "[invalid\n");
    await expect(pushBranch(repo, work, "broken", sha)).rejects.toThrow();
    expect(existsSync(captured)).toBe(false);
    expect(
      (
        await sh([gitBin, "show-ref", "--verify", "--quiet", "refs/heads/broken"], {
          cwd: bare,
          env: original as Record<string, string>,
          allowFail: true,
        })
      ).exitCode,
    ).toBe(1);
  } finally {
    for (const name of [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "PATH",
    ]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
