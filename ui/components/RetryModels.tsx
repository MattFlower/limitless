import { createSignal, onMount, Show } from "solid-js";
import { RUN_ROLES, type Run, type RunModels } from "../../src/core/types.ts";
import { getRouting, retryRun } from "../api.ts";
import { RunModelPicker } from "./RunModelPicker.tsx";

export const RetryModels = (props: { run: Run; onRetried: (id: string) => void; onCancel: () => void }) => {
  const [models, setModels] = createSignal<RunModels>(structuredClone(props.run.models ?? {}));
  const [loading, setLoading] = createSignal(Object.keys(props.run.models ?? {}).length === 0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(() => {
    if (!loading()) return;
    void getRouting()
      .then((r) => {
        const complexity = props.run.complexity ?? "medium";
        setModels(
          Object.fromEntries(
            RUN_ROLES.flatMap((role) => {
              const groups = r.effective[role]?.[complexity]?.groups ?? r.effective[role]?.default?.groups;
              return groups ? [[role, [...groups]]] : [];
            }),
          ),
        );
        setLoading(false);
      })
      .catch((e) => setError(String(e)));
  });
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      props.onRetried((await retryRun(props.run.id, models())).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card card-pad stack">
      <h2>Retry with different models</h2>
      <Show when={!loading()} fallback={<p>Loading current routing…</p>}>
        <RunModelPicker models={models()} onChange={setModels} error={error()} />
      </Show>
      <Show when={error()}>
        <div class="error-box" role="alert">
          {error()}
        </div>
      </Show>
      <div class="setup-controls">
        <button
          type="button"
          class="btn btn-primary"
          disabled={loading() || busy()}
          onClick={() => void submit()}
        >
          Retry with selected models
        </button>
        <button type="button" class="btn" disabled={busy()} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
};
