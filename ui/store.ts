// Process-wide live state: one SSE connection to /api/stream, hydrated from REST on first use.
// Solid stores/signals declared at module scope behave like a singleton — every page that reads
// `live.runs` / `live.providers` sees the same reactive data, and the nav's connection dot reflects
// the one shared EventSource regardless of which route is mounted.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ProviderStatus, Run } from "../src/core/types.ts";
import { getProviders, listRuns, openGlobalStream } from "./api.ts";

const [runsById, setRunsById] = createStore<Record<string, Run>>({});
const [providersById, setProvidersById] = createStore<Record<string, ProviderStatus>>({});
const [connected, setConnected] = createSignal(false);
const [hydrated, setHydrated] = createSignal(false);

let started = false;

function upsertRun(run: Run): void {
  setRunsById(
    produce((draft) => {
      draft[run.id] = run;
    }),
  );
}

function upsertProvider(p: ProviderStatus): void {
  setProvidersById(
    produce((draft) => {
      draft[p.id] = p;
    }),
  );
}

/** Idempotent: safe to call from every page that needs live data. */
export function ensureLiveStore(): void {
  if (started) return;
  started = true;

  Promise.all([listRuns({ limit: 200 }), getProviders()])
    .then(([runs, providers]) => {
      setRunsById(
        produce((draft) => {
          for (const r of runs) draft[r.id] = r;
        }),
      );
      setProvidersById(
        produce((draft) => {
          for (const p of providers) draft[p.id] = p;
        }),
      );
      setHydrated(true);
    })
    .catch(() => setHydrated(true));

  openGlobalStream((msg) => {
    if (msg.kind === "run") upsertRun(msg.run);
    else if (msg.kind === "provider") upsertProvider(msg.provider);
  }, setConnected);
}

export const live = {
  runs: runsById,
  providers: providersById,
  connected,
  hydrated,
};
