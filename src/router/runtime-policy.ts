import type { Complexity, Role, RoutingCell, RoutingChange, RunModels, RunRole } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { redactCredentials } from "../util/proc.ts";
import { DEFAULT_POLICY, type ModelDef, type Policy, type ProviderDef } from "./catalog.ts";
import { overlayPolicy, type PolicyOverlay, validatePolicy } from "./policy.ts";
import { validatePrefer } from "./prefer.ts";
import { filterRetiredTargets, retiredReason } from "./retired.ts";
import type { Router } from "./router.ts";

const CELLS: RoutingCell[] = ["default", "trivial", "small", "medium", "large"];

/** Validates before persistence; routing and API reads share the Router's effective policy. */
export class RuntimePolicy {
  private operator: PolicyOverlay = {};
  private readonly revisions = new Map<string, string>();
  private operatorPrefer: string[] | null;

  constructor(
    private readonly store: Store,
    private readonly router: Router,
    private readonly models: ModelDef[],
    private readonly providers: ProviderDef[],
    private readonly configPrefer: string[],
    readonly code: Policy = DEFAULT_POLICY,
    readonly evals: PolicyOverlay = {},
  ) {
    for (const row of store.routingCells()) {
      const { role, cell } = this.entry(row.role, row.cell);
      const groups = filterRetiredTargets(row.groups, models, providers);
      if (groups.length)
        this.operator[role] = { ...this.operator[role], [cell]: this.groups(role, cell, groups) };
    }
    this.operatorPrefer = store.routingPrefer();
    if (this.operatorPrefer !== null)
      this.operatorPrefer = validatePrefer(
        this.operatorPrefer.filter((id) => !retiredReason(id, providers)),
        this.models,
        this.providers,
      );
    for (const target of this.unavailable())
      console.warn(`[routing] ${target.id}: unavailable (${target.reason}); ${target.references.join("; ")}`);
    // History IDs survive restart and distinguish edits even when a cell is reset to its old value.
    for (const change of store.routingHistory())
      if (this.changesCell(change) && !this.revisions.has(change.key))
        this.revisions.set(change.key, String(change.id));
    router.setPolicy(this.merge(this.operator), this.revisions);
    router.setPreferProviders(this.prefer);
  }

  private merge(operator: PolicyOverlay): Policy {
    const base = Object.keys(this.evals).length ? overlayPolicy(this.code, this.evals) : this.code;
    return Object.keys(operator).length ? overlayPolicy(base, operator) : base;
  }

  private changesCell(change: RoutingChange): boolean {
    // Compare recorded operator values: today's lower layers cannot reclassify an old edit.
    return change.key !== "prefer" && JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
  }

  private entry(role: string, cell: string): { role: Role; cell: RoutingCell } {
    if (!Object.hasOwn(DEFAULT_POLICY, role)) throw new Error(`${role}.${cell}: unknown role`);
    if (!CELLS.includes(cell as RoutingCell)) throw new Error(`${role}.${cell}: unknown cell`);
    return { role: role as Role, cell: cell as RoutingCell };
  }

  private groups(role: Role, cell: RoutingCell, groups: unknown, excludeOrigins?: string[]): string[] {
    try {
      const checked = validatePolicy(
        { [role]: { [cell]: groups } },
        this.models,
        this.providers,
        excludeOrigins,
      );
      return checked[role]?.[cell] ?? [];
    } catch (error) {
      throw new Error(`${role}.${cell}: ${String(error)}`);
    }
  }

