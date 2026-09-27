import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Role } from "../core/types.ts";
import { DEFAULT_POLICY, type ModelDef, type Policy } from "./catalog.ts";
import { resolveTarget } from "./targets.ts";

export type PolicyOverlay = Partial<Policy>;
export function validatePolicy(value: unknown, models: ModelDef[]): PolicyOverlay {
  const group = z.string().superRefine((s, ctx) => {
    for (const id of s.split("|")) {
      try {
        resolveTarget(id, (id) => models.find((m) => m.id === id));
      } catch (error) {
        ctx.addIssue({ code: "custom", message: String(error) });
      }
    }
  });
  const cell = z.array(group).min(1);
  const cells = z.strictObject({
    default: cell.optional(),
    trivial: cell.optional(),
    small: cell.optional(),
    medium: cell.optional(),
    large: cell.optional(),
  });
  return z
    .strictObject({
      triage: cells.optional(),
      summarize: cells.optional(),
      chat: cells.optional(),
      spec: cells.optional(),
      plan: cells.optional(),
      plan_review: cells.optional(),
      holdout: cells.optional(),
      implement: cells.optional(),
      review: cells.optional(),
      verify: cells.optional(),
    })
    .parse(value);
}
export function parsePolicy(text: string, models: ModelDef[], path: string): PolicyOverlay {
  try {
    return validatePolicy(JSON.parse(text), models);
  } catch (error) {
    throw new Error(`Invalid routing policy ${path}: ${String(error)}`);
  }
}
export function readPolicy(path: string, models: ModelDef[]): PolicyOverlay {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parsePolicy(text, models, path);
}
export function overlayPolicy(base: Policy, overlay: PolicyOverlay): Policy {
  const result = structuredClone(base);
  for (const role of Object.keys(overlay) as Role[])
    result[role] = { ...result[role], ...structuredClone(overlay[role]) };
  return result;
}
export function loadPolicy(path: string, models: ModelDef[]): Policy {
  return overlayPolicy(DEFAULT_POLICY, readPolicy(path, models));
}
