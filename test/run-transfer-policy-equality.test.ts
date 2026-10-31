import { expect, test } from "bun:test";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import {
  encodeTransferPolicy,
  executableFieldsFromPolicy,
  parseTransferPolicy,
} from "../src/pipeline/run-transfer-policy-equality.ts";
import { parseTransferPolicyHistory } from "../src/pipeline/run-transfer-policy-schema.ts";
import { policyFixture, seal, source } from "./run-transfer-policy-support.ts";

const boundaries = [encodeTransferPolicy, parseTransferPolicy];
test.each([
  ["gatesConfig", { setup: [], checks: [], source: "none", protectedPaths: [] }],
  ["previewConfig", { paths: ["ui/"], build: "build", serve: "serve", ready: "ready", env: {} }],
  [
    "slottedCommands",
    [
      ["bun", "check"],
      ["bun", "test"],
    ],
  ],
  ["agentFullSuite", "slot"],
  ["baselineScripts", { test: "true" }],
  ["reviewLenses", []],
  ["shadowLenses", []],
  ["reviewMode", "panel"],
])("both transfer boundaries reject different %s despite matching identity", (key, value) => {
  const f = policyFixture();
  for (const boundary of boundaries) {
    expect(() => boundary(f.history, f.identity, { ...f.state, [String(key)]: value })).toThrow("conflict");
    const state: object = { ...f.state };
    if (key === "shadowLenses") Reflect.set(state, "shadowLenses", null);
    else Reflect.deleteProperty(state, String(key));
    expect(() => boundary(f.history, f.identity, state)).toThrow("conflict");
  }
});

test("canonical parity keeps object ordering insignificant and presence, none and null distinct", () => {
  const f = policyFixture();
  for (const boundary of boundaries) {
    expect(
      boundary(f.history.slice(0, 2), f.identity, {
        ...f.prepared.fields,
        baselineScripts: { lint: "biome check .", test: "bun test" },
      }),
    ).toEqual(f.prepared);
    for (const previewConfig of [undefined, "none", {}]) {
      const state: object = { ...f.state };
      if (previewConfig === undefined) Reflect.deleteProperty(state, "previewConfig");
      else Reflect.set(state, "previewConfig", previewConfig);
      expect(() => boundary(f.history, f.identity, state)).toThrow(RunTransferError);
    }
    expect(() =>
      boundary(f.history, f.identity, {
        ...f.state,
        gatesConfig: {
          ...f.state.gatesConfig,
          merge: null,
        },
      }),
    ).toThrow("conflict");
    expect(() => boundary(f.history, { ...f.identity, policyId: "other" }, f.state)).toThrow("conflict");
    expect(() =>
      boundary(
        f.history,
        {
          ...f.identity,
          repository: {
            ...f.identity.repository,
            defaultBranch: "other",
          },
        },
        f.state,
      ),
    ).toThrow("conflict");
  }
});

test("applicable lenses, shadow error records and non-applicable absence are preserved", () => {
  for (const [mode, shadow] of [
    ["single", "off"],
    ["single", "panel"],
    ["panel", "panel"],
  ] as const) {
    const f = policyFixture(mode, shadow);
    for (const boundary of boundaries) {
      expect(boundary(f.history, f.identity, f.state)).toEqual(f.refreshed);
      const field = mode === "panel" ? "reviewLenses" : "shadowLenses";
      expect(() => boundary(f.history, f.identity, { ...f.state, [field]: null })).toThrow("conflict");
      const fields: object = { ...f.prepared.fields };
      if (mode === "single" && shadow === "off") Reflect.set(fields, "reviewLenses", []);
      else Reflect.deleteProperty(fields, field);
      expect(() => boundary([f.provisional, seal({ ...f.prepared, fields })], f.identity, fields)).toThrow(
        RunTransferError,
      );
    }
  }
  const f = policyFixture("single", "panel");
  for (const shadowLenses of [[], [{ name: "safety", focus: "Review", profiles: ["standard" as const] }]]) {
    const prepared = seal({ ...f.prepared, fields: { ...f.prepared.fields, shadowLenses } });
    expect(parseTransferPolicy([f.provisional, prepared], f.identity, prepared.fields)).toEqual(prepared);
  }
});

