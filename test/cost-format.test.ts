import { expect, test } from "bun:test";
import { formatCost } from "../src/core/cost-format.ts";

test("cost display leads with API-equivalent work and preserves tiny paid amounts in the title", () => {
  expect(formatCost(0.0002, 4.34)).toEqual({
    primary: "≈$4.34",
    paid: null,
    title: "API-equivalent $4.34 · paid $0.0002",
  });
  expect(formatCost(0.005, 4.34).paid).toBe("$0.01");
  expect(formatCost(0.01, 4.34)).toMatchObject({ primary: "≈$4.34", paid: "$0.01" });
  expect(formatCost(0, 0).primary).toBe("—");
  expect(formatCost(0, 0.001)).toMatchObject({ primary: "≈$0.00", paid: null });
});
