import { expect, test } from "bun:test";
import { Store } from "../src/db/store.ts";
import { decodeRunTransferRows, encodeRunTransferRows } from "../src/pipeline/run-transfer-rows.ts";
import { fixture, head, rejects, repo, sha } from "./run-transfer-support.ts";

test("portable rows retain identity, provenance, accounting and sparse row relationships", () => {
  const result = encodeRunTransferRows(fixture(), repo);
  expect(result.run).toEqual({
    id: "logical-run",
    repoSlug: "example/project",
    title: "Recorded title",
    prompt: "Request text",
    source: "mcp",
    sourceRef: { kind: "custom", nested: { unknown: [true, null, 1] } },
    requestedBy: "mcp:consumer",
    githubWebhookVerified: false,
    profile: "auto",
    resolvedProfile: "deep",
    taskClass: "bugfix",
    complexity: "small",
    status: "resolved",
    dependsOn: [],
    prClosedUnmerged: true,
    resolution: { kind: "done_elsewhere", ref: "other-run", note: null, by: "human", at: 77 },
    stage: "review",
    baseBranch: "main",
    deliveryBranch: null,
    baseSha: sha,
    branch: "factory/topic",
    headSha: head,
    prUrl: "https://github.com/example/project/pull/42",
    merged: false,
    mergedBy: null,
    mergedAt: null,
    costUsd: 1.25,
    costEquivUsd: 8.5,
    tokensIn: 1234,
    tokensOut: 98,
    error: null,
    createdAt: 11,
    startedAt: 12,
    finishedAt: 76,
    priority: 2,
    titleProvenance: "explicit",
    flow: "build",
    noBaselineCache: false,
    allow: ["binary"],
    githubWait: { since: 21, nextAttemptAt: 22, deadline: 25, reason: "recorded" },
    models: { review: ["vendor/model"] },
  });
  expect(result.stages).toEqual([
    {
      ordinal: 1,
      runId: "logical-run",
      name: "review",
      round: 1,
      status: "failed",
      summary: null,
      startedAt: 31,
      finishedAt: 50,
    },
    {
      ordinal: 2,
      runId: "logical-run",
      name: "review",
      round: 2,
      status: "succeeded",
      summary: "second",
      startedAt: 51,
      finishedAt: 66,
    },
  ]);
  expect(result.invocations).toEqual([
    {
      ordinal: 1,
      runId: "logical-run",
      stageOrdinal: null,
      role: "triage",
      harness: "fake",
      provider: "provider",
      model: "other",
      modelId: "vendor/other",
      effort: null,
      status: "declined",
      costUsd: 0.5,
      costEquivUsd: 1,
      inputTokens: 8,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      numTurns: 1,
      waitMs: 0,
      fast: false,
      fastModeState: null,
      fastModeDisabledReason: "disabled",
      error: "uncertain",
      startedAt: 13,
      finishedAt: 20,
    },
    {
      ordinal: 2,
      runId: "logical-run",
      stageOrdinal: 2,
      role: "review_shadow",
      harness: "fake",
      provider: "provider",
      model: "model",
      modelId: "vendor/model",
      effort: "default",
      status: "ok",
      costUsd: 0.25,
      costEquivUsd: 2.5,
      inputTokens: 101,
      outputTokens: 23,
      cacheReadTokens: 43,
      cacheWriteTokens: 53,
      numTurns: 3,
      waitMs: 19,
      fast: true,
      fastModeState: "enabled",
      fastModeDisabledReason: null,
      error: null,
      startedAt: 52,
      finishedAt: 60,
    },
  ]);
  expect(result.questions).toEqual([
    {
      ordinal: 1,
      runId: "logical-run",
      question: "Answered?",
      answer: "Yes",
      askedAt: 25,
      answeredAt: 26,
      answeredBy: "human",
    },
    {
      ordinal: 2,
      runId: "logical-run",
      question: "Open?",
      answer: null,
      askedAt: 65,
      answeredAt: null,
      answeredBy: null,
    },
  ]);
  expect(decodeRunTransferRows(result, { ...repo, id: "destination-binding" })).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(
    /local-binding|private-session|sessionId|repoId|stageId|"id":(900|721|101)/,
  );
});

