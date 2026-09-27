import { expect, test } from "bun:test";
import { ClaudeStreamParser } from "../src/harness/claude.ts";
import { CodexStreamParser } from "../src/harness/codex.ts";
import type { AgentEvent, CommandResult } from "../src/harness/types.ts";
import { formatVerifyFeedback } from "../src/pipeline/prompts.ts";
import { type Holdout, type Spec, VerifySchema } from "../src/pipeline/schemas.ts";
import { blockedOnly, executedChecks, normalizeVerify } from "../src/pipeline/verification.ts";

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
for (const [evidence, blocked, command] of [
  ["Ran bun test: failed with EPERM creating fixture directory", true, "bun test"],
  ["Attempted mkdir: EACCES", true, "mkdir -p fixtures"],
  ["bun run build failed: permission denied opening output", true, "bun run build"],
  ["Could not execute sh check: operation not permitted", true, "sh check"],
  ["Attempted sh test command: sandbox denied file write", true, "sh check"],
  ["Expected permission denied test passed", false, "bun test"],
  ["Assertion failed: expected EPERM, got success", false, "bun test"],
  ["Source code contains literal 'EPERM'; test failed on wrong value", false, "bun test"],
  ["Documentation says command failed with permission denied", false, "sh check"],
  ["Quoted 'bun test failed: EACCES'", false, "bun test"],
  ["bun test failed: expected 1 received 2", false, "bun test"],
  ["bun test failed: missing tool", false, "bun test"],
] as const) {
  test(`normalization: ${evidence}`, () => {
    for (const status of ["unmet", "unclear"] as const) {
      const result = normalizeVerify(
        { criteria: [{ id: "AC-1", status, evidence }], overall: "pass", notes: "" },
        spec,
        holdout,
        [{ command, output: evidence, isError: true }],
      );
      expect(result.criteria[0]?.status).toBe(blocked ? "blocked" : status);
      expect(result.criteria[1]?.status).toBe("unclear");
      expect(result.overall).toBe("fail");
      expect(blockedOnly(result)).toBe(false);
    }
  });
}

const eperm = "error: EPERM: operation not permitted, mkdtemp '/tmp/fixture-'";
const statusOf = (evidence: string, commands: CommandResult[]) =>
  normalizeVerify(
    { criteria: [{ id: "AC-1", status: "unmet", evidence }], overall: "fail", notes: "" },
    spec,
    holdout,
    commands,
  ).criteria[0]?.status;

for (const command of [
  "bun test",
  "TMPDIR=/tmp/scratch bun test",
  "env TMPDIR=/tmp/scratch bun test",
  "env -u CI TMPDIR=/tmp/scratch bun test --timeout 5000",
  "cd /repo && bun test",
  "/bin/zsh -lc 'cd /repo && TMPDIR=/tmp/scratch bun test'",
  'bash -lc "bun test 2>&1 | tail -40"',
]) {
  test(`wrapped check commands are correlated: ${command}`, () => {
    expect(executedChecks(command)).toContainEqual({ executable: "bun", target: "test", args: [] });
    expect(
      statusOf("Ran bun test: fixture setup failed with EPERM", [{ command, output: eperm, isError: true }]),
    ).toBe("blocked");
  });
}

test("a permission error from another check does not mask a genuine failure", () => {
  const evidence =
    "bun run build failed with EPERM writing dist, worked around by building into TMPDIR; bun test then returned HTTP 500 instead of 200";
  const build = {
    command: "bun run build",
    output: "EPERM: operation not permitted, open 'dist/app.js'",
    isError: true,
  };
  const failing = {
    command: "bun test",
    output: "(fail) GET /health\nExpected: 200\nReceived: 500",
    isError: true,
  };
  expect(statusOf(evidence, [build, failing])).toBe("unmet");
  // The build barrier was resolved by a later successful build; the remaining failure is genuine.
  const rebuilt = {
    command: "TMPDIR=/tmp/s bun run build --outdir /tmp/s/dist",
    output: "ok",
    isError: false,
  };
  expect(statusOf(evidence, [build, rebuilt, failing])).toBe("unmet");
  // A criterion that only refers to the unrelated build does not inherit the test failure.
  expect(statusOf("bun test could not start: EPERM mkdtemp", [build, failing])).toBe("unmet");
  expect(statusOf("bun run build failed with EPERM writing dist", [build, failing])).toBe("blocked");
});

