import type { Role } from "../core/types.ts";
import type { ModelTarget } from "./types.ts";

export const TOOL_LESS_ROLES: readonly Role[] = ["triage", "chat", "summarize"];

/** Keep tool-less roles identical in pipeline, concierge and evaluations. */
export function selectHarness(role: Role, target: ModelTarget, noTools = false) {
  const toolLess = TOOL_LESS_ROLES.includes(role);
  return {
    harnessName: toolLess && target.openai ? "llm" : target.harness,
    noTools: toolLess || noTools,
  };
}
