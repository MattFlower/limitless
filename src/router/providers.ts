import type { Reserves } from "../config.ts";
import type {
  ConfinementProbe,
  InvocationStatus,
  ProviderStatus,
  QuotaAlert,
  QuotaWindow,
} from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { ProviderDef } from "./catalog.ts";
import { providerKind } from "./config-catalog.ts";

/** How far apart sources report one window's reset (seen: 5 s; allows minute rounding). Windows are hours apart. */
const RESET_JITTER_MS = 60_000;

interface ProviderRuntime {
  def: ProviderDef;
  enabled: boolean;
  fast: boolean;
  fastModeUnavailableReason?: string | null;
  disabledReason: string | null;
  windows: Record<string, QuotaWindow>;
  windowObservedAt: Record<string, number>;
  exhaustedUntil: number | null;
  exhaustedReason: string | null;
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  healthy: boolean; // for local servers: last probe result
  inFlight: number;
  waiters: (() => void)[];
  /** Waiters woken by a release that have not yet taken their slot: no later caller takes it first. */
  waking: number;
  /** Shadow calls holding a slot; a production waiter aborts one and becomes heir to its slot. */
  shadows: Set<ShadowHold>;
  confinement?: ConfinementProbe;
}

type ShadowHold = { preempt: () => void; heir?: () => void };

interface KeyReading {
  usage: number;
  at: number;
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  monthlyPeriod: string | null;
  monthlyResetAt: number | null;
}

function monthlyResetAt(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : value;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  return typeof value === "number" && at < 1e12 ? at * 1000 : at;
}

function sameMonth(prior: KeyReading, next: KeyReading): boolean {
  if (prior.monthlyPeriod !== null && next.monthlyPeriod !== null)
    return prior.monthlyPeriod === next.monthlyPeriod;
  if (prior.monthlyResetAt !== null && next.monthlyResetAt !== null)
    return (
      prior.monthlyResetAt === next.monthlyResetAt &&
      !(prior.at < prior.monthlyResetAt && next.at >= prior.monthlyResetAt)
    );
  return new Date(prior.at).toISOString().slice(0, 7) === new Date(next.at).toISOString().slice(0, 7);
}

const CIRCUIT_THRESHOLD = 3;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_MS = 10 * 60_000;
const PREFLIGHT_MS = 2 * 60_000;

/**
 * Tracks health, quota and concurrency per provider. The router asks it which providers are
 * usable; the pipeline reports every invocation outcome back to it.
 */
