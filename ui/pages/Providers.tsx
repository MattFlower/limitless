import type { Component } from "solid-js";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getProviderWorkload } from "../api.ts";
import { ProviderCard } from "../components/ProviderCard.tsx";
import {
  createProviderWorkloadController,
  initialWorkloadState,
  type WorkloadSection,
  type WorkloadWindow,
  workloadCell,
  workloadFor,
  workloadMetrics,
  workloadTables,
} from "../lib/provider-workload.ts";
import { ensureLiveStore, live, subscribeLiveUpdates } from "../store.ts";

export const Providers: Component = () => {
  ensureLiveStore();
  const [workload, setWorkload] = createSignal(initialWorkloadState());
  const [section, setSection] = createSignal<WorkloadSection>("production");
  const controller = createProviderWorkloadController(getProviderWorkload, setWorkload, subscribeLiveUpdates);
  const tables = createMemo(() => workloadTables(workload().rows ?? [], section()));
  const providers = createMemo(() => Object.values(live.providers).sort((a, b) => a.id.localeCompare(b.id)));

  onMount(() => {
    void controller.load();
    const timer = setInterval(controller.load, 30_000);
    onCleanup(() => {
      clearInterval(timer);
      controller.dispose();
    });
  });

  return (
    <div class="page stack">
      <div class="page-header">
        <h1 class="page-title">Providers</h1>
      </div>
      <div class="provider-grid">
        <For each={providers()}>
          {(p) => <ProviderCard provider={p} workload={workloadFor(p.id, workload().cards)} />}
        </For>
        <Show when={providers().length === 0}>
          <div class="hint-banner">No provider telemetry yet.</div>
        </Show>
      </div>
      <section class="stack">
        <h2 class="section-label">Workload</h2>
        <div class="chips">
          <span>Window</span>
          <For
            each={
              [
                ["today", "Today"],
                ["sevenDays", "7 days"],
              ] as [WorkloadWindow, string][]
            }
          >
            {([key, label]) => (
              <button
                type="button"
                class={`chip${workload().window === key ? " active" : ""}`}
                onClick={() => controller.setWindow(key)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <div class="chips">
          <span>Section</span>
          <For
            each={
              [
                ["production", "Production"],
                ["eval", "Eval"],
              ] as [WorkloadSection, string][]
            }
          >
            {([key, label]) => (
              <button
                type="button"
                class={`chip${section() === key ? " active" : ""}`}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <Show when={workload().error}>
          <div class="text-danger">{workload().error}</div>
        </Show>
        <Show when={workload().rows} fallback={<div>loading…</div>}>
          <For each={tables().unavailable}>
            {(name) => <div>{name}: historical statistics unavailable</div>}
          </For>
          <Show
            when={tables().providers.rows.length || tables().roles.rows.length}
            fallback={<div>No workload in this window.</div>}
          >
            <For each={["providers", "roles"] as const}>
              {(key) => (
                <div>
                  <h3 class="section-label">By {key === "providers" ? "provider" : "role"}</h3>
                  <div class="card">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th class="num">{section() === "eval" ? "Executions" : "Invocations"}</th>
                          <th class="num">Tokens in</th>
                          <th class="num">Tokens out</th>
                          <th class="num">Wall time</th>
                          <th class="num">API-equivalent work</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={[...tables()[key].rows, tables()[key].total]}>
                          {(row) => (
                            <tr>
                              <td class="mono">{row.name}</td>
                              <For each={workloadMetrics}>
                                {(metric) => {
                                  const cell = () =>
                                    workloadCell(metric, row[metric], tables()[key].total[metric]);
                                  return (
                                    <td class="num mono">
                                      {cell().value} <span class="text-dim">({cell().share})</span>
                                    </td>
                                  );
                                }}
                              </For>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </section>
    </div>
  );
};
