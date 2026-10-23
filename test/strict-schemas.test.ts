import { expect, test } from "bun:test";
import type { z } from "zod";
import { ChatOutputSchema } from "../src/concierge.ts";
import {
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
