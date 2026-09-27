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
for (const [evidence, blocked] of [
  ["Ran bun test: failed with EPERM creating fixture directory", true],
  ["Attempted mkdir: EACCES", true],
  ["bun run build failed: permission denied opening output", true],
  ["Could not execute sh check: operation not permitted", true],
  ["Attempted sh test command: sandbox denied file write", true],
  ["Expected permission denied test passed", false],
  ["Assertion failed: expected EPERM, got success", false],
  ["Source code contains literal 'EPERM'; test failed on wrong value", false],
  ["Documentation says command failed with permission denied", false],
  ["Quoted 'bun test failed: EACCES'", false],
  ["bun test failed: expected 1 received 2", false],
  ["bun test failed: missing tool", false],
] as const) {
  test(`normalization: ${evidence}`, () => {
    for (const status of ["unmet", "unclear"] as const) {
      const result = normalizeVerify(
        { criteria: [{ id: "AC-1", status, evidence }], overall: "pass", notes: "" },
        spec,
        holdout,
        [
          {
            command: evidence.includes("mkdir")
              ? "mkdir"
              : evidence.includes("bun")
                ? "bun test"
                : "sh check",
            output: evidence,
            isError: true,
          },
        ],
      );
      expect(result.criteria[0]?.status).toBe(blocked ? "blocked" : status);
      expect(result.criteria[1]?.status).toBe("unclear");
      expect(result.overall).toBe("fail");
      expect(blockedOnly(result)).toBe(false);
    }
  });
}

test("a met criterion whose evidence mentions a resolved EPERM stays met", () => {
  const evidence = "Ran bun test; failed with EPERM mkdtemp, reran with TMPDIR and it passed";
  const result = normalizeVerify(
    {
      criteria: [
        { id: "AC-1", status: "met", evidence },
        { id: "H-1", status: "met", evidence: "ok" },
      ],
      overall: "pass",
      notes: "",
    },
    spec,
    holdout,
    [
      { command: "bun test", output: "EPERM: operation not permitted, mkdtemp", isError: true },
      { command: "TMPDIR=$TMPDIR bun test", output: "12 pass", isError: false },
    ],
  );
  expect(result.criteria[0]?.status).toBe("met");
  expect(blockedOnly(result)).toBe(false);
  expect(result.overall).toBe("pass");
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

test("derivation requires failed command evidence, not source reads, claims or successful denial tests", () => {
  const verify = {
    criteria: [
      {
        id: "AC-1",
        status: "unclear" as const,
        evidence: "Ran bun test: failed with EPERM creating fixture directory",
      },
    ],
    overall: "fail" as const,
    notes: "",
  };
  for (const commands of [
    [],
    [{ command: "bun test", output: "EPERM", isError: false }],
    [{ command: "cat test.ts", output: "bun test failed: EPERM", isError: true }],
    [{ command: "bun test", output: "assertion failed: expected EPERM", isError: true }],
  ])
    expect(normalizeVerify(verify, spec, holdout, commands).criteria[0]?.status).toBe("unclear");
  expect(
    normalizeVerify(verify, spec, holdout, [
      { command: "/bin/zsh -lc 'bun test'", output: "EPERM", isError: true },
    ]).criteria[0]?.status,
  ).toBe("blocked");
});
