import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import * as command from "../src/git/command.ts";
import { ConfinementError, gitConfinement } from "../src/git/confinement.ts";
import * as hardening from "../src/git/hardening.ts";
import {
  githubRetry,
  mergePullRequest,
  pushBranch,
  pushExistingBranch,
  remoteBranchSha,
} from "../src/git/repos.ts";
import * as proc from "../src/util/proc.ts";
import { CommandError, sh } from "../src/util/proc.ts";

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

test.each([false, true])(
  "push guard runs after asynchronous preparation and never retries refusal (transport-like error: %s)",
  async (transient) => {
    const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cacheGit = command.cacheGit;
    const harden = hardening.harden;
    const execute = proc.sh;
    let preparingPush = false;
    let owned = true;
    let guards = 0;
    const refused = transient
      ? new CommandError("claim lost", 1, "", "HTTP 502", false)
      : new Error("claim lost");
    const boundary = spyOn(command, "cacheGit").mockImplementation((...args) => {
      if (args[0].includes("push")) preparingPush = true;
      return cacheGit(...args);
    });
    const preparation = spyOn(hardening, "harden").mockImplementation(async (...args) => {
      const result = await harden(...args);
      if (preparingPush) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const transport = spyOn(proc, "sh").mockImplementation((cmd, opts) => {
      if (cmd.includes("push")) throw new Error("unexpected push");
      return execute(cmd, opts);
    });
    const result = pushExistingBranch(
      repo,
      work,
      "dependabot/npm/pkg-2",
      base,
      undefined,
      undefined,
      base,
      () => {
        guards++;
        if (!owned) throw refused;
      },
    );
    // Attach a rejection handler before releasing preparation.
    const outcome = result.catch((error: unknown) => error);
    try {
      await entered.promise;
      owned = false;
      release.resolve();
      expect(await outcome).toBe(refused);
      expect(guards).toBe(1);
      expect(transport.mock.calls.filter(([cmd]) => cmd.includes("push"))).toEqual([]);
    } finally {
      release.resolve();
      await outcome;
      boundary.mockRestore();
      preparation.mockRestore();
      transport.mockRestore();
    }
  },
);

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

test.each([
  { failure: "HTTP 502", throwsAt: 0, asyncGuard: false },
  { failure: "checks required", throwsAt: 0, asyncGuard: false },
  { failure: "HTTP 502", throwsAt: 1, asyncGuard: false },
  { failure: "HTTP 502", throwsAt: 2, asyncGuard: false },
  { failure: "checks required", throwsAt: 2, asyncGuard: false },
  { failure: "HTTP 502", throwsAt: 0, asyncGuard: true },
  { failure: "HTTP 502", throwsAt: 1, asyncGuard: true },
  { failure: "HTTP 502", throwsAt: 2, asyncGuard: true },
])("merge guard covers attempts and propagates refusal: %j", async ({ failure, throwsAt, asyncGuard }) => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "merge-calls");
  const sha = "a".repeat(40);
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import {appendFileSync, existsSync} from "node:fs";
const args = process.argv.slice(2), file = ${JSON.stringify(calls)};
if(args[1] === "view") {
 console.log(JSON.stringify({title:"PR",body:"body",headRefOid:${JSON.stringify(sha)},state:"OPEN"}));
} else if(args[1] === "merge") {
 const first = !existsSync(file);
 appendFileSync(file, args.join(" ")+"\\n");
 if(first) {console.error(${JSON.stringify(failure)});process.exit(1);}
}
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  const delay = githubRetry.baseDelayMs;
  process.env.PATH = `${bin}:${path}`;
  githubRetry.baseDelayMs = 1;
  let guards = 0;
  const refused =
    throwsAt === 2 ? new CommandError("claim lost", 1, "", "HTTP 502", false) : new Error("claim lost");
  try {
    const result = mergePullRequest(
      "https://github.com/test/repo/pull/1",
      work,
      sha,
      undefined,
      undefined,
      [],
      {
        guard: () => {
          const check = () => {
            guards++;
            if (guards === throwsAt) throw refused;
          };
          return asyncGuard ? Promise.resolve().then(check) : check();
        },
      },
    );
    if (throwsAt) await expect(result).rejects.toBe(refused);
    else expect(await result).toBe(failure === "HTTP 502" ? "merged" : "auto");
    const merges = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    expect(guards).toBe(throwsAt || 2);
    expect(merges).toHaveLength(throwsAt ? throwsAt - 1 : 2);
    if (!throwsAt && failure === "checks required") expect(merges[1]).toContain("--auto");
  } finally {
    process.env.PATH = path;
    githubRetry.baseDelayMs = delay;
  }
});

test("explicit run-branch lease permits updates and rewinds and recovers an already-landed push", async () => {
  const branch = "dependabot/npm/pkg-2";
  const ref = `refs/heads/${branch}`;
  const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "file.txt"), "next\n");
  await git(work, "commit", "-qam", "next");
  const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  const bareLease = await sh(["git", "push", "--force-with-lease", bare, `${head}:${ref}`], {
    cwd: work,
    allowFail: true,
  });
  expect(bareLease.exitCode).not.toBe(0);
  expect(bareLease.stderr).toContain("stale info");
  await expect(pushBranch(repo, work, branch, head, undefined, undefined, null)).rejects.toThrow();
  expect(await remoteBranchSha(repo, work, branch)).toBe(base);
  await pushBranch(repo, work, branch, head, undefined, undefined, base);
  expect(await remoteBranchSha(repo, work, branch)).toBe(head);
  await pushBranch(repo, work, branch, base, undefined, undefined, head);
  expect(await remoteBranchSha(repo, work, branch)).toBe(base);
  await pushBranch(repo, work, "new-branch", head, undefined, undefined, null);
  expect(await remoteBranchSha(repo, work, "new-branch")).toBe(head);
  await pushBranch(repo, work, "new-branch", head, undefined, undefined, head);
  // Force the refusal path, even on Git versions that accept an up-to-date push with a stale lease.
  const original = command.cacheGit;
  let refused = false;
  const refusal = new Error("synthetic stale lease");
  const spy = spyOn(command, "cacheGit").mockImplementation((args, ...rest) => {
    if (args.includes("push")) {
      refused = true;
      throw refusal;
    }
    return original(args, ...rest);
  });
  try {
    await pushBranch(repo, work, "new-branch", head, undefined, undefined, null);
    expect(refused).toBe(true);
    await expect(pushBranch(repo, work, branch, head, undefined, undefined, null)).rejects.toBe(refusal);
  } finally {
    spy.mockRestore();
  }
});
