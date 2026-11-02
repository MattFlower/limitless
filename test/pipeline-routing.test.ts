import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { headSha } from "../src/git/repos.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";
import { fakeConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import {
  approve,
  type Handler,
  holdout,
  models,
  pass,
  pipelineSetup,
  policy,
  providers,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub } = pipelineSetup({
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

describe("pipeline (fake agents, real git + gates)", () => {
  test.each([
    [undefined, "claude/opus"],
    [false, "codex/sol-6.1"],
  ] as const)("single review vendor avoidance %s routes to %s", async (avoid, reviewer) => {
    const configDir = join(home, "cfg");
    mkdirSync(configDir);
    if (avoid !== undefined)
      writeFileSync(join(configDir, "config.toml"), `[review]\navoid_implementer_vendor = ${avoid}\n`);
    const chain = { default: ["codex/sol-6.1", "claude/opus"] };
    const f = new Factory(loadConfig({ home: join(home, "data"), configDir }), {
      loadSource: () => 0,
      confinement: fakeConfinement,
      harnesses: {
        fake: fakeHarness((s) => {
          const role = roleOf(s);
          if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
          if (role === "review") return { structured: approve };
          return { files: { "farewell.txt": "goodbye\n" } };
        }),
      },
      providers: providers.map((p, i) => ({ ...p, id: i === 0 ? "codex" : "claude" })),
      models: models.map((m, i) => ({
        ...m,
        id: i === 0 ? "codex/sol-6.1" : "claude/opus",
        provider: i === 0 ? "codex" : "claude",
        vendor: i === 0 ? "openai" : "anthropic",
      })),
      policy: {
        ...policy,
        triage: chain,
        spec: chain,
        holdout: chain,
        implement: chain,
        review: chain,
        verify: chain,
      },
      bootSha: "test-build",
    });
    factory = f;
    f.start();
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.modelId),
    ).toEqual(["codex/sol-6.1"]);
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "review")
        .map((i) => i.modelId),
    ).toEqual([reviewer, reviewer]);
    const messages = f.store.listEvents(run.id).map((e) => e.message);
    expect(messages).not.toContain("Review done by the implementer's vendor (no other vendor available)");
    expect(
      messages.filter(
        (m) =>
          m ===
          (avoid === false
            ? "review: same-vendor allowed by config"
            : "review: avoiding implementer's vendor"),
      ),
    ).toHaveLength(1);
  });

  test.each([
    ["sticks with it", 1, "alpha/m"],
    ["escalates beyond it", 2, "beta/m"],
  ])(
    "a run restarted on an implementer since removed from the catalog routes to an available model when it %s",
    async (_, roundsOnImplementer, next) => {
      let reviews = 0;
      const blocker = {
        severity: "major" as const,
        security: false,
        ...findingEvidence,
        file: "farewell.txt",
        line: 1,
        title: "First blocker",
        detail: "First blocker",
        suggestion: "Fix",
      };
      const handler: Handler = (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review")
          return { structured: { ...approve, findings: ++reviews === 1 ? [blocker] : [] } };
        return { files: { "farewell.txt": `goodbye ${reviews}\n` } };
      };
      const f = start(handler);
      // Round 1 starts after a restart from state saved when the run was on GPT-6 Astra.
      f.deps.faults = {
        "stage:implement:before": {
          action: "kill",
          occurrence: 2,
          onHit: ({ runId }) => {
            const state = f.store.getRunState<RunState>(runId);
            if (!state) throw new Error("missing run state");
            const astra = { modelId: "codex/astra", effort: "high" as const };
            state.implementer = { ...astra, targetId: "codex/astra@high", tier: 5, vendor: "openai" };
            state.triedImplementers.push(astra);
            state.roundsOnImplementer = roundsOnImplementer;
            f.store.setRunState(runId, state);
          },
        },
      };
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      const deadline = Date.now() + 10_000;
      while (
        f.store
          .listStages(run.id)
          .filter((s) => s.name === "implement")
          .at(-1)?.status !== "cancelled"
      ) {
        if (Date.now() > deadline) throw new Error("implement interruption timed out");
        await Bun.sleep(10);
      }
      await f.stop();
      f.store.close();
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const implemented = resumed.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.modelId);
      expect(implemented).toEqual(["alpha/m", next]);
      expect(resumed.store.getRunState<RunState>(run.id)?.implementer?.modelId).toBe(next);
      const escalated = resumed.store
        .listEvents(run.id)
        .some((e) => e.message === "Escalating implementer beyond codex/astra");
      expect(escalated).toBe(roundsOnImplementer === 2);
    },
  );

  test("an in-flight run picks up an operator cell and leaves its removed sticky implementer", async () => {
    const reached = deferred<void>();
    const resume = deferred<void>();
    const invoked: string[] = [];
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      invoked.push(s.target.modelId);
      if (invoked.length === 1) {
        reached.resolve();
        await resume.promise;
      }
      return { files: { "farewell.txt": invoked.length === 1 ? "BAD goodbye\n" : "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    await reached.promise;
    f.routing.setCell("implement", "small", ["beta/m"], "subscription depleted");
    resume.resolve();
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(invoked).toEqual(["alpha/m", "beta/m"]);
    expect(f.store.getRunState<RunState>(run.id)?.implementer?.modelId).toBe("beta/m");
  });

  test("an escalation selected after a live edit stays sticky on the fourth round", async () => {
    const reached = deferred<void>();
    const resume = deferred<void>();
    const invoked: string[] = [];
    const f = start(
      async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") return { structured: approve };
        invoked.push(s.target.modelId);
        if (invoked.length === 1) {
          reached.resolve();
          await resume.promise;
        }
        return { files: { "farewell.txt": invoked.length < 4 ? "BAD goodbye\n" : "goodbye\n" } };
      },
      false,
      true,
    );
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    await reached.promise;
    f.routing.setCell("implement", "small", ["alpha/m"]);
    resume.resolve();
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(invoked).toEqual(["alpha/m", "alpha/m", "delta/m", "delta/m"]);
    expect(f.store.getRunState<RunState>(run.id)?.implementer).toMatchObject({
      modelId: "delta/m",
      policyRevision: f.router.cellRevision("implement", "small"),
    });
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
});

describe("pipeline (fake agents, real git + gates)", () => {
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
});

describe("pipeline (fake agents, real git + gates)", () => {
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
    confinement: fakeConfinement,
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

test.each([
  ["authentication", "quota"],
  ["confinement", "authentication"],
] as const)(
  "worker %s fallback retires before local %s and the next candidate",
  async (workerFailure, localFailure) => {
    const bare = await githubFixture();
    const implementers: string[] = [];
    let adopted: RunState | undefined;
    let reloaded: RunState | undefined;
    const handler = (s: AgentSpec): FakeReply => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      implementers.push(s.target.provider);
      if (s.target.provider === "alpha")
        return {
          files: { "partial.txt": "keep these edits\n" },
          ...(localFailure === "quota"
            ? { status: "quota", error: "Quota exhausted" }
            : { status: "unavailable", failureClass: "authentication", error: "Login rejected" }),
        };
      expect(readFileSync(join(s.cwd, "partial.txt"), "utf8")).toBe("keep these edits\n");
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler, false, false, {
      providers: providers.map((p) => ({ ...p, harness: "claude" })),
      harnesses: { claude: fakeHarness(handler) },
      agentExecutor: {
        kind: "test",
        async run(call, local) {
          if (call.role !== "implement") return local();
          const hooks = call.publication;
          if (!hooks) throw new Error("Missing publication hooks");
          call.publication = {
            ...hooks,
            async adopt(sha, request) {
              await hooks.adopt(sha, request);
              adopted = f.store.getRunState<RunState>(call.runId) ?? undefined;
            },
          };
          return lanAgentExecutor(f.workers, f.cfg).run(call, async () => {
            if (call.spec.target.provider === "alpha") {
              const run = f.store.getRun(call.runId);
              const repo = run && f.store.getRepo(run.repoId);
              if (!run || !repo || !adopted?.agentJob) throw new Error("Missing worker state");
              reloaded = new RunContext(f.deps, run, repo, call.spec.signal).state;
              expect(f.workers.agentJob(adopted.agentJob.id)).toMatchObject({ state: "done" });
            }
            return local();
          });
        },
      },
    });
    f.cfg.workers.agents = ["implement"];
    f.cfg.workers.repos = ["test/repo"];
    registerGithub(f, bare);
    const enqueue = f.workers.enqueueAgentJob.bind(f.workers);
    const queued = spyOn(f.workers, "enqueueAgentJob").mockImplementation((request, id) => {
      const job = enqueue(request, id);
      if (!job) throw new Error("Missing worker job");
      f.store.db.query("UPDATE agent_jobs SET state='leased' WHERE id=?").run(job);
      expect(
        f.workers.completeAgentJob(
          job,
          {
            status: "unavailable",
            ...(workerFailure === "authentication"
              ? { failureClass: "authentication" }
              : {
                  confinement: {
                    ok: false,
                    path: null,
                    version: null,
                    reason: "probe inconclusive",
                    exitCode: 1,
                  },
                }),
            error: "Worker could not start",
            finalText: "",
            structured: null,
            sessionId: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            numTurns: 0,
            costUsd: 0,
            costEquivUsd: 0,
            quota: null,
            sha: request.parentSha,
            parentSha: request.parentSha,
            branch: request.branch,
            privateStringsDigest: request.privateStringsDigest,
          },
          request.parentSha,
        ),
      ).toBe(true);
      return job;
    });
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    const status = await waitFor(f, run.id, ["succeeded", "needs_human", "failed"]);
    expect(f.store.getRun(run.id)?.error).toBeNull();
    expect(status).toBe("succeeded");
    expect(implementers).toEqual(["alpha", "beta"]);
    expect(reloaded).toBeDefined();
    expect(reloaded?.agentJob).toBeUndefined();
    expect(reloaded?.publishedSha).toBe(adopted?.publishedSha);
    expect(reloaded?.workerCommitRound).toBe(adopted?.workerCommitRound);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(f.store.listStages(run.id).filter((s) => s.name === "implement")).toMatchObject([
      { round: 0, status: "succeeded" },
    ]);
  },
);

test("authentication exhaustion fails implementation without consuming a round or checking unchanged code", async () => {
  let before = "";
  const f = start(
    (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      return { status: "error", failureClass: "authentication", error: "authentication rejected" };
    },
    false,
    false,
    {
      agentExecutor: {
        kind: "capture",
        async run(call, local) {
          if (call.role === "implement") {
            before ||= await headSha(call.spec.cwd);
          }
          return local();
        },
      },
    },
  );
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(f, run.id, ["needs_human", "succeeded", "failed"])).toBe("needs_human");
  expect(f.store.getRun(run.id)?.error).toContain("authentication rejected");
  const state = f.store.getRunState<RunState>(run.id);
  if (!state?.worktreePath) throw new Error("missing worktree");
  expect(state).toMatchObject({ round: 0, roundsOnImplementer: 0 });
  expect(state.implementationReadyRound).toBeUndefined();
  expect(state.implementedRound).toBeUndefined();
  expect(state.gateEvidence).toBeUndefined();
  expect(before).toBe(f.store.getRun(run.id)?.baseSha ?? "missing base");
  expect(await headSha(state.worktreePath)).toBe(before);
  const stages = f.store.listStages(run.id);
  expect(stages.filter((s) => s.name === "implement")).toMatchObject([
    { round: 0, status: "failed", summary: expect.stringContaining("authentication rejected") },
  ]);
  expect(stages.filter((s) => ["gates", "verify", "review"].includes(s.name))).toEqual([]);
  expect(f.store.listInvocations(run.id).filter((i) => i.role === "implement")).toMatchObject([
    { provider: "alpha", status: "unavailable", error: "authentication rejected" },
    { provider: "beta", status: "unavailable", error: "authentication rejected" },
  ]);
  expect(f.store.listEvents(run.id).some((e) => e.message.includes("implementation-ready"))).toBe(false);
  expect(f.store.listArtifacts(run.id).some((a) => a.name.startsWith("implement-"))).toBe(false);
});

test("a resumed near-limit run completes the same round after authentication fallback", async () => {
  const handler: Handler = (s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify") return { structured: pass };
    if (s.target.provider === "alpha")
      return { status: "error", failureClass: "authentication", error: "authentication rejected" };
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const f = start(handler, false, false, { faults: { "stage:implement:before": { action: "kill" } } });
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  const deadline = Date.now() + 10_000;
  while (!f.store.listStages(run.id).some((s) => s.name === "implement" && s.status === "cancelled")) {
    if (Date.now() > deadline) throw new Error("implement interruption timed out");
    await Bun.sleep(10);
  }
  await f.stop();
  const state = f.store.getRunState<RunState>(run.id);
  if (!state?.worktreePath) throw new Error("missing state");
  const before = await headSha(state.worktreePath);
  const round = f.cfg.maxRounds + 1;
  state.round = round;
  state.roundsOnImplementer = 1;
  state.implementer = { modelId: "alpha/m", tier: 4, vendor: "anthropic" };
  state.triedImplementers = ["alpha/m"];
  f.store.setRunState(run.id, state);
  f.store.close();
  factory = null;
  const resumed = start(handler);
  expect(await waitFor(resumed, run.id, ["succeeded", "needs_human", "failed"])).toBe("succeeded");
  const after = resumed.store.getRunState<RunState>(run.id);
  const head = resumed.store.getRun(run.id)?.headSha;
  if (!head) throw new Error("missing implementation commit");
  expect(after).toMatchObject({
    round,
    roundsOnImplementer: 1,
    implementedRound: round,
    implementationReadyRound: round,
  });
  expect(head).toBeString();
  expect(head).not.toBe(before);
  expect(after?.gateEvidence?.sha).toBe(head);
  expect(after?.lastVerifiedSha).toBe(head);
  expect(after?.gateEvidence?.changedFiles).toContain("farewell.txt");
  const invocations = resumed.store.listInvocations(run.id);
  expect(invocations.filter((i) => i.role === "implement").map((i) => [i.provider, i.status])).toEqual([
    ["alpha", "unavailable"],
    ["beta", "ok"],
  ]);
  const stages = resumed.store.listStages(run.id);
  expect(stages.filter((s) => s.name === "implement" && s.status === "succeeded")).toMatchObject([{ round }]);
  expect(
    stages
      .filter((s) => ["gates", "verify", "review"].includes(s.name))
      .every((s) => s.round === round && s.status === "succeeded"),
  ).toBe(true);
  expect(resumed.store.listEvents(run.id).some((e) => e.message.includes("Escalating implementer"))).toBe(
    false,
  );
});
