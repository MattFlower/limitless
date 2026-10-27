import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import type { GateConfig } from "../src/gates/detect.ts";
import type { GateRunner } from "../src/gates/executor.ts";
import { extractFailures } from "../src/gates/failures.ts";
import {
  compareGates,
  type GateComparison,
  type GateResult,
  type GateRun,
  retryBaselineFailures,
  retryRegressions,
  runGates,
  UNSLOTTED_RETRY_MAX_SECONDS,
} from "../src/gates/run.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { formatGateFeedback, implementPrompt, reviewPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import { renderReport } from "../src/pipeline/report.ts";
import type { Spec } from "../src/pipeline/schemas.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { credentialGate, gateCredential } from "./gate-output-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { providerFixture } from "./provider-config-support.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

test.each([
  { kind: "JSON", secret: 'synthetic-gate-json-"quoted"-\\slash', padding: "" },
  {
    kind: "multiline with blank and result lines",
    secret: "synthetic-blank-header\n\n(fail) x\nsynthetic-result-footer",
    padding: "",
  },
  {
    kind: "multiline across many chunks",
    secret: `synthetic-chunk-header\n\n(fail) x\n${"chunk-body".repeat(20_000)}\nsynthetic-chunk-footer`,
    padding: "",
  },
  { kind: "multiline", secret: "synthetic-gate-multiline-key\nsecond-key-line", padding: "" },
  {
    kind: "multiline beyond line cap",
    secret: Array.from({ length: 45 }, (_, i) => `synthetic-pem-key-line-${i}`).join("\n"),
    padding: "",
  },
  {
    kind: "multiline at excerpt cap",
    secret: "synthetic-gate-capped-key\nsecond-capped-line",
    padding: "x".repeat(7_900),
  },
  // A stray introducer once consumed the first character, leaving the rest of the value visible.
  {
    kind: "terminal after a stray introducer",
    secret: "terminal-synthetic-gate-key-707",
    padding: "x".repeat(7_900),
  },
])(
  "$kind credentials are redacted in gate results, artifacts and feedback",
  async ({ kind, secret, padding }) => {
    registerCredential("ESCAPED_GATE_TEST_TOKEN", secret);
    const fixture = providerFixture([]);
    const factory = new Factory(fixture.load());
    try {
      const diagnostic =
        kind === "JSON"
          ? JSON.stringify({ credential: secret })
          : kind.startsWith("terminal")
            ? `\u001b[${secret.slice(0, 9)}\u001b[31m${secret.slice(9)}\u001b[0m`
            : secret;
      const fragments = [secret.slice(1, 13), secret.slice(-12)];
      writeFileSync(join(fixture.work, "output.txt"), `${padding}error: ${diagnostic}\n(fail) assertion\n`);
      const gates = await confinementScope.run(fakeConfinement, () =>
        runGates(
          fixture.work,
          {
            setup: [],
            checks: [
              {
                name: "test",
                run: `"${process.execPath}" -e 'process.stdout.write(require("fs").readFileSync("output.txt")); process.exitCode = 1'`,
              },
            ],
            source: "detected",
            protectedPaths: [],
          },
          new AbortController().signal,
        ),
      );
      const result = gates.checks[0];
      if (!result?.failures) throw new Error("missing failure excerpt");
      for (const text of [result.output, result.failures]) {
        if (!padding || text === result.output) expect(text).toContain("[redacted]");
        expect(text).not.toContain(diagnostic);
        for (const fragment of secret.split("\n").filter((part) => part.length >= 8))
          expect(text).not.toContain(fragment.slice(0, 12));
        for (const fragment of fragments) expect(text).not.toContain(fragment);
      }
      const repo = factory.store.upsertRepo({
        slug: "test/repo",
        kind: "local",
        localPath: fixture.root,
        url: null,
        defaultBranch: "main",
        mergePolicy: "none",
      });
      const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "test" });
      factory.store.putArtifact(run.id, "gates.json", "gates", JSON.stringify(gates));
      factory.store.addEvent({ runId: run.id, type: "gate", message: "gates", data: gates });
      const routes = createHttpRoutes(factory);
      const route = routes["/api/runs/:id/artifacts/:name"] as Route;
      const response = await route(
        requestWithParams(`http://localhost:7400/api/runs/${run.id}/artifacts/gates.json`, undefined, {
          id: run.id,
          name: "gates.json",
        }),
        localServer,
      );
      expect(response.status).toBe(200);
      const events = await (routes["/api/runs/:id/events"] as Route)(
        requestWithParams(`http://localhost:7400/api/runs/${run.id}/events`, undefined, { id: run.id }),
        localServer,
      );
      for (const text of [
        factory.store.getArtifact(run.id, "gates.json"),
        await response.text(),
        await events.text(),
        formatGateFeedback(compareGates(null, gates)),
        reviewPrompt({
          prompt: "test",
          spec: null,
          baseSha: "base",
          stat: "",
          gates: compareGates(null, gates),
          audit: [],
          implementerReport: "",
        }),
      ]) {
        expect(text).toContain("[redacted]");
        expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
        for (const fragment of secret.split("\n").filter((part) => part.length >= 8))
          expect(text).not.toContain(fragment.slice(0, 12));
        for (const fragment of fragments) expect(text).not.toContain(fragment);
      }
    } finally {
      await factory.stop();
      factory.store.close();
      fixture.close();
    }
  },
);

