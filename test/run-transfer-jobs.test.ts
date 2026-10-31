import { expect, test } from "bun:test";
import type { AgentJobRow } from "../src/db/workers.ts";
import * as j from "../src/pipeline/run-transfer-jobs.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { rejects } from "./run-transfer-support.ts";

const parent = "a".repeat(40),
  resultSha = "b".repeat(40);
const invocations = [
  { id: 721, runId: "logical-run" },
  { id: 19, runId: "logical-run" },
];
const portable = [
  { ordinal: 1, runId: "logical-run" },
  { ordinal: 2, runId: "logical-run" },
];
const result = {
  status: "ok",
  failureClass: "malformed",
  finalText: "c".repeat(40),
  structured: JSON.parse('{"constructor":[null,true,1],"__proto__":{"answer":"recorded"}}'),
  usage: { input: 101, output: 102, cacheRead: 103, cacheWrite: 104, cacheWrite1h: 51 },
  numTurns: 3,
  costUsd: 1.25,
  costEquivUsd: 2.5,
  error: null,
  decline: { reason: "uncertain", lastResort: false },
  fastModeState: "enabled",
  fastModeDisabledReason: null,
  sessionId: "private-session",
  quota: { windows: {}, exhaustedUntil: 555 },
  modelCooldownMs: 300,
  confinement: { ok: true, path: "/local/binary", version: null, reason: null, exitCode: null },
};
function source(state: AgentJobRow["state"]): AgentJobRow {
  return {
    id: "historical-job",
    run_id: "logical-run",
    invocation_id: 721,
    parent_sha: parent,
    state,
    attempt: 2,
    result_sha: state === "done" ? resultSha : null,
    result: state === "done" ? JSON.stringify(result) : null,
    failure_reason: state === "queued" ? "prior attempt interrupted" : null,
    created_at: 10,
    updated_at: 20,
    attempt_deadline_at: state === "queued" ? null : 40,
    request: "private backend request",
    worker: "local-worker",
    excluded: '["worker"]',
    lease_expires_at: 99,
  };
}
const roundTrip = (value: unknown) =>
  j.parseTransferAgentJob(
    JSON.parse(new TextDecoder().decode(encodeTransferJson(j.encodeTransferAgentJob(value, invocations)))),
    portable,
  );

test.each(["queued", "leased", "done", "failed", "cancelled"] as const)(
  "%s preserves consumed attempts and absolute deadlines without queue transitions",
  (state) => {
    const input = Object.freeze(source(state));
    const value = roundTrip(input);
    expect(value).toMatchObject({
      id: "historical-job",
      run_id: "logical-run",
      invocationOrdinal: 2,
      parent_sha: parent,
      state,
      attempt: 2,
      result_sha: state === "done" ? resultSha : null,
      failure_reason: state === "queued" ? "prior attempt interrupted" : null,
      created_at: 10,
      updated_at: 20,
      attempt_deadline_at: state === "queued" ? null : 40,
    });
    for (const field of ["request", "worker", "excluded", "lease_expires_at", "invocation_id"])
      expect(Object.hasOwn(value, field)).toBe(false);
    expect(input.lease_expires_at).toBe(99);
    expect(input.invocation_id).toBe(721);
    if (state !== "done") expect(value.result).toBeNull();
  },
);

test("accepted completion retains all semantic result fields and exact commit dependencies", () => {
  const value = roundTrip(source("done"));
  expect(value.result).toEqual({
    status: "ok",
    failureClass: "malformed",
    finalText: "c".repeat(40),
    structured: JSON.parse('{"constructor":[null,true,1],"__proto__":{"answer":"recorded"}}'),
    usage: { input: 101, output: 102, cacheRead: 103, cacheWrite: 104, cacheWrite1h: 51 },
    numTurns: 3,
    costUsd: 1.25,
    costEquivUsd: 2.5,
    error: null,
    decline: { reason: "uncertain", lastResort: false },
    fastModeState: "enabled",
    fastModeDisabledReason: null,
  });
  expect(j.agentJobCommitDependencies(value)).toEqual([parent, resultSha]);
  expect(j.agentJobCommitDependencies(roundTrip(source("queued")))).toEqual([parent]);
  const encoded = JSON.stringify(value);
  for (const field of [
    "sessionId",
    "quota",
    "modelCooldownMs",
    "confinement",
    "private-session",
    "/local/binary",
  ])
    expect(encoded).not.toContain(field);
});

test("historical result optionality remains absent rather than invented", () => {
  const value = j.encodeTransferAgentResult(
    Object.freeze({
      status: "error",
      finalText: "",
      structured: null,
      usage: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      numTurns: 0,
      costUsd: 0,
      costEquivUsd: 0,
      error: "interrupted",
      fastModeState: undefined,
    }),
  );
  for (const field of ["failureClass", "decline", "fastModeState", "fastModeDisabledReason"])
    expect(Object.hasOwn(value, field)).toBe(false);
  expect(Object.hasOwn(value.usage, "cacheWrite1h")).toBe(false);
});

test("invocation ordinals use sorted IDs and reject dangling or cross-run targets", () => {
  expect(roundTrip({ ...source("queued"), invocation_id: 19 }).invocationOrdinal).toBe(1);
  expect(roundTrip({ ...source("queued"), run_id: null }).run_id).toBeNull();
  rejects(() => roundTrip({ ...source("queued"), invocation_id: 20 }));
  rejects(() => j.encodeTransferAgentJob(source("queued"), [...invocations, ...invocations]));
  rejects(() => roundTrip({ ...source("queued"), run_id: "other-run" }));
  const value = roundTrip(source("queued"));
  rejects(() => j.parseTransferAgentJob(value, portable.slice(0, 1)));
  rejects(() => j.parseTransferAgentJob(value, [{ ordinal: 2, runId: "other-run" }]));
  rejects(() => j.parseTransferAgentJob(value, [...portable, ...portable]));
});

test("strict portable records refuse local resources at every boundary", () => {
  const value = roundTrip(source("done"));
  for (const extra of [
    { request: {} },
    { sessionId: "session" },
    { lease_expires_at: 100 },
    { cwd: "/checkout" },
  ]) {
    rejects(() => j.parseTransferAgentJob({ ...value, ...extra }, portable));
    rejects(() => j.parseTransferAgentJob({ ...value, result: { ...value.result, ...extra } }, portable));
  }
  for (const change of [
    { parent_sha: "invalid" },
    { result_sha: "invalid" },
    { attempt: -1 },
    { attempt_deadline_at: -1 },
  ])
    rejects(() => roundTrip({ ...source("done"), ...change }));
  expect(() => roundTrip({ ...source("done"), result: "private malformed JSON" })).toThrow(
    expect.objectContaining({ code: "invalid", message: "Run transfer data is invalid" }),
  );
  rejects(() => roundTrip({ ...source("queued"), unknown_dependency: parent }), "unsupported");
  rejects(() => j.encodeTransferAgentResult({ ...result, backend: {} }), "unsupported");
  rejects(() => j.encodeTransferAgentResult({ ...result, structured: { nested: undefined } }));
  rejects(() => j.encodeTransferAgentResult({ ...result, structured: new Date(0) }));
});
