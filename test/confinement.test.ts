import { expect, test } from "bun:test";
import { seatbeltProbeSkip } from "./confinement.ts";

test.each([
  [
    71,
    "sandbox-exec: sandbox_apply: Operation not permitted\n",
    "nested Seatbelt unavailable in this sandbox",
  ],
  [0, "", null],
  [0, "sandbox_apply: Operation not permitted", null],
  [1, "sandbox-exec: invalid profile", null],
  [1, "Operation not permitted", null],
] as const)("Seatbelt probe exit %s, stderr %s", (exitCode, stderr, expected) => {
  expect(seatbeltProbeSkip({ exitCode, stderr })).toBe(expected);
});
