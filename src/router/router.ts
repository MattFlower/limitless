import type { Complexity, Role } from "../core/types.ts";
import type { ModelTarget } from "../harness/types.ts";
import { DEFAULT_POLICY, MODELS, type ModelDef, type Policy } from "./catalog.ts";
import type { ProviderTracker } from "./providers.ts";

export interface RouteConstraints {
  /** Skip models from this vendor (cross-vendor review). Falls back to it only if nothing else is available. */
  avoidVendor?: string;
  /** Only consider models at or above this tier (escalation). */
  minTier?: number;
  /** Models to skip entirely (already failed in this stage). */
  exclude?: string[];
  /** Put this model first when it is available (stick with the current implementer). */
  prefer?: string;
}

export interface RouteDecision {
  candidates: ModelTarget[];
  /** Why candidates were skipped, for the run log. */
  skipped: { modelId: string; reason: string }[];
}

export class Router {
  private readonly models: Map<string, ModelDef>;

  constructor(
    private readonly tracker: ProviderTracker,
    private readonly policy: Policy = DEFAULT_POLICY,
    models: ModelDef[] = MODELS,
  ) {
    this.models = new Map(models.map((m) => [m.id, m]));
  }

  model(id: string): ModelDef | undefined {
    return this.models.get(id);
  }

  toTarget(m: ModelDef): ModelTarget {
    const def = this.tracker.def(m.provider);
    if (!def) throw new Error(`model ${m.id} references unknown provider ${m.provider}`);
    const target: ModelTarget = {
      modelId: m.id,
      provider: m.provider,
      harness: def.harness,
      model: m.model,
      vendor: m.vendor,
      tier: m.tier,
      billing: def.billing,
      price: m.price,
    };
    if (m.effort) target.effort = m.effort;
    if (def.baseUrl)
      target.backend = { baseUrl: def.baseUrl, authToken: this.tracker.authToken(m.provider) ?? "" };
    return target;
  }

  /** Ordered, available candidates for a role. Never empty unless nothing at all is usable. */
  route(role: Role, complexity: Complexity, c: RouteConstraints = {}): RouteDecision {
    const entry = this.policy[role];
    const groups = entry?.[complexity] ?? entry?.default ?? [];
    const skipped: RouteDecision["skipped"] = [];
    const preferred: ModelDef[] = [];
    const sameVendor: ModelDef[] = [];
    const seen = new Set<string>();

    const consider = (ids: string[]) => {
      const group: ModelDef[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const m = this.models.get(id);
        if (!m) {
          skipped.push({ modelId: id, reason: "not in catalog" });
          continue;
        }
        if (c.exclude?.includes(id)) {
          skipped.push({ modelId: id, reason: "already tried" });
          continue;
        }
        if (c.minTier !== undefined && m.tier < c.minTier) {
          skipped.push({ modelId: id, reason: `below tier ${c.minTier}` });
          continue;
        }
        const why = this.tracker.unavailableReason(m.provider) ?? this.tracker.modelUnavailableReason(m.id);
        if (why) {
          skipped.push({ modelId: id, reason: `${m.provider}: ${why}` });
          continue;
        }
        group.push(m);
      }
      // Interchangeable models: most headroom first (spreads load across subscriptions).
      group.sort((a, b) => this.tracker.headroom(b.provider) - this.tracker.headroom(a.provider));
      for (const m of group) (c.avoidVendor && m.vendor === c.avoidVendor ? sameVendor : preferred).push(m);
    };

    for (const g of groups) consider(g.split("|"));
    // Escalation beyond the policy list: any remaining catalog model at a sufficient tier.
    if (c.minTier !== undefined) {
      const rest = [...this.models.values()]
        .filter((m) => m.tier >= (c.minTier as number) && !seen.has(m.id))
        .sort((a, b) => a.tier - b.tier)
        .map((m) => m.id);
      for (const id of rest) consider([id]);
    }

    const ordered = [...preferred, ...sameVendor];
    const pinned = c.prefer ? ordered.findIndex((m) => m.id === c.prefer) : -1;
    if (pinned > 0) ordered.unshift(...ordered.splice(pinned, 1));
    return { candidates: ordered.map((m) => this.toTarget(m)), skipped };
  }
}
