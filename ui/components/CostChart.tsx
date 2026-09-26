import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { DayStats } from "../../src/db/stats.ts";
import { money } from "../lib/format.ts";

const HEIGHT = 150;
const BAR_GAP = 8;

/** Hand-rolled stacked bar chart: real $ (solid) under subscription-equivalent $ (hatched), per day. */
export const CostChart: Component<{ days: DayStats[] }> = (props) => {
  const max = createMemo(() => Math.max(0.01, ...props.days.map((d) => d.costUsd + d.costEquivUsd)));
  const barWidth = createMemo(() => (props.days.length ? 100 / props.days.length : 100));

  const short = (day: string) => {
    const d = new Date(`${day}T00:00:00`);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <div>
      <svg viewBox={`0 0 100 ${HEIGHT}`} width="100%" height={HEIGHT} preserveAspectRatio="none" role="img">
        <title>Cost per day, real and subscription-equivalent</title>
        <defs>
          <pattern
            id="equiv-hatch"
            width="3"
            height="3"
            patternTransform="rotate(45)"
            patternUnits="userSpaceOnUse"
          >
            <rect width="3" height="3" fill="var(--accent-dim)" />
            <line x1="0" y1="0" x2="0" y2="3" stroke="var(--accent)" stroke-width="1" />
          </pattern>
        </defs>
        <For each={props.days}>
          {(d, i) => {
            const x = i() * barWidth() + BAR_GAP / 20;
            const w = barWidth() - BAR_GAP / 10;
            const realH = (d.costUsd / max()) * (HEIGHT - 18);
            const equivH = (d.costEquivUsd / max()) * (HEIGHT - 18);
            return (
              <g>
                <Show when={equivH > 0}>
                  <rect
                    x={x}
                    y={HEIGHT - 18 - realH - equivH}
                    width={w}
                    height={equivH}
                    fill="url(#equiv-hatch)"
                  />
                </Show>
                <Show when={realH > 0}>
                  <rect x={x} y={HEIGHT - 18 - realH} width={w} height={realH} fill="var(--accent)" />
                </Show>
                <Show when={realH === 0 && equivH === 0}>
                  <rect x={x} y={HEIGHT - 19} width={w} height="1" fill="var(--border-strong)" />
                </Show>
              </g>
            );
          }}
        </For>
      </svg>
      <div style={{ display: "flex", "justify-content": "space-between", "margin-top": "4px" }}>
        <For each={props.days}>
          {(d) => (
            <span
              class="text-faint mono"
              style={{ "font-size": "9.5px", width: `${barWidth()}%`, "text-align": "center" }}
              title={`${short(d.day)}: ${money(d.costUsd)} real + ${money(d.costEquivUsd)} equiv`}
            >
              {short(d.day)}
            </span>
          )}
        </For>
      </div>
      <div style={{ display: "flex", gap: "16px", "margin-top": "10px" }}>
        <span
          class="text-dim"
          style={{ "font-size": "11px", display: "flex", "align-items": "center", gap: "6px" }}
        >
          <span
            style={{
              display: "inline-block",
              width: "10px",
              height: "10px",
              background: "var(--accent)",
              "border-radius": "2px",
            }}
          />
          real spend
        </span>
        <span
          class="text-dim"
          style={{ "font-size": "11px", display: "flex", "align-items": "center", gap: "6px" }}
        >
          <span
            style={{
              display: "inline-block",
              width: "10px",
              height: "10px",
              background: "var(--accent-dim)",
              border: "1px solid var(--accent)",
              "border-radius": "2px",
            }}
          />
          subscription-equivalent
        </span>
      </div>
    </div>
  );
};