test("legacy gate results are redacted at checkpoints, HTTP and SSE reads without altering run state", async () => {
  const secret = "synthetic-legacy-gate-credential-421";
  registerCredential("LEGACY_GATE_TEST_TOKEN", secret);
  const terminalSecret = "synthetic-legacy-terminal-credential-421";
  registerCredential("LEGACY_TERMINAL_TEST_TOKEN", terminalSecret);
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
    const interrupted = comparison("sandbox_apply: Oper\u001b[0mation not permitted", undefined, false)[0];
    if (!interrupted) throw new Error("missing legacy result");
    interrupted.result.firstAttempt = { ...interrupted.result };
    gates.push(interrupted);
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
    store.updateRun(run.id, {
      status: "failed",
      error: `terminal error: ${terminalSecret}; Last feedback: ${colored}`,
    });
    store.setRunState(run.id, state);
    store.putArtifact(run.id, "gates.json", "gates", JSON.stringify(gates));
    store.addEvent({
      runId: run.id,
      type: "gate",
      message: `gate: ${secret}; terminal error: ${terminalSecret}`,
      data: gates,
    });
    store.close();
    store = new Store(db);
    factory = new Factory(fixture.load(), { store });
    const context = new RunContext(factory.deps, run, repo, controller.signal);
    expect(context.state.feedback).toBe("gate feedback: [redacted]");
    expect(context.state.terminalReason).toBe("gate failure: [redacted]");
    expect(context.state.lastGates?.[0]?.result).toMatchObject({
      output: "credential: [redacted]",
      failures: "error: [redacted]\n(fail) assertion",
    });
    expect(JSON.stringify(context.state)).not.toContain(secret);
    expect(store.getRunState<RunState>(run.id)).toEqual(state);
    const checkpoint = await context.stage("gates", async () => {
      throw new Error("completed gate checkpoint must be reused");
    });
    if (!state.baseline || !context.state.baseline) throw new Error("missing baseline");
    expect(compareGates(null, state.baseline).at(-1)?.verdict).toBe("new_failure");
    expect(compareGates(null, context.state.baseline).at(-1)?.verdict).toBe("new_failure");
    expect((checkpoint as GateComparison[]).at(-1)?.result).toMatchObject({
      confinementError: false,
      firstAttempt: { confinementError: false },
    });
    const routes = createHttpRoutes(factory);
    const read = (path: string, name = "") => {
      const route = routes[path];
      return (typeof route === "function" ? (route as Route) : (route as { GET: Route }).GET)(
        requestWithParams(
          `http://localhost:7400${path.replace(":id", run.id).replace(":name", name)}`,
          { signal: controller.signal },
          { id: run.id, name },
        ),
        localServer,
      );
    };
    const runResponses = await Promise.all(
      ["/api/runs/:id", "/api/runs", "/api/feed"].map(async (path) => {
        const response = await read(path);
        expect(response.status).toBe(200);
        const text = JSON.stringify(await response.json());
        expect(text).toContain("terminal error: [redacted]");
        expect(text).toContain("Last feedback: [redacted]");
        return text;
      }),
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
      ...runResponses,
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
      expect(message).not.toContain(terminalSecret);
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

test("ambiguous sanitized gate names cannot select retry commands or timeout limits", async () => {
  const cfg = {
    setup: [],
    checks: [
      { name: "check\x1b[31m", run: "false", timeoutSec: 37 },
      { name: "check\x1b[34m", run: "false", timeoutSec: 42 },
    ],
    source: "none" as const,
    protectedPaths: [],
  };
  const run: GateRun = {
    setupOk: true,
    setup: [],
    checks: [{ name: "check", command: "false", ok: false, exitCode: 1, durationMs: 1, output: "failed" }],
  };
  const cmp = compareGates({ ...run, checks: run.checks.map((c) => ({ ...c, ok: true })) }, run);
  const retry = async () => {
    throw new Error("ambiguous gate must not be retried");
  };
  const signal = new AbortController().signal;
  expect(await retryBaselineFailures(run, ".", cfg, signal, undefined, retry)).toBe(run);
  expect(await retryRegressions(cmp, ".", cfg, [], signal, undefined, retry)).toBe(cmp);
  expect(
    formatGateFeedback(
      cmp.map((c) => ({ ...c, result: { ...c.result, timedOut: true } })),
      cfg,
    ),
  ).toContain("timed out after 900 s");
  // Lookup uses literal names before feedback redaction, preserving the exact second timeout.
  const literal = cmp.map((c) => ({
    ...c,
    name: cfg.checks[1]?.name ?? "",
    result: { ...c.result, timedOut: true },
  }));
  expect(formatGateFeedback(literal, cfg)).toContain("timed out after 42 s");
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

test.each([
  { targeted: "fail", fullOk: false },
  { targeted: "fail", fullOk: true },
  { targeted: "pass", fullOk: false },
  { targeted: "pass", fullOk: true },
  { targeted: "timeout", fullOk: true },
  { targeted: "confinement", fullOk: true },
])("regression retry: targeted $targeted / full ok $fullOk", async ({ targeted, fullOk }) => {
  const f = await retryFixture();
  try {
    const { runner, calls } = recordingRetry(targeted, fullOk, f.sha);
    const [comparison] = await retryRegressions(
      [{ name: "test", verdict: "regressed", blocking: true, result: f.original }],
      f.cwd,
      f.cfg,
      [],
      new AbortController().signal,
      undefined,
      runner,
    );
    const fullRuns = targeted === "pass" || targeted === "timeout";
    expect(calls).toEqual(
      fullRuns
        ? ["bun test --isolate './test/a.test.ts' './test/b.test.ts'", "full-test"]
        : ["bun test --isolate './test/a.test.ts' './test/b.test.ts'"],
    );
    expect(comparison?.firstAttempt).toBe(f.original);
    expect(comparison?.result.firstAttempt).toBe(f.original);
    expect(comparison?.firstAttempt?.ok).toBe(false);
    expect(comparison?.result.targetedRetry?.command).toBe(calls[0]);
    expect(comparison?.result.command).toBe(fullRuns ? "full-test" : f.original.command);
    if (targeted === "fail") {
      expect(formatGateFeedback(comparison ? [comparison] : [])).toContain("unreported.test.ts: load error");
      expect(comparison?.result.output).toBe(f.original.output);
    }
    expect(comparison?.verdict).toBe(
      targeted === "confinement" ? "confinement_error" : fullRuns && fullOk ? "flaky" : "regressed",
    );
    expect(comparison?.blocking).toBe(!(fullRuns && fullOk));
  } finally {
    f.close();
  }
});

test.each([
  { targeted: "fail", fullOk: false },
  { targeted: "pass", fullOk: true },
  { targeted: "pass", fullOk: false },
  { targeted: "timeout", fullOk: true },
  { targeted: "confinement", fullOk: true },
])("baseline retry: targeted $targeted / full ok $fullOk", async ({ targeted, fullOk }) => {
  const f = await retryFixture();
  try {
    const { runner, calls } = recordingRetry(targeted, fullOk, f.sha);
    const result = await retryBaselineFailures(
      { setupOk: true, setup: [], checks: [f.original] },
      f.cwd,
      f.cfg,
      new AbortController().signal,
      undefined,
      runner,
    );
    const fullRuns = targeted === "pass" || targeted === "timeout";
    expect(calls).toEqual(
      fullRuns
        ? ["bun test --isolate './test/a.test.ts' './test/b.test.ts'", "full-test"]
        : ["bun test --isolate './test/a.test.ts' './test/b.test.ts'"],
    );
    expect(result.checks[0]?.ok).toBe(fullRuns && fullOk);
    expect(result.checks[0]?.firstAttempt).toBe(f.original);
    expect(result.checks[0]?.targetedRetry?.command).toBe(calls[0]);
  } finally {
    f.close();
  }
});

test("known files without retry_files still use the full retry", async () => {
  const f = await retryFixture();
  try {
    const { runner, calls } = recordingRetry("pass", true, f.sha);
    await retryRegressions(
      [{ name: "test", verdict: "regressed", blocking: true, result: f.original }],
      f.cwd,
      { ...f.cfg, retryFiles: undefined },
      [],
      new AbortController().signal,
      undefined,
      runner,
    );
    expect(calls).toEqual(["full-test"]);
  } finally {
    f.close();
  }
});

test.each([
  { timeoutSec: 37, knownTimes: true, skipGateSlot: true, expected: 37 },
  { timeoutSec: undefined, knownTimes: true, skipGateSlot: true, expected: 120 },
  { timeoutSec: 1800, knownTimes: false, skipGateSlot: false, expected: 1800 },
])("targeted timeout policy: %j", async ({ timeoutSec, knownTimes, skipGateSlot, expected }) => {
  const f = await retryFixture();
  try {
    if (!knownTimes) f.original.failedFileTimes = undefined;
    const calls: number[] = [];
    await retryBaselineFailures(
      { setupOk: true, setup: [], checks: [f.original] },
      f.cwd,
      { ...f.cfg, checks: [{ name: "test", run: "full-test", timeoutSec }] },
      new AbortController().signal,
      undefined,
      async (cfg, options) => {
        expect(options).toEqual({ targeted: true, skipGateSlot });
        const check = cfg.checks[0];
        if (!check?.timeoutSec) throw new Error("missing retry timeout");
        calls.push(check.timeoutSec);
        return { setupOk: true, setup: [], checks: [{ ...f.original, command: check.run }] };
      },
    );
    expect(calls).toEqual([expected]);
  } finally {
    f.close();
  }
});

test("file substitution shell-quotes apostrophes and literal replacement syntax", async () => {
  const f = await retryFixture();
  try {
    const file = "test/space ' $&.test.ts";
    writeFileSync(join(f.cwd, file), "");
    f.original.failedFiles = [file];
    f.original.failedFileTimes = { [file]: 1 };
    const { runner, calls } = recordingRetry("fail", false, f.sha);
    await retryBaselineFailures(
      { setupOk: true, setup: [], checks: [f.original] },
      f.cwd,
      f.cfg,
      new AbortController().signal,
      undefined,
      runner,
    );
    expect(calls).toEqual(["bun test --isolate './test/space '\\'' $&.test.ts'"]);
  } finally {
    f.close();
  }
});

const retrySeed = seeded(async (cwd) => {
  await sh(["git", "init", "-q"], { cwd });
  await sh(["git", "commit", "-qm", "retry fixture", "--allow-empty"], { cwd });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
});
async function retryFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "gate-feedback-retry-"));
  mkdirSync(join(cwd, "test"));
  for (const file of ["a.test.ts", "b.test.ts"]) writeFileSync(join(cwd, "test", file), "");
  const { value: sha } = await retrySeed(cwd);
  const cfg: GateConfig = {
    setup: [],
    checks: [{ name: "test", run: "full-test", timeoutSec: 1800 }],
    source: "none",
    protectedPaths: [],
    retryFiles: "bun test --isolate {files}",
  };
  const original: GateResult = {
    name: "test",
    command: "full-test",
    ok: false,
    exitCode: 1,
    output: "unreported.test.ts: load error\noriginal failure",
    durationMs: 10,
    failedFiles: ["test/a.test.ts", "test/b.test.ts"],
    failedFileTimes: { "test/a.test.ts": 1, "test/b.test.ts": 2 },
  };
  return { cwd, sha, cfg, original, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

function recordingRetry(targeted: string, fullOk: boolean, sha: string) {
  const calls: string[] = [];
  const runner: GateRunner = async (cfg, options) => {
    expect(cfg.setup).toEqual([]);
    const check = cfg.checks[0];
    if (!check) throw new Error("Missing retry check");
    calls.push(check.run);
    const isTarget = options?.targeted;
    expect(options?.skipGateSlot).toBe(!!isTarget);
    expect(check.timeoutSec).toBe(isTarget ? 2 * UNSLOTTED_RETRY_MAX_SECONDS : 1800);
    const ok = isTarget ? targeted === "pass" : fullOk;
    return {
      sha,
      trackedClean: true,
      setupOk: true,
      setup: [],
      checks: [
        {
          name: check.name,
          command: check.run,
          ok,
          exitCode: ok ? 0 : 1,
          output: "retry",
          durationMs: 1,
          ...(isTarget && targeted === "timeout" ? { timedOut: true } : {}),
          ...(isTarget && targeted === "confinement" ? { confinementError: true } : {}),
        },
      ],
    };
  };
  return { runner, calls };
}

test("structured failure filenames and timing keys are redacted at gate callbacks", async () => {
  const f = await retryFixture();
  const secret = "synthetic-junit-file-credential-480";
  registerCredential("JUNIT_FILE_TOKEN", secret);
  try {
    const file = `test/${secret}.test.ts`;
    writeFileSync(join(f.cwd, file), "");
    writeFileSync(join(f.cwd, "report.xml"), `<testsuite file="${file}" failures="1" time="2"/>`);
    const observed: string[] = [];
    const result = await confinementScope.run(fakeConfinement, () =>
      runGates(
        f.cwd,
        {
          ...f.cfg,
          checks: [{ name: "test", run: 'cp report.xml "$LIMITLESS_GATE_REPORT"; exit 1' }],
        },
        new AbortController().signal,
        { onResult: (r) => observed.push(JSON.stringify(r)) },
      ),
    );
    expect(result.checks[0]?.failedFiles).toEqual([file]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain("[redacted].test.ts");
    expect(observed[0]).not.toContain(secret);
  } finally {
    f.close();
  }
});
