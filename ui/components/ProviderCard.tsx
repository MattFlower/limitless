import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { observationAge } from "../../src/core/quota-format.ts";
import type { ProviderStatus } from "../../src/core/types.ts";
import type { ProviderWorkload, WorkloadTotals } from "../../src/db/stats.ts";
import { setProviderEnabled } from "../api.ts";
import { compactNumber, duration, money, pct, resetsIn } from "../lib/format.ts";
import { now } from "../lib/ticker.ts";
import { windowLabel } from "../lib/window-label.ts";
import { ProviderStatePill } from "./StatusPill.tsx";

function gaugeClass(util: number): string {
  if (util >= 0.9) return "crit";
  if (util >= 0.7) return "warn";
  return "";
}

function openRouterDetails(provider: ProviderStatus): string {
  const estimate = provider.spendUsd ?? 0;
  const reported = provider.reportedUsageUsd;
  const materialDifference =
    reported != null && Math.abs(reported - estimate) > Math.max(0.5, estimate * 0.1);
  const key = provider.limitRemaining == null ? "unavailable" : money(provider.limitRemaining);
  const limit = provider.limit == null ? "unavailable" : money(provider.limit);
  return `key ${key} left of ${limit} · resets ${provider.limitReset ?? "unavailable"}${materialDifference ? ` · reported this month ${money(reported)}` : ""}`;
}

const Gauge: Component<{
  label: string;
  value: string;
  utilization?: number;
  barWidth?: string;
  details?: string;
  title?: string;
}> = (props) => (
  <div class="gauge" title={props.title}>
    <div class="gauge-label">
      <span>{props.label}</span>
      <span class="gauge-value">{props.value}</span>
    </div>
    <Show when={props.utilization !== undefined}>
      <div class="gauge-track">
        <div
          class={`gauge-fill ${gaugeClass(props.utilization ?? 0)}`}
          style={{ width: props.barWidth ?? pct(props.utilization ?? 0) }}
        />
      </div>
    </Show>
    <Show when={props.details}>
      <div class="gauge-details">{props.details}</div>
    </Show>
  </div>
);

export const ProviderCard: Component<{ provider: ProviderStatus; workload?: ProviderWorkload }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      await setProviderEnabled(props.provider.id, !props.provider.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider update failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card provider-card">
      <div class="provider-card-top">
        <div class="provider-head">
          <span class="provider-name">{props.provider.label}</span>
          <ProviderStatePill state={props.provider.state} />
        </div>
        <button type="button" class="btn btn-sm" disabled={busy()} onClick={() => void toggle()}>
          {busy() ? "Updating…" : props.provider.enabled ? "Disable" : "Enable"}
        </button>
        <Show when={error()}>
          <div class="provider-reason" role="alert">
            {error()}
          </div>
        </Show>
        <Show when={props.provider.reason}>
          <div class="provider-reason">{props.provider.reason}</div>
        </Show>
        <div class="provider-meta">
          <span>
            in-flight <span class="mono">{props.provider.inFlight}</span>/{props.provider.maxConcurrent}
          </span>
          <span class="text-faint">{props.provider.billing}</span>
        </div>
        <div class="provider-workload">
          <div class="provider-workload-head">
            <span>Workload</span>
            <span>Today</span>
            <span>7 days</span>
          </div>
          <For
            each={
              [
                ["Invocations", (w: WorkloadTotals) => String(w.invocations)],
                ["Tokens in", (w: WorkloadTotals) => compactNumber(w.tokensIn)],
                ["Tokens out", (w: WorkloadTotals) => compactNumber(w.tokensOut)],
                ["Wall time", (w: WorkloadTotals) => duration(w.wallTimeMs)],
                [
                  props.provider.billing === "free" ? "Saved (API-equiv.)" : "API-equivalent",
                  (w: WorkloadTotals) => money(w.costEquivUsd),
                ],
              ] as const
            }
          >
            {([label, format]) => (
              <div class="provider-workload-row">
                <span>{label}</span>
                <span>{format(props.workload?.today ?? ZERO_WORKLOAD)}</span>
                <span>{format(props.workload?.sevenDays ?? ZERO_WORKLOAD)}</span>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="provider-gauges">
        <For each={Object.entries(props.provider.windows)}>
          {([name, w]) => (
            <Gauge
              label={windowLabel(name)}
              value={pct(w.utilization)}
              utilization={w.utilization}
              details={`${w.resetsAt === null ? "" : `${resetsIn(w.resetsAt, now())} · `}${observationAge(w.observedAt, now()).replace(/^as of /, "updated ")}`}
            />
          )}
        </For>
        <Show when={props.provider.spendUsd !== null}>
          <Gauge
            label="30-day spend"
            value={`${money(props.provider.spendUsd ?? 0)}${props.provider.budgetUsd ? ` / ${money(props.provider.budgetUsd)}` : ""}`}
            utilization={
              props.provider.budgetUsd ? (props.provider.spendUsd ?? 0) / props.provider.budgetUsd : undefined
            }
            barWidth={
              props.provider.budgetUsd
                ? `${Math.min(100, Math.round(((props.provider.spendUsd ?? 0) / props.provider.budgetUsd) * 100))}%`
                : undefined
            }
            title={
              props.provider.id === "openrouter" && props.provider.reportedAt != null
                ? `reading ${new Date(props.provider.reportedAt).toLocaleString()}`
                : undefined
            }
            details={props.provider.id === "openrouter" ? openRouterDetails(props.provider) : ""}
          />
        </Show>
      </div>
    </div>
  );
};

const ZERO_WORKLOAD: WorkloadTotals = {
  invocations: 0,
  tokensIn: 0,
  tokensOut: 0,
  wallTimeMs: 0,
  costEquivUsd: 0,
};
