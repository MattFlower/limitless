import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ACTIVE_LAND_STATES, type LandEntry } from "../../src/core/types.ts";
import { cancelLand, landLogUrl, listLand } from "../api.ts";
import { createLandController, type LandListState, newestLand } from "../lib/land.ts";

export const LandList: Component<{
  entries: readonly LandEntry[];
  error?: string;
  cancelling?: readonly number[];
  cancel: (id: number) => void;
}> = (props) => (
  <div class="page stack">
    <h1 class="page-title">Land</h1>
    <Show when={props.error}>
      <p role="alert">{props.error}</p>
    </Show>
    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th>State</th>
            <th>PR</th>
            <th>Approved SHA</th>
            <th>Reason</th>
            <th>Log</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={newestLand(props.entries)}
            fallback={
              <tr>
                <td colSpan={6}>No land entries.</td>
              </tr>
            }
          >
            {(entry) => (
              <tr>
                <td>{entry.state}</td>
                <td>
                  <a href={entry.prUrl}>{entry.title || entry.prUrl}</a>
                </td>
                <td>
                  <code title={entry.approvedSha}>{entry.approvedSha.slice(0, 8)}</code>
                </td>
                <td>{entry.reason}</td>
                <td>
                  <Show when={entry.logPath}>
                    <a href={landLogUrl(entry.id)}>Log</a>
                  </Show>
                </td>
                <td>
                  <Show when={ACTIVE_LAND_STATES.includes(entry.state)}>
                    <button
                      type="button"
                      class="btn btn-sm"
                      disabled={props.cancelling?.includes(entry.id)}
                      onClick={() => props.cancel(entry.id)}
                    >
                      Cancel
                    </button>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </div>
);

export const Land: Component = () => {
  const [state, setState] = createSignal<LandListState>({ entries: [], error: "", cancelling: [] });
  const controller = createLandController({ list: listLand, cancel: cancelLand }, setState);
  onMount(() => {
    void controller.load();
    const timer = setInterval(() => void controller.load(), 15_000);
    onCleanup(() => {
      clearInterval(timer);
      controller.dispose();
    });
  });
  return (
    <LandList
      entries={state().entries}
      error={state().error}
      cancelling={state().cancelling}
      cancel={(id) => void controller.cancel(id)}
    />
  );
};
