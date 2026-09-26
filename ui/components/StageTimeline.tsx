import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { Stage } from "../../src/core/types.ts";
import { duration } from "../lib/format.ts";
import { now } from "../lib/ticker.ts";

export const StageTimeline: Component<{ stages: Stage[] }> = (props) => {
  const bounds = createMemo(() => {
    if (!props.stages.length) return { start: Date.now(), span: 1 };
    const start = Math.min(...props.stages.map((s) => s.startedAt));
    const ends = props.stages.map((s) => s.finishedAt ?? now());
    const end = Math.max(start + 1000, ...ends, now());
    return { start, span: Math.max(1, end - start) };
  });

  return (
    <div class="timeline">
      <For each={props.stages}>
        {(stage) => {
          const end = () => stage.finishedAt ?? now();
          const left = () => ((stage.startedAt - bounds().start) / bounds().span) * 100;
          const width = () => Math.max(1.2, ((end() - stage.startedAt) / bounds().span) * 100);
          const label = () => `${stage.name}${stage.round > 0 ? ` · r${stage.round + 1}` : ""}`;
          return (
            <div class="timeline-row">
              <div class="timeline-name">
                <span>{label()}</span>
                <span class="text-faint">{duration(end() - stage.startedAt)}</span>
              </div>
              <div class="timeline-track">
                <div
                  class={`timeline-bar ${stage.status}`}
                  style={{ left: `${left()}%`, width: `${width()}%` }}
                  title={stage.summary ?? stage.status}
                />
              </div>
              <Show when={stage.summary}>
                <div class="timeline-summary">{stage.summary}</div>
              </Show>
            </div>
          );
        }}
      </For>
      <Show when={props.stages.length === 0}>
        <div class="text-faint mono" style={{ "font-size": "12px" }}>
          No stages yet.
        </div>
      </Show>
    </div>
  );
};
