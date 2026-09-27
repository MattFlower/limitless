import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { DayStats } from "../../src/db/stats.ts";

function chartMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function costBarLabel(day: DayStats): string {
  return `${dayLabel(day.day)}: metered ${chartMoney(day.costUsd)}, subscription/local ${chartMoney(Math.max(0, day.costEquivUsd - day.costUsd))}, API-equivalent total ${chartMoney(Math.max(day.costUsd, day.costEquivUsd))}, ${day.runs} ${day.runs === 1 ? "run" : "runs"}`;
}

export const CostChart: Component<{ days: DayStats[] }> = (props) => {
  const max = createMemo(() => Math.max(0.01, ...props.days.map((d) => Math.max(d.costUsd, d.costEquivUsd))));
  const totals = createMemo(() =>
    props.days.reduce(
      (sum, d) => ({ metered: sum.metered + d.costUsd, equivalent: sum.equivalent + d.costEquivUsd }),
      { metered: 0, equivalent: 0 },
    ),
  );

  return (
    <div class={`cost-chart ${props.days.length > 7 ? "cost-chart-dense" : ""}`}>
      <Show when={props.days.length} fallback={<div class="cost-empty">No cost data in this range.</div>}>
        <div class="cost-bars">
          <For each={props.days}>
            {(d) => {
              const total = () => Math.max(d.costUsd, d.costEquivUsd);
              const height = () => (total() / max()) * 100;
              const metered = () => (d.costUsd / max()) * 100;
              const subscription = () => (Math.max(0, d.costEquivUsd - d.costUsd) / max()) * 100;
              return (
                <div class="cost-column">
                  <div
                    class="cost-bar"
                    tabindex="0"
                    role="img"
                    title={costBarLabel(d)}
                    aria-label={costBarLabel(d)}
                  >
                    <span class="cost-tooltip" aria-hidden="true">
                      <strong>{dayLabel(d.day)}</strong>
                      <span>Metered: {chartMoney(d.costUsd)}</span>
                      <span>Subscription/local: {chartMoney(Math.max(0, d.costEquivUsd - d.costUsd))}</span>
                      <span>API-equivalent total: {chartMoney(total())}</span>
                      <span>Runs: {d.runs}</span>
                    </span>
                    <Show
                      when={
                        height() >= 18 &&
                        total() > 0 &&
                        (props.days.length <= 7 || chartMoney(total()).length <= 6)
                      }
                    >
                      <span class="cost-value" style={{ bottom: `${height()}%` }}>
                        {chartMoney(total())}
                      </span>
                    </Show>
                    <span class="cost-stack" style={{ height: `${height()}%` }}>
                      <span
                        class="cost-equivalent"
                        style={{ height: `${(subscription() / (height() || 1)) * 100}%` }}
                      />
                      <span
                        class="cost-metered"
                        style={{ height: `${(metered() / (height() || 1)) * 100}%` }}
                      />
                    </span>
                    <Show when={height() === 0}>
                      <span class="cost-zero" />
                    </Show>
                  </div>
                  <span class="cost-day">
                    {new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={props.days.length}>
        <div class="cost-totals">
          <span>
            Visible range · Metered <strong>{chartMoney(totals().metered)}</strong>
          </span>
          <span>
            API-equivalent total <strong>{chartMoney(totals().equivalent)}</strong>
          </span>
        </div>
        <div class="cost-legend">
          <span class="cost-legend-metered" /> Metered <span class="cost-legend-equivalent" />{" "}
          Subscription/local
        </div>
      </Show>
    </div>
  );
};
