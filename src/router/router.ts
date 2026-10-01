import type { Complexity, Effort, ModelSelection, Role } from "../core/types.ts";
import type { ModelTarget } from "../harness/types.ts";
import { DEFAULT_POLICY, MODELS, type ModelDef, type Policy } from "./catalog.ts";
import type { ProviderTracker } from "./providers.ts";
import { formatTarget, parseTarget, resolveTarget, transportError } from "./targets.ts";

export interface RouteConstraints {
  /** Skip models from these vendors (cross-vendor review). Falls back to them only if nothing else is available. */
  avoidVendor?: string | string[];
  /** Exclude model identities regardless of reasoning effort. */
  excludeModels?: string[];
  /** Why `excludeModels` are skipped, for the run log (default "already tried"). */
  excludedBecause?: string;
  /** Only consider models at or above this tier (escalation). */
  minTier?: number;
  /** Resolved targets to skip (already failed in this stage). */
  exclude?: (string | ModelSelection)[];
  /** Put this target first when it is available (stick with the current implementer). */
  prefer?: string | ModelSelection;
  /** Consider only this target, with no fallback (a verifier picked from a configured list). */
  only?: string;
  /** Put this vendor's models first, as if every other vendor were avoided. */
  preferVendor?: string;
  /** Ranked after the same vendor without it; below `avoidVendor` (a verifier: the implementer's vendor). */
  preferNotVendor?: string[];
  /** Model identities tried last of all (a verifier: the implementer's model). */
  preferNotModels?: string[];
  /** "free_first" tries free models first; "free_only" considers nothing else. */
  billing?: "free_first" | "free_only";
  /** Vendor independence outranks free-first billing (a verifier stays independent of free finders). */
  independenceFirst?: boolean;
}

export interface RouteDecision {
  candidates: ModelTarget[];
  /** Why candidates were skipped, for the run log. */
  skipped: { modelId: string; reason: string }[];
}

export class Router {
  private readonly models: Map<string, ModelDef>;
  private readonly lastRoute = new Map<
    string,
    { role: Role; complexity: Complexity; constraints: RouteConstraints }
  >();

  constructor(
    private readonly tracker: ProviderTracker,
    private readonly policy: Policy = DEFAULT_POLICY,
    models: ModelDef[] = MODELS,
    private readonly preferProviders: string[] = [],
  ) {
    this.models = new Map(models.map((m) => [m.id, m]));
    for (const model of models) this.resolve(model.id);
  }

  model(id: string): ModelDef | undefined {
    return this.models.get(id);
  }

  resolve(reference: string | ModelSelection) {
    return resolveTarget(reference, (id) => this.models.get(id));
  }

  /** Resolve a reference and reject efforts the role's harness cannot deliver. */
  resolveFor(role: Role, reference: string | ModelSelection) {
    const resolved = this.resolve(reference);
    const problem = transportError(role, resolved, this.tracker.def(resolved.model.provider));
    if (problem) throw new Error(problem);
    return resolved;
  }

  toTarget(m: ModelDef, effort: Effort | null | undefined = m.effort): ModelTarget {
    if (effort != null && !m.supportedEfforts.includes(effort))
      throw new Error(`Unsupported effort "${effort}" for ${m.id}`);
    const def = this.tracker.def(m.provider);
    if (!def) throw new Error(`model ${m.id} references unknown provider ${m.provider}`);
    const target: ModelTarget = {
      modelId: m.id,
      targetId: formatTarget(m.id, effort),
      provider: m.provider,
      harness: def.harness,
      model: m.model,
      vendor: m.vendor,
      tier: m.tier,
      billing: def.billing,
      price: m.price,
    };
    if (effort != null) target.effort = effort;
    if (def.openaiBaseUrl)
      target.effortMapping =
        def.id === "openrouter"
          ? "openrouter"
          : m.vendor === "qwen" && def.billing === "free"
            ? "qwen"
            : "generic";
    if (def.baseUrl)
      target.backend = { baseUrl: def.baseUrl, authToken: this.tracker.authToken(m.provider) ?? "" };
    if (def.openaiBaseUrl)
      target.openai = { baseUrl: def.openaiBaseUrl, authToken: this.tracker.authToken(m.provider) ?? "" };
    if (def.decisionsBaseUrl)
      target.decisions = {
        baseUrl: def.decisionsBaseUrl,
        authToken: this.tracker.authToken(m.provider) ?? "",
      };
    return target;
  }

