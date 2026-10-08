import type { ModelDef, ProviderDef } from "./catalog.ts";
import { parseTarget } from "./targets.ts";

export function retiredReason(id: string, catalog: readonly { id: string }[]): string | null {
  return catalog.some((entry) => entry.id === id) ? null : `retired reference: ${id} is not in the catalog`;
}

/** Filter persisted chains only; new writes still go through the strict validators. */
export function filterRetiredTargets(
  groups: string[],
  models: ModelDef[],
  providers: ProviderDef[],
  unavailable: (id: string, reason: string) => void = () => {},
): string[] {
  return groups.flatMap((group) => {
    const live = group.split("|").filter((reference) => {
      const { modelId } = parseTarget(reference);
      const model = models.find((m) => m.id === modelId);
      const reason = retiredReason(modelId, models) ?? (model && retiredReason(model.provider, providers));
      if (!reason) return true;
      unavailable(modelId, reason);
      return false;
    });
    return live.length ? [live.join("|")] : [];
  });
}
