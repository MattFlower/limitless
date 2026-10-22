import type { ProviderWorkload, WorkloadTotals } from "../../src/db/stats.ts";
import type { subscribeLiveUpdates } from "../store.ts";
import { compactNumber, duration, money } from "./format.ts";

export const workloadMetrics = [
  "invocations",
  "tokensIn",
  "tokensOut",
  "wallTimeMs",
  "costEquivUsd",
] as const;
type Metric = (typeof workloadMetrics)[number];
type Metrics = Record<Metric, number | null>;
type InputMetrics = Partial<Record<Metric, unknown>>;
type Section = { totals?: InputMetrics; roles?: (InputMetrics & { role?: string })[] };
type WorkloadInput = { provider: string; production?: Section; eval?: Section };
export type WorkloadSection = "production" | "eval";
export type WorkloadWindow = "today" | "sevenDays";
export type WorkloadRow = Metrics & { name: string };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const metrics = (row: InputMetrics): Metrics =>
  Object.fromEntries(workloadMetrics.map((key) => [key, finite(row[key]) ? row[key] : null])) as Metrics;
const sum = (rows: Metrics[]): Metrics =>
  metrics(
    Object.fromEntries(
      workloadMetrics.map((key) => [
        key,
        rows.reduce<number | null>((n, row) => (n === null || row[key] === null ? null : n + row[key]), 0),
      ]),
    ),
  );
const table = (rows: WorkloadRow[]) => ({
  rows: rows.sort((a, b) => (b.invocations ?? 0) - (a.invocations ?? 0) || a.name.localeCompare(b.name)),
  total: { name: "Total", ...sum(rows) },
});

export function workloadTables(rows: readonly WorkloadInput[], section: WorkloadSection) {
  const providers: WorkloadRow[] = [];
  const roles = new Map<string, Metrics[]>();
  const unavailable: string[] = [];
  for (const row of rows) {
    const history = row[section];
    if (!history) {
      unavailable.push(row.provider);
      continue;
    }
    if (finite(history.totals?.invocations) && history.totals.invocations > 0)
      providers.push({ name: row.provider, ...metrics(history.totals) });
    for (const role of history.roles ?? []) {
      const name = role.role ?? "(unknown role)";
      const group = roles.get(name) ?? [];
      group.push(metrics(role));
      roles.set(name, group);
    }
  }
  return {
    providers: table(providers),
    roles: table([...roles].map(([name, group]) => ({ name, ...sum(group) }))),
    unavailable,
  };
}

export function workloadCell(key: Metric, value: unknown, total: unknown) {
  const share = finite(value) && finite(total) && total !== 0 ? (value / total) * 100 : null;
  const format = key === "wallTimeMs" ? duration : key === "costEquivUsd" ? money : compactNumber;
  return {
    value: finite(value) ? format(value) : "unknown",
    share:
      share === null || !Number.isFinite(share)
        ? "—"
        : share > 0 && share < 0.5
          ? "<1%"
          : `${Math.round(share)}%`,
  };
}

export type ProviderWorkloadState = {
  window: WorkloadWindow;
  since: number | null;
  cards: ProviderWorkload[];
  rows: ProviderWorkload[] | null;
  error: string;
};
export const initialWorkloadState = (): ProviderWorkloadState => ({
  window: "today",
  since: null,
  cards: [],
  rows: null,
  error: "",
});
export function createProviderWorkloadController(
  read: (since: number) => Promise<ProviderWorkload[]>,
  changed: (state: ProviderWorkloadState) => void,
  subscribe?: typeof subscribeLiveUpdates,
  now = Date.now,
) {
  let state = initialWorkloadState();
  let generation = 0;
  let disposed = false;
  let inFlight = 0;
  let refreshPending = false;
  const update = (patch: Partial<ProviderWorkloadState>) => {
    state = { ...state, ...patch };
    changed(state);
  };
  const load = async () => {
    if (disposed) return;
    const request = ++generation;
    const date = new Date(now());
    const since = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - (state.window === "sevenDays" ? 6 : 0),
    ).getTime();
    if (since !== state.since) update({ since, rows: null, error: "" });
    inFlight++;
    try {
      const rows = await read(since);
      if (!disposed && request === generation) update({ cards: rows, rows, error: "" });
    } catch (error) {
      if (!disposed && request === generation) update({ error: String(error) });
    } finally {
      inFlight--;
      if (!disposed && inFlight === 0 && refreshPending) {
        refreshPending = false;
        void load();
      }
    }
  };
  const unsubscribe = subscribe?.((message) => {
    if (disposed || message.kind !== "reconnected") return;
    if (inFlight) refreshPending = true;
    else void load();
  });
  return {
    load,
    setWindow(window: WorkloadWindow) {
      if (disposed || window === state.window) return;
      update({ window, since: null, rows: null, error: "" });
      void load();
    },
    dispose() {
      disposed = true;
      generation++;
      unsubscribe?.();
    },
  };
}

const zero = (): WorkloadTotals => ({
  invocations: 0,
  tokensIn: 0,
  tokensOut: 0,
  wallTimeMs: 0,
  costEquivUsd: 0,
});

export function workloadFor(providerId: string, rows: ProviderWorkload[]): ProviderWorkload {
  return (
    rows.find((row) => row.provider === providerId) ?? {
      provider: providerId,
      today: zero(),
      sevenDays: zero(),
    }
  );
}
