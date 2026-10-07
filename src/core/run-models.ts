import { RUN_ROLES, type RunModels, type RunRole } from "./types.ts";

/** Preserve policy groups; validation of catalog targets belongs to the daemon. */
export function parseRunModels(flags: string[] | undefined): RunModels | undefined {
  if (!flags?.length) return undefined;
  const models: RunModels = {};
  for (const flag of flags) {
    const [role, chain, ...extra] = flag.split("=");
    if (!RUN_ROLES.includes(role as RunRole) || chain === undefined || extra.length)
      throw new Error(`Invalid --model "${flag}": expected role=chain (${RUN_ROLES.join(", ")})`);
    if (Object.hasOwn(models, role as string)) throw new Error(`Duplicate --model role "${role}"`);
    models[role as RunRole] = chain.split(",").map((group) => group.trim());
  }
  return models;
}
