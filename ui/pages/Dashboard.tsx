import type { Component } from "solid-js";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { RunStatus } from "../../src/core/types.ts";
import type { ProviderWorkload, Stats } from "../../src/db/stats.ts";
import { getProviderWorkload, getStats } from "../api.ts";
import { CostCell } from "../components/CostCell.tsx";
import { CostChart } from "../components/CostChart.tsx";
import { FilterChips } from "../components/FilterChips.tsx";
import { KpiStrip } from "../components/KpiStrip.tsx";
import { ProviderCard } from "../components/ProviderCard.tsx";
import { RunsTable } from "../components/RunsTable.tsx";
import { workloadFor } from "../lib/provider-workload.ts";
import { ensureLiveStore, live } from "../store.ts";

const STATS_REFRESH_MS = 30_000;

export const Dashboard: Component = () => {
  ensureLiveStore();
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [workload, setWorkload] = createSignal<ProviderWorkload[]>([]);
  const [now, setNow] = createSignal(Date.now());
  const [statusFilter, setStatusFilter] = createSignal<RunStatus | null>(null);

  const refreshStats = () => {
    getStats(14)
      .then(setStats)
      .catch(() => {});
    getProviderWorkload()
      .then(setWorkload)
      .catch(() => {});
  };
  onMount(() => {
    refreshStats();
    const t = setInterval(refreshStats, STATS_REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      clearInterval(t);
      clearInterval(clock);
    });
  });

  const runs = createMemo(() => Object.values(live.runs).sort((a, b) => b.createdAt - a.createdAt));
  const filteredRuns = createMemo(() => {
    const f = statusFilter();
    return f ? runs().filter((r) => r.status === f) : runs();
  });
  const providers = createMemo(() => Object.values(live.providers).sort((a, b) => a.id.localeCompare(b.id)));
  const alerts = createMemo(() =>
    Object.values(live.alerts).filter((a) => a.resetsAt === null || a.resetsAt > now()),
  );

  return (
    <div class="page stack">
      <div class="page-header">
        <h1 class="page-title">Mission control</h1>
      </div>

      <For each={alerts()}>
        {(alert) => (
          <div class={`quota-alert quota-alert--${alert.severity}`} role="alert">
            <strong>
              Quota {alert.severity}: {alert.provider} · {alert.window}
            </strong>
            <span>
              {alert.utilization === null
                ? "Utilization unknown"
                : `${(alert.utilization * 100).toFixed(1)}% utilization`}
            </span>
            <span>
              Resets {alert.resetsAt === null ? "unknown" : new Date(alert.resetsAt).toLocaleString()}
            </span>
            <span>{alert.routing}</span>
          </div>
        )}
      </For>

      <Show when={stats()} fallback={<div class="centered-hint">loading stats…</div>}>
        {(s) => <KpiStrip totals={s().totals} />}
      </Show>

      <div>
        <div class="section-label">Providers</div>
        <div class="provider-grid">
          <For each={providers()}>
            {(p) => <ProviderCard provider={p} workload={workloadFor(p.id, workload())} />}
          </For>
          <Show when={providers().length === 0}>
            <div class="hint-banner">No provider telemetry yet.</div>
          </Show>
        </div>
      </div>

      <div class="grid-2">
        <div class="card card-pad">
          <div class="section-label">Cost per day (14d)</div>
          <Show when={stats()} fallback={<div class="centered-hint">loading…</div>}>
            {(s) => <CostChart days={s().days} />}
          </Show>
        </div>
        <div class="card card-pad">
          <div class="section-label">By model (14d)</div>
          <Show when={stats()} fallback={<div class="centered-hint">loading…</div>}>
            {(s) => (
              <table class="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Role</th>
                    <th class="num">Invocations</th>
                    <th class="num">Ok</th>
                    <th class="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={s().models.slice(0, 8)}>
                    {(m) => (
                      <tr>
                        <td class="mono text-accent">{m.modelId}</td>
                        <td class="mono text-faint">{m.role}</td>
                        <td class="num mono">{m.invocations}</td>
                        <td class="num mono">{m.ok}</td>
                        <CostCell costUsd={m.costUsd} costEquivUsd={m.costEquivUsd} />
                      </tr>
                    )}
                  </For>
                  <Show when={s().models.length === 0}>
                    <tr class="empty-row">
                      <td colspan={5}>No invocations yet.</td>
                    </tr>
                  </Show>
                </tbody>
              </table>
            )}
          </Show>
        </div>
      </div>

      <div>
        <div class="page-header" style={{ "margin-bottom": "10px" }}>
          <div class="section-label" style={{ "margin-bottom": 0 }}>
            Runs
          </div>
          <FilterChips active={statusFilter()} onChange={setStatusFilter} />
        </div>
        <div class="card">
          <RunsTable runs={filteredRuns()} />
        </div>
      </div>
    </div>
  );
};
