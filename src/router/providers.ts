import type { Reserves } from "../config.ts";
import type { InvocationStatus, ProviderStatus, QuotaAlert, QuotaWindow } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { ProviderDef } from "./catalog.ts";

interface ProviderRuntime {
  def: ProviderDef;
  enabled: boolean;
  disabledReason: string | null;
  windows: Record<string, QuotaWindow>;
  exhaustedUntil: number | null;
  exhaustedReason: string | null;
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  healthy: boolean; // for local servers: last probe result
  inFlight: number;
  waiters: (() => void)[];
}

const CIRCUIT_THRESHOLD = 3;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tracks health, quota and concurrency per provider. The router asks it which providers are
 * usable; the pipeline reports every invocation outcome back to it.
 */
export class ProviderTracker {
  private providers = new Map<string, ProviderRuntime>();
  /** Individual models a provider rejected (e.g. not available on this plan). */
  private modelBlocks = new Map<string, { until: number; reason: string }>();
  private routingFor: ((provider: string, exhausted: boolean) => string) | null = null;

  constructor(
    defs: ProviderDef[],
    private readonly store: Store,
    private readonly reserves: Reserves,
    private readonly secrets: Record<string, string>,
    private readonly budgets: Record<string, number> = {},
    private readonly clock: () => number = Date.now,
  ) {
    for (const def of defs) {
      let enabled = true;
      let disabledReason: string | null = null;
      if (def.apiKeySecret && !secrets[def.apiKeySecret]) {
        enabled = false;
        disabledReason = `missing ${def.apiKeySecret}`;
      }
      const row = store.getProviderRow(def.id);
      const windows = row?.windows_json
        ? (JSON.parse(row.windows_json as string) as Record<string, QuotaWindow>)
        : {};
      const until = (row?.until as number | null) ?? null;
      this.providers.set(def.id, {
        def,
        enabled,
        disabledReason,
        windows,
        exhaustedUntil: row?.state === "exhausted" && until && until > clock() ? until : null,
        exhaustedReason: row?.state === "exhausted" ? ((row.reason as string) ?? null) : null,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        healthy: !def.healthUrl, // local servers start unknown→down until probed
        inFlight: 0,
        waiters: [],
      });
    }
  }

  now(): number {
    return this.clock();
  }

  setRoutingDescription(describe: (provider: string, exhausted: boolean) => string): void {
    this.routingFor = describe;
  }

  isEnabled(id: string): boolean {
    return this.providers.get(id)?.enabled ?? false;
  }

  def(id: string): ProviderDef | undefined {
    return this.providers.get(id)?.def;
  }

  authToken(id: string): string | undefined {
    const p = this.providers.get(id);
    if (!p) return undefined;
    if (p.def.apiKeySecret) return this.secrets[p.def.apiKeySecret];
    return p.def.apiKey;
  }

  /** Fraction of the tightest reserve still available: 1 = untouched, <=0 = at/over reserve. */
  headroom(id: string, now = this.clock()): number {
    const p = this.providers.get(id);
    if (!p) return 0;
    let min = 1;
    for (const [name, w] of Object.entries(p.windows)) {
      const cap = this.reserveFor(id, name);
      const util = w.resetsAt !== null && w.resetsAt <= now ? 0 : w.utilization;
      min = Math.min(min, (cap - util) / cap);
    }
    const budget = this.budgets[id];
    if (budget !== undefined) {
      if (!(budget > 0)) return 0; // a zero, negative or NaN budget means "never spend"
      const spent = this.store.providerSpendSince(id, now - MONTH_MS);
      min = Math.min(min, (budget - spent) / budget);
    }
    return min;
  }

  private reserveFor(id: string, window: string): number {
    const configured = this.reserves.windows?.[id]?.[window];
    if (configured !== undefined) return configured;
    if (id === "claude" && window === "five_hour") return this.reserves.claudeFiveHour;
    if (id === "claude" && window === "seven_day") return this.reserves.claudeSevenDay;
    if (id === "codex" && window === "five_hour") return this.reserves.codexFiveHour;
    if (id === "codex" && window === "seven_day") return this.reserves.codexWeekly;
    return 1;
  }

