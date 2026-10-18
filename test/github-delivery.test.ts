import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { ConfinementError, gitConfinement } from "../src/git/confinement.ts";
import { pushBranch, pushExistingBranch, remoteBranchSha } from "../src/git/repos.ts";
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
  const updated = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  // Publication scans `updated`; a later local HEAD must not change what gets pushed.
  writeFileSync(join(work, "file.txt"), "unscanned change\n");
  await git(work, "commit", "-qam", "unscanned");
  await pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base, undefined, undefined, updated);
  expect((await git(work, "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).stdout).toContain(updated);
  expect((await git(work, "ls-remote", bare, "refs/heads/main")).stdout).toBe("");
  await expect(pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base)).rejects.toThrow("moved");
});

test.each(["remote", "existing", "local"])("%s delivery never follows tags or notes", async (kind) => {
  const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "file.txt"), "changed\n");
  await git(work, "commit", "-qam", "safe change");
  const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  await git(work, "config", "push.followTags", "true");
  await git(work, "tag", "-am", "synthetic tag", "secret-host.example");
  await git(work, "notes", "add", "-m", "synthetic note");
  const branch = kind === "existing" ? "dependabot/npm/pkg-2" : "delivered";
  if (kind === "existing") await pushExistingBranch(repo, work, branch, base);
  else await pushBranch(kind === "local" ? { ...repo, kind: "local", localPath: bare } : repo, work, branch);
  expect((await git(bare, "rev-parse", `refs/heads/${branch}`)).stdout.trim()).toBe(head);
  expect((await git(bare, "for-each-ref", "refs/tags", "refs/notes")).stdout).toBe("");
});

test.each(["passing", "rejecting"])(
  "GitHub transport ignores a checkout's URL rewrite to a helper (%s backend)",
  async (kind) => {
    const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    writeFileSync(join(work, "file.txt"), "changed\n");
    await git(work, "commit", "-qam", "change");
    const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    const marker = join(dir, "transport-marker");
    const helper = join(dir, "transport-helper");
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    await git(work, "config", `url.ext::${helper}.insteadOf`, bare);
    await git(work, "config", "protocol.ext.allow", "always");
    const calls: string[][] = [];
    const backend = {
      wrap: async (cmd: string[], opts: { cwd: string }) => {
        if (opts.cwd === work) calls.push(cmd);
        if (kind === "rejecting") throw new ConfinementError("test refusal");
        return cmd;
      },
    };
    const deliver = () =>
      gitConfinement.run(backend, async () => {
        expect(await remoteBranchSha(repo, work, "dependabot/npm/pkg-2")).toBe(base);
        await pushBranch(repo, work, "delivered");
        await pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base);
      });
    if (kind === "rejecting") await expect(deliver()).rejects.toBeInstanceOf(ConfinementError);
    else {
      await deliver();
      for (const branch of ["delivered", "dependabot/npm/pkg-2"])
        expect((await git(bare, "rev-parse", `refs/heads/${branch}`)).stdout.trim()).toBe(head);
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
  },
);
