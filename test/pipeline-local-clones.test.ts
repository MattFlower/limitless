import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { Repo } from "../src/core/types.ts";
import { recordWorktree } from "../src/git/command.ts";
import {
  cachePath,
  pushBranch,
  removeWorktree,
  slugify,
  withRepoLock,
  worktreeOwner,
} from "../src/git/repos.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import {
  approve,
  type Handler,
  holdout,
  pass,
  pipelineSetup,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start } = pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

describe("local factory clones", () => {
  const reply: Handler = (s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify") return { structured: pass };
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const git = async (cwd: string, ...args: string[]) => (await sh(["git", ...args], { cwd })).stdout.trim();
  const files = (dir: string): string[] =>
    existsSync(join(repoDir, dir))
      ? readdirSync(join(repoDir, dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name).slice(repoDir.length + 1))
      : [];
  /** Every tracked and untracked file outside .git, hashed together. */
  const workingTree = () => {
    const hash = new Bun.CryptoHasher("sha256");
    for (const path of files("")
      .filter((path) => !path.startsWith(".git/"))
      .sort())
      hash
        .update(`${path}\0`)
        .update(readFileSync(join(repoDir, path)))
        .update("\0");
    return hash.digest("hex");
  };
  const snapshot = (): Record<string, Buffer | string> => ({
    ...Object.fromEntries(
      [
        ".git/HEAD",
        ".git/index",
        ".git/config",
        ...["packed-refs"].filter((name) => existsSync(join(repoDir, ".git", name))).map((n) => `.git/${n}`),
        ...["hooks", "refs", "logs", "info"].flatMap((dir) => files(`.git/${dir}`)),
      ].map((path) => [path, readFileSync(join(repoDir, path))]),
    ),
    workingTree: workingTree(),
  });

  test.each([false, true])(
    "full delivery preserves the source, with concurrent config edits=%s",
    async (editConfig) => {
      await git(repoDir, "config", "user.email", "original@example.test");
      await git(repoDir, "remote", "add", "original", "/unused/original");
      writeFileSync(join(repoDir, "staged.txt"), "staged input\n");
      await git(repoDir, "add", "staged.txt");
      writeFileSync(join(repoDir, "greeting.txt"), "dirty input\n");
      writeFileSync(join(repoDir, "untracked.txt"), "untracked input\n");
      const marker = join(repoDir, "hook-ran");
      writeFileSync(join(repoDir, ".git/hooks/pre-receive"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
        mode: 0o755,
      });
      let prepared = () => {};
      const ready = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      let release = () => {};
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = start(async (s) => {
        if (roleOf(s) === "triage") {
          prepared();
          await paused;
        }
        return reply(s);
      });
      const before = snapshot();
      const current = await git(repoDir, "symbolic-ref", "HEAD");
      const base = await git(repoDir, "rev-parse", "HEAD");
      const sourceTrees = await git(repoDir, "worktree", "list", "--porcelain");
      const refsBefore = await git(repoDir, "for-each-ref", "--format=%(refname)");
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      try {
        await ready;
        const repo = f.store.getRepo(run.repoId);
        if (!repo) throw new Error("missing repo");
        const work = f.store.getRunState<RunState>(run.id)?.worktreePath;
        if (!work) throw new Error("missing worktree");
        const cache = cachePath(f.cfg.paths, repo);
        expect(await git(repoDir, "worktree", "list", "--porcelain")).toBe(sourceTrees);
        expect(await git(cache, "worktree", "list", "--porcelain")).toContain(work);
        expect(await worktreeOwner(work)).toBe(await worktreeOwner(cache));
        expect(snapshot()).toEqual(before);
        if (editConfig) {
          await git(repoDir, "remote", "add", "during-run", "/unused/during-run");
          await git(repoDir, "config", "user.email", "added@example.test");
        }
        const expected = snapshot();
        release();
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const result = f.store.getRun(run.id);
        expect(await git(repoDir, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
        expect(await git(repoDir, "symbolic-ref", "HEAD")).toBe(current);
        expect(await git(repoDir, "rev-parse", "HEAD")).toBe(base);
        expect(await git(repoDir, "worktree", "list", "--porcelain")).toBe(sourceTrees);
        const delivered = snapshot();
        expect(
          Object.keys(delivered)
            .filter((path) => !(path in expected))
            .sort(),
        ).toEqual([`.git/logs/refs/heads/${result?.branch}`, `.git/refs/heads/${result?.branch}`]);
        const unchanged = { ...delivered };
        delete unchanged[`.git/refs/heads/${result?.branch}`];
        delete unchanged[`.git/logs/refs/heads/${result?.branch}`];
        expect(unchanged).toEqual(expected);
        expect(await git(repoDir, "for-each-ref", "--format=%(refname)")).toBe(
          [...refsBefore.split("\n"), `refs/heads/${result?.branch}`].sort().join("\n"),
        );
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(join(repoDir, "farewell.txt"))).toBe(false);
        if (editConfig) {
          expect(await git(repoDir, "remote", "get-url", "during-run")).toBe("/unused/during-run");
          expect(await git(repoDir, "config", "user.email")).toBe("added@example.test");
        }
        await removeWorktree(f.cfg.paths, repo, work);
        expect(await git(repoDir, "worktree", "list", "--porcelain")).toBe(sourceTrees);
        expect(snapshot()).toEqual(delivered);
      } finally {
        release();
      }
    },
  );

  test("later and concurrent runs fetch the current recorded base into one clone", async () => {
    let prepared = () => {};
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = start(async (s) => {
      if (roleOf(s) === "triage" && s.prompt.includes("first local run")) {
        prepared();
        await paused;
      }
      return reply(s);
    });
    const base = await git(repoDir, "rev-parse", "HEAD");
    const first = await f.createRun({ repo: repoDir, prompt: "first local run" });
    try {
      await ready;
      writeFileSync(join(repoDir, "upstream.txt"), "new base\n");
      await git(repoDir, "add", "upstream.txt");
      await git(repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "advance base");
      const advanced = await git(repoDir, "rev-parse", "HEAD");
      release();
      expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const later = await Promise.all(
        ["second", "third"].map((prompt) => f.createRun({ repo: repoDir, prompt })),
      );
      const repo = f.store.getRepo(first.repoId);
      if (!repo) throw new Error("missing repo");
      const cache = cachePath(f.cfg.paths, repo);
      for (const run of later) {
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        expect(f.store.getRun(run.id)?.baseSha).toBe(advanced);
        expect(await worktreeOwner(join(f.cfg.paths.work, run.id))).toBe(await worktreeOwner(cache));
      }
      expect(f.store.getRun(first.id)?.baseSha).toBe(base);
      expect(readdirSync(f.cfg.paths.repos)).toEqual([basename(cache)]);
      expect(await git(cache, "rev-parse", "--is-bare-repository")).toBe("true");
      expect(await git(repoDir, "worktree", "list", "--porcelain")).not.toContain(f.cfg.paths.work);
    } finally {
      release();
    }
  });

  test("source branch deletion and gc do not break subsequent local runs", async () => {
    await git(repoDir, "checkout", "-qb", "temporary");
    writeFileSync(join(repoDir, "temporary.txt"), "discarded branch\n");
    await git(repoDir, "add", "temporary.txt");
    await git(repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "temporary");
    const discarded = await git(repoDir, "rev-parse", "HEAD");
    await git(repoDir, "checkout", "main");
    const f = start(reply);
    const first = await f.createRun({ repo: repoDir, prompt: "First run" });
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(first.repoId);
    if (!repo) throw new Error("missing repo");
    const cache = cachePath(f.cfg.paths, repo);
    expect(await git(cache, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
      `refs/heads/${f.store.getRun(first.id)?.branch}`,
    );
    expect(existsSync(join(cache, "objects/info/alternates"))).toBe(false);
    await git(repoDir, "branch", "-D", "temporary");
    await git(repoDir, "reflog", "expire", "--expire=now", "--all");
    await git(repoDir, "gc", "--prune=now");
    expect(
      (await sh(["git", "cat-file", "-e", discarded], { cwd: repoDir, allowFail: true })).exitCode,
    ).not.toBe(0);
    const next = await f.createRun({ repo: repoDir, prompt: "Next run" });
    expect(await waitFor(f, next.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await git(cache, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/temporary")).toBe("");
    expect(await git(repoDir, "rev-parse", `refs/heads/${f.store.getRun(next.id)?.branch}`)).toBe(
      f.store.getRun(next.id)?.headSha ?? "",
    );
  });

  test("an explicit base branch runs after the recorded default branch is renamed", async () => {
    const f = start(reply);
    const first = await f.createRun({ repo: repoDir, prompt: "First run" });
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    await git(repoDir, "branch", "-m", "main", "trunk");
    const next = await f.createRun({ repo: repoDir, prompt: "Next run", baseBranch: "trunk" });
    expect(await waitFor(f, next.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(f.store.getRun(next.id)?.baseSha).toBe(await git(repoDir, "rev-parse", "trunk"));
  });

  test("source history rewrite and gc preserve an active run's base history", async () => {
    let prepared = () => {};
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = start(async (s) => {
      if (roleOf(s) === "triage" && s.prompt.includes("old base run")) {
        prepared();
        await paused;
      }
      return reply(s);
    });
    const base = await git(repoDir, "rev-parse", "HEAD");
    const first = await f.createRun({ repo: repoDir, prompt: "old base run" });
    try {
      await ready;
      await git(repoDir, "checkout", "--orphan", "replacement");
      await git(repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "rewrite base");
      await git(repoDir, "branch", "-M", "main");
      const rewritten = await git(repoDir, "rev-parse", "HEAD");
      await git(repoDir, "reflog", "expire", "--expire=now", "--all");
      await git(repoDir, "gc", "--prune=now");
      expect(
        (await sh(["git", "cat-file", "-e", base], { cwd: repoDir, allowFail: true })).exitCode,
      ).not.toBe(0);
      const next = await f.createRun({ repo: repoDir, prompt: "rewritten base run" });
      expect(await waitFor(f, next.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(f.store.getRun(next.id)?.baseSha).toBe(rewritten);
      release();
      expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const result = f.store.getRun(first.id);
      expect(result?.baseSha).toBe(base);
      expect(await git(repoDir, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
      expect(await git(repoDir, "rev-parse", `${result?.branch}^`)).toBe(base);
    } finally {
      release();
    }
  });

  test("an interrupted legacy worktree finishes in its owner while new runs use the clone", async () => {
    const f = start(reply);
    f.scheduler.drain();
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const work = join(f.cfg.paths.work, run.id);
    const branch = `limitless/${run.id}-${slugify(run.title, 30)}`;
    const baseSha = await git(repoDir, "rev-parse", "HEAD");
    await git(repoDir, "worktree", "add", "-b", branch, work, baseSha);
    await recordWorktree(work);
    f.store.updateRun(run.id, { status: "running", baseSha, branch }, {
      phase: "prepare",
      worktreePath: work,
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    } satisfies RunState);
    const owner = await worktreeOwner(work);
    expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("succeeded");
    expect(await worktreeOwner(work)).toBe(owner);
    expect(await git(repoDir, "rev-parse", `refs/heads/${branch}`)).toBe(
      f.store.getRun(run.id)?.headSha ?? "",
    );
    expect(existsSync(cachePath(f.cfg.paths, repo))).toBe(false);
    const fresh = await f.createRun({ repo: repoDir, prompt: "New run" });
    expect(await executeRun(f.deps, fresh.id, new AbortController().signal)).toBe("succeeded");
    expect(await worktreeOwner(join(f.cfg.paths.work, fresh.id))).toBe(
      await worktreeOwner(cachePath(f.cfg.paths, repo)),
    );
    expect(await git(repoDir, "rev-parse", `refs/heads/${f.store.getRun(fresh.id)?.branch}`)).toBe(
      f.store.getRun(fresh.id)?.headSha ?? "",
    );
    await removeWorktree(f.cfg.paths, repo, work);
    expect(await git(repoDir, "worktree", "list", "--porcelain")).not.toContain(work);
  });

  test("needs-human delivery keeps the existing local branch-only policy", async () => {
    const f = start((s) => (roleOf(s) === "implement" ? { files: { "farewell.txt": "BAD\n" } } : reply(s)));
    f.cfg.maxRounds = 1;
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    const result = f.store.getRun(run.id);
    expect(await git(repoDir, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
    expect(await git(repoDir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(result?.prUrl).toBeNull();
    expect(result?.merged).toBe(false);
  });

  test("local commits do not depend on the source or global git identity", async () => {
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    try {
      await git(repoDir, "config", "user.name", "Source Owner");
      await git(repoDir, "config", "user.email", "source@example.test");
      const f = start(reply);
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const branch = f.store.getRun(run.id)?.branch ?? "";
      expect(await git(repoDir, "show", "-s", "--format=%ae", branch)).toBe("limitless@localhost");
      expect(await git(repoDir, "config", "user.email")).toBe("source@example.test");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  test("delivery refuses a conflicting branch and a checked-out branch even with updateInstead", async () => {
    const f = start(reply);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const work = join(f.cfg.paths.work, run.id);
    await git(repoDir, "config", "receive.denyCurrentBranch", "updateInstead");
    const before = readFileSync(join(repoDir, ".git/index"));
    await expect(pushBranch(repo, work, "main")).rejects.toThrow();
    expect(readFileSync(join(repoDir, ".git/index"))).toEqual(before);
    expect(existsSync(join(repoDir, "farewell.txt"))).toBe(false);
    await git(
      repoDir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-qm",
      "unrelated",
    );
    await git(repoDir, "branch", "conflicting");
    const conflicting = await git(repoDir, "rev-parse", "conflicting");
    await expect(pushBranch(repo, work, "conflicting")).rejects.toThrow();
    expect(await git(repoDir, "rev-parse", "conflicting")).toBe(conflicting);
  });

  test("delivery does not restore a source tag deleted during the run, even with push.followTags", async () => {
    await git(repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "obsolete", "-m", "old");
    const f = start(reply);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const work = join(f.cfg.paths.work, run.id);
    expect(await git(work, "tag", "--list")).toContain("obsolete");
    await git(repoDir, "tag", "-d", "obsolete");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    const globalConfig = join(f.cfg.paths.work, "follow-tags.gitconfig");
    writeFileSync(globalConfig, "[push]\n\tfollowTags = true\n");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      await pushBranch(repo, work, "redelivered");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(await git(repoDir, "rev-parse", "refs/heads/redelivered")).toBe(
      await git(work, "rev-parse", "HEAD"),
    );
    expect(await git(repoDir, "tag", "--list")).toBe("");
  });

  const withEnv = async <T>(name: string, value: string, fn: () => Promise<T>): Promise<T> => {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  };
  const localRepo = (): Repo => ({
    id: "legacy",
    slug: "local/legacy",
    kind: "local",
    url: null,
    localPath: repoDir,
    defaultBranch: "main",
    mergePolicy: "none",
    createdAt: 0,
  });

  test("hooks from init.templateDir or placed in the clone never run, including delivery", async () => {
    const markers = join(home, "markers");
    const template = join(home, "template");
    mkdirSync(join(template, "hooks"), { recursive: true });
    const hook = (name: string) => `#!/bin/sh\nmkdir -p '${markers}' && touch '${markers}/${name}'\n`;
    for (const name of ["pre-push", "post-checkout"])
      writeFileSync(join(template, "hooks", name), hook(name), { mode: 0o755 });
    const globalConfig = join(home, "template.gitconfig");
    writeFileSync(globalConfig, `[init]\n\ttemplateDir = ${template}\n`);
    await withEnv("GIT_CONFIG_GLOBAL", globalConfig, async () => {
      const f = start(reply);
      const first = await f.createRun({ repo: repoDir, prompt: "First run" });
      expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const repo = f.store.getRepo(first.repoId);
      if (!repo) throw new Error("missing repo");
      const cache = cachePath(f.cfg.paths, repo);
      expect(existsSync(join(cache, "hooks", "pre-push"))).toBe(false);
      mkdirSync(join(cache, "hooks"), { recursive: true });
      for (const name of ["pre-push", "post-checkout"])
        writeFileSync(join(cache, "hooks", name), hook(name), { mode: 0o755 });
      const next = await f.createRun({ repo: repoDir, prompt: "Next run" });
      expect(await waitFor(f, next.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const result = f.store.getRun(next.id);
      expect(await git(repoDir, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
    });
    expect(existsSync(markers)).toBe(false);
  });

  test("config hooks activated only by the factory clone's git directory never run", async () => {
    const marker = join(home, "conditional-hook-ran");
    const f = start(reply);
    // Inactive wherever the factory discovers hooks before the clone exists; active inside it.
    const conditional = join(home, "conditional.gitconfig");
    const hook = "hook.conditional";
    writeFileSync(
      conditional,
      `[${hook}]\n\tcommand = touch '${marker}'\n${["reference-transaction", "post-checkout", "pre-push"]
        .map((event) => `\tevent = ${event}\n`)
        .join("")}`,
    );
    mkdirSync(f.cfg.paths.repos, { recursive: true });
    const globalConfig = join(home, "includeif.gitconfig");
    writeFileSync(
      globalConfig,
      `[includeIf "gitdir:${realpathSync(f.cfg.paths.repos)}/"]\n\tpath = ${conditional}\n`,
    );
    await withEnv("GIT_CONFIG_GLOBAL", globalConfig, async () => {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const repo = f.store.getRepo(run.repoId);
      const result = f.store.getRun(run.id);
      if (!repo) throw new Error("missing repo");
      // The include is in force in the clone: only the factory's blanking keeps the hook quiet.
      expect(await git(cachePath(f.cfg.paths, repo), "config", `${hook}.command`)).toBe(`touch '${marker}'`);
      expect(await git(repoDir, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
    });
    expect(existsSync(marker)).toBe(false);
  });

  test.each(["onbranch:limitless/**", "gitdir:**/worktrees/**"])(
    "config hooks activated only inside the run's worktree (%s) never run",
    async (condition) => {
      const marker = join(home, "worktree-hook-ran");
      const conditional = join(home, "worktree-hook.gitconfig");
      const hook = "hook.worktree";
      writeFileSync(
        conditional,
        `[${hook}]\n\tcommand = touch '${marker}'\n${["reference-transaction", "post-checkout", "pre-push"]
          .map((event) => `\tevent = ${event}\n`)
          .join("")}`,
      );
      const globalConfig = join(home, "worktree-includeif.gitconfig");
      writeFileSync(globalConfig, `[includeIf "${condition}"]\n\tpath = ${conditional}\n`);
      await withEnv("GIT_CONFIG_GLOBAL", globalConfig, async () => {
        const f = start(reply);
        const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const repo = f.store.getRepo(run.repoId);
        const result = f.store.getRun(run.id);
        if (!repo) throw new Error("missing repo");
        // Invisible from the clone, where the worktree is created; in force inside the worktree.
        const lookup = ["config", "--get-regexp", "^hook\\."];
        expect(
          (await sh(["git", ...lookup], { cwd: cachePath(f.cfg.paths, repo), allowFail: true })).exitCode,
        ).toBe(1);
        expect(await git(join(f.cfg.paths.work, run.id), "config", `${hook}.command`)).toBe(
          `touch '${marker}'`,
        );
        expect(await git(join(f.cfg.paths.work, run.id), "ls-files")).toContain("farewell.txt");
        expect(await git(repoDir, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
      });
      expect(existsSync(marker)).toBe(false);
    },
  );

  test("a SHA-256 source gets a SHA-256 clone and still receives its branch", async () => {
    const source = join(home, "sha256");
    mkdirSync(source);
    writeFileSync(join(source, "greeting.txt"), "hello\n");
    await git(source, "init", "-q", "-b", "main", "--object-format=sha256");
    await git(source, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    await git(source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const f = start(reply);
    const run = await f.createRun({ repo: source, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(run.repoId);
    const result = f.store.getRun(run.id);
    if (!repo) throw new Error("missing repo");
    expect(await git(cachePath(f.cfg.paths, repo), "rev-parse", "--show-object-format")).toBe("sha256");
    expect(result?.headSha).toMatch(/^[a-f0-9]{64}$/);
    expect(await git(source, "rev-parse", `refs/heads/${result?.branch}`)).toBe(result?.headSha ?? "");
  });

  test("delivery push runs no maintenance or gc in the source repository", async () => {
    const f = start(reply);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const work = join(f.cfg.paths.work, run.id);
    await git(repoDir, "config", "gc.auto", "1");
    const trace = join(home, "push.trace");
    await withEnv("GIT_TRACE", trace, () => pushBranch(repo, work, "traced"));
    const log = readFileSync(trace, "utf8");
    expect(log).toContain("receive-pack");
    expect(log).not.toMatch(/\b(maintenance|gc)\b/);
    expect(await git(repoDir, "rev-parse", "refs/heads/traced")).toBe(await git(work, "rev-parse", "HEAD"));
  });

  test("config-defined receive hooks in the source repository never run during delivery", async () => {
    const f = start(reply);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const work = join(f.cfg.paths.work, run.id);
    const marker = join(home, "config-hook-ran");
    // Only the source sees these; the quote and '=' exercise the receive-pack shell quoting.
    const name = "hook.source's x=y";
    await git(repoDir, "config", `${name}.command`, `touch '${marker}'`);
    for (const event of ["pre-receive", "update", "reference-transaction", "post-receive", "post-update"])
      await git(repoDir, "config", "--add", `${name}.event`, event);
    await pushBranch(repo, work, "config-hooked");
    expect(existsSync(marker)).toBe(false);
    expect(await git(repoDir, "rev-parse", "refs/heads/config-hooked")).toBe(
      await git(work, "rev-parse", "HEAD"),
    );
  });

  test("delivery from a legacy worktree pushes nothing: the branch already lives in the source", async () => {
    const legacy = join(home, "legacy-work");
    await git(repoDir, "worktree", "add", "-q", "-b", "legacy-branch", legacy);
    await recordWorktree(legacy);
    await pushBranch(localRepo(), legacy, "would-be-created");
    const refs = await git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads");
    expect(refs).toContain("refs/heads/legacy-branch");
    expect(refs).not.toContain("would-be-created");
  });

  test("redelivery succeeds when the source branch already contains the run head", async () => {
    const f = start(reply);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(run.repoId);
    const result = f.store.getRun(run.id);
    if (!repo || !result?.branch || !result.headSha) throw new Error("missing run");
    const ref = `refs/heads/${result.branch}`;
    const user = ["-c", "user.name=t", "-c", "user.email=t@t"];
    const built = await git(repoDir, ...user, "commit-tree", `${ref}^{tree}`, "-p", ref, "-m", "user work");
    await git(repoDir, "update-ref", ref, built);
    await pushBranch(repo, join(f.cfg.paths.work, run.id), result.branch, result.headSha);
    expect(await git(repoDir, "rev-parse", ref)).toBe(built);
  });

  test("the clone's tags follow the source's, including deleted and moved tags", async () => {
    const user = ["-c", "user.name=t", "-c", "user.email=t@t"];
    await git(repoDir, ...user, "tag", "-a", "obsolete", "-m", "old");
    await git(repoDir, "tag", "moved");
    const f = start(reply);
    const first = await f.createRun({ repo: repoDir, prompt: "First run" });
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const repo = f.store.getRepo(first.repoId);
    if (!repo) throw new Error("missing repo");
    const tags = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags");
    expect(await tags(cachePath(f.cfg.paths, repo))).toBe(await tags(repoDir));
    await git(repoDir, "tag", "-d", "obsolete");
    await git(repoDir, ...user, "commit", "-q", "--allow-empty", "-m", "advance");
    await git(repoDir, "tag", "-f", "moved");
    await git(repoDir, "tag", "fresh");
    const next = await f.createRun({ repo: repoDir, prompt: "Next run" });
    expect(await waitFor(f, next.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await tags(cachePath(f.cfg.paths, repo))).toBe(await tags(repoDir));
  });

  test("a lock taken through a symlinked path serializes with its real path", async () => {
    const real = join(home, "real");
    mkdirSync(real);
    symlinkSync(real, join(home, "link"));
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRepoLock(join(home, "link", "repos", "local-x.git"), async () => {
      order.push("first:start");
      await held;
      order.push("first:end");
    });
    const second = withRepoLock(join(realpathSync(real), "repos", "local-x.git"), async () => {
      order.push("second");
    });
    await Bun.sleep(20);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
