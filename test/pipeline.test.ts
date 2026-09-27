import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { githubWebhook } from "../src/integrations/github.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { renderReport } from "../src/pipeline/report.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";

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
  if (p.startsWith("Write blind holdout checks")) return "holdout";
  if (p.startsWith("You are an adversarial code reviewer")) return "review";
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
const approve = { verdict: "approve", summary: "LGTM", findings: [] };
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

function start(handler: Handler, effortRouting = false): Factory {
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  factory = new Factory(cfg, {
    harnesses: { fake: fakeHarness(handler) },
    providers,
    models: effortRouting
      ? models.map((m): ModelDef => ({ ...m, supportedEfforts: ["low", "high"], effort: "low" }))
      : models,
    policy: effortRouting ? { ...policy, implement: { default: ["alpha/m@high", "alpha/m@low"] } } : policy,
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

describe("pipeline (fake agents, real git + gates)", () => {
  async function githubFixture(): Promise<string> {
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> '${join(home, "gh-calls")}'\ncase "$2" in\n  list) exit 0 ;;\n  create) echo https://github.com/test/repo/pull/1 ;;\nesac\n`,
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

  async function resolveBaseConflict(cwd: string, bare: string): Promise<void> {
    expect((await sh(["git", "status", "--porcelain"], { cwd })).stdout).toBe("");
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const path = (await sh(["git", "rev-parse", "--git-path", name], { cwd })).stdout.trim();
      expect(existsSync(resolve(cwd, path))).toBe(false);
    }
    await assertUnpublished(bare);
    const merge = await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", "origin/main"], {
      cwd,
      allowFail: true,
    });
    expect(merge.exitCode).not.toBe(0);
    writeFileSync(join(cwd, "greeting.txt"), "hello from both intents\nnew base\n");
    await sh(["git", "add", "greeting.txt"], { cwd });
    await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "resolve merge"], {
      cwd,
    });
  }

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
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          checkedHead = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
          return { structured: pass };
        }
        implementCalls++;
        if (conflict && implementCalls === 2) {
          mergePrompt = s.prompt;
          await resolveBaseConflict(s.cwd, bare);
          return { text: "Resolved base conflict" };
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
      // Rebasing is best-effort: these fall back to delivering the gated head on its original base.
      const fallback = kind.endsWith("regressed") || kind === "rewritten";
      expect(status).toBe("succeeded");
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
        expect(mergePrompt).toContain("git merge origin/main");
        expect(stages.slice(-6)).toEqual(["implement", "gates", "audit", "review", "verify", "deliver"]);
        expect(f.store.getArtifact(run.id, "diff.patch")).not.toContain("+new base");
      }
      if (fallback) {
        expect(finished?.baseSha).toBe(originalBase);
        const state = f.store.getRunState<RunState>(run.id);
        expect(f.store.getArtifact(run.id, "report.md")).toContain(state?.rebaseNote ?? "missing note");
        expect(
          (
            await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], {
              cwd: bare,
              allowFail: true,
            })
          ).exitCode,
        ).not.toBe(0);
        if (kind.endsWith("regressed")) {
          expect(state?.rebaseNote).toContain("checks regressed");
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
                    ...(reviews > 1 ? { label: reviews > normalRounds ? "regression" : "unaddressed" } : {}),
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
          expect(s.prompt).toContain("git merge origin/main");
          expect(s.prompt).toContain("preserving both intents");
          await resolveBaseConflict(s.cwd, bare);
          if (outcome === "gates") return { files: { "bad.txt": "BAD\n" } };
          if (outcome === "audit") return { files: { ".limitless.toml": "# removed gates\n" } };
          return { text: "Merged the base" };
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
        await assertUnpublished(bare);
      }
    });
  }

  for (const checkpoint of [
    "post-rebase-gates",
    "interrupted-rebase",
    "base-moved",
    "base-moved-during-gates",
    "conflict-implement",
  ] as const) {
    test(`delivery checkpoint ${checkpoint} never publishes unchecked work`, async () => {
      const marker = join(home, "checking");
      const release = join(home, "release");
      if (checkpoint !== "conflict-implement") {
        const check = `if test -f base.txt && ! test -f '${release}'; then echo dirty > greeting.txt; touch '${marker}'; while ! test -f '${release}'; do sleep 0.05; done; fi; test -f greeting.txt`;
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
          if (reviews === 1)
            baseTip = await advanceBase(
              bare,
              checkpoint === "conflict-implement" ? "greeting.txt" : "base.txt",
              "new base\n",
            );
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          return { structured: pass };
        }
        implementsCount++;
        if (implementsCount > 1) {
          expect(s.prompt).toContain("git merge origin/main");
          if (!restarting) {
            writeFileSync(marker, "implementing");
            return { delayMs: 30_000 };
          }
          await resolveBaseConflict(s.cwd, bare);
          return { text: "Merged the base after restart" };
        }
        return {
          files: {
            "farewell.txt": "goodbye\n",
            ...(checkpoint === "conflict-implement" ? { "greeting.txt": "feature\n" } : {}),
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
      expect(state?.phase).toBe(checkpoint === "conflict-implement" ? "loop" : "deliver");
      if (checkpoint === "conflict-implement") {
        expect(f.store.getRun(run.id)?.baseSha).toBe(baseTip);
        expect(state?.conflictRound).toBe(1);
      } else {
        expect(state?.pendingRebaseSha).toBe(baseTip);
        expect(f.store.getRun(run.id)?.baseSha).not.toBe(baseTip);
      }
      await assertUnpublished(bare);
      if (checkpoint === "interrupted-rebase") {
        const cwd = state?.worktreePath;
        const originalHead = f.store.getRun(run.id)?.headSha;
        if (!cwd || !originalHead) throw new Error("missing delivery checkpoint");
        // Recreate a crash between rebase starting and the post-rebase checks starting.
        await sh(["git", "reset", "--hard", originalHead], { cwd });
        const interrupted = await sh(
          ["git", "-c", "user.name=t", "-c", "user.email=t@t", "rebase", "--exec", "false", baseTip],
          { cwd, allowFail: true },
        );
        expect(interrupted.exitCode).not.toBe(0);
        const path = (await sh(["git", "rev-parse", "--git-path", "rebase-merge"], { cwd })).stdout.trim();
        expect(existsSync(resolve(cwd, path))).toBe(true);
      }
      f.store.close();
      restarting = true;
      if (checkpoint === "base-moved") baseTip = await advanceBase(bare, "again.txt", "newer base\n");
      writeFileSync(release, "resume");
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const finished = resumed.store.getRun(run.id);
      expect(finished?.baseSha).toBe(baseTip);
      expect(resumed.store.getRunState<RunState>(run.id)?.pendingRebaseSha).toBeUndefined();
      expect(implementsCount).toBe(checkpoint === "conflict-implement" ? 3 : 1);
      expect(reviews).toBe(checkpoint === "conflict-implement" ? 2 : 1);
      expect(verifies).toBe(checkpoint === "conflict-implement" ? 2 : 1);
      expect(
        (await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], { cwd: bare }))
          .exitCode,
      ).toBe(0);
      expect(
        (await sh(["git", "show", `${finished?.headSha}:greeting.txt`], { cwd: bare })).stdout,
      ).not.toContain("dirty");
      expect(resumed.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(
        checkpoint === "conflict-implement" ? 2 : 3,
      );
    });
  }

  test("Dependabot run delivers to the existing PR head without creating a PR", async () => {
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    await sh(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir });
    const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    let concurrent: string | null = null;
    let content = "verified\n";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
      if (role === "review") {
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
        pull_request: { head: { sha: string } };
      };
      payload.pull_request.head.sha = sha;
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
    const run = await trigger(baseSha, "initial");
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
    if (!finished?.headSha) throw new Error("missing delivered head");
    const stale = await trigger(finished.headSha, "concurrent");
    expect(await waitFor(f, stale.id, ["succeeded", "failed", "needs_human"])).toBe("failed");
    expect(f.store.getRun(stale.id)?.error).toContain("PR head moved");
    expect(
      (await sh(["git", "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir })).stdout,
    ).toContain(competingSha);
  });

  test("holdout starts alongside implementation, stays blind, and quick skips it", async () => {
    for (const profile of ["standard", "deep", "quick"] as const) {
      let implementStarted = false;
      let holdoutCalls = 0;
      let holdoutCwd = "";
      const f = start(async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") {
          holdoutCalls++;
          holdoutCwd = s.cwd;
          expect(s.mode).toBe("readonly");
          expect(s.noTools).toBe(true);
          expect(s.maxToolCalls).toBe(0);
          expect(s.prompt).toContain("# Original request");
          expect(s.prompt).toContain("# Specification");
          expect(s.prompt).not.toContain("implementation marker");
          expect(existsSync(join(s.cwd, "greeting.txt"))).toBe(false);
          while (!implementStarted && !s.signal.aborted) await Bun.sleep(10);
          return { structured: holdout };
        }
        if (role === "review") return { structured: approve };
        if (role === "verify") return { structured: pass };
        implementStarted = true;
        expect(
          s.prompt.includes(
            "A separate verifier will check private scenarios derived from the request, including edge and failure cases",
          ),
        ).toBe(profile !== "quick");
        return {
          files: { "farewell.txt": "goodbye\n", "implementation-marker.txt": "implementation marker" },
        };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file", profile });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(holdoutCalls).toBe(profile === "quick" ? 0 : 1);
      if (profile !== "quick") {
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

  test("completed holdout survives a stopped factory and is reused after restart", async () => {
    let holdoutCalls = 0;
    let blockImplement = true;
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
        return { structured: pass };
      }
      return blockImplement ? { delayMs: 30_000 } : { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.holdoutStatus !== "complete" ||
        f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("complete");
    await f.stop();
    f.store.close();
    blockImplement = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(1);
    expect(restarted.store.getRunState<RunState>(run.id)?.holdout?.scenarios).toEqual(holdout.scenarios);
  });

  test("interrupted holdout is retried after restart and remains unpublished while stopped", async () => {
    let holdoutCalls = 0;
    let slow = true;
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCalls++;
        return slow ? { structured: holdout, delayMs: 30_000 } : { structured: holdout };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (f.store.getRunState<RunState>(run.id)?.holdoutStatus !== "generating" && Date.now() < deadline)
      await Bun.sleep(10);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("generating");
    await f.stop();
    expect(f.store.listArtifacts(run.id).map((a) => a.name)).not.toContain("holdout-scenarios.json");
    f.store.close();
    slow = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(2);
    expect(restarted.store.getArtifact(run.id, "holdout-scenarios.json")).toContain("H-3");
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
      if (implementCalls === 2) expect(s.prompt).toContain("H-3");
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(2);
    expect(verifyCalls).toBe(2);
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
      ...(label ? { label } : {}),
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
                        ...(reviews === 2 ? { label } : {}),
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
                              label: "new",
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
                        label: "new",
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
                        label: "regression",
                        file: "farewell.txt",
                        line: 1,
                        title: "Regression",
                        detail: "regressed",
                        suggestion: "fix",
                      },
                      {
                        severity: "major",
                        security: false,
                        label: "new",
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
                        label: "unaddressed",
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
    expect(prompts[3]).toContain("Backlog idea");
    expect(implementsCount).toBe(5); // Includes the interrupted implementation and the unmatched claim fix.
    expect(restarted.store.getArtifact(run.id, "review-2.json")).toContain('"verdict": "request_changes"');
    expect(restarted.store.getRunState<RunState>(run.id)?.reviewFollowUps).toHaveLength(1);
    expect(restarted.store.getArtifact(run.id, "report.md")).toContain("Backlog idea");
  });

  for (const restartRound of [0, 1]) {
    test(`restart during verify preserves review policy and replaces round ${restartRound} follow-ups`, async () => {
      let implementations = 0;
      let slow = true;
      let verifyStarted = false;
      let resumedVerifies = 0;
      const prompts: string[] = [];
      const finding = (title: string, label = "new") => ({
        severity: "major",
        security: false,
        label,
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
      // Replaying checks must use the same earlier round's context, never its own review.
      expect(prompts[restartRound + 1]).toBe(prompts[restartRound]);
      const state = resumed.store.getRunState<RunState>(run.id);
      expect(implementations).toBe(restartRound === 0 ? 2 : 3);
      expect(state?.reviewHistory?.map((entry) => entry.round)).toEqual(
        restartRound === 0 ? [0, 1] : [0, 1, 2],
      );
      if (restartRound === 0) {
        expect(resumed.store.getArtifact(run.id, "review-0.json")).toContain('"verdict": "request_changes"');
        expect(state?.reviewFollowUps).toEqual([]);
      } else {
        expect(state?.reviewFollowUps?.map((f) => f.title)).toEqual(["Backlog idea"]);
        const followUps = resumed.store.getArtifact(run.id, "report.md")?.split("## Review follow-ups")[1];
        expect(followUps?.match(/^- major: `farewell\.txt:1` Backlog idea/gm)).toHaveLength(1);
        expect(followUps).not.toContain("Obsolete follow-up");
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

test("drain blocks queued starts across ticks and completion without pausing active stages", async () => {
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
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    await Bun.sleep(10);
    expect(f.scheduler.activeRunIds).toEqual([]);
    expect(calls).toBe(1);
    expect(f.store.getRunDetail(first.id)?.stages.map((s) => s.name)).toContain("review");
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([]);
    f.scheduler.resume();
    f.scheduler.resume();
    expect(f.scheduler.activeRunIds.length).toBe(f.cfg.maxConcurrentRuns);
    expect(f.scheduler.activeRunIds.length).toBeLessThanOrEqual(f.cfg.maxConcurrentRuns);
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

test("pipeline fallback records each effort and reloads the exact implementer preference", async () => {
  const { evalFixture, enableEfforts, answer } = await import("./evals-support.ts");
  const { RunContext } = await import("../src/pipeline/context.ts");
  const { Router } = await import("../src/router/router.ts");
  const { createHttpRoutes } = await import("../src/server/http.ts");
  const { requestWithParams } = await import("./mcp-support.ts");
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
    context.save();
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
      {} as import("bun").Server<undefined>,
    );
    expect(await response.json()).toMatchObject({ invocations: [{ effort: "low" }, { effort: "high" }] });
    // Old run state without a targetId still loads and resolves its bare preference.
    loaded.state.implementer = { modelId: model.id, tier: model.tier, vendor: model.vendor };
    loaded.save();
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

for (const path of [
  "blocked",
  "passes",
  "retry-unmet",
  "initial-unmet",
  "unclear",
  "no-alternative",
] as const) {
  test(`environment verification retry: ${path}`, async () => {
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
