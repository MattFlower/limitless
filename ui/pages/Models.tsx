import type { Component } from "solid-js";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { ProviderWorkload, Stats } from "../../src/db/stats.ts";
import type { ModelDef, Policy } from "../../src/router/catalog.ts";
import { getModels, getProviderWorkload, getStats } from "../api.ts";
import { CostCell } from "../components/CostCell.tsx";
import { ProviderCard } from "../components/ProviderCard.tsx";
import { duration } from "../lib/format.ts";
import { workloadFor } from "../lib/provider-workload.ts";
import { ensureLiveStore, live } from "../store.ts";

export const Models: Component = () => {
  ensureLiveStore();
  const [catalog, setCatalog] = createSignal<{ models: ModelDef[]; policy: Policy } | null>(null);
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [workload, setWorkload] = createSignal<ProviderWorkload[]>([]);

  onMount(() => {
    getModels()
      .then(setCatalog)
      .catch(() => {});
    getStats(14)
      .then(setStats)
      .catch(() => {});
    getProviderWorkload()
      .then(setWorkload)
      .catch(() => {});
  });

  const providers = createMemo(() => Object.values(live.providers).sort((a, b) => a.id.localeCompare(b.id)));
  const statsByModel = createMemo(() => {
    const map = new Map<string, Stats["models"]>();
    for (const m of stats()?.models ?? []) {
      const list = map.get(m.modelId) ?? [];
      list.push(m);
      map.set(m.modelId, list);
    }
    return map;
  });

  return (
    <div class="page stack">
      <div class="page-header">
        <h1 class="page-title">Models &amp; routing</h1>
      </div>

      <div>
        <div class="section-label">Providers</div>
        <div class="provider-grid">
          <For each={providers()}>
            {(p) => <ProviderCard provider={p} workload={workloadFor(p.id, workload())} />}
          </For>
        </div>
      </div>

      <div>
        <div class="section-label">Model catalog</div>
        <div class="card">
          <table class="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Provider</th>
                <th>Vendor</th>
                <th>Supported efforts (default)</th>
                <th>Origin</th>
                <th>Base origin</th>
                <th class="num">Tier</th>
                <th class="num">$/M in</th>
                <th class="num">$/M out</th>
                <th class="num">Invocations (14d)</th>
                <th class="num">Ok / Failed</th>
                <th class="num">Avg duration</th>
                <th class="num">Cost (14d)</th>
              </tr>
            </thead>
            <tbody>
              <Show
                when={catalog()}
                fallback={
                  <tr class="empty-row">
                    <td colspan={13}>loading…</td>
                  </tr>
                }
              >
                {(c) => (
                  <For each={c().models}>
                    {(m) => {
                      const rows = statsByModel().get(m.id) ?? [];
                      const invocations = rows.reduce((a, r) => a + r.invocations, 0);
                      const ok = rows.reduce((a, r) => a + r.ok, 0);
                      const failed = rows.reduce((a, r) => a + r.failed, 0);
                      const costUsd = rows.reduce((a, r) => a + r.costUsd, 0);
                      const costEquivUsd = rows.reduce((a, r) => a + r.costEquivUsd, 0);
                      const avgMs = rows.length
                        ? rows.reduce((a, r) => a + r.avgDurationMs, 0) / rows.length
                        : 0;
                      return (
                        <tr>
                          <td class="mono text-accent">{m.id}</td>
                          <td class="mono text-dim">{m.provider}</td>
                          <td class="mono text-faint">{m.vendor}</td>
                          <td>
                            {m.supportedEfforts.join(", ") || "unsupported"} (default:{" "}
                            {m.effort ?? "backend default"})
                          </td>
                          <td class="mono">{m.origin}</td>
                          <td class="mono">{m.baseOrigin}</td>
                          <td class="num mono">{m.tier}</td>
                          <td class="num mono">${m.price.input.toFixed(2)}</td>
                          <td class="num mono">${m.price.output.toFixed(2)}</td>
                          <td class="num mono">{invocations || "—"}</td>
                          <td class="num mono">
                            <Show when={invocations} fallback="—">
                              <span class="text-success">{ok}</span> /{" "}
                              <span class="text-danger">{failed}</span>
                            </Show>
                          </td>
                          <td class="num mono">{avgMs ? duration(avgMs) : "—"}</td>
                          <CostCell costUsd={costUsd} costEquivUsd={costEquivUsd} />
                        </tr>
                      );
                    }}
                  </For>
                )}
              </Show>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div class="section-label">Routing policy</div>
        <div class="card card-pad stack" style={{ gap: "14px" }}>
          <Show when={catalog()} fallback={<span class="text-faint mono">loading…</span>}>
            {(c) => (
              <For each={Object.entries(c().policy)}>
                {([role, byComplexity]) => (
                  <div>
                    <div
                      class="mono text-accent"
                      style={{ "font-size": "12.5px", "font-weight": "600", "margin-bottom": "6px" }}
                    >
                      {role}
                    </div>
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Complexity</th>
                          <th>Ordered candidate groups</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={Object.entries(byComplexity ?? {})}>
                          {([complexity, groups]) => (
                            <tr>
                              <td class="mono text-dim">{complexity}</td>
                              <td class="mono">
                                <For each={groups}>
                                  {(g, i) => (
                                    <span>
                                      {i() > 0 ? <span class="text-faint"> → </span> : null}
                                      <span class="chip-tag">{g}</span>
                                    </span>
                                  )}
                                </For>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                )}
              </For>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};
