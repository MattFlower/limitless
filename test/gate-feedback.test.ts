import { expect, test } from "bun:test";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import { extractFailures } from "../src/gates/failures.ts";
import { compareGates, type GateComparison } from "../src/gates/run.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { formatGateFeedback, implementPrompt, reviewPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import { renderReport } from "../src/pipeline/report.ts";
import type { Spec } from "../src/pipeline/schemas.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { credentialGate, gateCredential } from "./gate-output-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { providerFixture } from "./provider-config-support.ts";

test("legacy gate results are redacted on reopened state, checkpoints, HTTP and SSE reads", async () => {
  const secret = "synthetic-legacy-gate-credential-421";
  registerCredential("LEGACY_GATE_TEST_TOKEN", secret);
  const colored = `${secret.slice(0, 12)}\u001b[31m${secret.slice(12)}`;
  const fixture = providerFixture([]);
  const db = join(fixture.root, "store.db");
  let store = new Store(db);
  let factory: Factory | undefined;
  const controller = new AbortController();
  try {
    const repo = store.upsertRepo({
      slug: "test/repo",
      kind: "local",
      localPath: fixture.root,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
    const gates = comparison(`credential: ${colored}`, `error: ${secret}\n(fail) assertion`, false);
    const state: RunState = {
      flow: "build",
      phase: "loop",
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      toolCommands: [],
      feedback: `gate feedback: ${colored}`,
      baseline: { setupOk: true, setup: [], checks: gates.map((g) => g.result) },
      lastGates: gates,
      preRebaseGates: gates,
      gateEvidence: { stageId: 1, sha: "head", checks: gates.map((g) => ({ ...g, testCommand: null })) },
      completedChecks: { round: 0, values: { gates } },
      terminalReason: `gate failure: ${colored}`,
    };
    store.setRunState(run.id, state);
    store.putArtifact(run.id, "gates.json", "gates", JSON.stringify(gates));
    store.addEvent({ runId: run.id, type: "gate", message: `gate: ${secret}`, data: gates });
    store.close();
    store = new Store(db);
    factory = new Factory(fixture.load(), { store });
    const context = new RunContext(factory.deps, run, repo, controller.signal);
    const checkpoint = await context.stage("gates", async () => {
      throw new Error("completed gate checkpoint must be reused");
    });
    const routes = createHttpRoutes(factory);
    const read = (path: string, name = "") =>
      (routes[path] as Route)(
        requestWithParams(
          `http://localhost:7400${path.replace(":id", run.id).replace(":name", name)}`,
          { signal: controller.signal },
          { id: run.id, name },
        ),
        localServer,
      );
    const artifact = await (await read("/api/runs/:id/artifacts/:name", "gates.json")).text();
    const events = await (await read("/api/runs/:id/events")).json();
    const response = await read("/api/runs/:id/stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE stream");
    let backlog = "";
    while (!backlog.includes("data: ")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before its backlog");
      backlog += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    await reader.cancel();
    const spec: Spec = {
      summary: "test",
      requirements: [],
      assumptions: [],
      out_of_scope: [],
      blocking_questions: [],
      acceptance_criteria: [],
    };
    const messages = [
      JSON.stringify(context.state),
      JSON.stringify(checkpoint),
      artifact,
      JSON.stringify(events),
      backlog,
      formatGateFeedback(context.state.lastGates ?? []),
      formatGateFeedback(gates),
      implementPrompt({
        prompt: "test",
        spec,
        baseSha: "base",
        round: 1,
        hasHoldout: false,
        feedback: state.feedback,
        gates: {
          setup: [],
          checks: [],
          source: "detected",
          protectedPaths: [],
        },
        baseline: state.baseline ?? null,
      }),
      reviewPrompt({
        prompt: "test",
        spec,
        baseSha: "base",
        stat: "",
        gates,
        audit: [],
        implementerReport: "",
      }),
      verifyPrompt({
        prompt: "test",
        spec,
        holdout: { scenarios: [] },
        baseSha: "base",
        checks: gates.map((g) => ({ ...g, result: { ...g.result, command: secret } })),
      }),
      renderReport({
        success: false,
        runId: run.id,
        prompt: "test",
        state,
        invocations: [],
        totals: { costUsd: 0, costEquivUsd: 0 },
        runUrl: "https://example.com/run",
      }),
    ];
    for (const message of messages) {
      expect(message).toContain("[redacted]");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(secret.slice(12));
    }
    // Reads must leave the previous release's rows untouched.
    expect(store.getRunState<RunState>(run.id)).toEqual(state);
    expect(store.getArtifact(run.id, "gates.json")).toBe(JSON.stringify(gates));
  } finally {
    controller.abort();
    await factory?.stop();
    store.close();
    fixture.close();
  }
});

test("gate feedback and review receive redacted early diagnostics and tails", async () => {
  const gates = compareGates(null, await credentialGate());
  const messages = [
    formatGateFeedback(gates),
    reviewPrompt({
      prompt: "fix tests",
      spec: null,
      baseSha: "base",
      stat: "",
      gates,
      audit: [],
      implementerReport: "",
    }),
  ];
  for (const message of messages) {
    expect(message).toContain("error: credential [redacted]");
    expect(message).toContain("(fail) assertion");
    expect(message).not.toContain(gateCredential);
  }
});

function comparison(output: string, failures?: string, timedOut = true): GateComparison[] {
  return [
    {
      name: "test",
      verdict: "regressed",
      blocking: true,
      result: {
        name: "test",
        command: "fake-test",
        ok: false,
        exitCode: 1,
        timedOut,
        durationMs: 900_000,
        output,
        ...(failures ? { failures } : {}),
      },
    },
  ];
}

function feedback(output: string, failures?: string, timedOut = true): string {
  return formatGateFeedback(comparison(output, failures, timedOut));
}

test.each([false, true])(
  "failure feedback puts bounded excerpts before a shorter tail (timeout: %s)",
  (timedOut) => {
    const reason = "error: values differ\nExpected: 1\nReceived: 2\n(fail) assertion";
    const message = feedback("summary\n".repeat(800), `${reason}\n${"x".repeat(8_000)}`, timedOut);
    expect(message).toContain(reason);
    expect(message.indexOf("error:")).toBeLessThan(message.indexOf("summary"));
    expect(message).toContain("left out");
    expect(message.length).toBeLessThan(3_300);
  },
);

test("legacy failed gate feedback still shows the tail", () => {
  const message = feedback(`early\n${"x".repeat(4_000)}\nlegacy failure tail`, undefined, false);
  expect(message).toContain("legacy failure tail");
  expect(message).not.toContain("early");
  expect(message.length).toBeLessThan(3_300);
});

test.each([
  "ok 1 - completed test\n  ---\n  duration_ms: 0.1\n  ...\n",
  "not ok 1 - completed test\n",
  "ok 1 completed test\n",
  "ok 1\n",
  "ok 1 - completed test # SKIP unavailable\n",
])("timeout feedback does not call a completed TAP subtest running: %s", (result) => {
  expect(feedback(`[timed out]\n# Subtest: completed test\n${result}`)).not.toContain(
    "the last test running was completed test",
  );
});

test.each(["", "ok 1 - other test\n", "  ok 1 - unfinished test\n"])(
  "timeout feedback names an unfinished TAP subtest: %s",
  (result) => {
    expect(feedback(`[timed out]\n# Subtest: unfinished test\n${result}`)).toContain(
      "the last test running was unfinished test",
    );
  },
);

test("timeout feedback names the unfinished subtest after a completed one", () => {
  expect(
    feedback("# Subtest: completed test\nok 1 - completed test\n# Subtest: unfinished test\n"),
  ).toContain("the last test running was unfinished test");
});

test("timeout feedback recognizes indented TAP completion with ANSI and CRLF", () => {
  expect(
    feedback("\u001b[32m  # Subtest: completed test\u001b[0m\r\n  ok 1 - completed test\r\n"),
  ).not.toContain("the last test running was completed test");
});

for (const consumer of ["feedback", "review"]) {
  test.each([
    ["(fail) identifier", "(fail) identifier"],
    ["\u001b[31m✗ colored identifier\u001b[0m", "✗ colored identifier"],
    ["not ok 1 - tap identifier", "not ok 1 - tap identifier"],
  ])(`${consumer} keeps the complete identity after a long diagnostic: %s`, (result, identity) => {
    const failures = extractFailures(`error: reason\n${"x".repeat(9_000)}\n${result}`);
    const gates = comparison("summary\n".repeat(800), failures, false);
    const message =
      consumer === "feedback"
        ? formatGateFeedback(gates)
        : reviewPrompt({
            prompt: "fix tests",
            spec: null,
            baseSha: "base",
            stat: "",
            gates,
            audit: [],
            implementerReport: "",
          });
    expect(message).toContain(identity);
    expect(message).toContain("error: reason");
    expect(message).toContain("left out");
    expect(message.indexOf(identity)).toBeLessThan(message.indexOf("summary"));
    expect(message).not.toContain("\u001b");
    if (consumer === "feedback") expect(message.length).toBeLessThan(3_300);
  });
}
