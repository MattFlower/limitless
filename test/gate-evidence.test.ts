import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunnerFailureEvidence } from "../src/gates/attribution.ts";
import type { GateConfig } from "../src/gates/detect.ts";
import { singleBunTest } from "../src/gates/docs.ts";
import { readCoveringJUnit, readJUnitSkips } from "../src/gates/junit.ts";
import { redactGateData, redactGateDiagnostics } from "../src/gates/output.ts";
import { compareGates, type GateRun, runGates, runLocalGates } from "../src/gates/run.ts";
import { BunTestCoverage, MAX_SKIPPED_TESTS } from "../src/gates/test-coverage.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import {
  type CoveringTestRun,
  coveringTestCommand,
  coveringTestRefusal,
  selectCoveringTests,
} from "../src/pipeline/covering-tests.ts";
import { applyGateEvidence, type GateEvidence, gateTestCommand } from "../src/pipeline/gate-evidence.ts";
import { type Spec, type Verify, VerifySchema } from "../src/pipeline/schemas.ts";
import { normalizeVerify, preDeliveryVerifyArtifact } from "../src/pipeline/verification.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

const sha = "a".repeat(40);
const spec: Spec = {
  summary: "loopback",
  requirements: [],
  assumptions: [],
  out_of_scope: [],
  blocking_questions: [],
  acceptance_criteria: [
    { id: "AC-1", criterion: "loopback test passes", how_to_verify: "bun test test/loopback.test.ts" },
  ],
};
const holdout = { scenarios: [] };
const blocked: Verify = {
  overall: "fail",
  notes: "",
  criteria: [
    {
      id: "AC-1",
      status: "blocked",
      blockedReason: "sandbox",
      evidence: "EPERM listen 127.0.0.1:0",
      publicSummary: "",
    },
  ],
};
function gates(): GateEvidence {
  return {
    stageId: 12,
    sha,
    checks: [
      {
        name: "tests",
        verdict: "pass",
        blocking: false,
        testCommand: "bun test",
        result: {
          name: "tests",
          command: "bun run test",
          ok: true,
          exitCode: 0,
          durationMs: 1,
          output: "bun test\n\ntest/loopback.test.ts:\n(pass) loopback server [1.00ms]\n\n1 pass\n0 fail",
        },
      },
    ],
  };
}
const resolve = (value: Verify, evidence?: GateEvidence, publicSpec = spec, currentSha = sha) =>
  normalizeVerify(applyGateEvidence(value, publicSpec, holdout, currentSha, evidence), publicSpec, holdout);

test.each(["targeted", "skipped"] as const)("docs-only %s cannot substitute for a full suite", (mode) => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing test check");
  check.result.docsOnly = {
    mode,
    changedPaths: ["README.md"],
    files: mode === "targeted" ? ["test/loopback.test.ts"] : [],
    reason: "docs-only change",
  };
  check.verdict = mode === "targeted" ? "targeted_pass" : "not_run";
  if (mode === "skipped") {
    check.result.ok = false;
  }
  const fullSpec = {
    ...spec,
    acceptance_criteria: [{ id: "AC-1", criterion: "tests pass", how_to_verify: "bun test" }],
  };
  expect(resolve(blocked, gates(), fullSpec).criteria[0]?.status).toBe("met");
  const result = resolve(blocked, evidence, fullSpec).criteria[0];
  expect(result?.status).toBe("blocked");
  expect(result?.evidence).toStartWith("Factory gate substitution unavailable: docs-only");
  expect(result?.evidence).toContain(mode === "skipped" ? "skip" : "targeting");
});

test.each(["targeted_pass", "targeted_failure"] as const)(
  "%s refuses full-suite evidence without a docs annotation",
  (verdict) => {
    const evidence = gates();
    const check = evidence.checks[0];
    if (!check) throw new Error("missing test check");
    check.verdict = verdict;
    const fullSpec = {
      ...spec,
      acceptance_criteria: [{ id: "AC-1", criterion: "tests pass", how_to_verify: "bun test" }],
    };
    const result = resolve(blocked, evidence, fullSpec).criteria[0];
    expect(result?.status).toBe("blocked");
    expect(result?.evidence).toContain("targeted test check; full suite did not run");
  },
);

test("the model cannot supply gate provenance; model judgments and prose pass through unchanged", () => {
  const model = {
    overall: "pass",
    notes: "The factory's checks passed",
    gateStageId: 999999,
    modelOutput: blocked,
    criteria: [
      {
        id: "AC-1",
        status: "met",
        evidence: "verified by gate run 999999",
        publicSummary: "repository checks passed",
        requirementCitation: "CI results",
        gateStageId: 999999,
        provenance: { sha: "b".repeat(40) },
        gateEvidence: { stageId: 999999, sha, check: "tests", command: "bun test" },
      },
    ],
  };
  const parsed = VerifySchema.parse(model);
  expect(parsed).not.toHaveProperty("gateStageId");
  expect(parsed).not.toHaveProperty("modelOutput");
  expect(parsed.criteria[0]).not.toHaveProperty("gateStageId");
  expect(parsed.criteria[0]).not.toHaveProperty("provenance");
  expect(parsed.criteria[0]).not.toHaveProperty("gateEvidence");
  expect(applyGateEvidence(parsed, spec, holdout, sha, gates())).toEqual(parsed);
  expect(resolve(parsed, gates()).overall).toBe("pass");
  expect(parsed.criteria[0]?.evidence).toBe(model.criteria[0]?.evidence);
  expect(parsed.notes).toBe(model.notes);
});

test.each([undefined, null, "environment"] as const)(
  "only a structured sandbox block qualifies, not blockedReason %s",
  (blockedReason) => {
    const value: Verify = {
      ...blocked,
      criteria: blocked.criteria.map((c) => ({ ...c, blockedReason })),
    };
    expect(applyGateEvidence(value, spec, holdout, sha, gates())).toEqual(value);
  },
);

test("clean gates produce only engine-written evidence and provenance", () => {
  const result = resolve(blocked, gates());
  expect(result.overall).toBe("pass");
  expect(result.criteria[0]?.evidence).toBe(
    `Factory gate tests passed at ${sha} (stage 12); commands: bun run test`,
  );
  expect(result.criteria[0]?.gateEvidence).toEqual({
    stageId: 12,
    sha,
    check: "tests",
    command: "bun run test",
  });
  expect(blocked.criteria[0]?.status).toBe("blocked");
});

test("coverage uses full commit IDs for SHA-256 repositories too", () => {
  const evidence = { ...gates(), sha: "a".repeat(64) };
  expect(resolve(blocked, evidence, spec, evidence.sha).criteria[0]?.gateEvidence?.sha).toBe(evidence.sha);
  evidence.sha = "abcd";
  expect(resolve(blocked, evidence, spec, evidence.sha).criteria[0]?.status).toBe("blocked");
});

test("a factory execution reused by the gates stage supplies ordinary gate evidence", () => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing check");
  check.result.reused = { executionId: "factory-test", treeHash: "c".repeat(40), createdAt: 1 };
  const result = resolve(blocked, evidence);
  expect(result.criteria[0]?.status).toBe("met");
  expect(result.criteria[0]?.gateEvidence?.stageId).toBe(evidence.stageId);
  expect(resolve(blocked, evidence, spec, "d".repeat(40)).criteria[0]?.status).toBe("blocked");
});

