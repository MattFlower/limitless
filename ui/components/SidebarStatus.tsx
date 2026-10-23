import { A } from "@solidjs/router";
import { type Component, createMemo, For, Index, Show } from "solid-js";
import { pct } from "../lib/format.ts";
import { gaugeClass } from "../lib/gauge.ts";
import { windowLabel } from "../lib/window-label.ts";
import { live } from "../store.ts";

/** Gate-slot occupancy and the busiest quota window of each enabled provider, under the nav. */
export const SidebarStatus: Component = () => {
  const quotas = createMemo(() =>
    Object.values(live.providers)
      .filter((p) => p.enabled)
      .flatMap((p) => {
        const busiest = Object.entries(p.windows).reduce<[string, number] | null>(
          (top, [key, w]) => (top === null || w.utilization > top[1] ? [key, w.utilization] : top),
          null,
        );
        return busiest
          ? [{ id: p.id, label: p.label, window: windowLabel(busiest[0]), used: busiest[1] }]
          : [];
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
  return (
    <div class="sidebar-status">
      <Show when={live.gateSlots()}>
        {(slots) => (
          <div class="sidebar-gates" role="status">
            <div class="sidebar-row">
              <span>Gate slots</span>
              <span class="gate-dots" aria-hidden="true">
                <Index
                  each={Array.from({ length: Math.min(slots().limit, 8) }, (_, i) => i < slots().occupied)}
                >
                  {(busy) => <span class="gate-dot" classList={{ busy: busy() }} />}
                </Index>
              </span>
              <span class="mono">
                {slots().occupied}/{slots().limit}
              </span>
            </div>
            <Show when={slots().holders.length > 0}>
              <div class="sidebar-holders">{slots().holders.join(", ")}</div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={quotas().length > 0}>
        <A href="/providers" class="sidebar-quotas">
          <For each={quotas()}>
            {(q) => (
              <span class="sidebar-quota">
                <span class="sidebar-row">
                  <span class="sidebar-quota-name">{q.label}</span>
                  <span class="mono">
                    {q.window} {pct(q.used)}
                  </span>
                </span>
                <span class="sidebar-quota-track" aria-hidden="true">
                  <span class={`sidebar-quota-fill ${gaugeClass(q.used)}`} style={{ width: pct(q.used) }} />
                </span>
              </span>
            )}
          </For>
        </A>
      </Show>
    </div>
  );
};
