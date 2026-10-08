import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
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

describe("pipeline (fake agents, real git + gates)", () => {
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
