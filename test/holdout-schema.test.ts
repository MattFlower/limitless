import { expect, test } from "bun:test";
import { HoldoutSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";

const scenarios = Array.from({ length: 3 }, (_, i) => ({
  id: `H-${i + 1}`,
  description: `Case ${i + 1}`,
  steps: `run case-${i + 1}`,
  expected: "exit zero",
  edge_case: i > 0,
}));

test("holdout schema accepts 1–8 sequential scenarios without an edge-case quota", () => {
  const [first] = scenarios;
  expect(HoldoutSchema.safeParse({ scenarios: [{ ...first, edge_case: false }] }).success).toBe(true);
  expect(
    HoldoutSchema.safeParse({ scenarios: scenarios.map((s) => ({ ...s, edge_case: false })) }).success,
  ).toBe(true);
  expect(
    HoldoutSchema.safeParse({
      scenarios: Array.from({ length: 8 }, (_, i) => ({ ...scenarios[i % 3], id: `H-${i + 1}` })),
    }).success,
  ).toBe(true);
  const json = toStrictJsonSchema(HoldoutSchema);
  expect(json).toHaveProperty("properties.scenarios");
});

test("holdout schema still accepts the previously persisted three-scenario format", () => {
  // Shape written by the old 3–8 scenario, two-edge-case schema.
  const persisted = JSON.parse(JSON.stringify({ scenarios }));
  expect(HoldoutSchema.parse(persisted)).toEqual({ scenarios });
});

test("holdout schema rejects length, IDs and missing fields", () => {
  for (const bad of [
    [],
    Array.from({ length: 9 }, (_, i) => ({ ...scenarios[i % 3], id: `H-${i + 1}` })),
    [scenarios[0], { ...scenarios[1], id: "H-1" }, scenarios[2]],
    [{ ...scenarios[0], id: "H-2" }],
    [scenarios[0], { id: "H-2", description: "x", expected: "y", edge_case: true }, scenarios[2]],
    [{ id: "H-1", description: "x", steps: "s", expected: "y" }],
    [{ ...scenarios[0], expected: "  " }],
  ])
    expect(HoldoutSchema.safeParse({ scenarios: bad }).success).toBe(false);
});
