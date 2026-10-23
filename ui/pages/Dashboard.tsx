import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { Stats } from "../../src/db/stats.ts";
import { getStats } from "../api.ts";
import { CostCell } from "../components/CostCell.tsx";
import { CostChart } from "../components/CostChart.tsx";
import { FilterChips, matchesRunFilter, type RunFilter } from "../components/FilterChips.tsx";
import { KpiStrip } from "../components/KpiStrip.tsx";
import { PipelineMap } from "../components/PipelineMap.tsx";
import { RunsTable } from "../components/RunsTable.tsx";
import { padDays } from "../lib/days.ts";
import { ensureLiveStore, live, subscribeLiveUpdates } from "../store.ts";

const STATS_REFRESH_MS = 30_000;

export const Dashboard: Component = () => {
  ensureLiveStore();
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [statusFilter, setStatusFilter] = createSignal<RunFilter | null>(null);

  let statsRequest = 0;
  let statsRefresh: ReturnType<typeof setTimeout> | undefined;
  const refreshStats = () => {
    clearTimeout(statsRefresh);
    statsRefresh = undefined;
    const request = ++statsRequest;
    getStats(14)
      .then((next) => request === statsRequest && setStats(next))
      .catch(() => {});
  };
  const scheduleStats = () => {
    statsRefresh ??= setTimeout(refreshStats, 250);
  };
  onMount(() => {
    refreshStats();
    const close = subscribeLiveUpdates((msg) => {
      if (["feed", "github_pr", "reconnected"].includes(msg.kind)) scheduleStats();
    });
    const t = setInterval(refreshStats, STATS_REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      close();
      statsRequest++;
      clearTimeout(statsRefresh);
      clearInterval(t);
      clearInterval(clock);
    });
  });

  const runs = createMemo(() => Object.values(live.runs).sort((a, b) => b.createdAt - a.createdAt));
  const needsYouCount = createMemo(
    () => runs().filter((r) => matchesRunFilter(r.status, "needs_you")).length,
  );
  createEffect(on(needsYouCount, scheduleStats, { defer: true }));
  const attention = createMemo(() => {
    const ids = stats()?.needsYouRunIds;
    return ids ? new Set(ids) : undefined;
  });
  const filteredRuns = createMemo(() => {
    const f = statusFilter();
    return f ? runs().filter((r) => matchesRunFilter(r.status, f, attention()?.has(r.id))) : runs();
  });
  // Re-pad only when the stats or the calendar day change, not on every clock tick, so the chart's
  // bars (and a focused bar's tooltip) are not rebuilt each second.
  const today = createMemo(() => new Date(now()).toDateString());
  const chartDays = createMemo(() => {
    today();
    const s = stats();
    return s ? padDays(s.days, 14, untrack(now)) : [];
  });
  const delivered = createMemo(() => {
    const totals = stats()?.totals;
    return totals ? { succeeded: totals.succeeded, runs: totals.runs } : undefined;
  });
  const alerts = createMemo(() =>
    Object.values(live.alerts).filter((a) => a.resetsAt === null || a.resetsAt > now()),
  );

  return (
    <div class="page stack">
      <div class="page-header">
        <div>
          <h1 class="page-title">Mission control</h1>
          <Show when={stats()}>
            {(s) => (
              <p class="page-subtitle">
                {s().totals.runs} {s().totals.runs === 1 ? "run" : "runs"} in the last 14 days ·{" "}
                {s().totals.openNeedsHuman === 0
                  ? "nothing needs you right now"
                  : `${s().totals.openNeedsHuman} ${s().totals.openNeedsHuman === 1 ? "needs" : "need"} you`}
              </p>
            )}
          </Show>
        </div>
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

      <PipelineMap runs={runs()} delivered={delivered()} />

      <Show when={stats()} fallback={<div class="centered-hint">loading stats…</div>}>
        {(s) => <KpiStrip totals={s().totals} />}
      </Show>

      <div class="grid-2">
        <div class="card card-pad">
          <h2 class="card-title">Cost per day · 14d</h2>
          <Show when={stats()} fallback={<div class="centered-hint">loading…</div>}>
            <CostChart days={chartDays()} />
          </Show>
        </div>
        <div class="card card-pad">
          <h2 class="card-title">By model · 14d</h2>
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
        <div class="page-header runs-header">
          <h2 class="section-title">Runs</h2>
          <FilterChips active={statusFilter()} onChange={setStatusFilter} />
        </div>
        <div class="card">
          <RunsTable runs={filteredRuns()} />
        </div>
      </div>
    </div>
  );
};
