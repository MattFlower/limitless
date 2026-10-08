import { expect, test } from "bun:test";
import { extractFailures } from "../src/gates/failures.ts";
import { compareGates, type GateComparison } from "../src/gates/run.ts";
import { formatGateFeedback, reviewPrompt } from "../src/pipeline/prompts.ts";
import { credentialGate, gateCredential } from "./gate-output-support.ts";

test("gate feedback and review receive redacted early diagnostics and tails", async () => {
  const gates = compareGates(null, await credentialGate());
  const messages = [
    formatGateFeedback(gates),
    reviewPrompt({
      prompt: "fix tests",
      spec: null,
      baseSha: "base",
      stat: "",
      gates,
      audit: [],
      implementerReport: "",
    }),
  ];
  for (const message of messages) {
    expect(message).toContain("error: credential [redacted]");
    expect(message).toContain("(fail) assertion");
    expect(message).not.toContain(gateCredential);
  }
});

function comparison(output: string, failures?: string, timedOut = true): GateComparison[] {
  return [
    {
      name: "test",
      verdict: "regressed",
      blocking: true,
      result: {
        name: "test",
        command: "fake-test",
        ok: false,
        exitCode: 1,
        timedOut,
        durationMs: 900_000,
        output,
        ...(failures ? { failures } : {}),
      },
    },
  ];
}

function feedback(output: string, failures?: string, timedOut = true): string {
  return formatGateFeedback(comparison(output, failures, timedOut));
}

test.each([false, true])(
  "failure feedback puts bounded excerpts before a shorter tail (timeout: %s)",
  (timedOut) => {
    const reason = "error: values differ\nExpected: 1\nReceived: 2\n(fail) assertion";
    const message = feedback("summary\n".repeat(800), `${reason}\n${"x".repeat(8_000)}`, timedOut);
    expect(message).toContain(reason);
    expect(message.indexOf("error:")).toBeLessThan(message.indexOf("summary"));
    expect(message).toContain("left out");
    expect(message.length).toBeLessThan(3_300);
  },
);

test("legacy failed gate feedback still shows the tail", () => {
  const message = feedback(`early\n${"x".repeat(4_000)}\nlegacy failure tail`, undefined, false);
  expect(message).toContain("legacy failure tail");
  expect(message).not.toContain("early");
  expect(message.length).toBeLessThan(3_300);
});

test.each([
  "ok 1 - completed test\n  ---\n  duration_ms: 0.1\n  ...\n",
  "not ok 1 - completed test\n",
  "ok 1 completed test\n",
  "ok 1\n",
  "ok 1 - completed test # SKIP unavailable\n",
])("timeout feedback does not call a completed TAP subtest running: %s", (result) => {
  expect(feedback(`[timed out]\n# Subtest: completed test\n${result}`)).not.toContain(
    "the last test running was completed test",
  );
});

test.each(["", "ok 1 - other test\n", "  ok 1 - unfinished test\n"])(
  "timeout feedback names an unfinished TAP subtest: %s",
  (result) => {
    expect(feedback(`[timed out]\n# Subtest: unfinished test\n${result}`)).toContain(
      "the last test running was unfinished test",
    );
  },
);

test("timeout feedback names the unfinished subtest after a completed one", () => {
  expect(
    feedback("# Subtest: completed test\nok 1 - completed test\n# Subtest: unfinished test\n"),
  ).toContain("the last test running was unfinished test");
});

test("timeout feedback recognizes indented TAP completion with ANSI and CRLF", () => {
  expect(
    feedback("\u001b[32m  # Subtest: completed test\u001b[0m\r\n  ok 1 - completed test\r\n"),
  ).not.toContain("the last test running was completed test");
});

for (const consumer of ["feedback", "review"]) {
  test.each([
    ["(fail) identifier", "(fail) identifier"],
    ["\u001b[31m✗ colored identifier\u001b[0m", "✗ colored identifier"],
    ["not ok 1 - tap identifier", "not ok 1 - tap identifier"],
  ])(`${consumer} keeps the complete identity after a long diagnostic: %s`, (result, identity) => {
    const failures = extractFailures(`error: reason\n${"x".repeat(9_000)}\n${result}`);
    const gates = comparison("summary\n".repeat(800), failures, false);
    const message =
      consumer === "feedback"
        ? formatGateFeedback(gates)
        : reviewPrompt({
            prompt: "fix tests",
            spec: null,
            baseSha: "base",
            stat: "",
            gates,
            audit: [],
            implementerReport: "",
          });
    expect(message).toContain(identity);
    expect(message).toContain("error: reason");
    expect(message).toContain("left out");
    expect(message.indexOf(identity)).toBeLessThan(message.indexOf("summary"));
    expect(message).not.toContain("\u001b");
    if (consumer === "feedback") expect(message.length).toBeLessThan(3_300);
  });
}
