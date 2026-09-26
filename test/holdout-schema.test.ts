import { expect, test } from "bun:test";
import { HoldoutSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";

const scenarios = Array.from({ length: 3 }, (_, i) => ({
  id: `H-${i + 1}`,
  description: `Case ${i + 1}`,
  steps: `run case-${i + 1}`,
  expected: "exit zero",
  edge_case: i > 0,
}));

test("holdout schema accepts 3–8 sequential scenarios with two edge cases", () => {
  expect(HoldoutSchema.safeParse({ scenarios }).success).toBe(true);
  expect(
    HoldoutSchema.safeParse({
      scenarios: Array.from({ length: 8 }, (_, i) => ({ ...scenarios[i % 3], id: `H-${i + 1}` })),
    }).success,
  ).toBe(true);
  const json = toStrictJsonSchema(HoldoutSchema);
  expect(json).toHaveProperty("properties.scenarios");
});

test("holdout schema rejects length, IDs, missing fields, and insufficient edge cases", () => {
  for (const bad of [
    scenarios.slice(0, 2),
    Array.from({ length: 9 }, (_, i) => ({ ...scenarios[i % 3], id: `H-${i + 1}` })),
    [scenarios[0], { ...scenarios[1], id: "H-1" }, scenarios[2]],
    [scenarios[0], { id: "H-2", description: "x", expected: "y", edge_case: true }, scenarios[2]],
    scenarios.map((s) => ({ ...s, edge_case: false })),
  ])
    expect(HoldoutSchema.safeParse({ scenarios: bad }).success).toBe(false);
});
