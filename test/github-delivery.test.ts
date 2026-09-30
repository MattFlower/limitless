import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { createPullRequest, mergePullRequest, pushBranch, pushExistingBranch } from "../src/git/repos.ts";
import { GitHubUnavailableError, githubRetry, isTransient } from "../src/git/retry.ts";
import { sh } from "../src/util/proc.ts";
import { fakeGh } from "./fake-gh.ts";

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
const oldPath = process.env.PATH;
const oldDelays = githubRetry.delaysMs;
afterEach(() => {
  process.env.PATH = oldPath;
  githubRetry.delaysMs = oldDelays;
  rmSync(dir, { recursive: true, force: true });
});

function withGh(plan: Record<string, string[]>) {
  githubRetry.delaysMs = [5, 10];
  const gh = fakeGh(dir, plan);
  process.env.PATH = `${gh.bin}:${oldPath}`;
  return gh;
}
const pr = (signal?: AbortSignal, title = "T") =>
  createPullRequest(repo, { branch: "b", base: "main", title, body: "B", cwd: work, signal });

/** A `git push` that fails `dropped` times without effect, then lands but reports a 502, once. */
function flakyPush(dropped = 0) {
  const real = Bun.which("git") ?? "git";
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = push ]; then echo push >> '${join(dir, "pushes")}'; fi
if [ "$1" = push ] && [ ! -f '${join(dir, "flaked")}' ]; then
  if [ "$(wc -l < '${join(dir, "pushes")}')" -gt ${dropped} ]; then touch '${join(dir, "flaked")}'; '${real}' "$@" || exit 1; fi
  echo "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502" >&2; exit 1
