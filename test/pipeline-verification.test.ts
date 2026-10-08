import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { RunStatus } from "../src/core/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
import { approve, holdout, pass, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";

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

for (const evidence of [
  "matching",
  "suite",
  "absent",
  "unrelated",
  "different-sha",
  "prior-round",
  "resume",
  "resume-other-sha",
  "resume-retried",
  "resume-failed-stage",
] as const) {
  test(`loopback verification uses confined gate evidence: ${evidence}`, async () => {
    mkdirSync(join(repoDir, "test"));
    writeFileSync(
      join(repoDir, "test/loopback.test.ts"),
      `import { expect, test } from "bun:test";
test("loopback server", () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  try { expect(server.port).toBeGreaterThan(0); } finally { server.stop(true); }
  ${evidence === "suite" ? 'console.error("x".repeat(8000));' : ""}
});\n`,
    );
    const command = evidence === "suite" ? "bun run test" : "bun test test/loopback.test.ts";
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      evidence === "absent"
        ? "[gates]\nchecks = []\n"
        : evidence === "unrelated"
          ? `[gates]\nchecks = [{ name = "unrelated", run = "true" }]\n`
          : `[gates]\nchecks = [{ name = "test", run = "${command}" }]\n`,
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "commit", "-qm", "loopback gate fixture"], { cwd: repoDir });
    let attempts = 0;
    let initialGateSha = "";
    let priorGates: RunState["gateEvidence"];
    const loopbackSpec = {
      ...spec,
      acceptance_criteria: [
        {
          id: "AC-1",
          criterion: "loopback-server test passes",
          how_to_verify: "bun test test/loopback.test.ts",
        },
      ],
    };
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: loopbackSpec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") {
        if (evidence === "different-sha") {
          initialGateSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
          await sh(["git", "commit", "--allow-empty", "-qm", "advance after gates"], { cwd: s.cwd });
        }
        return { structured: approve };
      }
      if (role === "verify") {
        attempts++;
        if (evidence === "prior-round" && attempts === 1) {
          const runId = f.store.listRuns()[0]?.id;
          const prior = runId ? f.store.getRunState<RunState>(runId) : null;
          initialGateSha = prior?.gateEvidence?.sha ?? "";
          priorGates = prior?.gateEvidence;
          return {
            structured: {
              ...pass,
              overall: "fail",
              criteria: pass.criteria.map((c) =>
                c.id === "H-1"
                  ? { ...c, status: "unmet", evidence: "wrong output", publicSummary: "wrong output" }
                  : c,
              ),
            },
          };
        }
        return {
          structured: {
            ...pass,
            overall: "fail",
            criteria: pass.criteria.map((c) =>
              c.id === "AC-1"
                ? {
                    ...c,
                    status: "blocked",
                    blockedReason: "sandbox",
                    evidence: "bun test test/loopback.test.ts: EPERM listen 127.0.0.1:0",
                  }
                : c,
            ),
          },
        };
      }
      return {
        files: {
          "farewell.txt": `goodbye\n${evidence === "prior-round" && attempts ? "next commit\n" : ""}`,
        },
      };
    });
    const resume = evidence.startsWith("resume");
    if (resume) f.deps.faults = { "stage:verify:after": { action: "kill", occurrence: 1 } };
    // Exercise stale evidence retained from an earlier round while the next round has a new SHA.
    if (evidence === "prior-round")
      f.deps.faults = { "stage:verify:before": { action: "kill", occurrence: 2 } };
    const interrupted = deferred<void>();
    const unsubscribe = f.store.subscribe((message) => {
      if (message.kind === "stage" && message.stage.status === "cancelled") interrupted.resolve();
    });
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell with a passing loopback-server test",
      profile: "standard",
    });
    let terminal: RunStatus;
    if (resume || evidence === "prior-round") {
      await interrupted.promise;
      await f.stop();
      const state = f.store.getRunState<RunState>(run.id);
      expect(state).not.toBeNull();
      if (state && resume) {
        const recorded = state.verifyResults?.at(-1);
        const original = recorded?.modelOutput?.criteria.find((c) => c.id === "AC-1");
        expect(original).toMatchObject({
          status: "blocked",
          blockedReason: "sandbox",
          evidence: "bun test test/loopback.test.ts: EPERM listen 127.0.0.1:0",
        });
        expect(original?.gateEvidence).toBeUndefined();
        expect(recorded?.criteria.find((c) => c.id === "AC-1")).toMatchObject({
          status: "met",
          gateEvidence: { stageId: state.gateEvidence?.stageId },
        });
        expect(f.store.getArtifact(run.id, "verify-0.json")).not.toContain("modelOutput");
        if (evidence === "resume-other-sha" && state.gateEvidence) state.gateEvidence.sha = "b".repeat(40);
        if (evidence === "resume-retried") {
          const check = state.gateEvidence?.checks[0];
          if (!check) throw new Error("missing gate check");
          check.firstAttempt = { ...check.result };
        }
        if (evidence === "resume-failed-stage")
          f.store.finishStage(state.gateEvidence?.stageId ?? -1, "failed", "gate record invalidated");
        f.store.setRunState(run.id, state);
      }
      if (state && evidence === "prior-round") {
        expect(priorGates).toBeDefined();
        state.gateEvidence = priorGates;
        f.store.setRunState(run.id, state);
      }
      f.deps.faults = undefined;
      terminal = await executeRun(f.deps, run.id, new AbortController().signal);
    } else terminal = await waitFor(f, run.id, ["succeeded", "needs_human", "failed"]);
    unsubscribe();
    const succeeds = ["matching", "suite", "resume"].includes(evidence);
    expect(terminal).toBe(succeeds ? "succeeded" : "needs_human");
    const state = f.store.getRunState<RunState>(run.id);
    const result = state?.lastVerify?.criteria.find((c) => c.id === "AC-1");
    if (succeeds) {
      const gate = state?.gateEvidence;
      expect(result?.status).toBe("met");
      expect(gate?.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(result?.evidence).toContain(`Factory gate test passed at ${gate?.sha} (stage ${gate?.stageId})`);
      expect(result?.gateEvidence?.stageId).toBe(gate?.stageId);
      expect(f.store.getStage(gate?.stageId ?? -1)?.status).toBe("succeeded");
      expect(f.store.getArtifact(run.id, "verify-0.json")).toContain(
        `Factory gate test passed at ${gate?.sha} (stage ${gate?.stageId})`,
      );
      expect(attempts).toBe(1);
    } else {
      expect(result?.status).toBe("blocked");
      expect(result?.gateEvidence).toBeUndefined();
      if (resume) {
        expect(state?.verifyResults?.[0]?.criteria.find((c) => c.id === "AC-1")?.status).toBe("blocked");
        expect(result?.evidence).toContain("Factory gate substitution unavailable");
      }
      expect(f.store.getRun(run.id)?.error).toContain("verification blocked by the environment");
      if (initialGateSha) expect(state?.verifyResults?.at(-1)?.sha).not.toBe(initialGateSha);
    }
  });
}

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
      // Readers and edit-mode implementers alike get a scratch owned and removed by their call.
      if (role === "review" || role === "verify" || role === "implement") {
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
