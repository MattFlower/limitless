import { expect, test } from "bun:test";
import { formatGateFeedback } from "../src/pipeline/prompts.ts";

function feedback(output: string): string {
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
        timedOut: true,
        durationMs: 900_000,
        output,
      },
    },
  ]);
}

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
