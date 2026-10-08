import { expect, test } from "bun:test";
import { formatGateFeedback } from "../src/pipeline/prompts.ts";

function feedback(output: string, failures?: string, timedOut = true): string {
  return formatGateFeedback([
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
  ]);
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
