import type { Store } from "./store.ts";

export interface DayStats {
  day: string; // YYYY-MM-DD (local)
  runs: number;
  succeeded: number;
  failed: number;
  costUsd: number;
  costEquivUsd: number;
}

export interface ModelStats {
  modelId: string;
  role: string;
  invocations: number;
  ok: number;
  failed: number;
  costUsd: number;
  costEquivUsd: number;
  avgDurationMs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface Stats {
  days: DayStats[];
  models: ModelStats[];
  totals: {
    runs: number;
    succeeded: number;
    costUsd: number;
    costEquivUsd: number;
    active: number;
    queued: number;
  };
}

export function computeStats(store: Store, days = 14): Stats {
  const since = Date.now() - days * 86_400_000;
  const dayRows = store.db
    .query(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS runs,
              SUM(status = 'succeeded') AS succeeded,
              SUM(status IN ('failed','needs_human')) AS failed,
              SUM(cost_usd) AS cost_usd, SUM(cost_equiv_usd) AS cost_equiv_usd
         FROM runs WHERE created_at >= ? GROUP BY day ORDER BY day`,
    )
    .all(since) as Record<string, number | string>[];
  const modelRows = store.db
    .query(
      `SELECT model_id, role, COUNT(*) AS n, SUM(status = 'ok') AS ok,
              SUM(status NOT IN ('ok','running','cancelled')) AS failed,
              SUM(cost_usd) AS cost_usd, SUM(cost_equiv_usd) AS cost_equiv_usd,
              AVG(COALESCE(finished_at, started_at) - started_at) AS avg_ms,
              SUM(input_tokens + cache_read_tokens) AS tin, SUM(output_tokens) AS tout
         FROM invocations WHERE started_at >= ? GROUP BY model_id, role ORDER BY n DESC`,
    )
    .all(since) as Record<string, number | string>[];
  const totals = store.db
    .query(
      `SELECT COUNT(*) AS runs, SUM(status = 'succeeded') AS succeeded, SUM(cost_usd) AS cost_usd,
              SUM(cost_equiv_usd) AS cost_equiv_usd,
              SUM(status IN ('running','waiting_input')) AS active, SUM(status = 'queued') AS queued
         FROM runs WHERE created_at >= ?`,
    )
    .get(since) as Record<string, number>;
  return {
    days: dayRows.map((r) => ({
      day: String(r.day),
      runs: Number(r.runs),
      succeeded: Number(r.succeeded ?? 0),
      failed: Number(r.failed ?? 0),
      costUsd: Number(r.cost_usd ?? 0),
      costEquivUsd: Number(r.cost_equiv_usd ?? 0),
    })),
    models: modelRows.map((r) => ({
      modelId: String(r.model_id),
      role: String(r.role),
      invocations: Number(r.n),
      ok: Number(r.ok ?? 0),
      failed: Number(r.failed ?? 0),
      costUsd: Number(r.cost_usd ?? 0),
      costEquivUsd: Number(r.cost_equiv_usd ?? 0),
      avgDurationMs: Math.round(Number(r.avg_ms ?? 0)),
      tokensIn: Number(r.tin ?? 0),
      tokensOut: Number(r.tout ?? 0),
    })),
    totals: {
      runs: Number(totals.runs ?? 0),
      succeeded: Number(totals.succeeded ?? 0),
      costUsd: Number(totals.cost_usd ?? 0),
      costEquivUsd: Number(totals.cost_equiv_usd ?? 0),
      active: Number(totals.active ?? 0),
      queued: Number(totals.queued ?? 0),
    },
  };
}
