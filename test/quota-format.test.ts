import { expect, test } from "bun:test";
import { observationAge, utilizationPercent } from "../src/core/quota-format.ts";
import { pct } from "../ui/lib/format.ts";

test("utilization display rounds upward and stays within 0 to 100 percent", () => {
  expect([0, 0.721, 1, -0.1, 1.1].map(utilizationPercent)).toEqual(["0%", "73%", "100%", "0%", "100%"]);
  expect(pct(0.721)).toBe("73%");
});

test("observation age handles elapsed, missing and future readings", () => {
  const now = 1_000_000;
  expect(observationAge(now - 12 * 60_000, now)).toBe("as of 12 min ago");
  expect(observationAge(now - 12 * 60_000, now + 60_000)).toBe("as of 13 min ago");
  expect(observationAge(null, now)).toBe("as of unknown");
  expect(observationAge(undefined, now)).toBe("as of unknown");
  expect(observationAge(now + 60_000, now)).toBe("as of just now");
});
