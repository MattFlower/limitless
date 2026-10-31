import { expect, test } from "bun:test";
import * as e from "../src/pipeline/run-transfer-execution.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { rejects } from "./run-transfer-support.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const check = (n: number) => ({
  name: "test",
  command: oid(90),
  ok: false,
  exitCode: null,
  durationMs: 4,
  output: oid(91),
  executionProvenance: { sha: oid(n), trackedClean: false },
  reused: { executionId: oid(92), treeHash: oid(93), createdAt: 3 },
});
const completed = {
  sha: oid(4),
  treeHash: oid(94),
  trackedClean: true,
  setupOk: true,
  setup: [check(5)],
  checks: [
    {
      ...check(6),
      firstAttempt: { ...check(7), targetedRetry: check(8) },
      retryAttempt: {
        ...check(9),
        executor: { kind: "github-actions" as const, workflowSha: oid(10), runsOn: "linux" },
      },
      testCoverage: { passedFiles: ["a.test.ts"], skippedFiles: [], summary: { passed: 1, failed: 0 } },
    },
  ],
};
function source() {
  return {
    stage: "gates",
    round: 2,
    purpose: "initial",
    sha: oid(1),
    gateKey: "configuration",
    handle: {
      kind: "github-actions",
      id: oid(95),
      startedAt: 10,
      githubActions: {
        repo: "example/project",
        cwd: "/private/checkout",
        candidate: "candidate/ref",
        dispatch: "dispatch/ref",
        headSha: oid(2),
        dispatchSha: oid(3),
        owner: "logical-run",
        gateKey: "configuration",
        inputs: {
          sha: oid(11),
          candidate: "candidate/ref",
          setup: "[]",
          checks: oid(96),
          setup_minutes: "1",
        },
        dispatchIntent: true,
        cleanupRunIds: [21, 22],
        cleanupFailed: true,
        visibilityDeadline: 110,
        deadline: 120,
        nextPollAt: 115,
        interrupted: "operational",
        diagnostic: "dispatch response lost",
        completed,
      },
    },
  };
}
const roundTrip = (value: unknown) =>
  e.parseTransferExecution(
    JSON.parse(new TextDecoder().decode(encodeTransferJson(e.encodeTransferExecution(value)))),
  );
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

test("completed active Actions evidence survives without previous history", () => {
  const input = freeze(source());
  const value = roundTrip(input);
  expect(value.stage).toBe("gates");
  expect(value.identity).toEqual({ executorKind: "github-actions", id: oid(95), startedAt: 10 });
  expect(value.githubActions?.completed).toEqual(completed);
  expect(value.githubActions?.completed?.checks[0]?.firstAttempt?.targetedRetry?.executionProvenance).toEqual(
    { sha: oid(8), trackedClean: false },
  );
  expect(value.githubActions?.completed?.checks[0]?.retryAttempt?.executor?.workflowSha).toBe(oid(10));
  expect(value.previous).toBeUndefined();
  expect(JSON.stringify(value)).not.toContain("/private/checkout");
  expect(Object.hasOwn(value, "handle")).toBe(false);
  expect(input.handle.githubActions.cwd).toBe("/private/checkout");
});

test("uncertain dispatch and known remote cleanup retain distinct obligations and optional flags", () => {
  for (const known of [false, true]) {
    const input = source();
    const p = input.handle.githubActions;
    const value = roundTrip({
      ...input,
      handle: {
        ...input.handle,
        ...(known ? { url: "https://github.com/example/project/actions/runs/23" } : {}),
        githubActions: { ...p, ...(known ? { runId: 23, pushed: false, dispatchSent: false } : {}) },
      },
    });
    expect(value.githubActions).toMatchObject({
      repo: "example/project",
      candidate: "candidate/ref",
      dispatch: "dispatch/ref",
      headSha: oid(2),
      dispatchSha: oid(3),
      dispatchIntent: true,
      cleanupRunIds: [21, 22],
      cleanupFailed: true,
      visibilityDeadline: 110,
      deadline: 120,
      nextPollAt: 115,
      interrupted: "operational",
      diagnostic: "dispatch response lost",
      owner: "logical-run",
      gateKey: "configuration",
    });
    expect(Object.hasOwn(value.githubActions ?? {}, "runId")).toBe(known);
    expect(Object.hasOwn(value.githubActions ?? {}, "pushed")).toBe(known);
    expect(Object.hasOwn(value.githubActions ?? {}, "dispatchSent")).toBe(known);
    expect(value.githubActions?.runId).toBe(known ? 23 : undefined);
    expect(value.githubActions?.dispatchSent).toBe(known ? false : undefined);
  }
});

