import { expect, test } from "bun:test";
import type { RunEvent } from "../src/core/types.ts";
import { BROWSER_TOOLS } from "../src/harness/browser-mcp.ts";
import { selectCoveringTests } from "../src/pipeline/covering-tests.ts";
import { applyGateEvidence, type GateEvidence } from "../src/pipeline/gate-evidence.ts";
import { holdoutPrompt, specPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import { HoldoutSchema, SpecSchema, toStrictJsonSchema, VerifySchema } from "../src/pipeline/schemas.ts";
import {
  applyBrowserContext,
  BROWSER_INCOMPLETE,
  blockedOnly,
  browserSucceeded,
  normalizeVerify,
} from "../src/pipeline/verification.ts";
import { registerCredential } from "../src/util/proc.ts";

const criterion = { id: "AC-1", criterion: "UI tests pass", how_to_verify: "bun test test/ui.test.ts" };
const scenario = {
  id: "H-1",
  description: "UI interaction",
  steps: "bun test test/ui.test.ts",
  expected: "tests pass",
  edge_case: false,
};
const legacySpec = {
  summary: "UI",
  assumptions: [],
  requirements: [],
  out_of_scope: [],
  blocking_questions: [],
  acceptance_criteria: [criterion],
};
const legacyHoldout = { scenarios: [scenario] };
const spec = SpecSchema.parse({ ...legacySpec, acceptance_criteria: [{ ...criterion, browser: true }] });
const holdout = HoldoutSchema.parse({ scenarios: [{ ...scenario, browser: true }] });
const blocked = VerifySchema.parse({
  criteria: ["AC-1", "H-1"].map((id) => ({
    id,
    status: "blocked",
    blockedReason: "sandbox",
    evidence: "browser not used",
    publicSummary: "private",
    covering_tests: [{ file: "test/ui.test.ts", name: "UI works" }],
  })),
  overall: "pass",
  notes: "",
});

const browserCall = (name: string, id = "call"): RunEvent => ({
  id: 1,
  runId: "run",
  invocationId: 1,
  ts: 0,
  type: "tool_call",
  level: "info",
  message: name,
  data: { id, input: {} },
});
const browserResult = (level: RunEvent["level"] = "debug", id = "call"): RunEvent => ({
  ...browserCall("result", id),
  id: 2,
  type: "tool_result",
  level,
});

test.each(BROWSER_TOOLS)("successful granted browser tool %s is recognized for both harnesses", (tool) => {
  for (const prefix of ["playwright.", "mcp__playwright__"])
    expect(browserSucceeded([browserCall(`${prefix}${tool}`), browserResult()])).toBe(true);
});

test("browser success requires a matching granted call and a recorded successful result", () => {
  const call = browserCall("playwright.browser_snapshot");
  for (const events of [
    [],
    [call],
    [browserResult()],
    [call, browserResult("warn")],
    [call, browserResult("error")],
    [call, browserResult("info")],
    [call, browserResult("debug", "unmatched")],
    [browserResult(), call],
    [{ ...call, data: null }, browserResult()],
    [call, { ...browserResult(), data: {} }],
    [call, { ...browserResult(), type: "stderr" as const }],
    [call, browserCall("Read"), browserResult()],
  ])
    expect(browserSucceeded(events)).toBe(false);
  for (const name of [
    "Read",
    "other.browser_snapshot",
    "playwright.browser_run_code",
    "mcp__playwright__browser_run_code",
    "playwright.browser_snapshot_extra",
    "mcp__playwright__browser_snapshot_extra",
    "playwright.browser_snapshot: claimed success",
  ])
    expect(browserSucceeded([browserCall(name), browserResult()])).toBe(false);
});

test("browser markers default for older data and survive serialization; strict schemas require them", () => {
  expect(SpecSchema.parse(legacySpec).acceptance_criteria[0]?.browser).toBe(false);
  expect(HoldoutSchema.parse(legacyHoldout).scenarios[0]?.browser).toBe(false);
  expect(SpecSchema.parse(JSON.parse(JSON.stringify(spec))).acceptance_criteria[0]?.browser).toBe(true);
  expect(HoldoutSchema.parse(JSON.parse(JSON.stringify(holdout))).scenarios[0]?.browser).toBe(true);
  for (const [schema, field] of [
    [SpecSchema, "acceptance_criteria"],
    [HoldoutSchema, "scenarios"],
  ] as const)
    expect(toStrictJsonSchema(schema)).toMatchObject({
      properties: { [field]: { items: { required: expect.arrayContaining(["browser"]) } } },
    });
});

test("authors mark preview checks and the verifier receives the URL, IDs and both viewports", () => {
  expect(specPrompt({ prompt: "UI", answers: [] })).toContain(
    "Set browser true only for checks that need viewing or interacting with the UI preview, and false otherwise",
  );
  expect(specPrompt({ prompt: "UI", answers: [] })).toContain("a browser outside the UI preview");
  expect(holdoutPrompt({ prompt: "UI", spec })).toContain(
    "Set browser true only for checks that need viewing or interacting with the UI preview, and false otherwise",
  );
  const input = { prompt: "UI", spec, holdout, baseSha: "abc" };
  const prompt = verifyPrompt({ ...input, previewUrl: "http://127.0.0.1:43210" });
  for (const text of [
    "# Browser",
    "http://127.0.0.1:43210",
    "available browser tools",
    "marked browser check (AC-1, H-1)",
    "resize the viewport",
    "record observations at both 1280 × 800 and 375 × 812 CSS pixels",
    "actions taken and the results observed at both sizes",
    "own inspection but are not retained",
    "A screenshot alone does not establish interactive correctness",
    'blockedReason "environment"',
  ])
    expect(prompt).toContain(text);
  const without = verifyPrompt(input);
  expect(without).not.toContain("# Browser");
  expect(without).not.toContain("1280");
  expect(verifyPrompt({ ...input, previewUrl: undefined })).toBe(without);
});

test("available browser blocks become actionable failures before covering tests and gate substitution", () => {
  const secret = "browser-test-credential-5871";
  registerCredential("browser-verification-test", secret);
  const raw = {
    ...blocked,
    criteria: blocked.criteria.map((c) => ({
      ...c,
      evidence: `\u001b[31mOriginal ${secret}\u001b[0m`,
      gateEvidence: { stageId: 7, sha: "a".repeat(40), check: "test", command: "bun test" },
    })),
  };
  const converted = applyBrowserContext(raw, spec, holdout, "available");
  for (const row of converted.criteria) {
    expect(row).toMatchObject({ status: "unclear", blockedReason: null, covering_tests: [] });
    expect(row).not.toHaveProperty("gateEvidence");
    expect(row.evidence).toStartWith(BROWSER_INCOMPLETE);
    expect(row.evidence).toContain("Original [redacted]");
    expect(row.evidence).not.toContain(secret);
    expect(row.evidence).not.toContain("\u001b");
  }
  expect(converted.criteria[1]?.publicSummary).toBe(BROWSER_INCOMPLETE);
  expect(raw.criteria[0]?.status).toBe("blocked");
  expect(selectCoveringTests(converted).flatMap((c) => c.tests)).toEqual([]);
  const gates: GateEvidence = {
    stageId: 7,
    sha: "a".repeat(40),
    checks: [
      {
        name: "test",
        verdict: "pass",
        blocking: false,
        testCommand: "bun test",
        result: {
          name: "test",
          command: "bun test",
          ok: true,
          exitCode: 0,
          durationMs: 0,
          output: "test/ui.test.ts:\n(pass) UI works\n1 pass\n0 fail",
        },
      },
    ],
  };
  expect(
    applyGateEvidence(
      { ...blocked, criteria: blocked.criteria.map((c) => ({ ...c, covering_tests: [] })) },
      spec,
      holdout,
      gates.sha,
      gates,
    ).criteria[0]?.status,
  ).toBe("met");
  const resolved = normalizeVerify(
    applyGateEvidence(converted, spec, holdout, gates.sha, gates),
    spec,
    holdout,
  );
  expect(resolved.overall).toBe("fail");
  expect(resolved.criteria.map((c) => c.status)).toEqual(["unclear", "unclear"]);
  expect(blockedOnly(resolved)).toBe(false);
});

test.each([undefined, "no_preview", "unavailable"] as const)(
  "browser context %s keeps legacy blocks",
  (context) => {
    expect(applyBrowserContext(blocked, spec, holdout, context)).toBe(blocked);
  },
);

test("verifier cannot mark checks; legacy markers, unknown IDs and completed rows stay unchanged", () => {
  const output = VerifySchema.parse({
    ...blocked,
    criteria: [
      { ...blocked.criteria[0], browser: true },
      { ...blocked.criteria[1], browser: true },
      { ...blocked.criteria[0], id: "unknown", browser: true },
    ],
  });
  expect(output.criteria[0]).not.toHaveProperty("browser");
  const mixed = applyBrowserContext(output, spec, legacyHoldout, "available");
  expect(mixed.criteria.map((c) => c.status)).toEqual(["unclear", "blocked", "blocked"]);
  expect(spec.acceptance_criteria[0]?.browser).toBe(true);
  expect(applyBrowserContext(output, legacySpec, legacyHoldout, "available").criteria).toEqual(
    output.criteria,
  );
  const completed = { ...blocked, criteria: blocked.criteria.map((c) => ({ ...c, status: "met" as const })) };
  expect(applyBrowserContext(completed, spec, holdout, "available").criteria).toEqual(completed.criteria);
  expect(legacySpec.acceptance_criteria[0]).not.toHaveProperty("browser");
});
