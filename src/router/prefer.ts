import { type ModelDef, type ProviderDef, REMOVED_MODELS } from "./catalog.ts";

export function validatePrefer(value: unknown, models: ModelDef[], providers: ProviderDef[]): string[] {
  if (!Array.isArray(value)) throw new Error("routing.prefer must be an array of provider IDs");
  const prefer: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") throw new Error(`routing.prefer[${index}] must be a provider ID string`);
    if (!providers.some((p) => p.id === entry)) {
      const model = models.find((m) => m.id === entry);
      if (model)
        throw new Error(
          `routing.prefer: "${entry}" is a model ID, not a provider; prefer takes provider IDs (use "${model.provider}")`,
        );
      const retired = REMOVED_MODELS.get(entry);
      if (retired) throw new Error(`routing.prefer: "${entry}" is a retired model ID: ${retired}`);
      throw new Error(`routing.prefer: "${entry}" is not a known provider ID`);
    }
    prefer.push(entry);
  }
  return prefer;
}
