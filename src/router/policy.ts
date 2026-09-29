import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Role } from "../core/types.ts";
import { DEFAULT_POLICY, type ModelDef, type Policy, PROVIDERS, type ProviderDef } from "./catalog.ts";
import { resolveTarget, transportError } from "./targets.ts";

export type PolicyOverlay = Partial<Policy>;
export function validatePolicy(
  value: unknown,
  models: ModelDef[],
  providers: ProviderDef[] = PROVIDERS,
): PolicyOverlay {
  const cells = (role: Role) => {
    const group = z.string().superRefine((s, ctx) => {
      for (const id of s.split("|")) {
        try {
          const target = resolveTarget(id, (id) => models.find((m) => m.id === id));
          const problem = transportError(
            role,
            target,
            providers.find((p) => p.id === target.model.provider),
          );
          if (problem) throw new Error(problem);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: String(error) });
        }
      }
    });
    const cell = z.array(group).min(1);
    return z.strictObject({
      default: cell.optional(),
      trivial: cell.optional(),
      small: cell.optional(),
      medium: cell.optional(),
      large: cell.optional(),
    });
  };
  return z
    .strictObject({
      triage: cells("triage").optional(),
      summarize: cells("summarize").optional(),
      chat: cells("chat").optional(),
      spec: cells("spec").optional(),
      plan: cells("plan").optional(),
      plan_review: cells("plan_review").optional(),
      holdout: cells("holdout").optional(),
      implement: cells("implement").optional(),
      review: cells("review").optional(),
      verify: cells("verify").optional(),
    })
    .parse(value);
}
export function parsePolicy(
  text: string,
  models: ModelDef[],
  path: string,
  providers?: ProviderDef[],
): PolicyOverlay {
  try {
    return validatePolicy(JSON.parse(text), models, providers);
  } catch (error) {
    throw new Error(`Invalid routing policy ${path}: ${String(error)}`);
  }
}
export function readPolicy(path: string, models: ModelDef[], providers?: ProviderDef[]): PolicyOverlay {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parsePolicy(text, models, path, providers);
}
export function overlayPolicy(base: Policy, overlay: PolicyOverlay): Policy {
  const result = structuredClone(base);
  for (const role of Object.keys(overlay) as Role[])
    result[role] = { ...result[role], ...structuredClone(overlay[role]) };
  return result;
}
export function loadPolicy(path: string, models: ModelDef[], providers?: ProviderDef[]): Policy {
  return overlayPolicy(DEFAULT_POLICY, readPolicy(path, models, providers));
}
