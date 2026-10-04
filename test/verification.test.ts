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
  requirementCitationIssue,
  requirementEntries,
  requirementSource,
  type Spec,
  SpecSchema,
  toStrictJsonSchema,
  type Verify,
  VerifySchema,
} from "../src/pipeline/schemas.ts";
import { blockedOnly, normalizeVerify, preDeliveryVerifyArtifact } from "../src/pipeline/verification.ts";

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
    assumptions: ["The caller has administrator access"],
    out_of_scope: ["Delete the old parser"],
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
    ["Delete the old parser", source],
    ["The caller has administrator access", source],
    [spec.summary, source],
    [spec.acceptance_criteria[0]?.how_to_verify ?? "", source],
  ] as const)
    expect(citedRequirement(citation, text)).toBeNull();
  // A fragment grounds nothing: single words, and text cut from inside words, are rejected.
  for (const citation of ["lists", "e", "the", "mpty lists are accep", "lists are accepte"])
    expect(citedRequirement(citation, source)).toBeNull();
  expect(citedRequirement("make it", requirementSource("request", "make it work", spec))).toBeNull();
  expect(citedRequirement("ake it wor", "make it work")).toBeNull();
  // Underscores join identifiers: a quote cut from inside `user_id` is not a whole-word citation.
  expect(citedRequirement("Return the user", "Return the user_id")).toBeNull();
  expect(citedRequirement("id is required", "the user_id is required")).toBeNull();
  expect(citedRequirement("Return the user_id", "Return the user_id")).toBe("Return the user_id");
  expect(citedRequirement('  **Lists  ARE** accepted" ', source)).toBe("Lists ARE** accepted");
});

test("a complete short spec entry is grounded; a short partial quote is not", () => {
  const shortSpec = {
    ...spec,
    requirements: ["Idempotent retries"],
    acceptance_criteria: [{ id: "AC-1", criterion: "Paginated.", how_to_verify: "run it" }],
  };
  const source = requirementSource("spec", "", shortSpec);
  const entries = requirementEntries("spec", shortSpec);
  expect(citedRequirement("idempotent retries", source, entries)).toBe("idempotent retries");
  expect(citedRequirement('"paginated"', source, entries)).toBe("paginated");
  expect(citedRequirement("Idempotent", source, entries)).toBeNull();
  expect(
    citedRequirement("idempotent", "Idempotent retries", requirementEntries("request", shortSpec)),
  ).toBeNull();
  const issue = (requirementCitation: string, evidence: string) =>
    requirementCitationIssue(
      { id: "H-1", status: "unmet", evidence, publicSummary: "", requirement: "spec", requirementCitation },
      "",
      shortSpec,
    );
  expect(issue("Idempotent retries", "violates idempotent retries: second call fails")).toBeNull();
  expect(issue("Paginated", "violates **Paginated**")).toBeNull();
  expect(issue("Paginated", "the list is unpaginated")).toBe("evidence does not cite the requirement");
  expect(issue("Idempotent retries", "idempotent retriesx")).toBe("evidence does not cite the requirement");
  expect(issue("retries", "violates retries")).toBe("citation is not a stated public requirement");
  expect(issue("Paginated", "see paginated_results")).toBe("evidence does not cite the requirement");
  const requestIssue = requirementCitationIssue(
    {
      id: "H-1",
      status: "unmet",
      evidence: "Violation: Return the user_ref",
      publicSummary: "",
      requirement: "request",
      requirementCitation: "Return the user",
    },
    "Return the user list",
    shortSpec,
  );
  expect(requestIssue).toBe("evidence does not cite the requirement");
});