test("previous order and recursive typed dependencies exclude opaque hashes", () => {
  const value = roundTrip({
    ...source(),
    previous: [
      { purpose: "baseline", gateKey: "one", result: { setupOk: false, setup: [check(12)], checks: [] } },
      { purpose: "baseline", gateKey: "two", result: { setupOk: true, setup: [], checks: [check(13)] } },
    ],
  });
  expect(value.previous?.map((v) => [v.purpose, v.gateKey, v.result.setupOk])).toEqual([
    ["baseline", "one", false],
    ["baseline", "two", true],
  ]);
  expect(new Set(e.executionCommitDependencies(value))).toEqual(
    new Set(Array.from({ length: 13 }, (_, i) => oid(i + 1))),
  );
});

test("local execution is historical and optional undefined source members are omitted", () => {
  const value = roundTrip({
    ...source(),
    previous: [],
    handle: { kind: "local", id: "local-attempt", startedAt: 0, url: undefined },
  });
  expect(value.identity).toEqual({ executorKind: "local", id: "local-attempt", startedAt: 0 });
  expect(value.previous).toEqual([]);
  expect(Object.hasOwn(value, "githubActions")).toBe(false);
});

test("unsupported executors, progress combinations and unclassified dependencies fail closed", () => {
  const input = source();
  for (const kind of ["lan", "inplace", "claude-cloud", "future", "local"])
    rejects(() => e.encodeTransferExecution({ ...input, handle: { ...input.handle, kind } }), "unsupported");
  rejects(
    () => e.encodeTransferExecution({ ...input, handle: { kind: "github-actions", id: "id", startedAt: 1 } }),
    "unsupported",
  );
  for (const githubActions of [
    { ...input.handle.githubActions, dependencySha: oid(80) },
    { ...input.handle.githubActions, inputs: { ...input.handle.githubActions.inputs, baseSha: oid(80) } },
    { ...input.handle.githubActions, completed: { ...completed, stageId: 900 } },
  ])
    rejects(
      () => e.encodeTransferExecution({ ...input, handle: { ...input.handle, githubActions } }),
      "unsupported",
    );
  let lifecycleCalls = 0;
  const attach = () => {
    lifecycleCalls++;
  };
  rejects(() => e.encodeTransferExecution({ ...input, handle: { ...input.handle, attach } }), "unsupported");
  expect(lifecycleCalls).toBe(0);
});

test("only credential-free matching HTTPS Actions run references are supported", () => {
  for (const url of [
    "file:///checkout",
    "https://github.com/other/project/actions/runs/23",
    "https://user:password@github.com/example/project/actions/runs/23",
    "https://github.com/example/project/actions/runs/23?secret=value",
    "https://github.com/example/project/actions/runs/23#fragment",
    "https://github.com/example/project/actions/runs/24",
    "http://github.com/example/project/actions/runs/23",
    "https://github.com/example/project/actions/runs/9007199254740992",
    "https://github.com/example/project/actions/runs/23\n",
  ]) {
    const input = source();
    rejects(
      () =>
        e.encodeTransferExecution({
          ...input,
          handle: { ...input.handle, url, githubActions: { ...input.handle.githubActions, runId: 23 } },
        }),
      "unsupported",
    );
  }
  const input = source();
  rejects(
    () =>
      e.encodeTransferExecution({
        ...input,
        handle: {
          ...input.handle,
          url: "https://github.com/example/../actions/runs/23",
          githubActions: { ...input.handle.githubActions, repo: "example/..", runId: 23 },
        },
      }),
    "unsupported",
  );
});

test("portable schemas reject injected resources, malformed commits and incompatible progress", () => {
  const value = roundTrip(source());
  for (const extra of [
    { cwd: "/checkout" },
    { request: {} },
    { lease_expires_at: 99 },
    { sessionId: "session" },
  ]) {
    rejects(() => e.parseTransferExecution({ ...value, ...extra }));
    rejects(() =>
      e.parseTransferExecution({ ...value, githubActions: { ...value.githubActions, ...extra } }),
    );
  }
  rejects(() => e.parseTransferExecution({ ...value, sha: "private malformed commit" }));
  rejects(() =>
    e.parseTransferExecution({ ...value, identity: { ...value.identity, executorKind: "local" } }),
  );
  rejects(() => e.encodeTransferExecution({ ...source(), sha: "invalid" }));
});
