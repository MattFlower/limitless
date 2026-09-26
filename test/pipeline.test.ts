import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    tier: 4,
    price: { input: 1, output: 1 },
  },
  {
    id: "beta/m",
    provider: "beta",
    model: "beta-1",
    vendor: "openai",
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
    { id: "AC-1", status: "met", evidence: "cat shows goodbye" },
    ...holdout.scenarios.map((s) => ({ id: s.id, status: "met", evidence: "observed expected result" })),
  ],
  overall: "pass",
  notes: "",
};

function start(handler: Handler): Factory {
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  factory = new Factory(cfg, {
    harnesses: { fake: fakeHarness(handler) },
    providers,
    models,
    policy,
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
      '#!/bin/sh\ncase "$2" in\n  list) exit 0 ;;\n  create) echo https://github.com/test/repo/pull/1 ;;\nesac\n',
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

  for (const kind of [
    "unchanged",
    "clean",
    "clean-scripts",
    "regressed",
    "conflict",
    "conflict-scripts",
    "rewritten",
  ] as const) {
    test(`GitHub delivery handles ${kind} base`, async () => {
      const conflict = kind === "conflict" || kind === "conflict-scripts";
      const changedScripts = kind === "clean-scripts" || kind === "conflict-scripts";
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
      const bare = await githubFixture();
      let baseTip = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      const originalBase = baseTip;
      let implementCalls = 0;
      let reviews = 0;
      let verifies = 0;
      let mergePrompt = "";
      let checkedHead = "";
      const f = start(async (s) => {
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
          expect((await sh(["git", "status", "--porcelain"], { cwd: s.cwd })).stdout).toBe("");
          expect(
            (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
              .stdout,
          ).toBe("");
          const merge = await sh(
            ["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", `origin/main`],
            { cwd: s.cwd, allowFail: true },
          );
          expect(merge.exitCode).not.toBe(0);
          writeFileSync(join(s.cwd, "greeting.txt"), "hello from both intents\nnew base\n");
          await sh(["git", "add", "greeting.txt"], { cwd: s.cwd });
          await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "resolve merge"], {
            cwd: s.cwd,
          });
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
      const blocked = kind === "regressed" || kind === "rewritten";
      expect(status).toBe(blocked ? "failed" : "succeeded");
      const finished = f.store.getRun(run.id);
      const stages = f.store.listStages(run.id).map((s) => s.name);
      const gates = stages.filter((s) => s === "gates").length;
      expect(gates).toBe(kind === "unchanged" || kind === "rewritten" ? 1 : 2);
      expect(stages.filter((s) => s === "audit")).toHaveLength(conflict ? 2 : 1);
      expect(implementCalls).toBe(conflict ? 2 : 1);
      expect(reviews).toBe(conflict ? 2 : 1);
      expect(verifies).toBe(conflict ? 2 : 1);
      if (conflict) {
        expect(mergePrompt).toContain("git merge origin/main");
        expect(stages.slice(-6)).toEqual(["implement", "gates", "audit", "review", "verify", "deliver"]);
        expect(f.store.getArtifact(run.id, "diff.patch")).not.toContain("+new base");
      }
      if (blocked) {
        expect(finished?.baseSha).toBe(originalBase);
        if (kind === "regressed")
          expect(f.store.getArtifact(run.id, "gates-rebase-0.json")).toContain("regressed");
        else expect(finished?.error).toContain("base branch no longer descends from the recorded base");
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
      if (blocked)
        expect(
          (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
            .stdout,
        ).toBe("");
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
    const privateHoldout = {
      scenarios: holdout.scenarios.map((s) =>
        s.id === "H-2"
          ? {
              ...s,
              steps: `run ${secret}`,
              description: `secret ${secret} check`,
              expected: `result ${secret}`,
            }
          : s,
      ),
    };
    let implementCalls = 0;
    let verifies = 0;
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
        return verifies === 1
          ? {
              text: `ordinary verifier diagnostic; private input ${secret}`,
              error: `verifier diagnostic included ${secret}`,
              structured: {
                ...pass,
                criteria: pass.criteria.map((c) =>
                  c.id === "H-2"
                    ? {
                        ...c,
                        status: "unmet",
                        evidence: `Observed failure: ${secret} returned an empty response`,
                      }
                    : c,
                ),
              },
            }
          : { structured: pass };
      }
      implementCalls++;
      if (implementCalls === 2) {
        expect(s.prompt).toContain("Observed failure");
        expect(s.prompt).not.toContain(secret);
        expect(s.prompt).not.toContain(privateHoldout.scenarios[1]?.steps);
        expect(f.store.getRunState<RunState>(runId)?.feedback).not.toContain(secret);
        expect(f.store.listArtifacts(runId).map((a) => a.name)).not.toContain("holdout-scenarios.json");
        expect(f.store.getArtifact(runId, "verify-0.json")).toContain("Observed failure");
        expect(f.store.getArtifact(runId, "verify-0.json")).not.toContain(secret);
        expect(existsSync(join(s.cwd, "holdout-scenarios.json"))).toBe(false);
        for (const artifact of f.store.listArtifacts(runId))
          expect(f.store.getArtifact(runId, artifact.name)).not.toContain(secret);
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(2);
    expect(f.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
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
          ? { ...criterion, status: "unmet", evidence: `Observed empty output for ${secret}` }
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
