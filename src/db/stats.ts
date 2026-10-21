import type { EvalTrial, ReviewSystem } from "../core/types.ts";
import { parseTarget } from "../router/targets.ts";
import { activity } from "../util/stall.ts";
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
  /** Across all runs, independently of the statistics window and UI list limit. */
  needsYouRunIds?: string[];
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
  production?: HistoricalWorkload;
  eval?: HistoricalWorkload;
}

/** Calendar days use the daemon's local timezone, including across DST changes. */
export function computeProviderWorkload(store: Store, now = Date.now()): ProviderWorkload[] {
  return activity("stats.computeProviderWorkload", () => computeProviderWorkloadQuery(store, now));
}
function computeProviderWorkloadQuery(store: Store, now = Date.now()): ProviderWorkload[] {
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

/** Null metrics mean the persisted record cannot supply that measurement; sums stay unknown. */
export interface HistoricalTotals {
  invocations: number;
  successfulShare: number;
  countingUnits: { invocation: number; round: number; trial: number };
  tokensIn: number | null;
  inputTokens: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  costEquivUsd: number | null;
  wallTimeMs: number;
  p50WallTimeMs: number | null;
}
interface HistoricalRow extends HistoricalTotals {
  provider: string | null;
  modelId: string | null;
  /** Unsplit multi-call trial totals, never attributed to an individual participant. */
  compound?: boolean;
  participants?: string[];
  role?: string;
  day?: string;
}
export interface HistoricalWorkload {
  totals: HistoricalTotals;
  models: HistoricalRow[];
  roles: HistoricalRow[];
  days: HistoricalRow[];
}
type WorkRecord = Omit<
  HistoricalRow,
  "invocations" | "successfulShare" | "countingUnits" | "p50WallTimeMs" | "wallTimeMs"
> & {
  status: string;
  unit: keyof HistoricalTotals["countingUnits"];
  duration: number | null;
};

function summarize(rows: WorkRecord[]): HistoricalTotals {
  const sum = (
    key:
      | "tokensIn"
      | "tokensOut"
      | "costUsd"
      | "costEquivUsd"
      | "inputTokens"
      | "cacheReadTokens"
      | "cacheWriteTokens",
  ) =>
    rows.some((r) => r[key] == null || !Number.isFinite(r[key]))
      ? null
      : rows.reduce((n, r) => n + (r[key] ?? 0), 0);
  const durations = rows
    .flatMap((r) => (r.duration === null || !Number.isFinite(r.duration) ? [] : [Math.max(0, r.duration)]))
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  return {
    invocations: rows.length,
    successfulShare: rows.length ? rows.filter((r) => r.status === "ok").length / rows.length : 0,
    countingUnits: {
      invocation: rows.filter((r) => r.unit === "invocation").length,
      round: rows.filter((r) => r.unit === "round").length,
      trial: rows.filter((r) => r.unit === "trial").length,
    },
    tokensIn: sum("tokensIn"),
    inputTokens: sum("inputTokens"),
    tokensOut: sum("tokensOut"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    costUsd: sum("costUsd"),
    costEquivUsd: sum("costEquivUsd"),
    wallTimeMs: durations.reduce((n, ms) => n + ms, 0),
    p50WallTimeMs: durations.length
      ? ((durations[middle] ?? 0) + (durations[Math.ceil(durations.length / 2) - 1] ?? 0)) / 2
      : null,
  };
}
function historical(rows: WorkRecord[]): HistoricalWorkload {
  const groups = (dimension?: "role" | "day"): HistoricalRow[] => {
    const grouped = new Map<string, WorkRecord[]>();
    for (const row of rows) {
      const key = JSON.stringify([
        dimension ? row[dimension] : null,
        row.provider,
        row.modelId,
        row.compound,
        row.participants,
      ]);
      const values = grouped.get(key) ?? [];
      values.push(row);
      grouped.set(key, values);
    }
    return [...grouped]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, values]) => {
        const row = values[0];
        if (!row) throw new Error("Empty workload group");
        return {
          provider: row.provider,
          modelId: row.modelId,
          ...(row.compound ? { compound: true, participants: row.participants } : {}),
          ...(dimension ? { [dimension]: row[dimension] } : {}),
          ...summarize(values),
        };
      });
  };
  return { totals: summarize(rows), models: groups(), roles: groups("role"), days: groups("day") };
}

function workloadDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Historical sections exclude chat. Eval days use trial creation, even for recorded rounds. */
export function computeProviderStatistics(
  store: Store,
  since = -8_640_000_000_000_000,
  now = Date.now(),
): ProviderWorkload[] {
  const production = store.db
    .query(`SELECT provider, model_id AS modelId, role, status,
    started_at AS startedAt,
    input_tokens + cache_read_tokens + cache_write_tokens AS tokensIn, input_tokens AS inputTokens,
    output_tokens AS tokensOut, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
    cost_usd AS costUsd, cost_equiv_usd AS costEquivUsd, finished_at - started_at AS duration,
    'invocation' AS unit FROM invocations WHERE started_at >= ?`)
    .all(since) as (WorkRecord & { startedAt: number })[];
  for (const row of production) row.day = workloadDay(row.startedAt);
  const trials = store.db
    .query(
      `SELECT t.*, r.role, s.systems_json FROM eval_trials t JOIN eval_runs r ON r.id = t.eval_run_id
       LEFT JOIN eval_run_systems s ON s.eval_run_id = r.id WHERE t.created_at >= ? AND t.status != 'queued'`,
    )
    .all(since) as (Record<string, string | number | null> & {
    role: string;
    details_json: string;
    systems_json: string | null;
  })[];
  const evaluation: WorkRecord[] = [];
  for (const t of trials) {
    const details = JSON.parse(t.details_json) as EvalTrial["details"];
    if (details.cache != null || details.resumedFrom != null) continue;
    const rounds = details.rounds;
    // Skips and preparation failures can happen before any provider call.
    if (
      !rounds?.length &&
      details.interrupted !== true &&
      details.invocationStatus == null &&
      (t.status === "skipped" || details.preparationFailed) &&
      t.tokens_in === 0 &&
      t.tokens_out === 0 &&
      t.cost_usd === 0 &&
      t.cost_equiv_usd === 0
    )
      continue;
    const system = (JSON.parse(t.systems_json ?? "[]") as ReviewSystem[]).find(
      (s) => details.system !== undefined && s.name === details.system,
    );
    const compound = !rounds?.length && (!!details.verifiers?.length || (system?.finders.length ?? 0) > 1);
    const participants = compound
      ? [
          ...new Set([
            String(t.model_id),
            ...(system?.finders.flatMap((f) => (f.target ? [parseTarget(f.target).modelId] : [])) ?? []),
            ...(details.verifiers?.map((v) => v.modelId) ?? []),
          ]),
        ].sort()
      : undefined;
    const unknown = details.interrupted === true && details.invocationStatus == null;
    const records = rounds?.length
      ? rounds
      : [
          {
            provider: details.provider,
            modelId: String(t.model_id),
            status: details.invocationStatus ?? (unknown ? "interrupted" : String(t.status)),
            tokensIn: unknown ? null : Number(t.tokens_in),
            tokensOut: unknown ? null : Number(t.tokens_out),
            costUsd: unknown ? null : Number(t.cost_usd),
            costEquivUsd: unknown ? null : Number(t.cost_equiv_usd),
            durationMs: unknown ? null : Number(t.duration_ms),
          },
        ];
    for (const r of records) {
      const read = rounds?.length || unknown ? null : (details.cacheReadTokens ?? null);
      const write = rounds?.length || unknown ? null : (details.cacheWriteTokens ?? null);
      evaluation.push({
        provider: compound ? null : (r.provider ?? null),
        modelId: compound ? null : (r.modelId ?? null),
        ...(compound ? { compound: true, participants } : {}),
        role: t.role,
        day: workloadDay(Number(t.created_at)),
        status: r.status,
        unit: rounds?.length ? "round" : "trial",
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        inputTokens: read === null || write === null || r.tokensIn == null ? null : r.tokensIn - read - write,
        cacheReadTokens: read,
        cacheWriteTokens: write,
        costUsd: r.costUsd ?? null,
        costEquivUsd: r.costEquivUsd ?? null,
        duration: !rounds?.length && t.status === "running" ? null : (r.durationMs ?? null),
      });
    }
  }
  const legacy = computeProviderWorkload(store, now);
  const bucket = (r: WorkRecord) => (r.compound ? "(compound/unattributed)" : r.provider);
  const providers = new Set([
    ...legacy.map((r) => r.provider),
    ...production.map((r) => r.provider),
    ...evaluation.map(bucket),
  ]);
  return [...providers].sort().map((provider) => ({
    ...(legacy.find((r) => r.provider === provider) ?? {
      provider: provider ?? "(unknown)",
      today: emptyWorkload(),
      sevenDays: emptyWorkload(),
    }),
    production: historical(production.filter((r) => r.provider === provider)),
    eval: historical(evaluation.filter((r) => bucket(r) === provider)),
  }));
}

