import { expect, spyOn, test } from "bun:test";
import type { GateResult } from "../src/gates/run.ts";
import {
  attributionReason,
  fieldPrivacySchema,
  gateIdentities,
  IDENTITY_CAP,
  remoteGateData,
  textPrivacySchema,
  withheldText,
} from "../src/gates/text-privacy.ts";
import { resultSchema } from "../src/pipeline/agent-gate.ts";
import { transferGateResultSchema } from "../src/pipeline/run-transfer-gates.ts";
import { Check } from "../src/workers/protocol.ts";

const privacy = {
  output: { withheld: false, checkedComplete: true, kind: "complete" as const, mac: "a".repeat(64) },
  identities: { withheld: true, reason: "identity-cap" },
};
const result = (): GateResult => ({
  name: "test",
  command: "bun test",
  executedCommand: "bun test a.test.ts",
  ok: true,
  exitCode: 0,
  durationMs: 1,
  output: "passed",
  textPrivacy: privacy,
  failedFiles: ["b.test.ts"],
  failedFileTimes: Object.fromEntries([
    ["constructor", 3],
    ["__proto__", 4],
    ["b.test.ts", 2],
    ["a.test.ts", 1],
  ]),
  testCoverage: {
    passedFiles: ["a.test.ts"],
    skippedFiles: ["b.test.ts"],
    skippedTests: [{ name: "test name", file: "b.test.ts", line: 2 }],
  },
  coveringTest: { name: "test name", file: "a.test.ts" },
  coveringTests: [{ name: "another", file: "b.test.ts" }],
});
test("withheld markers are stable and only contain validated reasons", () => {
  expect(withheldText("credential-changed")).toBe("[withheld: credential-changed]");
  expect(withheldText("credential-changed")).toBe(withheldText("credential-changed"));
  for (const reason of [
    "Uppercase",
    "x".repeat(41),
    "two words",
    "private text",
    "credential-changed\n",
    undefined,
    "",
  ])
    expect(withheldText(reason)).toBe("[withheld: unproven]");
  expect(withheldText("checker-timeout", true)).toBe("[withheld: checker-timeout; timed out]");
  expect(
    fieldPrivacySchema.safeParse({ withheld: true, reason: "private-match", mac: "forged" }).success,
  ).toBe(false);
});
test("strict readers retain privacy records and recursive attempts; worker rejects remote claims", () => {
  const r = result();
  for (const schema of [Check, transferGateResultSchema, resultSchema]) {
    const parsed = schema.parse({ ...r, firstAttempt: r, targetedRetry: r, retryAttempt: r });
    for (const item of [parsed, parsed.firstAttempt, parsed.targetedRetry, parsed.retryAttempt]) {
      expect(item?.textPrivacy).toEqual(privacy);
      if (!item) throw new Error("Missing attempt");
      expect(gateIdentities(item)).toBe(gateIdentities(r));
    }
  }
  expect(Check.safeParse({ ...r, remoteAttestation: privacy }).success).toBe(false);
  expect(
    Check.safeParse({ ...r, textPrivacy: { output: { withheld: false, extra: "unknown" } } }).success,
  ).toBe(false);
  expect(textPrivacySchema.safeParse({ ...privacy, extra: "unknown" }).success).toBe(false);
  for (const schema of [transferGateResultSchema, resultSchema]) {
    const nested = { ...r, remoteAttestation: privacy };
    const parsed = schema.parse({
      ...nested,
      firstAttempt: nested,
      targetedRetry: nested,
      retryAttempt: nested,
    });
    for (const item of [parsed, parsed.firstAttempt, parsed.targetedRetry, parsed.retryAttempt])
      expect(item?.remoteAttestation).toEqual(privacy);
  }
});
test("identity bytes are stable under object insertion order, but bind every identity", () => {
  const r = result(),
    bytes = gateIdentities(r);
  expect(
    gateIdentities({
      ...r,
      failedFileTimes: Object.fromEntries(Object.entries(r.failedFileTimes ?? {}).reverse()),
      coveringTest: { file: "a.test.ts", name: "test name" },
    }),
  ).toBe(bytes);
  for (const change of [
    { command: "other" },
    { executedCommand: "other" },
    { failedFiles: ["other"] },
    { failedFileTimes: { "other.test.ts": 1 } },
    { coveringTest: { file: "other", name: "other" } },
    { coveringTests: [{ file: "other", name: "other" }] },
    ...["passedFiles", "skippedFiles", "skippedTests"].map((key) => ({
      testCoverage: {
        ...r.testCoverage,
        passedFiles: [],
        skippedFiles: [],
        [key]: key === "skippedTests" ? [{ file: "other", name: "other" }] : ["other"],
      },
    })),
  ])
    expect(gateIdentities({ ...r, ...change })).not.toBe(bytes);
});
test("oversized identities are refused before serialization", () => {
  const r = { ...result(), command: "x".repeat(IDENTITY_CAP + 1) };
  const stringify = spyOn(JSON, "stringify");
  try {
    expect(gateIdentities(r)).toBe("identity-cap");
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
  const empty: GateResult = {
    name: "test",
    command: "x".repeat(IDENTITY_CAP),
    ok: true,
    exitCode: 0,
    durationMs: 0,
    output: "",
  };
  expect(gateIdentities(empty)).not.toBe("identity-cap");
});

test("attribution grammar accepts whole fixed parts and counted forms only", () => {
  const fixed = [
    "Unknown testcase evidence",
    "Cross-file testcase failure",
    "Ambiguous testcase",
    "Unattributed testcase",
    "Unknown suite evidence",
    "Unmatched JUnit counter",
    "Invalid JUnit evidence",
    "runner reported an error, bail, or invalid/duplicate summary",
    "runner summary missing or inconsistent with JUnit",
    "unrecognized attribution reason",
  ];
  const counted = [
    "1 unattributed failure",
    "3 unattributed errors",
    "2 unattributed failures",
    "1 unattributed error",
  ];
  for (const reason of [...fixed, ...counted, fixed.join("; "), `${counted[0]}; ${fixed[2]}`])
    expect(attributionReason(reason)).toBe(reason);
  for (const reason of [
    "leak",
    "",
    "Ambiguous testcase; secret-token",
    "Ambiguous testcase secret-token",
    "prefix Ambiguous testcase",
    "Ambiguous testcase;Unattributed testcase",
    "Ambiguous testcase;  Unattributed testcase",
    "Ambiguous testcase; ",
    "; Ambiguous testcase",
    "Ambiguous testcase\n",
    "1 unattributed error: secret",
    "x1 unattributed error",
    "1 unattributed warnings",
    "ambiguous testcase",
    undefined,
    42,
  ])
    expect(attributionReason(reason)).toBe("unrecognized attribution reason");
});
test("worker ingress keeps claims as MAC-free attestations, recursively, and fixes reasons", () => {
  const claim = { withheld: false, checkedComplete: true, kind: "complete" as const, mac: "b".repeat(64) },
    attested = { withheld: false, checkedComplete: true, kind: "complete" as const };
  const worker: GateResult = {
    ...result(),
    textPrivacy: { output: claim, identities: { withheld: true, reason: "identity-cap" } },
    failureAttributionReason: "Ambiguous testcase; secret-token",
  };
  const nested = { ...worker, failureAttributionReason: "2 unattributed errors" };
  const stored = remoteGateData({
    ...worker,
    firstAttempt: nested,
    targetedRetry: nested,
    retryAttempt: worker,
  });
  expect(JSON.stringify(stored)).not.toContain("b".repeat(64));
  for (const item of [stored, stored.firstAttempt, stored.targetedRetry, stored.retryAttempt]) {
    expect(item).not.toHaveProperty("textPrivacy");
    expect(item?.remoteAttestation).toEqual({
      output: attested,
      identities: { withheld: true, reason: "identity-cap" },
    });
  }
  expect(stored.failureAttributionReason).toBe("unrecognized attribution reason");
  expect(stored.retryAttempt?.failureAttributionReason).toBe("unrecognized attribution reason");
  expect(stored.firstAttempt?.failureAttributionReason).toBe("2 unattributed errors");
  expect(remoteGateData({ ...result(), textPrivacy: undefined })).not.toHaveProperty(
    "failureAttributionReason",
  );
  expect(worker.textPrivacy?.output.mac).toBe("b".repeat(64));
});

test.each([
  { withheld: true, reason: "private-match" },
  { withheld: false, checkedComplete: true, kind: "complete" as const, truncated: true, mac: "c".repeat(64) },
])("excerpt records pass every strict reader and stay out of worker claims: %p", (failures) => {
  const r = { ...result(), textPrivacy: { ...privacy, failures } };
  expect(textPrivacySchema.parse(r.textPrivacy).failures).toEqual(failures);
  for (const schema of [Check, transferGateResultSchema, resultSchema]) {
    expect(schema.parse(r).textPrivacy?.failures).toEqual(failures);
    expect(schema.safeParse({ ...r, textPrivacy: { ...r.textPrivacy, unknown: true } }).success).toBe(false);
  }
  expect(JSON.stringify(remoteGateData(r))).toBe(JSON.stringify(remoteGateData(result())));
});