test("optional absence, explicit nulls and safe boundary values receive no defaults", () => {
  const input = fixture();
  for (const key of ["models", "flow", "githubWait", "titleProvenance", "noBaselineCache", "allow"] as const)
    delete input.run[key];
  Object.assign(input.run, {
    tokensIn: Number.MAX_SAFE_INTEGER,
    tokensOut: 0,
    baseSha: null,
    headSha: null,
    startedAt: null,
  });
  const result = encodeRunTransferRows(input, repo);
  for (const key of ["models", "flow", "githubWait", "titleProvenance", "noBaselineCache", "allow"])
    expect(result.run).not.toHaveProperty(key);
  expect(decodeRunTransferRows(result, repo).run).toMatchObject({
    tokensIn: Number.MAX_SAFE_INTEGER,
    tokensOut: 0,
    baseSha: null,
    headSha: null,
    startedAt: null,
  });
});

test("request JSON retains arbitrary keys while input envelopes stay closed", () => {
  const input = fixture();
  input.run.sourceRef = JSON.parse('{"__proto__":{"inert":1},"constructor":{"inert":2},"nested":[null]}');
  const wire = encodeRunTransferRows(input, repo);
  expect(wire.run.sourceRef).toEqual(
    JSON.parse('{"__proto__":{"inert":1},"constructor":{"inert":2},"nested":[null]}'),
  );
  expect(decodeRunTransferRows(wire, repo).run.sourceRef).toEqual(input.run.sourceRef);
  rejects(() => encodeRunTransferRows(Object.assign(input, { undeclared: true }), repo));
});

test("both row boundaries reject malformed declared fields without normalization", () => {
  const mutations = [
    ["run", "status", "invented"],
    ["run", "tokensIn", -1],
    ["run", "tokensOut", 0.5],
    ["run", "createdAt", Number.MAX_SAFE_INTEGER + 1],
    ["run", "costUsd", Infinity],
    ["run", "costEquivUsd", NaN],
    ["run", "priority", -0],
    ["run", "githubWebhookVerified", 1],
    ["run", "baseSha", "bad"],
    ["run", "titleProvenance", "unknown"],
    ["run", "flow", 3],
    ["run", "sourceRef", []],
    ["run", "models", []],
    ["run", "undeclared", true],
    ["stages", "name", "bogus"],
    ["stages", "round", -1],
    ["stages", "runId", "other"],
    ["invocations", "effort", "bogus"],
    ["invocations", "status", "bogus"],
    ["invocations", "numTurns", 0.5],
    ["invocations", "costUsd", Infinity],
    ["invocations", "runId", "other"],
    ["questions", "answer", 1],
    ["questions", "askedAt", -1],
  ] as const;
  for (const [collection, key, value] of mutations) {
    const input = fixture(),
      wire = encodeRunTransferRows(input, repo);
    Object.assign(collection === "run" ? input.run : (input[collection][0] ?? {}), { [key]: value });
    Object.assign(collection === "run" ? wire.run : (wire[collection][0] ?? {}), { [key]: value });
    rejects(() => encodeRunTransferRows(input, repo));
    rejects(() => decodeRunTransferRows(wire, repo));
  }
});

