import type { RecordedEffort } from "./types.ts";

/** Display label for a recorded effort; legacy rows never borrow today's catalog default. */
export function effortLabel(effort: RecordedEffort | null | undefined): string {
  if (effort == null) return "unknown (legacy)";
  return effort === "default" ? "backend default" : effort;
}