test("a trivial citation blocks and is never repeated to the implementer", () => {
  for (const requirementCitation of ["e", "the", "work"]) {
    const verify = unmetHoldout({
      requirement: "request",
      requirementCitation,
      evidence: `violates ${requirementCitation}`,
    });
    const normalized = normalizeVerify(VerifySchema.parse(verify), spec, holdout, "make the thing work");
    expect(normalized.overall).toBe("fail");
    expect(normalized.notes).toContain("citation is not a stated public requirement");
    const feedback = formatVerifyFeedback(
      normalized,
      spec,
      holdout,
      "make the thing work",
      "make the thing work",
    );
    // "e" is not a whole word of the request; "the" and "work" are, but too short to ground anything.
    expect(feedback).toContain(
      requirementCitation === "e"
        ? "(the verifier's citation was not found in it)"
        : "(the verifier's attribution could not be validated)",
    );
    expect(feedback).toContain("check them against the original request and specification above");
    expect(feedback).not.toContain(`requirement of the original request: "${requirementCitation}"`);
  }
});

test("the verifier is told what makes a citation grounded", () => {
  const prompt = verifyPrompt({ prompt: "make it work", spec, holdout, baseSha: "abc" });
  expect(prompt).toContain(
    "A citation must be either at least three consecutive words quoted exactly, or one whole line of the request (a sentence or bullet) or one whole acceptance criterion, exactly as shown",
  );
});

test("a whole request line or acceptance criterion is grounded however short; a short fragment is not", () => {
  const request =
    "Networking changes:\nBackground\nOur service uses IPv4.\n\nRequirements\n- Support IPv6\n* Keep IPv4\n> Log it\n1. Retry once\n- Support IPv6 and DNS over TLS\n## Limits\nCap it.\n## Scope.\nOther notes\n\n- Later:\nShip it";
  const shortSpec = {
    ...spec,
    acceptance_criteria: [{ id: "AC-1", criterion: "Paginated.", how_to_verify: "run" }],
  };
  const source = requirementSource("spec", "", shortSpec);
  const entries = requirementEntries("spec", shortSpec);
  for (const [citation, line] of [
    ["Support IPv6", "Support IPv6"],
    ["- Support IPv6", "Support IPv6"],
    ['"keep ipv4"', "keep ipv4"],
    ["Log it", "Log it"],
    ["1. Retry once", "Retry once"],
    ["Cap it.", "Cap it"],
    // A standalone sentence (set apart by a blank line or the end) needs no marker or punctuation.
    ["Other notes", "Other notes"],
    ["Ship it", "Ship it"],
  ] as const)
    expect(citedRequirement(citation, request)).toBe(line);
  expect(citedRequirement("Support IPv6", "Support IPv6")).toBe("Support IPv6");
  expect(citedRequirement("Retry", "Retry")).toBe("Retry");
  expect(citedRequirement("Support IPv6", "Support IPv6 and IPv4")).toBeNull();
  expect(citedRequirement("Keep IPv4", "Support IPv6\nKeep IPv4")).toBe("Keep IPv4");
  // Headings label requirements rather than stating one: marked, punctuated, or a plain line
  // directly above its block ("Background" above prose, "Requirements" above a list).
  for (const citation of [
    "IPv6",
    "Retry",
    "Support",
    "DNS over",
    "Networking",
    "Networking changes:",
    "Networking changes",
    "Background",
    "Requirements",
    "Limits",
    "## Limits",
    "Scope",
    "## Scope.",
    "Later",
  ])
    expect(citedRequirement(citation, request)).toBeNull();
  expect(citedRequirement("## Scope.", "## Scope.\n- Support IPv6")).toBeNull();
  const plain = "Background\nOur service uses IPv4.\n\nRequirements\n- Support IPv6";
  for (const citation of ["Background", "Requirements"]) expect(citedRequirement(citation, plain)).toBeNull();
  expect(citedRequirement("Support IPv6", plain)).toBe("Support IPv6");
  // Labels set apart by blank lines are still headings.
  const spaced = "Background\n\nOur service uses IPv4.\n\nRequirements\n\n- Support IPv6";
  for (const citation of ["Background", "Requirements"])
    expect(citedRequirement(citation, spaced)).toBeNull();
  for (const citation of ["**AC-1** Paginated.", "AC-1: Paginated", "- **AC-1** Paginated."])
    expect(citedRequirement(citation, source, entries)).toBe("Paginated");
  const verify = unmetHoldout({
    requirement: "request",
    requirementCitation: "Support IPv6",
    evidence: "violates Support IPv6: connecting to ::1 fails",
  });
  const normalized = normalizeVerify(VerifySchema.parse(verify), spec, holdout, request);
  expect(normalized.notes).not.toContain("citation");
  expect(formatVerifyFeedback(normalized, spec, holdout, request, request)).toContain(
    'violates this requirement of the original request: "Support IPv6"',
  );
});

