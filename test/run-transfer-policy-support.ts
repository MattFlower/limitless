import type { z } from "zod";
import {
  type transferAdmissionPolicySchema,
  transferPolicyRecordId,
  type transferPreparedPolicySchema,
} from "../src/pipeline/run-transfer-policy-schema.ts";

export const base = "a".repeat(40),
  source = "b".repeat(40);
export const seal = <T extends object>(value: T) => ({ ...value, recordId: transferPolicyRecordId(value) });
export function policyFixture(mode: "single" | "panel" = "panel", shadow: "off" | "panel" = "off") {
  const engine: z.infer<typeof transferAdmissionPolicySchema> = {
    maxRounds: 3,
    waitBudgetS: { implement: 42 },
    dependabotRouting: "policy",
    triageDecisionConfidence: 0.8,
    reviewMode: mode,
    reviewShadow: shadow,
    reviewShadowGraceSeconds: 30,
    reviewImplementerReport: "omit",
    reviewAvoidImplementerVendor: true,
    reviewRosters: {
      quick: [],
      standard: [{ prompt: "careful", target: "historical-id", family: "cross" }],
      deep: [],
    },
    reviewTrustedReviewers: ["reviewer"],
  };
  const provisional = seal({
    formatVersion: 1 as const,
    policyId: "policy-a",
    version: 1,
    parent: null,
    kind: "provisional" as const,
    trustedBase: null,
    repository: {
      slug: "example/project",
      kind: "github" as const,
      defaultBranch: "main",
      mergePolicy: "none" as const,
      profile: JSON.parse('{"private":{"values":[null,false,1]},"constructor":{"inert":true}}') as Record<
        string,
        unknown
      >,
    },
    settings: { discreet: false, branchPrefix: "change/", landRequiresApproval: true },
    engine,
  });
  const fields: z.infer<typeof transferPreparedPolicySchema> = {
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
    baselineScripts: { test: "bun test", lint: "biome check ." },
    ...(mode === "panel"
      ? { reviewLenses: [{ name: "trust", focus: "Check boundaries", profiles: ["deep" as const] }] }
      : shadow === "panel"
        ? { shadowLenses: { error: "Invalid lens table" } }
        : {}),
  };
  const prepared = seal({
    ...provisional,
    kind: "prepared" as const,
    version: 2,
    parent: { recordId: provisional.recordId, version: 1 },
    trustedBase: base,
    scriptSource: base,
    fields,
  });
  const reviewed = seal({
    ...prepared,
    kind: "review-finalized" as const,
    version: 3,
    parent: { recordId: prepared.recordId, version: 2 },
    effectiveReviewMode: "single" as const,
  });
  const refreshed = seal({
    ...reviewed,
    kind: "scripts-refreshed" as const,
    version: 4,
    parent: { recordId: reviewed.recordId, version: 3 },
    scriptSource: source,
    fields: { ...fields, baselineScripts: { test: "bun test --coverage" } },
  });
  return {
    provisional,
    prepared,
    reviewed,
    refreshed,
    history: [provisional, prepared, reviewed, refreshed],
    identity: { policyId: "policy-a", repository: provisional.repository },
    state: { ...fields, baselineScripts: { test: "bun test --coverage" }, reviewMode: "single" },
  };
}