test("only the selected version authorizes refreshed scripts and established mode", () => {
  const f = policyFixture(),
    original = structuredClone(f.history.slice(0, 3));
  expect(parseTransferPolicy(f.history, f.identity, f.state)).toEqual(f.refreshed);
  for (const boundary of boundaries) {
    expect(() => boundary(original, f.identity, f.state)).toThrow("conflict");
    expect(() =>
      boundary(f.history, f.identity, { ...f.state, baselineScripts: f.prepared.fields.baselineScripts }),
    ).toThrow("conflict");
    expect(() =>
      boundary(f.history.slice(0, 2), f.identity, { ...f.prepared.fields, reviewMode: "panel" }),
    ).toThrow("conflict");
  }
  const { scriptSource: _source, ...unbound } = f.refreshed;
  for (const successor of [
    seal(unbound),
    seal({ ...f.reviewed, fields: f.refreshed.fields }),
    seal({ ...f.refreshed, parent: { recordId: f.prepared.recordId, version: 3 } }),
    seal({ ...f.refreshed, kind: "review-finalized", scriptSource: source }),
  ])
    expect(() => parseTransferPolicyHistory([...original, successor])).toThrow(RunTransferError);
  expect(f.history.slice(0, 3)).toEqual(original);
  const preReviewRefresh = seal({
    ...f.prepared,
    kind: "scripts-refreshed",
    version: 3,
    parent: { recordId: f.prepared.recordId, version: 2 },
    scriptSource: source,
    fields: f.refreshed.fields,
  });
  expect(parseTransferPolicyHistory([f.provisional, f.prepared, preReviewRefresh])).toHaveLength(3);
  const laterReview = seal({
    ...preReviewRefresh,
    kind: "review-finalized",
    version: 4,
    effectiveReviewMode: "single",
    parent: { recordId: preReviewRefresh.recordId, version: 3 },
  });
  expect(parseTransferPolicyHistory([f.provisional, f.prepared, preReviewRefresh, laterReview])).toHaveLength(
    4,
  );
});

test("executable configuration comes from the pin, with no destination defaults", () => {
  const f = policyFixture();
  const adopter = { gatesConfig: { checks: [] }, reviewMode: "panel", baselineScripts: { test: "true" } };
  const result = executableFieldsFromPolicy(f.history, f.identity, { ...f.state, adopter });
  expect(result).toEqual({
    gatesConfig: {
      setup: ["bun install"],
      checks: [{ name: "test", run: "bun test", timeoutSec: 60 }],
      source: ".limitless.toml",
      protectedPaths: ["fixtures/**"],
      merge: "none",
    },
    previewConfig: null,
    slottedCommands: [
      ["bun", "test"],
      ["bun", "check"],
    ],
    agentFullSuite: "gate",
    baselineScripts: { test: "bun test --coverage" },
    reviewLenses: [{ name: "trust", focus: "Check boundaries", profiles: ["deep"] }],
    reviewMode: "single",
  });
  expect(result.gatesConfig).not.toBe(f.state.gatesConfig);
  for (const history of [undefined, null, [], [f.prepared]])
    expect(() => executableFieldsFromPolicy(history, f.identity, f.state)).toThrow(RunTransferError);
  expect(() => executableFieldsFromPolicy([f.provisional], f.identity, {})).toThrow("incomplete");
  expect(() => executableFieldsFromPolicy(f.history, f.identity, { ...f.state, ...adopter })).toThrow(
    "conflict",
  );
  for (const boundary of boundaries) {
    expect(boundary([f.provisional], f.identity, {})).toEqual(f.provisional);
    expect(() => boundary([f.provisional], f.identity, f.prepared.fields)).toThrow("conflict");
    expect(() => boundary(undefined, f.identity, {})).toThrow("missing");
  }
});