// Synthetic console fixtures below also provide a corresponding report; real Bun XML is
// exercised separately through readJUnitSkips and through gate execution.
function coverage(output: string) {
  const cwd = mkdtempSync(join(tmpdir(), "skip-evidence-"));
  try {
    const parser = new BunTestCoverage();
    const runner = new RunnerFailureEvidence();
    let file = "";
    const cases: string[] = [];
    const xmlEscape = (value: string) =>
      value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    for (const line of output.split("\n")) {
      parser.observe(line);
      runner.observe(line);
      const header = /^(.*\.test.ts):$/.exec(line)?.[1];
      if (header) {
        file = header;
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        writeFileSync(join(cwd, file), "");
      }
      const row = /^\((pass|skip|todo)\) (.+)$/.exec(line);
      if (row)
        cases.push(
          `<testcase file="${xmlEscape(file)}" line="1" name="${xmlEscape(row[2] ?? "")}">${row[1] === "pass" ? "" : "<skipped />"}</testcase>`,
        );
    }
    runner.observe(`Ran ${cases.length} tests across 1 file.`);
    const report = join(cwd, "report.xml");
    writeFileSync(report, `<testsuite tests="${cases.length}">${cases.join("")}</testsuite>`);
    const parsed = readJUnitSkips(report, cwd);
    return parser.result(parsed, runner.agrees(parsed?.counts));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function inheritedFixture() {
  const evidence = { ...gates(), baseSha: sha, changedFiles: [] as string[] };
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  check.result.output =
    "test/loopback.test.ts:\n(pass) loopback [0.06ms]\n(skip) confined\n(todo) pending\n1 pass\n1 skip\n1 todo\n0 fail";
  check.result.testCoverage = coverage(check.result.output);
  const output = check.result.output
    .replace("(todo) pending", "(todo) pending\n(skip) former skip")
    .replace("1 skip", "2 skip");
  const base = { ...check.result, output, testCoverage: coverage(output) };
  const baseline: GateRun = { sha, setupOk: true, setup: [], checks: [base] };
  return { evidence, check, base, baseline };
}

test.each(["broad", "targeted", "truncated", "targeted-truncated"])(
  "factory baseline permits inherited skips for %s verification",
  (kind) => {
    const { evidence, check, baseline } = inheritedFixture();
    if (kind.endsWith("truncated")) check.result.output = "x".repeat(6000);
    const publicSpec = {
      ...spec,
      acceptance_criteria: [
        {
          id: "AC-1",
          criterion: "all tests pass",
          how_to_verify: kind.startsWith("targeted") ? "bun test test/loopback.test.ts" : "bun test",
        },
      ],
    };
    const result = applyGateEvidence(blocked, publicSpec, holdout, sha, evidence, baseline);
    expect(result.criteria[0]?.status).toBe("met");
    expect(result.criteria[0]?.evidence).toBe(
      `Factory gate tests passed at ${sha} (stage 12); commands: bun run test; 2 inherited skips`,
    );
    expect(result.criteria[0]?.gateEvidence).toEqual({
      stageId: 12,
      sha,
      check: "tests",
      command: "bun run test",
    });
  },
);

test.each(["broad", "targeted", "targeted-truncated"])(
  "fully skipped files provide only broad-suite evidence: %s",
  (kind) => {
    const { evidence, check, base, baseline } = inheritedFixture();
    for (const result of [check.result, base]) {
      result.output = `test/other.test.ts:\n(pass) other\n${result.output.replace("(pass) loopback [0.06ms]\n", "")}`;
      result.testCoverage = coverage(result.output);
    }
    if (kind === "targeted-truncated") check.result.output = "x".repeat(6000);
    const publicSpec = {
      ...spec,
      acceptance_criteria: [
        {
          id: "AC-1",
          criterion: "all tests pass",
          how_to_verify: kind === "broad" ? "bun test" : "bun test test/loopback.test.ts",
        },
      ],
    };
    const result = applyGateEvidence(blocked, publicSpec, holdout, sha, evidence, baseline);
    expect(result.criteria[0]?.status).toBe(kind === "broad" ? "met" : "blocked");
    if (kind !== "broad") expect(result.criteria[0]?.gateEvidence).toBeUndefined();
  },
);

test.each([
  "new-name",
  "new-file",
  "missing-baseline",
  "legacy-baseline",
  "legacy-candidate",
  "legacy-baseline-line",
  "legacy-candidate-line",
  "different-name",
  "different-command",
  "partial-identities",
  "identity-limit",
  "baseline-identity-limit",
  "unexplained-summary",
  "unexplained-summary-outside-tail",
  "orphan-row-outside-tail",
  "missing-summary",
  "zero-pass",
  "failure",
  "failure-outside-tail",
  "retry",
  "comparison-retry",
  "timeout",
  "confinement",
  "baseline-retry",
  "baseline-timeout",
  "baseline-failure",
  "baseline-confinement",
])("inherited skips do not excuse %s", (kind) => {
  const { evidence, check, base, baseline } = inheritedFixture();
  switch (kind) {
    case "new-name":
      check.result.output = check.result.output.replace("(skip) confined", "(skip) newly skipped");
      break;
    case "new-file":
      check.result.output = check.result.output.replace("test/loopback.test.ts:", "test/other.test.ts:");
      break;
    case "different-name":
      base.name = "other";
      break;
    case "different-command":
      base.command = "bun test";
      break;
    case "identity-limit":
      check.result.output = `test/loopback.test.ts:\n(pass) loopback\n${Array.from({ length: MAX_SKIPPED_TESTS + 1 }, (_, i) => `(skip) skip ${i}`).join("\n")}\n1 pass\n${MAX_SKIPPED_TESTS + 1} skip\n0 fail`;
      base.output = check.result.output;
      base.testCoverage = coverage(base.output);
      break;
    case "baseline-identity-limit":
      base.output = base.output
        .replace(
          "(skip) former skip",
          Array.from({ length: MAX_SKIPPED_TESTS }, (_, i) => `(skip) skip ${i}`).join("\n"),
        )
        .replace("2 skip", `${MAX_SKIPPED_TESTS + 1} skip`);
      base.testCoverage = coverage(base.output);
      break;
    case "unexplained-summary":
      check.result.output = check.result.output.replace("1 skip", "2 skip");
      break;
    case "unexplained-summary-outside-tail":
    case "orphan-row-outside-tail":
      check.result.output = `${kind === "orphan-row-outside-tail" ? "(skip) confined\n" : ""}test/loopback.test.ts:\n(pass) loopback\n1 pass\n1 skip\n0 fail`;
      break;
    case "missing-summary":
      check.result.output = check.result.output.replace("0 fail", "");
      break;
    case "zero-pass":
      check.result.output = check.result.output.replace("1 pass", "0 pass");
      break;
    case "failure":
    case "failure-outside-tail":
      check.result.output += "\n(fail) confined";
      break;
    case "retry":
      check.result.firstAttempt = { ...check.result };
      break;
    case "comparison-retry":
      check.firstAttempt = { ...check.result };
      break;
    case "timeout":
      check.result.timedOut = true;
      break;
    case "confinement":
      check.result.confinementError = true;
      break;
    case "baseline-retry":
      base.firstAttempt = { ...base };
      break;
    case "baseline-timeout":
      base.timedOut = true;
      break;
    case "baseline-failure":
      base.ok = false;
      base.exitCode = 1;
      break;
    case "baseline-confinement":
      base.confinementError = true;
      break;
  }
  check.result.testCoverage = coverage(check.result.output);
  if (kind.endsWith("outside-tail") || kind === "identity-limit") check.result.output = "x".repeat(6000);
  if (kind === "legacy-baseline") delete base.testCoverage?.skippedTests;
  if (kind === "legacy-candidate") delete check.result.testCoverage.skippedTests;
  if (kind === "legacy-baseline-line")
    for (const skip of base.testCoverage?.skippedTests ?? []) delete skip.line;
  if (kind === "legacy-candidate-line")
    for (const skip of check.result.testCoverage.skippedTests ?? []) delete skip.line;
  if (kind === "partial-identities") check.result.testCoverage.skippedFiles.push("test/unrecorded.test.ts");
  const result = applyGateEvidence(
    blocked,
    spec,
    holdout,
    sha,
    evidence,
    kind === "missing-baseline" ? undefined : baseline,
  );
  expect(result.criteria[0]?.status).toBe("blocked");
  expect(result.criteria[0]?.gateEvidence).toBeUndefined();
});

test.each(["suite", "targeted", "retained-coverage"])(
  "clean %s gate accepts skip/todo words in passing test names and prose",
  (kind) => {
    const evidence = gates();
    const check = evidence.checks[0];
    if (!check) throw new Error("missing fixture check");
    if (kind === "targeted") check.testCommand = "bun test test/loopback.test.ts";
    if (kind !== "suite") check.result.command = check.testCommand ?? "";
    check.result.output = [
      "test/loopback.test.ts:",
      "(pass) skipped scenarios are reported correctly",
      "(pass) todo items that are not run remain visible",
      "(pass) (skip) and (fail) markers are parsed correctly",
      "Diagnostic: skip and todo handling was checked; no scenarios were skipped.",
      "3 pass",
      "0 skip",
      "0 todo",
      "0 fail",
    ].join("\n");
    if (kind === "retained-coverage") {
      check.result.testCoverage = {
        passedFiles: ["test/loopback.test.ts"],
        skippedFiles: [],
        summary: { passed: 3, failed: 0 },
      };
      check.result.output = check.result.output.split("\n").slice(1).join("\n");
    }
    const result = resolve(blocked, evidence);
    expect(result.overall).toBe("pass");
    expect(result.criteria[0]?.status).toBe("met");
    expect(result.criteria[0]?.gateEvidence?.stageId).toBe(12);
  },
);

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
  "invalid persisted source line cannot authorize candidate or baseline skips: %s",
  (line) => {
    for (const side of ["candidate", "baseline"]) {
      const { evidence, check, base, baseline } = inheritedFixture();
      const skips = (side === "candidate" ? check.result : base).testCoverage?.skippedTests;
      if (!skips?.[0]) throw new Error("missing skipped testcase");
      skips[0].line = line;
      const result = applyGateEvidence(blocked, spec, holdout, sha, evidence, baseline);
      expect(result.criteria[0]?.status).toBe("blocked");
      expect(result.criteria[0]?.evidence).toContain(`${side} skip identities unavailable`);
    }
  },
);

test.each([
  "(skip) hidden scenario",
  "(todo) pending scenario",
  "(fail) failed scenario",
  "1 skip",
  "1 skipped",
  "1 todo",
  "1 fail",
  "not run: setup failed",
])("actual incomplete runner output prevents a citation: %s", (output) => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  check.result.output += `\n${output}`;
  const result = resolve(blocked, evidence);
  expect(result.overall).toBe("fail");
  expect(result.criteria[0]?.status).toBe("blocked");
  expect(result.criteria[0]?.gateEvidence).toBeUndefined();
});

