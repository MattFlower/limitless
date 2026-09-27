import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { DayStats } from "../../src/db/stats.ts";
import { money } from "../lib/format.ts";

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function costBarLabel(day: DayStats): string {
  return `${dayLabel(day.day)}: metered ${money(day.costUsd)}, API-equivalent ${money(day.costEquivUsd)}, ${day.runs} ${day.runs === 1 ? "run" : "runs"}`;
}

export const CostChart: Component<{ days: DayStats[] }> = (props) => {
  const max = createMemo(() => Math.max(0.01, ...props.days.map((d) => d.costUsd + d.costEquivUsd)));
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
              const height = () => ((d.costUsd + d.costEquivUsd) / max()) * 100;
              const metered = () => (d.costUsd / max()) * 100;
              const equivalent = () => (d.costEquivUsd / max()) * 100;
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
                      <span>Metered: {money(d.costUsd)}</span>
                      <span>API-equivalent: {money(d.costEquivUsd)}</span>
                      <span>Runs: {d.runs}</span>
                    </span>
                    <Show
                      when={
                        height() >= 18 &&
                        d.costUsd + d.costEquivUsd > 0 &&
                        (props.days.length <= 7 || money(d.costUsd + d.costEquivUsd).length <= 6)
                      }
                    >
                      <span class="cost-value" style={{ bottom: `${height()}%` }}>
                        {money(d.costUsd + d.costEquivUsd)}
                      </span>
                    </Show>
                    <span class="cost-stack" style={{ height: `${height()}%` }}>
                      <span
                        class="cost-equivalent"
                        style={{ height: `${(equivalent() / (height() || 1)) * 100}%` }}
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
            Visible range · Metered <strong>{money(totals().metered)}</strong>
          </span>
          <span>
            API-equivalent <strong>{money(totals().equivalent)}</strong>
          </span>
        </div>
        <div class="cost-legend">
          <span class="cost-legend-metered" /> Metered <span class="cost-legend-equivalent" /> API-equivalent
        </div>
      </Show>
    </div>
  );
};