  /** Policy order only: no health filtering, headroom sorting or routing side effects. */
  policyTargets(role: Role, complexity: Complexity) {
    const entry = this.policy[role];
    return (entry?.[complexity] ?? entry?.default ?? []).flatMap((group) =>
      group.split("|").flatMap((id) => {
        if (!this.model(parseTarget(id).modelId)) return [];
        const { model, effort } = this.resolveFor(role, id);
        return [{ modelId: model.id, effort: effort ?? null, tier: model.tier }];
      }),
    );
  }

  /** Where a declined decision falls through to: the role's first policy target that isn't a decision model. */
  decisionFallback(role: Role): string | undefined {
    const target = this.policyTargets(role, "small").find(
      (t) => this.tracker.def(this.models.get(t.modelId)?.provider ?? "")?.harness !== "decisions",
    );
    return target && formatTarget(target.modelId, target.effort);
  }

  describeFallback(provider: string, exhausted: boolean): string {
    const alternatives = new Set<string>();
    const effortAlternatives = new Set<string>();
    const selected = this.lastRoute.get(provider);
    const routes: { role: Role; complexity: Complexity; constraints: RouteConstraints }[] = selected
      ? [selected]
      : [];
    for (const [role, cases] of Object.entries(this.policy) as [Role, Policy[Role]][]) {
      if (selected) break;
      for (const [complexity, groups] of Object.entries(cases) as [Complexity | "default", string[]][]) {
        const ids = groups.flatMap((group) => group.split("|"));
        if (!ids.some((id) => this.model(parseTarget(id).modelId)?.provider === provider)) continue;
        routes.push({ role, complexity: complexity === "default" ? "medium" : complexity, constraints: {} });
      }
    }
    for (const route of routes) {
      for (const candidate of this.decideRoute(route.role, route.complexity, route.constraints).candidates) {
        if (candidate.provider !== provider) {
          alternatives.add(candidate.provider);
          if (candidate.effort !== undefined)
            effortAlternatives.add(formatTarget(candidate.modelId, candidate.effort));
        }
      }
    }
    let fallback = alternatives.size
      ? `Eligible fallback providers: ${[...alternatives].join(", ")}.`
      : "No eligible fallback providers are available.";
    if (effortAlternatives.size)
      fallback += ` Eligible fallback targets: ${[...effortAlternatives].join(", ")}.`;
    if (exhausted) return `Router skips ${provider}. ${fallback}`;
    const reason = this.tracker.unavailableReason(provider);
    return reason
      ? `${provider} is currently unavailable (${reason}). ${fallback}`
      : `${provider} remains eligible until its reserve is reached. ${fallback}`;
  }

  /** Ordered, available candidates for a role. Never empty unless nothing at all is usable. */
  route(role: Role, complexity: Complexity, c: RouteConstraints = {}): RouteDecision {
    const decision = this.decideRoute(role, complexity, c);
    const selected = decision.candidates[0];
    if (selected)
      this.lastRoute.set(selected.provider, {
        role,
        complexity,
        constraints: { ...c, exclude: c.exclude ? [...c.exclude] : undefined },
      });
    this.tracker.refreshAlerts();
    return decision;
  }