test.each([
  "retried-pass",
  "first-failure",
  "first-timeout",
  "nested-first-failure",
  "nested-first-timeout",
  "flaky",
  "sibling-failure",
  "sibling-timeout",
  "sibling-confinement",
  "sibling-unrun",
  "sibling-skipped",
  "sibling-retained-skipped",
  "sibling-retry-failure",
])("no factory citation from a gate run with %s", (reason) => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  const failed = { ...check.result, ok: false, exitCode: 1, output: "assertion failed" };
  const timedOut = { ...check.result, ok: false, exitCode: null, timedOut: true };
  switch (reason) {
    case "retried-pass":
      check.firstAttempt = { ...check.result };
      break;
    case "first-failure":
      check.firstAttempt = failed;
      break;
    case "first-timeout":
      check.firstAttempt = timedOut;
      break;
    case "nested-first-failure":
      check.result.firstAttempt = { ...check.result, firstAttempt: failed };
      break;
    case "nested-first-timeout":
      check.result.firstAttempt = timedOut;
      break;
    case "flaky":
      check.verdict = "flaky";
      break;
    default: {
      const sibling = { ...check, name: "sibling", result: { ...check.result, name: "sibling" } };
      if (reason === "sibling-failure") sibling.result = failed;
      if (reason === "sibling-timeout") sibling.result = timedOut;
      if (reason === "sibling-confinement") sibling.result.confinementError = true;
      if (reason === "sibling-unrun") sibling.verdict = "not_run";
      if (reason === "sibling-skipped") sibling.result.output += "\n1 skip";
      if (reason === "sibling-retained-skipped")
        sibling.result.testCoverage = { passedFiles: [], skippedFiles: ["test/private.test.ts"] };
      if (reason === "sibling-retry-failure") sibling.firstAttempt = failed;
      evidence.checks.push(sibling);
    }
  }
  const result = resolve(blocked, evidence);
  expect(result.overall).toBe("fail");
  expect(result.criteria[0]?.status).toBe("blocked");
  expect(result.criteria[0]?.gateEvidence).toBeUndefined();
  expect(result.criteria[0]?.evidence).toContain(
    reason.includes("skipped") ? "skip identities unavailable" : "did not all pass cleanly",
  );
});

test.each([
  "bun test test/loopback.test.ts\ncurl http://127.0.0.1:3000/health",
  "bun test test/loopback.test.ts\nbun test test/other.test.ts",
  "Run `bun test test/loopback.test.ts`.\nInspect the HTTP health response",
  "Run `bun test test/loopback.test.ts` and inspect the HTTP health response",
])("partial gate coverage leaves every step blocked: %s", (steps) => {
  const publicSpec = {
    ...spec,
    acceptance_criteria: [{ id: "AC-1", criterion: "all tests pass", how_to_verify: steps }],
  };
  const result = resolve(blocked, gates(), publicSpec);
  expect(result.criteria[0]?.status).toBe("blocked");
  expect(result.criteria[0]?.gateEvidence).toBeUndefined();
  expect(result.criteria[0]?.evidence).toContain("do not cover every required verification step");
  const privateHoldout = {
    scenarios: [{ id: "H-1", description: "all steps pass", steps, expected: "ok", edge_case: true }],
  };
  const privateResult = applyGateEvidence(
    { ...blocked, criteria: blocked.criteria.map((c) => ({ ...c, id: "H-1" })) },
    { ...spec, acceptance_criteria: [] },
    privateHoldout,
    sha,
    gates(),
  );
  expect(privateResult.criteria[0]?.status).toBe("blocked");
  expect(privateResult.criteria[0]?.gateEvidence).toBeUndefined();
});

test("clean gate checks can cover all commands in a multi-step criterion", () => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  evidence.checks.push({
    ...check,
    name: "other",
    testCommand: "bun test test/other.test.ts",
    result: {
      ...check.result,
      command: "bun test test/other.test.ts",
      output: "test/other.test.ts:\n(pass) other test\n1 pass\n0 fail",
    },
  });
  const result = resolve(blocked, evidence, {
    ...spec,
    acceptance_criteria: [
      {
        id: "AC-1",
        criterion: "both tests pass",
        how_to_verify: "1. Run `bun test test/loopback.test.ts`.\n2. Run `bun test test/other.test.ts`.",
      },
    ],
  });
  expect(result.overall).toBe("pass");
  expect(result.criteria[0]?.gateEvidence?.command).toContain("bun test test/other.test.ts");
});

test.each([
  "failed",
  "not-run",
  "confinement",
  "retained-confinement",
  "timeout",
  "no-output",
  "skipped",
  "unrelated",
  "non-test-command",
  "filtered",
  "other-sha",
])("gate evidence refuses %s checks", (reason) => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  switch (reason) {
    case "failed":
      check.result.ok = false;
      check.result.exitCode = 1;
      break;
    case "not-run":
      check.verdict = "not_run";
      break;
    case "confinement":
      check.result.confinementError = true;
      break;
    case "retained-confinement":
      check.firstAttempt = { ...check.result, output: "sandbox_apply: Operation not permitted" };
      break;
    case "timeout":
      check.result.timedOut = true;
      break;
    case "no-output":
      check.result.output = "1 pass";
      break;
    case "skipped":
      check.result.output += "\n(skip) nested Seatbelt test";
      break;
    case "unrelated":
      check.result.output = "test/other.test.ts:\n(pass) something else";
      break;
    case "non-test-command":
      // A passing gate that runs no test runner has no test command to cover a criterion.
      check.testCommand = null;
      check.result.command = "true";
      check.result.output = "";
      break;
    case "filtered":
      check.testCommand = "bun test --test-name-pattern other";
      break;
    case "other-sha":
      evidence.sha = "b".repeat(40);
      break;
  }
  const result = resolve(blocked, evidence);
  expect(result.overall).toBe("fail");
  expect(result.criteria[0]?.status).toBe("blocked");
  expect(result.criteria[0]?.evidence).toContain("Factory gate substitution unavailable");
  if (reason === "other-sha") expect(result.criteria[0]?.evidence).toContain("exact verified SHA");
  if (reason === "non-test-command")
    expect(result.criteria[0]?.evidence).toContain("do not cover every required verification step");
});

test("a missing or empty candidate gate stage never substitutes", () => {
  expect(resolve(blocked).criteria[0]).toMatchObject({
    status: "blocked",
    evidence: "Factory gate substitution unavailable: no completed candidate gate stage for this run.",
  });
  expect(resolve(blocked, { ...gates(), checks: [] }).criteria[0]).toMatchObject({
    status: "blocked",
    evidence:
      "Factory gate substitution unavailable: candidate gate checks did not all pass cleanly without retries or skipped tests.",
  });
});

test("only the covering file is substituted; actionable or unclear criteria remain failures", () => {
  for (const status of ["unmet", "unclear", "blocked"] as const) {
    const result = resolve(
      {
        ...blocked,
        criteria: [
          ...blocked.criteria,
          { id: "AC-2", status, evidence: "EPERM unrelated check", publicSummary: "" },
        ],
      },
      gates(),
      {
        ...spec,
        acceptance_criteria: [
          ...spec.acceptance_criteria,
          { id: "AC-2", criterion: "other test passes", how_to_verify: "bun test test/other.test.ts" },
        ],
      },
    );
    expect(result.criteria[0]?.status).toBe("met");
    expect(result.criteria[1]?.status).toBe(status);
    expect(result.overall).toBe("fail");
  }
});