test("strict wire envelopes, required nullable fields and relational ordinals", () => {
  const mutate = (change: (wire: ReturnType<typeof encodeRunTransferRows>) => unknown) => {
    const wire = encodeRunTransferRows(fixture(), repo);
    change(wire);
    rejects(() => decodeRunTransferRows(wire, repo));
  };
  for (const extra of [{ unexpected: true }, { repoId: "local" }, { approval: {} }])
    mutate((w) => Object.assign(w, extra));
  mutate((w) => Reflect.deleteProperty(w.run, "headSha"));
  mutate((w) => Reflect.deleteProperty(w.run, "dependsOn"));
  mutate((w) => Object.assign(w.run, { repoId: "local" }));
  for (const collection of ["stages", "invocations", "questions"] as const) {
    for (const ordinal of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      mutate((w) => Object.assign(w[collection][0] ?? {}, { ordinal }));
    mutate((w) => Object.assign(w[collection][0] ?? {}, { ordinal: 2 }));
    mutate((w) => Object.assign(w[collection][0] ?? {}, { id: 91 }));
    const input = fixture();
    input[collection].push(input[collection][0] as never);
    rejects(() => encodeRunTransferRows(input, repo));
  }
  mutate((w) => Object.assign(w.invocations[0] ?? {}, { stageOrdinal: 999 }));
  mutate((w) => Object.assign(w.invocations[0] ?? {}, { sessionId: "private" }));
  mutate((w) => Reflect.deleteProperty(w.questions[0] ?? {}, "answeredAt"));
  const input = fixture();
  Object.assign(input.invocations[0] ?? {}, { stageId: 999 });
  rejects(() => encodeRunTransferRows(input, repo));
});

test("Store-created and reloaded GitHub runs encode with undefined optional fields", () => {
  const store = new Store(":memory:");
  try {
    const storedRepo = store.upsertRepo(repo);
    const created = store.createRun(storedRepo, { repo: repo.slug, prompt: "Store request", source: "cli" });
    for (const run of [created, store.getRun(created.id)]) {
      if (!run) throw new Error("Expected stored run");
      expect(Object.hasOwn(run, "githubWait")).toBe(true);
      expect(run.githubWait).toBeUndefined();
      const wire = encodeRunTransferRows({ run, stages: [], invocations: [], questions: [] }, storedRepo);
      expect(wire.run).not.toHaveProperty("githubWait");
      expect(decodeRunTransferRows(wire, storedRepo)).toEqual(wire);
      expect(wire.run).toMatchObject({
        id: created.id,
        prompt: "Store request",
        createdAt: created.createdAt,
      });
    }
  } finally {
    store.close();
  }
});

test("declared undefined domain options are omitted without changing inputs or wire strictness", () => {
  const input = fixture();
  for (const key of [
    "models",
    "flow",
    "githubWait",
    "titleProvenance",
    "noBaselineCache",
    "allow",
  ] as const) {
    Object.assign(input.run, { [key]: undefined });
    const absent = structuredClone(input);
    delete absent.run[key];
    expect(encodeRunTransferRows(input, repo)).toEqual(encodeRunTransferRows(absent, repo));
    expect(Object.hasOwn(input.run, key)).toBe(true);
    const wire = encodeRunTransferRows(absent, repo);
    Object.assign(wire.run, { [key]: undefined });
    rejects(() => decodeRunTransferRows(wire, repo));
  }
  input.run.models = {
    triage: undefined,
    spec: undefined,
    holdout: undefined,
    implement: undefined,
    review: ["model"],
    verify: undefined,
  };
  input.run.titleProvenance = null;
  const wire = encodeRunTransferRows(input, repo);
  expect(wire.run.models).toEqual({ review: ["model"] });
  expect(wire.run.titleProvenance).toBeNull();
  expect(Object.hasOwn(input.run.models, "triage")).toBe(true);
  Object.assign(wire.run.models ?? {}, { triage: undefined });
  rejects(() => decodeRunTransferRows(wire, repo));
  Object.assign(input.run, { undeclared: undefined });
  rejects(() => encodeRunTransferRows(input, repo));
});

test.each(["stages", "invocations", "questions"] as const)(
  "%s containers must be arrays on both row boundaries",
  (collection) => {
    for (const value of [null, {}, "rows", 3]) {
      const input = fixture(),
        wire = encodeRunTransferRows(input, repo);
      Object.assign(input, { [collection]: value });
      Object.assign(wire, { [collection]: value });
      rejects(() => encodeRunTransferRows(input, repo));
      rejects(() => decodeRunTransferRows(wire, repo));
    }
  },
);

test("row dependency refusal precedes invalid fields and undeclared envelope members", () => {
  const input = fixture(),
    wire = encodeRunTransferRows(input, repo);
  for (const rows of [input, wire]) {
    rows.run.dependsOn = ["unresolved"];
    Object.assign(rows.stages[0] ?? {}, { name: "invalid" });
    Object.assign(rows, { undeclared: undefined });
  }
  rejects(() => encodeRunTransferRows(input, repo), "unsupported");
  rejects(() => decodeRunTransferRows(wire, repo), "unsupported");
});

test.each(["stages", "invocations", "questions"] as const)(
  "%s ordinals must be contiguous even with an existing stage reference",
  (collection) => {
    const wire = encodeRunTransferRows(fixture(), repo);
    Object.assign(wire[collection][1] ?? {}, { ordinal: 3 });
    if (collection === "stages") Object.assign(wire.invocations[1] ?? {}, { stageOrdinal: 3 });
    rejects(() => decodeRunTransferRows(wire, repo));
  },
);

test("empty row collections remain valid", () => {
  const input = { ...fixture(), stages: [], invocations: [], questions: [] };
  const wire = encodeRunTransferRows(input, repo);
  expect(decodeRunTransferRows(wire, repo)).toEqual(wire);
});
