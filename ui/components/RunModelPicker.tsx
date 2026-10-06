import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { RUN_ROLES, type RunModels } from "../../src/core/types.ts";
import type { ModelDef } from "../../src/router/catalog.ts";
import { getCatalog } from "../api.ts";
import { subscribeLiveUpdates } from "../store.ts";
import { ChainPicker } from "./ChainPicker.tsx";

export const RunModelPicker = (props: {
  models: RunModels;
  onChange: (models: RunModels) => void;
  error?: string | null;
}) => {
  const [catalog, setCatalog] = createSignal<ModelDef[]>([]);
  const [loadError, setLoadError] = createSignal("");
  onMount(() => {
    let generation = 0;
    const refresh = async () => {
      const version = ++generation;
      try {
        const c = await getCatalog();
        if (version !== generation) return;
        setCatalog(c.models);
        setLoadError("");
      } catch (e) {
        if (version === generation) setLoadError(String(e));
      }
    };
    const close = subscribeLiveUpdates((msg) => {
      if (msg.kind === "catalog" || msg.kind === "reconnected") void refresh();
    });
    onCleanup(() => {
      close();
      generation++;
    });
    void refresh();
  });
  const change = (role: (typeof RUN_ROLES)[number], groups?: string[]) => {
    const next = { ...props.models };
    if (groups === undefined) delete next[role];
    else next[role] = groups;
    props.onChange(next);
  };
  return (
    <div class="stack">
      <Show when={loadError()}>
        <div class="error-box" role="alert">
          {loadError()}
        </div>
      </Show>
      <For each={RUN_ROLES}>
        {(role) => (
          <section class="stack" aria-label={`${role} models`}>
            <label>
              <input
                type="checkbox"
                checked={props.models[role] !== undefined}
                onChange={(e) => change(role, e.currentTarget.checked ? [""] : undefined)}
              />{" "}
              {role} override
            </label>
            <Show when={props.models[role] !== undefined}>
              <ChainPicker
                groups={props.models[role] ?? []}
                models={catalog()}
                onChange={(groups) => change(role, groups)}
              />
            </Show>
            <Show when={props.error?.includes(`models.${role}`)}>
              <div class="error-box" role="alert">
                {props.error}
              </div>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
};
