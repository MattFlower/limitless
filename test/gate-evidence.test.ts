import { expect, test } from "bun:test";
import { applyGateEvidence, type GateEvidence, gateTestCommand } from "../src/pipeline/gate-evidence.ts";
import { type Spec, type Verify, VerifySchema } from "../src/pipeline/schemas.ts";
import { normalizeVerify, preDeliveryVerifyArtifact } from "../src/pipeline/verification.ts";

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

test.each(["suite", "targeted", "custom", "retained-coverage"])(
  "clean %s gate accepts skip/todo words in passing test names and prose",
  (kind) => {
    const evidence = gates();
    const check = evidence.checks[0];
    if (!check) throw new Error("missing fixture check");
    if (kind === "targeted") check.testCommand = "bun test test/loopback.test.ts";
    if (kind === "custom") check.testCommand = "node test.js";
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
      check.result.testCoverage = { passedFiles: ["test/loopback.test.ts"], skippedFiles: [] };
      check.result.output = check.result.output.split("\n").slice(1).join("\n");
    }
    const publicSpec =
      kind === "custom"
        ? {
            ...spec,
            acceptance_criteria: [{ id: "AC-1", criterion: "test passes", how_to_verify: "node test.js" }],
          }
        : spec;
    const result = resolve(blocked, evidence, publicSpec);
    expect(result.overall).toBe("pass");
    expect(result.criteria[0]?.status).toBe("met");
    expect(result.criteria[0]?.gateEvidence?.stageId).toBe(12);
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
  expect(result.criteria[0]?.evidence).toContain("did not all pass cleanly");
});

test.each([
  "bun test test/loopback.test.ts\ncurl http://127.0.0.1:3000/health",
  "bun test test/loopback.test.ts\nbun test test/other.test.ts",
  "Run `bun test test/loopback.test.ts`.\nInspect the HTTP health response",
  "Run `bun test test/loopback.test.ts` and inspect the HTTP health response",
])("partial gate coverage leaves every step blocked: %s", (steps) => {
  const publicSpec = {
    ...spec,
    acceptance_criteria: [{ id: "AC-1", criterion: "all steps pass", how_to_verify: steps }],
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
    result: { ...check.result, command: "bun test test/other.test.ts", output: "1 pass\n0 fail" },
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

test("script expansion and exact custom test commands use factory configuration", () => {
  expect(gateTestCommand("bun run test", { test: "bun test" })).toBe("bun test");
  expect(gateTestCommand("bun run test", {})).toBeNull();
  expect(gateTestCommand("bun run test", { test: "true || bun test" })).toBeNull();
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
  ).toBe("pass");
});

test("an explicit targeted gate command covers the same test even when its output tail lost the header", () => {
  const evidence = gates();
  const check = evidence.checks[0];
  if (!check) throw new Error("missing fixture check");
  check.testCommand = "bun test ./test/loopback.test.ts";
  check.result.command = check.testCommand;
  check.result.output = "1 pass\n0 fail";
  expect(resolve(blocked, evidence).overall).toBe("pass");
  check.result.output = "1 pass\n1 skip\n0 fail";
  expect(resolve(blocked, evidence).overall).toBe("fail");
});

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
        expected: "private",
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
