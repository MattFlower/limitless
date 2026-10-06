import { z } from "zod";
import type { Store } from "../db/store.ts";
import type { ModelDef, ProviderDef } from "./catalog.ts";
import { runtimeModel } from "./config-catalog.ts";
import { validatePolicy, validateRunModels } from "./policy.ts";
import type { ProviderTracker } from "./providers.ts";
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
      models: this.models.map((m) => ({ ...m, source: m.source ?? "code" })),
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

  private apply(id: string, model: ModelDef | null) {
    const next = this.models.filter((m) => m.id !== id);
    if (model) next.push(model);
    for (const [layer, policy] of Object.entries(this.routing.snapshot().layers)) {
      try {
        validatePolicy(policy, next, this.providers);
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
        validateRunModels(run.models, next, this.providers);
      } catch (error) {
        throw new Error(`run ${run.id}: ${String(error)}`);
      }
    }
    this.store.writeRuntimeModel(id, model);
    this.models.splice(0, this.models.length, ...next);
    this.router.setModels(this.models);
    this.tracker.setModels(this.models);
    this.store.publishCatalog();
    return this.snapshot();
  }

  add(value: unknown) {
    const model = runtimeModel(value, this.providers);
    if (this.models.some((m) => m.id === model.id)) throw new Error(`catalog collision: ${model.id}`);
    return this.apply(model.id, model);
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
    return this.apply(id, model);
  }

  remove(id: string) {
    this.editable(id);
    const cells = this.store
      .routingCells()
      .filter((cell) => cell.groups.some((g) => g.split("|").some((ref) => parseTarget(ref).modelId === id)));
    if (cells.length)
      throw new Error(
        `${id} is referenced by operator policy: ${cells.map((c) => `${c.role}.${c.cell}`).join(", ")}`,
      );
    return this.apply(id, null);
  }
}
