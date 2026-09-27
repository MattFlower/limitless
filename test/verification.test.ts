import { expect, test } from "bun:test";
import { formatVerifyFeedback, redactHoldoutText, verifyPrompt } from "../src/pipeline/prompts.ts";
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
          {
            id: "AC-1",
            status,
            evidence: "bun test: EPERM: operation not permitted, mkdtemp",
            publicSummary: "",
          },
          { id: "H-1", status: "met", evidence: "ok", publicSummary: "" },
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
    {
      criteria: [{ id: "AC-1", status: "met", evidence: "ok", publicSummary: "" }],
      overall: "pass",
      notes: "",
    },
    spec,
    holdout,
  );
  expect(result.criteria.find((c) => c.id === "H-1")?.status).toBe("unclear");
  expect(result.overall).toBe("fail");
});

test("blockedOnly: only met and blocked, with at least one blocked", () => {
  const verify = (...statuses: ("met" | "unmet" | "unclear" | "blocked")[]) => ({
    criteria: statuses.map((status, i) => ({ id: `C-${i}`, status, evidence: "e", publicSummary: "" })),
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
      criteria: [{ id: "H-1", status: "unmet", evidence: "checked" }],
      overall: "fail",
      notes: "",
    }).success,
  ).toBe(false);
  expect(
    VerifySchema.safeParse({
      criteria: [{ id: "AC-1", status: "blocked", evidence: " ", publicSummary: "" }],
      overall: "fail",
      notes: "",
    }).success,
  ).toBe(false);
  const verified = VerifySchema.parse({
    criteria: [
      {
        id: "AC-1",
        status: "blocked",
        evidence: "bun test could not create fixture: EPERM",
        publicSummary: "",
      },
      { id: "H-1", status: "met", evidence: "ok", publicSummary: "" },
    ],
    overall: "pass",
    notes: "",
  });
  expect(blockedOnly(normalizeVerify(verified, spec, holdout))).toBe(true);
  expect(formatVerifyFeedback(verified, spec, holdout)).toBe("");
  verified.criteria[0] = { id: "AC-1", status: "met", evidence: "ok", publicSummary: "" };
  expect(normalizeVerify(verified, spec, holdout).overall).toBe("pass");
  verified.criteria.push(verified.criteria[0]);
  expect(normalizeVerify(verified, spec, holdout).overall).toBe("fail");
});

test("verifier asks for a public behavior summary and accepts an empty one", () => {
  const prompt = verifyPrompt({ prompt: "make it work", spec, holdout, baseSha: "abc" });
  expect(prompt).toContain("publicSummary");
  expect(prompt).toContain("without private inputs, expected values, or scenario text");
  expect(
    VerifySchema.safeParse({
      criteria: [{ id: "H-1", status: "unmet", evidence: "checked", publicSummary: "" }],
      overall: "fail",
      notes: "",
    }).success,
  ).toBe(true);
});

test("private feedback uses only sanitized summaries while public evidence stays actionable", () => {
  const feedback = formatVerifyFeedback(
    {
      criteria: [
        { id: "AC-1", status: "unmet", evidence: "assertion failed at code.ts:12", publicSummary: "" },
        {
          id: "H-1",
          status: "unmet",
          evidence: "secret input returned wrong result",
          publicSummary: "rejects valid input when the list is empty",
        },
      ],
      overall: "fail",
      notes: "",
    },
    spec,
    holdout,
  );
  expect(feedback).toContain("works");
  expect(feedback).toContain("assertion failed at code.ts:12");
  expect(feedback).toContain("H-1** private scenario (unmet): rejects valid input when the list is empty");
  expect(feedback).not.toContain("secret input");
  expect(feedback).not.toContain("returned wrong result");
  const unclear = formatVerifyFeedback(
    {
      criteria: [{ id: "H-1", status: "unclear", evidence: "secret input", publicSummary: "" }],
      overall: "fail",
      notes: "",
    },
    spec,
    holdout,
  );
  expect(unclear).toContain(
    "private scenario (unclear): The verifier could not confirm this private scenario.",
  );
  expect(unclear).not.toContain("secret input");
});

test("backstop removes private sentences and literals at word boundaries", () => {
  const scenarios: Holdout = {
    scenarios: [
      {
        id: "H-1",
        description: "When the list is empty, return 731.",
        steps: "run 'violet-key' at /tmp/secret-case --hidden-mode with secretArg_731 and sharedIdentifier",
        expected: "value 731",
        edge_case: true,
      },
    ],
  };
  const publicSources =
    "request: list buildPrivateInputArgs; spec: run --public-mode; repository identifier: sharedIdentifier";
  const input =
    "When the list is empty, return 731. Common list and buildPrivateInputArgs remain; 'violet-key' /tmp/secret-case --hidden-mode SECRETARG_731 731 sharedIdentifier.";
  const redacted = redactHoldoutText(input, scenarios, publicSources);
  expect(redacted).not.toContain("return 731");
  for (const secret of ["violet-key", "/tmp/secret-case", "--hidden-mode", "SECRETARG_731", "731"])
    expect(redacted).not.toContain(secret);
  expect(redacted).toContain("Common list and buildPrivateInputArgs remain");
  expect(redacted).toContain("sharedIdentifier");
  expect(redacted).toMatch(/\d+ private details withheld/);
  const midword = redactHoldoutText("buildPrivateInputArgs PrivateInput", {
    scenarios: [
      { id: "H-1", description: "private", steps: "run PrivateInput", expected: "ok", edge_case: true },
    ],
  });
  expect(midword).toContain("buildPrivateInputArgs");
  expect(midword).not.toContain("build[private detail]Args");
  expect(midword).not.toContain(" PrivateInput");
  expect(redactHoldoutText("--public-mode and buildPrivateInputArgs", scenarios, publicSources)).toBe(
    "--public-mode and buildPrivateInputArgs",
  );
});

test("actionable feedback excludes blocked checks and redacts holdout inputs", () => {
  const feedback = formatVerifyFeedback(
    {
      criteria: [
        { id: "AC-1", status: "blocked", evidence: "bun test failed: EPERM", publicSummary: "" },
        { id: "H-1", status: "unmet", evidence: "secret input returned wrong result", publicSummary: "" },
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
