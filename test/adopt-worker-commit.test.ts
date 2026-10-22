import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../src/config.ts";
import type { Repo } from "../src/core/types.ts";
import * as command from "../src/git/command.ts";
import { addDetachedWorktree, adoptWorkerCommit, commitAll, headSha } from "../src/git/repos.ts";
import { agentEnv, sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

const commit = {
  message: "Worker change",
  authorName: "Worker Author",
  authorEmail: "author@example.com",
  committerName: "Worker Committer",
  committerEmail: "committer@example.com",
};
const env = () => ({
  ...agentEnv(),
  GIT_AUTHOR_NAME: commit.authorName,
  GIT_AUTHOR_EMAIL: commit.authorEmail,
  GIT_COMMITTER_NAME: commit.committerName,
  GIT_COMMITTER_EMAIL: commit.committerEmail,
});
const git = async (cwd: string, ...args: string[]) => (await sh(["git", ...args], { cwd })).stdout.trim();
const fixture = seeded(async (dir) => {
  const source = join(dir, "source");
  mkdirSync(source);
  await git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "file"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "base");
  const parentSha = await headSha(source);
  writeFileSync(join(source, "file"), "worker\n");
  const sha = await commitAll(source, commit.message, { verbatim: true, env: env() });
  if (!sha) throw new Error("missing worker commit");
  await git(dir, "clone", "--bare", source, join(dir, "remote.git"));
  return { parentSha, sha };
});
let dir: string, source: string, cwd: string, paths: Paths, repo: Repo, parentSha: string, sha: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "adopt-worker-"));
  ({
    value: { parentSha, sha },
  } = await fixture(dir));
  source = join(dir, "source");
  paths = { home: dir, repos: join(dir, "repos"), work: join(dir, "work"), db: "", runs: "", configDir: "" };
  mkdirSync(paths.repos);
  mkdirSync(paths.work);
  repo = {
    id: "r",
    slug: "test/repo",
    kind: "github",
    url: join(dir, "remote.git"),
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
    createdAt: 0,
  };
  const cache = join(paths.repos, "test__repo.git");
  await git(dir, "clone", "--bare", repo.url ?? "", cache);
  // Adoption must fetch through repo.url, even if the cache's origin differs.
  await git(cache, "remote", "set-url", "origin", join(dir, "absent.git"));
  cwd = join(paths.work, "coordinator");
  await addDetachedWorktree(cache, parentSha, cwd);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const adopt = (signal?: AbortSignal) =>
  adoptWorkerCommit(paths, repo, cwd, { branch: "worker", parentSha, sha, commit }, signal);
const publish = async (tip = sha) =>
  git(source, "push", "--force", repo.url ?? "", `${tip}:refs/heads/worker`);

test.each(["success", "reset preparation fails", "cancel after checks", "cancel at reset"])(
  "adoption has one cancellable mutation and no cleanup (%s)",
  async (scenario) => {
    await publish();
    const controller = new AbortController();
    const execute = command.worktreeGit;
    const mutations: string[][] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const boundary = spyOn(command, "worktreeGit").mockImplementation(async (args, opts, ...rest) => {
      if (args.includes("clean")) throw new Error("cleanup must not run");
      if (args[1] === "reset") {
        mutations.push(args);
        signals.push(opts.signal);
        if (scenario === "reset preparation fails") throw new Error("reset preparation failed");
        if (scenario === "cancel at reset") controller.abort(new Error("adoption cancelled"));
        opts.signal?.throwIfAborted();
      }
      const result = await execute(args, opts, ...rest);
      if (args[1] === "status" && scenario === "cancel after checks")
        controller.abort(new Error("adoption cancelled"));
      return result;
    });
    try {
      if (scenario === "success") await adopt(controller.signal);
      else
        await expect(adopt(controller.signal)).rejects.toThrow(
          scenario === "reset preparation fails" ? "reset preparation failed" : "adoption cancelled",
        );
    } finally {
      boundary.mockRestore();
    }
    expect(mutations).toEqual(
      scenario === "cancel after checks" ? [] : [["git", "reset", "--hard", "-q", sha]],
    );
    expect(signals).toHaveLength(scenario === "cancel after checks" ? 0 : 1);
    if (signals.length) expect(signals[0]).toBe(controller.signal);
    expect(await headSha(cwd)).toBe(scenario === "success" ? sha : parentSha);
    expect(await git(cwd, "rev-list", "--count", `${parentSha}..HEAD`)).toBe(
      scenario === "success" ? "1" : "0",
    );
    expect(await git(cwd, "status", "--porcelain", "--untracked-files=all")).toBe("");
  },
);

test.each([
  "tip moved",
  "two parents",
  "different parent",
  "trailing newline",
  "author name",
  "author email",
  "committer name",
  "committer email",
  "encoding",
  "invalid UTF-8",
  "dirty tracked",
  "dirty untracked",
  "HEAD moved",
])("refuses %s before moving HEAD", async (kind) => {
  if (!["tip moved", "dirty tracked", "dirty untracked", "HEAD moved"].includes(kind)) {
    const result = await sh(["git", "cat-file", "commit", sha], { cwd: source });
    let raw = result.stdout;
    if (kind === "two parents")
      raw = raw.replace(`parent ${parentSha}`, `parent ${parentSha}\nparent ${sha}`);
    if (kind === "different parent") raw = raw.replace(`parent ${parentSha}`, `parent ${sha}`);
    if (kind === "trailing newline") raw += "\n";
    for (const field of ["author", "committer"] as const) {
      if (kind === `${field} name`) raw = raw.replace(commit[`${field}Name`], "Another Name");
      if (kind === `${field} email`) raw = raw.replace(commit[`${field}Email`], "other@example.com");
    }
    if (kind === "encoding") raw = raw.replace("\n\n", "\nencoding UTF-8\n\n");
    const bytes =
      kind === "invalid UTF-8" ? Buffer.concat([Buffer.from(raw), Buffer.from([255])]) : Buffer.from(raw);
    const object = join(dir, "commit-object");
    writeFileSync(object, bytes);
    sha = await git(source, "hash-object", "-t", "commit", "-w", object);
  }
  await publish(kind === "tip moved" ? parentSha : sha);
  if (kind === "dirty tracked") writeFileSync(join(cwd, "file"), "dirty\n");
  if (kind === "dirty untracked") writeFileSync(join(cwd, "untracked"), "dirty\n");
  if (kind === "HEAD moved") await git(cwd, "reset", "--hard", sha);
  const before = await headSha(cwd);
  const reason =
    kind === "tip moved"
      ? "branch tip"
      : kind.startsWith("dirty")
        ? "dirty"
        : kind === "HEAD moved"
          ? "HEAD"
          : kind === "trailing newline"
            ? "message"
            : kind.includes("name") || kind.includes("email")
              ? "identity"
              : kind === "invalid UTF-8"
                ? "UTF-8"
                : "headers";
  await expect(adopt()).rejects.toThrow(reason);
  expect(await headSha(cwd)).toBe(before);
});
