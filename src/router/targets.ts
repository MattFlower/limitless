import type { Effort, ModelSelection, RecordedEffort, Role } from "../core/types.ts";
import { TOOL_LESS_ROLES } from "../harness/select.ts";
import type { ModelDef, ProviderDef } from "./catalog.ts";

export function parseTarget(reference: string): { modelId: string; effort?: string } {
  if (!reference) throw new Error("empty model ID: expected model or model@effort");
  if (reference.trim() !== reference)
    throw new Error("model reference must be nonempty without surrounding whitespace");
  const parts = reference.split("@");
  const modelId = parts[0];
  if (!modelId || parts.length > 2 || (parts.length === 2 && !parts[1]))
    throw new Error(`Invalid model reference "${reference}": expected model or model@effort`);
  if (parts.some((part) => part.trim() !== part))
    throw new Error("model reference components must not have surrounding whitespace");
  return { modelId, effort: parts[1] };
}
export function formatTarget(modelId: string, effort?: string | null): string {
  return effort == null || effort === "default" ? modelId : `${modelId}@${effort}`;
}
export type ResolvedTarget = ReturnType<typeof resolveTarget>;
export function resolveTarget(
  reference: string | ModelSelection,
  lookup: (id: string) => ModelDef | undefined,
) {
  const parsed = parseTarget(typeof reference === "string" ? reference : reference.modelId);
  if (typeof reference !== "string" && parsed.effort !== undefined)
    throw new Error("saved modelId must be a base catalog ID");
  const model = lookup(parsed.modelId);
  if (!model) throw new Error(`unknown model ID "${parsed.modelId}"`);
  if (model.effort !== undefined && !model.supportedEfforts.includes(model.effort))
    throw new Error(`Invalid default effort for ${model.id}: ${model.effort}`);
  const effort =
    typeof reference === "string" ? (parsed.effort ?? model.effort) : (reference.effort ?? undefined);
  if (effort !== undefined && !model.supportedEfforts.includes(effort as Effort))
    throw new Error(
      `Unsupported effort "${effort}" for ${model.id}; supported: ${model.supportedEfforts.join(", ") || "none (explicit control unavailable)"}`,
    );
  return { model, effort: effort as Effort | undefined, targetId: formatTarget(model.id, effort) };
}
/**
 * Backends reached through the Claude CLI (OpenRouter, mtplx, llama.cpp) cannot receive an effort;
 * only the tool-less roles run over HTTP there, where the llm harness maps it.
 */
export function effortTransportError(
  role: Role,
  target: Pick<ResolvedTarget, "model" | "effort" | "targetId">,
  provider: ProviderDef | undefined,
): string | null {
  if (target.effort === undefined || !provider) return null;
  if (provider.harness !== "claude" || !provider.baseUrl) return null;
  if (TOOL_LESS_ROLES.includes(role) && provider.openaiBaseUrl) return null;
  return `${target.targetId} cannot carry effort in the ${role} role: ${provider.id} runs through the Claude CLI there, which cannot set effort (use ${target.model.id} without @effort)`;
}
/** Record an unset effort as "default" so it stays distinct from legacy rows (null = unknown). */
export function recordEffort(effort: Effort | undefined): RecordedEffort {
  return effort ?? "default";
}
/** Recorded values never consult today's defaults. */
export function recordedTarget(target: { modelId: string; effort?: string | null }): string {
  return formatTarget(target.modelId, target.effort);
}
