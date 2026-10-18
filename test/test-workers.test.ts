import { expect, test } from "bun:test";
import { resolveTestWorkers } from "../src/util/test-workers.ts";

test("suite workers default to a third of the cores, from 4 to 8, unless overridden", () => {
  expect([1, 4, 12, 14, 15, 18, 24, 26, 64].map((cores) => resolveTestWorkers(undefined, cores))).toEqual([
    4, 4, 4, 4, 5, 6, 8, 8, 8,
  ]);
  expect(resolveTestWorkers("2", 18)).toBe(2);
  expect(resolveTestWorkers("12", 4)).toBe(12);
  for (const invalid of ["", "0", "-1", "2.5", "six", "9007199254740993"])
    expect(resolveTestWorkers(invalid, 18)).toBe(6);
});