test.each(["request", "spec"] as const)(
  "%s evidence citations are validated after parsing",
  (requirement) => {
    const requirementCitation = "Must return 1";
    const publicSpec = { ...spec, requirements: [requirementCitation] };
    for (const cites of [false, true]) {
      const parsed = VerifySchema.parse(
        unmetHoldout({
          requirement,
          requirementCitation,
          evidence: `Observed failure: command returns 0${cites ? `; violates ${requirementCitation}` : ""}`,
        }),
      );
      const normalized = normalizeVerify(parsed, publicSpec, holdout, requirementCitation);
      expect(normalized.overall).toBe("fail");
      expect(normalized.notes.includes("evidence does not cite the requirement")).toBe(!cites);
      expect(normalizeVerify(normalized, publicSpec, holdout, requirementCitation).notes).toBe(
        normalized.notes,
      );
      const feedback = formatVerifyFeedback(
        normalized,
        publicSpec,
        holdout,
        requirementCitation,
        requirementCitation,
      );
      expect(feedback).toContain('"Must return 1"');
      expect(feedback).toContain("Observed failure: rejects an empty list");
      expect(feedback).not.toContain("command returns 0");
    }
  },
);

test("out-of-scope citations remain blocking but are never attributed as spec requirements", () => {
  const publicSpec = { ...spec, out_of_scope: ["Delete the old parser"] };
  const result = normalizeVerify(
    VerifySchema.parse(
      unmetHoldout({
        requirement: "spec",
        requirementCitation: "Delete the old parser",
        evidence: "Delete the old parser: parser still exists",
      }),
    ),
    publicSpec,
    holdout,
  );
  expect(result.overall).toBe("fail");
  expect(result.notes).toContain("citation is not a stated public requirement");
  const feedback = formatVerifyFeedback(result, publicSpec, holdout);
  expect(feedback).not.toContain("Delete the old parser");
  expect(feedback).toContain("check them against the original request and specification above");
});

test("feedback for several ungrounded holdouts states the fallback once and omits the request", () => {
  const request = "REQUEST_BODY_MARKER make it work";
  const verify: Verify = {
    criteria: ["H-1", "H-2", "H-3", "H-4"].map((id) => ({
      id,
      status: "unmet" as const,
      evidence: "secret input failed",
      publicSummary: "rejects an empty list",
      requirement: "request" as const,
      requirementCitation: "fabricated requirement",
    })),
    overall: "fail",
    notes: "",
  };
  const knownHoldouts = {
    scenarios: verify.criteria.map((c) => ({
      ...holdout.scenarios[0],
      id: c.id,
      description: "private",
      steps: "secret input",
      expected: "ok",
      edge_case: true,
    })),
  };
  const feedback = formatVerifyFeedback(verify, spec, knownHoldouts, request, request);
  expect(feedback.split("(the verifier's citation was not found in it)").length - 1).toBe(4);
  expect(feedback.split("REQUEST_BODY_MARKER").length - 1).toBeLessThanOrEqual(1);
  expect(feedback.split("check them against the original request and specification above").length - 1).toBe(
    1,
  );
  expect(feedback).not.toContain("Citation validation");
  expect(feedback).not.toContain("secret input");
});

