import { effortLabel } from "../../src/core/effort-format.ts";
import type { Invocation } from "../../src/core/types.ts";

export function invocationModelLabel(
  invocation: Pick<Invocation, "modelId" | "effort"> & { model: string | null | undefined },
): string {
  const model = invocation.model?.trim() || "unknown model (legacy)";
  return `${invocation.modelId} → ${model} · ${effortLabel(invocation.effort)}`;
}