fi
exec '${real}' "$@"
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${oldPath}`;
  githubRetry.delaysMs = [5, 10];
  return () => readFileSync(join(dir, "pushes"), "utf8").trim().split("\n").length;
}

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

test("classifies only 5xx, 429 and network failures as transient", () => {
  expect(isTransient("HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)")).toBe(true);
  expect(isTransient("HTTP 429: Too Many Requests")).toBe(true);
  expect(isTransient("dial tcp: lookup api.github.com: i/o timeout")).toBe(true);
  expect(isTransient("ssh: Could not resolve host github.com")).toBe(true);
  expect(isTransient("curl: (7) Could not connect to server")).toBe(true);
  expect(isTransient("dial tcp: lookup github.com: Temporary failure in name resolution")).toBe(true);
  expect(isTransient("HTTP 422: Validation Failed (504 Gateway Timeout in title)")).toBe(false);
  expect(isTransient("HTTP 422: Validation Failed")).toBe(false);
  expect(isTransient("HTTP 401: Bad credentials")).toBe(false);
  expect(isTransient("HTTP 409: Conflict")).toBe(false);
});

test("PR create retries 502s and then delivers one PR", async () => {
  const gh = withGh({ create: ["fail502", "fail502"] });
  expect(await pr()).toBe(gh.url);
  expect(gh.calls("pr create")).toHaveLength(3);
});

test("PR create does not retry a 422", async () => {
  const gh = withGh({ create: ["fail422"] });
  const error = await pr().catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(GitHubUnavailableError);
  expect(gh.calls("pr create")).toHaveLength(1);
});

test("a 422 is not retried even when the PR title mentions a timeout", async () => {
  const gh = withGh({ create: ["fail422", "fail422", "fail422"] });
  const error = await pr(undefined, "Fix timeout handling").catch((e: Error) => e);
  expect(error).not.toBeInstanceOf(GitHubUnavailableError);
  expect(gh.calls("pr create")).toHaveLength(1);
});

test("a PR created by the last uncertain attempt is still found", async () => {
  const gh = withGh({ create: ["fail502", "fail502", "ok502"] });
  expect(await pr()).toBe(gh.url);
  expect(gh.calls("pr create")).toHaveLength(3);
});

test("a 502 that hid a created PR reuses it instead of creating another", async () => {
  const gh = withGh({ create: ["ok502"] });
  expect(await pr()).toBe(gh.url);
  expect(gh.calls("pr create")).toHaveLength(1);
});

test("exhausted retries report GitHub unavailable; a failed lookup never leads to create", async () => {
  const gh = withGh({ list: ["fail502", "fail502", "fail502"] });
  const error = await pr().catch((e: Error) => e);
  expect(error).toBeInstanceOf(GitHubUnavailableError);
  expect((error as Error).message).toStartWith("GitHub unavailable: PR lookup failed after 3 attempts");
  expect((error as Error).message).toContain("HTTP 502");
  expect(gh.calls("pr create")).toHaveLength(0);
});

test("PR edit failures are retried, not treated as success", async () => {
  writeFileSync(join(dir, "gh-pr"), "https://github.com/test/repo/pull/1");
  const gh = withGh({ edit: ["fail502"] });
  expect(await pr()).toBe(gh.url);
  expect(gh.calls("pr edit")).toHaveLength(2);
  withGh({ edit: ["fail422"] });
  await expect(pr()).rejects.toThrow("HTTP 422");
});

test("merge reconciles a 502 that actually merged", async () => {
  const gh = withGh({ merge: ["ok502"] });
  expect(await mergePullRequest(gh.url, work, "T")).toBe("merged");
  expect(gh.calls("pr merge")).toHaveLength(1);
  expect(gh.calls("pr view")).toHaveLength(1);
});

test("a merge that lands on the final attempt is reported merged, not retried as auto-merge", async () => {
  const gh = withGh({ merge: ["fail502", "fail502", "ok502"] });
  expect(await mergePullRequest(gh.url, work, "T")).toBe("merged");
  expect(gh.calls("pr merge")).toHaveLength(3);
  expect(gh.calls("pr merge").some((c) => c.includes("--auto"))).toBe(false);
});

test("merge retries transient failures and leaves the PR open once exhausted", async () => {
  let gh = withGh({ merge: ["fail502"] });
  expect(await mergePullRequest(gh.url, work)).toBe("merged");
  expect(gh.calls("pr merge")).toHaveLength(2);
  rmSync(join(dir, "gh-calls"));
  rmSync(join(dir, "gh-merged"));
  gh = withGh({ merge: Array(6).fill("fail502") });
  expect(await mergePullRequest(gh.url, work)).toBe("failed");
  expect(gh.calls("pr merge")).toHaveLength(6);
});

test("cancelling during backoff stops further GitHub calls", async () => {
  const gh = withGh({ create: ["fail502"] });
  githubRetry.delaysMs = [5_000, 5_000];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  await expect(pr(controller.signal)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
  await Bun.sleep(50);
  expect(gh.calls("pr create")).toHaveLength(1);
  // The initial lookup plus the reconciliation right after the uncertain create; nothing after cancel.
  expect(gh.calls("pr list")).toHaveLength(2);
});

test("push reconciles a 502 that actually landed", async () => {
  const pushes = flakyPush();
  await pushBranch(repo, work, "feature");
  const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  expect((await git(work, "ls-remote", bare, "refs/heads/feature")).stdout).toContain(head);
  expect(pushes()).toBe(1);
});

test("a push that lands on the final attempt is reconciled instead of reported unavailable", async () => {
  const pushes = flakyPush(2);
  await pushBranch(repo, work, "feature");
  const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  expect((await git(work, "ls-remote", bare, "refs/heads/feature")).stdout).toContain(head);
  expect(pushes()).toBe(3);
});

test("existing-branch push reconciles a 502 that actually landed", async () => {
  const base = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "file.txt"), "fixed\n");
  await git(work, "commit", "-qam", "fix");
  const pushes = flakyPush();
  await pushExistingBranch(repo, work, "dependabot/npm/pkg-2", base);
  const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  expect((await git(work, "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).stdout).toContain(head);
  expect(pushes()).toBe(1);
});
