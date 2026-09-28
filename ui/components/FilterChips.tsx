import type { Component } from "solid-js";
import { For } from "solid-js";
import type { RunStatus } from "../../src/core/types.ts";

const ALL_STATUSES: RunStatus[] = [
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
  active: RunStatus | null;
  onChange: (status: RunStatus | null) => void;
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
          {s.replace("_", " ")}
        </button>
      )}
    </For>
  </div>
);
