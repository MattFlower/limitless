import { expect, test } from "bun:test";
import {
  formatVerifyFeedback,
  holdoutPrompt,
  redactHoldoutText,
  verifyPrompt,
} from "../src/pipeline/prompts.ts";
import {
  citedRequirement,
  type Holdout,
  requirementSource,
  type Spec,
  toStrictJsonSchema,
  type Verify,
  VerifySchema,
} from "../src/pipeline/schemas.ts";
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

test("holdout prompt reads the base repository and grounds outcomes in the request", () => {
  const prompt = holdoutPrompt({ prompt: "Add a --json flag", spec });
  expect(prompt).toContain("read-only checkout of the repository at the base commit");
  expect(prompt).toContain("real commands, real config keys, real entry points");
  expect(prompt).toContain("must follow from the request or specification");
  expect(prompt).toContain("Don't dictate exact wording");
  expect(prompt).toContain("1–8 scenarios");
  expect(prompt).toContain("relative paths; never use this checkout's absolute path");
  expect(prompt).toContain("Keep scenario text out of files");
  expect(prompt).toContain("Add a --json flag");
  expect(prompt).toContain("AC-1");
  expect(prompt).not.toContain("Do not inspect a repository");
  expect(prompt).not.toContain("at least two");
  expect(prompt).not.toContain("not literally listed");
});

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
  const verified: Verify = VerifySchema.parse({
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

test("verifier cites the factory's gate results instead of rerunning whole suites", () => {
  const result = (name: string, ok: boolean) => ({
    name,
    command: `bun run ${name}`,
    ok,
    exitCode: ok ? 0 : 1,
    durationMs: 1,
    output: "",
  });
  const prompt = verifyPrompt({
    prompt: "make it work",
    spec,
    holdout,
    baseSha: "abc",
    checks: [
      { name: "lint", verdict: "pass", blocking: false, result: result("lint", true) },
      { name: "test", verdict: "still_failing", blocking: false, result: result("test", false) },
    ],
  });
  expect(prompt).toContain("- lint `bun run lint`: pass");
  expect(prompt).toContain("- test `bun run test`: FAIL (still failing)");
  expect(prompt).toContain("Do not rerun these full commands as evidence");
  // Without gate results (evals), the prompt is unchanged so cached eval results stay valid.
  expect(verifyPrompt({ prompt: "make it work", spec, holdout, baseSha: "abc" })).not.toContain(
    "Repository checks",
  );
});

const unmetHoldout = (extra: Partial<Verify["criteria"][number]>): Verify => ({
  criteria: [
    { id: "AC-1", status: "met", evidence: "ok", publicSummary: "" },
    {
      id: "H-1",
      status: "unmet",
      evidence: "secret input failed",
      publicSummary: "rejects an empty list",
      ...extra,
    },
  ],
  overall: "fail",
  notes: "",
});

test("verifier classifies unmet holdouts against the request and spec, citing public text", () => {
  const prompt = verifyPrompt({
    prompt: "make it work",
    spec: { ...spec, requirements: ["empty lists are accepted"] },
    holdout,
    baseSha: "abc",
  });
  expect(prompt).toContain("# Specification requirements\n- empty lists are accepted");
  expect(prompt).toContain("For every unmet H-id, set requirement:");
  for (const value of ["- request:", "- spec:", "- not_required:"]) expect(prompt).toContain(value);
  expect(prompt).toContain("set requirementCitation to the violated text quoted exactly");
  expect(prompt).toContain("cite that text in evidence");
  const item = (toStrictJsonSchema(VerifySchema) as { properties: { criteria: { items: unknown } } })
    .properties.criteria.items as { required: string[]; properties: Record<string, Record<string, unknown>> };
  expect(item.required).toEqual(expect.arrayContaining(["requirement", "requirementCitation"]));
  expect(JSON.stringify(item.properties.requirement)).toContain("not_required");
  expect(item.properties.requirement).not.toHaveProperty("default");
  expect(VerifySchema.safeParse(unmetHoldout({ requirement: "not_required" })).success).toBe(true);
  expect(VerifySchema.safeParse(unmetHoldout({})).success).toBe(true);
});

test("a malformed live classification is not a schema failure: it still yields a blocking verdict", () => {
  // A missing, fabricated or paraphrased citation is never grounds to discard the verifier's output;
  // the classification keeps blocking and only the ungrounded citation is withheld from feedback.
  for (const [requirement, requirementCitation] of [
    ["spec", ""],
    ["request", ' "" '],
    ["spec", "fabricated requirement"],
    ["spec", "empty lists accepted"],
    ["request", "empty lists are accepted"],
  ] as const) {
    const parsed = VerifySchema.safeParse(unmetHoldout({ requirement, requirementCitation }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) continue;
    expect(normalizeVerify(parsed.data, spec, holdout).overall).toBe("fail");
    expect(blockedOnly(normalizeVerify(parsed.data, spec, holdout))).toBe(false);
  }
});

test("a citation is grounded only when it is a verbatim quote of the named source", () => {
  const source = requirementSource("spec", "make it work", {
    ...spec,
    requirements: ["empty lists are accepted"],
  });
  expect(citedRequirement('"Empty lists are  accepted."', source)).toBe("Empty lists are accepted");
  expect(citedRequirement("make it work", requirementSource("request", "make it work", spec))).toBe(
    "make it work",
  );
  for (const [citation, text] of [
    ["fabricated requirement", source],
    ["empty lists accepted", source],
    ["empty lists are accepted", "make it work"],
    ["", source],
  ] as const)
    expect(citedRequirement(citation, text)).toBeNull();
});

test("only unmet holdouts classified request or spec block the verdict", () => {
  expect(normalizeVerify(unmetHoldout({ requirement: "not_required" }), spec, holdout).overall).toBe("pass");
  for (const requirement of ["request", "spec"] as const)
    expect(normalizeVerify(unmetHoldout({ requirement }), spec, holdout).overall).toBe("fail");
  // Output recorded before classification existed parses as unclassified and keeps blocking.
  const legacy = VerifySchema.parse(unmetHoldout({}));
  expect(legacy.criteria[1]?.requirement).toBeNull();
  expect(normalizeVerify(legacy, spec, holdout).overall).toBe("fail");
  expect(normalizeVerify(unmetHoldout({}), spec, holdout).overall).toBe("fail");
  // The exemption never applies to acceptance criteria, unclear holdouts, or duplicate rows.
  const acUnmet = unmetHoldout({ requirement: "not_required" });
  acUnmet.criteria[0] = {
    id: "AC-1",
    status: "unmet",
    evidence: "x",
    publicSummary: "",
    requirement: "not_required",
  };
  expect(normalizeVerify(acUnmet, spec, holdout).overall).toBe("fail");
  expect(normalizeVerify(acUnmet, spec, holdout).criteria[0]?.requirement).toBeNull();
  expect(
    normalizeVerify(unmetHoldout({ status: "unclear", requirement: "not_required" }), spec, holdout).overall,
  ).toBe("fail");
  const duplicate = unmetHoldout({ requirement: "not_required" });
  duplicate.criteria.push({ id: "AC-1", status: "met", evidence: "ok", publicSummary: "" });
  expect(normalizeVerify(duplicate, spec, holdout).overall).toBe("fail");
  const missing = unmetHoldout({ requirement: "not_required" });
  missing.criteria.shift();
  expect(normalizeVerify(missing, spec, holdout).overall).toBe("fail");
});

test("an environment block still stops or retries alongside a not_required holdout", () => {
  const verify = unmetHoldout({ requirement: "not_required" });
  verify.criteria[0] = { id: "AC-1", status: "blocked", evidence: "EPERM mkdir", publicSummary: "" };
  const normalized = normalizeVerify(verify, spec, holdout);
  expect(normalized.overall).toBe("fail");
  expect(blockedOnly(normalized)).toBe(true);
  expect(blockedOnly(normalizeVerify(unmetHoldout({ requirement: "spec" }), spec, holdout))).toBe(false);
});

test("feedback names the violated public requirement and omits not_required holdouts", () => {
  const publicSources = "make it work\n## Requirements\n- empty lists are accepted\nparseList";
  const withRequirement = { ...spec, requirements: ["empty lists are accepted"] };
  const feedback = (extra: Partial<Verify["criteria"][number]>) =>
    formatVerifyFeedback(unmetHoldout(extra), withRequirement, holdout, publicSources, "make it work");
  const blocking = feedback({ requirement: "spec", requirementCitation: '"Empty lists are accepted."' });
  expect(blocking).toContain(
    '**H-1** violates this requirement of the specification: "Empty lists are accepted"',
  );
  expect(blocking).toContain("Observed failure: rejects an empty list");
  expect(blocking).not.toContain("secret input");
  expect(blocking).not.toContain("private detail");
  expect(feedback({ requirement: "request", requirementCitation: "make it work" })).toContain(
    'violates this requirement of the original request: "make it work"',
  );
  // A citation must come from the source it names; a paraphrase could carry the scenario.
  for (const [requirement, requirementCitation] of [
    ["request", "handle secret input"],
    ["request", "empty lists are accepted"],
    ["spec", "parseList"],
  ] as const) {
    const withheld = feedback({ requirement, requirementCitation });
    expect(withheld).toContain("(the verifier's citation was not found in it)");
    expect(withheld).not.toContain("secret input");
  }
  expect(feedback({ requirement: "not_required" })).toBe("");
});