test("an unrunnable scenario is reported unmet not_required; unclear stays blocking", () => {
  expect(verifyPrompt({ prompt: "make it work", spec, holdout, baseSha: "abc" })).toContain(
    "If a scenario cannot be run as written in this repository, report it `unmet` with requirement `not_required`; use `unclear` only for a check you ran whose outcome you could not determine.",
  );
  expect(normalizeVerify(unmetHoldout({ status: "unclear" }), spec, holdout).overall).toBe("fail");
});

test("an invalid requirement value parses as null and blocks; the strict schema is unchanged", () => {
  for (const requirement of ["", "none"]) {
    const parsed = VerifySchema.parse({
      ...unmetHoldout({}),
      criteria: unmetHoldout({}).criteria.map((c) => ({ ...c, requirement })),
    });
    expect(parsed.criteria.map((c) => c.requirement)).toEqual([null, null]);
    expect(normalizeVerify(parsed, spec, holdout).overall).toBe("fail");
  }
  const item = (toStrictJsonSchema(VerifySchema) as { properties: { criteria: { items: unknown } } })
    .properties.criteria.items as { required: string[]; properties: Record<string, unknown> };
  expect(item.required).toContain("requirement");
  expect(item.properties.requirement).toEqual({
    description: "For unmet H-ids, what the failure violates; null for every other entry",
    anyOf: [{ type: "string", enum: ["request", "spec", "not_required"] }, { type: "null" }],
  });
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

test("spec criterion ids are exactly AC-n", () => {
  for (const id of ["AC-1", "AC-12", "H-1", "unknown", "AC-1 secret", "AC-1\n", "xAC-1", "AC-"]) {
    const parsed = SpecSchema.safeParse({
      ...spec,
      acceptance_criteria: [{ ...spec.acceptance_criteria[0], id }],
    });
    expect(parsed.success).toBe(id === "AC-1" || id === "AC-12");
  }
});

test("legacy collisions and unknown ids never expose private rows in artifacts or feedback", () => {
  const legacy = {
    ...spec,
    acceptance_criteria: [
      ...spec.acceptance_criteria,
      { id: "H-1", criterion: "legacy", how_to_verify: "inspect" },
    ],
  };
  const privateText = "secret input PrivateEvidence_931";
  const verify: Verify = {
    overall: "fail",
    notes: "",
    criteria: [
      { id: "AC-1", status: "unmet", evidence: "public evidence at code.ts:12", publicSummary: "" },
      {
        id: "H-1",
        status: "unmet",
        evidence: privateText,
        publicSummary: privateText,
        requirementCitation: privateText,
      },
      {
        id: "X-9",
        status: "unclear",
        evidence: "arbitrary private prose",
        publicSummary: "arbitrary private prose",
        requirementCitation: "arbitrary private prose",
      },
      {
        id: "H-1 secret",
        status: "unmet",
        evidence: privateText,
        publicSummary: privateText,
        requirement: "spec",
        requirementCitation: privateText,
      },
      {
        id: "",
        status: "unclear",
        evidence: "arbitrary private prose",
        publicSummary: "arbitrary private prose",
      },
    ],
  };
  const artifact = preDeliveryVerifyArtifact(
    { ...verify, modelId: "fake", round: 0, attempt: 0 },
    legacy,
    holdout,
    "",
  );
  const rows = JSON.parse(artifact) as Verify;
  expect(rows.criteria.map((c) => c.id)).toEqual(["AC-1", "H-1", "unknown-3", "unknown-4", "unknown-5"]);
  for (const row of rows.criteria.slice(2)) {
    expect(row.evidence).toBe("");
    expect(row.publicSummary).toBe("");
    expect(row.requirementCitation).toBe("");
  }
  const feedback = formatVerifyFeedback(verify, legacy, holdout);
  for (const output of [artifact, feedback]) {
    expect(output).toContain("public evidence at code.ts:12");
    for (const secret of [
      "secret input",
      "PrivateEvidence_931",
      "H-1 secret",
      "arbitrary private prose",
      "X-9",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("unknown-");
  }
});