export function computeStats(store: Store, days = 14): Stats {
  return activity("stats.computeStats", () => computeStatsQuery(store, days));
}
function computeStatsQuery(store: Store, days = 14): Stats {
  const since = Date.now() - days * 86_400_000;
  const attention = store.db
    .query(`
    WITH RECURSIVE descendants(source, child) AS (
      SELECT source_run_id, run_id FROM review_rounds
      UNION
      SELECT d.source, rr.run_id FROM descendants d JOIN review_rounds rr ON rr.source_run_id = d.child
    )
    SELECT r.id, r.created_at AS createdAt FROM runs r
    LEFT JOIN review_rounds own ON own.run_id = r.id
    WHERE r.status IN ('failed', 'needs_human') AND r.merged = 0 AND r.resolution IS NULL
      AND (r.pr_url IS NULL OR r.pr_url NOT IN (
        SELECT pr_url FROM runs WHERE merged = 1 AND pr_url IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM land_entries l WHERE l.pr_url = r.pr_url
        AND l.state IN ('queued', 'checking', 'waiting_ci', 'merging'))
      AND NOT EXISTS (
        SELECT 1 FROM review_approvals a JOIN pr_heads h ON h.pr_url = a.pr_url AND h.sha = a.sha
        WHERE a.pr_url = r.pr_url AND a.stale_reason IS NULL
          AND a.id = (SELECT MAX(id) FROM review_approvals WHERE pr_url = r.pr_url)
          AND a.created_at > r.finished_at
          AND NOT EXISTS (SELECT 1 FROM land_entries l WHERE l.pr_url = r.pr_url
            AND l.id = (SELECT MAX(id) FROM land_entries WHERE pr_url = r.pr_url)
            AND l.state = 'blocked' AND l.updated_at >= a.created_at)
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_rounds rr JOIN runs next ON next.id = rr.run_id
        WHERE next.status IN ('queued', 'running') AND (
          rr.run_id IN (SELECT child FROM descendants WHERE source = r.id)
          OR (rr.pr_url = COALESCE(own.pr_url, r.pr_url) AND rr.round > COALESCE(own.round, 0)))
      )
  `)
    .all() as { id: string; createdAt: number }[];
  const openNeedsHuman = attention.filter((r) => r.createdAt >= since).length;
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
              SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS tin, SUM(output_tokens) AS tout
         FROM invocations WHERE started_at >= ? AND role != 'review_shadow'
        GROUP BY model_id, role ORDER BY n DESC`,
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
    needsYouRunIds: attention.map((r) => r.id),
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
      openNeedsHuman,
      openNeedsHumanRate: totals.runs ? openNeedsHuman / Number(totals.runs) : 0,
    },
  };
}
