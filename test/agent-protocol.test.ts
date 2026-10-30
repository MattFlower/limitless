import { expect, test } from "bun:test";
import { AgentEvents, AgentResultReport } from "../src/workers/agent-protocol.ts";

test("browser diagnostics retain their code through the event protocol", () => {
  const warning = {
    type: "warning",
    id: "browser-unavailable",
    code: "browser_unavailable",
    text: "Browser disabled: missing cache",
  } as const;
  expect(AgentEvents.parse({ seq: 0, events: [warning] }).events).toEqual([warning]);
  expect(AgentEvents.safeParse({ seq: 0, events: [{ ...warning, code: "unknown" }] }).success).toBe(false);
});

test("agent result reports accept only terminal statuses and strict fields", () => {
  const report = {
    status: "ok",
    finalText: "Completed",
    structured: null,
    sessionId: null,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    numTurns: 1,
    costUsd: 0,
    costEquivUsd: 0,
    error: null,
    quota: null,
    parentSha: "f".repeat(40),
    sha: "a".repeat(40),
    branch: "change/example",
  };
  for (const status of ["ok", "error", "cancelled", "timeout", "stuck", "quota", "unavailable", "declined"])
    expect(AgentResultReport.safeParse({ ...report, status }).success).toBe(true);
  for (const failureClass of ["authentication", "malformed"] as const)
    expect(AgentResultReport.parse({ ...report, failureClass }).failureClass).toBe(failureClass);
  expect(
    AgentResultReport.parse({ ...report, status: "error", error: "Failed to authenticate" }).failureClass,
  ).toBeUndefined();
  for (const bad of [
    { status: "running" },
    { status: "unknown" },
    { extra: true },
    { failureClass: "unknown" },
    { failureClass: true },
  ])
    expect(AgentResultReport.safeParse({ ...report, ...bad }).success).toBe(false);
});
