import { expect, test } from "bun:test";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { executableFieldsFromPolicy } from "../src/pipeline/run-transfer-policy-equality.ts";
import {
  parseTransferPolicyHistory,
  parseTransferPolicyRecord,
  policyCommitDependencies,
  transferAdmissionPolicySchema,
} from "../src/pipeline/run-transfer-policy-schema.ts";
import { registerCredential } from "../src/util/proc.ts";
import { base, policyFixture, seal, source } from "./run-transfer-policy-support.ts";

test("lifecycle records validate independently and retain immutable admission history", () => {
  const f = policyFixture();
  for (const record of f.history) expect(parseTransferPolicyRecord(record)).toEqual(record);
  expect(parseTransferPolicyHistory(f.history)).toEqual(f.history);
  expect(f.provisional.trustedBase).toBeNull();
  expect(f.reviewed.engine.reviewMode).toBe("panel");
  expect(f.reviewed.effectiveReviewMode).toBe("single");
  expect(f.prepared).not.toHaveProperty("effectiveReviewMode");
  expect(parseTransferPolicyRecord(f.provisional).repository.profile).toEqual({
    private: { values: [null, false, 1] },
    constructor: { inert: true },
  });
  expect(policyCommitDependencies([f.provisional])).toEqual([]);
  expect(policyCommitDependencies(f.history.slice(0, 2))).toEqual([base]);
  expect(policyCommitDependencies(f.history.slice(0, 3))).toEqual([base]);
  expect(policyCommitDependencies(f.history)).toEqual([base, source]);
});

test("malformed records and parent transitions fail closed", () => {
  const f = policyFixture();
  for (const record of [
    { ...f.provisional, trustedBase: base },
    { ...f.provisional, fields: f.prepared.fields },
    { ...f.prepared, trustedBase: null },
    { ...f.prepared, scriptSource: source },
    { ...f.prepared, parent: null },
    { ...f.reviewed, parent: { recordId: base, version: 1 } },
    { ...f.reviewed, effectiveReviewMode: null },
    { ...f.prepared, formatVersion: 2 },
    { ...f.reviewed, version: 2 },
    { ...f.refreshed, scriptSource: null },
  ])
    expect(() => parseTransferPolicyRecord(seal(record))).toThrow(RunTransferError);
  expect(() => parseTransferPolicyRecord({ ...f.refreshed, fields: f.prepared.fields })).toThrow("corrupt");
  for (const history of [
    [f.prepared],
    [f.provisional, f.reviewed],
    [f.provisional, f.prepared, f.prepared],
    [...f.history.slice(0, 3), seal({ ...f.refreshed, trustedBase: source })],
    [...f.history.slice(0, 3), seal({ ...f.refreshed, effectiveReviewMode: "panel" })],
    [...f.history.slice(0, 3), seal({ ...f.refreshed, engine: { ...f.refreshed.engine, maxRounds: 1 } })],
    [...f.history.slice(0, 2), seal({ ...f.reviewed, fields: f.refreshed.fields })],
  ])
    expect(() => parseTransferPolicyHistory(history)).toThrow(RunTransferError);
});

test("strict portable members exclude whole configuration and machine bindings", () => {
  const { prepared } = policyFixture();
  for (const record of [
    { ...prepared, raw: {} },
    { ...prepared, config: { server: "example.com" } },
    { ...prepared, engine: { ...prepared.engine, endpoints: [] } },
    {
      ...prepared,
      engine: {
        ...prepared.engine,
        reviewRosters: {
          quick: [],
          standard: [],
          deep: [{ prompt: "standard", target: { provider: "fake" } }],
        },
      },
    },
    { ...prepared, repository: { ...prepared.repository, localPath: "/machine/repo" } },
    { ...prepared, settings: { ...prepared.settings, toolPath: "/machine/bin" } },
    { ...prepared, fields: { ...prepared.fields, gatesConfig: { ...prepared.fields.gatesConfig, raw: {} } } },
    { ...prepared, repository: { ...prepared.repository, profile: [] } },
  ])
    expect(() => parseTransferPolicyRecord(seal(record))).toThrow(RunTransferError);
});

test("portable profiles stay inert and admission policy never supplies defaults", () => {
  const f = policyFixture();
  let invoked = false;
  const active = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      invoked = true;
      return "value";
    },
  });
  for (const profile of [active, new Date(0), { hidden: undefined }, { value: () => "value" }])
    expect(() =>
      parseTransferPolicyRecord({ ...f.provisional, repository: { ...f.provisional.repository, profile } }),
    ).toThrow(RunTransferError);
  expect(invoked).toBe(false);
  for (const engine of [
    {},
    { ...f.provisional.engine, maxRounds: "3" },
    { ...f.provisional.engine, waitBudgetS: { implement: null } },
    { ...f.provisional.engine, triageDecisionConfidence: 1.1 },
    { ...f.provisional.engine, reviewMode: null },
  ])
    expect(() => parseTransferPolicyRecord(seal({ ...f.provisional, engine }))).toThrow(RunTransferError);
});

