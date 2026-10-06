import { For, Index, Show } from "solid-js";
import type { ModelDef } from "../../src/router/catalog.ts";

export function move<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  const item = next[index];
  if (item === undefined || target < 0 || target >= next.length) return next;
  next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export const ChainPicker = (props: {
  groups: string[];
  models: ModelDef[];
  onChange: (groups: string[]) => void;
  note?: string;
  onNote?: (note: string) => void;
}) => {
  const update = (group: number, entries: string[]) =>
    props.onChange(
      props.groups.flatMap((value, i) =>
        i === group ? (entries.length ? [entries.join("|")] : []) : [value],
      ),
    );
  return (
    <div class="stack chain-picker">
      <Index each={props.groups}>
        {(group, g) => (
          <div class="card card-pad stack">
            <div class="setup-controls">
              <span>Group {g + 1}</span>
              <button
                type="button"
                class="btn btn-sm"
                aria-label={`Move group ${g + 1} up`}
                disabled={g === 0}
                onClick={() => props.onChange(move(props.groups, g, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                class="btn btn-sm"
                aria-label={`Move group ${g + 1} down`}
                disabled={g === props.groups.length - 1}
                onClick={() => props.onChange(move(props.groups, g, 1))}
              >
                ↓
              </button>
              <button type="button" class="btn btn-sm" onClick={() => update(g, [])}>
                Remove group
              </button>
            </div>
            <Index each={group().split("|")}>
              {(entry, a) => {
                const model = () => props.models.find((m) => m.id === entry().split("@")[0]);
                const replace = (value: string) =>
                  update(
                    g,
                    group()
                      .split("|")
                      .map((old, i) => (i === a ? value : old)),
                  );
                return (
                  <div class="setup-controls field">
                    <label>
                      Model{" "}
                      <select
                        aria-label={`Group ${g + 1} alternative ${a + 1} model`}
                        value={entry().split("@")[0]}
                        onChange={(e) => replace(e.currentTarget.value)}
                      >
                        <option value="">Choose model</option>
                        <Show when={entry() && !model()}>
                          <option value={entry().split("@")[0]} selected>
                            {entry().split("@")[0]} (unavailable)
                          </option>
                        </Show>
                        <For each={props.models.map((m) => m.id)}>
                          {(id) => (
                            <option value={id} selected={id === entry().split("@")[0]}>
                              {id}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                    <label>
                      Effort{" "}
                      <select
                        aria-label={`Group ${g + 1} alternative ${a + 1} effort`}
                        value={entry().split("@")[1] ?? ""}
                        onChange={(e) =>
                          replace(
                            `${entry().split("@")[0]}${e.currentTarget.value ? `@${e.currentTarget.value}` : ""}`,
                          )
                        }
                      >
                        <option value="">Model default</option>
                        <Show
                          when={
                            entry().split("@")[1] &&
                            !model()?.supportedEfforts.some((effort) => effort === entry().split("@")[1])
                          }
                        >
                          <option value={entry().split("@")[1]} disabled selected>
                            {entry().split("@")[1]} (unsupported)
                          </option>
                        </Show>
                        <For each={model()?.supportedEfforts ?? []}>
                          {(effort) => (
                            <option value={effort} selected={effort === entry().split("@")[1]}>
                              {effort}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                    <button
                      type="button"
                      class="btn btn-sm"
                      aria-label={`Move alternative ${a + 1} up in group ${g + 1}`}
                      disabled={a === 0}
                      onClick={() => update(g, move(group().split("|"), a, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm"
                      aria-label={`Move alternative ${a + 1} down in group ${g + 1}`}
                      disabled={a === group().split("|").length - 1}
                      onClick={() => update(g, move(group().split("|"), a, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() =>
                        update(
                          g,
                          group()
                            .split("|")
                            .filter((_, i) => i !== a),
                        )
                      }
                    >
                      Remove alternative
                    </button>
                  </div>
                );
              }}
            </Index>
            <button type="button" class="btn btn-sm" onClick={() => update(g, [...group().split("|"), ""])}>
              Add alternative
            </button>
          </div>
        )}
      </Index>
      <button type="button" class="btn btn-sm" onClick={() => props.onChange([...props.groups, ""])}>
        Add group
      </button>
      <Show when={props.onNote}>
        <label class="field">
          Note (optional)
          <input
            type="text"
            value={props.note ?? ""}
            onInput={(e) => props.onNote?.(e.currentTarget.value)}
          />
        </label>
      </Show>
    </div>
  );
};
