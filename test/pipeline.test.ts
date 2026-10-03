import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Repo, Role, RunStatus, StageName } from "../src/core/types.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { completeMerge, mergeGit, prepareMerge } from "../src/git/merge.ts";
import {
  cachePath,
  githubRetry,
  pushBranch,
  removeWorktree,
  slugify,
  withRepoLock,
  worktreeOwner,
} from "../src/git/repos.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { githubWebhook } from "../src/integrations/github.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import { CancelledError, NoCapacityError, RunContext, type RunState } from "../src/pipeline/context.ts";
import { executeRun, readingTimeout } from "../src/pipeline/engine.ts";
import { specPrompt } from "../src/pipeline/prompts.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { LOCAL_FINDER_TIMEOUT_MS } from "../src/pipeline/review.ts";
import { LaterReviewSchema, ReviewSchema, renderSpec, toStrictJsonSchema } from "../src/pipeline/schemas.ts";
import { outOfRunCriteria } from "../src/pipeline/spec-criteria.ts";
import { specScopeViolation } from "../src/pipeline/spec-scope.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { sh } from "../src/util/proc.ts";
import { reviewOutput } from "./evals-reading-support.ts";
import { findingEvidence } from "./review-support.ts";
import { waitClock } from "./wait-clock.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

const providers: ProviderDef[] = [
  { id: "alpha", label: "Alpha", harness: "fake", billing: "subscription", maxConcurrent: 2 },
  { id: "beta", label: "Beta", harness: "fake", billing: "subscription", maxConcurrent: 2 },
];
const models: ModelDef[] = [
  {
    id: "alpha/m",
    provider: "alpha",
    model: "alpha-1",
    vendor: "anthropic",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 1, output: 1 },
  },
  {
    id: "beta/m",
    provider: "beta",
    model: "beta-1",
    vendor: "openai",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 1, output: 1 },
  },
];
const everyone = { default: ["alpha/m", "beta/m"] };
const policy = {
  triage: everyone,
  spec: everyone,
  holdout: everyone,
  implement: everyone,
  review: { default: ["beta/m", "alpha/m"] },
  verify: { default: ["beta/m", "alpha/m"] },
} as unknown as Policy;

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const originalPath = process.env.PATH;

async function makeRepo(): Promise<string> {
  const dir = join(home, "target");
  mkdirSync(dir);
  writeFileSync(join(dir, "greeting.txt"), "hello\n");
  writeFileSync(
    join(dir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "no-bad", run = "! grep -rq BAD --include=*.txt ." }]\n`,
  );
  await sh(["git", "init", "-q", "-b", "main"], { cwd: dir });
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: dir });
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

type Handler = (spec: AgentSpec) => FakeReply | Promise<FakeReply>;

function roleOf(spec: AgentSpec): string {
  const p = spec.prompt;
  if (p.startsWith("Classify this software task")) return "triage";
  if (p.startsWith("Write the specification")) return "spec";
  if (p.startsWith("Write holdout checks")) return "holdout";
  if (/^You are (an adversarial|a) code reviewer/.test(p)) return "review";
  if (p.startsWith("You are the acceptance verifier")) return "verify";
  return "implement";
}

const triage = (over: Record<string, unknown> = {}) => ({
  title: "Add farewell",
  task_class: "feature",
  complexity: "small",
  risk: "low",
  ambiguity: "low",
  blocking_questions: [],
  summary: "Add a farewell file",
  suggested_profile: "standard",
  ...over,
});
const spec = {
  summary: "Add farewell.txt",
  assumptions: [],
  requirements: ["farewell.txt exists"],
  acceptance_criteria: [
    { id: "AC-1", criterion: "farewell.txt says goodbye", how_to_verify: "cat farewell.txt" },
  ],
  out_of_scope: [],
  blocking_questions: [],
};
const approve = {
  verdict: "approve",
  summary: "LGTM: checked the diff against every requirement",
  findings: [],
};
const holdout = {
  scenarios: [
    {
      id: "H-1",
      description: "file appears",
      steps: "cat farewell.txt",
      expected: "goodbye",
      edge_case: false,
    },
    {
      id: "H-2",
      description: "missing input",
      steps: "test ! -e missing.txt",
      expected: "exit zero",
      edge_case: true,
    },
    {
      id: "H-3",
      description: "empty input",
      steps: "test -s farewell.txt",
      expected: "exit zero",
      edge_case: true,
    },
  ],
};
const pass = {
  criteria: [
    { id: "AC-1", status: "met", evidence: "cat shows goodbye", publicSummary: "" },
    ...holdout.scenarios.map((s) => ({
      id: s.id,
      status: "met",
      evidence: "observed expected result",
      publicSummary: "",
    })),
  ],
  overall: "pass",
  notes: "",
};

function start(handler: Handler, effortRouting = false, freeProviders = false): Factory {
  const alpha = models[0];
  const beta = models[1];
  if (!alpha || !beta) throw new Error("missing fixture models");
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  factory = new Factory(cfg, {
    harnesses: { fake: fakeHarness(handler) },
    providers: freeProviders
      ? [
          ...providers,
          { id: "gamma", label: "Gamma", harness: "fake", billing: "free", maxConcurrent: 2 },
          { id: "delta", label: "Delta", harness: "fake", billing: "free", maxConcurrent: 2 },
        ]
      : providers,
    models: effortRouting
      ? models.map((m): ModelDef => ({ ...m, supportedEfforts: ["low", "high"], effort: "low" }))
      : freeProviders
        ? [
            ...models,
            { ...alpha, id: "gamma/m", provider: "gamma", vendor: "anthropic", tier: 3 },
            { ...beta, id: "delta/m", provider: "delta", vendor: "openai", tier: 5 },
          ]
        : models,
    policy: effortRouting ? { ...policy, implement: { default: ["alpha/m@high", "alpha/m@low"] } } : policy,
    bootSha: "test-build",
  });
  factory.start();
  return factory;
}

async function waitFor(
  f: Factory,
  runId: string,
  statuses: RunStatus[],
  timeoutMs = 20_000,
): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = f.store.getRun(runId);
    if (run && statuses.includes(run.status)) return run.status;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${statuses.join("|")}; status=${f.store.getRun(runId)?.status}`);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "limitless-e2e-"));
  repoDir = await makeRepo();
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await factory?.stop();
  factory?.store.close();
  factory = null;
  rmSync(home, { recursive: true, force: true });
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

describe("pipeline (fake agents, real git + gates)", () => {
  test.each([
    ["trivial", "1–2"],
    ["small", "1–3"],
    ["medium", "3–5"],
    ["large", "5–8"],
    [undefined, "2–8"],
  ] as const)("spec prompt sizes criteria for %s complexity", (complexity, range) => {
    const prompt = specPrompt({ prompt: "Add farewell", answers: [], complexity });
    expect(prompt).toContain(`acceptance_criteria: ${range} observable`);
    expect(prompt).toContain(
      "Require a specific new test only where behavior is new or at risk of regression, not for every criterion",
    );
    expect(prompt).toContain("Each needs a concrete how_to_verify");
  });

  test.each([
    ["small", 7, 3],
    ["small", 7, 7],
    ["trivial", 2, 2],
    ["small", 3, 3],
    ["medium", 5, 5],
    ["large", 8, 8],
  ] as const)("spec size retry: %s %i → %i", async (complexity, initialCount, finalCount) => {
    const oversized = initialCount === 7;
    const prompts: string[] = [];
    const expected = {
      ...spec,
      summary: oversized ? "Retried farewell specification" : spec.summary,
      acceptance_criteria: Array.from({ length: finalCount }, (_, i) => ({
        id: `AC-${i + 1}`,
        criterion: `Farewell behavior ${i + 1}`,
        how_to_verify: "cat farewell.txt",
      })),
    };
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ complexity }) };
      if (role === "spec") {
        prompts.push(s.prompt);
        return {
          structured:
            prompts.length === 1 && oversized
              ? {
                  ...expected,
                  summary: "Initial farewell specification",
                  acceptance_criteria: Array.from({ length: initialCount }, (_, i) => ({
                    ...expected.acceptance_criteria[0],
                    id: `AC-${i + 1}`,
                  })),
                }
              : expected,
        };
      }
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify")
        return {
          structured: {
            ...pass,
            criteria: [
              ...expected.acceptance_criteria.map((a) => ({
                id: a.id,
                status: "met",
                evidence: "observed",
                publicSummary: "",
              })),
              ...pass.criteria.filter((c) => !c.id.startsWith("AC-")),
            ],
          },
        };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(prompts).toHaveLength(oversized ? 2 : 1);
    if (oversized) expect(prompts[1]).toContain("For small complexity, use at most 3 criteria");
    expect(f.store.getRunState<RunState>(run.id)?.spec).toEqual(expected);
    expect(f.store.getArtifact(run.id, "spec.md")).toContain(renderSpec(expected));
    const warnings = f.store.listEvents(run.id).filter((e) => e.message?.startsWith("Kept oversized spec"));
    expect(warnings).toHaveLength(oversized && finalCount === 7 ? 1 : 0);
    if (warnings.length) expect(warnings[0]).toMatchObject({ level: "warn" });
  });

  test("spec prompt confines the read-only rule to investigation", () => {
    const prompt = specPrompt({ prompt: "Add farewell", answers: [] });
    expect(prompt).toContain("task below.\n\nYou are only writing the specification");
    expect(prompt).toContain("while investigating the repository, read and search but do not edit files");
    expect(prompt).toContain("change itself will be implemented later");
    expect(prompt).not.toContain("DO NOT modify anything");
    expect(prompt).toContain("verifiable inside the run's own checkout");
    expect(prompt).toContain("using the repository's commands and tests");
    expect(prompt).toContain(
      "a person, the orchestrator, a browser, live external services, a deploy, or a later event",
    );
    expect(prompt).toContain("Put such concerns under assumptions or out_of_scope");
  });

  test.each(
    "manual,manually,human,humans,owner,owners,orchestrator,reviewer approves,in a browser,visually,screenshot,screenshots,deploy,deploys,deployed,deploying,deployment,deployments,production,live API,after merge,wait for".split(
      ",",
    ),
  )("out-of-run criteria match bounded phrases in how_to_verify only: %s", (phrase) => {
    expect(
      outOfRunCriteria({
        ...spec,
        acceptance_criteria: [
          { id: "AC-1", criterion: `(${phrase})`, how_to_verify: "bun test test/page.test.ts" },
        ],
      }),
    ).toEqual([]);
    for (const text of [phrase, phrase.toUpperCase(), phrase.replaceAll(" ", "\n ")]) {
      const criterion = { id: "AC-1", criterion: "Works", how_to_verify: `(${text})` };
      expect(outOfRunCriteria({ ...spec, acceptance_criteria: [criterion] })).toEqual([criterion]);
      expect(
        outOfRunCriteria({
          ...spec,
          acceptance_criteria: [{ ...criterion, how_to_verify: `pre${text}post` }],
        }),
      ).toEqual([]);
    }
    expect(outOfRunCriteria(spec)).toEqual([]);
    expect(
      outOfRunCriteria({
        ...spec,
        acceptance_criteria: [
          { id: "AC-1", criterion: "Test passes", how_to_verify: "bun test test/page.test.ts" },
        ],
      }),
    ).toEqual([]);
  });

  test.each(["clean", "persistent", "empty", "invalid scope", "scope retry", "new dependency"])(
    "out-of-run criteria retry: %s",
    async (scenario) => {
      const external = {
        id: "AC-2",
        criterion: "the page shows the farewell",
        how_to_verify: "The owner opens the page in a browser",
      };
      const other = { id: "AC-3", criterion: "Page works", how_to_verify: "manual check" };
      const initial = { ...spec, acceptance_criteria: [...spec.acceptance_criteria, external, other] };
      if (scenario === "scope retry" || scenario === "new dependency") initial.summary = "No code changes.";
      if (scenario === "new dependency") initial.acceptance_criteria = spec.acceptance_criteria;
      const retry =
        scenario === "clean"
          ? { ...spec, summary: "Locally verifiable farewell" }
          : scenario === "empty"
            ? { ...spec, acceptance_criteria: [external, { ...other, id: "AC-4" }] }
            : scenario === "invalid scope"
              ? { ...spec, summary: "No code changes." }
              : {
                  ...spec,
                  acceptance_criteria: [...spec.acceptance_criteria, external, { ...other, id: "AC-4" }],
                };
      // Flagged criteria that survive the retry are kept and logged, never dropped.
      const expected = retry;
      const prompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") {
          prompts.push(s.prompt);
          return { structured: prompts.length === 1 ? initial : retry };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          // Every criterion in the stored spec, kept out-of-run ones included, is met.
          const ids = (f.store.getRunState<RunState>(run.id)?.spec?.acceptance_criteria ?? []).map(
            (a) => a.id,
          );
          const met = ids.map((id) => ({ id, status: "met", evidence: "observed", publicSummary: "" }));
          return {
            structured: {
              ...pass,
              criteria: [...met, ...pass.criteria.filter((c) => !c.id.startsWith("AC-"))],
            },
          };
        }
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        scenario === "invalid scope" ? "failed" : "succeeded",
      );
      expect(prompts).toHaveLength(scenario === "invalid scope" || scenario === "new dependency" ? 3 : 2);
      expect(prompts[scenario === "new dependency" ? 2 : 1]).toContain(
        scenario === "new dependency" ? "AC-2, AC-4" : "AC-2, AC-3",
      );
      if (scenario === "scope retry") expect(prompts[1]).toContain("Invalid specification:");
      if (scenario === "invalid scope") {
        expect(f.store.getArtifact(run.id, "spec.md")).toBeNull();
        expect(f.store.getRun(run.id)?.error).toContain("invalid spec scope");
        return;
      }
      expect(f.store.getRunState<RunState>(run.id)?.spec).toEqual(expected);
      const artifact = f.store.getArtifact(run.id, "spec.md");
      expect(artifact).toContain(expected.summary);
      if (scenario !== "clean") expect(artifact).toContain(other.how_to_verify);
      if (scenario !== "empty") expect(artifact).toContain("farewell.txt says goodbye");
      const kept = f.store
        .listEvents(run.id)
        .filter((e) => e.message?.startsWith("Kept acceptance criteria that may depend"));
      expect(kept.map((e) => e.message)).toEqual(
        scenario === "clean"
          ? []
          : ["Kept acceptance criteria that may depend on something outside the run: AC-2, AC-4"],
      );
    },
  );

  test("spec scope phrases normalize punctuation and leave ordinary documentation work alone", () => {
    for (const summary of [
      "SPECIFICATION—ONLY task",
      "Documentation  \nonly.",
      "Do NOT modify source code.",
      "No code changes.",
      "Do not modify code in this task.",
    ]) {
      expect(specScopeViolation({ ...spec, summary }, "Add farewell")).toBe(summary);
      expect(specScopeViolation({ ...spec, summary }, `${summary} Explain the behavior.`)).toBeNull();
    }
    for (const summary of [
      "Add code and documentation.",
      "Verify behavior without modifying fixtures.",
      "Document the read-only API.",
      "Do not change the code path for legacy users.",
      "Do not modify code outside src/pipeline.",
      "Must not edit the code generator output.",
      "Do not change code in existing callers.",
      "Existing plugins keep working without code changes.",
      "Existing plugins require no code changes.",
    ]) {
      expect(specScopeViolation({ ...spec, summary }, "Add farewell")).toBeNull();
      expect(specScopeViolation({ ...spec, summary: "No code changes." }, summary)).toBe("No code changes.");
    }
    // "X only" in ordinary prose is not a task restriction (a request that says it is still exempt).
    for (const summary of [
      "The README docs only list supported commands.",
      "The spec only covers the CLI path; the UI is out of scope.",
    ])
      expect(specScopeViolation({ ...spec, summary }, "Add farewell")).toBeNull();
    expect(
      specScopeViolation(
        {
          ...spec,
          acceptance_criteria: [{ id: "AC-1", criterion: "Works", how_to_verify: "Do not modify code" }],
        },
        "Add farewell",
      ),
    ).toBeNull();
  });

  test.each(["summary", "requirement", "criterion", "exhausted", "documentation"])(
    "spec scope validation: %s",
    async (scenario) => {
      const sentence = "This is a specification-only task; do not modify code";
      const invalid = { ...spec };
      if (scenario === "requirement") invalid.requirements = [sentence];
      else if (scenario === "criterion")
        invalid.acceptance_criteria = [{ id: "AC-1", criterion: sentence, how_to_verify: "Inspect" }];
      else invalid.summary = scenario === "documentation" ? "Documentation-only task" : sentence;
      const prompts: string[] = [];
      let implementCalls = 0;
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") {
          prompts.push(s.prompt);
          return { structured: prompts.length === 1 || scenario === "exhausted" ? invalid : spec };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") return { structured: pass };
        implementCalls++;
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      const run = await f.createRun({
        repo: repoDir,
        prompt: scenario === "documentation" ? "Documentation only: add farewell" : "Add farewell",
      });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        scenario === "exhausted" ? "failed" : "succeeded",
      );
      expect(prompts).toHaveLength(scenario === "documentation" ? 1 : 2);
      if (scenario !== "documentation") expect(prompts[1]).toContain(JSON.stringify(sentence));
      expect(implementCalls).toBe(scenario === "exhausted" ? 0 : 1);
      if (scenario === "exhausted") {
        expect(f.store.getArtifact(run.id, "spec.md")).toBeNull();
        expect(f.store.getRunState<RunState>(run.id)?.spec).toBeUndefined();
        expect(f.store.getRun(run.id)?.error).toContain("structured output failed validation");
      } else
        expect(f.store.getArtifact(run.id, "spec.md")).toContain(
          scenario === "documentation" ? invalid.summary : spec.summary,
        );
    },
  );

  test("prepare restart retains the reused worktree base after upstream advances", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `${readFileSync(join(repoDir, ".limitless.toml"), "utf8")}\n[policy]\nprotected_paths = ["protected.txt"]\n`,
    );
    writeFileSync(join(repoDir, "protected.txt"), "original\n");
    const bare = await githubFixture();
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    f.deps.faults = { "store:save": { action: "kill", when: (c) => c.stage === "prepare" } };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (
      f.store.listStages(run.id).at(-1)?.status !== "cancelled" ||
      f.store.getRun(run.id)?.status !== "running"
    ) {
      if (Date.now() > deadline) throw new Error("prepare interruption timed out");
      await Bun.sleep(10);
    }
    await f.stop();
    const originalBase = f.store.getRun(run.id)?.baseSha;
    expect(originalBase).toHaveLength(40);
    expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("prepare");
    f.store.close();
    await advanceBase(bare, "protected.txt", "upstream only\n");
    const resumed = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      expect(resumed.store.getRun(run.id)?.baseSha).toBe(originalBase);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(resumed.store.getArtifact(run.id, "diff.patch")).not.toContain("protected.txt");
    expect(resumed.store.getRunState<RunState>(run.id)?.lastAudit).toEqual([]);
  });

  test.each(["saved URL", "branch lookup", "open PR"])("delivery restart reconciles %s", async (scenario) => {
    const bare = await githubFixture();
    const bin = join(home, "bin", "gh");
    const stateFile = join(home, "pr-state");
    const calls = join(home, "gh-calls");
    const url = "https://github.com/test/repo/pull/1";
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$*" >> '${calls}'
case "$1 $2" in
  'pr view') echo '{"state":"'"$(cat '${stateFile}')"'","url":"${url}"}' ;;
  'pr list') if [ -f '${stateFile}' ]; then
    if [ "$*" = "pr list --repo test/repo --head $6 --state all --json state,url" ]; then
      echo '[{"state":"'"$(cat '${stateFile}')"'","url":"${url}"}]'
    else echo '${url}'; fi
  fi ;;
  'pr create') cat >/dev/null; echo '${url}' ;;
  'pr merge') echo MERGED > '${stateFile}' ;;
