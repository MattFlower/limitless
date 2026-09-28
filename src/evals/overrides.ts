import { z } from "zod";
import type { Complexity, Role } from "../core/types.ts";
import { DEFAULT_POLICY } from "../router/catalog.ts";
import type { PolicyOverlay } from "../router/policy.ts";
import type { PolicyEvaluation } from "./policy.ts";

export const OVERRIDES_PATH = "routing/overrides.json";
const CELLS: readonly (Complexity | "default")[] = ["default", "trivial", "small", "medium", "large"];
const isDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const OverrideSchema = z.strictObject({
  reason: z.string().trim().min(1),
  decided: z.string().refine(isDate, "decided must be a valid YYYY-MM-DD date"),
});
export type Override = z.infer<typeof OverrideSchema>;
/** Owner decisions keyed by `role.cell`; the pinned chain stays exactly as in policy.json. */
export type Overrides = Map<string, Override>;

export const pinMessage = (o: Override) => `pinned by owner decision (${o.decided}): ${o.reason}`;

/** A missing file means no pins; every pin must name an explicit chain in `existing`. */
export function parseOverrides(text: string | null, existing: PolicyOverlay): Overrides {
  const pins: Overrides = new Map();
  if (text === null) return pins;
  try {
    const entries = Object.entries(z.record(z.string(), OverrideSchema).parse(JSON.parse(text)));
    for (const [key, value] of entries) {
      const [role, cell, ...rest] = key.split(".");
      if (!role || !Object.hasOwn(DEFAULT_POLICY, role)) throw new Error(`unknown role in ${key}`);
      if (!cell || rest.length || !CELLS.includes(cell as Complexity))
        throw new Error(`unknown cell in ${key}`);
      if (!existing[role as Role]?.[cell as Complexity])
        throw new Error(`${key} has no explicit chain in routing/policy.json to pin`);
      pins.set(key, value);
    }
  } catch (error) {
    throw new Error(`Invalid routing overrides ${OVERRIDES_PATH}: ${String(error)}`);
  }
  return pins;
}

/** Pinned cells keep their evidence but propose nothing; the pin replaces the update line. */
export function pinEvaluation(evaluation: PolicyEvaluation, pins: Overrides): PolicyEvaluation {
  const roles = evaluation.roles.map((r) => {
    const pin = pins.get(`${r.role}.${r.cell}`);
    return pin ? { ...r, order: [], availabilityFallbacks: [], decision: pinMessage(pin) } : r;
  });
  const generated: PolicyOverlay = {};
  for (const r of roles) if (r.order.length) generated[r.role] = { ...generated[r.role], [r.cell]: r.order };
  return { ...evaluation, roles, generated };
}

/** Sections for pins the evaluation has no cell for, so the report still records them. */
export function unevaluatedPins(evaluation: PolicyEvaluation, pins: Overrides): [string, Override][] {
  const evaluated = new Set(evaluation.roles.map((r) => `${r.role}.${r.cell}`));
  return [...pins].filter(([key]) => !evaluated.has(key)).sort(([a], [b]) => (a < b ? -1 : 1));
}
