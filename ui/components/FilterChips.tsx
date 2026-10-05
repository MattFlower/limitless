import type { Component } from "solid-js";
import { For } from "solid-js";
import type { RunStatus } from "../../src/core/types.ts";

export type RunFilter = RunStatus | "needs_you";
export const matchesRunFilter = (status: RunStatus, filter: RunFilter) =>
  filter === "needs_you" ? status === "failed" || status === "needs_human" : status === filter;
const ALL_STATUSES: RunFilter[] = [
  "needs_you",
  "waiting",
  "running",
  "waiting_input",
  "needs_human",
  "resolved",
  "failed",
  "queued",
  "succeeded",
  "cancelled",
];

export const FilterChips: Component<{
  active: RunFilter | null;
  onChange: (status: RunFilter | null) => void;
}> = (props) => (
  <div class="chips">
    <button
      type="button"
      class="chip"
      classList={{ active: props.active === null }}
      onClick={() => props.onChange(null)}
    >
      all
    </button>
    <For each={ALL_STATUSES}>
      {(s) => (
        <button
          type="button"
          class="chip"
          classList={{ active: props.active === s }}
          onClick={() => props.onChange(props.active === s ? null : s)}
        >
          {s === "needs_you" ? "Needs you" : s.replace("_", " ")}
        </button>
      )}
    </For>
  </div>
);