  unavailableReason(id: string, now = this.clock()): string | null {
    const p = this.providers.get(id);
    if (!p) return "unknown provider";
    if (!p.enabled) return p.disabledReason ?? "disabled";
    if (!p.healthy) return "server not reachable";
    if (p.exhaustedUntil && p.exhaustedUntil > now) return p.exhaustedReason ?? "quota exhausted";
    if (p.circuitOpenUntil && p.circuitOpenUntil > now)
      return `circuit open after ${p.consecutiveFailures} failures`;
    if (this.headroom(id, now) <= 0) return "at reserve limit";
    return null;
  }

  blockModel(modelId: string, reason: string, ms = 24 * 60 * 60 * 1000): void {
    this.modelBlocks.set(modelId, { until: this.clock() + ms, reason: reason.slice(0, 200) });
  }

  modelUnavailableReason(modelId: string, now = this.clock()): string | null {
    const block = this.modelBlocks.get(modelId);
    return block && block.until > now ? `model rejected: ${block.reason}` : null;
  }

  isAvailable(id: string): boolean {
    return this.unavailableReason(id) === null;
  }

  // ---- concurrency ---------------------------------------------------------

  async acquire(id: string, signal: AbortSignal): Promise<() => void> {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    while (p.inFlight >= p.def.maxConcurrent) {
      if (signal.aborted) throw new Error("cancelled");
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        // A cancelled waiter must leave the queue, or a later release would wake a dead waiter
        // and strand the live ones behind it.
        const onAbort = () => {
          const i = p.waiters.indexOf(wake);
          if (i >= 0) p.waiters.splice(i, 1);
          resolve();
        };
        p.waiters.push(wake);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    p.inFlight++;
    this.publish(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      p.inFlight--;
      p.waiters.shift()?.();
      this.publish(id);
    };
  }

  // ---- outcome reporting ---------------------------------------------------

  observeWindows(id: string, windows: Record<string, QuotaWindow>): void {
    const p = this.providers.get(id);
    if (!p || !Object.keys(windows).length) return;
    const now = this.clock();
    const prior = p.windows;
    const current = Object.fromEntries(
      Object.entries(windows).filter(([name, window]) => {
        const previous = prior[name];
        return (
          !previous ||
          previous.resetsAt === null ||
          window.resetsAt === null ||
          window.resetsAt >= previous.resetsAt
        );
      }),
    );
    if (!Object.keys(current).length) return;
    p.windows = { ...p.windows, ...current };
    this.persist(id);
    if (p.def.billing !== "subscription") return;
    for (const [name, window] of Object.entries(current)) {
      const cap = this.reserveFor(id, name);
      if (window.resetsAt !== null && window.resetsAt <= now) {
        this.store.clearAlert(id, name);
        continue;
      }
      if (
        prior[name] &&
        prior[name].resetsAt !== window.resetsAt &&
        window.utilization + Number.EPSILON < cap * 0.75
      )
        this.store.clearAlert(id, name);
      if (window.utilization + Number.EPSILON >= cap * 0.75) {
        this.alert(
          id,
          name,
          window.utilization,
          window.resetsAt,
          window.utilization >= cap ? "exhausted" : "warning",
        );
      }
    }
  }

  private alert(
    id: string,
    window: string,
    utilization: number | null,
    resetsAt: number | null,
    severity: QuotaAlert["severity"],
  ): void {
    const routing =
      this.routingFor?.(id, severity === "exhausted") ??
      (severity === "exhausted"
        ? "Router skips this provider; no eligible fallback providers are known."
        : "Provider remains eligible until its reserve is reached.");
    this.store.putAlert({
      provider: id,
      window,
      utilization,
      resetsAt,
      severity,
      routing,
      createdAt: this.clock(),
    });
  }

  record(
    id: string,
    status: InvocationStatus,
    detail?: { exhaustedUntil?: number | null; error?: string | null },
  ): void {
    const p = this.providers.get(id);
    if (!p) return;
    const now = this.clock();
    if (status === "quota") {
      p.exhaustedUntil = detail?.exhaustedUntil ?? now + 60 * 60 * 1000;
      p.exhaustedReason = (detail?.error ?? "quota exhausted").slice(0, 300);
      if (p.def.billing === "subscription") {
        const known = Object.entries(p.windows)
          .filter(([, w]) => w.resetsAt === null || w.resetsAt > now)
          .sort((a, b) => (a[1].resetsAt ?? Infinity) - (b[1].resetsAt ?? Infinity))[0];
        this.alert(
          id,
          known?.[0] ?? "hard_limit",
          known?.[1].utilization ?? null,
          known?.[1].resetsAt ?? detail?.exhaustedUntil ?? null,
          "exhausted",
        );
      }
    } else if (status === "unavailable" || status === "timeout") {
      p.consecutiveFailures++;
      if (p.consecutiveFailures >= CIRCUIT_THRESHOLD) {
        const backoff = Math.min(60, 2 ** (p.consecutiveFailures - CIRCUIT_THRESHOLD)) * 60_000;
        p.circuitOpenUntil = now + backoff;
      }
    } else if (status === "ok" || status === "error") {
      // "error" is a task-level failure, not a provider failure.
      p.consecutiveFailures = 0;
      p.circuitOpenUntil = null;
      if (p.exhaustedUntil && p.exhaustedUntil < now) p.exhaustedUntil = null;
    }
    this.persist(id);
  }

  setHealthy(id: string, healthy: boolean): void {
    const p = this.providers.get(id);
    if (!p || p.healthy === healthy) return;
    p.healthy = healthy;
    this.persist(id);
  }

  /** Probe local model servers; call periodically. */
  async probe(): Promise<void> {
    await Promise.all(
      [...this.providers.values()]
        .filter((p) => p.def.healthUrl)
        .map(async (p) => {
          try {
            const headers: Record<string, string> = {};
            const token = this.authToken(p.def.id);
            if (token) headers.authorization = `Bearer ${token}`;
            const res = await fetch(p.def.healthUrl as string, {
              signal: AbortSignal.timeout(3000),
              headers,
            });
            this.setHealthy(p.def.id, res.ok);
          } catch {
            this.setHealthy(p.def.id, false);
          }
        }),
    );
  }

  status(id: string): ProviderStatus | null {
    const p = this.providers.get(id);
    if (!p) return null;
    const now = this.clock();
    const reason = this.unavailableReason(id, now);
    let state: ProviderStatus["state"] = "ok";
    if (!p.enabled) state = "disabled";
    else if (!p.healthy) state = "down";
    else if (p.exhaustedUntil && p.exhaustedUntil > now) state = "exhausted";
    else if (p.circuitOpenUntil && p.circuitOpenUntil > now) state = "down";
    else if (reason) state = "exhausted";
    else if (p.consecutiveFailures > 0) state = "degraded";
    const budget = this.budgets[id];
    return {
      id,
      label: p.def.label,
      billing: p.def.billing,
      enabled: p.enabled,
      state,
      reason,
      until: p.exhaustedUntil ?? p.circuitOpenUntil,
      windows: p.windows,
      spendUsd: p.def.billing === "metered" ? this.store.providerSpendSince(id, now - MONTH_MS) : null,
      budgetUsd: budget ?? null,
      inFlight: p.inFlight,
      maxConcurrent: p.def.maxConcurrent,
      updatedAt: now,
    };
  }

  all(): ProviderStatus[] {
    return [...this.providers.keys()].map((id) => this.status(id) as ProviderStatus);
  }

  private persist(id: string): void {
    const p = this.providers.get(id);
    if (!p) return;
    const st = this.status(id) as ProviderStatus;
    this.store.putProviderRow({
      provider: id,
      state: st.state,
      reason: st.reason,
      until: st.until,
      windows: p.windows,
      consecutiveFailures: p.consecutiveFailures,
    });
    this.store.publishProvider({ kind: "provider", provider: st });
  }

  private publish(id: string): void {
    const st = this.status(id);
    if (st) this.store.publishProvider({ kind: "provider", provider: st });
  }
}