export class ProviderTracker {
  private providers = new Map<string, ProviderRuntime>();
  /** Individual models a provider rejected (e.g. not available on this plan). */
  private modelBlocks = new Map<string, { until: number; reason: string }>();
  private routingFor: ((provider: string, exhausted: boolean) => string) | null = null;
  private reading: KeyReading | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    defs: ProviderDef[],
    private readonly store: Store,
    private readonly reserves: Reserves,
    private readonly secrets: Record<string, string>,
    private readonly budgets: Record<string, number> = {},
    private readonly clock: () => number = Date.now,
    private readonly fetchKey: typeof fetch = fetch,
    private readonly timer: { set: typeof setInterval; clear: typeof clearInterval } = {
      set: setInterval,
      clear: clearInterval,
    },
    private readonly fetchHealth: typeof fetch = fetch,
  ) {
    this.budgets = Object.assign(Object.create(null), budgets);
    for (const def of defs) {
      const override = store.getProviderEnabledOverride(def.id);
      let enabled = override ?? true;
      let disabledReason: string | null = null;
      if (!enabled) disabledReason = "disabled";
      if (enabled && def.apiKeySecret && !secrets[def.apiKeySecret]) {
        enabled = false;
        disabledReason = `missing key ${def.apiKeySecret}`;
      }
      const row = store.getProviderRow(def.id);
      const lastFast = def.id === "claude" ? store.latestFastInvocation(def.id) : null;
      if (
        def.id === "openrouter" &&
        typeof row?.reported_usage_usd === "number" &&
        typeof row.reported_at === "number"
      ) {
        this.reading = {
          usage: row.reported_usage_usd,
          at: row.reported_at,
          limit: typeof row.key_limit === "number" ? row.key_limit : null,
          remaining: typeof row.limit_remaining === "number" ? row.limit_remaining : null,
          reset: typeof row.limit_reset === "string" ? row.limit_reset : null,
          monthlyPeriod: typeof row.monthly_period === "string" ? row.monthly_period : null,
          monthlyResetAt: typeof row.monthly_reset_at === "number" ? row.monthly_reset_at : null,
        };
      }
      const windows = row?.windows_json
        ? (JSON.parse(row.windows_json as string) as Record<string, QuotaWindow>)
        : {};
      const windowObservedAt = row?.window_observed_at_json
        ? (JSON.parse(row.window_observed_at_json as string) as Record<string, number>)
        : {};
      const until = (row?.until as number | null) ?? null;
      this.providers.set(def.id, {
        def,
        enabled,
        fast: (def.id === "codex" || def.id === "claude") && row?.fast === 1,
        fastModeUnavailableReason: lastFast?.fastModeState === "off" ? lastFast.fastModeDisabledReason : null,
        disabledReason,
        windows,
        windowObservedAt,
        exhaustedUntil: row?.state === "exhausted" && until && until > clock() ? until : null,
        exhaustedReason: row?.state === "exhausted" ? ((row.reason as string) ?? null) : null,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        healthy: !def.healthUrl, // local servers start unknown→down until probed
        inFlight: 0,
        waiters: [],
        waking: 0,
        shadows: new Set(),
      });
    }
  }

  now(): number {
    return this.clock();
  }

  start(): void {
    this.started = true;
    if (this.pollTimer || !this.isEnabled("openrouter")) return;
    void this.refreshOpenRouter();
    this.pollTimer = this.timer.set(() => {
      void this.refreshOpenRouter();
    }, POLL_MS);
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) this.timer.clear(this.pollTimer);
    this.pollTimer = null;
  }

  async preflight(id: string): Promise<boolean> {
    if (id !== "openrouter") return this.isAvailable(id);
    if (!this.isEnabled(id)) return false;
    if (!this.reading || this.clock() - this.reading.at > PREFLIGHT_MS) await this.refreshOpenRouter();
    return this.reading !== null && this.isAvailable(id);
  }

  refreshOpenRouter(): Promise<boolean> {
    if (!this.isEnabled("openrouter")) return Promise.resolve(false);
    if (this.refreshInFlight) return this.refreshInFlight;
    const request = this.readOpenRouter();
    this.refreshInFlight = request;
    void request.finally(() => {
      if (this.refreshInFlight === request) this.refreshInFlight = null;
    });
    return request;
  }

  private async readOpenRouter(): Promise<boolean> {
    try {
      const response = await this.fetchKey("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${this.authToken("openrouter")}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("data" in body)) return false;
      const data = body.data;
      if (!data || typeof data !== "object") return false;
      const fields = data as Record<string, unknown>;
      if (
        !["usage", "usage_daily", "usage_weekly", "usage_monthly"].every(
          (name) =>
            typeof fields[name] === "number" &&
            Number.isFinite(fields[name]) &&
            (fields[name] as number) >= 0,
        )
      )
        return false;
      const optional = (value: unknown) =>
        value === null || (typeof value === "number" && Number.isFinite(value));
      if (
        !optional(fields.limit) ||
        !optional(fields.limit_remaining) ||
        (fields.limit_reset !== null && typeof fields.limit_reset !== "string")
      )
        return false;
      const period = fields.usage_monthly_period ?? fields.monthly_period;
      const next: KeyReading = {
        usage: fields.usage_monthly as number,
        at: this.clock(),
        limit: fields.limit as number | null,
        remaining: fields.limit_remaining as number | null,
        reset: fields.limit_reset as string | null,
        monthlyPeriod: typeof period === "string" && period.trim() ? period : null,
        monthlyResetAt: monthlyResetAt(
          fields.usage_monthly_reset_at ??
            fields.usage_monthly_reset ??
            fields.monthly_reset_at ??
            fields.monthly_reset,
        ),
      };
      const prior = this.reading;
      if (prior && next.at > prior.at && sameMonth(prior, next)) {
        const reported = next.usage - prior.usage;
        const local = this.store.providerSpendBetween("openrouter", prior.at, next.at);
        const drift = Math.abs(reported - local);
        if (drift > 0.05 && drift > 0.2 * Math.max(reported, local)) {
          this.store.addEvent({
            runId: "provider:openrouter",
            type: "log",
            level: "warn",
            message: `OpenRouter spend drift: reported $${reported.toFixed(4)}, local $${local.toFixed(4)}`,
            data: {
              provider: "openrouter",
              reportedUsd: reported,
              localUsd: local,
              from: prior.at,
              to: next.at,
            },
          });
        }
      }
      this.store.putOpenRouterReading(next);
      this.reading = next;
      this.publish("openrouter");
      this.refreshAlerts();
      return true;
    } catch {
      return false;
    }
  }

  setRoutingDescription(describe: (provider: string, exhausted: boolean) => string): void {
    this.routingFor = describe;
    this.refreshAlerts();
  }

  /** Eligibility can change without new telemetry from the alerted provider. */
  refreshAlerts(): void {
    this.store.expireAlerts(this.clock());
    if (!this.routingFor) return;
    for (const alert of this.store.listAlerts(this.clock())) {
      const routing = this.routingFor(alert.provider, this.status(alert.provider)?.state === "exhausted");
      if (routing !== alert.routing) this.store.putAlert({ ...alert, routing });
    }
  }

  isEnabled(id: string): boolean {
    return this.providers.get(id)?.enabled ?? false;
  }

  isFast(id: string): boolean {
    return this.providers.get(id)?.fast ?? false;
  }

  setFast(id: string, fast: boolean): ProviderStatus {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    if (id !== "codex" && id !== "claude") throw new Error(`fast mode unsupported for provider ${id}`);
    this.store.setProviderFast(id, fast);
    p.fast = fast;
    this.publish(id);
    return this.status(id) as ProviderStatus;
  }

  observeFast(
    id: string,
    requested: boolean,
    result: { fastModeState?: string | null; fastModeDisabledReason?: string | null },
  ): void {
    const p = this.providers.get(id);
    if (!p || id !== "claude" || !requested) return;
    p.fastModeUnavailableReason =
      result.fastModeState === "off" ? (result.fastModeDisabledReason ?? null) : null;
    this.publish(id);
  }

  setEnabled(id: string, enabled: boolean): ProviderStatus {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    const wasEnabled = p.enabled;
    this.store.setProviderEnabledOverride(id, enabled);
    p.enabled = enabled && (!p.def.apiKeySecret || !!this.secrets[p.def.apiKeySecret]);
    if (p.enabled && !wasEnabled && p.def.healthUrl) p.healthy = false;
    p.disabledReason = !enabled ? "disabled" : p.enabled ? null : `missing key ${p.def.apiKeySecret}`;
    if (id === "openrouter") {
      if (!p.enabled && this.pollTimer) {
        this.timer.clear(this.pollTimer);
        this.pollTimer = null;
      } else if (p.enabled && this.started) this.start();
    }
    if (p.enabled && p.def.healthUrl && this.started) void this.probeProvider(p);
    this.publish(id);
    this.refreshAlerts();
    return this.status(id) as ProviderStatus;
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
      const spent = Math.max(
        this.store.providerSpendSince(id, now - MONTH_MS),
        id === "openrouter" ? (this.reading?.usage ?? 0) : 0,
      );
      min = Math.min(min, (budget - spent) / budget);
    }
    if (
      id === "openrouter" &&
      this.reading?.remaining !== null &&
      this.reading?.remaining !== undefined &&
      this.reading.remaining <= 0
    )
      return 0;
    return min;
  }

  private reserveFor(id: string, window: string): number {
    const configured = this.reserves.windows?.[id]?.[window];
    if (configured !== undefined) return configured;
    const def = this.providers.get(id)?.def;
    const kind = def && providerKind(def);
    if (kind === "claude-cli" && window === "five_hour") return this.reserves.claudeFiveHour;
    if (kind === "claude-cli" && window === "seven_day") return this.reserves.claudeSevenDay;
    if (kind === "codex-cli" && window === "five_hour") return this.reserves.codexFiveHour;
    if (kind === "codex-cli" && window === "seven_day") return this.reserves.codexWeekly;
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

  budgetUnavailableReason(id: string, now = this.clock()): string | null {
    const budget = this.budgets[id];
    return budget !== undefined &&
      (!(budget > 0) || this.store.providerSpendSince(id, now - MONTH_MS) >= budget)
      ? "provider budget exhausted"
      : null;
  }

  blockModel(modelId: string, reason: string, ms = 24 * 60 * 60 * 1000, label = "model rejected"): void {
    this.modelBlocks.set(modelId, { until: this.clock() + ms, reason: `${label}: ${reason.slice(0, 200)}` });
    this.refreshAlerts();
  }

  modelUnavailableReason(modelId: string, now = this.clock()): string | null {
    const block = this.modelBlocks.get(modelId);
    return block && block.until > now ? block.reason : null;
  }

  isAvailable(id: string): boolean {
    return this.unavailableReason(id) === null;
  }

  // ---- concurrency ---------------------------------------------------------

  /** Race providers in preference order, releasing every unused reservation. */
  async acquireFirst(
    ids: string[],
    signal: AbortSignal,
    waitMs: number | undefined,
    onWait: (id: string, ahead: number) => void,
  ): Promise<{ provider: string; release: () => void } | null> {
    const cancel = new AbortController();
    const combined = AbortSignal.any([signal, cancel.signal]);
    const pending = ids.map(async (provider) => ({
      provider,
      release: await this.acquire(provider, combined, waitMs, (ahead) => onWait(provider, ahead)),
    }));
    let failure: unknown;
    await Promise.race(pending).catch((error: unknown) => {
      failure = error;
    });
    cancel.abort();
    const results = await Promise.allSettled(pending);
    let chosen: { provider: string; release: () => void } | null = null;
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value.release) continue;
      if (!chosen && !signal.aborted && !failure) chosen = { ...result.value, release: result.value.release };
      else result.value.release();
    }
    if (signal.aborted) throw new Error("cancelled");
    if (failure) throw failure;
    return chosen;
  }

  acquire(id: string, signal: AbortSignal): Promise<() => void>;
  acquire(
    id: string,
    signal: AbortSignal,
    waitMs: number | undefined,
    onWait?: (ahead: number) => void,
  ): Promise<(() => void) | null>;
  async acquire(
    id: string,
    signal: AbortSignal,
    waitMs?: number,
    onWait?: (ahead: number) => void,
  ): Promise<(() => void) | null> {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    const end = waitMs === undefined ? Infinity : this.clock() + waitMs;
    let notified = false;
    while (p.inFlight + p.waking >= p.def.maxConcurrent) {
      if (signal.aborted) throw new Error("cancelled");
      if (!notified) {
        onWait?.(p.waiters.length);
        notified = true;
      }
      if (signal.aborted) throw new Error("cancelled");
      if (this.clock() >= end) return null;
      // Production never waits behind a shadow call: abort one, and take its slot ahead of the queue.
      const shadow = [...p.shadows].find((s) => !s.heir);
      const woken = await new Promise<boolean>((resolve) => {
        let timeout: ReturnType<typeof setInterval> | undefined;
        const wake = () => {
          if (timeout !== undefined) this.timer.clear(timeout);
          signal.removeEventListener("abort", leave);
          p.waking++;
          resolve(true);
        };
        // A cancelled or expired waiter must leave the queue, or a later release would wake a dead
        // waiter and strand the live ones behind it. A claim on a shadow's slot passes to the head of
        // the queue, so a newcomer cannot take it ahead of an older waiter.
        const leave = () => {
          if (timeout !== undefined) this.timer.clear(timeout);
          signal.removeEventListener("abort", leave);
          for (const held of p.shadows) if (held.heir === wake) held.heir = p.waiters.shift();
          const i = p.waiters.indexOf(wake);
          if (i >= 0) p.waiters.splice(i, 1);
          resolve(false);
        };
        if (shadow) shadow.heir = wake;
        else p.waiters.push(wake);
        signal.addEventListener("abort", leave, { once: true });
        if (Number.isFinite(end))
          timeout = this.timer.set(leave, Math.min(end - this.clock(), 2_147_483_647));
        shadow?.preempt();
      });
      if (woken) p.waking--;
    }
    const release = this.hold(p);
    // Cancelled after its wake, or past the deadline when the slot freed: hand the slot on.
    if (signal.aborted) {
      release();
      throw new Error("cancelled");
    }
    if (notified && this.clock() >= end) {
      release();
      return null;
    }
    return release;
  }

  /** Shadow admission needs two free slots and no waiting production; `preempt` cancels this call. */
  tryAcquire(id: string, preempt: () => void): (() => void) | null {
    const p = this.providers.get(id);
    if (!p || p.inFlight + 2 > p.def.maxConcurrent || p.waiters.length || p.waking) return null;
    if ([...p.shadows].some((s) => s.heir)) return null;
    const shadow = { preempt };
    p.shadows.add(shadow);
    return this.hold(p, shadow);
  }

  private hold(p: ProviderRuntime, shadow?: ShadowHold): () => void {
    const id = p.def.id;
    p.inFlight++;
    this.publish(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (shadow) p.shadows.delete(shadow);
      p.inFlight--;
      // A preempted shadow's slot goes to its heir; any other free slot to the earliest pending heir.
      const heir = shadow?.heir ? shadow : [...p.shadows].find((s) => s.heir);
      const next = heir?.heir ?? p.waiters.shift();
      if (heir) heir.heir = undefined;
      next?.();
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
        // Only a reading from an earlier window is stale. Sources report one window's reset a few
        // seconds apart, so a slightly earlier resetsAt is still the current window.
        return (
          !previous ||
          previous.resetsAt === null ||
          window.resetsAt === null ||
          window.resetsAt >= previous.resetsAt - RESET_JITTER_MS
        );
      }),
    );
    if (!Object.keys(current).length) return;
    p.windows = { ...p.windows, ...current };
    for (const name of Object.keys(current)) p.windowObservedAt[name] = now;
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
      this.routingFor?.(id, this.status(id)?.state === "exhausted") ??
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
    detail?: {
      exhaustedUntil?: number | null;
      error?: string | null;
      /** A per-model rate limit (AgentResult.modelCooldownMs) leaves the provider's other models routable. */
      modelCooldown?: { modelId: string; ms: number };
    },
  ): void {
    const p = this.providers.get(id);
    if (!p) return;
    const now = this.clock();
    if (status === "quota" && detail?.modelCooldown) {
      const { modelId, ms } = detail.modelCooldown;
      this.blockModel(modelId, detail.error ?? "rate limited", ms, "model cooling down");
    } else if (status === "quota") {
      p.exhaustedUntil = detail?.exhaustedUntil ?? now + 60 * 60 * 1000;
      p.exhaustedReason = (detail?.error ?? "quota exhausted").slice(0, 300);
      if (p.def.billing === "subscription") {
        const known = Object.entries(p.windows)
          .filter(
            ([name, w]) =>
              (w.resetsAt === null || w.resetsAt > now) && w.utilization >= this.reserveFor(id, name),
          )
          .sort((a, b) => (a[1].resetsAt ?? Infinity) - (b[1].resetsAt ?? Infinity))[0];
        let resetsAt = known ? known[1].resetsAt : (detail?.exhaustedUntil ?? null);
        if (!known) {
          // Retry cooldown estimates move on every rejection; reuse the durable alert boundary
          // until it expires, including across restarts or changes in provider health.
          const existing = this.store
            .listAlerts(now)
            .find((alert) => alert.provider === id && alert.window === "hard_limit");
          if (existing) resetsAt = existing.resetsAt;
        }
        this.alert(id, known?.[0] ?? "hard_limit", known?.[1].utilization ?? null, resetsAt, "exhausted");
      }
    } else if (status === "unavailable" || status === "timeout") {
      p.consecutiveFailures++;
      if (p.consecutiveFailures >= CIRCUIT_THRESHOLD) {
        const backoff = Math.min(60, 2 ** (p.consecutiveFailures - CIRCUIT_THRESHOLD)) * 60_000;
        p.circuitOpenUntil = now + backoff;
      }
    } else if (status === "ok" || status === "error" || status === "declined") {
      // "error" is a task-level failure; "declined" is an answer the caller chose not to use.
      p.consecutiveFailures = 0;
      p.circuitOpenUntil = null;
      if (p.exhaustedUntil && p.exhaustedUntil < now) p.exhaustedUntil = null;
    }
    this.persist(id);
  }

  /** Shown on the provider card; a failed probe only diverts confined readers, not the provider. */
  observeConfinement(id: string, probe: ConfinementProbe): void {
    const p = this.providers.get(id);
    if (!p) return;
    p.confinement = probe;
    this.publish(id);
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
        .filter((p) => p.enabled && p.def.healthUrl)
        .map((p) => this.probeProvider(p)),
    );
  }

  private async probeProvider(p: ProviderRuntime): Promise<void> {
    if (!p.enabled || !p.def.healthUrl) return;
    try {
      const headers: Record<string, string> = {};
      const token = this.authToken(p.def.id);
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await this.fetchHealth(p.def.healthUrl, {
        signal: AbortSignal.timeout(3000),
        headers,
      });
      if (p.enabled) this.setHealthy(p.def.id, res.ok);
    } catch {
      if (p.enabled) this.setHealthy(p.def.id, false);
    }
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
      kind: providerKind(p.def),
      billing: p.def.billing,
      enabled: p.enabled,
      fast: p.fast,
      supportsFast: id === "codex" || id === "claude",
      fastModeUnavailableReason: p.fast ? (p.fastModeUnavailableReason ?? null) : null,
      state,
      reason,
      until: p.exhaustedUntil ?? p.circuitOpenUntil,
      windows: Object.fromEntries(
        Object.entries(p.windows).map(([name, window]) => [
          name,
          { ...window, observedAt: p.windowObservedAt[name] ?? null },
        ]),
      ),
      spendUsd: p.def.billing === "metered" ? this.store.providerSpendSince(id, now - MONTH_MS) : null,
      budgetUsd: budget ?? null,
      ...(id === "openrouter"
        ? {
            reportedUsageUsd: this.reading?.usage ?? null,
            reportedAt: this.reading?.at ?? null,
            limit: this.reading?.limit ?? null,
            limitRemaining: this.reading?.remaining ?? null,
            limitReset: this.reading?.reset ?? null,
          }
        : {}),
      inFlight: p.inFlight,
      maxConcurrent: p.def.maxConcurrent,
      updatedAt: now,
      ...(p.confinement ? { confinement: p.confinement } : {}),
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
      windowObservedAt: p.windowObservedAt,
      consecutiveFailures: p.consecutiveFailures,
    });
    this.store.publishProvider({ kind: "provider", provider: st });
    this.refreshAlerts();
  }

  private publish(id: string): void {
    const st = this.status(id);
    if (st) this.store.publishProvider({ kind: "provider", provider: st });
  }
}
