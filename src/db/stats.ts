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
    openNeedsHuman: number;
    openNeedsHumanRate: number;
  };
}

export interface WorkloadTotals {
  invocations: number;
  tokensIn: number;
  tokensOut: number;
  wallTimeMs: number;
  costEquivUsd: number;
}

export interface ProviderWorkload {
  provider: string;
  today: WorkloadTotals;
  sevenDays: WorkloadTotals;
}

/** Calendar days use the daemon's local timezone, including across DST changes. */
export function computeProviderWorkload(store: Store, now = Date.now()): ProviderWorkload[] {
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const sevenDays = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 6).getTime();
  const rows = store.db
    .query(`
    SELECT provider, started_at, tokens_in, tokens_out, wall_ms, cost_equiv_usd FROM (
      SELECT provider, started_at, input_tokens + cache_read_tokens + cache_write_tokens AS tokens_in,
             output_tokens AS tokens_out,
             CASE WHEN finished_at IS NULL THEN 0 ELSE MAX(0, finished_at - started_at) END AS wall_ms,
             cost_equiv_usd
        FROM invocations WHERE started_at >= ? AND started_at <= ?
      UNION ALL
      SELECT provider, started_at,
             COALESCE(json_extract(result_json, '$.usage.input'), 0) +
               COALESCE(json_extract(result_json, '$.usage.cacheRead'), 0) +
               COALESCE(json_extract(result_json, '$.usage.cacheWrite'), 0),
             COALESCE(json_extract(result_json, '$.usage.output'), 0),
             COALESCE(duration_ms, 0),
             COALESCE(json_extract(result_json, '$.costEquivUsd'), 0)
        FROM chat_calls WHERE started_at >= ? AND started_at <= ? AND json_valid(result_json)
    )
  `)
    .all(sevenDays, now, sevenDays, now) as {
    provider: string;
    started_at: number;
    tokens_in: number;
    tokens_out: number;
    wall_ms: number;
    cost_equiv_usd: number;
  }[];
  const result = new Map<string, ProviderWorkload>();
  for (const row of rows) {
    let workload = result.get(row.provider);
    if (!workload) {
      workload = { provider: row.provider, today: emptyWorkload(), sevenDays: emptyWorkload() };
      result.set(row.provider, workload);
    }
    addWorkload(workload.sevenDays, row);
    if (row.started_at >= today) addWorkload(workload.today, row);
  }
  return [...result.values()];
}

function emptyWorkload(): WorkloadTotals {
  return { invocations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0, costEquivUsd: 0 };
}

function addWorkload(
  total: WorkloadTotals,
  row: {
    tokens_in: number;
    tokens_out: number;
    wall_ms: number;
    cost_equiv_usd: number;
  },
): void {
  total.invocations += 1;
  total.tokensIn += row.tokens_in;
  total.tokensOut += row.tokens_out;
  total.wallTimeMs += row.wall_ms;
  total.costEquivUsd += row.cost_equiv_usd;
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
              SUM(status NOT IN ('ok','running','cancelled','declined')) AS failed,
              SUM(cost_usd) AS cost_usd, SUM(cost_equiv_usd) AS cost_equiv_usd,
              AVG(COALESCE(finished_at, started_at) - started_at) AS avg_ms,
              SUM(input_tokens + cache_read_tokens) AS tin, SUM(output_tokens) AS tout
         FROM invocations WHERE started_at >= ? AND role != 'review_shadow'
        GROUP BY model_id, role ORDER BY n DESC`,
    )
    .all(since) as Record<string, number | string>[];
  const totals = store.db
    .query(
      `SELECT COUNT(*) AS runs, SUM(status = 'succeeded') AS succeeded, SUM(cost_usd) AS cost_usd,
              SUM(cost_equiv_usd) AS cost_equiv_usd,
              SUM(status IN ('running','waiting_input')) AS active, SUM(status = 'queued') AS queued,
              SUM(status = 'needs_human') AS open_needs_human
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
      openNeedsHuman: Number(totals.open_needs_human ?? 0),
      openNeedsHumanRate: totals.runs ? Number(totals.open_needs_human ?? 0) / Number(totals.runs) : 0,
    },
  };
}