esac
`,
      { mode: 0o755 },
    );
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    f.store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "auto",
    });
    f.deps.faults = {
      "store:save": {
        action: "kill",
        when: (c) =>
          c.checkpoint === (scenario === "saved URL" ? "delivery-complete" : "delivery-pr-created"),
      },
    };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (
      f.store.listStages(run.id).at(-1)?.name !== "deliver" ||
      f.store.listStages(run.id).at(-1)?.status !== "cancelled"
    ) {
      if (Date.now() > deadline) throw new Error("delivery interruption timed out");
      await Bun.sleep(10);
    }
    await f.stop();
    expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("deliver");
    const branch = f.store.getRun(run.id)?.branch;
    if (!branch) throw new Error("missing delivery branch");
    f.store.close();
    if (scenario === "branch lookup") writeFileSync(stateFile, "MERGED");
    if (scenario === "open PR") writeFileSync(stateFile, "OPEN");
    if (scenario !== "open PR") await sh(["git", "branch", "-D", branch], { cwd: bare });
    const before = readFileSync(calls, "utf8").split("\n").filter(Boolean);
    const resumed = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const after = readFileSync(calls, "utf8").split("\n").filter(Boolean);
    expect(resumed.store.getRun(run.id)?.prUrl).toBe(url);
    expect(resumed.store.getRun(run.id)?.merged).toBe(true);
    expect(after.filter((c) => c.startsWith("pr merge"))).toHaveLength(
      scenario === "open PR" ? 1 : scenario === "saved URL" ? 1 : 0,
    );
    if (scenario !== "open PR")
      expect(after.filter((c) => c.startsWith("pr merge"))).toEqual(
        before.filter((c) => c.startsWith("pr merge")),
      );
    expect(after.some((c) => c.startsWith(scenario === "saved URL" ? "pr view" : "pr list"))).toBe(true);
    if (scenario !== "open PR") {
      const remote = await sh(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
        cwd: bare,
        allowFail: true,
      });
      expect(remote.exitCode).not.toBe(0);
    }
  });

  test("implement summaries include the commit or no changes and warn on empty timeout", async () => {
    let calls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      calls++;
      return calls === 1
        ? { status: "timeout", files: { "farewell.txt": "goodbye\n" } }
        : { status: "timeout" };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const stages = f.store.listStages(run.id).filter((s) => s.name === "implement");
    expect(stages[0]?.summary).toContain(f.store.getRun(run.id)?.headSha?.slice(0, 8) ?? "missing SHA");
    expect(
      f.store
        .listEvents(run.id)
        .some((e) => e.level === "warn" && e.message === "Implementer ended with timeout"),
    ).toBe(true);
    expect(stages[0]?.summary).not.toContain("timeout: ");
    const empty = await f.createRun({ repo: repoDir, prompt: "Leave files unchanged", profile: "quick" });
    expect(await waitFor(f, empty.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(f.store.listStages(empty.id).find((s) => s.name === "implement")?.summary).toContain("no changes");
  });

  test("replayed review retains one omitted follow-up on the same round and SHA", async () => {
    let reviews = 0;
    const specs: AgentSpec[] = [];
    const finding = (title: string, label?: "new") => ({
      severity: "major" as const,
      security: false,
      ...findingEvidence,
      ...(label ? { label, prior: "" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: title,
      suggestion: "Fix",
    });
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews = specs.push(s);
        return { structured: { ...approve, findings: reviews === 1 ? [finding("First blocker")] : [] } };
      }
      return { files: { "farewell.txt": `goodbye ${reviews}\n` } };
    };
    const f = start(handler);
    f.deps.faults = {
      "stage:review:before": {
        action: "kill",
        occurrence: 2,
        onHit: ({ runId }) => {
          const state = f.store.getRunState<RunState>(runId);
          if (!state?.worktreePath) throw new Error("missing replay worktree");
          const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: state.worktreePath })
            .stdout.toString()
            .trim();
          const followUp = finding("Backlog idea", "new");
          // History recorded before finding schema v2 has none of its fields.
          const legacy = state.reviewHistory?.map((entry) => ({
            ...entry,
            blocking: entry.blocking.map(
              ({ failure_scenario, category, confidence, introduced_by_diff, ...f }) => f,
            ),
          }));
          state.reviewHistory = [...(legacy ?? []), { round: 1, sha, blocking: [], followUps: [followUp] }];
          state.reviewFollowUps = [followUp];
          f.store.setRunState(runId, state);
        },
      },
    };
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (
      f.store.listStages(run.id).at(-1)?.name !== "review" ||
      f.store.listStages(run.id).at(-1)?.status !== "cancelled"
    ) {
      if (Date.now() > deadline) throw new Error("review interruption timed out");
      await Bun.sleep(10);
    }
    await f.stop();
    f.store.close();
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(reviews).toBe(2);
    expect(resumed.store.getRunState<RunState>(run.id)?.reviewFollowUps?.map((v) => v.title)).toEqual([
      "Backlog idea",
    ]);
    const followUps = resumed.store.getArtifact(run.id, "report.md")?.split("## Review follow-ups")[1];
    expect(followUps?.match(/^- major: `farewell\.txt:1` Backlog idea/gm)).toHaveLength(1);
    const [first, later] = specs;
    expect(first).toMatchObject({ mode: "readonly", timeoutMs: readingTimeout(1) });
    expect([first?.schema, later?.schema]).toEqual([ReviewSchema, LaterReviewSchema]);
    expect(first?.jsonSchema).toEqual(toStrictJsonSchema(ReviewSchema));
    expect(later?.prompt).toContain("First blocker");
    expect(later?.prompt).not.toContain('"confidence"');
    const artifact = JSON.parse(resumed.store.getArtifact(run.id, "review-0.json") ?? "{}");
    expect(artifact).toMatchObject({ verdict: "request_changes", modelVerdict: "approve" });
  });
  test("Dependabot uses free models across quick stages and keeps them on feedback rounds", async () => {
    const seen: { role: string; provider: string }[] = [];
    let implementations = 0;
    const f = start(
      (s) => {
        const role = roleOf(s);
        seen.push({ role, provider: s.target.provider });
        if (role === "triage")
          return { structured: triage({ suggested_profile: "quick", task_class: "dependency_update" }) };
        if (role === "review") return { structured: approve };
        implementations++;
        return { files: { "farewell.txt": implementations === 1 ? "BAD goodbye\n" : "goodbye\n" } };
      },
      false,
      true,
    );
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      requestedBy: "dependabot[bot]",
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(seen).toEqual([
      { role: "triage", provider: "gamma" },
      { role: "implement", provider: "gamma" },
      { role: "implement", provider: "gamma" },
      { role: "review", provider: "delta" },
    ]);
    expect(f.store.getArtifact(run.id, "report.md")).toContain("Routing: free-first (Dependabot)");
    expect(f.store.getRunState<RunState>(run.id)?.flow).toBe("build");
  });

  test.each([undefined, "include", "omit"] as const)(
    "production review system is one routed finder honoring implementer_report=%s",
    async (mode) => {
      const reviews: AgentSpec[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          reviews.push(s);
          return { structured: approve };
        }
        return { files: { "farewell.txt": "goodbye\n" }, text: "IMPLEMENTER_SAYS_DONE" };
      });
      if (mode) f.deps.cfg.reviewImplementerReport = mode;
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(reviews.map((s) => s.target.provider)).toEqual(["beta"]);
      const included = mode !== "omit";
      expect(reviews[0]?.prompt.includes("# Implementer's own report")).toBe(included);
      expect(reviews[0]?.prompt.includes("IMPLEMENTER_SAYS_DONE")).toBe(included);
    },
  );

  test.each([false, true])("panel mode: deep roster plus base lenses, local=%s", async (configuredLocal) => {
    const lens = (focus: string) => `[review]\nlenses = [{ name = "ops", focus = "${focus}" }]\n`;
    const toml = readFileSync(join(repoDir, ".limitless.toml"), "utf8");
    writeFileSync(join(repoDir, ".limitless.toml"), `${toml}${lens("BASE_FOCUS")}`);
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "lens"], {
      cwd: repoDir,
    });
    const reviews: AgentSpec[] = [];
    let verifications = 0;
    let implementations = 0;
    const f = start((s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        // R1's finding is real; R2's recheck finds it fixed.
        const ruling = {
          verdict: verifications++ ? "REFUTED" : "CONFIRMED",
          severity: "high",
          evidence: "a:1",
        };
        const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1]);
        return {
          structured: {
            results: ids.map((id) => ({ id, ...ruling, category: "correctness", trigger: "x" })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "deep" }) };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "verify") return { structured: pass };
      if (role === "review") {
        reviews.push(s);
        const finding = {
          ...findingEvidence,
          severity: "major",
          file: "farewell.txt",
          line: 1,
          title: "Terse",
        };
        const found = s.prompt.startsWith("You are an adversarial") && !s.prompt.includes("review R2");
        const findings = found ? [{ ...finding, detail: "d", suggestion: "s", security: false }] : [];
        return { structured: { ...approve, findings } };
      }
      // The change under review rewrites the lens; every review must keep the base's.
      const farewell = implementations++ ? "goodbye!\n" : "goodbye\n";
      return { files: { "farewell.txt": farewell, ".limitless.toml": `${toml}${lens("HEAD_FOCUS")}` } };
    });
    f.deps.cfg.reviewMode = "panel";
    if (configuredLocal)
      f.deps.cfg.reviewRosters.deep = [
        ...f.deps.cfg.reviewRosters.deep,
        { prompt: "standard", lens: { name: "failure-paths", focus: "Failure paths." }, local: true },
      ];
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "deep" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(f.store.getArtifact(run.id, "diff.patch")).toContain("HEAD_FOCUS");
    const prompts = reviews.map((s) => s.prompt);
    expect(prompts.filter((p) => p.includes("review R2"))).toHaveLength(3);
    expect(prompts.filter((p) => p.includes("BASE_FOCUS"))).toHaveLength(2);
    expect(prompts.some((p) => p.includes("HEAD_FOCUS"))).toBe(false);
    // Adversarial avoids the implementer's vendor, careful takes its family, the lens finder is cross-vendor.
    for (const review of [1, 2])
      expect(JSON.parse(f.store.getArtifact(run.id, `review-${review}.json`) ?? "{}").panel.finders).toEqual([
        { prompt: "adversarial", vendor: "openai" },
        // The careful finder took the implementer's own model, in a fresh session.
        { prompt: "careful", vendor: "anthropic", implementerModel: true },
        ...(configuredLocal
          ? [
              {
                prompt: "standard",
                lens: "failure-paths",
                vendor: null,
                skipped: expect.stringContaining("No model available for review"),
              },
            ]
          : []),
        { prompt: "standard", lens: "ops", vendor: "openai" },
      ]);
  });

  test("panel mode: one deadline covers a local finder's fallbacks, and its skip says why", async () => {
    const local: number[] = [];
    const f = start(
      (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "verify") return { structured: pass };
        if (role !== "review") return { files: { "farewell.txt": "goodbye\n" } };
        if (!s.prompt.includes("# Lens: failure-paths")) return { structured: approve };
        local.push(s.timeoutMs);
        return { fault: "timeout", delayMs: 50 };
      },
      false,
      true,
    );
    f.deps.cfg.reviewMode = "panel";
    f.deps.cfg.reviewRosters.standard = [
      ...f.deps.cfg.reviewRosters.standard,
      { prompt: "standard", lens: { name: "failure-paths", focus: "Failure paths." }, local: true },
    ];
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    // Both free models were tried, the second with only what was left of the first's time.
    expect(local).toHaveLength(2);
    const [first = 0, second = 0] = local;
    expect(first).toBeLessThanOrEqual(LOCAL_FINDER_TIMEOUT_MS);
    expect(second).toBeLessThanOrEqual(first - 50);
    const finders = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}").panel.finders;
    expect(finders[2]).toMatchObject({ vendor: null, skipped: expect.stringContaining("harness timeout") });
  });

  test("panel mode on free-first runs: the verifier is independent of the implementer and the finder", async () => {
    const calls: { role: string; model: string; vendor: string }[] = [];
    let implementations = 0;
    const f = start(
      (s) => {
        const verifier = s.prompt.startsWith("You are a code-review verifier");
        const role = verifier ? "verifier" : roleOf(s);
        calls.push({ role, model: s.target.modelId, vendor: s.target.vendor });
        if (verifier) {
          const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1]);
          const ruling = {
            verdict: "REFUTED",
            severity: "low",
            category: "correctness",
            evidence: "a:1",
            trigger: "x",
          };
          return { structured: { results: ids.map((id) => ({ id, ...ruling })) } };
        }
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          const finding = {
            ...findingEvidence,
            severity: "major",
            file: "farewell.txt",
            line: 1,
            title: "T",
          };
          return {
            structured: {
              ...approve,
              findings: [{ ...finding, detail: "d", suggestion: "s", security: false }],
            },
          };
        }
        return { files: { "farewell.txt": implementations++ ? "goodbye!\n" : "goodbye\n" } };
      },
      false,
      true,
    );
    f.deps.cfg.reviewMode = "panel";
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      requestedBy: "dependabot[bot]",
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const [implementer, finder, verifier] = ["implement", "review", "verifier"].map((role) =>
      calls.find((c) => c.role === role),
    );
    // Free-first picks free models for the implementer and the finder, but not an unindependent verifier.
    expect([implementer?.model, finder?.model]).toEqual(["gamma/m", "delta/m"]);
    expect(verifier?.model).not.toBe(implementer?.model);
    expect(verifier?.vendor).not.toBe(finder?.vendor);
    expect(verifier?.model).toBe("alpha/m");
  });

  test("Dependabot falls back when free providers are unavailable; owner keeps policy routing", async () => {
    const f = start(
      (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") return { structured: approve };
        return { files: { "farewell.txt": "goodbye\n" } };
      },
      false,
      true,
    );
    f.tracker.setEnabled("gamma", false);
    f.tracker.setHealthy("delta", false);
    for (const requestedBy of ["dependabot[bot]", "owner"]) {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick", requestedBy });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(f.store.listInvocations(run.id).map((i) => [i.role, i.provider])).toEqual([
        ["triage", "alpha"],
        ["implement", "alpha"],
        ["review", "beta"],
      ]);
      expect(f.store.getArtifact(run.id, "report.md")?.includes("Routing: free-first (Dependabot)")).toBe(
        requestedBy === "dependabot[bot]",
      );
    }
  });

  test("Dependabot escalation keeps free-first routing with a minimum tier", async () => {
    let implementations = 0;
    const f = start(
      (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") return { structured: approve };
        implementations++;
        return { files: { "farewell.txt": implementations < 3 ? "BAD goodbye\n" : "goodbye\n" } };
      },
      false,
      true,
    );
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      requestedBy: "dependabot[bot]",
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.provider),
    ).toEqual(["gamma", "gamma", "delta"]);
  });

  test("owner and policy opt-out ignore eligible free models", async () => {
    mkdirSync(join(home, "cfg"));
    writeFileSync(join(home, "cfg", "config.toml"), '[routing]\ndependabot = "policy"\n');
    const f = start(
      (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") return { structured: approve };
        return { files: { "farewell.txt": "goodbye\n" } };
      },
      false,
      true,
    );
    for (const requestedBy of ["owner", "dependabot[bot]"]) {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick", requestedBy });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(f.store.listInvocations(run.id).map((i) => i.provider)).toEqual(["alpha", "alpha", "beta"]);
      expect(f.store.getArtifact(run.id, "report.md")).not.toContain("Routing: free-first");
    }
  });

  test("a check that fails once after the change is retried, reported flaky, and does not block", async () => {
    const count = join(home, "gate-runs");
    // Run 1 is the baseline, run 2 the post-change gates, run 3 the retry.
    const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -ne 2`;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "flaky gate"], {
      cwd: repoDir,
    });
    let implementations = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      implementations++;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementations).toBe(1);
    const gates = f.store.getRunState<RunState>(run.id)?.lastGates?.[0];
    expect([gates?.verdict, gates?.blocking, gates?.firstAttempt?.ok]).toEqual(["flaky", false, false]);
    expect(
      f.store.listEvents(run.id).some((e) => e.message === "check retry: pass (flaky, not blocking)"),
    ).toBe(true);
    expect(f.store.getArtifact(run.id, "report.md")).toContain("Flaky: `check` failed, then passed");
  });

  test("a baseline check that fails once is retried and recorded as passing, so a regression blocks", async () => {
    const count = join(home, "gate-runs");
    // Run 1 is the baseline, run 2 its retry; every run after the change fails.
    const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -eq 2`;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "flaky baseline"], {
      cwd: repoDir,
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).not.toBe("succeeded");
    const baseline = f.store.getRunState<RunState>(run.id)?.baseline?.checks[0];
    expect([baseline?.ok, baseline?.firstAttempt?.ok]).toEqual([true, false]);
    const artifact = JSON.parse(f.store.getArtifact(run.id, "baseline-gates.json") ?? "{}");
    expect([artifact.checks?.[0]?.ok, artifact.checks?.[0]?.firstAttempt?.ok]).toEqual([true, false]);
    const flaky = f.store.listEvents(run.id).find((e) => e.message === "baseline check: flaky");
    expect(flaky?.data).toMatchObject({ flaky: true, firstAttempt: { ok: false }, retry: { ok: true } });
    const gates = f.store.getRunState<RunState>(run.id)?.lastGates?.[0];
    expect([gates?.verdict, gates?.blocking]).toEqual(["regressed", true]);
    // Baseline, its retry, then each post-change round and its regression retry.
    expect(readFileSync(count, "utf8").trim().split("\n").length % 2).toBe(0);
  });

  test("a baseline check that fails twice stays failing and does not block after the change", async () => {
    const count = join(home, "gate-runs");
    const check = `echo x >> '${count}'; echo attempt $(( $(wc -l < '${count}') )); exit 1`;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "broken baseline"], {
      cwd: repoDir,
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const state = f.store.getRunState<RunState>(run.id);
    const baseline = state?.baseline?.checks[0];
    expect([
      baseline?.ok,
      baseline?.output,
      baseline?.firstAttempt?.ok,
      baseline?.firstAttempt?.output,
    ]).toEqual([false, "attempt 2", false, "attempt 1"]);
    // Both failed attempts stay in the artifact.
    const artifact = JSON.parse(f.store.getArtifact(run.id, "baseline-gates.json") ?? "{}");
    expect([artifact.checks?.[0]?.output, artifact.checks?.[0]?.firstAttempt?.output]).toEqual([
      "attempt 2",
      "attempt 1",
    ]);
    expect([state?.lastGates?.[0]?.verdict, state?.lastGates?.[0]?.blocking]).toEqual([
      "still_failing",
      false,
    ]);
    const events = f.store.listEvents(run.id);
    expect(events.some((e) => e.message.endsWith(": flaky"))).toBe(false);
    const again = events.find((e) => e.message === "baseline check: retry FAIL again");
    expect(again?.data).toMatchObject({ flaky: false, firstAttempt: { ok: false }, retry: { ok: false } });
    // Two baseline attempts, one post-change run (still_failing is never retried).
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(3);
  });

  describe("baseline cache", () => {
    const lines = (path: string) =>
      existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
    const cacheRows = (f: Factory) =>
      f.store.db.query("SELECT base_sha, gate_run, run_id, created_at FROM passing_baselines").all() as {
        base_sha: string;
        gate_run: string;
        run_id: string;
        created_at: number;
      }[];
    const quick = (s: AgentSpec): FakeReply => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    async function commitGates(toml: string): Promise<void> {
      writeFileSync(join(repoDir, ".limitless.toml"), toml);
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "gates"], {
        cwd: repoDir,
      });
    }
    async function finish(f: Factory, over: Partial<Parameters<Factory["createRun"]>[0]> = {}) {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick", ...over });
      await waitFor(f, run.id, ["succeeded", "failed", "needs_human", "cancelled"]);
      return { run, state: f.store.getRunState<RunState>(run.id) };
    }

    test("a second run on the same base reuses a passing baseline", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      const first = await finish(f);
      // Baseline and the post-implement gates.
      expect(lines(count)).toBe(2);
      expect(first.state?.baselineCached).toBe(false);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([first.run.id]);
      const second = await finish(f);
      // Only the post-implement gates executed.
      expect(lines(count)).toBe(3);
      expect(second.state?.baselineCached).toBe(true);
      expect(second.state?.baseline).toEqual(first.state?.baseline ?? null);
      expect(f.store.getRun(second.run.id)?.status).toBe("succeeded");
      const prepare = f.store.listStages(second.run.id).find((s) => s.name === "prepare");
      expect(prepare?.summary).toContain("baseline reused from cache");
      expect(f.store.listStages(first.run.id).find((s) => s.name === "prepare")?.summary).not.toContain(
        "cache",
      );
      expect(JSON.parse(f.store.getArtifact(second.run.id, "baseline-gates.json") ?? "{}")).toEqual(
        second.state?.baseline,
      );
    });

    test("a flaky base that failed twice is not cached, so the next run blocks the regression", async () => {
      const count = join(home, "gate-runs");
      // Fails the first baseline and its retry; later it fails only once the change exists.
      const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -gt 2 || exit 1; test ! -f farewell.txt`;
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`);
      const f = start(quick);
      const first = await finish(f);
      expect(first.state?.baseline?.checks[0]?.firstAttempt?.ok).toBe(false);
      expect(first.state?.baseline?.checks[0]?.ok).toBe(false);
      expect(cacheRows(f)).toEqual([]);
      const second = await finish(f);
      expect(second.state?.baselineCached).toBe(false);
      expect(second.state?.baseline?.checks[0]?.ok).toBe(true);
      expect(second.state?.lastGates?.map((g) => [g.name, g.verdict, g.blocking])).toEqual([
        ["check", "regressed", true],
      ]);
      expect(f.store.getRun(second.run.id)?.status).not.toBe("succeeded");
    });

    test("concurrent runs on one base execute the baseline once", async () => {
      const count = join(home, "gate-runs");
      const check = `test -f farewell.txt || echo base >> '${count}'; sleep 1`;
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`);
      const f = start(quick);
      const [a, b] = await Promise.all([finish(f), finish(f)]);
      expect(lines(count)).toBe(1);
      expect([a.state?.baselineCached, b.state?.baselineCached].sort()).toEqual([false, true]);
      expect(cacheRows(f)).toHaveLength(1);
    });

    describe("uncacheable baselines on one base", () => {
      let slots = 1;
      beforeEach(() => {
        slots = gateSlots.limit;
      });
      afterEach(() => gateSlots.setLimit(slots));
      // Each baseline attempt logs start and end around a sleep; adjacent starts mean overlap.
      const overlapping = (log: string) => readFileSync(log, "utf8").includes("start\nstart\n");
      const timed = (log: string, exit: number) =>
        `test -f farewell.txt && exit 0; echo start >> '${log}'; sleep 1; echo end >> '${log}'; exit ${exit}`;

      test("with the kill switch, same-base runs execute their baselines concurrently", async () => {
        const log = join(home, "gate-log");
        await commitGates(`[gates]\nchecks = [{ name = "check", run = "${timed(log, 0)}" }]\n`);
        const f = start(quick);
        f.cfg.baselineCache = false;
        gateSlots.setLimit(3);
        const runs = await Promise.all([finish(f), finish(f), finish(f)]);
        expect(runs.map((r) => r.state?.baselineCached)).toEqual([false, false, false]);
        expect(readFileSync(log, "utf8").split("\n").slice(0, 3)).toEqual(["start", "start", "start"]);
      });

      test("a failing flight releases its waiters to run concurrently", async () => {
        const log = join(home, "gate-log");
        await commitGates(`[gates]\nchecks = [{ name = "check", run = "${timed(log, 1)}" }]\n`);
        const f = start(quick);
        gateSlots.setLimit(3);
        const runs = await Promise.all([finish(f), finish(f), finish(f)]);
        expect(runs.map((r) => r.state?.baseline?.checks[0]?.ok)).toEqual([false, false, false]);
        expect(cacheRows(f)).toEqual([]);
        expect(overlapping(log)).toBe(true);
      });
    });

    test("an unknown build SHA neither reads nor writes the cache", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      f.deps.buildSha = undefined;
      await finish(f);
      const second = await finish(f);
      expect([lines(count), second.state?.baselineCached]).toEqual([4, false]);
      expect(cacheRows(f)).toEqual([]);
    });

    test("a changed gate config or base commit misses", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      await finish(f);
      expect(lines(count)).toBe(2);
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'; true" }]\n`);
      const changedConfig = await finish(f);
      expect([lines(count), changedConfig.state?.baselineCached]).toEqual([4, false]);
      writeFileSync(join(repoDir, "greeting.txt"), "hello again\n");
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "base"], {
        cwd: repoDir,
      });
      const changedBase = await finish(f);
      expect([lines(count), changedBase.state?.baselineCached]).toEqual([6, false]);
      expect(cacheRows(f)).toHaveLength(3);
    });

    test("a changed gate environment misses", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const saved = { npm: process.env.npm_config_ignore_scripts, flag: process.env.MY_GATE_FLAG };
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      try {
        process.env.npm_config_ignore_scripts = "false";
        process.env.MY_GATE_FLAG = "a";
        const f = start(quick);
        await finish(f);
        expect((await finish(f)).state?.baselineCached).toBe(true);
        process.env.npm_config_ignore_scripts = "true";
        expect((await finish(f)).state?.baselineCached).toBe(false);
        // Undeclared variables don't key the cache; declared ones do.
        process.env.MY_GATE_FLAG = "b";
        expect((await finish(f)).state?.baselineCached).toBe(true);
        f.cfg.baselineEnv = ["MY_GATE_FLAG"];
        expect((await finish(f)).state?.baselineCached).toBe(false);
        process.env.MY_GATE_FLAG = "c";
        expect((await finish(f)).state?.baselineCached).toBe(false);
        expect((await finish(f)).state?.baselineCached).toBe(true);
      } finally {
        restore("npm_config_ignore_scripts", saved.npm);
        restore("MY_GATE_FLAG", saved.flag);
      }
    });

    test("a changed nonsecret setting with a secret-looking name misses", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const names = ["GOPRIVATE", "NODE_TLS_REJECT_UNAUTHORIZED"] as const;
      const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
      try {
        process.env.GOPRIVATE = "example.com/*";
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
        const f = start(quick);
        await finish(f);
        expect((await finish(f)).state?.baselineCached).toBe(true);
        process.env.GOPRIVATE = "other.example/*";
        expect((await finish(f)).state?.baselineCached).toBe(false);
        expect((await finish(f)).state?.baselineCached).toBe(true);
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        expect((await finish(f)).state?.baselineCached).toBe(false);
        expect((await finish(f)).state?.baselineCached).toBe(true);
      } finally {
        for (const k of names) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    });

    test("a timed-out or cancelled baseline is not cached", async () => {
      const count = join(home, "gate-runs");
      // The first execution outlasts its timeout; later ones pass.
      const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -ne 1 || sleep 5`;
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "${check}", timeoutSec = 1 }]\n`);
      const f = start(quick);
      const timedOut = await finish(f);
      expect(timedOut.state?.baseline?.checks[0]?.timedOut).toBe(true);
      expect(cacheRows(f)).toEqual([]);
      const next = await finish(f);
      expect(next.state?.baselineCached).toBe(false);
      expect(next.state?.baseline?.checks[0]?.ok).toBe(true);
      expect(cacheRows(f)).toHaveLength(1);

      rmSync(count);
      await commitGates(
        `[gates]\nchecks = [{ name = "check", run = "${check.replace("sleep 5", "sleep 10")}" }]\n`,
      );
      const cancelled = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(count)) {
        if (Date.now() > deadline) throw new Error("baseline never started");
        await Bun.sleep(10);
      }
      f.cancelRun(cancelled.id);
      expect(await waitFor(f, cancelled.id, ["cancelled", "failed"])).toBe("cancelled");
      expect(cacheRows(f)).toHaveLength(1);
      const after = await finish(f);
      expect(after.state?.baselineCached).toBe(false);
      // Cancelled baseline, then this run's baseline and post-implement gates.
      expect(lines(count)).toBe(3);
    });

    test("a bypass run refreshes a passing entry and evicts it when the base fails", async () => {
      const count = join(home, "gate-runs");
      const broken = join(home, "broken");
      await commitGates(
        `[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'; test ! -f '${broken}'" }]\n`,
      );
      const f = start(quick);
      const primed = await finish(f);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([primed.run.id]);
      const bypass = await finish(f, { noBaselineCache: true });
      expect(f.store.getRun(bypass.run.id)?.noBaselineCache).toBe(true);
      expect([lines(count), bypass.state?.baselineCached]).toEqual([4, false]);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([bypass.run.id]);
      const refreshed = cacheRows(f);

      expect(refreshed).toHaveLength(1);

      // A failing fresh baseline contradicts the cached pass, so it is evicted, not replaced.
      writeFileSync(broken, "");
      const failing = await finish(f, { noBaselineCache: true });
      expect(failing.state?.baseline?.checks[0]?.ok).toBe(false);
      expect(cacheRows(f)).toEqual([]);
      const retried = await f.retryRun(failing.run.id);
      expect(retried.noBaselineCache).toBe(true);
      await waitFor(f, retried.id, ["succeeded", "failed", "needs_human"]);
      expect(cacheRows(f)).toEqual([]);

      // The config kill switch bypasses reads too, and still refreshes on a pass.
      rmSync(broken);
      f.cfg.baselineCache = false;
      const before = lines(count);
      const switchedOff = await finish(f);
      expect([lines(count) - before, switchedOff.state?.baselineCached]).toEqual([2, false]);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([switchedOff.run.id]);
    });

    test("post-rebase gates execute when prepare reused the cached baseline", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const bare = await githubFixture();
      let advance = false;
      const f = start(async (s) => {
        if (advance && roleOf(s) === "review") {
          advance = false;
          await advanceBase(bare, "base.txt", "new base\n");
        }
        return quick(s);
      });
      registerGithub(f, bare);
      const first = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(lines(count)).toBe(2);
      advance = true;
      const second = await f.createRun({ repo: "test/repo", prompt: "Add farewell too", profile: "quick" });
      expect(await waitFor(f, second.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(f.store.getRunState<RunState>(second.id)?.baselineCached).toBe(true);
      // Post-implement gates, then the gates after merging the advanced base.
      expect(lines(count)).toBe(4);
      expect(f.store.listStages(second.id).filter((s) => s.name === "gates")).toHaveLength(2);
    });
  });

  // Same text git generates, so a fixture line can never stand in for a real marker.
  const fixture = "<<<<<<< HEAD\nexample\n=======\n>>>>>>> theirs\n";

  async function githubFixture(): Promise<string> {
    // Ordinary headings and intentional marker fixtures must not block any base merge.
    writeFileSync(join(repoDir, "README.md"), "Project\n=======\n");
    writeFileSync(join(repoDir, "markers.fixture"), fixture);
    writeFileSync(join(repoDir, "binary.fixture"), Buffer.from([0, 255, 10]));
    await mergeGit(repoDir, ["add", "-A"]);
    await mergeGit(repoDir, ["commit", "-qm", "merge scan fixtures"]);
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> '${join(home, "gh-calls")}'\ncase "$2" in\n  list) exit 0 ;;\n  create) cat > '${join(home, "gh-body")}'; echo https://github.com/test/repo/pull/1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    return bare;
  }

  function registerGithub(f: Factory, bare: string): void {
    f.store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
  }

  async function advanceBase(bare: string, file: string, content: string): Promise<string> {
    writeFileSync(join(repoDir, file), content);
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "advance base"], {
      cwd: repoDir,
    });
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    await sh(["git", "push", bare, "HEAD:refs/heads/main"], { cwd: repoDir });
    return sha;
  }

  async function assertPublished(bare: string): Promise<void> {
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).not.toBe("");
  }

  async function assertUnpublished(bare: string): Promise<void> {
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");
    expect(existsSync(join(home, "gh-calls"))).toBe(false);
  }

  async function resolveBaseConflict(cwd: string, bare: string): Promise<FakeReply> {
    expect(readFileSync(join(cwd, "greeting.txt"), "utf8")).toContain("<<<<<<<");
    expect((await sh(["git", "rev-parse", "MERGE_HEAD"], { cwd })).stdout.trim()).toHaveLength(40);
    await assertUnpublished(bare);
    return { files: { "greeting.txt": "hello from both intents\nnew base\n" } };
  }

  test("drain during deliver completes its nested post-merge gates", async () => {
    const bare = await githubFixture();
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const startStage = f.store.startStage.bind(f.store);
    f.store.startStage = (...args) => {
      const stage = startStage(...args);
      if (args[1] === "deliver") f.scheduler.drain();
      return stage;
    };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(f.store.listStages(run.id).filter((stage) => stage.name === "gates")).toHaveLength(2);
    expect(f.store.listStages(run.id).find((stage) => stage.name === "deliver")?.status).toBe("succeeded");
    expect(f.store.getRunState<RunState>(run.id)?.pendingRebaseSha).toBeUndefined();
    expect(f.scheduler.parkedRunIds).toEqual([]);
  });

  test("post-merge gates slower than the GitHub retry budget still deliver", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      '[gates]\nchecks = [{ name = "slow", run = "sleep 2" }]\n',
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "slow gate"], {
      cwd: repoDir,
    });
    const bare = await githubFixture();
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const budgetMs = githubRetry.budgetMs;
    githubRetry.budgetMs = 1_500;
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    try {
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    } finally {
      githubRetry.budgetMs = budgetMs;
    }
    expect(f.store.getRun(run.id)?.prUrl).toBe("https://github.com/test/repo/pull/1");
    expect(f.store.listStages(run.id).filter((stage) => stage.name === "gates")).toHaveLength(2);
    expect(readFileSync(join(home, "gh-calls"), "utf8").match(/^pr create/gm)).toHaveLength(1);
  });

  test("needs-human draft delivery continues during drain", async () => {
    const bare = await githubFixture();
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review")
        return {
          structured: {
            verdict: "request_changes",
            summary: "Needs work",
            findings: [
              {
                label: "unaddressed",
                prior: "P1",
                severity: "blocker",
                security: false,
                ...findingEvidence,
                file: "farewell.txt",
                line: 1,
                title: "Incorrect output",
                detail: "Needs work",
                suggestion: "Fix it",
              },
            ],
          },
        };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    f.cfg.maxRounds = 1;
    registerGithub(f, bare);
    const addEvent = f.store.addEvent.bind(f.store);
    f.store.addEvent = (event) => {
      if (event.message?.startsWith("Run needs a human")) f.scheduler.drain();
      return addEvent(event);
    };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe("needs_human");
    expect(f.store.getRun(run.id)?.prUrl).toContain("/pull/1");
    expect(f.store.listStages(run.id).find((stage) => stage.name === "deliver")?.status).toBe("succeeded");
    expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
  });

  test("panel reviews R1-R3: fix-diff scope, tightening blocks, restart, then needs_human with a draft", async () => {
    const bare = await githubFixture();
    const finding = (title: string, label = "new", prior = "") => ({
      severity: "major",
      security: false,
      ...findingEvidence,
      ...(label === "r1" ? {} : { label, prior }),
      ...(title.endsWith("cleanup") ? { category: "cleanup" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: `detail ${title}`,
      suggestion: "fix",
    });
    // Finder output per panel review; the verifier rules on each candidate by its title.
    const found = [
      [finding("R1 low", "r1"), finding("R1 cleanup", "r1")],
      // No R2 finder repeats P1, so the verifier rechecks it on its own.
      [finding("R2 medium"), finding("R2 high")],
      [finding("R3 high"), finding("R3 critical")],
    ];
    const severity: Record<string, string> = {
      "R1 low": "low",
      "R2 medium": "medium",
      "R2 high": "high",
      "R3 high": "high",
      "R3 critical": "critical",
    };
    const finders: string[] = [];
    // Verifier prompts per review; a re-review's recheck of the prior blocker is its own batch.
    const verifiers: string[][] = [[], [], []];
    let implementations = 0;
    let slow = true;
    const handler: Handler = (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        verifiers[finders.length - 1]?.push(s.prompt);
        const cited = [
          ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
        ];
        return {
          structured: {
            results: cited.map(([, id, title]) => ({
              id,
              verdict: "CONFIRMED",
              // Each re-review's recheck finds the previous review's blocker fixed after all.
              ...(title?.startsWith(`R${finders.length - 1} `)
                ? { verdict: "REFUTED", severity: "low" }
                : { severity: severity[title ?? ""] }),
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        finders.push(s.prompt);
        return { structured: { ...approve, findings: found[finders.length - 1] ?? [] } };
      }
      implementations++;
      // The second implementation fails the gates, so that round never reaches a review.
      if (implementations === 2) return { files: { "farewell.txt": "BAD\n" } };
      if (slow && implementations === 4) return { delayMs: 30_000 };
      return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
    };
    const panel = {
      name: "panel",
      mode: "panel" as const,
      finders: [{ prompt: "standard" as const }],
      verifier: {},
      implementerReport: "include" as const,
    };
    const f = start(handler);
    f.deps.reviewSystem = panel;
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    // Stop the factory between R2 and R3, while the fourth implementation runs.
    const deadline = Date.now() + 15_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.round !== 3 || f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    const before = f.store.getRunState<RunState>(run.id);
    expect(before?.reviewHistory?.map((e) => [e.round, e.panelReview])).toEqual([
      [0, 1],
      [2, 2],
    ]);
    await f.stop();
    f.store.close();
    slow = false;
    const restarted = start(handler);
    restarted.deps.reviewSystem = panel;
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");

    // Exactly three panel reviews, never a fourth; the gate-failed round 1 did not count. Artifacts
    // are numbered by review, not by implementation round.
    expect(finders).toHaveLength(3);
    expect(implementations).toBe(5); // Includes the implementation interrupted by the stop.
    expect(restarted.store.getArtifact(run.id, "review-0.json")).toBeNull();
    expect(restarted.store.getArtifact(run.id, "review-4.json")).toBeNull();
    const [r1, r2, r3] = [1, 2, 3].map((n) =>
      JSON.parse(restarted.store.getArtifact(run.id, `review-${n}.json`) ?? "{}"),
    );
    const baseSha = restarted.store.getRun(run.id)?.baseSha ?? "missing";
    expect(r1).toMatchObject({
      round: 0,
      panelReview: 1,
      scope: { kind: "full", range: `${baseSha}..${r1.reviewedSha}` },
    });
    expect(r2).toMatchObject({
      round: 2,
      panelReview: 2,
      scope: { kind: "fix", range: `${r1.reviewedSha}..${r2.reviewedSha}` },
    });
    expect(r3).toMatchObject({
      round: 3,
      panelReview: 3,
      scope: { kind: "fix", range: `${r2.reviewedSha}..${r3.reviewedSha}` },
    });
    // R1: a verified low blocks, cleanup is a follow-up. R2: new high blocks, new medium is a follow-up.
    // R3: new high is a follow-up, critical blocks.
    const titles = (r: { blocking: { title: string }[] }) => r.blocking.map((b) => b.title);
    expect([titles(r1), titles(r2), titles(r3)]).toEqual([["R1 low"], ["R2 high"], ["R3 critical"]]);
    const state = restarted.store.getRunState<RunState>(run.id);
    expect(state?.reviewFollowUps?.map((x) => x.title).sort()).toEqual([
      "R1 cleanup",
      "R2 medium",
      "R3 high",
    ]);

    // R1 reviews the full change; R2 and R3 finders and verifiers see only the fix diff and P-ids.
    expect(finders[0]).toContain(`git diff ${baseSha}..HEAD`);
    for (const [i, prompt] of finders.slice(1).entries()) {
      const range = `${[r1, r2][i].reviewedSha}..${[r2, r3][i].reviewedSha}`;
      expect(prompt).toContain(`review R${i + 2}: the fix diff only`);
      expect(prompt).toContain(`git diff ${range}`);
      expect(prompt).toContain('"id": "P1"');
      expect(prompt).toContain('"status": "unresolved at the previous review');
      expect(prompt).not.toContain(`git diff ${baseSha}..`);
      expect(prompt).not.toContain("full base-to-HEAD");
      expect(verifiers[i + 1]).toHaveLength(2);
      for (const verifier of verifiers[i + 1] ?? []) {
        expect(verifier).toContain(`git diff ${range}`);
        expect(verifier).not.toContain(`git diff ${baseSha}..`);
        expect(verifier).toContain('"id": "P1"');
        expect(verifier).toContain('"status": "not repeated by any finder; recheck it as C3"');
      }
    }
    expect(verifiers[0]).toHaveLength(1);
    expect(finders[1]).toContain("R1 low");
    // Each re-review's verifier rechecked P1 as a candidate of its own (after the finders' C1 and C2)
    // and refuted it: fixed.
    expect(verifiers[1]?.[1]).toMatch(/"id": "C3",[\s\S]*"title": "R1 low",[\s\S]*"prior": "P1"/);
    expect(r2.panel.refuted).toEqual(["C3"]);
    expect(verifiers[2]?.[1]).toMatch(/"id": "C3",[\s\S]*"title": "R2 high",[\s\S]*"prior": "P1"/);
    expect(r3.panel.refuted).toEqual(["C3"]);
    // R1's only blocker was refuted by R2's recheck, so R3 is told it is resolved.
    expect(finders[2]).toMatch(/"title": "R1 low",[\s\S]*"status": "resolved"/);
    expect(verifiers[2]?.[0]).toMatch(/"title": "R1 low",[\s\S]*"status": "resolved at an earlier review"/);

    expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
    const report = restarted.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain(`Panel review R3 — fix diff \`${r2.reviewedSha}..${r3.reviewedSha}\``);
  });

  // R1 and R2 block, R3 approves; the delivery merge then conflicts with a base that also added an
  // upstream-only file. The resolution review is outside R1-R3 and sees the change against the new base.
  for (const outcome of ["approves", "blocks"] as const)
    test(`panel conflict-resolution review after R3 ${outcome}`, async () => {
      const bare = await githubFixture();
      const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n");
      const finding = (title: string, label?: "new" | "regression") => ({
        severity: "major",
        security: false,
        ...findingEvidence,
        ...(label ? { label, prior: "" } : {}),
        file: "farewell.txt",
        line: 1,
        title,
        detail: `detail ${title}`,
        suggestion: "fix",
      });
      // The resolution finder raises a regression the verifier rates medium: R2's rules block it.
      const found = [
        [finding("R1 bug")],
        [finding("R2 bug", "new")],
        [],
        outcome === "blocks" ? [finding("R4 bug", "regression")] : [],
      ];
      const finders: AgentSpec[] = [];
      const verifiers: AgentSpec[][] = [[], [], [], []];
      let implementations = 0;
      let baseTip = "";
      const handler: Handler = async (s) => {
        if (s.prompt.startsWith("You are a code-review verifier")) {
          verifiers[finders.length - 1]?.push(s);
          const cited = [
            ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
          ];
          return {
            structured: {
              results: cited.map(([, id, title]) => ({
                id,
                // Only the current review's own finding is real; rechecks of earlier ones are fixed.
                verdict: title === `R${finders.length} bug` ? "CONFIRMED" : "REFUTED",
                severity: title === "R4 bug" ? "medium" : "high",
                category: "correctness",
                evidence: "farewell.txt:1 `bye`",
                trigger: "reading the file -> wrong farewell",
              })),
            },
          };
        }
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          finders.push(s);
          if (finders.length === 3) {
            await advanceBase(bare, "upstream-only.txt", `${lines(300, "upstream")}\n`);
            baseTip = await advanceBase(bare, "greeting.txt", "new base\n");
          }
          return { structured: { ...approve, findings: found[finders.length - 1] ?? [] } };
        }
        implementations++;
        if (implementations === 4) return resolveBaseConflict(s.cwd, bare);
        return {
          files: {
            "farewell.txt": `goodbye ${implementations}\n`,
            ...(implementations === 1
              ? { "greeting.txt": "feature\n", "first-only.txt": `${lines(500, "first")}\n` }
              : {}),
          },
        };
      };
      const f = start(handler);
      f.deps.reviewSystem = {
        name: "panel",
        mode: "panel",
        finders: [{ prompt: "standard" }],
        verifier: {},
        implementerReport: "include",
      };
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        outcome === "approves" ? "succeeded" : "needs_human",
      );
      expect(implementations).toBe(4);
      expect(finders).toHaveLength(4);
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.conflictRound).toBe(3);
      expect(state?.reviewHistory?.map((e) => [e.round, e.panelReview, e.scope?.kind])).toEqual([
        [0, 1, "full"],
        [1, 2, "fix"],
        [2, 3, "fix"],
        [3, undefined, "resolution"],
      ]);
      expect(f.store.getArtifact(run.id, "review-4.json")).toBeNull();
      const [r1, r2, r3] = [1, 2, 3].map((n) =>
        JSON.parse(f.store.getArtifact(run.id, `review-${n}.json`) ?? "{}"),
      );
      expect([r1.panelReview, r2.panelReview, r3.panelReview]).toEqual([1, 2, 3]);
      expect(r3.verdict).toBe("approve");
      const resolution = JSON.parse(f.store.getArtifact(run.id, "review-resolution.json") ?? "{}");
      expect(resolution).toMatchObject({
        round: 3,
        scope: { kind: "resolution", range: `${baseTip}..${resolution.reviewedSha}` },
      });
      expect(resolution).not.toHaveProperty("panelReview");

      // The resolution review: the change against the new base, never the upstream-only file.
      const resolutionPrompt = finders[3]?.prompt ?? "";
      expect(resolutionPrompt).toContain(`inspect \`git diff ${baseTip}..HEAD\` against the pinned new base`);
      expect(resolutionPrompt).not.toContain("the fix diff only");
      for (const file of ["first-only.txt", "farewell.txt", "greeting.txt"])
        expect(resolutionPrompt).toContain(file);
      expect(resolutionPrompt).not.toContain("upstream-only.txt");
      // R2 sees only its fix diff: never the file only R1's change touched.
      expect(finders[1]?.prompt).toContain("farewell.txt");
      expect(finders[1]?.prompt).not.toContain("first-only.txt");
      // Timeouts follow the diff each reviewer got: 503 changed lines for R1, 2 for R2, and 502
      // against the new base for the resolution review (the upstream file's 300 would make it 802).
      expect(finders.map((s) => s.timeoutMs)).toEqual([503, 2, 2, 502].map((n) => readingTimeout(n)));
      for (const v of verifiers[1] ?? []) expect(v.timeoutMs).toBe(readingTimeout(2));

      if (outcome === "approves") {
        expect(f.store.getArtifact(run.id, "report.md")).toContain(
          `- Conflict-resolution review — change against the new base \`${baseTip}..${resolution.reviewedSha}\``,
        );
      } else {
        expect(resolution.verdict).toBe("request_changes");
        expect(resolution.blocking.map((b: { title: string }) => b.title)).toEqual(["R4 bug"]);
        // The resolution review's feedback follows R2's rules too, so the finding reaches the human.
        expect(f.store.getRun(run.id)?.error).toContain("R4 bug");
        for (const v of verifiers[3] ?? []) {
          expect(v.timeoutMs).toBe(readingTimeout(502));
          expect(v.prompt).toContain(`git diff ${baseTip}..${resolution.reviewedSha}`);
          expect(v.prompt).not.toContain("upstream-only.txt");
        }
        // No further repair round: the verified R3 head goes out as a draft.
        expect(f.store.getRun(run.id)?.prUrl).toContain("/pull/1");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
      }
    });

  test("panel: a verify failure after R3 approves goes to a human before a fourth implementation", async () => {
    const bare = await githubFixture();
    const blocker = (title: string, label?: "new") => ({
      severity: "major",
      security: false,
      ...findingEvidence,
      ...(label ? { label, prior: "" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: `detail ${title}`,
      suggestion: "fix",
    });
    const found = [[blocker("R1 bug")], [blocker("R2 bug", "new")], []];
    let finders = 0;
    let implementations = 0;
    let verifies = 0;
    const f = start((s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        const cited = [
          ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
        ];
        return {
          structured: {
            results: cited.map(([, id, title]) => ({
              id,
              verdict: title === `R${finders} bug` ? "CONFIRMED" : "REFUTED",
              severity: "high",
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: { ...approve, findings: found[finders++] ?? [] } };
      if (role === "verify") {
        verifies++;
        return {
          structured: {
            ...pass,
            overall: "fail",
            criteria: pass.criteria.map((c) => ({ ...c, status: "unmet" })),
          },
        };
      }
      implementations++;
      return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
    });
    f.deps.reviewSystem = {
      name: "panel",
      mode: "panel",
      finders: [{ prompt: "standard" }],
      verifier: {},
      implementerReport: "include",
    };
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(implementations).toBe(3);
    expect(finders).toBe(3);
    expect(verifies).toBe(1);
    expect(f.store.listStages(run.id).filter((stage) => stage.name === "implement")).toHaveLength(3);
    expect(f.store.getArtifact(run.id, "implement-3.md")).toBeNull();
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.reviewHistory?.map((e) => e.panelReview)).toEqual([1, 2, 3]);
    expect(state?.needsHumanReason).toContain("Panel review limit reached (R3)");
    // The draft is the head R3 reviewed.
    const r3 = JSON.parse(f.store.getArtifact(run.id, "review-3.json") ?? "{}");
    const finished = f.store.getRun(run.id);
    expect(finished?.headSha).toBe(r3.reviewedSha);
    expect(
      (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
    ).toContain(r3.reviewedSha);
    expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
  });

  for (const kind of [
    "unchanged",
    "clean",
    "clean-scripts",
    "regressed",
    "setup-regressed",
    "fixed-regressed",
    "conflict",
    "conflict-scripts",
    "rewritten",
  ] as const) {
    test(`GitHub delivery handles ${kind} base`, async () => {
      const conflict = kind === "conflict" || kind === "conflict-scripts";
      const changedScripts = kind === "clean-scripts" || kind === "conflict-scripts";
      if (kind === "setup-regressed" || kind === "fixed-regressed") {
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          kind === "setup-regressed"
            ? '[gates]\nsetup = ["test ! -f base.txt"]\nchecks = [{ name = "check", run = "true" }]\n'
            : '[gates]\nchecks = [{ name = "check", run = "test -f farewell.txt && test ! -f base.txt" }]\n',
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "gate fixture"], {
          cwd: repoDir,
        });
      }
      if (changedScripts) {
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: { check: "test -s greeting.txt" } }),
        );
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          '[gates]\nchecks = [{ name = "check", run = "bun run check" }]\n',
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "script gate"], {
          cwd: repoDir,
        });
      }
      if (kind === "clean" || kind === "unchanged") {
        const configPath = join(repoDir, ".limitless.toml");
        writeFileSync(
          configPath,
          readFileSync(configPath, "utf8").replace(
            "[gates]\n",
            `[gates]\nsetup = ["echo setup >> '${join(home, "setup-calls")}'"]\n`,
          ),
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "setup fixture"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let baseTip = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      const originalBase = baseTip;
      let implementCalls = 0;
      let reviews = 0;
      let verifies = 0;
      let mergePrompt = "";
      let checkedHead = "";
      let preMergeHead = "";
      const f = start(async (s): Promise<FakeReply> => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "standard" }) };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews === 1 && kind !== "unchanged") {
            if (changedScripts) {
              writeFileSync(
                join(repoDir, "package.json"),
                JSON.stringify({ scripts: { check: "test -s greeting.txt && test -f package.json" } }),
              );
            }
            if (conflict) writeFileSync(join(repoDir, "base.txt"), "base only\n");
            baseTip = await advanceBase(
              bare,
              conflict ? "greeting.txt" : "base.txt",
              kind === "regressed" ? "BAD base\n" : "new base\n",
            );
            if (kind === "rewritten") {
              // Replace the initial commit so the fetched base no longer descends from it.
              baseTip = (
                await sh(["git", "commit-tree", "HEAD^{tree}", "-m", "rewritten base"], {
                  cwd: repoDir,
                  env: {
                    GIT_AUTHOR_NAME: "t",
                    GIT_AUTHOR_EMAIL: "t@t",
                    GIT_COMMITTER_NAME: "t",
                    GIT_COMMITTER_EMAIL: "t@t",
                  },
                })
              ).stdout.trim();
              await sh(["git", "push", "--force", bare, `${baseTip}:refs/heads/main`], { cwd: repoDir });
            }
          }
          if (reviews === 2) {
            expect(s.prompt).toContain(baseTip);
            expect(s.prompt).not.toContain(`git diff ${preMergeHead}..`);
            expect(s.prompt).not.toContain("base.txt");
            expect(s.prompt).not.toContain("package.json");
          }
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          if (verifies === 2) expect(s.prompt).toContain(baseTip);
          checkedHead = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
          if (verifies === 1) preMergeHead = checkedHead;
          return { structured: pass };
        }
        implementCalls++;
        if (conflict && implementCalls === 2) {
          mergePrompt = s.prompt;
          return resolveBaseConflict(s.cwd, bare);
        }
        const files: Record<string, string> = { "farewell.txt": "goodbye\n" };
        if (conflict) files["greeting.txt"] = "hello from feature\n";
        return { files };
      });
      registerGithub(f, bare);
      const run = await f.createRun({
        repo: "test/repo",
        prompt: "Add a farewell file",
        profile: "standard",
      });
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
      const fallback = kind.endsWith("regressed") || kind === "rewritten";
      expect(status).toBe(kind.endsWith("regressed") ? "needs_human" : "succeeded");
      const finished = f.store.getRun(run.id);
      const stages = f.store.listStages(run.id).map((s) => s.name);
      const gates = stages.filter((s) => s === "gates").length;
      expect(gates).toBe(kind === "unchanged" || kind === "rewritten" ? 1 : 2);
      if (kind === "clean" || kind === "unchanged")
        expect(readFileSync(join(home, "setup-calls"), "utf8").trim().split("\n")).toHaveLength(
          kind === "clean" ? 3 : 2,
        );
      expect(stages.filter((s) => s === "audit")).toHaveLength(conflict ? 2 : 1);
      expect(implementCalls).toBe(conflict ? 2 : 1);
      expect(reviews).toBe(conflict ? 2 : 1);
      expect(verifies).toBe(conflict ? 2 : 1);
      if (conflict) {
        expect(mergePrompt).toContain("do not run Git");
        expect(mergePrompt).toContain("- greeting.txt");
        expect(mergePrompt).not.toContain("git diff");
        expect(mergePrompt).not.toContain("Committing is optional");
        expect(stages.slice(-6)).toEqual(["implement", "gates", "audit", "review", "verify", "deliver"]);
        expect(f.store.getArtifact(run.id, "diff.patch")).not.toContain("+new base");
      }
      if (fallback) {
        expect(finished?.baseSha).toBe(originalBase);
        const state = f.store.getRunState<RunState>(run.id);
        if (kind === "rewritten")
          expect(f.store.getArtifact(run.id, "report.md")).toContain(state?.rebaseNote ?? "missing note");
        else {
          expect(state?.lastVerifiedSha).toBe(preMergeHead);
          expect(finished?.prUrl).toContain("/pull/1");
          expect(f.store.getArtifact(run.id, "report.md")).toContain("post-merge gates");
          expect(f.store.getArtifact(run.id, "report.md")).toContain(preMergeHead);
          expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
        }
        expect(
          (
            await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], {
              cwd: bare,
              allowFail: true,
            })
          ).exitCode,
        ).not.toBe(0);
        if (kind.endsWith("regressed")) {
          expect(f.store.getArtifact(run.id, "gates-rebase-0.json")).toContain("regressed");
          expect(state?.lastGates?.some((g) => g.blocking)).toBe(false);
          expect(
            f.store
              .listStages(run.id)
              .filter((s) => s.name === "gates")
              .at(-1)?.status,
          ).toBe("failed");
        } else expect(state?.rebaseNote).toContain("no longer descends from the recorded base");
      } else {
        expect(finished?.baseSha).toBe(baseTip);
        expect(
          (
            await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], {
              cwd: bare,
              allowFail: true,
            })
          ).exitCode,
        ).toBe(0);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(finished?.headSha ?? "missing");
        if (kind === "unchanged") expect(finished?.headSha).toBe(checkedHead);
        else {
          expect(
            (
              await sh(["git", "rev-list", "--parents", "-n", "1", finished?.headSha ?? ""], { cwd: bare })
            ).stdout
              .trim()
              .split(" ")
              .slice(1),
          ).toEqual([preMergeHead, baseTip]);
          const diff = (await sh(["git", "diff", `${baseTip}...${finished?.headSha}`], { cwd: bare })).stdout;
          expect(diff).not.toContain("base.txt");
          expect(diff).not.toContain("package.json");
          expect(diff).toContain("farewell.txt");
        }
      }
      if (changedScripts) {
        const state = f.store.getRunState<RunState>(run.id);
        expect(state?.baselineScripts).toEqual({ check: "test -s greeting.txt && test -f package.json" });
        expect(state?.lastAudit?.some((finding) => finding.rule === "gate-script-changed")).toBe(false);
        expect(f.store.getArtifact(run.id, "diff.patch")).not.toContain("package.json");
      }
      await assertPublished(bare);
    });
  }

  for (const outcome of ["exhausted", "gates", "audit", "review", "verify", "base-moved"] as const) {
    test(`conflict resolution gets one checked round: ${outcome}`, async () => {
      if (outcome === "audit") {
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          `${readFileSync(join(repoDir, ".limitless.toml"), "utf8")}\n[policy]\nprotected_paths = [".limitless.toml"]\n`,
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "protect gates"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let implementsCount = 0;
      let reviews = 0;
      let verifies = 0;
      let baseTip = "";
      const normalRounds = outcome === "exhausted" ? 3 : 1;
      const f = start(async (s): Promise<FakeReply> => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews < normalRounds || (outcome === "review" && reviews > normalRounds))
            return {
              structured: {
                verdict: "request_changes",
                summary: "Fix the feature",
                findings: [
                  {
                    severity: "blocker",
                    security: false,
                    ...findingEvidence,
                    ...(reviews > 1
                      ? reviews > normalRounds
                        ? { label: "regression", prior: "" }
                        : { label: "unaddressed", prior: "P1" }
                      : {}),
                    file: "farewell.txt",
                    line: 1,
                    title: "Fix the feature",
                    detail: "Incorrect output",
                    suggestion: "Fix it",
                  },
                ],
              },
            };
          if (reviews === normalRounds) baseTip = await advanceBase(bare, "greeting.txt", "new base\n");
          expect(s.prompt).toContain(reviews > normalRounds ? baseTip : "Add a farewell");
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          if (verifies === 2) {
            expect(s.prompt).toContain(baseTip);
            if (outcome === "base-moved") await advanceBase(bare, "again.txt", "another advance\n");
          }
          return {
            structured:
              outcome === "verify" && verifies === 2
                ? { ...pass, criteria: pass.criteria.map((c) => ({ ...c, status: "unmet" })) }
                : pass,
          };
        }
        implementsCount++;
        if (implementsCount > normalRounds) {
          expect(s.prompt).toContain("do not run Git");
          expect(s.prompt).toContain("preserving both intents");
          const reply = await resolveBaseConflict(s.cwd, bare);
          if (outcome === "gates") return { files: { ...reply.files, "bad.txt": "BAD\n" } };
          if (outcome === "audit")
            return { files: { ...reply.files, ".limitless.toml": "# removed gates\n" } };
          return reply;
        }
        return { files: { "greeting.txt": "feature\n", "farewell.txt": "goodbye\n" } };
      });
      f.cfg.maxRounds = 1;
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
      expect(status).toBe(outcome === "exhausted" || outcome === "base-moved" ? "succeeded" : "needs_human");
      expect(implementsCount).toBe(normalRounds + 1);
      expect(f.store.getRun(run.id)?.baseSha).toBe(baseTip);
      expect(f.store.getRunState<RunState>(run.id)?.conflictRound).toBe(normalRounds);
      if (outcome === "exhausted") {
        expect(reviews).toBe(4);
        expect(verifies).toBe(2);
        expect(
          f.store
            .listStages(run.id)
            .slice(-6)
            .map((s) => s.name),
        ).toEqual(["implement", "gates", "audit", "review", "verify", "deliver"]);
        const head = f.store.getRun(run.id)?.headSha ?? "";
        expect(
          (await sh(["git", "merge-base", "--is-ancestor", baseTip, head], { cwd: bare })).exitCode,
        ).toBe(0);
      } else if (outcome === "base-moved") {
        expect(f.store.getRunState<RunState>(run.id)?.rebaseNote).toContain("advanced again");
        await assertPublished(bare);
      } else {
        const state = f.store.getRunState<RunState>(run.id);
        const finished = f.store.getRun(run.id);
        const sha = state?.lastVerifiedSha ?? "missing";
        expect(sha).toHaveLength(40);
        expect(finished?.prUrl).toContain("/pull/1");
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(sha);
        // Single mode saves main's evidence: follow-ups and review history stay live, not snapshotted.
        const evidence = state?.lastVerifiedEvidence;
        expect(evidence?.lastReview?.verdict).toBe("approve");
        expect(evidence).not.toHaveProperty("reviewFollowUps");
        expect(evidence).not.toHaveProperty("reviewHistory");
        const report = f.store.getArtifact(run.id, "report.md") ?? "";
        expect(report).toContain(`Verified at \`${sha}\``);
        expect(report).toContain("conflict resolution");
        expect(report).toContain("The PR may conflict with `main`");
        expect(report).toContain("Acceptance criteria");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--title [needs human]");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
        expect(readFileSync(join(home, "gh-body"), "utf8")).toBe(report);
      }
    });
  }

  test("quick approval is the verified fallback when post-merge gates fail", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      '[gates]\nchecks = [{ name = "check", run = "test ! -f base.txt" }]\n',
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "quick gate"], {
      cwd: repoDir,
    });
    const bare = await githubFixture();
    let approvedSha = "";
    const f = start(async (s): Promise<FakeReply> => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        approvedSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      if (role === "verify" || role === "spec" || role === "holdout") throw new Error(`unexpected ${role}`);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    const finished = f.store.getRun(run.id);
    expect(f.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBe(approvedSha);
    expect(
      (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
    ).toContain(approvedSha);
    expect(f.store.getArtifact(run.id, "report.md")).toContain("post-merge gates");
  });

  for (const fault of [
    "missing",
    "single-parent",
    "markers",
    "resolver-error",
    "resolver-timeout",
    "partial",
    "fixture",
    "stray",
    "same-tree",
    "setext",
  ] as const) {
    test(`factory merge resolution: ${fault}`, async () => {
      const bare = await githubFixture();
      let calls = 0;
      let before = "";
      let base = "";
      const f = start(async (s): Promise<FakeReply> => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        // "fixture" conflicts right after a pre-existing marker line identical to git's own.
        const [file, prefix] = fault === "fixture" ? ["markers.fixture", fixture] : ["greeting.txt", ""];
        if (roleOf(s) === "review") {
          if (!base) base = await advanceBase(bare, file, `${prefix}base intent\n`);
          return { structured: approve };
        }
        calls++;
        if (calls === 1) return { files: { [file]: `${prefix}feature intent\n` } };
        before = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
        if (fault === "resolver-error" || fault === "resolver-timeout") {
          expect(readFileSync(join(s.cwd, file), "utf8")).toContain("<<<<<<< HEAD");
          // Even a failed resolver can have changed the index before it exits.
          await mergeGit(s.cwd, ["add", file]);
          return { status: fault === "resolver-error" ? "error" : "timeout", error: "resolver failed" };
        }
        if (fault === "fixture") {
          expect(readFileSync(join(s.cwd, file), "utf8")).toBe(
            `${fixture}<<<<<<< HEAD\nfeature intent\n=======\nbase intent\n>>>>>>> ${base}\n`,
          );
          return { files: { [file]: `${fixture}<<<<<<< HEAD\nfeature intent\n=======\nbase intent\n` } };
        }
        if (fault === "missing" || fault === "single-parent") {
          const path = (
            await sh(["git", "rev-parse", "--git-path", "MERGE_HEAD"], { cwd: s.cwd })
          ).stdout.trim();
          rmSync(resolve(s.cwd, path));
          if (fault === "single-parent") {
            writeFileSync(join(s.cwd, "greeting.txt"), "replacement\n");
            await mergeGit(s.cwd, ["add", "-A"]);
            await mergeGit(s.cwd, ["commit", "-qm", "lost merge parent"]);
          }
        }
        if (fault === "stray")
          return {
            files: {
              "greeting.txt": "feature intent\nbase intent\n",
              "README.md": "Project\n=======\n<<<<<<< HEAD\nours\n",
              "new.txt": "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> base\n",
            },
          };
        if (fault === "partial")
          return { files: { "greeting.txt": `feature intent\n=======\nbase intent\n>>>>>>> ${base}\n` } };
        if (fault === "setext")
          return { files: { "greeting.txt": "Greeting\n========\nfeature intent\nbase intent\n" } };
        return fault === "same-tree" ? { files: { "greeting.txt": "feature intent\n" } } : {};
      });
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Change greeting", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        fault === "same-tree" || fault === "setext" ? "succeeded" : "needs_human",
      );
      expect(calls).toBe(2);
      const result = f.store.getRun(run.id);
      if (fault === "same-tree" || fault === "setext") {
        expect(
          (await sh(["git", "rev-list", "--parents", "-n", "1", result?.headSha ?? ""], { cwd: bare })).stdout
            .trim()
            .split(" ")
            .slice(1),
        ).toEqual([before, base]);
        if (fault === "same-tree")
          expect((await sh(["git", "diff", before, result?.headSha ?? ""], { cwd: bare })).stdout).toBe("");
        else
          expect((await sh(["git", "show", `${result?.headSha}:greeting.txt`], { cwd: bare })).stdout).toBe(
            "Greeting\n========\nfeature intent\nbase intent\n",
          );
      } else {
        expect(result?.error).toContain(
          fault === "markers" ||
            fault === "partial" ||
            fault === "resolver-error" ||
            fault === "resolver-timeout"
            ? "Unresolved conflict markers: greeting.txt"
            : fault === "fixture"
              ? "Unresolved conflict markers: markers.fixture"
              : fault === "stray"
                ? "Unresolved conflict markers: new.txt, README.md"
                : "MERGE_HEAD",
        );
        if (fault === "resolver-error" || fault === "resolver-timeout") {
          const cwd = f.store.getRunState<RunState>(run.id)?.worktreePath ?? "";
          expect((await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
          expect((await mergeGit(cwd, ["rev-parse", "MERGE_HEAD"])).stdout.trim()).toBe(base);
          expect(
            (await mergeGit(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout
              .trim()
              .split(" ")
              .slice(1),
          ).toHaveLength(1);
          expect(f.store.getRunState<RunState>(run.id)?.implementerIssue).toContain(
            fault === "resolver-error" ? "error" : "timeout",
          );
        }
        const verified = f.store.getRunState<RunState>(run.id)?.lastVerifiedSha;
        expect(verified).toHaveLength(40);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${result?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(verified ?? "missing");
      }
    });
  }

  test("merge helpers isolate configured code in a linked worktree and reject non-conflict errors", async () => {
    const cwd = join(home, "linked");
    await sh(["git", "worktree", "add", "-b", "feature", cwd], { cwd: repoDir });
    writeFileSync(join(cwd, "greeting.txt"), "feature\n");
    await mergeGit(cwd, ["add", "-A"]);
    await mergeGit(cwd, ["commit", "-qm", "feature"]);
    const before = (await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(repoDir, ".git", "info", "attributes"), "greeting.txt merge=secret-check\n");
    writeFileSync(join(repoDir, "greeting.txt"), "base\n");
    await mergeGit(repoDir, ["add", "-A"]);
    await mergeGit(repoDir, ["commit", "-qm", "base"]);
    const base = (await mergeGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
    const sentinel = join(home, "hook-ran");
    for (const hook of [
      "pre-merge-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "post-merge",
      "post-index-change",
    ])
      writeFileSync(join(repoDir, ".git", "hooks", hook), `#!/bin/sh\ntouch '${sentinel}'\n`, {
        mode: 0o755,
      });
    await sh(
      [
        "git",
        "config",
        "merge.secret-check.driver",
        `test -z "$LIMITLESS_MERGE_TEST_SECRET" && touch '${join(home, "driver-ran")}' && exit 1`,
      ],
      { cwd },
    );
    process.env.LIMITLESS_MERGE_TEST_SECRET = "must not escape";
    try {
      await expect(prepareMerge(cwd, before, "invalid-target")).rejects.toThrow("Merge preparation failed");
      expect(await prepareMerge(cwd, before, base)).toEqual(["greeting.txt"]);
      expect(existsSync(join(home, "driver-ran"))).toBe(true);
      writeFileSync(join(cwd, "greeting.txt"), "both intents\n");
      await completeMerge(cwd, before, base);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      delete process.env.LIMITLESS_MERGE_TEST_SECRET;
    }
  });

  for (const checkpoint of [
    "post-rebase-gates",
    "post-rebase-gates-fail",
    "interrupted-merge",
    "base-moved",
    "base-moved-during-gates",
    "conflict-implement",
    "conflict-committed",
  ] as const) {
    test(`delivery checkpoint ${checkpoint} never publishes unchecked work`, async () => {
      const conflict = checkpoint.startsWith("conflict-");
      const marker = join(home, "checking");
      const release = join(home, "release");
      if (checkpoint !== "conflict-implement") {
        const check = `if test -f base.txt && ! test -f '${release}'; then echo dirty > greeting.txt; touch '${marker}'; while ! test -f '${release}'; do sleep 0.05; done; fi; test -f greeting.txt${checkpoint === "post-rebase-gates-fail" ? " && test ! -f base.txt" : ""}`;
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "slow gate"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let baseTip = "";
      let implementsCount = 0;
      let reviews = 0;
      let verifies = 0;
      let restarting = false;
      const handler: Handler = async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews === 1) {
            writeFileSync(join(repoDir, "base.txt"), "base only\n");
            baseTip = await advanceBase(bare, conflict ? "greeting.txt" : "base.txt", "new base\n");
          }
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          return { structured: pass };
        }
        implementsCount++;
        if (implementsCount > 1) {
          expect(s.prompt).toContain("do not run Git");
          if (checkpoint === "conflict-committed") return resolveBaseConflict(s.cwd, bare);
          if (!restarting) {
            writeFileSync(join(s.cwd, "greeting.txt"), "partially resolved\n");
            writeFileSync(marker, "implementing");
            return { delayMs: 30_000 };
          }
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("partially resolved\n");
          expect((await sh(["git", "rev-parse", "MERGE_HEAD"], { cwd: s.cwd })).stdout.trim()).toBe(baseTip);
          return { files: { "greeting.txt": "hello from both intents\nnew base\n" } };
        }
        return {
          files: {
            "farewell.txt": "goodbye\n",
            ...(conflict ? { "greeting.txt": "feature\n" } : {}),
          },
        };
      };
      const f = start(handler);
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      if (checkpoint === "base-moved-during-gates") {
        await assertUnpublished(bare);
        await advanceBase(bare, "again.txt", "newer base\n");
        writeFileSync(release, "finish gates");
        // The head that passed the post-rebase gates is published; the newer base is the PR's concern.
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const published = f.store.getRun(run.id);
        expect(published?.baseSha).toBe(baseTip);
        expect(f.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(2);
        expect(implementsCount).toBe(1);
        expect(reviews).toBe(1);
        expect(verifies).toBe(1);
        expect(
          (await sh(["git", "show", `${published?.headSha}:greeting.txt`], { cwd: bare })).stdout,
        ).not.toContain("dirty");
        await assertPublished(bare);
        return;
      }
      await f.stop();
      expect(f.store.getRun(run.id)?.status).toBe("queued");
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.phase).toBe(conflict ? "loop" : "deliver");
      expect(state?.lastVerifiedSha).toHaveLength(40);
      if (conflict) {
        expect(f.store.getRun(run.id)?.baseSha).toBe(baseTip);
        expect(state?.conflictRound).toBe(1);
      } else {
        expect(state?.pendingRebaseSha).toBe(baseTip);
        expect(f.store.getRun(run.id)?.baseSha).not.toBe(baseTip);
      }
      await assertUnpublished(bare);
      if (checkpoint === "interrupted-merge") {
        const cwd = state?.worktreePath;
        if (!cwd || !state?.preRebaseHead) throw new Error("missing delivery checkpoint");
        await sh(["git", "reset", "--hard", state.preRebaseHead], { cwd });
        await sh(
          ["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-commit", baseTip],
          { cwd },
        );
      }
      if (checkpoint === "conflict-committed" && state) {
        // Also exercise the crash window after git commit but before implementedRound is saved.
        state.implementedRound = undefined;
        f.store.updateRun(run.id, {}, state);
      }
      f.store.close();
      restarting = true;
      if (checkpoint === "base-moved" || conflict) await advanceBase(bare, "again.txt", "newer base\n");
      writeFileSync(release, "resume");
      const resumed = start(handler);
      if (checkpoint === "post-rebase-gates-fail") {
        expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
        const finished = resumed.store.getRun(run.id);
        const savedSha = state?.lastVerifiedSha ?? "missing";
        expect(resumed.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBe(savedSha);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(savedSha);
        expect(finished?.prUrl).toContain("/pull/1");
        return;
      }
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const finished = resumed.store.getRun(run.id);
      expect(finished?.baseSha).toBe(baseTip);
      expect(resumed.store.getRunState<RunState>(run.id)?.pendingRebaseSha).toBeUndefined();
      expect(implementsCount).toBe(conflict ? (checkpoint === "conflict-implement" ? 3 : 2) : 1);
      expect(reviews).toBe(conflict ? 2 : 1);
      expect(verifies).toBe(conflict ? 2 : 1);
      expect(
        (await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], { cwd: bare }))
          .exitCode,
      ).toBe(0);
      expect(
        (await sh(["git", "show", `${finished?.headSha}:greeting.txt`], { cwd: bare })).stdout,
      ).not.toContain("dirty");
      expect(
        (
          await sh(["git", "rev-list", "--count", "--merges", finished?.headSha ?? ""], { cwd: bare })
        ).stdout.trim(),
      ).toBe("1");
      expect(
        (await sh(["git", "rev-list", "--parents", "-n", "1", finished?.headSha ?? ""], { cwd: bare })).stdout
          .trim()
          .split(" ")
          .slice(1),
      ).toEqual([state?.preRebaseHead ?? "", baseTip]);
      expect(resumed.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(
        checkpoint === "conflict-implement" ? 2 : 3,
      );
    });
  }

  test.each([
    ["main", null],
    ["main", "not-a-sha"],
    ["main.lock", "b".repeat(40)],
  ])("PR verification rejects invalid base metadata: %s %s", async (baseRef, baseSha) => {
    const f = start(() => {
      throw new Error("No model should run");
    });
    const run = await f.createRun({
      repo: repoDir,
      prompt: "verify",
      sourceRef: { kind: "pull_request", baseRef, baseSha, headSha: "a".repeat(40), number: 1 },
    });
    expect(await waitFor(f, run.id, ["failed", "succeeded"])).toBe("failed");
    expect(f.store.getRun(run.id)?.error).toContain("valid PR baseRef");
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
  });

  test.each([
    "approve",
    "gates",
    "review",
    "persistent",
    "repair-audit",
    "baseline",
    "empty",
    "restart-initial",
    "restart-repair",
    "pending-comment",
    "head-moved",
    "head-lookup-failure",
    "head-lookup-missing",
    "head-lookup-malformed",
    "base-script",
    "pr-script",
    "pr-script-removed",
  ])(
    "verify-change: %s",
    async (scenario) => {
      const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: repoDir })).stdout.trim();
      const commit = async () => {
        await git("add", ".");
        await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
        return git("rev-parse", "HEAD");
      };
      const scriptAudit = scenario.includes("script");
      const prScript = scenario.startsWith("pr-script");
      const stale = scenario.startsWith("head-");
      const records = join(home, "gate-revisions");
      writeFileSync(
        join(repoDir, ".limitless.toml"),
        `[gates]
checks = [{ name = "test", run = "git rev-parse HEAD >> ${records}; echo generated > generated.txt; ! grep BAD greeting.txt" }${scriptAudit ? ', { name = "script", run = "bun run audit-check || true" }' : ""}]
[policy]
protected_paths = ["protected.txt"]
`,
      );
      if (scenario === "baseline") writeFileSync(join(repoDir, "greeting.txt"), "BAD\n");
      if (scriptAudit)
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: { "audit-check": "exit 0" } }),
        );
      const base = await commit();
      if (prScript)
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: scenario === "pr-script-removed" ? {} : { "audit-check": "echo pr" } }),
        );
      if (scenario !== "empty") writeFileSync(join(repoDir, "version.txt"), "dependency 2\n");
      if (scenario === "gates") writeFileSync(join(repoDir, "greeting.txt"), "BAD\n");
      if (scenario === "repair-audit") writeFileSync(join(repoDir, "protected.txt"), "original\n");
      const head = scenario === "empty" ? base : await commit();
      const bare = join(home, "github.git");
      await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
      await git("push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2");
      // The base tip is not an ancestor of the PR head: review must use the merge base.
      await git("reset", "--hard", base);
      writeFileSync(join(repoDir, "base-only.txt"), "base advancement\n");
      if (scriptAudit)
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: { "audit-check": "echo base" } }),
        );
      const baseTip = await commit();
      await git("push", "--force", bare, "HEAD:refs/heads/main");
      const prompts: string[] = [];
      let implementations = 0;
      let interrupted = false;
      let resume: (() => void) | undefined;
      const blocker = {
        severity: "major",
        file: "version.txt",
        line: 1,
        title: "Compatibility bug",
        detail: "Repair compatibility",
        suggestion: "Fix compatibility",
        security: false,
        ...findingEvidence,
      };
      const needsReviewRepair = ["review", "persistent", "repair-audit", "restart-repair"].includes(scenario);
      const handler: Handler = async (agent): Promise<FakeReply> => {
        const role = roleOf(agent);
        if (role === "triage") return { structured: triage() }; // PR source overrides feature + standard triage.
        if (role === "review") {
          prompts.push(agent.prompt);
          expect(agent.prompt).toContain(`git diff ${baseTip}...`);
          for (const topic of [
            "breaking changes",
            "permission and pinning",
            "lockfile consistency",
            "install-time code",
          ])
            expect(agent.prompt).toContain(topic);
          const patch = (await sh(["git", "diff", `${baseTip}...HEAD`], { cwd: agent.cwd })).stdout;
          expect(patch).toContain("dependency 2");
          expect(patch).not.toContain("base-only");
          expect(patch).not.toContain("generated.txt");
          expect(agent.prompt).toContain("+dependency 2");
          expect(agent.prompt).not.toContain("base-only");
          if (
            (scenario === "restart-initial" || (scenario === "restart-repair" && implementations > 0)) &&
            !interrupted
          ) {
            interrupted = true;
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
          if (needsReviewRepair && (implementations === 0 || scenario === "persistent"))
            return {
              structured: {
                ...approve,
                findings: [
                  {
                    ...blocker,
                    ...(implementations ? { label: "unaddressed", prior: "P1", security: false } : {}),
                  },
                ],
              },
            };
          if (scenario === "head-moved") {
            await git("reset", "--hard", head);
            writeFileSync(join(repoDir, "competing.txt"), "another push\n");
            await commit();
            await git("push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2");
          }
          return { structured: approve };
        }
        expect(role).toBe("implement");
        implementations++;
        expect(agent.prompt).toContain(
          prScript
            ? "gate-script-changed"
            : scenario === "gates"
              ? "test"
              : scenario === "empty"
                ? "empty-diff"
                : implementations > 1 && scenario === "repair-audit"
                  ? "Repair:"
                  : "Compatibility bug",
        );
        if (scenario === "empty") return { text: "No changes" };
        return {
          files:
            scenario === "repair-audit"
              ? { "protected.txt": "tampered\n" }
              : { "greeting.txt": "repaired\n" },
          text: "Repaired compatibility",
        };
      };
      let f = start(handler);
      const calls: string[][] = [];
      const gh = async (args: string[]) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          if (scenario === "head-lookup-failure") throw new Error("fixture lookup failed");
          if (scenario === "head-lookup-missing") return "{}";
          if (scenario === "head-lookup-malformed") return "invalid JSON";
          return JSON.stringify({
            headRefOid: (await git("ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).split("\t")[0],
          });
        }
        if (args[0] === "api") return calls.find((call) => call[1] === "comment")?.at(-1) ?? "";
        return "";
      };
      if (scenario === "pending-comment")
        f.deps.faults = {
          "store:save": { action: "kill", when: (c) => c.checkpoint === "verification-comment-posted" },
        };
      f.deps.gh = gh;
      let stopNotifier = startGitHubNotifier(
        f.store,
        gh,
        () => {},
        async () => null,
      );
      f.store.upsertRepo({
        slug: "MattFlower/limitless",
        kind: "github",
        url: bare,
        localPath: null,
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      f.cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
      const payload = JSON.parse(readFileSync(join(import.meta.dir, "data/github-pr.json"), "utf8"));
      payload.pull_request.base.sha = baseTip;
      payload.pull_request.head.sha = head;
      const body = JSON.stringify(payload);
      const response = await githubWebhook(f)(
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": scenario,
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      expect(response.status).toBe(201);
      const { runId } = (await response.json()) as { runId: string };
      if (scenario === "pending-comment") {
        const deadline = Date.now() + 10_000;
        while (f.store.listStages(runId).at(-1)?.status !== "cancelled") {
          if (Date.now() > deadline) throw new Error("comment interruption timed out");
          await Bun.sleep(10);
        }
        stopNotifier();
        await f.stop();
        expect(f.store.getRunState<RunState>(runId)?.verdictCommentPending).toBe(true);
        expect(f.store.getRunState<RunState>(runId)?.verdictCommentPosted).not.toBe(true);
        f.store.close();
        f = start(handler);
        f.deps.gh = gh;
      }
      if (scenario.startsWith("restart")) {
        for (let i = 0; !resume && i < 300; i++) await Bun.sleep(20);
        expect(resume).toBeDefined();
        const before = f.store.getRunState<RunState>(runId);
        stopNotifier();
        const stopping = f.stop();
        resume?.();
        await stopping;
        stopNotifier();
        f.store.close();
        f = start(handler);
        f.deps.gh = gh;
        stopNotifier = startGitHubNotifier(
          f.store,
          gh,
          () => {},
          async () => null,
        );
        expect(before?.verification?.baseSha).toBe(baseTip);
        expect(before?.verification?.headSha).toBe(head);
        if (scenario === "restart-repair") expect(before?.implementedRound).toBe(0);
      }
      const blocked = prScript || ["persistent", "repair-audit", "empty"].includes(scenario);
      expect(await waitFor(f, runId, ["succeeded", "failed", "needs_human", "cancelled"])).toBe(
        scenario === "head-moved" ? "cancelled" : stale ? "failed" : blocked ? "needs_human" : "succeeded",
      );
      stopNotifier();
      const state = f.store.getRunState<RunState>(runId);
      expect(state?.flow).toBe("verify-change");
      expect(f.store.getRunDetail(runId)?.run.flow).toBe("verify-change");
      const revisions = readFileSync(records, "utf8").trim().split("\n");
      // A check failing on base is retried once, still on base, before the head is checked out.
      const baseRuns = scenario === "baseline" ? [baseTip, baseTip] : [baseTip];
      expect(revisions.slice(0, baseRuns.length + 1)).toEqual([...baseRuns, head]);
      const remote = (await git("ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).split("\t")[0];
      if (stale) {
        expect(implementations).toBe(0);
        expect(
          calls.filter((call) => call[1] === "comment" && call.at(-1)?.includes("Verified by")),
        ).toHaveLength(0);
        const reason =
          scenario === "head-moved"
            ? `superseded: PR head moved from ${head} to ${remote}`
            : "Unable to confirm PR head";
        if (scenario === "head-moved") {
          expect(calls.filter((call) => call[1] === "comment")).toHaveLength(0);
          expect(f.store.listEvents(runId).some((event) => event.message === reason)).toBe(true);
        }
        expect(f.store.getRun(runId)?.error).toContain(reason);
        expect(state?.terminalReason).toContain(reason);
        expect(f.store.getArtifact(runId, "report.md")).toContain(reason);
        expect(f.store.getArtifact(runId, "report.md")).not.toContain("Verified by");
        return;
      }
      if (scriptAudit)
        expect(
          state?.lastAudit?.some((a) => a.rule === "gate-script-changed" && a.severity === "block"),
        ).toBe(prScript);
      const unchanged = ["approve", "baseline", "restart-initial", "pending-comment", "base-script"].includes(
        scenario,
      );
      expect(remote).toBe(unchanged || blocked ? head : (f.store.getRun(runId)?.headSha ?? "missing"));
      if (unchanged) {
        expect(implementations).toBe(0);
        expect(f.store.listStages(runId).some((stage) => stage.name === "implement")).toBe(false);
        expect(f.store.getRun(runId)?.headSha).toBe(head);
        expect(existsSync(state?.worktreePath ?? "missing")).toBe(false);
        const comments = calls.filter((call) => call[1] === "comment");
        expect(comments).toHaveLength(1);
        expect(comments[0]?.slice(0, 3)).toEqual(["pr", "comment", "18"]);
        expect(comments[0]?.at(-1)).not.toContain("generated.txt");
        expect(comments[0]?.at(-1)).toContain(`Verified commit: \`${head}\``);
        expect(f.store.getArtifact(runId, "report.md")).toContain(`Verified commit: \`${head}\``);
        expect(comments[0]?.at(-1)).toContain(`<!-- limitless-verification:${runId} -->`);
        for (const text of [
          "Flow: verify-change",
          "| Check |",
          "LGTM",
          "Work log",
          "Total:",
          "spent",
          "subscriptions",
        ])
          expect(comments[0]?.at(-1)).toContain(text);
        expect(f.store.getArtifact(runId, "diff.patch")).toBe(
          (await sh(["git", "diff", `${baseTip}...${head}`], { cwd: repoDir })).stdout,
        );
      } else if (!blocked) {
        expect(implementations).toBe(1);
        expect(revisions).toContain(remote ?? "missing");
        if (needsReviewRepair) {
          expect(prompts.at(-1)).toContain("# Previous review");
          expect(prompts.at(-1)).toContain("Compatibility bug");
          expect(f.store.getArtifact(runId, "diff.patch")).toContain("repaired");
        }
      } else {
        expect(implementations).toBe(f.cfg.maxRounds + 2);
        expect(f.store.getArtifact(runId, "report.md")).toContain("Flow: verify-change");
        if (scenario === "repair-audit")
          expect(
            state?.lastAudit?.some((a) => a.detail.startsWith("Repair:") && a.severity === "block"),
          ).toBe(true);
      }
    },
    30_000,
  );

  test("verify-change panel R2 gets only the fix diff's stat and patch", async () => {
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    writeFileSync(join(repoDir, "version.txt"), "dependency 2\n");
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump"], { cwd: repoDir });
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    await sh(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir });
    const finders: string[] = [];
    const f = start((s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        const cited = [
          ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
        ];
        return {
          structured: {
            results: cited.map(([, id]) => ({
              id,
              // R1's blocker is real; R2's recheck finds it repaired.
              verdict: finders.length === 1 ? "CONFIRMED" : "REFUTED",
              severity: "high",
              category: "compatibility",
              evidence: "version.txt:1 `dependency 2`",
              trigger: "installing -> broken",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
      if (role === "review") {
        finders.push(s.prompt);
        const findings =
          finders.length === 1
            ? [
                {
                  severity: "major",
                  file: "version.txt",
                  line: 1,
                  title: "Needs repair",
                  detail: "Repair the update",
                  suggestion: "Fix compatibility",
                  security: false,
                  ...findingEvidence,
                },
              ]
            : [];
        return { structured: { ...approve, findings } };
      }
      return { files: { "repair.txt": "repaired\n" }, text: "Repaired the update" };
    });
    f.deps.gh = async () => {};
    f.deps.reviewSystem = {
      name: "panel",
      mode: "panel",
      finders: [{ prompt: "standard" }],
      verifier: {},
      implementerReport: "include",
    };
    f.store.upsertRepo({
      slug: "MattFlower/limitless",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    f.cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
    const payload = JSON.parse(readFileSync(join(import.meta.dir, "data/github-pr.json"), "utf8"));
    payload.pull_request.base.sha = baseSha;
    payload.pull_request.head.sha = head;
    const body = JSON.stringify(payload);
    const response = await githubWebhook(f)(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "panel-fix-diff",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
        },
      }),
    );
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };
    expect(await waitFor(f, runId, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(finders).toHaveLength(2);
    // R1 reviews the PR's change inline; R2 only the repair since R1's head.
    expect(finders[0]).toContain("version.txt");
    expect(finders[0]).toContain("+dependency 2");
    const r2 = finders[1] ?? "";
    expect(r2).toContain("review R2: the fix diff only");
    expect(r2).toContain("repair.txt");
    expect(r2).toContain("+repaired");
    expect(r2).not.toContain("+dependency 2");
    expect(r2.slice(0, r2.indexOf("# Previous review"))).not.toContain("version.txt");
    expect(JSON.parse(f.store.getArtifact(runId, "review-2.json") ?? "{}")).toMatchObject({
      verdict: "approve",
      scope: { kind: "fix", range: `${head}..${f.store.getRun(runId)?.headSha}` },
    });
  });

  test("Dependabot run delivers to the existing PR head without creating a PR", async () => {
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    writeFileSync(join(repoDir, "version.txt"), "2\n");
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump"], { cwd: repoDir });
    const originalHead = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    await sh(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir });
    let reviews = 0;
    let concurrent: string | null = null;
    let content = "verified\n";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
      if (role === "review") {
        if (reviews++ === 0)
          return {
            structured: {
              ...approve,
              findings: [
                {
                  severity: "major",
                  file: "version.txt",
                  line: 1,
                  title: "Needs repair",
                  detail: "Repair the update",
                  suggestion: "Fix compatibility",
                  security: false,
                  ...findingEvidence,
                },
              ],
            },
          };
        if (concurrent) {
          const result = Bun.spawnSync(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], {
            cwd: concurrent,
          });
          if (result.exitCode !== 0) throw new Error("concurrent push failed");
          concurrent = null;
        }
        return { structured: approve };
      }
      return { files: { "farewell.txt": content }, text: "Verified dependency update" };
    });
    f.store.upsertRepo({
      slug: "MattFlower/limitless",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    f.cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
    const trigger = async (sha: string, delivery: string) => {
      const payload = JSON.parse(readFileSync(join(import.meta.dir, "data/github-pr.json"), "utf8")) as {
        pull_request: { head: { sha: string }; base: { sha: string } };
      };
      payload.pull_request.head.sha = sha;
      payload.pull_request.base.sha = baseSha;
      const body = JSON.stringify(payload);
      const response = await githubWebhook(f)(
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": delivery,
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      expect(response.status).toBe(201);
      const { runId } = (await response.json()) as { runId: string };
      const run = f.store.getRun(runId);
      if (!run) throw new Error("webhook did not create run");
      expect(run.githubWebhookVerified).toBe(true);
      return run;
    };
    const run = await trigger(originalHead, "initial");
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const finished = f.store.getRun(run.id);
    expect(finished?.prUrl).toBe("https://github.com/MattFlower/limitless/pull/18");
    expect(
      (await sh(["git", "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir })).stdout,
    ).toContain(finished?.headSha ?? "missing head");
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");

    const competitor = join(home, "competitor");
    await sh(["git", "clone", "-q", bare, competitor], { cwd: home });
    await sh(["git", "checkout", "-qb", "move", "origin/dependabot/npm/pkg-2"], { cwd: competitor });
    writeFileSync(join(competitor, "competing.txt"), "new head\n");
    await sh(["git", "add", "."], { cwd: competitor });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "competing update"], {
      cwd: competitor,
    });
    const competingSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: competitor })).stdout.trim();
    concurrent = competitor;
    content = "verified again\n";
    reviews = 0;
    if (!finished?.headSha) throw new Error("missing delivered head");
    const stale = await trigger(finished.headSha, "concurrent");
    expect(await waitFor(f, stale.id, ["succeeded", "failed", "needs_human"])).toBe("failed");
    expect(f.store.getRun(stale.id)?.error).toContain("PR head moved");
    expect(
      (await sh(["git", "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir })).stdout,
    ).toContain(competingSha);
  });

  test("holdout starts alongside implementation, reads only a base snapshot, and quick skips it", async () => {
    for (const profile of ["standard", "deep", "quick"] as const) {
      let implementStarted = false;
      let holdoutCalls = 0;
      let holdoutCwd = "";
      let snapshotChecked = false;
      let runId = "";
      const f = start(async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") {
          holdoutCalls++;
          holdoutCwd = s.cwd;
          expect(s.mode).toBe("readonly");
          expect(s.noTools).toBeFalsy();
          expect(s.maxToolCalls).toBeGreaterThan(0);
          expect(s.maxToolCalls).toBeLessThanOrEqual(50);
          expect(s.scratchDir).toBeTruthy();
          expect(s.privateSession).toBe(true);
          // The cwd alone doesn't confine tools: reads are limited to the snapshot and scratch, and
          // the implementer's worktree and factory state are denied wherever they live.
          expect(s.confineReads).toBe(true);
          expect(basename(dirname(s.cwd))).toStartWith(`limitless-holdout-${process.pid}-`);
          // The private CLI log in the shared temporary directory never holds scenario text.
          expect(s.redactOutput?.("H-1 private step")).toBe("[private]");
          expect(s.denyRead).toEqual(
            expect.arrayContaining([join(f.cfg.paths.work, runId), f.cfg.paths.home, f.cfg.paths.repos]),
          );
          expect(s.prompt).toContain("# Original request");
          expect(s.prompt).toContain("# Specification");
          expect(s.prompt).not.toContain("implementation marker");
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
          expect(existsSync(join(s.cwd, ".limitless.toml"))).toBe(true);
          expect(existsSync(join(s.cwd, ".git"))).toBe(false);
          while (!implementStarted && !s.signal.aborted) await Bun.sleep(10);
          // The implementer has now edited its worktree; the snapshot must not follow.
          await Bun.sleep(50);
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
          expect(existsSync(join(s.cwd, "implementation-marker.txt"))).toBe(false);
          expect(existsSync(join(s.cwd, "farewell.txt"))).toBe(false);
          return { structured: holdout };
        }
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          expect(existsSync(holdoutCwd)).toBe(false);
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("changed\n");
          snapshotChecked = true;
          return { structured: pass };
        }
        implementStarted = true;
        expect(
          s.prompt.includes(
            "A separate verifier will check private scenarios derived from the request, including edge and failure cases",
          ),
        ).toBe(profile !== "quick");
        return {
          files: {
            "farewell.txt": "goodbye\n",
            "greeting.txt": "changed\n",
            "implementation-marker.txt": "implementation marker",
          },
        };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file", profile });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(holdoutCalls).toBe(profile === "quick" ? 0 : 1);
      if (profile !== "quick") {
        expect(snapshotChecked).toBe(true);
        expect(existsSync(holdoutCwd)).toBe(false);
        expect(holdoutCwd).not.toBe(join(f.cfg.paths.work, run.id));
        const invs = f.store.listInvocations(run.id);
        expect(invs.find((i) => i.role === "holdout")?.provider).toBe("beta");
        expect(f.store.getRunState<RunState>(run.id)?.holdoutSameVendor).toBe(false);
      }
      await f.stop();
      f.store.close();
      factory = null;
    }
  });

  test("deep profile routes review as large while other stages keep the triaged complexity", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const route = spyOn(f.deps.router, "route");
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file", profile: "deep" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const complexity = (role: string) => route.mock.calls.filter(([r]) => r === role).map(([, c]) => c);
    expect(complexity("review")).toEqual(["large"]);
    expect(complexity("implement")).toEqual(["small"]);
  });

  test("unmet holdout feedback omits private inputs and publishes scenarios only after delivery", async () => {
    const secret = "PRIVATE_HOLDOUT_TOKEN_729";
    // These values are observed at runtime, not spelled out by the holdout author.
    const observed = '/api/v2/widgets --force 48231 "negative-quantity" ERR_RETRY_EXHAUSTED';
    const observedLiterals = [
      "/api/v2/widgets",
      "--force",
      "48231",
      "negative-quantity",
      "ERR_RETRY_EXHAUSTED",
    ];
    writeFileSync(join(repoDir, "identifiers.ts"), "export const sharedIdentifier = true;\n");
    await sh(["git", "add", "identifiers.ts"], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add identifier"], {
      cwd: repoDir,
    });
    const privateHoldout = {
      scenarios: holdout.scenarios.map((s) =>
        s.id === "H-2"
          ? {
              ...s,
              steps: `run ${secret} with sharedIdentifier and retryIdentifier`,
              description: `secret ${secret} check`,
              expected: `result ${secret}`,
            }
          : s,
      ),
    };
    let implementCalls = 0;
    let verifies = 0;
    let retryFeedbackChecked = false;
    const redactedOutputs: (string | undefined)[] = [];
    let runId = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: privateHoldout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        expect(s.prompt).toContain(secret);
        verifies++;
        redactedOutputs.push(s.redactOutput?.(`retryIdentifier ${secret}`));
        const transcript = s.redactOutput?.(observed);
        expect(transcript).toContain("5 private details withheld");
        for (const literal of observedLiterals) expect(transcript).not.toContain(literal);
        return verifies <= 2
          ? {
              text: `ordinary verifier diagnostic; retryIdentifier; private input ${secret}; ${observed}`,
              error: `verifier diagnostic included ${secret}; ${observed}`,
              structured: {
                ...pass,
                criteria: pass.criteria.map((c) =>
                  c.id === "H-2"
                    ? {
                        ...c,
                        status: verifies === 1 ? "unmet" : "unclear",
                        evidence: `Observed failure: ${secret} returned an empty response; ${observed}`,
                        publicSummary: `${verifies === 1 ? "sharedIdentifier" : "retryIdentifier"} returns an empty response for an invalid request; ${observed}`,
                      }
                    : c,
                ),
              },
            }
          : { structured: pass };
      }
      implementCalls++;
      if (implementCalls > 1) {
        for (const literal of observedLiterals) {
          expect(s.prompt).not.toContain(literal);
          expect(JSON.stringify(f.store.listEvents(runId))).not.toContain(literal);
          for (const artifact of f.store.listArtifacts(runId))
            expect(f.store.getArtifact(runId, artifact.name)).not.toContain(literal);
        }
        expect(s.prompt).toContain("5 private details withheld");
      }
      if (implementCalls === 2) {
        expect(s.prompt).toContain(
          "private scenario (unmet): sharedIdentifier returns an empty response for an invalid request",
        );
        expect(s.prompt).not.toContain("Observed failure");
        expect(s.prompt).not.toContain(secret);
        expect(s.prompt).not.toContain(privateHoldout.scenarios[1]?.steps);
        expect(f.store.getRunState<RunState>(runId)?.feedback).not.toContain(secret);
        expect(f.store.listArtifacts(runId).map((a) => a.name)).not.toContain("holdout-scenarios.json");
        expect(f.store.getArtifact(runId, "verify-0.json")).toContain("Observed failure");
        expect(f.store.getArtifact(runId, "verify-0.json")).not.toContain(secret);
        expect(JSON.stringify(f.store.listEvents(runId))).not.toContain("retryIdentifier");
        expect(existsSync(join(s.cwd, "holdout-scenarios.json"))).toBe(false);
        for (const artifact of f.store.listArtifacts(runId))
          expect(f.store.getArtifact(runId, artifact.name)).not.toContain(secret);
      }
      if (implementCalls === 3) {
        const summary = "retryIdentifier returns an empty response for an invalid request";
        expect(s.prompt).toContain(`private scenario (unclear): ${summary}`);
        expect(s.prompt).not.toContain("Observed failure");
        expect(s.prompt).not.toContain(secret);
        expect(s.prompt).not.toContain(privateHoldout.scenarios[1]?.steps);
        expect(f.store.getRunState<RunState>(runId)?.feedback).toContain(summary);
        expect(f.store.getArtifact(runId, "holdout-scenarios.json")).toBeNull();
        expect(f.store.getArtifact(runId, "verify-1.json")).toContain(summary);
        expect(f.store.getArtifact(runId, "verify-1.json")).not.toContain(secret);
        expect(JSON.stringify(f.store.listEvents(runId))).toContain(
          "ordinary verifier diagnostic; retryIdentifier; private input [private detail]",
        );
        retryFeedbackChecked = true;
      }
      return {
        files: {
          "farewell.txt": "goodbye\n",
          ...(implementCalls === 2 ? { "retry.ts": "export const retryIdentifier = true;\n" } : {}),
        },
      };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(3);
    expect(retryFeedbackChecked).toBe(true);
    expect(redactedOutputs[0]).toBe("[private detail] [private detail] [2 private details withheld]");
    expect(redactedOutputs[1]).toBe("retryIdentifier [private detail] [1 private details withheld]");
    expect(f.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
    expect(f.store.getArtifact(run.id, "verify-0.json")).toContain("ERR_RETRY_EXHAUSTED");
    const report = f.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain("## Holdout scenarios");
    expect(report).toContain("H-3");
    expect(
      renderReport({
        success: false,
        runId: run.id,
        prompt: run.prompt,
        state: f.store.getRunState<RunState>(run.id) as RunState,
        invocations: [],
        totals: { costUsd: 0, costEquivUsd: 0 },
        runUrl: "u",
      }),
    ).toContain("## Holdout scenarios");
    expect(JSON.stringify(f.store.listEvents(run.id))).not.toContain(secret);
    expect(JSON.stringify(f.store.listEvents(run.id))).toContain("ordinary verifier diagnostic");
    const firstVerify = f.store.listInvocations(run.id).find((inv) => inv.role === "verify");
    expect(firstVerify?.error).toContain("verifier diagnostic included");
    expect(firstVerify?.error).not.toContain(secret);
  });

  describe("unmet holdout classification", () => {
    const secret = "PRIVATE_SCENARIO_INPUT_314";
    const privateHoldout = {
      scenarios: holdout.scenarios.map((s) => (s.id === "H-2" ? { ...s, steps: `run ${secret}` } : s)),
    };
    const unmetH2 = (extra: Record<string, unknown>) => ({
      ...pass,
      criteria: pass.criteria.map((c) =>
        c.id === "H-2"
          ? {
              ...c,
              status: "unmet",
              evidence: `ran ${secret}: the file keeps a stale greeting line, violating "${extra.requirementCitation ?? ""}"`,
              publicSummary: "the file keeps a stale greeting line",
              ...extra,
            }
          : c,
      ),
    });
    const drive = (
      firstVerify: Record<string, unknown>,
      onImplement: (prompt: string, call: number) => void,
      publicSpec = spec,
    ) => {
      let verifies = 0;
      let implementCalls = 0;
      const handler: Handler = (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec")
          return { structured: { ...publicSpec, out_of_scope: ["Delete the old parser"] } };
        if (role === "holdout") return { structured: privateHoldout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          expect(s.prompt).toContain(
            "A citation must be either at least three consecutive words quoted exactly, or one whole line of the request (a sentence or bullet) or one whole acceptance criterion, exactly as shown",
          );
          return { structured: ++verifies === 1 ? firstVerify : pass };
        }
        onImplement(s.prompt, ++implementCalls);
        return { files: { "farewell.txt": "goodbye\n" } };
      };
      return { f: start(handler), handler, implementCalls: () => implementCalls, verifies: () => verifies };
    };

    test("a not_required holdout passes verify without another round and is a report follow-up", async () => {
      const { f, implementCalls, verifies } = drive(
        unmetH2({ requirement: "not_required", requirementCitation: "" }),
        () => {},
      );
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementCalls()).toBe(1);
      expect(verifies()).toBe(1);
      const report = f.store.getArtifact(run.id, "report.md") ?? "";
      expect(report).toContain("Holdouts not met: 0 blocking, 1 not required.");
      expect(report).toContain("**Holdout follow-ups**");
      expect(report).toContain("- H-2: missing input — ran");
      expect(report).toContain("unmet (not required)");
    });

    test.each([
      ["request", "Add a farewell file", "this requirement of the original request", ""],
      ["spec", "farewell.txt exists", "this requirement of the specification", ""],
      ["request", "Add a farewell file", "this requirement of the original request", "uncited evidence"],
      ["spec", "farewell.txt exists", "this requirement of the specification", "uncited evidence"],
    ])(
      "an unmet %s holdout fails verify and names the violated requirement",
      async (requirement, citation, source, evidence) => {
        let checked = false;
        const { f, implementCalls } = drive(
          unmetH2({ requirement, requirementCitation: citation, ...(evidence ? { evidence } : {}) }),
          (prompt, call) => {
            if (call !== 2) return;
            expect(prompt).toContain(`**H-2** violates ${source}: "${citation}"`);
            expect(prompt).toContain("Observed failure: the file keeps a stale greeting line");
            expect(prompt).not.toContain(secret);
            expect(prompt).not.toContain("missing input");
            expect(prompt).not.toContain("[private detail]");
            expect(prompt).not.toContain("Citation validation");
            checked = true;
          },
        );
        const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        expect(implementCalls()).toBe(2);
        expect(checked).toBe(true);
        const first = f.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
        expect(first?.notes.includes("evidence does not cite the requirement")).toBe(!!evidence);
      },
    );

    test.each([
      ["a fabricated citation", `run ${secret}`],
      ["a missing citation", ""],
      ["an out-of-scope citation", "Delete the old parser"],
    ])(
      "%s is not a failed invocation: the classification still blocks and the citation is withheld",
      async (_label, citation) => {
        let checked = false;
        const { f, implementCalls, verifies } = drive(
          unmetH2({ requirement: "spec", requirementCitation: citation }),
          (prompt, call) => {
            if (call !== 2) return;
            expect(prompt).toContain(
              "**H-2** violates a requirement of the specification (the verifier's citation was not found in it)",
            );
            expect(prompt).toContain("Observed failure: the file keeps a stale greeting line");
            expect(prompt).not.toContain(secret);
            expect(prompt).not.toContain("[private detail]");
            const feedback = prompt.split("### Checks not met")[1] ?? "";
            expect(feedback).not.toContain("Delete the old parser");
            expect(feedback).toContain("check them against the original request and specification above");
            checked = true;
          },
        );
        const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const invs = f.store.listInvocations(run.id).filter((i) => i.role === "verify");
        expect(invs.map((i) => i.status)).toEqual(["ok", "ok"]);
        expect(verifies()).toBe(2);
        expect(implementCalls()).toBe(2);
        expect(checked).toBe(true);
        const first = f.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
        expect(first?.overall).toBe("fail");
        expect(first?.criteria.find((c) => c.id === "H-2")?.requirement).toBe("spec");
        expect(first?.notes).toContain("requirement citation validation failed");
      },
    );

    test.each([
      ["Background\n\nOur service uses IPv4.\n\nRequirements\n\n- Support IPv6", "Background", false],
      ["Background\n\nOur service uses IPv4.\n\nRequirements\n\n- Support IPv6", "Requirements", false],
      ["Support IPv6\nKeep IPv4", "Support IPv6", true],
      ["Support IPv6\nKeep IPv4", "Keep IPv4", true],
      ["- Support IPv6", "Support IPv6", true],
      ["Support IPv6 and IPv4", "Support IPv6", false],
      ["Retry", "Retry", true],
      ["Add a farewell file", "**AC-1** Done", true],
    ] as const)("citation grounding in the fake pipeline: %s / %s", async (request, citation, grounded) => {
      let checked = false;
      const requirement = citation.startsWith("**AC-") ? "spec" : "request";
      const { f, implementCalls } = drive(
        unmetH2({ requirement, requirementCitation: citation }),
        (prompt, call) => {
          if (call !== 2) return;
          const feedback = prompt.split("### Checks not met")[1] ?? "";
          expect(feedback).not.toContain(secret);
          expect(feedback).not.toContain("missing input");
          if (grounded)
            expect(feedback).toContain(
              `violates this requirement of the ${requirement === "spec" ? "specification" : "original request"}:`,
            );
          else {
            expect(feedback).toContain("the verifier's attribution could not be validated");
            expect(feedback).not.toContain("the verifier's citation was not found in it");
            expect(feedback).toContain("check them against the original request and specification above");
          }
          checked = true;
        },
        {
          ...spec,
          acceptance_criteria: [{ id: "AC-1", criterion: "Done", how_to_verify: "cat farewell.txt" }],
        },
      );
      const run = await f.createRun({ repo: repoDir, prompt: request });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(checked).toBe(true);
      expect(implementCalls()).toBe(2);
      const first = f.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
      expect(first?.overall).toBe("fail");
      expect(first?.notes.includes("citation is not a stated public requirement")).toBe(!grounded);
    });

    test("an all-met verify with a non-enum requirement value succeeds instead of failing the invocation", async () => {
      const allMet = { ...pass, criteria: pass.criteria.map((c) => ({ ...c, requirement: "" })) };
      const { f, implementCalls, verifies } = drive(allMet, () => {});
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(
        f.store
          .listInvocations(run.id)
          .filter((i) => i.role === "verify")
          .map((i) => i.status),
      ).toEqual(["ok"]);
      expect(verifies()).toBe(1);
      expect(implementCalls()).toBe(1);
    });

    test("verifier output without a requirement field stays blocking on replay", async () => {
      let checked = false;
      const { f, handler, implementCalls, verifies } = drive(unmetH2({}), (prompt, call) => {
        if (call !== 2) return;
        expect(prompt).toContain("private scenario (unmet): the file keeps a stale greeting line");
        expect(prompt).not.toContain(secret);
        checked = true;
      });
      f.deps.faults = {
        "stage:verify:after": {
          action: "kill",
          onHit: ({ runId }) => {
            const state = f.store.getRunState<RunState>(runId);
            const stored = state?.verifyResults?.[0];
            if (!state || !stored) throw new Error("missing stored verification");
            for (const c of stored.criteria) {
              delete c.requirement;
              delete c.requirementCitation;
            }
            stored.overall = "pass"; // Replay must recompute even a stale model-supplied verdict.
            f.store.setRunState(runId, state);
          },
        },
      };
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      const deadline = Date.now() + 10_000;
      while (f.store.listStages(run.id).at(-1)?.status !== "cancelled") {
        if (Date.now() > deadline) throw new Error("verify interruption timed out");
        await Bun.sleep(10);
      }
      await f.stop();
      f.store.close();
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementCalls()).toBe(2);
      expect(checked).toBe(true);
      expect(verifies()).toBe(2);
      const first = resumed.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
      expect(first?.overall).toBe("fail");
      expect(first?.criteria.find((c) => c.id === "H-2")?.requirement).toBeNull();
    });
  });

  test("needs-human delivery includes failed holdouts and restores full verify evidence", async () => {
    const secret = "PRIVATE_FAILURE_CASE_872";
    const privateHoldout = {
      scenarios: holdout.scenarios.map((scenario) =>
        scenario.id === "H-2" ? { ...scenario, steps: `run ${secret}` } : scenario,
      ),
    };
    const failedVerify = {
      ...pass,
      criteria: pass.criteria.map((criterion) =>
        criterion.id === "H-2"
          ? {
              ...criterion,
              status: "unmet",
              evidence: `Observed empty output for ${secret}`,
              publicSummary: "",
            }
          : criterion,
      ),
    };
    let runId = "";
    let preDeliveryChecked = false;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: privateHoldout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: failedVerify };
      if (runId && !preDeliveryChecked && f.store.getRunState<RunState>(runId)?.round) {
        preDeliveryChecked = true;
        expect(f.store.getArtifact(runId, "holdout-scenarios.json")).toBeNull();
        expect(f.store.getArtifact(runId, "verify-0.json")).not.toContain(secret);
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(preDeliveryChecked).toBe(true);
    expect(f.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
    expect(f.store.getArtifact(run.id, "verify-0.json")).toContain(secret);
    const report = f.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain("## Holdout scenarios");
    expect(report).toContain("H-2");
    expect(report).toContain(`Observed empty output for ${secret}`);
  });

  test("pre-delivery verify artifacts preserve public evidence and redact private rows on retry", async () => {
    const privateLiterals = [
      "privateDescriptionToken_731",
      "privateStepsToken_732",
      "privateExpectedToken_733",
      "privateEvidenceToken_734",
      "privateSummaryToken_735",
      "privateNotesToken_736",
      "unknownRowToken_737",
      "retryPrivateEvidenceToken_739",
    ];
    const [description, steps, expected, evidence, summary, notes, unknown, retryEvidence] = privateLiterals;
    if (!description || !steps || !expected || !evidence || !summary || !notes || !unknown || !retryEvidence)
      throw new Error("missing private test literals");
    const privateHoldout = {
      scenarios: holdout.scenarios.map((scenario, index) => ({
        ...scenario,
        description: `Scenario ${description} ${index}`,
        steps: `Run ${steps} ${index}`,
        expected: `Returns ${expected} ${index}`,
      })),
    };
    const publicEvidence = "src/pipeline/engine.ts:742 publicIdentifier_738 is handled";
    const retryPublicEvidence = "src/pipeline/verification.ts:42 retryIdentifier_740 is handled";
    const privateEvidence = `Observed ${description} ${steps} ${expected} ${evidence}`;
    const retryPrivateEvidence = `Retry observed ${description} ${steps} ${expected} ${retryEvidence}`;
    let verifies = 0;
    let implementations = 0;
    let runId = "";
    const checkArtifact = (
      name: string,
      expectedPublicStatus: string,
      expectedPrivateStatus: string,
      expectedPublicEvidence: string,
    ) => {
      const raw = f.store.getArtifact(runId, name);
      expect(raw).not.toBeNull();
      const artifact = JSON.parse(raw as string) as typeof pass;
      const publicRow = artifact.criteria.find((criterion) => criterion.id === "AC-1");
      expect(publicRow?.status).toBe(expectedPublicStatus);
      expect(publicRow?.evidence).toBe(expectedPublicEvidence);
      for (const id of ["H-1", "H-2", "H-3", "X-9"]) {
        const row = artifact.criteria.find((criterion) => criterion.id === id);
        expect(row?.id).toBe(id);
        expect(row?.status).toBe(id === "H-1" ? expectedPrivateStatus : "met");
        expect(row?.evidence).toContain("[private detail]");
      }
      expect(artifact.criteria.find((criterion) => criterion.id === "H-1")?.publicSummary).toContain(
        "Observed behavior",
      );
      expect(artifact.criteria.find((criterion) => criterion.id === "H-1")?.publicSummary).toContain(
        "[private detail]",
      );
      expect(artifact.criteria.find((criterion) => criterion.id === "H-2")?.publicSummary).toBe("");
      expect(artifact.criteria.find((criterion) => criterion.id === "H-3")?.publicSummary).not.toContain(
        summary,
      );
      for (const literal of privateLiterals) expect(raw).not.toContain(literal);
      expect(raw).not.toContain(`Scenario ${description}`);
      expect(raw).not.toContain(`Run ${steps}`);
      expect(raw).not.toContain(`Returns ${expected}`);
    };
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: privateHoldout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        verifies++;
        if (verifies === 2) checkArtifact("verify-0.json", "blocked", "met", publicEvidence);
        return {
          structured: {
            ...pass,
            notes: `Verifier notes ${notes}`,
            criteria: [
              {
                id: "AC-1",
                status: verifies === 1 ? "blocked" : "met",
                evidence: verifies === 1 ? publicEvidence : retryPublicEvidence,
                publicSummary: "",
              },
              {
                id: "H-1",
                status: verifies === 2 ? "unmet" : "met",
                evidence: verifies === 1 ? privateEvidence : retryPrivateEvidence,
                publicSummary: `Observed behavior ${summary}`,
              },
              {
                id: "H-2",
                status: "met",
                evidence: verifies === 1 ? privateEvidence : retryPrivateEvidence,
                publicSummary: "",
              },
              {
                id: "H-3",
                status: "met",
                evidence: verifies === 1 ? privateEvidence : retryPrivateEvidence,
                publicSummary: summary,
              },
              { id: "X-9", status: "met", evidence: `Extra ${unknown}`, publicSummary: "" },
            ],
          },
        };
      }
      implementations++;
      if (implementations === 2) checkArtifact("verify-0-retry.json", "met", "unmet", retryPublicEvidence);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(verifies).toBe(3);
    expect(implementations).toBe(2);
  });

  test("completed holdout survives a stopped factory and is reused after restart", async () => {
    const secret = "OLD_FORMAT_PRIVATE_STEP_518";
    // Persisted under the former 3–8 scenario, two-edge-case schema.
    const oldHoldout = {
      scenarios: holdout.scenarios.map((s) => (s.id === "H-2" ? { ...s, steps: `run ${secret}` } : s)),
    };
    let holdoutCalls = 0;
    let implementations = 0;
    let blockImplement = true;
    let runId = "";
    let restarted: Factory | null = null;
    let privacyChecked = false;
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCalls++;
        return { structured: holdout };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        expect(s.prompt).toContain("H-3");
        expect(s.prompt).toContain(secret);
        return { structured: pass };
      }
      implementations++;
      if (restarted) {
        const store = restarted.store;
        expect(s.prompt).not.toContain(secret);
        expect(existsSync(join(s.cwd, "holdout-scenarios.json"))).toBe(false);
        expect(store.getArtifact(runId, "holdout-scenarios.json")).toBeNull();
        for (const artifact of store.listArtifacts(runId))
          expect(store.getArtifact(runId, artifact.name)).not.toContain(secret);
        expect(JSON.stringify(store.listEvents(runId))).not.toContain(secret);
        privacyChecked = true;
      }
      return blockImplement ? { delayMs: 30_000 } : { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.holdoutStatus !== "complete" ||
        f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("complete");
    f.scheduler.drain();
    expect(f.scheduler.activeRunIds).toEqual([run.id]);
    // Simulate a deploy deadline expiring while implement is still in flight.
    await f.stop();
    expect(f.store.getRun(run.id)?.status).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.implementedRound).toBeUndefined();
    expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.status).toBe("cancelled");
    const stopped = f.store.getRunState<RunState>(run.id);
    f.store.setRunState(run.id, { ...stopped, holdout: oldHoldout });
    f.store.close();
    blockImplement = false;
    restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(1);
    expect(implementations).toBe(2);
    expect(privacyChecked).toBe(true);
    expect(restarted.store.getRunState<RunState>(run.id)?.holdout?.scenarios).toEqual(oldHoldout.scenarios);
    expect(restarted.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
  });

  test("interrupted holdout is retried after restart and remains unpublished while stopped", async () => {
    let holdoutCalls = 0;
    let slow = true;
    const holdoutCwds: string[] = [];
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCalls++;
        holdoutCwds.push(s.cwd);
        return slow ? { structured: holdout, delayMs: 30_000 } : { structured: holdout };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.holdoutStatus !== "generating" || !holdoutCwds.length) &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("generating");
    await f.stop();
    // Cancellation removes the snapshot but leaves the implementer's worktree for the restart.
    expect(holdoutCwds).toHaveLength(1);
    expect(existsSync(holdoutCwds[0] ?? "")).toBe(false);
    const worktree = f.store.getRunState<RunState>(run.id)?.worktreePath ?? "";
    expect(existsSync(join(worktree, "greeting.txt"))).toBe(true);
    expect(f.store.listArtifacts(run.id).map((a) => a.name)).not.toContain("holdout-scenarios.json");
    f.store.close();
    slow = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(2);
    expect(holdoutCwds[1]).not.toBe(holdoutCwds[0]);
    expect(existsSync(holdoutCwds[1] ?? "")).toBe(false);
    expect(restarted.store.getArtifact(run.id, "holdout-scenarios.json")).toContain("H-3");
  });

  test("failed holdout removes its base snapshot and keeps the run worktree", async () => {
    const holdoutCwds: string[] = [];
    let runId = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCwds.push(s.cwd);
        return { fault: "throw", error: "holdout exploded" };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    const deadline = Date.now() + 10_000;
    while (f.store.listStages(runId).find((s) => s.name === "holdout")?.status !== "failed") {
      if (Date.now() > deadline) throw new Error("holdout failure timed out");
      await Bun.sleep(10);
    }
    expect(holdoutCwds.length).toBeGreaterThan(0);
    for (const cwd of holdoutCwds) expect(existsSync(cwd)).toBe(false);
    const worktree = f.store.getRunState<RunState>(runId)?.worktreePath ?? "";
    expect(worktree).not.toBe("");
    expect(existsSync(join(worktree, "greeting.txt"))).toBe(true);
    expect(f.store.getRunState<RunState>(runId)?.holdout).toBeUndefined();
  });

  test("holdout uses same-vendor fallback and invalid output routes to another model", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout" && s.target.provider === "beta") return { structured: { scenarios: [] } };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "holdout")
        .map((i) => i.status),
    ).toEqual(["error", "ok"]);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutSameVendor).toBe(true);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutModelId).toBe("alpha/m");
  });

  test("degenerate review is a failed invocation and the next routed reviewer completes the stage", async () => {
    let implementCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review")
        return {
          structured:
            s.target.provider === "beta" ? { verdict: "approve", summary: "test", findings: [] } : approve,
        };
      if (role === "verify") return { structured: pass };
      implementCalls++;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const reviews = f.store.listInvocations(run.id).filter((i) => i.role === "review");
    expect(reviews.map((i) => [i.modelId, i.status])).toEqual([
      ["beta/m", "error"],
      ["alpha/m", "ok"],
    ]);
    expect(reviews[0]?.error).toContain("structured output failed validation");
    expect(reviews[0]?.stageId).toBe(reviews[1]?.stageId);
    expect(f.store.listStages(run.id).filter((s) => s.name === "review")).toHaveLength(1);
    expect(implementCalls).toBe(1);
    const artifact = JSON.parse(f.store.getArtifact(run.id, "review-0.json") ?? "{}");
    expect(artifact).toMatchObject({ model: "alpha/m", summary: approve.summary });
    expect(f.store.listArtifacts(run.id).filter((a) => a.name.startsWith("review-"))).toHaveLength(1);
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.reviewHistory).toHaveLength(1);
    expect(state?.lastReview?.modelId).toBe("alpha/m");
  });

  test("degenerate review from every routed reviewer fails the stage without an approval", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review")
        return { structured: { verdict: "approve", summary: "   LGTM   ", findings: [] } };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    const reviews = f.store.listInvocations(run.id).filter((i) => i.role === "review");
    expect(reviews.map((i) => [i.modelId, i.status])).toEqual([
      ["beta/m", "error"],
      ["alpha/m", "error"],
    ]);
    expect(f.store.listStages(run.id).find((s) => s.name === "review")?.status).toBe("failed");
    expect(f.store.listArtifacts(run.id).some((a) => a.name.startsWith("review-"))).toBe(false);
    expect(f.store.getRunState<RunState>(run.id)?.lastReview).toBeUndefined();
    expect(f.store.listStages(run.id).some((s) => s.name === "verify" || s.name === "deliver")).toBe(false);
  });

  test("later-round review accepts a short fix confirmation but still rejects a placeholder", async () => {
    let implementCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        if (!s.prompt.includes("# Previous review"))
          return {
            structured: {
              verdict: "request_changes",
              summary: "wrong text",
              findings: [
                {
                  severity: "blocker",
                  security: false,
                  ...findingEvidence,
                  file: "farewell.txt",
                  line: 1,
                  title: "Wrong text",
                  detail: "Say goodbye",
                  suggestion: "Write goodbye",
                },
              ],
            },
          };
        return {
          structured: {
            verdict: "approve",
            summary: s.target.provider === "beta" ? "test" : "P1 fixed; no regressions found.",
            findings: [],
          },
        };
      }
      implementCalls++;
      return { files: { "farewell.txt": implementCalls === 1 ? "bye\n" : "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const reviews = f.store.listInvocations(run.id).filter((i) => i.role === "review");
    expect(reviews.map((i) => [i.modelId, i.status])).toEqual([
      ["beta/m", "ok"],
      ["beta/m", "error"],
      ["alpha/m", "ok"],
    ]);
    expect(reviews[1]?.error).toContain("at least 12 characters");
    expect(implementCalls).toBe(2);
    expect(JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}")).toMatchObject({
      model: "alpha/m",
      verdict: "approve",
      summary: "P1 fixed; no regressions found.",
    });
  });

  test("missing holdout verdict fails despite an overall pass claim", async () => {
    let verifyCalls = 0;
    let implementCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        verifyCalls++;
        return {
          structured:
            verifyCalls === 1 ? { ...pass, criteria: pass.criteria.filter((c) => c.id !== "H-3") } : pass,
        };
      }
      implementCalls++;
      if (implementCalls === 2) {
        expect(s.prompt).toContain("H-3");
        expect(f.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBeUndefined();
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(2);
    expect(verifyCalls).toBe(2);
  });

  async function previewFixture(): Promise<void> {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]
checks = [{ name = "no-bad", run = "! grep -rq BAD --include=*.txt ." }]
[preview]
paths = ["ui/"]
build = "echo build >> '${join(home, "preview-steps")}'"
seed = 'echo seed >> "${join(home, "preview-steps")}"; mkdir -p "$LIMITLESS_HOME" && echo seeded > "$LIMITLESS_HOME/seed.txt"'
serve = "echo serve >> '${join(home, "preview-steps")}'; bun serve.ts"
ready = "/health"
env = { LIMITLESS_HOME = "{scratch}/home", LIMITLESS_CONFIG_DIR = "{scratch}/config", LIMITLESS_PORT = "{port}" }
`,
    );
    writeFileSync(
      join(repoDir, "serve.ts"),
      'Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.LIMITLESS_PORT), fetch: async () => new Response(await Bun.file(process.env.LIMITLESS_HOME + "/seed.txt").text(), {headers: {"x-scratch": process.env.HOME ?? ""}}) });',
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "preview fixture"], {
      cwd: repoDir,
    });
  }

  test.each(["pass", "unmet", "error", "legacy"] as const)(
    "base preview survives config edits and cleans up after verify %s",
    async (outcome) => {
      await previewFixture();
      let runId = "";
      const previews: { url: string; scratch: string }[] = [];
      const assertStopped = async () => {
        for (const { url, scratch } of previews) {
          expect(existsSync(scratch)).toBe(false);
          await expect(fetch(`${url}/health`)).rejects.toThrow();
        }
      };
      const handler: Handler = async (agent) => {
        const role = roleOf(agent);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          const stage = factory?.store
            .getRunDetail(runId)
            ?.stages.filter((entry) => entry.name === "preview")
            .at(-1);
          expect(stage?.status).toBe("succeeded");
          const url = stage?.summary?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
          const response = await fetch(`${url}/health`);
          expect(await response.text()).toBe("seeded\n");
          const scratch = response.headers.get("x-scratch") ?? "";
          expect(existsSync(scratch)).toBe(true);
          previews.push({ url, scratch });
          if (outcome === "error") throw new Error("injected verifier failure");
          if (outcome === "unmet" && previews.length === 1)
            return {
              structured: {
                ...pass,
                overall: "fail",
                criteria: pass.criteria.map((c) => (c.id === "AC-1" ? { ...c, status: "unmet" } : c)),
              },
            };
          return { structured: pass };
        }
        await assertStopped();
        return {
          files: {
            "ui/change.txt": `visible ${previews.length}\n`,
            // Removing the table must not disable the trusted base preview.
            ".limitless.toml":
              readFileSync(join(repoDir, ".limitless.toml"), "utf8").split("[preview]")[0] ?? "",
          },
        };
      };
      const f = start(handler);
      const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        outcome === "error" ? "needs_human" : "succeeded",
      );
      expect(previews.length).toBeGreaterThan(0);
      await assertStopped();
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.previewConfig?.paths).toEqual(["ui/"]);
      if (outcome === "unmet") expect(previews).toHaveLength(2);
      if ((outcome !== "pass" && outcome !== "legacy") || !state) return;
      // Replay the persisted round after its verdict was saved, before phase advancement.
      const steps = readFileSync(join(home, "preview-steps"), "utf8");
      expect(steps).toBe("build\nseed\nserve\n");
      await f.stop();
      // Simulate an older run: restore the enabled config from base despite its removal in HEAD.
      if (outcome === "legacy") delete state.previewConfig;
      f.store.setRunState(run.id, { ...state, phase: "loop" });
      f.store.updateRun(run.id, { status: "queued", finishedAt: null });
      f.store.close();
      factory = null;
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(resumed.store.getRunState<RunState>(run.id)?.previewConfig?.paths).toEqual(["ui/"]);
      expect(previews).toHaveLength(1);
      expect(readFileSync(join(home, "preview-steps"), "utf8")).toBe(steps);
      expect(
        resumed.store.getRunDetail(run.id)?.stages.filter((entry) => entry.name === "preview"),
      ).toHaveLength(1);
    },
  );

  test.each([
    "paths = []",
    'paths = ["ui/"]\nbuild="true"\nserve="true"\nready="/health"\nenv={HOME="{scratch}/../escape"}',
    'paths = ["ui/"]\nbuild="true"\nserve="true"\nready=\'/\\evil.example/x\'\nenv={}',
  ])("invalid base preview fails prepare without model spend: %s", async (invalid) => {
    writeFileSync(join(repoDir, ".limitless.toml"), `[preview]\n${invalid}\n`);
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "invalid preview"], {
      cwd: repoDir,
    });
    let calls = 0;
    const f = start(() => {
      calls++;
      return {};
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
    expect(await waitFor(f, run.id, ["failed", "succeeded", "needs_human"])).toBe("failed");
    expect(calls).toBe(0);
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
    expect(f.store.getRun(run.id)?.error).toContain("Invalid [preview]");
    expect(f.store.getRunDetail(run.id)?.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ["prepare", "failed"],
    ]);
  });

  test.each(["missing base SHA", "missing worktree", "invalid base preview"])(
    "legacy preview backfill fails before model calls: %s",
    async (problem) => {
      if (problem === "invalid base preview") {
        writeFileSync(join(repoDir, ".limitless.toml"), "[preview]\npaths=[]\n");
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "invalid preview"], {
          cwd: repoDir,
        });
        // A repaired worktree must not hide an invalid trusted base.
        writeFileSync(join(repoDir, ".limitless.toml"), "");
      }
      let calls = 0;
      const f = start(() => {
        calls++;
        return {};
      });
      await f.stop();
      const run = await f.createRun({ repo: repoDir, prompt: "Resume an older run" });
      const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      if (problem !== "missing base SHA") f.store.updateRun(run.id, { baseSha });
      const state: RunState = {
        phase: "triage",
        worktreePath: problem === "missing worktree" ? undefined : repoDir,
        answers: [],
        round: 0,
        roundsOnImplementer: 0,
        triedImplementers: [],
        feedback: null,
        toolCommands: [],
      };
      f.store.setRunState(run.id, state);
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("failed");
      expect(calls).toBe(0);
      expect(f.store.listInvocations(run.id)).toHaveLength(0);
      expect(f.store.getRun(run.id)?.error).toContain(
        problem === "invalid base preview" ? "Invalid [preview]" : "missing base SHA or worktree",
      );
      expect(f.store.getRunState<RunState>(run.id)?.previewConfig).toBeUndefined();
    },
  );

  test.each(["gates only", "no config file"])("legacy resume backfills absent preview: %s", async (base) => {
    const baseConfig = base === "gates only" ? readFileSync(join(repoDir, ".limitless.toml"), "utf8") : "";
    if (base === "no config file") {
      await sh(["git", "rm", ".limitless.toml"], { cwd: repoDir });
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remove config"], {
        cwd: repoDir,
      });
    }
    const calls: string[] = [];
    let resumedRunId: string | undefined;
    const handler: Handler = (agent) => {
      if (resumedRunId) expect(factory?.store.getRunState<RunState>(resumedRunId)?.previewConfig).toBeNull();
      const role = roleOf(agent);
      calls.push(role);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return {
        files: {
          "ui/change.txt": "visible\n",
          ".limitless.toml": `${baseConfig}\n[preview]\npaths=[]\n`,
        },
      };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.previewConfig).toBeNull();
    expect(f.store.getRunDetail(run.id)?.stages.some((stage) => stage.name === "preview")).toBe(false);
    if (!state) throw new Error("Missing state");
    await f.stop();
    delete state.previewConfig;
    state.phase = "loop";
    f.store.setRunState(run.id, state);
    f.store.updateRun(run.id, { status: "queued", finishedAt: null });
    f.store.close();
    factory = null;
    const before = calls.length;
    resumedRunId = run.id;
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(calls.slice(before)).toEqual(["review"]);
    expect(resumed.store.getRunState<RunState>(run.id)?.previewConfig).toBeNull();
    expect(resumed.store.getRunDetail(run.id)?.stages.some((stage) => stage.name === "preview")).toBe(false);
  });

  test("happy path: triage → spec → implement → gates → review → verify → deliver", async () => {
    const seen: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      seen.push(`${role}:${s.target.modelId}`);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" }, text: "Added farewell.txt" };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");

    const detail = f.store.getRunDetail(run.id);
    expect(detail?.run.title).toBe("Add farewell");
    expect(detail?.run.resolvedProfile).toBe("standard");
    expect(detail?.stages.map((s) => s.name)).toEqual([
      "prepare",
      "triage",
      "spec",
      "holdout",
      "implement",
      "gates",
      "audit",
      "review",
      "verify",
      "deliver",
    ]);
    // Review and verify ran on a different vendor than the implementer.
    const impl = seen.find((s) => s.startsWith("implement"));
    const review = seen.find((s) => s.startsWith("review"));
    expect(impl?.split(":")[1]).not.toBe(review?.split(":")[1]);
    // Work landed on the branch in the local repo.
    const branch = detail?.run.branch as string;
    const show = await sh(["git", "show", `${branch}:farewell.txt`], { cwd: repoDir });
    expect(show.stdout).toBe("goodbye\n");
    expect(f.store.getArtifact(run.id, "report.md")).toContain("AC-1");
    expect(f.store.getArtifact(run.id, "diff.patch")).toContain("+goodbye");
  });

  test("regressing a gate sends feedback and the next round fixes it", async () => {
    let implementCalls = 0;
    let secondPrompt = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      implementCalls++;
      if (implementCalls === 1) return { files: { "farewell.txt": "BAD goodbye\n" } };
      secondPrompt = s.prompt;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(2);
    expect(secondPrompt).toContain("Check `no-bad` now FAILS");
    const gates = f.store.listStages(run.id).filter((s) => s.name === "gates");
    expect(gates.map((g) => g.summary)).toEqual(["blocking: no-bad", "1 checks ok"]);
  });

  test("review blockers loop back to the implementer", async () => {
    let reviews = 0;
    let implementPrompts: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        return reviews === 1
          ? {
              structured: {
                verdict: "request_changes",
                summary: "missing newline handling",
                findings: [
                  {
                    severity: "blocker",
                    security: false,
                    ...findingEvidence,
                    file: "farewell.txt",
                    line: 1,
                    title: "Wrong text",
                    detail: "Say goodbye politely",
                    suggestion: "Use 'goodbye, friend'",
                  },
                ],
              },
            }
          : { structured: approve };
      }
      implementPrompts = [...implementPrompts, s.prompt];
      return { files: { "farewell.txt": `goodbye${implementPrompts.length}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(reviews).toBe(2);
    expect(implementPrompts[1]).toContain("Wrong text");
  });

  test("later reviews compare the previous commit and keep new major findings as follow-ups", async () => {
    const prompts: string[] = [];
    const implementPrompts: string[] = [];
    const finding = (title: string, label?: "unaddressed" | "regression" | "new") => ({
      severity: "major",
      security: false,
      ...findingEvidence,
      ...(label ? { label, prior: label === "unaddressed" ? "P1" : "" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: title,
      suggestion: "Fix it",
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        prompts.push(s.prompt);
        return {
          structured:
            prompts.length === 1
              ? { verdict: "approve", summary: "first", findings: [finding("Prior bug")] }
              : prompts.length === 2
                ? { verdict: "approve", summary: "second", findings: [finding("Prior bug", "unaddressed")] }
                : {
                    verdict: "request_changes",
                    summary: "follow up",
                    findings: [finding("Later edge case", "new")],
                  },
        };
      }
      implementPrompts.push(s.prompt);
      return { files: { "farewell.txt": `goodbye ${implementPrompts.length}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementPrompts).toHaveLength(3);
    expect(implementPrompts[1]).toContain("Prior bug");
    type Stored = { verdict: string; modelVerdict: string };
    const first = JSON.parse(f.store.getArtifact(run.id, "review-0.json") ?? "{}") as Stored;
    const third = JSON.parse(f.store.getArtifact(run.id, "review-2.json") ?? "{}") as Stored;
    expect(first).toMatchObject({ verdict: "request_changes", modelVerdict: "approve" });
    expect(third).toMatchObject({ verdict: "approve", modelVerdict: "request_changes" });
    expect(prompts[1]).toContain("Prior bug");
    const reviewed = prompts[1]?.match(/Reviewed commit: ([a-f0-9]{40})\. Current HEAD: ([a-f0-9]{40})/);
    expect(reviewed).not.toBeNull();
    expect(reviewed?.[1]).not.toBe(reviewed?.[2]);
    expect(prompts[1]).toContain(`git diff ${reviewed?.[1]}..${reviewed?.[2]}`);
    expect(prompts[1]).toContain("git diff ");
    expect(prompts[1]).toContain("latest-change diff");
    expect(f.store.getArtifact(run.id, "report.md")).toContain(
      "## Review follow-ups\n\n- major: `farewell.txt:1` Later edge case",
    );
  });

  test("later-round prompts list previous findings without the v2 evidence fields", async () => {
    const prompts: string[] = [];
    const prior = { severity: "major", security: false, file: "farewell.txt", line: 1, title: "Prior bug" };
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        prompts.push(s.prompt);
        const findings = [{ ...prior, ...findingEvidence, detail: "Wrong", suggestion: "Fix it" }];
        return { structured: prompts.length === 1 ? { ...approve, findings } : approve };
      }
      return { files: { "farewell.txt": `goodbye ${prompts.length}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    // The fresh round-1 finding keeps its v2 fields in run state; only the prompt drops them.
    const history = f.store.getRunState<RunState>(run.id)?.reviewHistory;
    expect(history?.[0]?.blocking).toMatchObject([findingEvidence]);
    const previous = prompts[1]?.match(/Previous blocking findings[^\n]*\n```\n([\s\S]*?)\n```/)?.[1];
    expect(JSON.parse(previous ?? "null")).toEqual([
      { id: "P1", ...prior, detail: "Wrong", suggestion: "Fix it" },
    ]);
    for (const field of Object.keys(findingEvidence)) expect(prompts[1]).not.toContain(`"${field}"`);
  });

  for (const [label, laterTitle] of [
    ["unaddressed", "Prior bug"],
    ["unaddressed", "Prior bug still unfixed"],
    ["regression", "Still broken"],
  ] as const) {
    test(`${label} later finding (${laterTitle}) sends only blocking feedback to implementation`, async () => {
      let reviews = 0;
      const prompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          reviews++;
          const title = reviews === 1 ? "Prior bug" : laterTitle;
          return {
            structured:
              reviews < 3
                ? {
                    verdict: "approve",
                    summary: "review",
                    findings: [
                      {
                        severity: reviews === 2 ? "minor" : "major",
                        security: false,
                        ...findingEvidence,
                        ...(reviews === 2 ? { label, prior: label === "unaddressed" ? "P1" : "" } : {}),
                        file: "farewell.txt",
                        line: 1,
                        title,
                        detail: title,
                        suggestion: "Fix it",
                      },
                      ...(reviews === 2
                        ? [
                            {
                              severity: "minor",
                              security: false,
                              ...findingEvidence,
                              label: "new",
                              prior: "",
                              file: "farewell.txt",
                              line: 1,
                              title: "Future cleanup",
                              detail: "Optional",
                              suggestion: "Later",
                            },
                          ]
                        : []),
                    ],
                  }
                : { ...approve, verdict: "request_changes" },
          };
        }
        prompts.push(s.prompt);
        return { files: { "farewell.txt": `goodbye ${prompts.length}\n` } };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(prompts).toHaveLength(3);
      expect(prompts[2]).toContain(laterTitle);
      expect(prompts[2]).not.toContain("Future cleanup");
      expect(JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}")).toMatchObject({
        verdict: "request_changes",
        modelVerdict: "approve",
      });
      expect(f.store.getArtifact(run.id, "report.md")).toContain("Future cleanup");
    });
  }

  test("a new security finding blocks even at minor severity", async () => {
    let implementsCount = 0;
    let reviews = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        return {
          structured:
            reviews === 1
              ? {
                  verdict: "approve",
                  summary: "initial",
                  findings: [
                    {
                      severity: "major",
                      security: false,
                      ...findingEvidence,
                      file: "farewell.txt",
                      line: 1,
                      title: "Prior bug",
                      detail: "bug",
                      suggestion: "fix",
                    },
                  ],
                }
              : reviews === 2
                ? {
                    verdict: "approve",
                    summary: "security",
                    findings: [
                      {
                        severity: "minor",
                        security: true,
                        ...findingEvidence,
                        label: "new",
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Secret leak",
                        detail: "leak",
                        suggestion: "fix",
                      },
                    ],
                  }
                : approve,
        };
      }
      implementsCount++;
      if (implementsCount === 3) expect(s.prompt).toContain("Secret leak");
      return { files: { "farewell.txt": `goodbye ${implementsCount}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementsCount).toBe(3);
    expect(f.store.getArtifact(run.id, "review-1.json")).toContain('"verdict": "request_changes"');
  });

  test("review context and follow-ups survive a factory restart", async () => {
    let reviews = 0;
    let implementsCount = 0;
    let slow = true;
    const prompts: string[] = [];
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        prompts.push(s.prompt);
        if (reviews > 3) return { structured: approve };
        return {
          structured:
            reviews === 1
              ? {
                  ...approve,
                  findings: [
                    {
                      severity: "major",
                      security: false,
                      ...findingEvidence,
                      file: "farewell.txt",
                      line: 1,
                      title: "Prior bug",
                      detail: "bug",
                      suggestion: "fix",
                    },
                  ],
                }
              : reviews === 2
                ? {
                    ...approve,
                    findings: [
                      {
                        severity: "minor",
                        security: false,
                        ...findingEvidence,
                        label: "regression",
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Regression",
                        detail: "regressed",
                        suggestion: "fix",
                      },
                      {
                        severity: "major",
                        security: false,
                        ...findingEvidence,
                        label: "new",
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Backlog idea",
                        detail: "later",
                        suggestion: "later",
                      },
                    ],
                  }
                : {
                    ...approve,
                    findings: [
                      {
                        severity: "major",
                        security: false,
                        ...findingEvidence,
                        label: "unaddressed",
                        // Cites no previous blocking finding: a relabelled follow-up can't become mandatory.
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Backlog idea",
                        detail: "later",
                        suggestion: "later",
                      },
                    ],
                  },
        };
      }
      implementsCount++;
      return slow && implementsCount === 3
        ? { delayMs: 30_000 }
        : { files: { "farewell.txt": `goodbye ${implementsCount}\n` } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.round !== 2 || f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    const before = f.store.getRunState<RunState>(run.id);
    expect(before?.reviewedSha).toMatch(/^[a-f0-9]{40}$/);
    expect(before?.lastReview?.findings[0]?.title).toBe("Regression");
    expect(before?.reviewFollowUps?.[0]?.title).toBe("Backlog idea");
    await f.stop();
    f.store.close();
    slow = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(prompts[2]).toContain(before?.reviewedSha ?? "missing SHA");
    expect(prompts[2]).toContain("Regression");
    expect(prompts[2]).not.toContain("Backlog idea");
    expect(implementsCount).toBe(4); // Includes the interrupted implementation; the follow-up stays one.
    expect(restarted.store.getArtifact(run.id, "review-2.json")).toContain('"verdict": "approve"');
    expect(restarted.store.getRunState<RunState>(run.id)?.reviewFollowUps).toHaveLength(1);
    expect(restarted.store.getArtifact(run.id, "report.md")).toContain("Backlog idea");
  });

  for (const restartRound of [0, 1]) {
    test(`restart during verify preserves review policy and keeps round ${restartRound} follow-ups`, async () => {
      let implementations = 0;
      let slow = true;
      let verifyStarted = false;
      let resumedVerifies = 0;
      const prompts: string[] = [];
      const finding = (title: string, label = "new") => ({
        severity: "major",
        security: false,
        ...findingEvidence,
        label,
        prior: "",
        file: "farewell.txt",
        line: 1,
        title,
        detail: title,
        suggestion: "Fix",
      });
      const handler: Handler = (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          prompts.push(s.prompt);
          const findings =
            restartRound === 0
              ? prompts.length === 2
                ? [finding("New major on replay")]
                : []
              : prompts.length === 1
                ? [finding("Initial blocker")]
                : [finding("Backlog idea"), ...(slow ? [finding("Obsolete follow-up")] : [])];
          return { structured: { ...approve, findings } };
        }
        if (role === "verify") {
          verifyStarted = true;
          if (slow) return { delayMs: 30_000 };
          resumedVerifies++;
          return {
            structured:
              restartRound === 1 && resumedVerifies === 1
                ? {
                    ...pass,
                    criteria: pass.criteria.map((c) => (c.id === "AC-1" ? { ...c, status: "unmet" } : c)),
                  }
                : pass,
          };
        }
        implementations++;
        return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
      };
      const f = start(handler);
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
      const deadline = Date.now() + 10_000;
      while (!verifyStarted && Date.now() < deadline) await Bun.sleep(10);
      expect(verifyStarted).toBe(true);
      expect(f.store.getRun(run.id)?.stage).toBe("verify");
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint?.round).toBe(restartRound);
      expect(checkpoint?.reviewHistory?.at(-1)?.round).toBe(restartRound);
      await f.stop();
      f.store.close();
      slow = false;
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      // A restart resumes verification; completed reviews and their findings remain durable.
      expect(prompts).toHaveLength(restartRound === 0 ? 1 : 3);
      const state = resumed.store.getRunState<RunState>(run.id);
      expect(state?.reviewHistory?.slice(0, restartRound + 1)).toEqual(checkpoint?.reviewHistory);
      expect(implementations).toBe(restartRound === 0 ? 1 : 3);
      expect(state?.reviewHistory?.map((entry) => entry.round)).toEqual(restartRound === 0 ? [0] : [0, 1, 2]);
      if (restartRound === 0) {
        expect(resumed.store.getArtifact(run.id, "review-0.json")).toContain('"verdict": "approve"');
        expect(state?.reviewFollowUps).toEqual([]);
      } else {
        // The later round omitted "Obsolete follow-up"; omission is not resolution.
        expect(state?.reviewFollowUps?.map((f) => f.title)).toEqual(["Backlog idea", "Obsolete follow-up"]);
        const followUps = resumed.store.getArtifact(run.id, "report.md")?.split("## Review follow-ups")[1];
        expect(followUps?.match(/^- major: `farewell\.txt:1` Backlog idea/gm)).toHaveLength(1);
        expect(followUps?.match(/^- major: `farewell\.txt:1` Obsolete follow-up/gm)).toHaveLength(1);
      }
    });
  }

  test("falls back to another provider when one is out of quota", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (s.target.provider === "alpha") return { status: "quota", error: "You've hit your session limit" };
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const invs = f.store.listInvocations(run.id);
    expect(invs[0]).toMatchObject({ provider: "alpha", status: "quota" });
    expect(invs.filter((i) => i.status === "ok").every((i) => i.provider === "beta")).toBe(true);
    // Unset effort is recorded as the backend default, never as legacy-unknown (null).
    expect(invs.every((i) => i.effort === "default")).toBe(true);
    expect(f.tracker.status("alpha")?.state).toBe("exhausted");
  });

  test("a model the provider rejects is blocked and skipped without burning rounds", async () => {
    let alphaCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (s.target.provider === "alpha") {
        alphaCalls++;
        return {
          status: "error",
          error: "The 'alpha-1' model is not supported when using Codex with a ChatGPT account.",
        };
      }
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(alphaCalls).toBe(1);
    expect(f.store.listStages(run.id).filter((s) => s.name === "implement").length).toBe(1);
    expect(f.tracker.modelUnavailableReason("alpha/m")).toContain("not supported");
  });

  test("schema-invalid structured output falls through to the next model", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage" && s.target.provider === "alpha") return { structured: { title: 42 } };
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const triageInvs = f.store.listInvocations(run.id).filter((i) => i.role === "triage");
    expect(triageInvs.map((i) => [i.provider, i.status])).toEqual([
      ["alpha", "error"],
      ["beta", "ok"],
    ]);
    expect(triageInvs[0]?.error).toContain("failed validation");
  });

  test("asks the human when triage finds blocking ambiguity, then continues", async () => {
    let specPrompt = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage")
        return {
          structured: triage({ ambiguity: "high", blocking_questions: ["Formal or casual farewell?"] }),
        };
      if (role === "spec") {
        specPrompt = s.prompt;
        return { structured: spec };
      }
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["waiting_input"])).toBe("waiting_input");
    expect(f.store.listQuestions(run.id)[0]?.question).toBe("Formal or casual farewell?");
    f.answer(run.id, "Casual", "tester");
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(specPrompt).toContain("A: Casual");
  });

  test("cancellation stops a running agent", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      return { delayMs: 30_000, files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (f.store.getRun(run.id)?.stage !== "implement" && Date.now() < deadline) await Bun.sleep(20);
    expect(f.cancelRun(run.id, "tester")).toBe(true);
    expect(await waitFor(f, run.id, ["cancelled"])).toBe("cancelled");
    expect(f.store.getRun(run.id)?.error).toBe("cancelled by tester");
  });

  test("gives up after max rounds and marks the run for a human", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      return { files: { "farewell.txt": `BAD ${Math.random()}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"], 30_000)).toBe("needs_human");
    const implement = f.store.listStages(run.id).filter((s) => s.name === "implement");
    expect(implement.length).toBe(5);
    expect(f.store.getRun(run.id)?.error).toContain("Still failing");
  });
});

for (const phase of ["clarify", "spec"] as const) {
  test.each(["parked", "transition", "entering", "cancelled"] as const)(
    `drain parks ${phase} answer waits (%s)`,
    async (when) => {
      const question = "Formal or casual farewell?";
      const specPrompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage")
          return {
            structured: triage(
              phase === "clarify" ? { ambiguity: "high", blocking_questions: [question] } : {},
            ),
          };
        if (role === "spec") {
          specPrompts.push(s.prompt);
          return { structured: { ...spec, blocking_questions: phase === "spec" ? [question] : [] } };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") return { structured: pass };
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      let drained = () => {};
      const entered = new Promise<void>((resolve) => {
        drained = resolve;
      });
      const unsubscribe = f.store.subscribe((msg) => {
        if (when === "entering" && msg.kind === "run" && msg.run.status === "waiting_input") {
          f.scheduler.drain();
          drained();
        }
      });
      try {
        const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
        // The parking deadline starts at the drain, not at run startup (clone, fetch, triage).
        if (when === "entering") await entered;
        else {
          await waitFor(f, run.id, ["waiting_input"]);
          f.scheduler.drain();
        }
        if (when === "transition") f.answer(run.id, "Casual", "tester");
        if (when === "cancelled") f.cancelRun(run.id, "tester");
        expect(await waitFor(f, run.id, ["queued", "cancelled"], 500)).toBe(
          when === "cancelled" ? "cancelled" : "queued",
        );
        expect(f.scheduler.activeRunIds).toEqual([]);
        if (when === "cancelled") {
          expect(f.scheduler.parkedRunIds).toEqual([]);
          expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
          expect(f.store.getRun(run.id)?.error).toBe("cancelled by tester");
          return;
        }
        expect(f.store.getRun(run.id)?.stage).toBeNull();
        expect(f.store.getRunState<RunState>(run.id)).toMatchObject({ phase, parked: true });
        expect(f.scheduler.parkedRunIds).toEqual([run.id]);
        if (when === "parked") {
          f.scheduler.resume();
          await waitFor(f, run.id, ["waiting_input"]);
          expect(f.store.listQuestions(run.id)).toHaveLength(1);
          f.scheduler.drain();
          await waitFor(f, run.id, ["queued"], 500);
        }
        if (when !== "transition") f.answer(run.id, "Casual", "tester");
        expect(f.store.listQuestions(run.id)[0]?.answer).toBe("Casual");
        f.scheduler.tick();
        expect(f.scheduler.activeRunIds).toEqual([]);
        f.scheduler.resume();
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        expect(specPrompts.at(-1)).toContain("A: Casual");
        expect(f.store.listQuestions(run.id)).toHaveLength(1);
        expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("done");
      } finally {
        unsubscribe();
      }
    },
  );
}

test("drain blocks queued starts and parks the active run at its next boundary", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const atTriage = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let firstSignal: AbortSignal | undefined;
  let calls = 0;
  const f = start(async (s) => {
    if (roleOf(s) === "triage") {
      calls++;
      if (calls === 1) {
        firstSignal = s.signal;
        entered();
        await held;
      }
      return { structured: triage({ suggested_profile: "quick" }) };
    }
    if (roleOf(s) === "review") return { structured: approve };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  try {
    const first = await f.createRun({ repo: repoDir, prompt: "change" });
    await atTriage;
    expect(f.scheduler.draining).toBe(false);
    f.scheduler.drain();
    f.scheduler.drain();
    const queued = await f.createRun({ repo: repoDir, prompt: "second" });
    const retry = await f.retryRun(first.id);
    const extra = await Promise.all(
      Array.from({ length: 3 }, () => f.createRun({ repo: repoDir, prompt: "more" })),
    );
    await Promise.resolve(); // Queue notifications also pass through tick.
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([first.id]);
    expect(firstSignal?.aborted).toBe(false);
    expect(f.store.getRun(queued.id)?.status).toBe("queued");
    expect(f.store.getRun(retry.id)?.status).toBe("queued");
    release();
    expect(await waitFor(f, first.id, ["queued"])).toBe("queued");
    while (f.scheduler.activeRunIds.length) await Bun.sleep(10);
    expect(f.scheduler.activeRunIds).toEqual([]);
    expect(calls).toBe(1);
    expect(f.store.getRunState<RunState>(first.id)?.parked).toBe(true);
    expect(f.store.getRunDetail(first.id)?.stages.map((s) => s.name)).not.toContain("implement");
    for (const run of [queued, retry, ...extra]) expect(f.store.listStages(run.id)).toEqual([]);
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([]);
    f.scheduler.resume();
    f.scheduler.resume();
    expect(f.scheduler.activeRunIds.length).toBe(f.cfg.maxConcurrentRuns);
    expect(f.scheduler.activeRunIds.length).toBeLessThanOrEqual(f.cfg.maxConcurrentRuns);
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await waitFor(f, queued.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await waitFor(f, retry.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    for (const run of extra) {
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    }
    await f.stop();
    f.scheduler.drain();
    const stopped = await f.createRun({ repo: repoDir, prompt: "after stop" });
    f.scheduler.resume();
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([]);
    expect(f.store.getRun(stopped.id)?.status).toBe("queued");
  } finally {
    release();
  }
});

for (const profile of ["quick", "standard"] as const) {
  test(`drain after implement preserves the ${profile} checkpoint and resumes at gates after restart`, async () => {
    const holdoutDone = Promise.withResolvers<void>();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const implementing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let implementations = 0;
    const handler: Handler = async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: profile }) };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        await holdoutDone.promise;
        return { structured: holdout };
      }
      if (role === "verify") return { structured: pass };
      if (role === "review") return { structured: approve };
      if (role === "implement") {
        implementations++;
        entered();
        await held;
        return { files: { "farewell.txt": "goodbye\n" } };
      }
      throw new Error(`unexpected role ${role}`);
    };
    const f = start(handler);
    try {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile });
      await implementing;
      const worktree = f.store.getRunState<RunState>(run.id)?.worktreePath;
      expect(worktree).toBeDefined();
      f.scheduler.drain();
      release();
      const deadline = Date.now() + 5000;
      while (
        !f.store.listStages(run.id).some((s) => s.name === "implement" && s.status === "succeeded") &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.status).toBe("succeeded");
      expect(f.store.listStages(run.id).some((s) => s.name === "gates")).toBe(false);
      if (profile === "standard") expect(f.scheduler.activeRunIds).toEqual([run.id]);
      holdoutDone.resolve();
      expect(await waitFor(f, run.id, ["queued"])).toBe("queued");
      while (f.scheduler.activeRunIds.length) await Bun.sleep(10);
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint).toMatchObject({ phase: "loop", round: 0, implementedRound: 0, parked: true });
      expect(f.store.getRun(run.id)).toMatchObject({ status: "queued", stage: null, finishedAt: null });
      const completed: StageName[] = [
        "prepare",
        "triage",
        ...(profile === "standard" ? (["spec", "holdout"] as const) : []),
        "implement",
      ];
      expect(f.store.listStages(run.id).map((stage) => stage.name)).toEqual(completed);
      expect(worktree && existsSync(worktree)).toBe(true);
      await f.stop();
      f.store.close();

      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementations).toBe(1);
      expect(resumed.store.listStages(run.id).map((stage) => stage.name)).toEqual([
        ...completed,
        "gates",
        "audit",
        "review",
        ...(profile === "standard" ? (["verify"] as const) : []),
        "deliver",
      ]);
      expect(resumed.store.getRunState<RunState>(run.id)).toMatchObject({
        round: 0,
        worktreePath: worktree,
        parked: false,
      });
    } finally {
      release();
      holdoutDone.resolve();
    }
  });
}

