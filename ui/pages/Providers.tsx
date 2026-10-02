import type { Component } from "solid-js";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ProviderWorkload } from "../../src/db/stats.ts";
import { getProviderWorkload } from "../api.ts";
import { ProviderCard } from "../components/ProviderCard.tsx";
import { workloadFor } from "../lib/provider-workload.ts";
import { ensureLiveStore, live } from "../store.ts";

export const Providers: Component = () => {
  ensureLiveStore();
  const [workload, setWorkload] = createSignal<ProviderWorkload[]>([]);
  const providers = createMemo(() => Object.values(live.providers).sort((a, b) => a.id.localeCompare(b.id)));

  onMount(() => {
    const refresh = () => {
      getProviderWorkload()
        .then(setWorkload)
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <div class="page stack">
      <div class="page-header">
        <h1 class="page-title">Providers</h1>
      </div>
      <div class="provider-grid">
        <For each={providers()}>
          {(p) => <ProviderCard provider={p} workload={workloadFor(p.id, workload())} />}
        </For>
        <Show when={providers().length === 0}>
          <div class="hint-banner">No provider telemetry yet.</div>
        </Show>
      </div>
    </div>
  );
};
