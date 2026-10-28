import { expect, test } from "bun:test";
import type { z } from "zod";
import { ChatOutputSchema } from "../src/concierge.ts";
import {
  AcceptanceSchema,
  AttributionVerifierSchema,
  ChecklistReviewSchema,
  HoldoutSchema,
  LaterChecklistReviewSchema,
  LaterReviewSchema,
  ReviewSchema,
  SpecSchema,
  TriageSchema,
  toStrictJsonSchema,
  VerifierSchema,
  VerifySchema,
} from "../src/pipeline/schemas.ts";

/** Paths of object properties missing from their `required` list, which OpenAI strict mode refuses. */
function notRequired(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => notRequired(item, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key !== "properties" || !value || typeof value !== "object") {
      out.push(...notRequired(value, `${path}.${key}`));
      continue;
    }
    const required = new Set((node as { required?: unknown }).required as string[] | undefined);
    for (const [name, property] of Object.entries(value)) {
      if (!required.has(name)) out.push(`${path}.${name}`);
      out.push(...notRequired(property, `${path}.${name}`));
    }
  }
  return out;
}

// Every schema the factory sends as a model's structured-output format.
const modelSchemas: Record<string, z.ZodType> = {
  AcceptanceSchema,
  TriageSchema,
  SpecSchema,
  HoldoutSchema,
  ReviewSchema,
  LaterReviewSchema,
  ChecklistReviewSchema,
  LaterChecklistReviewSchema,
  VerifierSchema,
  AttributionVerifierSchema,
  VerifySchema,
  ChatOutputSchema,
};

test.each(Object.entries(modelSchemas))(
  "%s requires every property in its strict JSON schema",
  (_name, schema) => {
    expect(notRequired(toStrictJsonSchema(schema))).toEqual([]);
  },
);

test("a verify criterion without a blocked reason still parses, as null", () => {
  const parsed = VerifySchema.parse({
    criteria: [{ id: "AC-1", status: "met", evidence: "bun test → 1 pass", publicSummary: "" }],
    overall: "pass",
    notes: "",
  });
  expect(parsed.criteria[0]?.blockedReason).toBeNull();
});

test("acceptance output rejects model-supplied classes and invented evidence fields", () => {
  const item = {
    unit: "U1",
    verdict: "met" as const,
    files: [{ path: "README.md" }],
    tests: [{ file: "test/behaviour.test.ts", name: "fulfils requirement" }],
    note: "verified by gate run 12",
  };
  expect(AcceptanceSchema.parse({ items: [item] }).items[0]).toEqual({
    ...item,
    files: [{ path: "README.md", lines: null }],
  });
  for (const extra of [
    { class: "docs" },
    { files: [{ path: "README.md", verified: true }] },
    { files: [{ path: "README.md", lines: { start: 1, end: 2, verified: true } }] },
    { tests: [{ ...item.tests[0], stageId: 12 }] },
  ])
    expect(AcceptanceSchema.safeParse({ items: [{ ...item, ...extra }] }).success).toBe(false);
  expect(AcceptanceSchema.safeParse({ items: [item], passed: true }).success).toBe(false);
});

test.each(["met", "partly_met", "unmet", "regressed", "manual"])(
  "acceptance schema supports the %s reader verdict",
  (verdict) => {
    expect(
      AcceptanceSchema.safeParse({
        items: [{ unit: "U2", verdict, files: [], tests: [], note: "" }],
      }).success,
    ).toBe(true);
  },
);

test.each([
  { unit: "AC-1" },
  { unit: "U0" },
  { unit: "U01" },
  { verdict: "not_assessed" },
  { files: [{ path: "README.md", lines: { start: 0, end: 1 } }] },
  { files: [{ path: "README.md", lines: { start: 1, end: 1.5 } }] },
])("acceptance schema rejects invalid identities, verdicts and line coordinates: %j", (invalid) => {
  expect(
    AcceptanceSchema.safeParse({
      items: [{ unit: "U1", verdict: "met", files: [], tests: [], note: "", ...invalid }],
    }).success,
  ).toBe(false);
});
