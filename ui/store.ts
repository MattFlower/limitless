// Process-wide live state: one SSE connection to /api/stream, hydrated from REST on first use.
// Solid stores/signals declared at module scope behave like a singleton — every page that reads
// `live.runs` / `live.providers` sees the same reactive data, and the nav's connection dot reflects
// the one shared EventSource regardless of which route is mounted.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ProviderStatus, QuotaAlert, Run } from "../src/core/types.ts";
import { getAlerts, getProviders, listRuns, openGlobalStream } from "./api.ts";

const [runsById, setRunsById] = createStore<Record<string, Run>>({});
const [providersById, setProvidersById] = createStore<Record<string, ProviderStatus>>({});
const [alertsByKey, setAlertsByKey] = createStore<Record<string, QuotaAlert>>({});
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
  let alertsHydrated = false;
  const pendingAlerts = new Map<string, QuotaAlert | null>();

  Promise.all([listRuns({ limit: 200 }), getProviders(), getAlerts()])
    .then(([runs, providers, alerts]) => {
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
      const snapshot = Object.fromEntries(alerts.map((a) => [`${a.provider}:${a.window}`, a]));
      for (const [key, alert] of pendingAlerts) {
        if (alert) snapshot[key] = alert;
        else delete snapshot[key];
      }
      setAlertsByKey(snapshot);
      alertsHydrated = true;
      pendingAlerts.clear();
      setHydrated(true);
    })
    .catch(() => {
      alertsHydrated = true;
      setHydrated(true);
    });

  openGlobalStream((msg) => {
    if (msg.kind === "run") upsertRun(msg.run);
    else if (msg.kind === "provider") upsertProvider(msg.provider);
    else if (msg.kind === "alert") {
      const key = `${msg.provider}:${msg.window}`;
      if (!alertsHydrated) pendingAlerts.set(key, msg.alert);
      if (msg.alert) setAlertsByKey(key, msg.alert);
      else
        setAlertsByKey(
          produce((draft) => {
            delete draft[key];
          }),
        );
    }
  }, setConnected);
}

export const live = {
  runs: runsById,
  providers: providersById,
  alerts: alertsByKey,
  connected,
  hydrated,
};
