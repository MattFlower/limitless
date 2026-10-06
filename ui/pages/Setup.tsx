import { createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import type { ProviderStatus } from "../../src/core/types.ts";
import type { ProviderWorkload } from "../../src/db/stats.ts";
import type { RoutePreview } from "../../src/router/router.ts";
import {
  type CatalogSnapshot,
  getCatalog,
  getProviders,
  getProviderWorkload,
  getRouting,
  getRoutingPreview,
  type RoutingSnapshot,
  updateCatalog,
  updateRouting,
} from "../api.ts";
import { CatalogForm } from "../components/CatalogForm.tsx";
import { ChainPicker, move } from "../components/ChainPicker.tsx";
import { ProviderCard } from "../components/ProviderCard.tsx";
import { workloadFor } from "../lib/provider-workload.ts";
import { ensureLiveStore, subscribeLiveUpdates } from "../store.ts";

const CELLS = ["default", "trivial", "small", "medium", "large"];
type Draft = { groups: string[]; note: string };
export const Setup = () => {
  const [routing, setRouting] = createSignal<RoutingSnapshot>();
  const [catalog, setCatalog] = createSignal<CatalogSnapshot>();
  const [providers, setProviders] = createSignal<ProviderStatus[]>([]);
  const [workload, setWorkload] = createSignal<ProviderWorkload[]>([]);
  const [previews, setPreviews] = createSignal<
    Record<string, { complexity: string; candidates: RoutePreview[]; error?: string }>
  >({});
  const [drafts, setDrafts] = createSignal<Record<string, Draft>>({});
  const [prefer, setPrefer] = createSignal<Draft>();
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal<Record<string, boolean>>({});
  const [forms, setForms] = createSignal<Record<string, boolean>>({});
  const [now, setNow] = createSignal(Date.now());
  const models = () => catalog()?.models ?? [];
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const schedule = () => {
    clearTimeout(timer);
    if (disposed || !visible()) return;
    const time = Date.now();
    const expiries = [
      ...providers().flatMap((p) => [p.until, ...Object.values(p.windows).map((w) => w.resetsAt)]),
      ...Object.values(previews()).flatMap((p) =>
        p.candidates.flatMap((c) =>
          [...(c.reason ?? "").matchAll(/\buntil\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/g)].map(
            (m) => Date.parse(m[1] ?? ""),
          ),
        ),
      ),
    ].filter((at): at is number => at !== null && Number.isFinite(at) && at > time);
    timer = setTimeout(
      () => {
        setNow(Date.now());
        void refresh();
      },
      Math.min(60_000, ...expiries.map((at) => at - time + 1)),
    );
  };
  const currentProvider = (p: ProviderStatus): ProviderStatus => ({
    ...p,
    windows: Object.fromEntries(
      Object.entries(p.windows).map(([name, w]) => [
        name,
        w.resetsAt !== null && w.resetsAt <= now() ? { ...w, utilization: 0, observedAt: null } : w,
      ]),
    ),
  });
  const error = (key: string, value = "") => setErrors((old) => ({ ...old, [key]: value }));
  const refresh = async () => {
    clearTimeout(timer);
    const version = ++generation;
    try {
      const [r, c, p, w] = await Promise.all([
        getRouting(),
        getCatalog(),
        getProviders(),
        getProviderWorkload().catch(() => workload()),
      ]);
      if (version !== generation) return;
      const entries = await Promise.all(
        Object.entries(r.effective).flatMap(([role, cells]) =>
          Object.keys(cells).map(async (cell) => {
            // A default is only active for concrete complexities without an explicit cell.
            const complexity = cell === "default" ? CELLS.slice(1).find((c) => !cells[c]) : cell;
            if (!complexity) return [`${role}.${cell}`, { complexity: "shadowed", candidates: [] }] as const;
            try {
              return [
                `${role}.${cell}`,
                { complexity, candidates: await getRoutingPreview(role, complexity) },
              ] as const;
            } catch (e) {
              return [`${role}.${cell}`, { complexity, candidates: [], error: String(e) }] as const;
            }
          }),
        ),
      );
      if (version !== generation) return;
      setNow(Date.now());
      setRouting(r);
      setCatalog(c);
      setProviders(p);
      setWorkload(w);
      setPreviews(Object.fromEntries(entries));
      error("load");
    } catch (e) {
      if (version === generation) error("load", String(e));
    } finally {
      if (version === generation) schedule();
    }
  };
  onMount(() => {
    const close = subscribeLiveUpdates((msg) => {
      if (["routing", "catalog", "provider", "reconnected"].includes(msg.kind)) void refresh();
    });
    const visibility = () => {
      clearTimeout(timer);
      if (visible()) {
        setNow(Date.now());
        void refresh();
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
    onCleanup(() => {
      disposed = true;
      clearTimeout(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
      close();
      generation++;
    });
    ensureLiveStore();
    void refresh();
  });
  const edit = (key: string, groups: string[]) =>
    setDrafts((old) => ({ ...old, [key]: { groups: [...groups], note: "" } }));
  const discard = (key: string) =>
    setDrafts((old) => Object.fromEntries(Object.entries(old).filter(([k]) => k !== key)));
  const save = async (role: string, cell: string, reset = false) => {
    const key = `${role}.${cell}`;
    if (busy()[key]) return;
    setBusy((old) => ({ ...old, [key]: true }));
    error(key);
    const submitted = drafts()[key];
    try {
      const r = await updateRouting(
        `cells/${encodeURIComponent(role)}/${cell}`,
        reset ? "DELETE" : "PUT",
        reset ? undefined : submitted,
      );
      setRouting(r);
      if (reset || drafts()[key] === submitted) discard(key);
      await refresh();
    } catch (e) {
      error(key, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((old) => ({ ...old, [key]: false }));
    }
  };
  const savePrefer = async (reset = false) => {
    setBusy((old) => ({ ...old, prefer: true }));
    error("prefer");
    const submitted = prefer();
    try {
      setRouting(
        await updateRouting(
          "prefer",
          reset ? "DELETE" : "PUT",
          reset ? undefined : { prefer: submitted?.groups ?? [], note: submitted?.note },
        ),
      );
      if (reset || prefer() === submitted) setPrefer(undefined);
      await refresh();
    } catch (e) {
      error("prefer", String(e));
    } finally {
      setBusy((old) => ({ ...old, prefer: false }));
    }
  };
  const remove = async (id: string) => {
    setBusy((old) => ({ ...old, [id]: true }));
    error(id);
    try {
      setCatalog(await updateCatalog("DELETE", id));
      await refresh();
    } catch (e) {
      error(id, String(e));
    } finally {
      setBusy((old) => ({ ...old, [id]: false }));
    }
  };
  const chain = (groups: string[]) => (
    <div class="stack">
      <For each={groups}>
        {(group, i) => (
          <div class="setup-controls">
            <span>{i() + 1} →</span>
            <For each={group.split("|")}>
              {(entry) => {
                const [id, effort] = entry.split("@");
                const m = () => models().find((m) => m.id === id);
                return (
                  <span class="chip-tag">
                    {id} · {effort ?? m()?.effort ?? "backend default"} ·{" "}
                    {m()?.provider ?? "unknown provider"} ·{" "}
                    {providers().find((p) => p.id === m()?.provider)?.billing ?? "billing unavailable"}
                  </span>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
  return (
    <div class="page stack setup-page">
      <div class="page-header">
        <h1 class="page-title">Setup</h1>
      </div>
      <Show when={errors().load}>
        <div class="error-box" role="alert">
          {errors().load}
        </div>
      </Show>
      <section class="stack" aria-label="Routing grid">
        <h2>Routing</h2>
        <Show when={routing()} fallback={<p>Loading routing…</p>}>
          <For each={Object.keys(routing()?.effective ?? {})}>
            {(role) => (
              <section class="stack">
                <h3>{role}</h3>
                <div class="setup-grid">
                  <For
                    each={CELLS.filter(
                      (cell) => routing()?.effective[role]?.[cell] || drafts()[`${role}.${cell}`],
                    )}
                  >
                    {(cell) => {
                      const key = `${role}.${cell}`;
                      const value = () => routing()?.effective[role]?.[cell];
                      const draft = () => drafts()[key];
                      const preview = () => previews()[key];
                      return (
                        <article class="card card-pad stack" aria-label={`${role} ${cell}`}>
                          <div class="setup-controls">
                            <strong>{cell}</strong>
                            <span class="chip-tag">
                              {value()?.layer === "operator" ? "yours" : (value()?.layer ?? "new")}
                            </span>
                          </div>
                          {chain(value()?.groups ?? [])}
                          <Show when={value()?.evals}>
                            <div class="stack">
                              <span>Evals recommendation</span>
                              {chain(value()?.evals ?? [])}
                            </div>
                          </Show>
                          <div class="stack">
                            <strong>
                              Right now{" "}
                              {preview()?.complexity === "shadowed"
                                ? "— default currently shadowed"
                                : `(${preview()?.complexity ?? "loading"})`}
                            </strong>
                            <Show when={preview()?.error}>
                              <span role="alert">{preview()?.error}</span>
                            </Show>
                            <Show
                              when={preview() && preview()?.complexity !== "shadowed" && !preview()?.error}
                            >
                              <span>
                                {preview()?.candidates.find((c) => c.eligible)?.modelId ??
                                  "No eligible model"}
                              </span>
                            </Show>
                            <For each={preview()?.candidates.filter((c) => !c.eligible) ?? []}>
                              {(c) => (
                                <span>
                                  {c.modelId}: {c.reason}
                                </span>
                              )}
                            </For>
                          </div>
                          <Show
                            when={draft()}
                            fallback={
                              <button
                                type="button"
                                class="btn btn-sm"
                                onClick={() => edit(key, value()?.groups ?? [])}
                              >
                                Edit chain
                              </button>
                            }
                          >
                            <ChainPicker
                              groups={draft()?.groups ?? []}
                              models={models()}
                              note={draft()?.note}
                              onChange={(groups) =>
                                setDrafts((old) => ({
                                  ...old,
                                  [key]: { groups, note: old[key]?.note ?? "" },
                                }))
                              }
                              onNote={(note) =>
                                setDrafts((old) => ({
                                  ...old,
                                  [key]: { groups: old[key]?.groups ?? [], note },
                                }))
                              }
                            />
                            <div class="setup-controls">
                              <button
                                type="button"
                                class="btn btn-primary"
                                disabled={busy()[key]}
                                onClick={() => void save(role, cell)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                class="btn"
                                disabled={busy()[key]}
                                onClick={() => {
                                  discard(key);
                                  error(key);
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </Show>
                          <Show when={value()?.layer === "operator"}>
                            <button
                              type="button"
                              class="btn btn-sm"
                              disabled={busy()[key]}
                              onClick={() => void save(role, cell, true)}
                            >
                              Reset to recommended
                            </button>
                          </Show>
                          <Show when={errors()[key]}>
                            <div class="error-box" role="alert">
                              {errors()[key]}
                            </div>
                          </Show>
                        </article>
                      );
                    }}
                  </For>
                </div>
                <div class="setup-controls">
                  <span>Add cell</span>
                  <For
                    each={CELLS.filter(
                      (cell) => !routing()?.effective[role]?.[cell] && !drafts()[`${role}.${cell}`],
                    )}
                  >
                    {(cell) => (
                      <button
                        type="button"
                        class="btn btn-sm"
                        onClick={() =>
                          edit(`${role}.${cell}`, routing()?.effective[role]?.default?.groups ?? [])
                        }
                      >
                        {cell}
                      </button>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </section>
      <section class="card card-pad stack">
        <h2>Provider preference</h2>
        <span class="chip-tag">{routing()?.operatorPrefer === null ? "code/config" : "yours"}</span>
        <p>{routing()?.prefer.join(" → ")}</p>
        <Show
          when={prefer()}
          fallback={
            <button
              type="button"
              class="btn"
              onClick={() => setPrefer({ groups: [...(routing()?.prefer ?? [])], note: "" })}
            >
              Edit preference
            </button>
          }
        >
          <Index each={prefer()?.groups ?? []}>
            {(id, i) => (
              <div class="setup-controls field">
                <select
                  aria-label={`Preferred provider ${i + 1}`}
                  value={id()}
                  onChange={(e) =>
                    setPrefer({
                      groups: prefer()?.groups.map((p, n) => (n === i ? e.currentTarget.value : p)) ?? [],
                      note: prefer()?.note ?? "",
                    })
                  }
                >
                  <option value="">Choose provider</option>
                  <Show when={id() && !providers().some((p) => p.id === id())}>
                    <option value={id()} selected>
                      {id()} (unavailable)
                    </option>
                  </Show>
                  <For each={providers().map((p) => p.id)}>
                    {(provider) => (
                      <option value={provider} selected={provider === id()}>
                        {provider}
                      </option>
                    )}
                  </For>
                </select>
                <button
                  class="btn"
                  type="button"
                  disabled={i === 0}
                  onClick={() =>
                    setPrefer({ groups: move(prefer()?.groups ?? [], i, -1), note: prefer()?.note ?? "" })
                  }
                >
                  ↑
                </button>
                <button
                  class="btn"
                  type="button"
                  disabled={i === (prefer()?.groups.length ?? 0) - 1}
                  onClick={() =>
                    setPrefer({ groups: move(prefer()?.groups ?? [], i, 1), note: prefer()?.note ?? "" })
                  }
                >
                  ↓
                </button>
                <button
                  class="btn"
                  type="button"
                  onClick={() =>
                    setPrefer({
                      groups: prefer()?.groups.filter((_, n) => n !== i) ?? [],
                      note: prefer()?.note ?? "",
                    })
                  }
                >
                  Remove provider
                </button>
              </div>
            )}
          </Index>
          <button
            type="button"
            class="btn"
            onClick={() =>
              setPrefer({ groups: [...(prefer()?.groups ?? []), ""], note: prefer()?.note ?? "" })
            }
          >
            Add provider
          </button>
          <label class="field">
            Note (optional)
            <input
              type="text"
              value={prefer()?.note ?? ""}
              onInput={(e) => setPrefer({ groups: prefer()?.groups ?? [], note: e.currentTarget.value })}
            />
          </label>
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy().prefer}
            onClick={() => void savePrefer()}
          >
            Save preference
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => {
              setPrefer(undefined);
              error("prefer");
            }}
          >
            Cancel
          </button>
        </Show>
        <Show when={routing()?.operatorPrefer !== null && routing()?.operatorPrefer !== undefined}>
          <button type="button" class="btn" disabled={busy().prefer} onClick={() => void savePrefer(true)}>
            Reset preference
          </button>
        </Show>
        <Show when={errors().prefer}>
          <div class="error-box" role="alert">
            {errors().prefer}
          </div>
        </Show>
      </section>
      <section class="stack">
        <h2>Providers and quota headroom</h2>
        <div class="provider-grid">
          <For each={providers()}>
            {(p) => (
              <div class="stack">
                <ProviderCard provider={currentProvider(p)} workload={workloadFor(p.id, workload())} />
                <Show when={p.billing === "subscription"}>
                  <div class="card card-pad stack">
                    <strong>{p.label} headroom</strong>
                    <Show
                      when={p.quota === "unlimited"}
                      fallback={
                        <Show
                          when={Object.keys(p.windows).length}
                          fallback={<span>Telemetry unavailable</span>}
                        >
                          <For each={Object.entries(p.windows)}>
                            {([name, w]) => (
                              <span>
                                {name}:{" "}
                                {w.resetsAt !== null && w.resetsAt <= now()
                                  ? "window expired; awaiting telemetry"
                                  : w.observedAt === null
                                    ? "unobserved"
                                    : `${Math.round((1 - w.utilization) * 100)}% headroom`}{" "}
                                · resets{" "}
                                {w.resetsAt === null ? "unavailable" : new Date(w.resetsAt).toLocaleString()}
                              </span>
                            )}
                          </For>
                        </Show>
                      }
                    >
                      <span>Unlimited quota</span>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </section>
      <section class="stack">
        <h2>Models</h2>
        <div class="setup-grid">
          <For each={models().map((m) => m.id)}>
            {(id) => {
              const model = () => models().find((m) => m.id === id);
              return (
                <article class="card card-pad stack">
                  <strong>{id}</strong>
                  <span class="chip-tag">{model()?.source}</span>
                  <p>
                    {model()?.model} · {model()?.vendor} · {model()?.origin} · tier {model()?.tier}
                  </p>
                  <Show when={model()?.source === "runtime"}>
                    <div class="setup-controls">
                      <button
                        type="button"
                        class="btn"
                        onClick={() => setForms((old) => ({ ...old, [id]: true }))}
                      >
                        Edit model
                      </button>
                      <button type="button" class="btn" disabled={busy()[id]} onClick={() => void remove(id)}>
                        Delete model
                      </button>
                    </div>
                    <Show when={forms()[id]}>
                      <CatalogForm
                        provider={model()?.provider ?? ""}
                        backend={model()?.model ?? ""}
                        existing={model()}
                        onCancel={() => setForms((old) => ({ ...old, [id]: false }))}
                        onSaved={(c) => {
                          setCatalog(c);
                          setForms((f) => ({ ...f, [id]: false }));
                          void refresh();
                        }}
                      />
                    </Show>
                  </Show>
                  <Show when={errors()[id]}>
                    <div class="error-box" role="alert">
                      {errors()[id]}
                    </div>
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
        <For each={catalog()?.providers.map((p) => p.provider) ?? []}>
          {(id) => {
            const discovery = () => catalog()?.providers.find((p) => p.provider === id);
            return (
              <section class="stack">
                <h3>{id} discovery</h3>
                <Show when={discovery()?.served === null}>
                  <p>Served list unavailable</p>
                </Show>
                <Show when={discovery()?.served != null && discovery()?.catalogNotServed?.length}>
                  <p role="alert">Catalog but not served: {discovery()?.catalogNotServed?.join(", ")}</p>
                </Show>
                <For each={discovery()?.servedNotInCatalog ?? []}>
                  {(backend) => {
                    const key = `${id}:${backend}`;
                    return (
                      <div class="card card-pad stack">
                        <span>Served but not in catalog: {backend}</span>
                        <Show
                          when={forms()[key]}
                          fallback={
                            <button
                              type="button"
                              class="btn"
                              onClick={() => setForms((f) => ({ ...f, [key]: true }))}
                            >
                              Add
                            </button>
                          }
                        >
                          <CatalogForm
                            provider={id}
                            backend={backend}
                            onCancel={() => setForms((f) => ({ ...f, [key]: false }))}
                            onSaved={(c) => {
                              setCatalog(c);
                              setForms((f) => ({ ...f, [key]: false }));
                              void refresh();
                            }}
                          />
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </section>
            );
          }}
        </For>
      </section>
      <section class="card card-pad stack">
        <h2>Routing history</h2>
        <For each={routing()?.history ?? []}>
          {(h) => (
            <div>
              {h.key}: {JSON.stringify(h.oldValue)} → {JSON.stringify(h.newValue)} · {h.note} ·{" "}
              <time>{new Date(h.at).toLocaleString()}</time>
            </div>
          )}
        </For>
      </section>
      <section class="card card-pad stack">
        <h2>Catalog history</h2>
        <For each={catalog()?.history ?? []}>
          {(h) => (
            <div>
              {h.modelId}: {JSON.stringify(h.oldValue)} → {JSON.stringify(h.newValue)} · {h.note} ·{" "}
              <time>{new Date(h.at).toLocaleString()}</time>
            </div>
          )}
        </For>
      </section>
    </div>
  );
};
