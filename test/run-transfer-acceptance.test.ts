import { expect, test } from "bun:test";
import * as a from "../src/pipeline/run-transfer-acceptance.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { head, rejects, sha } from "./run-transfer-support.ts";

const issue = { number: 123, body: "#123 request", author: null };
const snapshot = {
  ticket: issue,
  parent: {
    ...issue,
    number: 1,
    author: { login: "author" },
    editor: null,
    lastEditedAt: null,
    userContentEdits: { nodes: [{ editor: { login: "editor" } }], pageInfo: { hasNextPage: false } },
  },
};
const progress = {
  snapshot,
  sha,
  manifest: [{ id: "U1", text: " observed ", class: "behaviour", sources: ["#123"] }],
  setupDone: true,
};
const complete = {
  ...progress,
  output: {
    items: [{ unit: "U1", verdict: "manual", files: [{ path: "a.ts" }], tests: [], note: ` ${sha} #123 ` }],
  },
  outcome: {
    sha: head,
    units: [
      {
        unit: "U1",
        verdict: "not_assessed",
        citations: [`${"c".repeat(40)} #123 stageId 900`],
        refusals: ["#900"],
      },
    ],
    summary: " historical ",
    passed: true,
  },
};
const json = (value: unknown) => JSON.parse(new TextDecoder().decode(encodeTransferJson(value)));

test("acceptance preserves snapshot, setup progress and complete historical outcomes", () => {
  for (const acceptance of [{ snapshot }, progress, complete]) {
    const input = { acceptance };
    expect<unknown>(a.parseTransferAcceptance(json(a.parseTransferAcceptance(input)))).toEqual(input);
    expect<unknown>(encodeTransferJson(a.parseTransferAcceptance(input))).toEqual(encodeTransferJson(input));
  }
  expect<unknown>(
    a.acceptanceCommitDependencies(a.parseTransferAcceptance({ acceptance: complete })),
  ).toEqual([sha, head]);
  expect<unknown>(
    a.acceptanceCommitDependencies(a.parseTransferAcceptance({ acceptance: { snapshot } })),
  ).toEqual([]);
  expect<unknown>(a.parseTransferAcceptance({})).toEqual({});
});

test("acceptance validates every factory wrapper and stored output without filling lines or note", () => {
  for (const acceptance of [
    { ...complete, extra: true },
    { ...complete, sha: "bad" },
    { ...complete, snapshot: { ...snapshot, extra: true } },
    { ...complete, snapshot: { ...snapshot, ticket: { ...issue, author: { login: "x", extra: true } } } },
    { ...complete, manifest: [{ id: "U1", text: "x", class: "code", sources: [] }] },
    {
      ...complete,
      output: {
        items: [{ ...complete.output.items[0], files: [{ path: "a.ts", lines: { start: 0, end: 1 } }] }],
      },
    },
    {
      ...complete,
      outcome: {
        ...complete.outcome,
        units: [{ unit: "U1", verdict: "approved", citations: [], refusals: [] }],
      },
    },
  ])
    rejects(() => a.parseTransferAcceptance({ acceptance }));
  rejects(() => a.parseTransferAcceptance({ acceptance: { snapshot, setupDone: undefined } }));
});

test("completed checks validate gates, audits and historical later reviews with typed dependencies", () => {
  const result = {
    name: "test",
    command: sha,
    ok: false,
    exitCode: null,
    durationMs: 0,
    output: sha,
    executionProvenance: { sha: head },
  };
  const comparison = {
    name: "test",
    verdict: "flaky",
    blocking: false,
    result,
    firstAttempt: { ...result, executionProvenance: { sha } },
  };
  const review = { verdict: "approve", summary: "Fixes checked; clear.", findings: [] };
  const values = {
    gates: [comparison],
    audit: [{ rule: "audit", severity: "warn", file: "a.ts", detail: " historical " }],
    review,
  };
  for (const value of [values, { gates: values.gates }, { audit: values.audit }, { review }]) {
    const input = { completedChecks: { round: 2, sha, values: value } };
    expect<unknown>(a.parseTransferCompletedChecks(json(a.parseTransferCompletedChecks(input)))).toEqual(
      input,
    );
  }
  expect<unknown>(
    a.completedChecksCommitDependencies(
      a.parseTransferCompletedChecks({ completedChecks: { round: 2, sha, values } }),
    ),
  ).toEqual([sha, head, sha]);
  expect<unknown>(a.parseTransferCompletedChecks({ completedChecks: { round: 0, values: {} } })).toEqual({
    completedChecks: { round: 0, values: {} },
  });
  expect<unknown>(a.parseTransferCompletedChecks({})).toEqual({});
});

test("unsupported completed stages reject distinctly from malformed supported results", () => {
  for (const values of [{ verify: {} }, { constructor: {} }, { review: {}, preview: [] }])
    rejects(() => a.parseTransferCompletedChecks({ completedChecks: { round: 1, values } }), "unsupported");
  for (const values of [
    { audit: [{ rule: "x" }] },
    { gates: "ok" },
    { review: { summary: "x", findings: [] } },
    null,
    [],
  ])
    rejects(() => a.parseTransferCompletedChecks({ completedChecks: { round: 1, values } }));
  rejects(() => a.parseTransferCompletedChecks({ completedChecks: { round: 1, sha: "bad", values: {} } }));
  rejects(() => a.parseTransferCompletedChecks({ completedChecks: { round: 1, values: {}, extra: true } }));
});