test("shadow grace preserves finite non-negative fractions without coercion", () => {
  const { provisional } = policyFixture();
  const record = seal({
    ...provisional,
    engine: { ...provisional.engine, reviewShadowGraceSeconds: 0.5 },
  });
  const decoded = JSON.parse(new TextDecoder().decode(encodeTransferJson(record)));
  expect(parseTransferPolicyRecord(decoded).engine.reviewShadowGraceSeconds).toBe(0.5);
  for (const value of [0, 0.5])
    expect(
      transferAdmissionPolicySchema.parse({ ...provisional.engine, reviewShadowGraceSeconds: value })
        .reviewShadowGraceSeconds,
    ).toBe(value);
  for (const value of [-0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.5"])
    expect(
      transferAdmissionPolicySchema.safeParse({ ...provisional.engine, reviewShadowGraceSeconds: value })
        .success,
    ).toBe(false);
});

test("credential-bearing commands and identities reject unchanged with fixed diagnostics", () => {
  const credential = ["synthetic", "policy", "credential", "12345678"].join("-");
  registerCredential("TEST_PORTABLE_POLICY", credential);
  const { prepared } = policyFixture();
  for (const record of [
    { ...prepared, policyId: credential },
    { ...prepared, repository: { ...prepared.repository, slug: `example/${credential}` } },
    { ...prepared, fields: { ...prepared.fields, baselineScripts: { test: `echo ${credential}` } } },
    {
      ...prepared,
      fields: {
        ...prepared.fields,
        gatesConfig: { ...prepared.fields.gatesConfig, setup: [`echo ${credential}`] },
      },
    },
  ]) {
    const input = seal(record),
      original = JSON.stringify(input);
    expect(() => parseTransferPolicyRecord(input)).toThrow("Run transfer data is invalid");
    expect(JSON.stringify(input)).toBe(original);
    try {
      parseTransferPolicyRecord(input);
    } catch (e) {
      expect(String(e)).not.toContain(credential);
    }
  }
});

test.each([["s3", "cr3t!"].join(""), ["s3", '"c\\t!'].join("")])(
  "short credentials in decoded policy strings and keys reject unchanged",
  (credential) => {
    registerCredential("TEST_SHORT_PORTABLE_POLICY", credential);
    const { provisional: admission, prepared } = policyFixture();
    expect(parseTransferPolicyRecord(prepared)).toEqual(prepared);
    expect(
      executableFieldsFromPolicy(
        [admission, prepared],
        {
          policyId: prepared.policyId,
          repository: prepared.repository,
        },
        prepared.fields,
      ).baselineScripts,
    ).toEqual({ test: "bun test", lint: "biome check ." });
    for (const record of [
      { ...prepared, policyId: credential },
      { ...prepared, repository: { ...prepared.repository, slug: credential } },
      { ...prepared, fields: { ...prepared.fields, slottedCommands: [[credential]] } },
      { ...prepared, fields: { ...prepared.fields, baselineScripts: { test: credential } } },
      { ...prepared, fields: { ...prepared.fields, baselineScripts: { [credential]: "bun test" } } },
      { ...prepared, repository: { ...prepared.repository, slug: `example/${credential}/project` } },
      { ...prepared, fields: { ...prepared.fields, slottedCommands: [["sh", "-c", `echo ${credential}`]] } },
      { ...prepared, fields: { ...prepared.fields, baselineScripts: { test: `echo ${credential}` } } },
      {
        ...prepared,
        fields: { ...prepared.fields, baselineScripts: { [`test-${credential}`]: "bun test" } },
      },
      {
        ...prepared,
        fields: {
          ...prepared.fields,
          gatesConfig: {
            ...prepared.fields.gatesConfig,
            checks: [{ name: "test", run: `echo ${credential}` }],
          },
        },
      },
      {
        ...prepared,
        fields: {
          ...prepared.fields,
          gatesConfig: { ...prepared.fields.gatesConfig, setup: [credential] },
        },
      },
      {
        ...prepared,
        repository: { ...prepared.repository, profile: { nested: { [credential]: true } } },
      },
    ]) {
      const provisional = seal({ ...admission, policyId: record.policyId, repository: record.repository });
      const input = seal({ ...record, parent: { recordId: provisional.recordId, version: 1 } });
      const history = [provisional, input];
      const identity = { policyId: input.policyId, repository: input.repository };
      const state = { ...input.fields };
      const original = JSON.stringify({ history, identity, state });
      for (const check of [
        () => parseTransferPolicyRecord(input),
        () => executableFieldsFromPolicy(history, identity, state),
      ]) {
        expect(check).toThrow("Run transfer data is invalid");
        expect(JSON.stringify({ history, identity, state })).toBe(original);
        try {
          check();
        } catch (error) {
          expect(String(error)).toBe("RunTransferError: Run transfer data is invalid");
          expect(String(error)).not.toContain(credential);
        }
      }
    }
  },
);
