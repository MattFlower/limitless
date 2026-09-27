import { effortLabel } from "../../src/core/effort-format.ts";
import type { Invocation } from "../../src/core/types.ts";

export function invocationModelLabel(invocation: Pick<Invocation, "modelId" | "model" | "effort">): string {
  return `${invocation.modelId} → ${invocation.model} · ${effortLabel(invocation.effort)}`;
}
