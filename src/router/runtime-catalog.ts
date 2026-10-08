import { z } from "zod";
import type { Store } from "../db/store.ts";
import type { ModelDef, ProviderDef } from "./catalog.ts";
import { runtimeModel } from "./config-catalog.ts";
import { originExclusion } from "./origins.ts";
import { validatePolicy, validateRunModels } from "./policy.ts";
import type { ProviderTracker } from "./providers.ts";
import { filterRetiredTargets, retiredReason } from "./retired.ts";
import type { Router } from "./router.ts";
import type { RuntimePolicy } from "./runtime-policy.ts";
import { parseTarget } from "./targets.ts";

export class RuntimeCatalog {
  constructor(
    private readonly store: Store,
    private readonly models: ModelDef[],
    private readonly providers: ProviderDef[],
    private readonly router: Router,
    private readonly tracker: ProviderTracker,
    private readonly routing: RuntimePolicy,
  ) {}

  snapshot() {
    return {
      history: this.store.catalogHistory(),
      ...(this.router.excludeOrigins === undefined ? {} : { excludeOrigins: this.router.excludeOrigins }),
      models: this.models.map((m) => ({
        ...m,
        source: m.source ?? "code",
        ...(retiredReason(m.provider, this.providers)
          ? { unavailable: retiredReason(m.provider, this.providers) }
          : {}),
        ...(this.router.excludeOrigins === undefined
          ? {}
          : { excluded: originExclusion(m, this.router.excludeOrigins) }),
      })),
      providers: this.tracker
        .all()
        .filter((p) => p.discovery)
        .map((p) => ({ provider: p.id, ...p.discovery })),
    };
  }

  private editable(id: string): ModelDef {
    const model = this.models.find((m) => m.id === id);
    if (!model) throw new Error(`missing catalog model ${id}`);
    if (model.source !== "runtime") throw new Error(`${id}: code and config models are read-only`);
    return model;
  }

  private apply(id: string, model: ModelDef | null, note: string | null = null) {
    const next = this.models.filter((m) => m.id !== id);
    if (model) next.push(model);
    // Only references valid before this edit can be newly invalidated by it.
    const affected = (role: string, groups: string[]) =>
      filterRetiredTargets(groups, this.models, this.providers).flatMap((group) =>
        group.split("|").filter((ref) => {
          if (parseTarget(ref).modelId !== id) return false;
          try {
            validatePolicy({ [role]: { default: [ref] } }, this.models, this.providers);
            return true;
          } catch {
            return false;
          }
        }),
      );
    for (const [layer, policy] of Object.entries(this.routing.snapshot().layers)) {
      try {
        const scoped = Object.fromEntries(
          Object.entries(policy).map(([role, cells]) => [
            role,
            Object.fromEntries(
              Object.entries(cells).flatMap(([cell, groups]) => {
                const refs = affected(role, groups);
                return refs.length ? [[cell, refs]] : [];
              }),
            ),
          ]),
        );
        validatePolicy(scoped, next, this.providers);
      } catch (error) {
        const reason =
          error instanceof z.ZodError
            ? error.issues.map((issue) => `${issue.path.slice(0, 2).join(".")}: ${issue.message}`).join("; ")
            : String(error);
        throw new Error(`${layer} policy: ${reason}`);
      }
    }
    for (const run of this.store.listRuns({ limit: Number.MAX_SAFE_INTEGER })) {
      if (run.models == null) continue;
      try {
        const scoped = Object.fromEntries(
          Object.entries(run.models).flatMap(([role, groups]) => {
            const refs = affected(role, groups);
            return refs.length ? [[role, refs]] : [];
          }),
        );
        validateRunModels(scoped, next, this.providers);
      } catch (error) {
        throw new Error(`run ${run.id}: ${String(error)}`);
      }
    }
    this.store.writeRuntimeModel(id, model, note);
    this.models.splice(0, this.models.length, ...next);
    this.router.setModels(this.models);
    this.tracker.setModels(this.models);
    this.store.publishCatalog();
    return this.snapshot();
  }

  add(value: unknown) {
    const model = runtimeModel(value, this.providers);
    if (this.models.some((m) => m.id === model.id)) throw new Error(`catalog collision: ${model.id}`);
    return this.apply(model.id, model, model.notes ?? null);
  }

  patch(id: string, value: unknown) {
    const { source: _source, ...old } = this.editable(id);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected model object");
    const patch = value as Record<string, unknown>;
    const model = runtimeModel(
      {
        ...old,
        id: id.slice(old.provider.length + 1),
        ...patch,
        // Omitted effort inherits; null explicitly clears the optional default.
        effort: patch.effort === null ? undefined : patch.effort === undefined ? old.effort : patch.effort,
        price:
          patch.price && typeof patch.price === "object" && !Array.isArray(patch.price)
            ? { ...old.price, ...patch.price }
            : patch.price === undefined
              ? old.price
              : patch.price,
      },
      this.providers,
    );
    if (model.id !== id) throw new Error("model id and provider are immutable");
    return this.apply(id, model, typeof patch.notes === "string" ? patch.notes : null);
  }

  remove(id: string) {
    this.editable(id);
    return this.apply(id, null);
  }
}
