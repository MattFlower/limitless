import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { registerCredential } from "../src/util/proc.ts";
import { customProvider, providerFixture } from "./provider-config-support.ts";

test("shared invocation recording redacts configured credentials including thrown errors and structured events", async () => {
  const secret = "FAKE_PIPELINE_CREDENTIAL_734";
  const fixture = providerFixture(
    [{ ...customProvider, api_key_env: "MAC_MLX_KEY" }],
    `MAC_MLX_KEY=${secret}\n`,
  );
  const store = new Store(":memory:");
  const cfg = fixture.load();
  mkdirSync(cfg.paths.runs, { recursive: true });
  const factory = new Factory(cfg, {
    store,
    harnesses: {
      claude: fakeHarness((spec) => {
        expect(spec.prompt).toBe("legacy state [redacted]");
        expect(spec.systemAppend).toStartWith("legacy context [redacted]");
        spec.onEvent({ type: "stderr", text: `ordinary diagnostic ${secret}` });
        spec.onEvent({
          type: "tool_call",
          id: "call",
          name: "inspect",
          input: { nested: [{ [secret]: secret }] },
        });
        writeFileSync(spec.logPath, spec.redactOutput?.(`ordinary diagnostic ${secret}`) ?? secret);
        return { fault: "throw", error: `ordinary diagnostic ${secret}` };
      }),
    },
  });
  try {
    const repo = store.upsertRepo({
      slug: "fixture/repo",
      kind: "local",
      localPath: fixture.root,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
    const stage = store.startStage(run.id, "triage", 0);
    const context = new RunContext(factory.deps, run, repo, new AbortController().signal);
    const outcome = await context.invoke({
      role: "triage",
      stage,
      prompt: `legacy state \x1b[31m${secret}`,
      systemAppend: `legacy context \x1b[31m${secret}`,
      mode: "readonly",
      complexity: "small",
      constraints: { only: "claude/haiku" },
    });
    expect(outcome.result.error).toBe("ordinary diagnostic [redacted]");
    const invocations = store.listInvocations(run.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.error).toBe("ordinary diagnostic [redacted]");
    expect(JSON.stringify(store.listEvents(run.id))).not.toContain(secret);
    expect(JSON.stringify(store.listEvents(run.id))).toContain("ordinary diagnostic");
    expect(readFileSync(join(cfg.paths.runs, run.id, `inv-${invocations[0]?.id}.log`), "utf8")).toBe(
      "ordinary diagnostic [redacted]",
    );
  } finally {
    await factory.stop();
    store.close();
    fixture.close();
  }
});

test("reload sanitizes legacy diagnostics while preserving executable and comparison state", async () => {
  const secret = "SYNTHETIC_RELOAD_CREDENTIAL_494";
  const literal = `\x1b[31m${secret}`;
  const fixture = providerFixture(
    [{ ...customProvider, api_key_env: "RELOAD_TEST_KEY" }],
    `RELOAD_TEST_KEY=${secret}\n`,
  );
  const store = new Store(":memory:");
  const factory = new Factory(fixture.load(), { store });
  try {
    const repo = store.upsertRepo({
      slug: "fixture/repo",
      kind: "local",
      localPath: fixture.root,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
    const initial = new RunContext(factory.deps, run, repo, new AbortController().signal);
    const result = {
      name: literal,
      command: literal,
      ok: false,
      exitCode: 1,
      durationMs: 1,
      output: literal,
      failures: literal,
    };
    const comparison = {
      name: literal,
      verdict: "still_failing" as const,
      blocking: false,
      result: { ...result, firstAttempt: result },
      firstAttempt: result,
    };
    const state = {
      ...initial.state,
      phase: "loop" as const,
      gatesConfig: {
        setup: [literal],
        checks: [{ name: literal, run: literal }],
        source: "detected" as const,
        protectedPaths: [literal],
      },
      baselineScripts: { check: literal },
      previewConfig: {
        paths: [literal],
        build: literal,
        seed: literal,
        serve: literal,
        ready: literal,
        env: { VALUE: literal },
      },
      worktreePath: literal,
      conflictFiles: [literal],
      reviewBaseSha: literal,
      pendingRebaseSha: literal,
      preRebaseHead: literal,
      lastVerifiedSha: literal,
      reviewedSha: literal,
      verification: { baseSha: literal, headSha: literal },
      implementer: { modelId: literal, vendor: literal, tier: 4 },
      triedImplementers: [literal],
      specAuthorVendor: literal,
      holdoutModelId: literal,
      reviewLenses: [{ name: literal, focus: literal, profiles: ["deep"] }],
      spec: {
        summary: literal,
        assumptions: [],
        requirements: [],
        acceptance_criteria: [{ id: literal, criterion: literal, how_to_verify: literal }],
        out_of_scope: [],
        blocking_questions: [],
      },
      holdout: {
        scenarios: [
          { id: literal, description: literal, steps: literal, expected: literal, edge_case: false },
        ],
      },
      baseline: { setupOk: true, setup: [result], checks: [{ ...result, firstAttempt: result }] },
      lastGates: [comparison],
      preRebaseGates: [comparison],
      gateEvidence: { stageId: 1, sha: literal, checks: [{ ...comparison, testCommand: literal }] },
      completedChecks: {
        round: 0,
        sha: literal,
        values: { gates: [comparison], audit: [{ id: literal, detail: literal }] },
      },
      feedback: literal,
      terminalReason: literal,
      needsHumanReason: literal,
      implementerReport: literal,
      implementerIssue: literal,
      rebaseNote: literal,
    } satisfies RunState;
    store.setRunState(run.id, state);
    registerCredential("reload-phase-test", "loop");
    registerCredential("reload-flow-test", "build");
    const loaded = new RunContext(factory.deps, run, repo, new AbortController().signal);
    const diagnostic = { output: "[redacted]", failures: "[redacted]", confinementError: false };
    const cleanResult = { ...result, ...diagnostic };
    const cleanComparison = {
      ...comparison,
      result: { ...cleanResult, firstAttempt: cleanResult },
      firstAttempt: cleanResult,
    };
    expect(loaded.state).toEqual({
      ...state,
      feedback: "[redacted]",
      terminalReason: "[redacted]",
      needsHumanReason: "[redacted]",
      implementerReport: "[redacted]",
      implementerIssue: "[redacted]",
      rebaseNote: "[redacted]",
      baseline: {
        setupOk: true,
        setup: [cleanResult],
        checks: [{ ...cleanResult, firstAttempt: cleanResult }],
      },
      lastGates: [cleanComparison],
      preRebaseGates: [cleanComparison],
      gateEvidence: { ...state.gateEvidence, checks: [{ ...cleanComparison, testCommand: literal }] },
      completedChecks: {
        ...state.completedChecks,
        values: { ...state.completedChecks.values, gates: [cleanComparison] },
      },
    });
    await loaded.save();
    expect(store.getRunState<RunState>(run.id)).toEqual(loaded.state);
    loaded.log(literal, "warn", { gate: result });
    expect(store.listEvents(run.id)).toMatchObject([
      {
        message: "[redacted]",
        data: { gate: { name: "[redacted]", command: "[redacted]", output: "[redacted]" } },
      },
    ]);
    expect(loaded.state.gatesConfig?.checks[0]?.name).toBe(literal);
    loaded.state.worktreePath = undefined;
    loaded.state.completedChecks = {
      ...state.completedChecks,
      sha: undefined,
      values: { gates: [cleanComparison] },
    };
    const cached = await loaded.stage(
      "gates",
      async () => {
        throw new Error("must reuse cached checks");
      },
      0,
    );
    expect(cached).toEqual([cleanComparison]);
  } finally {
    await factory.stop();
    store.close();
    fixture.close();
  }
});
