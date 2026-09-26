import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { EventType, RunEvent } from "../../src/core/types.ts";
import { formatTime } from "../lib/format.ts";

const TYPES: EventType[] = [
  "text",
  "tool_call",
  "tool_result",
  "thinking",
  "gate",
  "audit",
  "log",
  "status",
  "rate_limit",
  "stderr",
  "error",
];

type Level = RunEvent["level"];
const LEVELS: Level[] = ["debug", "info", "warn", "error"];
const DEFAULT_LEVELS = new Set<Level>(["info", "warn", "error"]);

const MAX_ROWS = 1500;

export const EventLog: Component<{
  events: RunEvent[];
  invocationFilter: number | null;
  onClearInvocationFilter: () => void;
}> = (props) => {
  const [types, setTypes] = createSignal<Set<EventType>>(new Set());
  const [levels, setLevels] = createSignal<Set<Level>>(new Set(DEFAULT_LEVELS));
  const [search, setSearch] = createSignal("");
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [expanded, setExpanded] = createSignal<number | null>(null);
  let listEl: HTMLDivElement | undefined;

  const toggle = <T,>(set: () => Set<T>, setter: (s: Set<T>) => void, value: T) => {
    const next = new Set(set());
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  };

  const filtered = createMemo(() => {
    const t = types();
    const l = levels();
    const q = search().trim().toLowerCase();
    const inv = props.invocationFilter;
    const rows = props.events.filter((e) => {
      if (inv !== null && e.invocationId !== inv) return false;
      if (!l.has(e.level)) return false;
      if (t.size > 0 && !t.has(e.type)) return false;
      if (q && !e.message.toLowerCase().includes(q)) return false;
      return true;
    });
    return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
  });

  createEffect(() => {
    filtered();
    if (autoScroll() && listEl) listEl.scrollTop = listEl.scrollHeight;
  });

  return (
    <div>
      <div class="log-toolbar">
        <div class="chips">
          <For each={TYPES}>
            {(t) => (
              <button
                type="button"
                class="chip"
                classList={{ active: types().has(t) }}
                onClick={() => toggle(types, setTypes, t)}
              >
                {t}
              </button>
            )}
          </For>
        </div>
        <div class="chips">
          <For each={LEVELS}>
            {(l) => (
              <button
                type="button"
                class="chip"
                classList={{ active: levels().has(l) }}
                onClick={() => toggle(levels, setLevels, l)}
              >
                {l}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="log-toolbar">
        <input
          class="log-search"
          type="text"
          placeholder="search message…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <label class="chip" style={{ display: "flex", "align-items": "center", gap: "5px" }}>
          <input
            type="checkbox"
            checked={autoScroll()}
            onChange={(e) => setAutoScroll(e.currentTarget.checked)}
          />
          auto-scroll
        </label>
        <Show when={props.invocationFilter !== null}>
          <button type="button" class="chip active" onClick={props.onClearInvocationFilter}>
            invocation #{props.invocationFilter} ✕
          </button>
        </Show>
        <span class="text-faint mono" style={{ "font-size": "11px" }}>
          {filtered().length} / {props.events.length} events
        </span>
      </div>
      <div class="log-list" ref={listEl}>
        <For each={filtered()}>
          {(e) => {
            const toggle = () => setExpanded(expanded() === e.id ? null : e.id);
            return (
              <button
                type="button"
                class={`log-row type-${e.type} level-${e.level}`}
                aria-expanded={expanded() === e.id}
                onClick={toggle}
              >
                <span class="log-time">{formatTime(e.ts)}</span>
                <span class="badge">{e.type}</span>
                <span class="log-msg">{e.message}</span>
                <Show when={expanded() === e.id && e.data !== null && e.data !== undefined}>
                  <pre class="log-detail">{JSON.stringify(e.data, null, 2)}</pre>
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={filtered().length === 0}>
          <div class="centered-hint">no events match these filters</div>
        </Show>
      </div>
    </div>
  );
};
