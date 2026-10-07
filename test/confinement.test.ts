import { expect, test } from "bun:test";
import { seatbeltProbeSkip } from "./confinement.ts";

test.each([
  [
    "profile application refused",
    71,
    "sandbox-exec: sandbox_apply: Operation not permitted\n",
    "nested Seatbelt unavailable in this sandbox",
  ],
  ["probe succeeded", 0, "", null],
  ["successful exit with diagnostic text", 0, "sandbox_apply: Operation not permitted", null],
  ["invalid profile", 1, "sandbox-exec: invalid profile", null],
  ["unrelated permission error", 1, "Operation not permitted", null],
] as const)("Seatbelt probe: %s", (_description, exitCode, stderr, expected) => {
  expect(seatbeltProbeSkip({ exitCode, stderr })).toBe(expected);
});
