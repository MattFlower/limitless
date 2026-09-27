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
  const midword = redactHoldoutText(
    "buildPrivateInputArgs PrivateInput",
    {
      scenarios: [
        { id: "H-1", description: "private", steps: "run PrivateInput", expected: "ok", edge_case: true },
      ],
    },
    "repository identifier: buildPrivateInputArgs",
  );
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

test("backstop detects observed literals absent from the authored scenario", () => {
  const input =
    'The scenario posts to /api/v2/widgets with flag --force and payload id 48231, expecting a validation error for "negative-quantity" input; runtime returned ERR_RETRY_EXHAUSTED from retryPrivateCall.';
  expect(redactHoldoutText(input, holdout)).toBe(
    'The scenario posts to [private detail] with flag [private detail] and payload id [private detail], expecting a validation error for "[private detail]" input; runtime returned [private detail] from [private detail]. [6 private details withheld]',
  );
  expect(redactHoldoutText(input, holdout, input)).toBe(input);
  expect(redactHoldoutText(input, { scenarios: [] })).toBe(input);
});

test("observed literal exemptions are case insensitive and respect identifier boundaries", () => {
  const publicSources =
    "request: /api/v2/widgets --force 48231 'negative-quantity'; specification: retryPublicCall; repository: buildPrivateInputArgs ERR_PUBLIC";
  const input =
    "Common words remain: /API/v2/WIDGETS --FORCE 48231 'NEGATIVE-QUANTITY' RETRYPUBLICCALL buildPrivateInputArgs err_public; PrivateInput ERR_PRIVATE 93827.";
  expect(redactHoldoutText(input, holdout, publicSources)).toBe(
    "Common words remain: /API/v2/WIDGETS --FORCE 48231 'NEGATIVE-QUANTITY' RETRYPUBLICCALL buildPrivateInputArgs err_public; [private detail] [private detail] [private detail]. [3 private details withheld]",
  );
});

test("private summaries redact runtime error identifiers on unmet and unclear retries", () => {
  for (const status of ["unmet", "unclear"] as const) {
    const feedback = formatVerifyFeedback(
      {
        criteria: [
          {
            id: "H-1",
            status,
            evidence: "secret evidence is never shown",
            publicSummary:
              "request fails with ERR_RETRY_EXHAUSTED after 3 attempts; ERR_RETRY_EXHAUSTED recurs on the following call",
          },
        ],
        overall: "fail",
        notes: "",
      },
      spec,
      holdout,
    );
    expect(feedback).toContain(`private scenario (${status}): request fails with [private detail]`);
    expect(feedback).toContain("recurs on the following call");
    expect(feedback).toContain("3 private details withheld");
    expect(feedback).not.toContain("ERR_RETRY_EXHAUSTED");
    expect(feedback).not.toContain("secret evidence");
  }
});

test("overlapping private details are replaced once without rewriting placeholders", () => {
  const scenarios: Holdout = {
    scenarios: [
      {
        id: "H-1",
        description: "Private detail is missing.",
        steps: "use 'private detail' with ERR_PRIVATE",
        expected: "ok",
        edge_case: true,
      },
    ],
  };
  expect(redactHoldoutText("Private detail is missing. ERR_PRIVATE ERR_PRIVATE", scenarios)).toBe(
    "[private detail] [private detail] [private detail] [3 private details withheld]",
  );
});

test("fully withheld summaries retain the removal count alongside the fallback", () => {
  const feedback = formatVerifyFeedback(
    {
      criteria: [{ id: "H-1", status: "unmet", evidence: "private evidence", publicSummary: "secret input" }],
      overall: "fail",
      notes: "",
    },
    spec,
    holdout,
  );
  expect(feedback).toContain(
    "The verifier could not confirm this private scenario. [1 private details withheld]",
  );
  expect(feedback).not.toContain("secret input");
});

test("private literals do not match inside longer words or dollar-prefixed identifiers", () => {
  const scenarios: Holdout = {
    scenarios: [{ id: "H-1", description: "private", steps: "use 'input'", expected: "ok", edge_case: true }],
  };
  expect(redactHoldoutText("inputs reinput $input input", scenarios)).toBe(
    "inputs reinput $input [private detail] [1 private details withheld]",
  );
});
