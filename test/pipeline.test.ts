import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RunStatus, StageName } from "../src/core/types.ts";
import { completeMerge, mergeGit, prepareMerge } from "../src/git/merge.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { githubWebhook } from "../src/integrations/github.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun, readingTimeout } from "../src/pipeline/engine.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { LaterReviewSchema, ReviewSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";
import { findingEvidence } from "./review-support.ts";

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
  }, 30_000);

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
          fault === "markers" || fault === "partial"
            ? "Unresolved conflict markers: greeting.txt"
            : fault === "fixture"
              ? "Unresolved conflict markers: markers.fixture"
              : fault === "stray"
                ? "Unresolved conflict markers: new.txt, README.md"
                : "MERGE_HEAD",
        );
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
  ])(
    "verify-change: %s",
    async (scenario) => {
      const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: repoDir })).stdout.trim();
      const commit = async () => {
        await git("add", ".");
        await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
        return git("rev-parse", "HEAD");
      };
      const records = join(home, "gate-revisions");
      writeFileSync(
        join(repoDir, ".limitless.toml"),
        `[gates]
checks = [{ name = "test", run = "git rev-parse HEAD >> ${records}; echo generated > generated.txt; ! grep BAD greeting.txt" }]
[policy]
protected_paths = ["protected.txt"]
`,
      );
      if (scenario === "baseline") writeFileSync(join(repoDir, "greeting.txt"), "BAD\n");
      const base = await commit();
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
          return { structured: approve };
        }
        expect(role).toBe("implement");
        implementations++;
        expect(agent.prompt).toContain(
          scenario === "gates"
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
      const blocked = ["persistent", "repair-audit", "empty"].includes(scenario);
      expect(await waitFor(f, runId, ["succeeded", "failed", "needs_human"])).toBe(
        blocked ? "needs_human" : "succeeded",
      );
      stopNotifier();
      const state = f.store.getRunState<RunState>(runId);
      expect(state?.flow).toBe("verify-change");
      expect(f.store.getRunDetail(runId)?.run.flow).toBe("verify-change");
      const revisions = readFileSync(records, "utf8").trim().split("\n");
      expect(revisions.slice(0, 2)).toEqual([baseTip, head]);
      const remote = (await git("ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).split("\t")[0];
      const unchanged = ["approve", "baseline", "restart-initial"].includes(scenario);
      expect(remote).toBe(unchanged || blocked ? head : (f.store.getRun(runId)?.headSha ?? "missing"));
      if (unchanged) {
        expect(implementations).toBe(0);
        expect(f.store.listStages(runId).some((stage) => stage.name === "implement")).toBe(false);
        expect(f.store.getRun(runId)?.headSha).toBe(head);
        expect(existsSync(state?.worktreePath ?? "missing")).toBe(false);
        expect(calls).toHaveLength(1); // Evidence only: no creation comment and no second verdict.
        expect(calls[0]?.slice(0, 3)).toEqual(["pr", "comment", "18"]);
        expect(calls[0]?.at(-1)).not.toContain("generated.txt");
        for (const text of [
          "Flow: verify-change",
          "| Check |",
          "LGTM",
          "Work log",
          "Total:",
          "spent",
          "subscriptions",
        ])
          expect(calls[0]?.at(-1)).toContain(text);
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
    let holdoutCalls = 0;
    let implementations = 0;
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
      implementations++;
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
    f.scheduler.drain();
    expect(f.scheduler.activeRunIds).toEqual([run.id]);
    // Simulate a deploy deadline expiring while implement is still in flight.
    await f.stop();
    expect(f.store.getRun(run.id)?.status).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.implementedRound).toBeUndefined();
    expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.status).toBe("cancelled");
    f.store.close();
    blockImplement = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(1);
    expect(implementations).toBe(2);
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