test("script expansion only accepts supported test runners from factory configuration", () => {
  expect(gateTestCommand("bun run test", { test: "bun test" })).toBe("bun test");
  expect(gateTestCommand("bun run test", {})).toBeNull();
  expect(gateTestCommand("bun run test", { test: "true || bun test" })).toBeNull();
  expect(gateTestCommand("cat farewell.txt", {})).toBeNull();
  expect(gateTestCommand("node test/loopback.js", {})).toBeNull();
  expect(
    resolve(blocked, gates(), {
      ...spec,
      acceptance_criteria: [{ id: "AC-1", criterion: "test suite passes", how_to_verify: "bun run test" }],
    }).overall,
  ).toBe("pass");
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  check.testCommand = "node test/loopback.js";
  check.result.command = check.testCommand;
  check.result.output = "loopback passed";
  expect(
    resolve(blocked, evidence, {
      ...spec,
      acceptance_criteria: [
        {
          ...spec.acceptance_criteria[0],
          id: "AC-1",
          criterion: "loopback passes",
          how_to_verify: "node test/loopback.js",
        },
      ],
    }).overall,
  ).toBe("fail");
});

test.each([
  "returns goodbye",
  "tests pass and the HTTP response is goodbye",
  "HTTP returns goodbye if tests pass",
])("a passing test runner does not prove a specific required observation: %s", (expected) => {
  const publicSpec = {
    ...spec,
    acceptance_criteria: [
      {
        ...spec.acceptance_criteria[0],
        id: "AC-1",
        criterion: expected,
        how_to_verify: "bun test test/loopback.test.ts",
      },
    ],
  };
  expect(resolve(blocked, gates(), publicSpec).criteria[0]).toMatchObject({
    status: "blocked",
    evidence: "Factory gate substitution unavailable: required outcome is not solely that tests pass.",
  });
  const privateResult = applyGateEvidence(
    { ...blocked, criteria: blocked.criteria.map((row) => ({ ...row, id: "H-1" })) },
    { ...spec, acceptance_criteria: [] },
    {
      scenarios: [
        {
          id: "H-1",
          description: "observation",
          steps: "bun test test/loopback.test.ts",
          expected,
          edge_case: false,
        },
      ],
    },
    sha,
    gates(),
  );
  expect(privateResult.criteria[0]?.status).toBe("blocked");
  expect(privateResult.criteria[0]?.gateEvidence).toBeUndefined();
});