test("drain during verification parks before delivery", async () => {
  const f = start((s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify") {
      f.scheduler.drain();
      return { structured: pass };
    }
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(f, run.id, ["queued"])).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)).toMatchObject({ phase: "deliver", parked: true, round: 0 });
  expect(f.store.listStages(run.id).at(-1)).toMatchObject({ name: "verify", status: "succeeded" });
  f.scheduler.resume();
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(f.store.listStages(run.id).filter((s) => s.name === "verify")).toHaveLength(1);
});

test("drain during review finishes the round (review and verify once) before parking", async () => {
  let reviews = 0;
  const f = start((s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") {
      reviews++;
      f.scheduler.drain();
      return { structured: approve };
    }
    if (role === "verify") return { structured: pass };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(f, run.id, ["queued"])).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)).toMatchObject({ phase: "deliver", parked: true, round: 0 });
  f.scheduler.resume();
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(reviews).toBe(1);
  for (const name of ["gates", "review", "verify"] as const)
    expect(f.store.listStages(run.id).filter((s) => s.name === name)).toHaveLength(1);
});

test("cancellation wins over parking when both are requested during a stage", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const implementing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = start(async (s) => {
    if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (roleOf(s) === "implement") {
      entered();
      await held;
      return { files: { "farewell.txt": "goodbye\n" } };
    }
    return { structured: approve };
  });
  try {
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    await implementing;
    f.scheduler.drain();
    expect(f.cancelRun(run.id, "tester")).toBe(true);
    release();
    expect(await waitFor(f, run.id, ["cancelled"])).toBe("cancelled");
    expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
    expect(f.scheduler.parkedRunIds).toEqual([]);
  } finally {
    release();
  }
});

