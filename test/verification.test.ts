import { expect, test } from "bun:test";
import { formatVerifyFeedback } from "../src/pipeline/prompts.ts";
import { type Holdout, type Spec, VerifySchema } from "../src/pipeline/schemas.ts";
import { blockedOnly, normalizeVerify } from "../src/pipeline/verification.ts";

const spec: Spec = {
  summary: "test",
  requirements: [],
  assumptions: [],
  out_of_scope: [],
  blocking_questions: [],
  acceptance_criteria: [{ id: "AC-1", criterion: "works", how_to_verify: "bun test" }],
};
const holdout: Holdout = {
  scenarios: [{ id: "H-1", description: "private", steps: "secret input", expected: "ok", edge_case: true }],
};

test("the verifier's statuses are authoritative, whatever the evidence mentions", () => {
  for (const status of ["met", "unmet", "unclear", "blocked"] as const) {
    const result = normalizeVerify(
      {
        criteria: [
          { id: "AC-1", status, evidence: "bun test: EPERM: operation not permitted, mkdtemp" },
          { id: "H-1", status: "met", evidence: "ok" },
        ],
        overall: "pass",
        notes: "",
      },
      spec,
      holdout,
    );
    expect(result.criteria[0]?.status).toBe(status);
    expect(result.overall).toBe(status === "met" ? "pass" : "fail");
  }
});

test("unreported criteria become unclear and fail the verdict", () => {
  const result = normalizeVerify(
    { criteria: [{ id: "AC-1", status: "met", evidence: "ok" }], overall: "pass", notes: "" },
    spec,
    holdout,
  );
  expect(result.criteria.find((c) => c.id === "H-1")?.status).toBe("unclear");
  expect(result.overall).toBe("fail");
});

test("blockedOnly: only met and blocked, with at least one blocked", () => {
  const verify = (...statuses: ("met" | "unmet" | "unclear" | "blocked")[]) => ({
    criteria: statuses.map((status, i) => ({ id: `C-${i}`, status, evidence: "e" })),
    overall: "fail" as const,
    notes: "",
  });
  expect(blockedOnly(verify("met", "blocked"))).toBe(true);
  expect(blockedOnly(verify("blocked"))).toBe(true);
  expect(blockedOnly(verify("met", "met"))).toBe(false);
  expect(blockedOnly(verify("blocked", "unmet"))).toBe(false);
  expect(blockedOnly(verify("blocked", "unclear"))).toBe(false);
});

test("explicit blocked needs evidence; complete unique met coverage alone can pass", () => {
  expect(
    VerifySchema.safeParse({
      criteria: [{ id: "AC-1", status: "blocked", evidence: " " }],
      overall: "fail",
      notes: "",
    }).success,
  ).toBe(false);
  const verified = VerifySchema.parse({
    criteria: [
      { id: "AC-1", status: "blocked", evidence: "bun test could not create fixture: EPERM" },
      { id: "H-1", status: "met", evidence: "ok" },
    ],
    overall: "pass",
    notes: "",
  });
  expect(blockedOnly(normalizeVerify(verified, spec, holdout))).toBe(true);
  expect(formatVerifyFeedback(verified, spec, holdout)).toBe("");
  verified.criteria[0] = { id: "AC-1", status: "met", evidence: "ok" };
  expect(normalizeVerify(verified, spec, holdout).overall).toBe("pass");
  verified.criteria.push(verified.criteria[0]);
  expect(normalizeVerify(verified, spec, holdout).overall).toBe("fail");
});

test("actionable feedback excludes blocked checks and redacts holdout inputs", () => {
  const feedback = formatVerifyFeedback(
    {
      criteria: [
        { id: "AC-1", status: "blocked", evidence: "bun test failed: EPERM" },
        { id: "H-1", status: "unmet", evidence: "secret input returned wrong result" },
      ],
      overall: "fail",
      notes: "",
    },
    spec,
    holdout,
  );
  expect(feedback).not.toContain("AC-1");
  expect(feedback).not.toContain("EPERM");
  expect(feedback).not.toContain("secret input");
  expect(feedback).toContain("H-1");
});
