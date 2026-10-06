import type { ProviderDef } from "./catalog.ts";
import { providerKind } from "./config-catalog.ts";

export function discoversModels(provider: ProviderDef): boolean {
  const url = URL.parse(provider.healthUrl ?? "");
  return (
    provider.id !== "openrouter" &&
    url?.hostname !== "openrouter.ai" &&
    !["claude-cli", "codex-cli"].includes(providerKind(provider)) &&
    /\/v1\/models\/?$/.test(url?.pathname ?? "")
  );
}

export function servedIds(value: unknown): string[] {
  const data = value && typeof value === "object" && "data" in value ? value.data : null;
  if (!Array.isArray(data)) throw new Error("invalid model list: expected data[].id");
  const ids = new Set<string>();
  for (const item of data as unknown[]) {
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !item.id.trim()
    )
      throw new Error("invalid model list: expected data[].id");
    ids.add(item.id);
  }
  return [...ids];
}
