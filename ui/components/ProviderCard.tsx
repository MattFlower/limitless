import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { observationAge } from "../../src/core/quota-format.ts";
import type { ProviderStatus } from "../../src/core/types.ts";
import { setProviderEnabled } from "../api.ts";
import { money, pct, resetsIn } from "../lib/format.ts";
import { now } from "../lib/ticker.ts";
import { ProviderStatePill } from "./StatusPill.tsx";

const WINDOW_LABEL: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
};

function gaugeClass(util: number): string {
  if (util >= 0.9) return "crit";
  if (util >= 0.7) return "warn";
  return "";
}

export const ProviderCard: Component<{ provider: ProviderStatus }> = (props) => {
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
      <For each={Object.entries(props.provider.windows)}>
        {([name, w]) => (
          <div class="gauge">
            <div class="gauge-label">
              <span>{WINDOW_LABEL[name] ?? name}</span>
              <span>
                {pct(w.utilization)} · {observationAge(w.observedAt, now())}
                {w.resetsAt === null ? "" : ` · ${resetsIn(w.resetsAt, now())}`}
              </span>
            </div>
            <div class="gauge-track">
              <div class={`gauge-fill ${gaugeClass(w.utilization)}`} style={{ width: pct(w.utilization) }} />
            </div>
          </div>
        )}
      </For>
      <Show when={props.provider.spendUsd !== null}>
        <div class="gauge">
          <div class="gauge-label">
            <span>spend (30d)</span>
            <span>
              {money(props.provider.spendUsd ?? 0)}
              {props.provider.budgetUsd ? ` / ${money(props.provider.budgetUsd)}` : ""}
            </span>
          </div>
          <Show when={props.provider.budgetUsd}>
            <div class="gauge-track">
              <div
                class={`gauge-fill ${gaugeClass((props.provider.spendUsd ?? 0) / (props.provider.budgetUsd as number))}`}
                style={{
                  width: `${Math.min(100, Math.round(((props.provider.spendUsd ?? 0) / (props.provider.budgetUsd as number)) * 100))}%`,
                }}
              />
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.provider.id === "openrouter"}>
        <div class="provider-meta">
          <span>
            estimated (30d) {money(props.provider.spendUsd ?? 0)} vs reported (monthly){" "}
            {props.provider.reportedUsageUsd === null || props.provider.reportedUsageUsd === undefined
              ? "unavailable"
              : money(props.provider.reportedUsageUsd)}
          </span>
        </div>
        <div class="provider-meta">
          <span>
            reading{" "}
            {props.provider.reportedAt === null || props.provider.reportedAt === undefined
              ? "unavailable"
              : new Date(props.provider.reportedAt).toLocaleString()}
          </span>
        </div>
        <div class="provider-meta">
          <span>
            key limit{" "}
            {props.provider.limit === null || props.provider.limit === undefined
              ? "unavailable"
              : money(props.provider.limit)}{" "}
            · remaining{" "}
            {props.provider.limitRemaining === null || props.provider.limitRemaining === undefined
              ? "unavailable"
              : money(props.provider.limitRemaining)}{" "}
            · reset {props.provider.limitReset ?? "unavailable"}
          </span>
        </div>
      </Show>
    </div>
  );
};