test.each(["wrong-content", "zero-tests-truncated", "noisy-pass"])(
  "real gate execution preserves the proof boundary: %s",
  async (kind) => {
    process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
    const cwd = mkdtempSync(join(tmpdir(), "limitless-gate-evidence-"));
    try {
      writeFileSync(join(cwd, "farewell.txt"), "hello\n");
      writeFileSync(join(cwd, "empty.test.ts"), "");
      writeFileSync(
        join(cwd, "passing.test.ts"),
        `import { test, expect } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n`,
      );
      const command =
        kind === "wrong-content"
          ? "cat farewell.txt"
          : `bun test ./${kind === "noisy-pass" ? "passing" : "empty"}.test.ts`;
      const run = await confinementScope.run(fakeConfinement, () =>
        runGates(
          cwd,
          {
            source: ".limitless.toml",
            setup: [],
            protectedPaths: [],
            checks: [{ name: "tests", run: command }],
          },
          new AbortController().signal,
        ),
      );
      expect(run.checks[0]?.ok).toBe(true);
      const check = run.checks[0];
      if (kind !== "wrong-content" && check) {
        // The summary was streamed; drop it from the retained tail, as later output would. Only
        // the streamed coverage may decide (descendants can no longer write after the command).
        expect(check.testCoverage?.summary).toBeDefined();
        check.output = "x".repeat(6000);
      }
      const evidence = {
        stageId: 12,
        sha,
        checks: compareGates(null, run).map((check) => ({
          ...check,
          testCommand: gateTestCommand(check.result.command, {}),
        })),
      };
      const privateHoldout = {
        scenarios: [
          {
            id: "H-1",
            description: "gate check",
            steps: command,
            expected: kind === "wrong-content" ? "goodbye" : "tests pass",
            edge_case: false,
          },
        ],
      };
      const publicSpec = { ...spec, acceptance_criteria: [] };
      const result = normalizeVerify(
        applyGateEvidence(
          { ...blocked, criteria: blocked.criteria.map((row) => ({ ...row, id: "H-1" })) },
          publicSpec,
          privateHoldout,
          sha,
          evidence,
        ),
        publicSpec,
        privateHoldout,
      );
      expect(result.criteria[0]?.status).toBe(kind === "noisy-pass" ? "met" : "blocked");
      expect(result.overall).toBe(kind === "noisy-pass" ? "pass" : "fail");
      if (kind !== "noisy-pass") {
        expect(result.criteria[0]?.gateEvidence).toBeUndefined();
        expect(result.criteria[0]?.evidence).toContain("Factory gate substitution unavailable");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test.each(["relative", "linux-absolute", "macos-absolute", "colored-crlf", "github-actions", "skipped"])(
  "Bun file and summary parsing is independent of output format: %s",
  (format) => {
    const cwd = format === "linux-absolute" ? "/home/runner/work/project/project" : "/private/var/project";
    const file = format.endsWith("absolute") ? `${cwd}/test/loopback.test.ts` : "./test/loopback.test.ts";
    const coverage = new BunTestCoverage(cwd);
    const lines = [`${file}:`, "(pass) loopback", "1 pass", "0 fail"];
    if (format === "github-actions") {
      lines[0] = `::group::${file}:`;
      lines.splice(2, 0, "::endgroup::");
    }
    if (format === "skipped") lines.splice(2, 0, "(skip) unavailable", "1 skip");
    if (format === "colored-crlf") {
      lines[2] = "1 passed";
      lines[3] = "0 failed";
    }
    for (const line of lines) coverage.observe(format === "colored-crlf" ? `\x1b[32m${line}\x1b[0m\r` : line);
    expect(coverage.result()).toEqual({
      passedFiles: ["test/loopback.test.ts"],
      skippedFiles: format === "skipped" ? ["test/loopback.test.ts"] : [],
      ...(format === "skipped" ? { skippedTestsIncomplete: true } : {}),
      summary: { passed: 1, failed: 0 },
    });
  },
);

test("Bun absolute file headers and checkout roots use the same realpath", () => {
  const cwd = mkdtempSync(join(tmpdir(), "limitless-coverage-path-"));
  try {
    const alias = join(cwd, "alias");
    writeFileSync(join(cwd, "loopback.test.ts"), "");
    symlinkSync(cwd, alias, "dir");
    for (const [root, header] of [
      [alias, realpathSync(cwd)],
      [realpathSync(cwd), alias],
    ]) {
      const coverage = new BunTestCoverage(root);
      for (const line of [`${header}/loopback.test.ts:`, "(pass) loopback", "1 pass", "0 fail"])
        coverage.observe(line);
      expect(coverage.result()).toEqual({
        passedFiles: ["loopback.test.ts"],
        skippedFiles: [],
        summary: { passed: 1, failed: 0 },
      });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("console failure rows survive tail truncation without a report", () => {
  const parser = new BunTestCoverage();
  for (const line of ["one.test.ts:", "(pass) runs", "(fail) fails", "1 pass", "0 fail"])
    parser.observe(line);
  expect(parser.result().passedFiles).toEqual([]);
  expect(parser.result().summary?.failed).toBe(1);
  expect(parser.result().skippedTestsIncomplete).toBe(true);
});

test.each(["no-header", "no-summary", "partial-summary", "zero-tests", "truncated", "retained-pass"])(
  "exact targeted commands require positive file coverage and a summary: %s",
  (kind) => {
    const evidence = gates();
    const check = evidence.checks[0];
    if (!check) throw new Error("missing fixture check");
    check.testCommand = "bun test ./test/loopback.test.ts";
    check.result.command = check.testCommand;
    if (kind === "no-header") check.result.output = "1 pass\n0 fail";
    if (kind === "no-summary") check.result.output = "test/loopback.test.ts:\n(pass) loopback";
    if (kind === "partial-summary") check.result.output = "test/loopback.test.ts:\n(pass) loopback\n1 pass";
    if (kind === "zero-tests") check.result.output = "test/loopback.test.ts:\n0 pass\n0 fail";
    if (kind === "truncated" || kind === "retained-pass") check.result.output = "x".repeat(6000);
    if (kind === "retained-pass")
      check.result.testCoverage = {
        passedFiles: ["test/loopback.test.ts"],
        skippedFiles: [],
        summary: { passed: 1, failed: 0 },
      };
    const result = resolve(blocked, evidence);
    expect(result.criteria[0]?.status).toBe(kind === "retained-pass" ? "met" : "blocked");
    if (kind !== "retained-pass") {
      expect(result.criteria[0]?.gateEvidence).toBeUndefined();
      expect(result.criteria[0]?.evidence).toContain("Factory gate substitution unavailable");
    }
  },
);

test("public artifacts withhold the original private sandbox block", () => {
  const privateHoldout = {
    scenarios: [
      { id: "H-1", description: "private", steps: "secret_input_791", expected: "private", edge_case: true },
    ],
  };
  const value = resolve(
    { ...blocked, criteria: blocked.criteria.map((c) => ({ ...c, evidence: "EPERM secret_input_791" })) },
    gates(),
  );
  const artifact = preDeliveryVerifyArtifact(
    {
      ...value,
      modelId: "fake",
      round: 0,
      attempt: 0,
      modelOutput: {
        ...blocked,
        criteria: blocked.criteria.map((c) => ({
          ...c,
          evidence: "EPERM secret_input_791",
        })),
      },
    },
    spec,
    privateHoldout,
    "",
  );
  expect(artifact).toContain(`passed at ${sha} (stage 12)`);
  expect(artifact).not.toContain("secret_input_791");
  expect(artifact).not.toContain("modelOutput");
});

test("holdout artifacts retain factory citations when their test command is private", () => {
  const privateHoldout = {
    scenarios: [
      {
        id: "H-1",
        description: "private loopback",
        steps: "bun test test/loopback.test.ts",
        expected: "tests pass",
        edge_case: true,
      },
    ],
  };
  const value: Verify = {
    ...blocked,
    criteria: [
      {
        id: "H-1",
        status: "blocked",
        blockedReason: "sandbox",
        evidence: "EPERM test/loopback.test.ts",
        publicSummary: "",
      },
    ],
  };
  const result = applyGateEvidence(value, { ...spec, acceptance_criteria: [] }, privateHoldout, sha, gates());
  expect(result.criteria[0]?.status).toBe("met");
  const artifact = JSON.parse(
    preDeliveryVerifyArtifact(
      { ...result, modelId: "fake", round: 0, attempt: 0, modelOutput: value },
      { ...spec, acceptance_criteria: [] },
      privateHoldout,
      "",
    ),
  ) as Verify;
  expect(artifact.criteria[0]?.evidence).toContain(`passed at ${sha} (stage 12)`);
  expect(artifact.criteria[0]?.gateEvidence?.sha).toBe(sha);
  expect(JSON.stringify(artifact)).not.toContain("test/loopback.test.ts");
  expect(artifact).not.toHaveProperty("modelOutput");
});

test.each([
  ["new occurrence", "occurrences not inherited"],
  ["missing base commit", "commit provenance unavailable"],
  ["stale base", "does not match the checked base"],
  ["missing diff", "changed-file provenance unavailable"],
  ["command", "command does not match"],
  ["identities", "baseline skip identities unavailable"],
  ...["added", "modified", "deleted", "rename-source", "rename-destination"].map((kind) => [
    kind,
    "files changed",
  ]),
])("inheritance refuses %s with a specific reason", (kind, reason) => {
  const { evidence, check, baseline, base } = inheritedFixture();
  if (kind === "new occurrence")
    check.result.testCoverage?.skippedTests?.push({
      file: "test/loopback.test.ts",
      name: "confined",
      line: 1,
    });
  else if (kind === "missing base commit") delete baseline.sha;
  else if (kind === "stale base") evidence.baseSha = "b".repeat(40);
  else if (kind === "missing diff") delete (evidence as GateEvidence).changedFiles;
  else if (kind === "command") base.command = "bun test";
  else if (kind === "identities") delete base.testCoverage?.skippedTests;
  else
    evidence.changedFiles =
      kind === "rename-source"
        ? ["renamed.test.ts", "test/loopback.test.ts"]
        : ["test/loopback.test.ts", "old.test.ts"];
  const result = applyGateEvidence(blocked, spec, holdout, sha, evidence, baseline);
  expect(result.criteria[0]?.status).toBe("blocked");
  expect(result.criteria[0]?.evidence).toContain(reason ?? "");
});

test("inherited duplicate occurrences are counted in the citation", () => {
  const { evidence, check, baseline, base } = inheritedFixture();
  for (const result of [check.result, base])
    result.testCoverage?.skippedTests?.push({ file: "test/loopback.test.ts", name: "confined", line: 1 });
  expect(applyGateEvidence(blocked, spec, holdout, sha, evidence, baseline).criteria[0]?.evidence).toContain(
    "3 inherited skips",
  );
});

test("unchanged duplicate titles cannot swap source lines through an edited helper", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "skip-lines-"));
  try {
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(
      join(cwd, "same.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { first, second } from "./helper.ts";',
        'test.skipIf(first)("same", () => expect(true).toBe(true));',
        'test.skipIf(second)("same", () => expect(true).toBe(true));',
        'test("runs", () => expect(true).toBe(true));',
      ].join("\n"),
    );
    const capture = async (first: boolean, second: boolean) => {
      writeFileSync(join(cwd, "helper.ts"), `export const first = ${first}, second = ${second};`);
      const run = await confinementScope.run(fakeConfinement, () =>
        runLocalGates(
          cwd,
          {
            source: "detected",
            setup: [],
            checks: [
              {
                name: "tests",
                run: `${process.execPath} test --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT"`,
              },
            ],
            protectedPaths: [],
          },
          new AbortController().signal,
        ),
      );
      expect(run.checks[0]?.ok).toBe(true);
      return { ...run, sha };
    };
    const first = await capture(true, false);
    const swapped = await capture(false, true);
    const both = await capture(true, true);
    expect(first.checks[0]?.testCoverage?.skippedTests).toEqual([
      { file: "same.test.ts", name: "same", line: 3 },
    ]);
    expect(swapped.checks[0]?.testCoverage?.skippedTests).toEqual([
      { file: "same.test.ts", name: "same", line: 4 },
    ]);
    const evidence = { ...gates(), baseSha: sha, changedFiles: ["helper.ts"] };
    const check = evidence.checks[0];
    if (!check) throw new Error("missing fixture check");
    const broad = {
      ...spec,
      acceptance_criteria: [{ id: "AC-1", criterion: "all tests pass", how_to_verify: "bun test" }],
    };
    for (const [baseline, candidate, status] of [
      [first, swapped, "blocked"],
      [both, first, "met"],
    ] as const) {
      const result = candidate.checks[0];
      if (!result) throw new Error("missing candidate check");
      check.result = result;
      const verdict = applyGateEvidence(blocked, broad, holdout, sha, evidence, baseline).criteria[0];
      expect(verdict?.status).toBe(status);
      expect(verdict?.evidence).toContain(
        status === "met" ? "1 inherited skips" : "occurrences not inherited",
      );
    }
    // A matching title at another line cannot supply a second occurrence of line 3.
    const result = first.checks[0];
    const skip = result?.testCoverage?.skippedTests?.[0];
    if (!result || !skip) throw new Error("missing skipped testcase");
    check.result = structuredClone(result);
    check.result.testCoverage?.skippedTests?.push(skip);
    const verdict = applyGateEvidence(blocked, broad, holdout, sha, evidence, both).criteria[0];
    expect(verdict?.status).toBe("blocked");
    expect(verdict?.evidence).toContain("occurrences not inherited");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Captured from Bun 1.4.3; hostname replaced. A `test.skipIf` flag moves the skip between two
// tests named `x`: `describe("outer") > describe("inner")` and `describe("b")`.
const swapJUnit = {
  inner: `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="2" failures="0" skipped="1" time="0.002826">
  <testsuite name="test/swap.test.ts" file="test/swap.test.ts" tests="3" assertions="2" failures="0" skipped="1" time="0.000669" hostname="example.com">
    <testsuite name="outer" file="test/swap.test.ts" line="3" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="example.com">
      <testsuite name="inner" file="test/swap.test.ts" line="4" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="example.com">
        <testcase name="x" classname="inner &gt; outer" time="0" file="test/swap.test.ts" line="5" assertions="0">
          <skipped />
        </testcase>
      </testsuite>
    </testsuite>
    <testsuite name="b" file="test/swap.test.ts" line="8" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="example.com">
      <testcase name="x" classname="b" time="0.000011" file="test/swap.test.ts" line="9" assertions="1" />
    </testsuite>
    <testcase name="runs" classname="" time="0.000004" file="test/swap.test.ts" line="11" assertions="1" />
  </testsuite>
</testsuites>`,
  b: `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="2" failures="0" skipped="1" time="0.002052">
  <testsuite name="test/swap.test.ts" file="test/swap.test.ts" tests="3" assertions="2" failures="0" skipped="1" time="0.000478" hostname="example.com">
    <testsuite name="outer" file="test/swap.test.ts" line="3" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="example.com">
      <testsuite name="inner" file="test/swap.test.ts" line="4" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="example.com">
        <testcase name="x" classname="inner &gt; outer" time="0.000008" file="test/swap.test.ts" line="5" assertions="1" />
      </testsuite>
    </testsuite>
    <testsuite name="b" file="test/swap.test.ts" line="8" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="example.com">
      <testcase name="x" classname="b" time="0" file="test/swap.test.ts" line="9" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
    <testcase name="runs" classname="" time="0.000003" file="test/swap.test.ts" line="11" assertions="1" />
  </testsuite>
</testsuites>`,
};

test.each([
  ["inner", "met"],
  ["b", "blocked"],
] as const)("skip identities include the describe path (candidate skips %s)", (skipped, status) => {
  const cwd = mkdtempSync(join(tmpdir(), "skip-describe-"));
  try {
    mkdirSync(join(cwd, "test"));
    writeFileSync(join(cwd, "test/swap.test.ts"), "");
    // A changed helper behind `skipIf` can swap which same-named test skips without editing the file.
    const output = "test/swap.test.ts:\n(pass) runs\n2 pass\n1 skip\n0 fail\nRan 3 tests across 1 file.";
    const result = (variant: keyof typeof swapJUnit) => {
      writeFileSync(join(cwd, "report.xml"), swapJUnit[variant]);
      const parsed = readJUnitSkips(join(cwd, "report.xml"), cwd);
      const parser = new BunTestCoverage(cwd);
      const runner = new RunnerFailureEvidence();
      for (const line of output.split("\n")) {
        parser.observe(line);
        runner.observe(line);
      }
      const template = gates().checks[0];
      if (!template) throw new Error("missing fixture check");
      return {
        ...template.result,
        output,
        testCoverage: parser.result(parsed, runner.agrees(parsed?.counts)),
      };
    };
    const base = result("inner");
    expect(base.testCoverage.skippedTests).toEqual([
      { file: "test/swap.test.ts", name: "outer > inner > x", line: 5 },
    ]);
    expect(result("b").testCoverage.skippedTests).toEqual([
      { file: "test/swap.test.ts", name: "b > x", line: 9 },
    ]);
    const evidence = { ...gates(), baseSha: sha, changedFiles: ["src/helper.ts"] };
    const check = evidence.checks[0];
    if (!check) throw new Error("missing fixture check");
    check.result = result(skipped);
    const baseline: GateRun = { sha, setupOk: true, setup: [], checks: [base] };
    const broad = {
      ...spec,
      acceptance_criteria: [{ id: "AC-1", criterion: "all tests pass", how_to_verify: "bun test" }],
    };
    const verdict = applyGateEvidence(blocked, broad, holdout, sha, evidence, baseline).criteria[0];
    expect(verdict?.status).toBe(status);
    expect(verdict?.evidence).toContain(
      skipped === "inner" ? "1 inherited skips" : "skipped-test occurrences not inherited from the baseline",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("redaction collisions cannot authorize inherited skips at cache or resume boundaries", () => {
  const secret = ["credential", "skip", "collision"].join("-").repeat(4);
  const { evidence, check, baseline, base } = inheritedFixture();
  if (!base.testCoverage?.skippedTests || !check.result.testCoverage?.skippedTests)
    throw new Error("missing skips");
  base.testCoverage.skippedTests[0] = { file: "test/loopback.test.ts", name: secret, line: 1 };
  check.result.testCoverage.skippedTests[0] = { file: "test/loopback.test.ts", name: "[redacted]", line: 1 };
  registerCredential("collision-fixture", secret);
  for (const stored of [redactGateData(baseline), { ...baseline, checks: [redactGateDiagnostics(base)] }]) {
    expect(stored.checks[0]?.testCoverage?.skippedTestsIncomplete).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const result = applyGateEvidence(blocked, spec, holdout, sha, evidence, stored);
    expect(result.criteria[0]?.status).toBe("blocked");
    expect(result.criteria[0]?.evidence).toContain("baseline skip identities unavailable");
    expect(JSON.stringify(result)).not.toContain(secret);
  }
});

const behaviouralSpec: Spec = {
  ...spec,
  acceptance_criteria: [
    { id: "AC-1", criterion: "A restart preserves the original reason", how_to_verify: "restart" },
  ],
};
const requested: Verify = {
  ...blocked,
  criteria: blocked.criteria.map((c) => ({
    ...c,
    covering_tests: [{ file: "x.test.ts", name: "passes" }],
  })),
};
function coveringRun(): CoveringTestRun {
  return {
    file: "x.test.ts",
    name: "passes",
    verifiedSha: sha,
    round: 0,
    stageId: 13,
    result: {
      name: "test",
      command: "bun test -t '(?:^| )passes$' './x.test.ts'",
      ok: true,
      exitCode: 0,
      durationMs: 1,
      output: "1 pass\n0 fail",
      executionProvenance: { sha, trackedClean: true },
      coveringTest: { file: "x.test.ts", name: "passes" },
      testCoverage: { passedFiles: ["x.test.ts"], skippedFiles: [], summary: { passed: 1, failed: 0 } },
    },
  };
}
const bindCovering = (value: Verify, runs: CoveringTestRun[], succeededStageIds = [13]) =>
  applyGateEvidence(value, behaviouralSpec, holdout, sha, gates(), undefined, { runs, succeededStageIds });

test("behavioural coverage binds only the factory record and cites its exact command", () => {
  const run = coveringRun();
  if (!run.result) throw new Error("missing result");
  run.result.executedCommand = `${run.result.command} --reporter=junit --reporter-outfile=report.xml`;
  const result = bindCovering(requested, [run]).criteria[0];
  expect(result).toMatchObject({
    status: "met",
    gateEvidence: {
      stageId: 13,
      sha,
      check: "x.test.ts › passes",
      command: run.result?.executedCommand,
    },
  });
  expect(result?.evidence).toBe(
    `Factory covering test x.test.ts › passes passed at ${sha} (stage 13); command: ${run.result?.executedCommand}`,
  );
});

test.each([
  {
    label: "zero matches",
    reason: "name matched no tests",
    change: { coveringTest: { file: "x.test.ts", name: "passes", reason: "name matched no tests" } },
  },
  { label: "failure", reason: "test failed", change: { ok: false, exitCode: 1 } },
  {
    label: "failed testcase",
    reason: "test failed",
    change: { coveringTest: { file: "x.test.ts", name: "passes", reason: "test failed" } },
  },
  {
    label: "missing JUnit evidence in legacy record",
    reason: "missing exact testcase JUnit evidence",
    change: { coveringTest: undefined },
  },
  {
    label: "skip",
    reason: "named test skipped",
    change: { coveringTest: { file: "x.test.ts", name: "passes", reason: "named test skipped" } },
  },
  {
    label: "dirty tree",
    reason: "run changed tracked files",
    change: { executionProvenance: { sha, trackedClean: false } },
  },
  {
    label: "different SHA",
    reason: "run executed at a different SHA",
    change: { executionProvenance: { sha: "b".repeat(40), trackedClean: true } },
  },
  {
    label: "short SHA",
    reason: "run executed at a different SHA",
    change: { executionProvenance: { sha: "abcd", trackedClean: true } },
  },
  { label: "timeout", reason: "test failed", change: { timedOut: true } },
  { label: "confinement", reason: "test failed", change: { confinementError: true } },
  {
    label: "wrong JUnit identity",
    reason: "missing exact testcase JUnit evidence",
    change: { coveringTest: { file: "other.test.ts", name: "passes" } },
  },
])("covering-test binding refuses $label", ({ reason, change }) => {
  const run = coveringRun();
  if (!run.result) throw new Error("missing result");
  Object.assign(run.result, change);
  const result = bindCovering(requested, [run]).criteria[0];
  expect(result).toMatchObject({ status: "blocked", blockedReason: "sandbox" });
  expect(result?.evidence).toStartWith(
    "Factory gate substitution unavailable: required outcome is not solely that tests pass;",
  );
  expect(result?.evidence).toContain(reason);
  expect(result?.gateEvidence).toBeUndefined();
});

test.each(["file not tracked at verified SHA", "file outside repository", "targeted retries not configured"])(
  "covering-test preflight refusal is retained: %s",
  (reason) => {
    expect(
      bindCovering(requested, [{ ...coveringRun(), result: undefined, reason }]).criteria[0],
    ).toMatchObject({
      status: "blocked",
      blockedReason: "sandbox",
      evidence: expect.stringContaining(reason),
    });
  },
);

test("a covering record needs a succeeded stage, while unrelated console evidence is harmless", () => {
  expect(bindCovering(requested, [coveringRun()], []).criteria[0]?.status).toBe("blocked");
  const run = coveringRun();
  if (!run.result?.testCoverage) throw new Error("missing coverage");
  run.result.testCoverage = { passedFiles: [], skippedFiles: [], skippedTestsIncomplete: true };
  run.result.output = "(fail) unrelated";
  expect(bindCovering(requested, [run]).criteria[0]?.status).toBe("met");
});

test("fabricated covering citations and provenance cannot replace factory records", () => {
  for (const status of ["met", "blocked"] as const) {
    const value = VerifySchema.parse({
      ...requested,
      criteria: requested.criteria.map((c) => ({
        ...c,
        status,
        evidence: `Factory covering test x.test.ts › passes passed at ${sha} (stage 13)`,
        gateEvidence: { stageId: 13, sha, check: "test", command: "bun test" },
      })),
    });
    const result = bindCovering(value, []).criteria[0];
    expect(result?.status).toBe(status);
    expect(result?.gateEvidence).toBeUndefined();
    if (status === "blocked") expect(result?.evidence).toContain("no factory record");
  }
});

test("covering selection enforces both limits and never accepts a partial criterion", () => {
  const eleven: Verify = {
    ...requested,
    criteria: Array.from({ length: 11 }, (_, i) => ({
      ...requested.criteria[0],
      id: `AC-${i + 1}`,
      status: "blocked",
      blockedReason: "sandbox",
      evidence: "sandbox",
      publicSummary: "",
      covering_tests: [{ file: "x.test.ts", name: `test ${i}` }],
    })),
  };
  const selected = selectCoveringTests(eleven);
  expect(selected.flatMap((s) => s.tests)).toHaveLength(10);
  expect(selected[10]?.reason).toBe("per-round limit reached");
  expect(bindCovering(eleven, []).criteria[10]?.evidence).toContain("per-round limit reached");
  const four: Verify = {
    ...requested,
    criteria: requested.criteria.map((c) => ({
      ...c,
      covering_tests: Array.from({ length: 4 }, () => ({ file: "x.test.ts", name: "passes" })),
    })),
  };
  expect(selectCoveringTests(four)[0]?.tests).toHaveLength(3);
  expect(bindCovering(four, [coveringRun()]).criteria[0]).toMatchObject({
    status: "blocked",
    evidence: expect.stringContaining("per-criterion limit reached"),
  });
});

const coveringConfig: GateConfig = {
  setup: [],
  checks: [{ name: "test", run: "bun test" }],
  retryFiles: "bun test {files}",
  source: ".limitless.toml",
  protectedPaths: [],
};
const coveringSeed = seeded(async (cwd) => {
  await sh(["git", "init", "-q"], { cwd });
  writeFileSync(
    join(cwd, "x.test.ts"),
    `import {test, expect, describe} from 'bun:test';
test('a.*b', () => expect(true).toBe(true));
test('aXXb', () => { throw new Error('wrong test ran'); });
test('$(touch pwned)', () => expect(true).toBe(true));
test(${JSON.stringify('it\'s "literal"')}, () => expect(true).toBe(true));
describe('outer', () => describe('inner', () => test('passes', () => expect(true).toBe(true))));
`,
  );
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "covering fixture"], { cwd });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
});

test("covering commands validate trusted configuration and tracked, contained test files before running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "covering-commands-"));
  const outside = mkdtempSync(join(tmpdir(), "covering-outside-"));
  try {
    const { value: checkedSha } = await coveringSeed(cwd);
    writeFileSync(join(cwd, "untracked.test.ts"), "");
    writeFileSync(join(outside, "escape.test.ts"), "");
    symlinkSync(join(outside, "escape.test.ts"), join(cwd, "escape.test.ts"));
    for (const cfg of [
      undefined,
      { ...coveringConfig, retryFiles: undefined },
      { ...coveringConfig, retryFiles: "bun test" },
      { ...coveringConfig, retryFiles: "bun test '{files}'" },
      { ...coveringConfig, retryFiles: "bun test {files} {files}" },
      { ...coveringConfig, checks: [{ name: "test", run: "npm test" }] },
      { ...coveringConfig, checks: [...coveringConfig.checks, ...coveringConfig.checks] },
    ])
      expect(await coveringTestCommand({ file: "x.test.ts", name: "passes" }, cfg, cwd, checkedSha)).toEqual({
        reason: "targeted retries not configured",
      });
    for (const file of ["../x.test.ts", join(cwd, "x.test.ts"), "escape.test.ts", "bad\n.test.ts"])
      expect(
        await coveringTestCommand({ file, name: "passes" }, coveringConfig, cwd, checkedSha),
      ).toMatchObject({ reason: expect.stringContaining("outside repository") });
    expect(
      await coveringTestCommand(
        { file: "untracked.test.ts", name: "passes" },
        coveringConfig,
        cwd,
        checkedSha,
      ),
    ).toEqual({ reason: "file not tracked at verified SHA" });
    for (const name of ["", "bad\nname", "x".repeat(2001)])
      expect(await coveringTestCommand({ file: "x.test.ts", name }, coveringConfig, cwd, checkedSha)).toEqual(
        { reason: "invalid test name" },
      );
    for (const name of ["$(x)", "`x`", "a.*b", "'", '"', ";", "'`x`", "' -t '`x`"]) {
      const built = await coveringTestCommand({ file: "x.test.ts", name }, coveringConfig, cwd, checkedSha);
      expect(built.command).toBeDefined();
      expect(singleBunTest(built.command ?? "")).toBe(true);
      expect(built.command).toContain(" -t '(?:^| )");
      expect(singleBunTest(`${built.command} './tick\u0060.test.ts'`)).toBe(false);
    }
    for (const name of ["a.*b", "$(touch pwned)", `it's "literal"`, "outer inner passes"]) {
      const built = await coveringTestCommand({ file: "x.test.ts", name }, coveringConfig, cwd, checkedSha);
      if (!built.command) throw new Error(built.reason);
      const gate = await confinementScope.run(fakeConfinement, () =>
        runLocalGates(
          cwd,
          {
            ...coveringConfig,
            checks: [
              {
                name: "test",
                run: built.command.replace(/^bun /, `${process.execPath} `),
                coveringTest: { file: "x.test.ts", name },
              },
            ],
          },
          new AbortController().signal,
        ),
      );
      const result = gate.checks[0];
      expect(result?.ok, result?.output).toBe(true);
      expect(result?.testCoverage?.summary).toEqual({ passed: 1, failed: 0 });
      expect(result?.coveringTest).toEqual({ file: "x.test.ts", name, reason: undefined });
      expect(existsSync(join(cwd, "pwned"))).toBe(false);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an option terminator in retry_files cannot turn the name filter into a positional argument", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "covering-terminator-"));
  try {
    await coveringSeed(cwd);
    writeFileSync(join(cwd, "y.test.ts"), 'import { test } from "bun:test";\ntest("unrelated", () => {});\n');
    await sh(["git", "add", "."], { cwd });
    await sh(["git", "commit", "-qm", "unrelated passing test"], { cwd });
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
    const cfg = { ...coveringConfig, retryFiles: "bun test {files} --" };
    const test = { file: "y.test.ts", name: "missing" };
    const built = await coveringTestCommand(test, cfg, cwd, head);
    expect(built.command).toBe("bun test -t '(?:^| )missing$' './y.test.ts' --");
    if (!built.command) throw new Error(built.reason);
    const command = built.command.replace(/^bun /, `${process.execPath} `);
    const gate = await confinementScope.run(fakeConfinement, () =>
      runLocalGates(
        cwd,
        {
          source: "detected",
          setup: [],
          checks: [{ name: "test", run: command, coveringTest: test }],
          protectedPaths: [],
        },
        new AbortController().signal,
      ),
    );
    const check = gate.checks[0];
    if (!check) throw new Error("missing covering check");
    const result = { ...check, executionProvenance: { sha: head, trackedClean: true } };
    const refusal = coveringTestRefusal({ ...coveringRun(), ...test, verifiedSha: head, result }, head, [
      coveringRun().stageId,
    ]);
    // Bun exits non-zero when the filter matches nothing; either way the unrelated pass is not evidence.
    expect(["name matched no tests", "test failed", "JUnit report missing, stale or unsafe"]).toContain(
      refusal ?? "accepted",
    );
    expect(check.testCoverage?.passedFiles ?? []).not.toContain("y.test.ts");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a nested skipped match refuses binding even when another exact full-name match passed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "covering-nested-skip-"));
  try {
    const seed = seeded(async (dir) => {
      await sh(["git", "init", "-q"], { cwd: dir });
      writeFileSync(
        join(dir, "x.test.ts"),
        [
          'import { describe, expect, test } from "bun:test";',
          'test("outer passes", () => expect(true).toBe(true));',
          'describe("outer", () => {',
          '  test.skip("passes", () => expect(true).toBe(true));',
          '  test("other", () => expect(true).toBe(true));',
          "});",
          "",
        ].join("\n"),
      );
      await sh(["git", "add", "."], { cwd: dir });
      await sh(["git", "commit", "-qm", "nested skip fixture"], { cwd: dir });
      return (await sh(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    });
    const { value: checkedSha } = await seed(cwd);
    // Bun's filter sees both `outer passes` tests; the skipped one is reported as `outer > passes`.
    const test = { file: "x.test.ts", name: "outer passes" };
    const built = await coveringTestCommand(test, coveringConfig, cwd, checkedSha);
    if (!built.command) throw new Error(built.reason);
    const command = built.command.replace(/^bun /, `${process.execPath} `);
    for (const run of [command, `${command} --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT"`]) {
      const gate = await confinementScope.run(fakeConfinement, () =>
        runLocalGates(
          cwd,
          {
            source: "detected",
            setup: [],
            checks: [{ name: "test", run, coveringTest: test }],
            protectedPaths: [],
          },
          new AbortController().signal,
        ),
      );
      const check = gate.checks[0];
      if (!check) throw new Error("missing covering check");
      expect(check.testCoverage?.summary).toEqual({ passed: 1, failed: 0 });
      const result = { ...check, executionProvenance: { sha, trackedClean: true } };
      const record: CoveringTestRun = {
        ...coveringRun(),
        ...test,
        result,
      };
      const nested: Verify = {
        ...requested,
        criteria: requested.criteria.map((c) => ({ ...c, covering_tests: [test] })),
      };
      const verdict = bindCovering(nested, [record]).criteria[0];
      expect(verdict).toMatchObject({ status: "blocked", blockedReason: "sandbox" });
      expect(verdict?.evidence).toContain("named test skipped");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.each([
  ["exact", undefined],
  ["canonical", undefined],
  ["nested", undefined],
  ["other-file", "name matched no tests"],
  ["suffix", "name matched no tests"],
  ["skipped", "named test skipped"],
  ["failed", "test failed"],
  ["errored", "test failed"],
  ["missing", "JUnit report missing, stale or unsafe"],
  ["stale", "JUnit report missing, stale or unsafe"],
  ["symlink", "JUnit report missing, stale or unsafe"],
  ["pre-existing", "JUnit report existed before execution"],
  ["malformed", "unparseable JUnit report"],
] as const)("covering JUnit requires fresh exact testcase evidence: %s", (mode, reason) => {
  const cwd = mkdtempSync(join(tmpdir(), "covering-junit-"));
  try {
    writeFileSync(join(cwd, "x.test.ts"), "");
    writeFileSync(join(cwd, "other.test.ts"), "");
    const path = join(cwd, "report.xml");
    const startedAt = Date.now();
    const name = mode === "nested" ? "outer inner passes" : "passes";
    const file =
      mode === "other-file"
        ? "other.test.ts"
        : mode === "canonical"
          ? realpathSync(join(cwd, "x.test.ts"))
          : "x.test.ts";
    const title = mode === "suffix" ? "outer passes" : "passes";
    const outcomes: Record<string, string> = { skipped: "skipped", failed: "failure", errored: "error" };
    const outcome = outcomes[mode];
    // Duplicate identities must all pass, regardless of their ordering.
    const cases =
      `<testcase name="${title}"/>` +
      (outcome ? `<testcase name="${title}"><${outcome}/></testcase><testcase name="${title}"/>` : "");
    const xml = `<testsuites><testsuite file="${file}">${mode === "nested" ? `<testsuite name="outer"><testsuite name="inner">${cases}</testsuite></testsuite>` : cases}</testsuite></testsuites>`;
    if (mode !== "missing") writeFileSync(path, mode === "malformed" ? "<testsuites><oops>" : xml);
    if (mode === "stale") utimesSync(path, 1, 1);
    if (mode === "symlink") {
      const target = join(cwd, "target.xml");
      writeFileSync(target, xml);
      rmSync(path);
      symlinkSync(target, path);
    }
    if (mode === "pre-existing") {
      // An earlier execution's report at this exact path is unusable even if its mtime looks fresh.
      expect(
        readCoveringJUnit(path, cwd, { file: "x.test.ts", name }, startedAt, false).reason,
      ).toBeUndefined();
    }
    const junit = readCoveringJUnit(
      path,
      cwd,
      { file: "./x.test.ts", name },
      startedAt,
      mode === "pre-existing",
    );
    expect(junit.reason).toBe(reason);
    const run = coveringRun();
    if (!run.result) throw new Error("missing result");
    run.name = name;
    run.result.coveringTest = junit;
    const value = {
      ...requested,
      criteria: requested.criteria.map((c) => ({ ...c, covering_tests: [{ file: "x.test.ts", name }] })),
    };
    const criterion = bindCovering(value, [run]).criteria[0];
    expect(criterion?.status).toBe(reason ? "blocked" : "met");
    if (reason) expect(criterion?.evidence).toContain(reason);
    else expect(criterion?.gateEvidence).toMatchObject({ stageId: 13, sha, command: run.result.command });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.each([
  "bun test -tunrelated {files}",
  "bun test '-t' unrelated {files}",
  "bun test {files} --test-name-pattern=unrelated",
  "bun test {files} --reporter=dot --reporter-outfile=unused.xml --",
])("covering evidence refuses filter or reporter overrides: %s", async (retryFiles) => {
  const cwd = mkdtempSync(join(tmpdir(), "covering-overrides-"));
  try {
    const { value: checkedSha } = await coveringSeed(cwd);
    // Filter overrides run an unrelated title; the reporter override suppresses proof of a real pass.
    const test = { file: "y.test.ts", name: retryFiles.includes("--reporter") ? "unrelated" : "missing" };
    writeFileSync(join(cwd, test.file), 'import { test } from "bun:test"; test("unrelated", () => {});');
    await sh(["git", "add", "."], { cwd });
    await sh(["git", "commit", "-qm", "override fixture"], { cwd });
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
    expect(head).not.toBe(checkedSha);
    const built = await coveringTestCommand(test, { ...coveringConfig, retryFiles }, cwd, head);
    if (!built.command) throw new Error(built.reason);
    const gate = await confinementScope.run(fakeConfinement, () =>
      runLocalGates(
        cwd,
        {
          ...coveringConfig,
          checks: [
            { name: "test", run: built.command.replace(/^bun /, `${process.execPath} `), coveringTest: test },
          ],
        },
        new AbortController().signal,
      ),
    );
    const result = gate.checks[0];
    if (!result) throw new Error("missing result");
    expect(result.coveringTest?.reason).toBeDefined();
    expect(result.ok, result.output).toBe(true);
    expect(result.testCoverage?.summary?.passed).toBe(1);
    if (!retryFiles.includes("--reporter")) {
      expect(result.coveringTest?.reason).toBe("name matched no tests");
    } else expect(result.coveringTest?.reason).toBe("JUnit report missing, stale or unsafe");
    const record = {
      ...coveringRun(),
      ...test,
      verifiedSha: head,
      result: { ...result, executionProvenance: { sha: head, trackedClean: true } },
    };
    expect(coveringTestRefusal(record, head, [13])).toBeDefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