test("restart dispatches parked runs by priority then creation time", async () => {
  const started: string[] = [];
  const handler: Handler = (s) => {
    const role = roleOf(s);
    if (role === "triage") {
      started.push(
        s.prompt.includes("high old") ? "high old" : s.prompt.includes("high new") ? "high new" : "low",
      );
      return { structured: triage({ suggested_profile: "quick" }) };
    }
    if (role === "review") return { structured: approve };
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const f = start(handler);
  f.scheduler.drain();
  const low = await f.createRun({ repo: repoDir, prompt: "low", priority: 1, profile: "quick" });
  await Bun.sleep(2);
  const highOld = await f.createRun({ repo: repoDir, prompt: "high old", priority: 9, profile: "quick" });
  await Bun.sleep(2);
  const highNew = await f.createRun({ repo: repoDir, prompt: "high new", priority: 9, profile: "quick" });
  for (const [run, round] of [
    [low, 1],
    [highOld, 2],
    [highNew, 3],
  ] as const) {
    f.store.updateRun(run.id, { status: "queued" }, {
      phase: "prepare",
      round,
      parked: true,
      answers: [],
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    } satisfies RunState);
  }
  expect(f.scheduler.parkedRunIds).toEqual([highOld.id, highNew.id, low.id]);
  expect(started).toEqual([]);
  await f.stop();
  f.store.close();

  // One slot so dispatch order is also triage order; with more, equal-priority runs race.
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(join(home, "cfg", "config.toml"), "[limits]\nmax_concurrent_runs = 1\n");
  const resumed = start(handler);
  expect(resumed.cfg.maxConcurrentRuns).toBe(1);
  for (const run of [low, highOld, highNew]) {
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  }
  expect(started).toEqual(["high old", "high new", "low"]);
  for (const [run, round] of [
    [low, 1],
    [highOld, 2],
    [highNew, 3],
  ] as const) {
    expect(resumed.store.getRunState<RunState>(run.id)).toMatchObject({ round, parked: false });
  }
});

test("pipeline fallback records each effort and reloads the exact implementer preference", async () => {
  const { evalFixture, enableEfforts, answer } = await import("./evals-support.ts");
  const { RunContext } = await import("../src/pipeline/context.ts");
  const { Router } = await import("../src/router/router.ts");
  const { createHttpRoutes } = await import("../src/server/http.ts");
  const { localServer, requestWithParams } = await import("./mcp-support.ts");
  const f = await evalFixture();
  try {
    const model = enableEfforts(f);
    model.provider = "provider-b";
    const router = new Router(
      f.factory.tracker,
      {
        ...policy,
        implement: { default: ["candidate-a@low", "candidate-a@high"] },
      },
      [model],
    );
    const deps = { ...f.factory.deps, router };
    const repo = f.factory.store.upsertRepo({
      slug: "fixture/repo",
      kind: "local",
      localPath: f.source,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = f.factory.store.createRun(repo, { repo: repo.slug, prompt: "test" });
    const context = new RunContext(deps, run, repo, new AbortController().signal);
    const stage = f.factory.store.startStage(run.id, "implement", 0);
    f.respond((s) =>
      s.target.effort === "low"
        ? { structured: null, status: "error", error: "invalid output" }
        : { structured: answer },
    );
    const outcome = await context.invoke({
      role: "implement",
      stage,
      prompt: "test",
      mode: "readonly",
      complexity: "small",
      requireStructured: true,
    });
    expect(outcome.target.effort).toBe("high");
    expect(f.calls.map((s) => s.target.effort)).toEqual(["low", "high"]);
    context.state.implementer = {
      modelId: outcome.target.modelId,
      targetId: outcome.target.targetId,
      tier: outcome.target.tier,
      vendor: outcome.target.vendor,
    };
    await context.save();
    const loaded = new RunContext(deps, run, repo, new AbortController().signal);
    expect(
      router.route("implement", "small", { prefer: loaded.state.implementer?.targetId }).candidates[0]
        ?.effort,
    ).toBe("high");
    expect(model.effort).toBe("low");
    expect(f.factory.store.listInvocations(run.id).map((i) => [i.effort, i.status])).toEqual([
      ["low", "error"],
      ["high", "ok"],
    ]);
    const routes = createHttpRoutes(f.factory);
    const route = routes["/api/runs/:id"] as import("./mcp-support.ts").Route;
    const response = await route(
      requestWithParams(`http://localhost/api/runs/${run.id}`, {}, { id: run.id }),
      localServer,
    );
    expect(await response.json()).toMatchObject({ invocations: [{ effort: "low" }, { effort: "high" }] });
    // Old run state without a targetId still loads and resolves its bare preference.
    loaded.state.implementer = { modelId: model.id, tier: model.tier, vendor: model.vendor };
    await loaded.save();
    const old = new RunContext(deps, run, repo, new AbortController().signal);
    expect(
      router.route("implement", "small", { prefer: old.state.implementer?.modelId }).candidates[0]?.effort,
    ).toBe("low");
  } finally {
    await f.close();
  }
});

test("engine persists selected effort through a feedback round without changing other roles", async () => {
  const seen: AgentSpec[] = [];
  let implementations = 0;
  const f = start((s) => {
    seen.push(s);
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review") return { structured: approve };
    if (role === "verify") return { structured: pass };
    implementations++;
    return { files: { "farewell.txt": "goodbye\n", "bad.txt": implementations === 1 ? "BAD\n" : "fixed\n" } };
  }, true);
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(implementations).toBe(2);
  expect(seen.filter((s) => roleOf(s) === "implement").map((s) => s.target.effort)).toEqual(["high", "high"]);
  expect(seen.filter((s) => roleOf(s) !== "implement").every((s) => s.target.effort === "low")).toBe(true);
  expect(f.store.getRunState<RunState>(run.id)?.implementer).toMatchObject({
    modelId: "alpha/m",
    targetId: "alpha/m@high",
    effort: "high",
  });
  expect(f.router.model("alpha/m")?.effort).toBe("low");
});

for (const scenario of [
  "blocked",
  "passes",
  "retry-unmet",
  "initial-unmet",
  "unclear",
  "no-alternative",
  "blocked-not-required",
  "passes-not-required",
] as const) {
  test(`environment verification retry: ${scenario}`, async () => {
    const path = scenario.replace("-not-required", "");
    const verifierModels: string[] = [];
    const scratchPaths: string[] = [];
    const implementationPrompts: string[] = [];
    const order: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      order.push(role);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review" || role === "verify") {
        expect(s.scratchDir).toBeDefined();
        const scratch = s.scratchDir as string;
        expect(existsSync(scratch)).toBe(true);
        expect(scratch.startsWith(s.cwd)).toBe(false);
        scratchPaths.push(scratch);
        writeFileSync(join(scratch, "fixture"), "data");
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        verifierModels.push(s.target.modelId);
        const n = verifierModels.length;
        if (path === "no-alternative") f.tracker.blockModel("alpha/m", "unavailable alternative");
        if (
          (path === "passes" && n === 2) ||
          n === 3 ||
          ((path === "initial-unmet" || path === "unclear") && n === 2)
        )
          return { structured: pass };
        const actionable =
          ((path === "initial-unmet" || path === "unclear") && n === 1) ||
          (path === "retry-unmet" && n === 2);
        return {
          structured: {
            ...pass,
            overall: "fail",
            criteria: pass.criteria.map((c) =>
              c.id === "AC-1"
                ? {
                    ...c,
                    status: "blocked",
                    evidence: "Ran bun test: EPERM creating fixture directory",
                    publicSummary: "",
                  }
                : c.id === "H-1" && actionable
                  ? {
                      ...c,
                      status: path === "unclear" ? "unclear" : "unmet",
                      evidence: "Observed wrong output",
                      publicSummary: "",
                    }
                  : c.id === "H-2" && scenario.endsWith("-not-required")
                    ? { ...c, status: "unmet", requirement: "not_required" }
                    : c,
            ),
          },
        };
      }
      implementationPrompts.push(s.prompt);
      return { files: { "farewell.txt": "goodbye\n" }, text: "implemented" };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file", profile: "standard" });
    const terminal = await waitFor(f, run.id, ["succeeded", "needs_human", "failed"]);
    expect(terminal).toBe(path === "blocked" || path === "no-alternative" ? "needs_human" : "succeeded");
    const state = f.store.getRunState<RunState>(run.id);
    const actionable = ["retry-unmet", "initial-unmet", "unclear"].includes(path);
    expect(implementationPrompts).toHaveLength(actionable ? 2 : 1);
    expect(state?.round).toBe(actionable ? 1 : 0);
    expect(state?.roundsOnImplementer).toBe(actionable ? 1 : 0);
    expect(state?.implementer?.modelId).toBe("alpha/m");
    expect(new Set(scratchPaths).size).toBe(scratchPaths.length);
    for (const scratch of scratchPaths) expect(existsSync(scratch)).toBe(false);
    expect(verifierModels[0]).toBe("beta/m");
    if (["blocked", "passes", "retry-unmet"].includes(path)) {
      expect(verifierModels[1]).toBe("alpha/m");
      expect(order.slice(order.indexOf("verify"), order.indexOf("verify") + 2)).toEqual(["verify", "verify"]);
      expect(state?.verifyResults?.slice(0, 2).map((v) => [v.round, v.attempt, v.modelId])).toEqual([
        [0, 0, "beta/m"],
        [0, 1, "alpha/m"],
      ]);
      expect(f.store.listArtifacts(run.id).map((a) => a.name)).toContain("verify-0-retry.json");
    }
    if (terminal === "needs_human") {
      expect(f.store.getRun(run.id)?.error).toContain("verification blocked by the environment");
      expect(state?.terminalReason).toContain("EPERM");
      if (path === "no-alternative") expect(verifierModels).toHaveLength(1);
      else expect(verifierModels).toHaveLength(2);
    }
    if (actionable) {
      const feedback = implementationPrompts[1]?.split("### Checks not met")[1] ?? "";
      expect(feedback).toContain("H-1");
      expect(feedback).not.toContain("EPERM");
      expect(feedback).not.toContain("cat farewell.txt");
    }
  });
}

for (const failure of ["throw", "timeout", "quota", "cancelled"] as const) {
  test(`reader failure cleanup and fallback: ${failure}`, async () => {
    let reviews = 0;
    const paths: string[] = [];
    let cwd = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        cwd = s.cwd;
        expect(readFileSync(join(cwd, "greeting.txt"), "utf8")).toBe("hello\n");
        const scratch = s.scratchDir as string;
        expect(existsSync(scratch)).toBe(true);
        paths.push(scratch);
        writeFileSync(join(scratch, "fixture"), "data");
        if (reviews === 1) {
          writeFileSync(join(cwd, "greeting.txt"), "incidental change");
          writeFileSync(join(cwd, "incidental.txt"), "untracked");
          if (failure === "throw") throw new Error("injected failure");
          return { status: failure, error: failure };
        }
        expect(existsSync(paths[0] as string)).toBe(false);
        expect(existsSync(join(cwd, "incidental.txt"))).toBe(false);
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human", "cancelled"])).toBe(
      failure === "cancelled" ? "cancelled" : "succeeded",
    );
    expect(readFileSync(join(cwd, "greeting.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(cwd, "incidental.txt"))).toBe(false);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });
}

test("completed environment retry stays consumed after persisted-state restart", async () => {
  let implementations = 0;
  let verifies = 0;
  const handler: Handler = (s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify") {
      verifies++;
      return {
        structured: {
          ...pass,
          criteria: pass.criteria.map((c) =>
            c.id === "AC-1"
              ? { ...c, status: "blocked", evidence: "bun test failed: EPERM mkdir", publicSummary: "" }
              : c,
          ),
        },
      };
    }
    implementations++;
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const f = start(handler);
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(f, run.id, ["needs_human", "succeeded", "failed"])).toBe("needs_human");
  expect(verifies).toBe(2);
  await f.stop();
  f.store.updateRun(run.id, { status: "queued", finishedAt: null });
  f.store.close();
  factory = null;
  const resumed = start(handler);
  expect(await waitFor(resumed, run.id, ["needs_human", "succeeded", "failed"])).toBe("needs_human");
  expect(verifies).toBe(2);
  expect(implementations).toBe(1);
  expect(resumed.store.getRunState<RunState>(run.id)?.verifyResults).toHaveLength(2);
});

test("environment retry prefers another cross-vendor model over same-vendor fallback", async () => {
  const ids: string[] = [];
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  const beta = models.find((m) => m.id === "beta/m");
  if (!beta) throw new Error("missing fixture model");
  factory = new Factory(cfg, {
    providers,
    models: [...models, { ...beta, id: "beta/other", model: "beta-2" }],
    policy: { ...policy, verify: { default: ["alpha/m", "beta/m", "beta/other"] } },
    harnesses: {
      fake: fakeHarness((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          ids.push(s.target.modelId);
          if (ids.length > 1) return { structured: pass };
          return {
            structured: {
              ...pass,
              criteria: pass.criteria.map((c) =>
                c.id === "AC-1"
                  ? { ...c, status: "blocked", evidence: "bun test failed: EPERM mkdir", publicSummary: "" }
                  : c,
              ),
            },
          };
        }
        return { files: { "farewell.txt": "goodbye\n" } };
      }),
    },
  });
  factory.start();
  const run = await factory.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(factory, run.id, ["succeeded", "needs_human", "failed"])).toBe("succeeded");
  expect(ids).toEqual(["beta/m", "beta/other"]);
});

test("panel review: a refuted blocker doesn't block, a CONFIRMED low does, and verifiers avoid the finder's vendor", async () => {
  const candidate = (title: string, severity: string) => ({
    severity,
    security: false,
    ...findingEvidence,
    file: "farewell.txt",
    line: 1,
    title,
    detail: `SECRET_DETAIL ${title}`,
    suggestion: "Fix it",
  });
  const rulings: Record<string, [string, string]> = {
    C1: ["REFUTED", "critical"],
    C2: ["CONFIRMED", "low"],
    C3: ["PLAUSIBLE", "medium"],
  };
  const verifiers: AgentSpec[] = [];
  const implementPrompts: string[] = [];
  const f = start((s) => {
    if (s.prompt.startsWith("You are a code-review verifier")) {
      verifiers.push(s);
      const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
      return {
        structured: {
          results: ids.map((id) => ({
            id,
            verdict: rulings[id]?.[0],
            severity: rulings[id]?.[1],
            category: "correctness",
            evidence: `farewell.txt:1 \`bye\` (${id})`,
            trigger: `reading the file -> wrong farewell (${id})`,
          })),
        },
      };
    }
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review")
      return {
        structured: s.prompt.includes("# Previous review")
          ? { verdict: "approve", summary: "P1 fixed; no regressions found.", findings: [] }
          : {
              verdict: "request_changes",
              summary: "Found problems in the farewell text.",
              findings: [
                candidate("Refuted blocker", "blocker"),
                candidate("Confirmed low", "minor"),
                candidate("Plausible medium", "major"),
              ],
            },
      };
    implementPrompts.push(s.prompt);
    return { files: { "farewell.txt": `goodbye ${implementPrompts.length}\n` } };
  });
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    finders: [{ prompt: "standard" }],
    verifier: {},
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  // Implementer alpha (anthropic) -> finder beta (openai) -> verifier routed away from openai.
  expect(
    f.store
      .listInvocations(run.id)
      .filter((i) => i.role === "review")
      .map((i) => i.modelId),
  ).toEqual(["beta/m", "alpha/m", "beta/m", "beta/m"]);
  // R2's finder repeated nothing, so the verifier rechecks P1 itself (as C1, refuted: fixed). No
  // finder raised that candidate, so there is no finder vendor to route away from.
  expect(verifiers.map((s) => [s.target.vendor, s.mode])).toEqual([
    ["anthropic", "readonly"],
    ["openai", "readonly"],
  ]);
  expect(verifiers[1]?.prompt).toContain('"status": "not repeated by any finder; recheck it as C1"');
  expect(verifiers[1]?.prompt).toMatch(/"title": "Confirmed low",[\s\S]*"prior": "P1"/);
  for (const s of verifiers) expect(s.prompt).not.toContain("SECRET_DETAIL");
  expect(implementPrompts).toHaveLength(2);
  const feedback = implementPrompts[1] ?? "";
  expect(feedback).toContain("**low** farewell.txt:1 — Confirmed low");
  expect(feedback).toContain("farewell.txt:1 `bye` (C2)");
  expect(feedback).toContain("Trigger: reading the file -> wrong farewell (C2)");
  for (const dropped of ["Refuted blocker", "Plausible medium"]) expect(feedback).not.toContain(dropped);
  expect(f.store.getArtifact(run.id, "review-0.json")).toBeNull();
  const artifact = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}");
  expect(artifact).toMatchObject({
    mode: "panel",
    verdict: "request_changes",
    round: 0,
    panelReview: 1,
    panel: { refuted: ["C1"], capped: [] },
  });
  expect(JSON.parse(f.store.getArtifact(run.id, "review-2.json") ?? "{}")).toMatchObject({
    verdict: "approve",
    round: 1,
    panelReview: 2,
    panel: { refuted: ["C1"], candidates: [{ id: "C1", title: "Confirmed low", finder: null, prior: "P1" }] },
  });
  expect(artifact.blocking.map((b: { title: string }) => b.title)).toEqual(["Confirmed low"]);
  expect(artifact.panel.candidates.map((c: { id: string; title: string }) => [c.id, c.title])).toEqual([
    ["C1", "Refuted blocker"],
    ["C2", "Confirmed low"],
    ["C3", "Plausible medium"],
  ]);
  expect(artifact.panel.verdicts.map((v: { id: string; verdict: string }) => [v.id, v.verdict])).toEqual([
    ["C1", "REFUTED"],
    ["C2", "CONFIRMED"],
    ["C3", "PLAUSIBLE"],
  ]);
  const state = f.store.getRunState<RunState>(run.id);
  expect(state?.reviewFollowUps?.map((x) => x.title)).toEqual(["Plausible medium"]);
  const report = f.store.getArtifact(run.id, "report.md") ?? "";
  expect(report).toContain("- medium: `farewell.txt:1` Plausible medium");
  expect(report).not.toContain("Refuted blocker");
});

test("panel review: a verifier that omits candidates is retried once, then they stay unverified follow-ups", async () => {
  const candidate = (title: string) => ({
    severity: "blocker",
    security: false,
    ...findingEvidence,
    file: "farewell.txt",
    line: 1,
    title,
    detail: `Detail ${title}`,
    suggestion: "Fix it",
  });
  const verifierIds: string[][] = [];
  const f = start((s) => {
    if (s.prompt.startsWith("You are a code-review verifier")) {
      const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
      verifierIds.push(ids);
      // Rules on C1 only; C2 is never answered.
      return {
        structured: {
          results: ids
            .filter((id) => id === "C1")
            .map((id) => ({
              id,
              verdict: "PLAUSIBLE",
              severity: "medium",
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
        },
      };
    }
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review")
      return {
        structured: {
          verdict: "request_changes",
          summary: "Found problems in the farewell text.",
          findings: [candidate("Answered"), candidate("Omitted")],
        },
      };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    finders: [{ prompt: "standard" }],
    verifier: {},
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifierIds).toEqual([["C1", "C2"], ["C2"]]);
  const artifact = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}");
  expect(artifact).toMatchObject({ verdict: "approve", blocking: [], panel: { omitted: ["C2"] } });
  const state = f.store.getRunState<RunState>(run.id);
  expect(state?.reviewFollowUps?.map((x) => [x.title, x.verification?.verdict])).toEqual([
    ["Answered", "PLAUSIBLE"],
    ["Omitted", undefined],
  ]);
  const warnings = f.store
    .listEvents(run.id)
    .filter((e) => e.level === "warn")
    .map((e) => e.message);
  expect(warnings).toContainEqual(expect.stringContaining("Verifier gave no ruling for C2"));
});

test("panel review: a verifier left on the finder's vendor is another model, with a recorded warning", async () => {
  const verifiers: string[] = [];
  const f = start(
    (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        verifiers.push(s.target.modelId);
        const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
        return {
          structured: {
            results: ids.map((id) => ({
              id,
              verdict: "PLAUSIBLE",
              severity: "low",
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review")
        return {
          structured: {
            verdict: "approve",
            summary: "One small note on the farewell text.",
            findings: [
              {
                severity: "minor",
                security: false,
                ...findingEvidence,
                file: "farewell.txt",
                line: 1,
                title: "Note",
                detail: "d",
                suggestion: "s",
              },
            ],
          },
        };
      return { files: { "farewell.txt": "goodbye\n" } };
    },
    false,
    true,
  );
  // Only one vendor is routable, so the verifier cannot avoid the finder's; it may not reuse its model.
  f.tracker.record("beta", "quota", { exhaustedUntil: Date.now() + 3_600_000 });
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    finders: [{ prompt: "standard" }],
    verifier: { target: "gamma/m" },
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual(["gamma/m"]);
  const warning =
    "Verifier gamma/m shares vendor anthropic with a finder it checks (C1); no other vendor was available";
  expect(JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}").panel.warnings).toEqual([warning]);
  expect(f.store.listEvents(run.id).map((e) => e.message)).toContain(warning);
  // With nothing but the finder's own model, there is no verifier: the run goes to a human.
  f.tracker.setEnabled("gamma", false);
  const alone = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, alone.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(verifiers).toEqual(["gamma/m"]);
  expect(f.store.getRun(alone.id)?.error).toContain("alpha/m (raised a candidate it would verify)");
  // A listed verifier is picked per batch, past the finder's own model, to one routing would not offer.
  Object.assign(f.deps.reviewSystem ?? {}, { verifier: { targets: ["alpha/m", "delta/m"] } });
  const listed = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, listed.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual(["gamma/m", "delta/m"]);
  // The picked target alone is offered: with it down, routing never falls back to an unlisted model.
  f.tracker.setEnabled("gamma", true);
  f.tracker.setEnabled("delta", false);
  const down = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, down.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(verifiers).toEqual(["gamma/m", "delta/m"]);
  expect(f.store.getRun(down.id)?.error).toContain("delta/m (disabled)");
  Object.assign(f.deps.reviewSystem ?? {}, { verifier: { targets: ["alpha/m"] } });
  const noVerifier = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, noVerifier.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(verifiers).toEqual(["gamma/m", "delta/m"]);
  expect(f.store.getRun(noVerifier.id)?.error).toContain("raised a candidate it would check");
});

test("panel review: batches from different vendors go to different listed verifiers", async () => {
  const verifiers: [string, string[]][] = [];
  const f = start(
    (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
        verifiers.push([s.target.modelId, ids]);
        return {
          structured: {
            results: ids.map((id) => ({
              id,
              verdict: "REFUTED",
              severity: "low",
              category: "correctness",
              evidence: "Checked the farewell text",
              trigger: "none",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: reviewOutput(1, "minor", `${s.target.vendor}.txt`) };
      return { files: { "farewell.txt": "goodbye\n" } };
    },
    false,
    true,
  );
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    implementerReport: "include",
    finders: ["alpha/m", "beta/m"].map((target) => ({ target, prompt: "standard" })),
    verifier: { targets: ["gamma/m", "delta/m"] },
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual([
    ["delta/m", ["C1"]],
    ["gamma/m", ["C2"]],
  ]);
  expect(
    JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}").panel.candidates.map(
      (c: { vendor: string }) => c.vendor,
    ),
  ).toEqual(["anthropic", "openai"]);
});

describe("routing bounded slot waits", () => {
  function fixture(
    catalog = models,
    routing = policy,
    reply?: (s: AgentSpec) => FakeReply | Promise<FakeReply>,
  ) {
    const clock = waitClock();
    const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
    const calls: AgentSpec[] = [];
    factory = new Factory(cfg, {
      providers,
      models: catalog,
      policy: routing,
      harnesses: {
        fake: fakeHarness((s) => {
          calls.push(s);
          if (reply) return reply(s);
          return s.target.modelId === "beta/5" || catalog === models
            ? { text: "ok", structured: {} }
            : { status: "error", error: "invalid output" };
        }),
      },
    });
    const tracker = new ProviderTracker(
      providers,
      factory.store,
      cfg.reserves,
      {},
      {},
      clock.now,
      fetch,
      clock.timer,
    );
    const router = new Router(tracker, routing, catalog);
    const repo = factory.store.upsertRepo({
      slug: "wait/repo",
      kind: "local",
      localPath: repoDir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "wait" });
    const controller = new AbortController();
    const context = new RunContext({ ...factory.deps, tracker, router }, run, repo, controller.signal);
    const stage = factory.store.startStage(run.id, "triage", 0);
    const invoke = (deadline?: number, role: Role = "triage") =>
      context.invoke({
        role,
        stage,
        prompt: "wait",
        mode: "readonly",
        noTools: true,
        complexity: "small",
        requireStructured: true,
        deadline,
      });
    const events = () => context.store.listEvents(run.id).filter((e) => e.message.startsWith("waiting for"));
    return { clock, cfg, tracker, calls, controller, context, run, invoke, events };
  }

  test("expiry falls through without an invocation; immediate admission records zero and no wait event", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const slots = await Promise.all([f.tracker.acquire("alpha", signal), f.tracker.acquire("alpha", signal)]);
    const ahead = f.tracker.acquire("alpha", signal);
    const pending = f.invoke();
    expect(f.events().map((e) => e.message)).toEqual(["waiting for alpha slot (1 ahead), up to 20s"]);
    await f.clock.advance(20_000);
    const outcome = await pending;
    expect(f.calls.map((s) => s.target.provider)).toEqual(["beta"]);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
    expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(20_000);
    expect(f.events()).toHaveLength(1);
    expect(f.clock.pending).toBe(0);
    const usage = f.context.store.listEvents(f.run.id).find((e) => e.message === "triage: using beta/m");
    expect(usage?.data).toMatchObject({ skipped: [] });
    for (const release of slots) release();
    (await ahead)();
    const immediate = await f.invoke();
    expect(f.context.store.getInvocation(immediate.invocation.id)?.waitMs).toBe(0);
    expect(f.events()).toHaveLength(1);
  });

  test("a slot freed inside the overridden budget is invoked with persisted elapsed wait", async () => {
    const f = fixture();
    f.cfg.waitBudgetS.triage = 7;
    const signal = new AbortController().signal;
    const slots = await Promise.all([f.tracker.acquire("alpha", signal), f.tracker.acquire("alpha", signal)]);
    const pending = f.invoke();
    await f.clock.advance(2_500);
    slots[0]?.();
    const outcome = await pending;
    expect(f.calls.map((s) => s.target.provider)).toEqual(["alpha"]);
    expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(2_500);
    expect(f.events().map((e) => e.message)).toEqual(["waiting for alpha slot (0 ahead), up to 7s"]);
    expect(f.clock.pending).toBe(0);
    slots[1]?.();
  });

  test("cancelled waiting stays cancellation without fallback or an invocation", async () => {
    const f = fixture();
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    const pending = f.invoke();
    f.controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(f.calls).toHaveLength(0);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
    expect(f.clock.pending).toBe(0);
    for (const release of slots) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  });

  test.each([0, 20])("all busy providers race for the first slot with a %ss budget", async (seconds) => {
    const f = fixture();
    f.cfg.waitBudgetS.triage = seconds;
    const slots = await Promise.all(
      providers.flatMap((p) =>
        Array.from({ length: p.maxConcurrent }, () => f.tracker.acquire(p.id, f.controller.signal)),
      ),
    );
    const pending = f.invoke();
    await f.clock.advance(seconds * 1000);
    await f.clock.advance(seconds * 1000);
    await f.clock.advance(60_000);
    expect(f.calls).toHaveLength(0);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
    expect(f.events().map((e) => e.message)).toEqual([
      `waiting for alpha slot (0 ahead), up to ${seconds}s`,
      `waiting for beta slot (0 ahead), up to ${seconds}s`,
      "waiting for alpha slot (0 ahead), up to unbounded",
      "waiting for beta slot (0 ahead), up to unbounded",
    ]);
    expect(f.clock.pending).toBe(0);
    slots[0]?.();
    const outcome = await pending;
    expect(f.calls.map((s) => s.target.provider)).toEqual(["alpha"]);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
    expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(seconds * 2000 + 60_000);
    expect(f.events()).toHaveLength(4);
    // Losing reservations and waiters must be gone: beta remains occupied only by the fixture.
    expect(f.tracker.status("beta")?.inFlight).toBe(2);
    for (const release of slots) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test.each(["alpha", "beta", "both"])("all busy providers select %s when its slot frees", async (free) => {
    const f = fixture();
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    const pending = f.invoke();
    await f.clock.advance(20_000);
    await f.clock.advance(20_000);
    await f.clock.advance(5_000);
    // Release beta first to prove simultaneous availability still prefers policy order.
    if (free !== "alpha") slots[2]?.();
    if (free !== "beta") slots[0]?.();
    expect((await pending).target.provider).toBe(free === "beta" ? "beta" : "alpha");
    expect(f.context.store.listInvocations(f.run.id)[0]?.waitMs).toBe(45_000);
    for (const release of slots) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
    // A new invocation can use either provider after losing waiters were cancelled.
    expect((await f.invoke()).target.provider).toBe("alpha");
  });

  test.each(["quota", "unavailable", "declined", "missing"] as const)(
    "an expired provider remains eligible after beta returns %s",
    async (status) => {
      const f = fixture(models, policy, (s) =>
        s.target.provider === "alpha" ? { structured: {} } : status === "missing" ? {} : { status },
      );
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      const pending = f.invoke();
      await f.clock.advance(20_000);
      expect(f.calls.map((s) => s.target.provider)).toEqual(["beta"]);
      await f.clock.advance(5_000);
      slots[0]?.();
      const outcome = await pending;
      expect(outcome.target.provider).toBe("alpha");
      expect(f.calls.map((s) => s.target.provider)).toEqual(["beta", "alpha"]);
      expect(f.context.store.listInvocations(f.run.id).map((i) => i.waitMs)).toEqual([20_000, 25_000]);
      expect(f.events().map((e) => e.message)).toEqual([
        "waiting for alpha slot (0 ahead), up to 20s",
        "waiting for alpha slot (0 ahead), up to unbounded",
      ]);
      expect(f.clock.pending).toBe(0);
      for (const release of slots) release();
    },
  );

  test("expired providers can run immediately when a fallback fails after their slot frees", async () => {
    let finishBeta: (reply: FakeReply) => void = () => {
      throw new Error("beta not invoked");
    };
    const f = fixture(models, policy, (s) =>
      s.target.provider === "alpha"
        ? { structured: {} }
        : new Promise<FakeReply>((resolve) => {
            finishBeta = resolve;
          }),
    );
    const slots = await Promise.all(["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)));
    const pending = f.invoke();
    await f.clock.advance(20_000);
    await f.clock.advance(5_000);
    slots[0]?.();
    finishBeta({ status: "quota" });
    const outcome = await pending;
    expect(outcome.target.provider).toBe("alpha");
    // The five seconds beta spent executing are not slot waiting.
    expect(outcome.invocation.waitMs).toBe(20_000);
    expect(f.events()).toHaveLength(1);
    slots[1]?.();
  });

  test.each(["cancel", "deadline"])("an all-provider wait cleans up on %s", async (end) => {
    const f = fixture();
    const now = spyOn(Date, "now").mockImplementation(f.clock.now);
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    try {
      const pending = f.invoke(end === "deadline" ? f.clock.now() + 60_000 : undefined);
      const settled = pending.catch((error: unknown) => error);
      await f.clock.advance(20_000);
      await f.clock.advance(20_000);
      if (end === "cancel") f.controller.abort();
      else await f.clock.advance(20_000);
      expect(await settled).toBeInstanceOf(end === "cancel" ? CancelledError : NoCapacityError);
      expect(f.clock.pending).toBe(0);
      expect(f.calls).toHaveLength(0);
      for (const release of slots) release();
      expect(f.tracker.status("alpha")?.inFlight).toBe(0);
      expect(f.tracker.status("beta")?.inFlight).toBe(0);
    } finally {
      now.mockRestore();
      for (const release of slots) release();
    }
  });

  test.each(["review", "verify", "spec", "holdout", "implement", "plan", "plan_review"] as const)(
    "%s waits beyond the former defaults without falling through",
    async (role) => {
      const f = fixture(models, { ...policy, [role]: everyone });
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      const pending = f.invoke(undefined, role);
      await f.clock.advance(360_000);
      expect(f.calls).toHaveLength(0);
      expect(f.events()[0]?.message).toContain("up to unbounded");
      slots[0]?.();
      const outcome = await pending;
      expect(outcome.target.provider).toBe("alpha");
      expect(outcome.invocation.waitMs).toBe(360_000);
      slots[1]?.();
    },
  );

  test.each(["release", "cancel", "deadline"])("a pinned candidate waits until %s", async (end) => {
    const f = fixture(models, { ...policy, triage: { default: ["alpha/m"] } });
    const now = spyOn(Date, "now").mockImplementation(f.clock.now);
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    try {
      const pending = f.invoke(end === "deadline" ? f.clock.now() + 60_000 : undefined);
      const settled = pending.catch((error: unknown) => error);
      await f.clock.advance(40_000);
      expect(f.calls).toHaveLength(0);
      expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
      expect(f.events().map((e) => e.message)).toEqual([
        `waiting for alpha slot (0 ahead), up to ${end === "deadline" ? "60s" : "unbounded"}`,
      ]);
      if (end === "release") {
        slots[0]?.();
        const outcome = await pending;
        expect(f.calls.map((s) => s.target.provider)).toEqual(["alpha"]);
        expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(40_000);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
      } else {
        if (end === "cancel") f.controller.abort();
        else await f.clock.advance(20_000);
        expect(await settled).toBeInstanceOf(end === "cancel" ? CancelledError : NoCapacityError);
        expect(f.calls).toHaveLength(0);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
      }
      expect(f.events()).toHaveLength(1);
      expect(f.clock.pending).toBe(0);
    } finally {
      now.mockRestore();
      for (const release of slots) release();
    }
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  });

  test("more than six busy candidates still allow all six actual invocation attempts", async () => {
    const alpha = models[0];
    const beta = models[1];
    if (!alpha || !beta) throw new Error("missing models");
    const catalog = [
      ...Array.from({ length: 7 }, (_, i) => ({ ...alpha, id: `alpha/${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ ...beta, id: `beta/${i}` })),
    ];
    const f = fixture(catalog, { ...policy, triage: { default: catalog.map((m) => m.id) } });
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    const pending = f.invoke();
    await f.clock.advance(20_000);
    expect((await pending).target.modelId).toBe("beta/5");
    expect(f.calls.map((s) => s.target.modelId)).toEqual(Array.from({ length: 6 }, (_, i) => `beta/${i}`));
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(6);
    expect(f.events()).toHaveLength(1);
    expect(f.context.store.listInvocations(f.run.id).map((i) => i.waitMs)).toEqual(Array(6).fill(20_000));
    for (const release of slots) release();
  });

  test("an invocation deadline caps the provider wait", async () => {
    const f = fixture();
    const now = spyOn(Date, "now").mockImplementation(f.clock.now);
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    try {
      const pending = f.invoke(f.clock.now() + 1_500);
      const rejection = pending.catch((error: unknown) => error);
      expect(f.events()[0]?.message).toContain("up to 2s");
      await f.clock.advance(1_500);
      expect(await rejection).toBeInstanceOf(NoCapacityError);
      expect(f.calls).toHaveLength(0);
      expect(f.clock.pending).toBe(0);
    } finally {
      now.mockRestore();
      for (const release of slots) release();
    }
  });
});
