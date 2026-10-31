import { createHash } from "node:crypto";
import { z } from "zod";
import { redactCredentials } from "../util/proc.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import { transferDictionary } from "./run-transfer-gates.ts";
import { encodeTransferJson, parseTransferJson } from "./run-transfer-json.ts";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject,
  text = z.string(),
  strings = z.array(text);
const mode = r.oneOf("single panel"),
  merge = r.oneOf("auto pr none");
const profile = r.oneOf("quick standard deep");
const lens = object({ name: text, focus: text });
const lenses = z.array(lens.extend({ profiles: z.array(profile) }));
const finder = object({
  target: text.optional(),
  prompt: r.oneOf(
    "standard adversarial careful probe trace adversarial-checklist adversarial-thorough adversarial-callers",
  ),
  lens: lens.optional(),
  family: r.oneOf("cross implementer").optional(),
  local: z.boolean().optional(),
});
export const transferAdmissionPolicySchema = object({
  maxRounds: r.counter,
  waitBudgetS: object(
    r.fields(
      "triage spec plan plan_review holdout implement review verify summarize chat",
      r.counter.optional(),
    ),
  ),
  dependabotRouting: r.oneOf("free_first policy"),
  triageDecisionConfidence: z.number().min(0).max(1),
  reviewMode: mode,
  reviewShadow: r.oneOf("off panel"),
  reviewShadowGraceSeconds: r.counter,
  reviewImplementerReport: r.oneOf("include omit"),
  reviewAvoidImplementerVendor: z.boolean(),
  reviewRosters: object(r.fields("quick standard deep", z.array(finder))),
  reviewTrustedReviewers: strings,
});
const repository = object({
  slug: r.identity,
  kind: r.oneOf("github local"),
  defaultBranch: r.identity,
  mergePolicy: merge,
  profile: z.custom<Record<string, unknown>>((v) => v !== null && typeof v === "object" && !Array.isArray(v)),
});
const settings = object({
  ...r.fields("shared githubActions githubActionsPaidMinutes", z.boolean().optional()),
  discreet: z.boolean(),
  branchPrefix: text,
  landRequiresApproval: z.boolean(),
});
const coveringTest = object({ file: text, name: text });
export const transferPreparedPolicySchema = object({
  gatesConfig: object({
    setup: strings,
    checks: z.array(
      object({
        name: text,
        run: text,
        timeoutSec: z.number().nonnegative().optional(),
        coveringTest: coveringTest.optional(),
        coveringTests: z.array(coveringTest).optional(),
      }),
    ),
    source: r.oneOf(".limitless.toml detected none"),
    protectedPaths: strings,
    retryFiles: text.optional(),
    docs: strings.optional(),
    merge: merge.optional(),
  }),
  previewConfig: object({
    paths: strings,
    build: text,
    serve: text,
    seed: text.optional(),
    ready: text,
    env: transferDictionary(text),
  }).nullable(),
  slottedCommands: z.array(strings),
  agentFullSuite: r.oneOf("slot refuse gate"),
  baselineScripts: transferDictionary(text),
  reviewLenses: lenses.optional(),
  shadowLenses: z.union([lenses, object({ error: text })]).optional(),
});
const common = {
  formatVersion: z.literal(1),
  recordId: text.regex(/^[0-9a-f]{64}$/),
  policyId: r.identity,
  version: r.ordinal,
  parent: object({ recordId: text.regex(/^[0-9a-f]{64}$/), version: r.ordinal }).nullable(),
  repository,
  settings,
  engine: transferAdmissionPolicySchema,
};
const prepared = {
  ...common,
  trustedBase: r.oid,
  scriptSource: r.oid,
  fields: transferPreparedPolicySchema,
};
export const transferPolicyRecordSchema = z.union([
  object({ ...common, kind: z.literal("provisional"), trustedBase: z.null() }),
  object({ ...prepared, kind: z.literal("prepared") }),
  object({ ...prepared, kind: z.literal("review-finalized"), effectiveReviewMode: mode }),
  object({ ...prepared, kind: z.literal("scripts-refreshed"), effectiveReviewMode: mode.optional() }),
]);
export type TransferPolicyRecord = z.infer<typeof transferPolicyRecordSchema>;
export const policyCanonical = (v: unknown): string => new TextDecoder().decode(encodeTransferJson(v));
// Short registered credentials match only whole decoded strings, not serialized JSON.
function rejectPolicyCredentials(value: unknown): void {
  if (typeof value === "string" && redactCredentials(value) !== value) throw new RunTransferError("invalid");
  if (Array.isArray(value)) value.forEach(rejectPolicyCredentials);
  else if (value && typeof value === "object")
    for (const [key, member] of Object.entries(value)) {
      rejectPolicyCredentials(key);
      rejectPolicyCredentials(member);
    }
}
// Content identity makes replacement under an unchanged record/version detectable.
export const transferPolicyRecordId = r.boundary((value: unknown): string => {
  parseTransferJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunTransferError("invalid");
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "recordId"));
  return createHash("sha256").update(encodeTransferJson(content)).digest("hex");
});
export const parseTransferPolicyRecord = r.boundary((value: unknown): TransferPolicyRecord => {
  const v = r.parseRecord(transferPolicyRecordSchema, value);
  rejectPolicyCredentials(value);
  if (v.recordId !== transferPolicyRecordId(value)) throw new RunTransferError("corrupt");
  if (v.kind === "provisional") {
    if (v.version !== 1 || v.parent !== null) throw new RunTransferError("invalid");
  } else {
    if (
      !v.parent ||
      v.parent.version !== v.version - 1 ||
      v.parent.recordId === v.recordId ||
      (v.kind === "prepared" ? v.version !== 2 || v.scriptSource !== v.trustedBase : v.version < 3)
    )
      throw new RunTransferError("invalid");
    if (
      Object.hasOwn(v.fields, "reviewLenses") !== (v.engine.reviewMode === "panel") ||
      Object.hasOwn(v.fields, "shadowLenses") !==
        (v.engine.reviewMode === "single" && v.engine.reviewShadow === "panel")
    )
      throw new RunTransferError("invalid");
  }
  return v;
});
// Histories are complete prefixes; selecting an older pin means supplying its prefix.
export const parseTransferPolicyHistory = r.boundary((value: unknown): TransferPolicyRecord[] => {
  parseTransferJson(value);
  if (!Array.isArray(value) || !value.length) throw new RunTransferError("missing");
  const records = value.map(parseTransferPolicyRecord);
  for (const [i, v] of records.entries()) {
    const p = records[i - 1];
    if (!p) {
      if (v.kind !== "provisional") throw new RunTransferError("incomplete");
      continue;
    }
    if (
      v.parent?.recordId !== p.recordId ||
      v.version !== p.version + 1 ||
      policyCanonical([v.policyId, v.repository, v.settings, v.engine]) !==
        policyCanonical([p.policyId, p.repository, p.settings, p.engine])
    )
      throw new RunTransferError("conflict");
    if (
      v.kind === "provisional" ||
      (p.kind === "provisional" ? v.kind !== "prepared" : v.kind === "prepared")
    )
      throw new RunTransferError("invalid");
    if (p.kind === "provisional") continue;
    const { baselineScripts: _old, ...oldFields } = p.fields;
    const { baselineScripts: _new, ...newFields } = v.fields;
    const oldMode = "effectiveReviewMode" in p ? p.effectiveReviewMode : undefined;
    const newMode = "effectiveReviewMode" in v ? v.effectiveReviewMode : undefined;
    if (
      v.trustedBase !== p.trustedBase ||
      policyCanonical(oldFields) !== policyCanonical(newFields) ||
      (v.kind === "review-finalized"
        ? oldMode !== undefined ||
          v.scriptSource !== p.scriptSource ||
          policyCanonical(v.fields) !== policyCanonical(p.fields)
        : newMode !== oldMode)
    )
      throw new RunTransferError("conflict");
  }
  return records;
});
export const policyCommitDependencies = r.boundary((value: unknown): string[] => {
  const records = parseTransferPolicyHistory(value);
  return [
    ...new Set(records.flatMap((v) => (v.kind === "provisional" ? [] : [v.trustedBase, v.scriptSource]))),
  ];
});
