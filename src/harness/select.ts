import type { Role } from "../core/types.ts";
import type { ModelTarget } from "./types.ts";

/** Keep tool-less roles identical in pipeline, concierge and evaluations. */
export function selectHarness(role: Role, target: ModelTarget, noTools = false) {
  const toolLess = ["triage", "chat", "summarize"].includes(role);
  return {
    harnessName: toolLess && target.openai ? "llm" : target.harness,
    noTools: toolLess || noTools,
  };
}
