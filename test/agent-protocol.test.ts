import { expect, test } from "bun:test";
import { AgentResultReport } from "../src/workers/agent-protocol.ts";

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
  for (const bad of [{ status: "running" }, { status: "unknown" }, { extra: true }])
    expect(AgentResultReport.safeParse({ ...report, ...bad }).success).toBe(false);
});