  private note(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== "string") throw new Error("note must be a string");
    return value;
  }

  get prefer(): string[] {
    return [...(this.operatorPrefer ?? this.configPrefer)];
  }

  private unavailable() {
    const retired = new Map<string, { id: string; reason: string; references: string[] }>();
    const add = (id: string, reason: string, reference: string) => {
      const entry = retired.get(id) ?? { id, reason, references: [] };
      if (!entry.references.includes(reference)) entry.references.push(reference);
      retired.set(id, entry);
    };
    for (const row of this.store.routingCells()) {
      const missing: { id: string; reason: string }[] = [];
      const groups = filterRetiredTargets(row.groups, this.models, this.providers, (id, reason) =>
        missing.push({ id, reason }),
      );
      for (const { id, reason } of missing)
        add(
          id,
          reason,
          `${row.role}.${row.cell}${groups.length ? "" : ": no override; falling back to code/evals policy"}`,
        );
    }
    for (const id of this.store.routingPrefer() ?? []) {
      const reason = retiredReason(id, this.providers);
      if (reason) add(id, reason, "prefer");
    }
    return [...retired.values()].map(({ id, reason, references }) => ({
      id: redactCredentials(id),
      reason: redactCredentials(reason),
      references: references.map(redactCredentials),
    }));
  }

  private runModels(runId?: string): RunModels | undefined {
    if (runId === undefined) return undefined;
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return run.models ?? undefined;
  }

  snapshot(runId?: string) {
    const models = this.runModels(runId);
    const effective = Object.fromEntries(
      Object.entries(this.router.getPolicy()).map(([role, cells]) => {
        const chain = models?.[role as RunRole];
        return [
          role,
          Object.fromEntries(
            (chain ? CELLS.map((cell) => [cell, chain] as const) : Object.entries(cells)).map(
              ([cell, groups]) => {
                const r = role as Role;
                const c = cell as RoutingCell;
                const operator = this.operator[r]?.[c] !== undefined;
                return [
                  cell,
                  {
                    groups,
                    layer: chain ? "run" : operator ? "operator" : this.evals[r]?.[c] ? "evals" : "code",
                    ...(!chain && operator && this.evals[r]?.[c] ? { evals: this.evals[r]?.[c] } : {}),
                  },
                ];
              },
            ),
          ),
        ];
      }),
    );
    const unavailable = this.unavailable();
    return {
      runId: runId ?? null,
      ...(this.router.excludeOrigins === undefined ? {} : { excludeOrigins: this.router.excludeOrigins }),
      layers: { code: this.code, evals: this.evals, operator: this.operator },
      effective,
      prefer: this.prefer,
      operatorPrefer: this.operatorPrefer,
      ...(unavailable.length ? { unavailable } : {}),
      history: this.store.routingHistory(),
    };
  }

  setCell(roleName: string, cellName: string, value: unknown, note?: unknown, by = "operator") {
    const { role, cell } = this.entry(roleName, cellName);
    const groups = value === null ? null : this.groups(role, cell, value, this.router.excludeOrigins);
    const next = structuredClone(this.operator);
    next[role] = { ...next[role] };
    if (groups === null) delete next[role]?.[cell];
    else next[role][cell] = groups;
    if (Object.keys(next[role]).length === 0) delete next[role];
    const merged = this.merge(next);
    const change = this.store.writeRouting(`${role}.${cell}`, groups, this.note(note), by);
    this.operator = next;
    if (this.changesCell(change)) this.revisions.set(change.key, String(change.id));
    this.router.setPolicy(merged, this.revisions);
    this.store.publishRouting(change);
    return this.snapshot();
  }

  setPrefer(value: unknown, note?: unknown, by = "operator") {
    const prefer = value === null ? null : validatePrefer(value, this.models, this.providers);
    const change = this.store.writeRouting("prefer", prefer, this.note(note), by);
    this.operatorPrefer = prefer;
    this.router.setPreferProviders(this.prefer);
    this.store.publishRouting(change);
    return this.snapshot();
  }

  preview(role: string, complexity = "medium", runId?: string) {
    this.entry(role, complexity);
    if (complexity === "default") throw new Error(`${role}.${complexity}: expected complexity`);
    const chain = this.runModels(runId)?.[role as RunRole];
    return this.router.preview(role as Role, complexity as Complexity, { chain });
  }
}
