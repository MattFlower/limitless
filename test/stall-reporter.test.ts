import { expect, spyOn, test } from "bun:test";
import { renderReport } from "../src/pipeline/report.ts";
import { EventLoopLag } from "../src/server/event-loop-lag.ts";
import { redactCredentials, registerCredential } from "../src/util/proc.ts";
import { StallReporter, stallReporter } from "../src/util/stall.ts";

test("one stall line per late sample, including the threshold boundary", () => {
  let time = 0;
  const lines: string[] = [];
  const reporter = new StallReporter(
    () => time,
    (line) => lines.push(line),
  );
  const lag = new EventLoopLag(() => time);
  for (const lateness of [0, 1999, 4500, 2000, 0]) {
    time += 1000 + lateness;
    reporter.sample(lag.sample());
  }
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("lag=4500ms");
  expect(lines[1]).toContain("lag=2000ms");
});

test("completed, throwing and active work is aggregated, sorted, capped and reset", () => {
  let time = 0;
  const lines: string[] = [];
  const reporter = new StallReporter(
    () => time,
    (line) => lines.push(line),
  );
  reporter.activity("old", () => {
    time += 10;
  });
  reporter.sample(0);
  reporter.activity("ci-log.inspect", () => {
    time += 3000;
  });
  const error = new Error("same error");
  expect(() =>
    reporter.activity("report.render", () => {
      time += 100;
      throw error;
    }),
  ).toThrow(error);
  try {
    reporter.activity("throw.identity", () => {
      throw error;
    });
  } catch (caught) {
    expect(caught).toBe(error);
  }
  const value = {};
  expect(reporter.activity("return.identity", () => value)).toBe(value);
  for (let i = 0; i < 50; i++)
    reporter.activity("redact", () => {
      time++;
    });
  const end = reporter.beginActivity("poller.cycle");
  time += 2000;
  reporter.sample(4000);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("ci-log.inspect: count=1 total=3000ms max=3000ms");
  expect(lines[0]).toContain("report.render: count=1 total=100ms");
  expect(lines[0]).toContain("redact: count=50 total=50ms");
  expect(lines[0]).toContain("poller.cycle: count=0 total=0ms max=0ms active=1 elapsed=2000ms");
  expect(lines[0]).not.toContain("old");
  expect(lines[0]?.match(/count=/g)).toHaveLength(5);
  expect(lines[0]?.indexOf("ci-log.inspect")).toBeLessThan(lines[0]?.indexOf("poller.cycle") ?? 0);
  end();
  end();
  reporter.sample(4000);
  expect(lines[1]).toContain("poller.cycle: count=1 total=2000ms");
  expect(lines[1]).not.toContain("active=");
  reporter.sample(4000);
  expect(lines[2]).not.toContain("poller.cycle");
  for (let i = 0; i < 10_000; i++)
    reporter.activity(`bounded-${i}`, () => {
      time++;
    });
  reporter.sample(4000);
  expect(lines[3]?.match(/count=/g)).toHaveLength(5);
});

test("real credential and report paths preserve output and record their work", () => {
  let time = 0;
  const lines: string[] = [];
  const clock = spyOn(stallReporter, "now").mockImplementation(() => time++);
  const log = spyOn(console, "warn").mockImplementation((line: string) => {
    lines.push(line);
  });
  try {
    stallReporter.sample(0);
    registerCredential("STALL_TEST_TOKEN", "synthetic-stall-token");
    expect(redactCredentials("value=synthetic-stall-token")).toBe("value=[redacted]");
    expect(redactCredentials("value=synthetic-stall-token", { start: 10, end: 20 })).toBe("[redacted]");
    expect(["plain", "synthetic-stall-token"].map(redactCredentials)).toEqual(["plain", "[redacted]"]);
    const report = renderReport({
      success: true,
      runId: "r1",
      prompt: "Build",
      state: {},
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "u",
    });
    expect(report).toStartWith("Built by **Limitless**");
    stallReporter.sample(4000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("credentials.redact");
    expect(lines[0]).toContain("report.render");
  } finally {
    clock.mockRestore();
    log.mockRestore();
  }
});
