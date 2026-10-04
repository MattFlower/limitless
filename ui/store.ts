// Process-wide live state: one SSE connection to /api/stream, hydrated from REST on first use
// and again after each gap in the stream.
// Solid stores/signals declared at module scope behave like a singleton — every page that reads
// `live.runs` / `live.providers` sees the same reactive data, and the nav's connection dot reflects
// the one shared EventSource regardless of which route is mounted.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { MAX_RUN_IDS, type ProviderStatus, type QuotaAlert, type Run } from "../src/core/types.ts";
import { getAlerts, getHealth, getProviders, listRuns, openGlobalStream } from "./api.ts";
import { createCatchUp, type Timers } from "./lib/catch-up.ts";

const [runsById, setRunsById] = createStore<Record<string, Run>>({});
const [providersById, setProvidersById] = createStore<Record<string, ProviderStatus>>(Object.create(null));
const [alertsByKey, setAlertsByKey] = createStore<Record<string, QuotaAlert>>({});
const [connected, setConnected] = createSignal(false);
const [draining, setDraining] = createSignal(false);
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
export function ensureLiveStore(
  deps = {
    listRuns,
    getProviders,
    getAlerts,
    getHealth,
    openGlobalStream,
    poll: (fn: () => void, ms: number) => {
      setInterval(fn, ms);
    },
  },
  timers?: Timers,
): void {
  if (started) return;
  started = true;
  let healthPending = false;
  const refreshHealth = async () => {
    if (healthPending) return;
    healthPending = true;
    try {
      setDraining((await deps.getHealth()).draining);
    } catch {
      // Keep the last known state while the daemon is unavailable during restart.
    } finally {
      healthPending = false;
    }
  };
  void refreshHealth();
  deps.poll(() => void refreshHealth(), 5000);
  let alertsHydrated = false;
  const pendingAlerts = new Map<string, QuotaAlert | null>();

  const sync = createCatchUp(
    async () => {
      alertsHydrated = false;
      pendingAlerts.clear();
      const [runs, providers, alerts] = await Promise.all([
        deps.listRuns({ limit: 200 }),
        deps.getProviders(),
        deps.getAlerts(),
      ]);
      // Cached runs outside that window, such as an old run resolved during a gap, are re-read by id.
      const listed = new Set(runs.map((r) => r.id));
      const omitted = Object.values(runsById)
        .filter((r) => !listed.has(r.id))
        .map((r) => r.id);
      const refreshed: Run[] = [];
      for (let i = 0; i < omitted.length; i += MAX_RUN_IDS) {
        const ids = omitted.slice(i, i + MAX_RUN_IDS);
        refreshed.push(...(await deps.listRuns({ ids, limit: ids.length })));
      }
      return [[...runs, ...refreshed], providers, alerts] as const;
    },
    ([runs, providers, alerts], pushed) => {
      setRunsById(
        produce((draft) => {
          for (const r of runs) if (!pushed.has(`run:${r.id}`)) draft[r.id] = r;
        }),
      );
      setProvidersById(
        produce((draft) => {
          for (const p of providers) if (!pushed.has(`provider:${p.id}`)) draft[p.id] = p;
        }),
      );
      const snapshot = Object.fromEntries(alerts.map((a) => [`${a.provider}:${a.window}`, a]));
      for (const [key, alert] of pendingAlerts) {
        if (alert) snapshot[key] = alert;
        else delete snapshot[key];
      }
      setAlertsByKey(reconcile(snapshot));
      alertsHydrated = true;
      pendingAlerts.clear();
      setHydrated(true);
    },
    () => {
      alertsHydrated = true;
      setHydrated(true);
    },
    timers,
  );
  sync.load();

  deps.openGlobalStream(
    (msg) => {
      if (msg.kind === "run") {
        sync.pushed(`run:${msg.run.id}`);
        upsertRun(msg.run);
      } else if (msg.kind === "provider") {
        sync.pushed(`provider:${msg.provider.id}`);
        upsertProvider(msg.provider);
      } else if (msg.kind === "alert") {
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
    },
    (connected) => {
      setConnected(connected);
      if (connected) void refreshHealth();
      sync.connected(connected);
    },
  );
}

export const live = {
  runs: runsById,
  providers: providersById,
  alerts: alertsByKey,
  connected,
  hydrated,
  draining,
};
