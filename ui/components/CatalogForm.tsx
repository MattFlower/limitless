import { createSignal, For, Show } from "solid-js";
import type { ModelDef } from "../../src/router/catalog.ts";
import { type CatalogSnapshot, updateCatalog } from "../api.ts";

const VENDORS = [
  "anthropic",
  "openai",
  "qwen",
  "deepseek",
  "moonshot",
  "zhipu",
  "minimax",
  "google",
  "meta",
  "ibm",
  "nvidia",
  "mistral",
  "typesafe",
  "other",
];
export const CatalogForm = (props: {
  provider: string;
  backend: string;
  existing?: ModelDef;
  onSaved: (snapshot: CatalogSnapshot, old: ModelDef | undefined, value: object) => void;
  onCancel: () => void;
}) => {
  const old = props.existing;
  const [fields, setFields] = createSignal<Record<string, string>>({
    id: old?.id.slice(props.provider.length + 1) ?? "",
    model: props.backend,
    origin: old?.origin ?? "",
    baseOrigin: old?.baseOrigin ?? "unknown",
    vendor: old?.vendor ?? "",
    tier: old ? String(old.tier) : "",
    input: String(old?.price.input ?? 0),
    output: String(old?.price.output ?? 0),
    supportedEfforts: old?.supportedEfforts.join(",") ?? "",
    effort: old?.effort ?? "",
    notes: old?.notes ?? "",
  });
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy()) return;
    const f = fields();
    if (![f.id, f.model, f.origin, f.vendor, f.tier, f.baseOrigin].every((v) => v?.trim())) {
      setError("Short id, backend name, origin, base origin, vendor and tier are required.");
      return;
    }
    const value = {
      provider: props.provider,
      id: f.id,
      model: f.model,
      origin: f.origin,
      baseOrigin: f.baseOrigin,
      vendor: f.vendor,
      tier: Number(f.tier),
      price: { ...old?.price, input: Number(f.input), output: Number(f.output) },
      supportedEfforts:
        f.supportedEfforts
          ?.split(",")
          .map((v) => v.trim())
          .filter(Boolean) ?? [],
      ...(f.effort ? { effort: f.effort } : {}),
      notes: f.notes,
    };
    setBusy(true);
    setError("");
    try {
      props.onSaved(await updateCatalog(old ? "PATCH" : "POST", old?.id, value), old, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="stack" onSubmit={submit} aria-label={old ? `Edit ${old.id}` : `Add ${props.backend}`}>
      <For
        each={[
          "id",
          "model",
          "origin",
          "baseOrigin",
          "vendor",
          "tier",
          "input",
          "output",
          "supportedEfforts",
          "effort",
          "notes",
        ]}
      >
        {(key) => (
          <label class="field">
            {{
              id: "Unique short id",
              model: "Backend name",
              baseOrigin: "Base origin",
              input: "Price / million input",
              output: "Price / million output",
              supportedEfforts: "Supported efforts (comma separated)",
              effort: "Default effort (optional)",
              notes: "Note (optional)",
            }[key] ?? key}
            <Show
              when={key === "vendor" || key === "tier"}
              fallback={
                <input
                  type={key === "input" || key === "output" ? "number" : "text"}
                  min="0"
                  step="any"
                  required={["id", "model", "origin", "baseOrigin", "input", "output"].includes(key)}
                  readOnly={(key === "id" && !!old) || (key === "model" && !old)}
                  value={fields()[key]}
                  onInput={(e) => setFields({ ...fields(), [key]: e.currentTarget.value })}
                />
              }
            >
              <select
                required
                value={fields()[key]}
                onChange={(e) => setFields({ ...fields(), [key]: e.currentTarget.value })}
              >
                <option value="">Choose {key}</option>
                <For each={key === "vendor" ? VENDORS : ["1", "2", "3", "4", "5"]}>
                  {(v) => <option value={v}>{v}</option>}
                </For>
              </select>
            </Show>
          </label>
        )}
      </For>
      <Show when={error()}>
        <div class="error-box" role="alert">
          {error()}
        </div>
      </Show>
      <div class="setup-controls">
        <button class="btn btn-primary" type="submit" disabled={busy()}>
          {old ? "Save model" : "Add model"}
        </button>
        <button class="btn" type="button" disabled={busy()} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};
