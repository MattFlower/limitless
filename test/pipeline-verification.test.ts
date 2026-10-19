import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { RunStatus } from "../src/core/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
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

// Each refusal reason (no gate stage, no checks, a non-test or unrelated gate, another SHA, a
// retried pass) is unit-tested in gate-evidence.test.ts; these rows cover the engine and resume.
for (const evidence of [
  "matching",
  "suite",
  "different-sha",
  "resume",
  "resume-redacted",
  "resume-failed-stage",
] as const) {
  test(`loopback verification uses confined gate evidence: ${evidence}`, async () => {
    // Fixture gates use this runtime, independently of the agent's slotted command shims.
    process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
    const secret = "synthetic-verification-artifact-549";
    const gateName = evidence === "resume-redacted" ? `\x1b[31m${secret}` : "test";
    if (evidence === "resume-redacted") registerCredential("verify-artifact-test", secret);
    mkdirSync(join(repoDir, "test"));
    writeFileSync(
      join(repoDir, "test/loopback.test.ts"),
      // The redaction case checks artifacts, so its gate must also pass where listening is denied.
      evidence === "resume-redacted"
        ? `import { expect, test } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n`
        : `import { expect, test } from "bun:test";
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
      `[gates]\nchecks = [{ name = ${JSON.stringify(gateName)}, run = "${command}" }]\n`,
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "commit", "-qm", "loopback gate fixture"], { cwd: repoDir });
    let attempts = 0;
    let initialGateSha = "";
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
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const resume = evidence.startsWith("resume");
    if (resume) f.deps.faults = { "stage:verify:after": { action: "kill", occurrence: 1 } };
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
    if (resume) {
      await interrupted.promise;
      await f.stop();
      const state = f.store.getRunState<RunState>(run.id);
      expect(state).not.toBeNull();
      if (state) {
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
        if (evidence === "resume-failed-stage")
          f.store.finishStage(state.gateEvidence?.stageId ?? -1, "failed", "gate record invalidated");
        f.store.setRunState(run.id, state);
      }
      f.deps.faults = undefined;
      terminal = await executeRun(f.deps, run.id, new AbortController().signal);
    } else terminal = await waitFor(f, run.id, ["succeeded", "needs_human", "failed"]);
    unsubscribe();
    const succeeds = ["matching", "suite", "resume", "resume-redacted"].includes(evidence);
    expect(terminal).toBe(succeeds ? "succeeded" : "needs_human");
    const state = f.store.getRunState<RunState>(run.id);
    const result = state?.lastVerify?.criteria.find((c) => c.id === "AC-1");
    if (succeeds) {
      const gate = state?.gateEvidence;
      expect(result?.status).toBe("met");
      expect(gate?.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(result?.evidence).toContain(
        `Factory gate ${gateName} passed at ${gate?.sha} (stage ${gate?.stageId})`,
      );
      expect(result?.gateEvidence?.stageId).toBe(gate?.stageId);
      expect(f.store.getStage(gate?.stageId ?? -1)?.status).toBe("succeeded");
      expect(f.store.getArtifact(run.id, "verify-0.json")).toContain(
        `Factory gate ${evidence === "resume-redacted" ? "[redacted]" : "test"} passed at ${gate?.sha} (stage ${gate?.stageId})`,
      );
      if (evidence === "resume-redacted") {
        const artifact = JSON.parse(f.store.getArtifact(run.id, "verify-0.json") ?? "null");
        expect(artifact.criteria[0].gateEvidence.check).toBe("[redacted]");
        expect(JSON.stringify(artifact)).not.toContain(secret);
        expect(JSON.stringify(artifact)).not.toContain("\\u001b");
        expect(result?.gateEvidence?.check).toBe(gateName);
        expect(state?.gatesConfig?.checks[0]?.name).toBe(gateName);
      }
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

test("Linux checks skipped on simulated macOS deliver an environment-blocked round", async () => {
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
  mkdirSync(join(repoDir, "test"));
  writeFileSync(
    join(repoDir, "test/linux.test.ts"),
    `import { expect, test } from "bun:test";
const platform = () => "darwin"; // Simulate macOS on either host platform.
test("fixture loads", () => expect(true).toBe(true));
test.skipIf(platform() !== "linux")("Linux wrapper", () => expect(platform()).toBe("linux"));
`,
  );
  const command = "bun test test/linux.test.ts";
  writeFileSync(
    join(repoDir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "test", run = "${command}" }]\n`,
  );
  await sh(["git", "add", "."], { cwd: repoDir });
  await sh(["git", "commit", "-qm", "platform gate fixture"], { cwd: repoDir });
  const platformSpec = {
    ...spec,
    acceptance_criteria: [{ id: "AC-1", criterion: "Linux tests pass", how_to_verify: command }],
  };
  const evidence = `${command}: 1 pass, 1 skip. Inspected test/linux.test.ts:4: platform() !== "linux" guard skips on the simulated current macOS (darwin) host; required platform is Linux (linux). Linux verification is still needed; CI has not been observed.`;
  let implementations = 0;
  const f = start((s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: platformSpec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify")
      return {
        structured: {
          ...pass,
          overall: "fail",
          criteria: pass.criteria.map((c) =>
            c.id === "AC-1" ? { ...c, status: "blocked", blockedReason: "environment", evidence } : c,
          ),
        },
      };
    implementations++;
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  const run = await f.createRun({
    repo: repoDir,
    prompt: "Add farewell and verify Linux tests",
    profile: "standard",
  });
  expect(await waitFor(f, run.id, ["succeeded", "needs_human", "failed"])).toBe("needs_human");
  const state = f.store.getRunState<RunState>(run.id);
  expect(implementations).toBe(1);
  expect(state?.round).toBe(0);
  expect(f.store.getRun(run.id)?.error).toContain("verification blocked by the environment");
  expect(f.store.getRun(run.id)?.error).not.toContain("Still failing after");
  expect(state?.lastGates?.[0]?.result.output).toContain("1 skip");
  expect(state?.deliveryComplete).toBe(true);
  expect(f.store.listStages(run.id).find((stage) => stage.name === "deliver")?.status).toBe("succeeded");
  for (const result of state?.verifyResults ?? []) {
    expect(result.criteria[0]).toMatchObject({ status: "blocked", blockedReason: "environment", evidence });
    expect(result.criteria[0]?.gateEvidence).toBeUndefined();
  }
  expect(f.store.getArtifact(run.id, "verify-0.json")).toContain('"blockedReason": "environment"');
  const report = f.store.getArtifact(run.id, "report.md") ?? "";
  expect(report).toContain("🚧 blocked AC-1");
  expect(report).toContain(evidence);
  expect(report).not.toContain("Factory gate test passed");
  expect(report).not.toContain("✅ AC-1");
});

for (const scenario of [
  "blocked",
  "passes",
  "retry-unmet",
  "initial-unmet",
  "initial-unclear",
  "mixed-unclear",
  "no-alternative",
] as const) {
  test(`environment verification retry: ${scenario}`, async () => {
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
        if (scenario === "no-alternative") f.tracker.blockModel("alpha/m", "unavailable alternative");
        if (
          (["passes", "initial-unmet", "initial-unclear", "mixed-unclear"].includes(scenario) && n === 2) ||
          n === 3
        )
          return { structured: pass };
        const actionable =
          (["initial-unmet", "mixed-unclear"].includes(scenario) && n === 1) ||
          (scenario === "retry-unmet" && n === 2);
        return {
          structured: {
            ...pass,
            overall: "fail",
            criteria: pass.criteria.map((c) =>
              c.id === "AC-1"
                ? {
                    ...c,
                    status: scenario === "initial-unclear" ? "unclear" : "blocked",
                    blockedReason: scenario === "mixed-unclear" ? "environment" : null,
                    evidence:
                      scenario === "initial-unclear"
                        ? "Missing evidence: farewell.txt contents were not inspected"
                        : scenario === "mixed-unclear"
                          ? "Linux-only tests skipped on macOS: platform guard requires Linux"
                          : "Ran bun test: EPERM creating fixture directory",
                    publicSummary: "",
                  }
                : c.id === "H-1" && actionable
                  ? {
                      ...c,
                      status: scenario === "mixed-unclear" ? "unclear" : "unmet",
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
    expect(terminal).toBe(
      scenario === "blocked" || scenario === "no-alternative" ? "needs_human" : "succeeded",
    );
    const state = f.store.getRunState<RunState>(run.id);
    const actionable = ["retry-unmet", "initial-unmet", "initial-unclear", "mixed-unclear"].includes(
      scenario,
    );
    expect(implementationPrompts).toHaveLength(actionable ? 2 : 1);
    expect(state?.round).toBe(actionable ? 1 : 0);
    expect(state?.roundsOnImplementer).toBe(actionable ? 1 : 0);
    expect(state?.implementer?.modelId).toBe("alpha/m");
    expect(new Set(scratchPaths).size).toBe(scratchPaths.length);
    for (const scratch of scratchPaths) expect(existsSync(scratch)).toBe(false);
    expect(verifierModels[0]).toBe("beta/m");
    if (["blocked", "passes", "retry-unmet"].includes(scenario)) {
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
      if (scenario === "no-alternative") expect(verifierModels).toHaveLength(1);
      else expect(verifierModels).toHaveLength(2);
    }
    if (actionable) {
      const feedback = implementationPrompts[1]?.split("### Checks not met")[1] ?? "";
      expect(feedback).toContain(scenario === "initial-unclear" ? "AC-1" : "H-1");
      if (scenario === "initial-unclear" || scenario === "mixed-unclear")
        expect(feedback).toContain("(unclear)");
      if (scenario === "initial-unclear") expect(feedback).toContain("Missing evidence");
      if (scenario === "mixed-unclear") {
        expect(feedback).not.toContain("AC-1");
        expect(feedback).not.toContain("Linux");
        expect(state?.verifyResults?.[0]?.criteria[0]?.status).toBe("blocked");
      }
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

for (const grounded of [true, false]) {
  test(`resumed verifier grounds citations in its sanitized public source: ${grounded}`, async () => {
    const secret = "synthetic-citation-source-549";
    registerCredential("citation-source-test", secret);
    const requirement = `Run ${secret} before delivery`;
    const citation = grounded
      ? "Run [redacted] before delivery"
      : "Run an unstated operation before delivery";
    const implementationPrompts: string[] = [];
    const verificationPrompts: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        verificationPrompts.push(s.prompt);
        return {
          structured:
            verificationPrompts.length > 1
              ? pass
              : {
                  ...pass,
                  overall: "fail",
                  criteria: pass.criteria.map((c) =>
                    c.id === "H-1"
                      ? {
                          ...c,
                          status: "unmet",
                          requirement: "spec",
                          requirementCitation: citation,
                          evidence: `The requirement "${citation}" was not satisfied.`,
                          publicSummary: "The required operation did not run.",
                        }
                      : c,
                  ),
                },
        };
      }
      implementationPrompts.push(s.prompt);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    await f.stop();
    f.deps.faults = { "stage:verify:before": { action: "kill", occurrence: 1 } };
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
    const execute = () => executeRun(f.deps, run.id, new AbortController().signal);
    expect(await execute()).toBe("running");
    const stored = f.store.getRunState<RunState>(run.id);
    if (!stored?.spec) throw new Error("missing saved specification");
    stored.spec.requirements = [requirement];
    f.store.setRunState(run.id, stored);
    f.deps.faults = undefined;
    expect(await execute()).toBe("succeeded");
    expect(verificationPrompts[0]).toContain("Run [redacted] before delivery");
    expect(verificationPrompts[0]).not.toContain(secret);
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.spec?.requirements).toEqual([requirement]);
    const notes = state?.verifyResults?.[0]?.notes;
    const feedback = implementationPrompts[1] ?? "";
    if (grounded) {
      expect(notes).not.toContain("citation validation failed");
      expect(feedback).toContain('this requirement of the specification: "Run [redacted] before delivery"');
      expect(feedback).not.toContain("citation was not found");
    } else {
      expect(notes).toContain("citation is not a stated public requirement");
      expect(feedback).toContain("citation was not found");
      expect(feedback).not.toContain(citation);
    }
  });
}
