import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { RUN_ROLES, type Run, type RunModels, type RunRole } from "../../src/core/types.ts";
import { getRouting, retryRun } from "../api.ts";
import { RunModelPicker } from "./RunModelPicker.tsx";

export const RetryModels = (props: { run: Run; onRetried: (id: string) => void; onCancel: () => void }) => {
  const [models, setModels] = createSignal<RunModels>(structuredClone(props.run.models ?? {}));
  const [inherited, setInherited] = createSignal<RunModels>({});
  const [changed, setChanged] = createSignal(new Set<RunRole>());
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(() => {
    let disposed = false;
    onCleanup(() => {
      disposed = true;
    });
    void getRouting()
      .then((r) => {
        if (disposed) return;
        const complexity = props.run.complexity ?? "medium";
        setInherited(
          Object.fromEntries(
            RUN_ROLES.flatMap((role) => {
              const deep = (props.run.resolvedProfile ?? props.run.profile) === "deep";
              const cell = role === "review" && deep ? "large" : complexity;
              const groups = r.effective[role]?.[cell]?.groups ?? r.effective[role]?.default?.groups;
              return groups ? [[role, [...groups]]] : [];
            }),
          ),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (!disposed) {
          setError(String(e));
          setLoading(false);
        }
      });
  });
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      props.onRetried((await retryRun(props.run.id, changed().size ? models() : undefined)).id);
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
        <RunModelPicker
          models={models()}
          inherited={inherited()}
          onChange={(next) => {
            setChanged(
              (old) =>
                new Set([
                  ...old,
                  ...RUN_ROLES.filter(
                    (role) => JSON.stringify(next[role]) !== JSON.stringify(models()[role]),
                  ),
                ]),
            );
            setModels(next);
          }}
          error={error()}
        />
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