test("a successful unrelated check does not resolve another check's barrier", () => {
  const integration = {
    command: "bun test test/integration.test.ts",
    output: eperm,
    isError: true,
  };
  const unit = { command: "bun test test/unit.test.ts", output: "4 pass", isError: false };
  expect(executedChecks(integration.command)).toEqual([
    { executable: "bun", target: "test", args: ["test/integration.test.ts"] },
  ]);
  expect(executedChecks("bun test test/a.test.ts 2>&1 > out.txt --timeout 5 --bail=1 -t name")).toEqual([
    { executable: "bun", target: "test", args: ["test/a.test.ts"] },
  ]);
  expect(executedChecks("bun test --timeout 5 test/a.test.ts")).toEqual([
    { executable: "bun", target: "test", args: ["test/a.test.ts"] },
  ]);
  const evidence = "bun test test/integration.test.ts failed with EPERM creating a fixture directory";
  expect(statusOf(evidence, [integration, unit])).toBe("blocked");
  expect(statusOf("Ran bun test: EPERM creating fixtures", [integration, unit])).toBe("blocked");
  // Rerunning the same check resolves it; a unit-test assertion failure is not the integration barrier.
  expect(statusOf(evidence, [integration, { ...integration, output: "2 pass", isError: false }])).toBe(
    "unmet",
  );
  const unitFailed = { ...unit, output: "Expected: 1\nReceived: 2", isError: true };
  expect(statusOf(evidence, [integration, unitFailed])).toBe("blocked");
  expect(statusOf("Ran bun test: EPERM creating fixtures", [integration, unitFailed])).toBe("unmet");
});

test("explicit blocked results are validated against execution evidence", () => {
  const blocked = (evidence: string, commands: CommandResult[]) =>
    normalizeVerify(
      { criteria: [{ id: "AC-1", status: "blocked", evidence }], overall: "fail", notes: "" },
      spec,
      holdout,
      commands,
    ).criteria[0]?.status;
  const mismatch = {
    command: "bun test",
    output: "(fail) denies writes\nExpected: EACCES\nReceived: undefined",
    isError: true,
  };
  expect(blocked("bun test failed: expected EACCES, received success", [mismatch])).toBe("unmet");
  expect(blocked("bun test failed: expected EACCES, received success", [])).toBe("unmet");
  expect(blocked("bun test could not create fixtures: EPERM", [mismatch])).toBe("unmet");
  expect(blocked("bun test could not create fixtures: EPERM", [])).toBe("blocked");
  expect(
    blocked("bun test could not create fixtures: EPERM", [
      { command: "bun test", output: eperm, isError: true },
    ]),
  ).toBe("blocked");
  expect(blocked("bun test: the sandbox forbids creating fixture directories", [])).toBe("blocked");
});

const assertion = "(fail) GET /health\nExpected: 200\nReceived: 500";
for (const [name, output, full, truncated] of [
  ["permission error", `${"ok ".repeat(7000)}\n${eperm}`, "blocked", "unmet"],
  ["assertion failure", `${eperm}\n${"ok ".repeat(7000)}\n${assertion}`, "unmet", "blocked"],
] as const) {
  test(`a late ${name} beyond the display truncation still counts`, () => {
    expect(output.length).toBeGreaterThan(20_000);
    for (const parser of ["codex", "claude"] as const) {
      const events: AgentEvent[] = [];
      if (parser === "codex") {
        const p = new CodexStreamParser((e) => events.push(e));
        p.feed(
          JSON.stringify({
            type: "item.started",
            item: { id: "c1", type: "command_execution", command: "bun test" },
          }),
        );
        p.feed(
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "c1",
              type: "command_execution",
              command: "bun test",
              aggregated_output: output,
              exit_code: 1,
            },
          }),
        );
      } else {
        const p = new ClaudeStreamParser((e) => events.push(e));
        p.feed(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "bun test" } }],
            },
          }),
        );
        p.feed(
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "c1", content: output, is_error: true }],
            },
          }),
        );
      }
      // Collected the way RunContext.invoke pairs shell calls with their results.
      const commands = new Map<string, string>();
      const results: CommandResult[] = [];
      for (const ev of events) {
        if (ev.type === "tool_call") commands.set(ev.id, String((ev.input as { command: string }).command));
        if (ev.type === "tool_result") {
          const command = commands.get(ev.id);
          if (command)
            results.push({
              command,
              output: ev.output,
              isError: ev.isError,
              ...(ev.diagnostics ? { diagnostics: ev.diagnostics } : {}),
            });
        }
      }
      expect(results).toHaveLength(1);
      expect(results[0]?.output.length).toBe(20_000);
      const evidence = "Ran bun test: failed with EPERM creating fixtures";
      expect(statusOf(evidence, results)).toBe(full);
      // The truncated text alone would say the opposite.
      expect(
        statusOf(evidence, [{ command: "bun test", output: results[0]?.output ?? "", isError: true }]),
      ).toBe(truncated);
    }
  });
}

test("an expected-denial diagnostic elsewhere in the output does not veto a real barrier", () => {
  const output = `(pass) expected-denial.test.ts > rejects writes with EACCES as expected\n${eperm}`;
  expect(
    statusOf("Ran bun test; expected-denial tests passed; fixture setup failed with EPERM mkdtemp", [
      { command: "bun test", output, isError: true },
    ]),
  ).toBe("blocked");
  expect(
    statusOf("bun test: expected EACCES for the denial test", [
      { command: "bun test", output: "Expected: EACCES\nReceived: undefined", isError: true },
    ]),
  ).toBe("unmet");
});

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
