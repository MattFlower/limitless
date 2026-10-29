import { userInfo } from "node:os";
import type { sh } from "../src/util/proc.ts";

export const inspectionCases = [
  "loaded",
  "absent",
  "wrong-status",
  "signal",
  "timeout-loaded",
  "timeout-absent",
  "empty",
  "permission",
  "execution-error",
  "wrong-domain",
  "wrong-label",
  "wrong-uid",
  "fragment",
] as const;

export function inspectionResult(
  scenario: string,
  label: string,
  domain: "gui" | "user" = "gui",
): Awaited<ReturnType<typeof sh>> {
  if (scenario === "execution-error") throw new Error("print could not execute");
  const diagnosticDomain = scenario === "wrong-domain" ? (domain === "gui" ? "user" : "gui") : domain;
  const missing = `Could not find service "${scenario === "wrong-label" ? "other.label" : label}" in domain for ${diagnosticDomain === "gui" ? "user gui" : "uid"}: ${userInfo().uid + (scenario === "wrong-uid" ? 1 : 0)}`;
  return {
    exitCode:
      scenario === "signal"
        ? null
        : ["loaded", "timeout-loaded"].includes(scenario)
          ? 0
          : ["wrong-status", "empty", "permission"].includes(scenario)
            ? 1
            : 113,
    timedOut: scenario.startsWith("timeout-"),
    stdout: "",
    stderr: ["loaded", "timeout-loaded", "empty"].includes(scenario)
      ? ""
      : scenario === "permission"
        ? "Operation not permitted"
        : scenario === "fragment"
          ? `prefix ${missing} suffix`
          : `${missing}\n`,
  };
}
