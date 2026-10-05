import type { Complexity, Role, RoutingCell, RoutingChange } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { DEFAULT_POLICY, type ModelDef, type Policy, type ProviderDef, REMOVED_MODELS } from "./catalog.ts";
import { overlayPolicy, type PolicyOverlay, validatePolicy } from "./policy.ts";
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
      this.operator[role] = { ...this.operator[role], [cell]: this.groups(role, cell, row.groups) };
    }
    this.operatorPrefer = store.routingPrefer();
    if (this.operatorPrefer !== null) this.validatePrefer(this.operatorPrefer);
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

  private groups(role: Role, cell: RoutingCell, groups: unknown): string[] {
    try {
      const checked = validatePolicy({ [role]: { [cell]: groups } }, this.models, this.providers);
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

  private validatePrefer(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error("prefer: expected provider IDs");
    for (const id of value) {
      if (typeof id !== "string" || !this.providers.some((p) => p.id === id)) {
        const retired = typeof id === "string" ? REMOVED_MODELS.get(id) : undefined;
        throw new Error(
          `prefer: unknown provider ${String(id)}${retired ? `: ${retired}` : " (use provider IDs, not model IDs)"}`,
        );
      }
    }
    return [...value] as string[];
  }

  get prefer(): string[] {
    return [...(this.operatorPrefer ?? this.configPrefer)];
  }

  snapshot() {
    const effective = Object.fromEntries(
      Object.entries(this.router.getPolicy()).map(([role, cells]) => [
        role,
        Object.fromEntries(
          Object.entries(cells).map(([cell, groups]) => {
            const r = role as Role;
            const c = cell as RoutingCell;
            const operator = this.operator[r]?.[c] !== undefined;
            return [
              cell,
              {
                groups,
                layer: operator ? "operator" : this.evals[r]?.[c] ? "evals" : "code",
                ...(operator && this.evals[r]?.[c] ? { evals: this.evals[r]?.[c] } : {}),
              },
            ];
          }),
        ),
      ]),
    );
    return {
      layers: { code: this.code, evals: this.evals, operator: this.operator },
      effective,
      prefer: this.prefer,
      operatorPrefer: this.operatorPrefer,
      history: this.store.routingHistory(),
    };
  }

  setCell(roleName: string, cellName: string, value: unknown, note?: unknown, by = "operator") {
    const { role, cell } = this.entry(roleName, cellName);
    const groups = value === null ? null : this.groups(role, cell, value);
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
    const prefer = value === null ? null : this.validatePrefer(value);
    const change = this.store.writeRouting("prefer", prefer, this.note(note), by);
    this.operatorPrefer = prefer;
    this.router.setPreferProviders(this.prefer);
    this.store.publishRouting(change);
    return this.snapshot();
  }

  preview(role: string, complexity = "medium") {
    this.entry(role, complexity);
    if (complexity === "default") throw new Error(`${role}.${complexity}: expected complexity`);
    return this.router.preview(role as Role, complexity as Complexity);
  }
}