  private decideRoute(role: Role, complexity: Complexity, c: RouteConstraints): RouteDecision {
    const entry = this.policy[role];
    const groups = entry?.[complexity] ?? entry?.default ?? [];
    const skipped: RouteDecision["skipped"] = [];
    // Lower ranks first; the sort is stable, so policy and headroom order hold within a rank.
    const ranked: { target: ModelTarget; rank: number }[] = [];
    const policyFreeModels = new Set<string>();
    const seen = new Set<string>();
    // Older run state can reference a model removed from the catalog.
    const identity = (reference: string | ModelSelection) => {
      try {
        return this.resolve(reference).targetId;
      } catch {
        return typeof reference === "string" ? reference : formatTarget(reference.modelId, reference.effort);
      }
    };
    const excluded = new Set(c.exclude?.map(identity));
    const preference = c.prefer ? identity(c.prefer) : undefined;

    const avoid = [c.avoidVendor ?? []].flat();
    // Additive, so an avoided vendor that is also the implementer's ranks below one that is not.
    const independence = (m: ModelTarget) =>
      (c.preferNotModels?.includes(m.modelId) ? 4 : 0) +
      (avoid.includes(m.vendor) || (c.preferVendor !== undefined && m.vendor !== c.preferVendor) ? 2 : 0) +
      (c.preferNotVendor?.includes(m.vendor) ? 1 : 0);
    const consider = (ids: (string | ModelSelection)[], fromPolicy = false) => {
      const group: ModelTarget[] = [];
      for (const reference of ids) {
        let resolved: ReturnType<Router["resolve"]>;
        try {
          resolved = this.resolve(reference);
        } catch (error) {
          skipped.push({ modelId: identity(reference), reason: String(error) });
          continue;
        }
        const { model: m, effort, targetId: id } = resolved;
        if (fromPolicy && this.tracker.def(m.provider)?.billing === "free") policyFreeModels.add(m.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (excluded.has(id) || c.excludeModels?.includes(m.id)) {
          skipped.push({
            modelId: id,
            reason: excluded.has(id) ? "already tried" : (c.excludedBecause ?? "already tried"),
          });
          continue;
        }
        const transport = transportError(role, resolved, this.tracker.def(m.provider));
        if (transport) {
          skipped.push({ modelId: id, reason: transport });
          continue;
        }
        if (c.minTier !== undefined && m.tier < c.minTier) {
          skipped.push({ modelId: id, reason: `below tier ${c.minTier}` });
          continue;
        }
        const why = this.tracker.unavailableReason(m.provider) ?? this.tracker.modelUnavailableReason(m.id);
        if (why) {
          skipped.push({ modelId: id, reason: why === "disabled" ? "disabled" : `${m.provider}: ${why}` });
          continue;
        }
        group.push(this.toTarget(m, effort ?? null));
      }
      // Interchangeable models: preferred providers first, then most headroom (spreads load).
      const pref = (m: ModelTarget) => (this.preferProviders.includes(m.provider) ? 0 : 1);
      group.sort(
        (a, b) => pref(a) - pref(b) || this.tracker.headroom(b.provider) - this.tracker.headroom(a.provider),
      );
      for (const m of group) {
        const paid = c.billing !== undefined && m.billing !== "free" ? 1 : 0;
        if (paid && c.billing === "free_only") continue;
        const rank = independence(m);
        ranked.push({ target: m, rank: c.independenceFirst ? rank * 2 + paid : paid * 8 + rank });
      }
    };

    if (c.only) {
      consider([c.only]);
      return { candidates: ranked.map((r) => r.target), skipped };
    }
    for (const g of groups) consider(g.split("|"), true);
    // A persisted implementer can retain an explicit effort after the catalog default changes.
    if (c.prefer) consider([c.prefer]);
    if (c.billing !== undefined) {
      for (const m of this.models.values())
        if (this.tracker.def(m.provider)?.billing === "free" && !policyFreeModels.has(m.id)) consider([m.id]);
    }
    // Escalation beyond the policy list: any remaining catalog model at a sufficient tier.
    if (c.minTier !== undefined) {
      const rest = [...this.models.values()]
        .filter((m) => m.tier >= (c.minTier as number) && !seen.has(formatTarget(m.id, m.effort)))
        .sort((a, b) => a.tier - b.tier)
        .map((m) => m.id);
      for (const id of rest) consider([id]);
    }

    const ordered = ranked.sort((a, b) => a.rank - b.rank).map((r) => r.target);
    // The current implementer stays first in every mode: escalation never falls back to a model
    // that already failed, even a free one.
    const pinned = preference ? ordered.findIndex((m) => m.targetId === preference) : -1;
    if (pinned > 0) ordered.unshift(...ordered.splice(pinned, 1));
    return { candidates: ordered, skipped };
  }
}
