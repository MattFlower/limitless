import { Database } from "bun:sqlite";
import type { WebAuthnCredential } from "@simplewebauthn/server";
import { AUDIT_ALLOWANCES, parseAllow, validateAllow } from "../core/allow.ts";
import { assertExistingBranchDelivery, type FactoryBranchGrant } from "../core/delivery.ts";
import type {
  ArtifactMeta,
  AuthPasskey,
  AuthSession,
  ChatMessage,
  ChatOrigin,
  ChatProposal,
  ChatProposalFields,
  CreateRunRequest,
  EvalRun,
  EvalTrial,
  EventType,
  FeedAck,
  FeedItem,
  FeedPage,
  GitHubAccessProblem,
  GitHubFeedKind,
  Invocation,
  InvocationStatus,
  LandEntry,
  LandFeedKind,
  OperatorRoutingCell,
  Question,
  QuotaAlert,
  Repo,
  ResolutionKind,
  ReviewApproval,
  ReviewFinding,
  ReviewRound,
  RoutingChange,
  Run,
  RunDetail,
  RunEvent,
  RunResolution,
  RunStatus,
  Stage,
  StageName,
  StageStatus,
  StreamMessage,
  TrackedPr,
} from "../core/types.ts";
import {
  ACTIVE_LAND_STATES,
  DEFAULT_EVAL_CONCURRENCY,
  MAX_RUN_IDS,
  TERMINAL_STATUSES,
} from "../core/types.ts";
import type { RunState } from "../pipeline/context.ts";
import { MIGRATION_DIR, runMigrations } from "./migration-runner.ts";

type Row = Record<string, unknown>;
type Listener = (msg: StreamMessage) => void;

const MAX_EVENT_DATA = 16_000;

/** A run id as `newId()` makes it: lowercase base 36. */
const RUN_ID = /^[0-9a-z]{1,32}$/;

export function newId(prefix = ""): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${prefix}${time}${rand}`;
}

function json(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

const FEED_SELECT =
  "SELECT id, ts, kind, run_id AS runId, eval_id AS evalId, repo, title, summary, data FROM feed";
type FeedInsert = Pick<FeedItem, "kind" | "runId" | "repo" | "summary" | "data"> & { key: string };
type GitHubFeedInput = FeedInsert & { kind: GitHubFeedKind };
const LAND_SELECT = `SELECT id, run_id AS runId, repo, pr_url AS prUrl, base_branch AS baseBranch,
  head_branch AS headBranch, approved_sha AS approvedSha, state, pushed_sha AS pushedSha,
  attempts, reason, created_at AS createdAt, updated_at AS updatedAt,
  finished_at AS finishedAt FROM land_entries`;
const LAND_PATCH_COLUMNS: Record<string, string> = {
  state: "state",
  pushedSha: "pushed_sha",
  logPath: "log_path",
  attempts: "attempts",
  reason: "reason",
};
const toFeedItem = (r: Row) => ({ ...r, data: parse(r.data, {}) }) as FeedItem;
/** The highest id retention has removed, so a cursor before it is told items were pruned. */
const FEED_PRUNED = "feed_pruned_through";
const AUTH_SESSION_SELECT =
  "SELECT id, method, device, created_at AS createdAt, last_seen_at AS lastSeenAt FROM auth_sessions";

function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Truncate large event payloads; full raw streams are kept in per-invocation log files. */
function clampData(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  const s = JSON.stringify(data);
  if (s.length <= MAX_EVENT_DATA) return s;
  return JSON.stringify({ truncated: true, preview: s.slice(0, MAX_EVENT_DATA) });
}

const EVAL_RUN_SELECT =
  "SELECT eval_runs.*, rounds, strategy, systems_json, concurrency, resumed_from, resumed_by FROM eval_runs LEFT JOIN eval_run_options o ON o.eval_run_id = id LEFT JOIN eval_run_systems s ON s.eval_run_id = id LEFT JOIN eval_run_concurrency c ON c.eval_run_id = id LEFT JOIN eval_run_requests q ON q.eval_run_id = id";
const toEvalRun = (r: Row): EvalRun => ({
  id: r.id as string,
  role: r.role as EvalRun["role"],
  rounds: (r.rounds as number | null) ?? 1,
  strategy: (r.strategy as EvalRun["strategy"]) ?? "retry",
  ...(r.systems_json ? { systems: parse(r.systems_json, []) } : {}),
  models: parse(r.models, []),
  k: r.k as number,
  maxUsd: r.max_usd as number,
  ...(r.concurrency == null ? {} : { concurrency: r.concurrency as number }),
  status: r.status as EvalRun["status"],
  createdAt: r.created_at as number,
  finishedAt: r.finished_at as number | null,
  error: r.error as string | null,
  ...(r.resumed_from ? { resumedFrom: r.resumed_from as string } : {}),
  ...(r.resumed_by ? { resumedBy: r.resumed_by as string } : {}),
});
const toEvalTrial = (r: Row): EvalTrial => ({
  evalRunId: r.eval_run_id as string,
  caseId: r.case_id as string,
  modelId: r.model_id as string,
  effort: r.effort as EvalTrial["effort"],
  trial: r.trial as number,
  cacheKey: r.cache_key as string,
  harness: r.harness as string,
  status: r.status as EvalTrial["status"],
  output: parse(r.output_json, null),
  pass: r.pass === null ? null : r.pass === 1,
  score: r.score as number | null,
  details: parse(r.details_json, {}),
  costUsd: r.cost_usd as number,
  costEquivUsd: r.cost_equiv_usd as number,
  tokensIn: r.tokens_in as number,
  tokensOut: r.tokens_out as number,
  durationMs: r.duration_ms as number,
  createdAt: r.created_at as number,
});

const toRepo = (r: Row): Repo => ({
  id: r.id as string,
  slug: r.slug as string,
  kind: r.kind as Repo["kind"],
  url: (r.url as string) ?? null,
  localPath: (r.local_path as string) ?? null,
  defaultBranch: r.default_branch as string,
  mergePolicy: r.merge_policy as Repo["mergePolicy"],
  createdAt: r.created_at as number,
});

const toRun = (r: Row): Run => ({
  id: r.id as string,
  repoId: r.repo_id as string,
  repoSlug: (r.repo_slug as string) ?? "",
  title: r.title as string,
  prompt: r.prompt as string,
  source: r.source as Run["source"],
  githubWebhookVerified: r.github_webhook_verified === 1,
  sourceRef: parse(r.source_ref, null),
  flow: parse<{ flow?: Run["flow"] }>(r.state_json, {}).flow ?? "build",
  requestedBy: (r.requested_by as string) ?? null,
  profile: r.profile as Run["profile"],
  resolvedProfile: (r.resolved_profile as Run["resolvedProfile"]) ?? null,
  taskClass: (r.task_class as Run["taskClass"]) ?? null,
  complexity: (r.complexity as Run["complexity"]) ?? null,
  status: r.status as RunStatus,
  dependsOn: parse(r.depends_on, []),
  prClosedUnmerged: Boolean(r.pr_closed_unmerged),
  resolution: parse(r.resolution, null),
  stage: (r.stage as StageName) ?? null,
  baseBranch: (r.base_branch as string) ?? null,
  deliveryBranch: (r.delivery_branch as string) ?? null,
  baseSha: (r.base_sha as string) ?? null,
  branch: (r.branch as string) ?? null,
  headSha: (r.head_sha as string) ?? null,
  prUrl: (r.pr_url as string) ?? null,
  merged: Boolean(r.merged),
  mergedBy: (r.merged_by as string) ?? null,
  mergedAt: (r.merged_at as number) ?? null,
  costUsd: r.cost_usd as number,
  costEquivUsd: r.cost_equiv_usd as number,
  tokensIn: r.tokens_in as number,
  tokensOut: r.tokens_out as number,
  error: (r.error as string) ?? null,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number) ?? null,
  finishedAt: (r.finished_at as number) ?? null,
  priority: r.priority as number,
  ...(r.no_baseline_cache === 1 ? { noBaselineCache: true } : {}),
  models: parse(r.models_json, {}),
  allow: AUDIT_ALLOWANCES.filter((kind) => parse<unknown[]>(r.audit_allow, []).includes(kind)),
});

const toStage = (r: Row): Stage => ({
  id: r.id as number,
  runId: r.run_id as string,
  name: r.name as StageName,
  round: r.round as number,
  status: r.status as StageStatus,
  summary: (r.summary as string) ?? null,
  startedAt: r.started_at as number,
  finishedAt: (r.finished_at as number) ?? null,
});

const toInvocation = (r: Row): Invocation => ({
  waitMs: r.wait_ms as number,
  fast: r.fast === 1,
  fastModeState: (r.fast_mode_state as string) ?? null,
  fastModeDisabledReason: (r.fast_mode_disabled_reason as string) ?? null,
  id: r.id as number,
  runId: r.run_id as string,
  stageId: (r.stage_id as number) ?? null,
  role: r.role as Invocation["role"],
  harness: r.harness as string,
  provider: r.provider as string,
  model: r.model as string,
  modelId: r.model_id as string,
  effort: r.effort as Invocation["effort"],
  status: r.status as InvocationStatus,
  costUsd: r.cost_usd as number,
  costEquivUsd: r.cost_equiv_usd as number,
  inputTokens: r.input_tokens as number,
  outputTokens: r.output_tokens as number,
  cacheReadTokens: r.cache_read_tokens as number,
  cacheWriteTokens: r.cache_write_tokens as number,
  numTurns: r.num_turns as number,
  sessionId: (r.session_id as string) ?? null,
  error: (r.error as string) ?? null,
  startedAt: r.started_at as number,
  finishedAt: (r.finished_at as number) ?? null,
});

const toEvent = (r: Row): RunEvent => ({
  id: r.id as number,
  runId: r.run_id as string,
  invocationId: (r.invocation_id as number) ?? null,
  ts: r.ts as number,
  type: r.type as EventType,
  level: r.level as RunEvent["level"],
  message: r.message as string,
  data: parse(r.data, null),
});

const toQuestion = (r: Row): Question => ({
  id: r.id as number,
  runId: r.run_id as string,
  question: r.question as string,
  answer: (r.answer as string) ?? null,
  askedAt: r.asked_at as number,
  answeredAt: (r.answered_at as number) ?? null,
  answeredBy: (r.answered_by as string) ?? null,
});

export interface BaselineCacheKey {
  repoId: string;
  baseSha: string;
  gatesHash: string;
  /** Lockfiles, Bun version, platform/arch, Limitless build and gate environment digest. */
  envHash: string;
}

/** Issue numbers named by standalone `Closes #N` directives. */
export const closedIssues = (prompt: string) =>
  new Set([...prompt.matchAll(/\bcloses\s+#([1-9][0-9]*)(?![\w#])/gi)].map((m) => Number(m[1])));

const RUN_SELECT = "SELECT runs.*, repos.slug AS repo_slug FROM runs JOIN repos ON repos.id = runs.repo_id";

export interface RunPatch {
  title?: string;
  status?: RunStatus;
  stage?: StageName | null;
  resolvedProfile?: Run["resolvedProfile"];
  taskClass?: Run["taskClass"];
  complexity?: Run["complexity"];
  baseBranch?: string;
  baseSha?: string;
  branch?: string;
  headSha?: string;
  prUrl?: string;
  merged?: boolean;
  prClosedUnmerged?: boolean;
  mergedBy?: string | null;
  mergedAt?: number | null;
  error?: string | null;
  startedAt?: number;
  finishedAt?: number | null;
}

const RUN_PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  title: "title",
  status: "status",
  stage: "stage",
  resolvedProfile: "resolved_profile",
  taskClass: "task_class",
  complexity: "complexity",
  baseBranch: "base_branch",
  baseSha: "base_sha",
  branch: "branch",
  headSha: "head_sha",
  prUrl: "pr_url",
  merged: "merged",
  prClosedUnmerged: "pr_closed_unmerged",
  mergedBy: "merged_by",
  mergedAt: "merged_at",
  error: "error",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export interface InvocationPatch {
  fastModeState?: string | null;
  fastModeDisabledReason?: string | null;
  status?: InvocationStatus;
  costUsd?: number;
  costEquivUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  numTurns?: number;
  sessionId?: string | null;
  error?: string | null;
  finishedAt?: number;
}

const INVOCATION_PATCH_COLUMNS: Record<keyof InvocationPatch, string> = {
  fastModeState: "fast_mode_state",
  fastModeDisabledReason: "fast_mode_disabled_reason",
  status: "status",
  costUsd: "cost_usd",
  costEquivUsd: "cost_equiv_usd",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
  cacheWriteTokens: "cache_write_tokens",
  numTurns: "num_turns",
  sessionId: "session_id",
  error: "error",
  finishedAt: "finished_at",
};

function buildUpdate(patch: object, columns: Record<string, string>): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = columns[key];
    if (!col || value === undefined) continue;
    sets.push(`${col} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  return { sets, values };
}

export class Store {
  readonly db: Database;
  private listeners = new Set<Listener>();
  private pendingPublications: StreamMessage[] | null = null;
  private feedPublished = 0;
  private feedPublishing = false;

  constructor(path: string, migrationDir = MIGRATION_DIR) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      runMigrations(this.db, migrationDir);
      this.feedPublished = this.feedIssued();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createEvalRun(
    input: Pick<
      EvalRun,
      "role" | "models" | "k" | "maxUsd" | "rounds" | "strategy" | "systems" | "concurrency"
    >,
    trials: EvalTrial[],
    /** The validated request, kept so `eval resume` can replay it; `resumedFrom` is the run it resumes. */
    request?: unknown,
    resumedFrom?: string,
  ): EvalRun {
    const run: EvalRun = {
      ...input,
      ...(resumedFrom ? { resumedFrom } : {}),
      rounds: input.rounds ?? 1,
      strategy: input.strategy ?? "retry",
      concurrency: input.concurrency ?? DEFAULT_EVAL_CONCURRENCY,
      id: newId("eval-"),
      status: "queued",
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO eval_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          run.id,
          run.role,
          JSON.stringify(run.models),
          run.k,
          run.maxUsd,
          run.status,
          run.createdAt,
          null,
          null,
        );
      this.db
        .query("INSERT INTO eval_run_options VALUES (?, ?, ?)")
        .run(run.id, run.rounds ?? 1, run.strategy ?? "retry");
      this.db
        .query("INSERT INTO eval_run_concurrency VALUES (?, ?)")
        .run(run.id, run.concurrency ?? DEFAULT_EVAL_CONCURRENCY);
      if (run.systems)
        this.db.query("INSERT INTO eval_run_systems VALUES (?, ?)").run(run.id, JSON.stringify(run.systems));
      if (request !== undefined)
        this.db
          .query("INSERT INTO eval_run_requests VALUES (?, ?, ?, NULL)")
          .run(run.id, JSON.stringify(request), resumedFrom ?? null);
      if (resumedFrom) {
        const linked = this.db
          .query("UPDATE eval_run_requests SET resumed_by = ? WHERE eval_run_id = ? AND resumed_by IS NULL")
          .run(run.id, resumedFrom);
        if (linked.changes !== 1) throw new Error(`eval ${resumedFrom} was already resumed`);
        // The predecessor keeps its error for diagnosis.
        this.db.query("UPDATE eval_runs SET status = 'interrupted' WHERE id = ?").run(resumedFrom);
      }
      for (const trial of trials) this.recordEvalTrial({ ...trial, evalRunId: run.id });
    })();
    this.publishFeed();
    return run;
  }

  updateEvalRun(id: string, status: EvalRun["status"], error: string | null = null): void {
    const finished = status === "queued" || status === "running" ? null : Date.now();
    this.db
      .query("UPDATE eval_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, finished, error, id);
    this.publishFeed();
  }

  getEvalRun(id: string): EvalRun | null {
    const row = this.db.query(`${EVAL_RUN_SELECT} WHERE id = ?`).get(id) as Row | null;
    return row ? toEvalRun(row) : null;
  }

  listEvalRuns(): EvalRun[] {
    return (this.db.query(`${EVAL_RUN_SELECT} ORDER BY created_at DESC, id DESC`).all() as Row[]).map(
      toEvalRun,
    );
  }

  recordEvalTrial(t: EvalTrial): void {
    this.db
      .query(`INSERT INTO eval_trials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
      cache_key=excluded.cache_key, harness=excluded.harness, status=excluded.status,
      output_json=excluded.output_json, pass=excluded.pass, score=excluded.score, details_json=excluded.details_json,
      cost_usd=excluded.cost_usd, cost_equiv_usd=excluded.cost_equiv_usd, tokens_in=excluded.tokens_in,
      tokens_out=excluded.tokens_out, duration_ms=excluded.duration_ms, created_at=excluded.created_at`)
      .run(
        t.evalRunId,
        t.caseId,
        t.modelId,
        t.trial,
        t.cacheKey,
        t.harness,
        t.status,
        json(t.output),
        t.pass === null ? null : Number(t.pass),
        t.score,
        JSON.stringify(t.details),
        t.costUsd,
        t.costEquivUsd,
        t.tokensIn,
        t.tokensOut,
        t.durationMs,
        t.createdAt,
        t.effort ?? null,
      );
  }

  listEvalTrials(id: string): EvalTrial[] {
    return (
      this.db.query("SELECT * FROM eval_trials WHERE eval_run_id = ? ORDER BY rowid").all(id) as Row[]
    ).map(toEvalTrial);
  }

  cachedEvalTrials(key: string): EvalTrial[] {
    return (
      this.db
        .query(
          "SELECT * FROM eval_trials WHERE cache_key = ? AND status = 'ok' ORDER BY created_at DESC, rowid DESC",
        )
        .all(key) as Row[]
    ).map(toEvalTrial);
  }

  /**
   * A run's spend, including the spend of every eval it resumed. A copied trial (`resumedFrom`)
   * repeats its original's cost, which the chain already counts.
   */
  evalSpend(id: string): number {
    return (
      this.db
        .query(
          `WITH RECURSIVE chain(id) AS (
            SELECT ?
            UNION ALL
            SELECT q.resumed_from FROM eval_run_requests q JOIN chain ON q.eval_run_id = chain.id
            WHERE q.resumed_from IS NOT NULL
          )
          SELECT COALESCE(SUM(t.cost_usd), 0) AS spend FROM chain JOIN eval_trials t ON t.eval_run_id = chain.id
          WHERE json_extract(t.details_json, '$.resumedFrom') IS NULL`,
        )
        .get(id) as { spend: number }
    ).spend;
  }

  /** The stored request of an eval run, or null for runs that predate stored requests. */
  evalRequest(id: string): unknown {
    const row = this.db.query("SELECT request_json FROM eval_run_requests WHERE eval_run_id = ?").get(id) as {
      request_json: string;
    } | null;
    return row ? parse(row.request_json, null) : null;
  }

  /** Ends a run's unfinished trials unscored: an interrupted trial is neither a pass nor a failure. */
  interruptEval(id: string, reason: string, status: "interrupted" | "failed" = "interrupted"): void {
    this.db.transaction(() => {
      for (const trial of this.listEvalTrials(id)) {
        if (trial.status === "queued" || trial.status === "running")
          this.recordEvalTrial({
            ...trial,
            status: "skipped",
            pass: null,
            score: null,
            details: {
              ...trial.details,
              interrupted: trial.status === "running",
              reason: trial.status === "running" ? `${reason}; final usage unknown` : reason,
            },
          });
      }
      this.updateEvalRun(id, status, reason);
    })();
    this.publishFeed();
  }

  recoverEvals(): void {
    for (const run of this.listEvalRuns()) {
      if (run.status !== "queued" && run.status !== "running") continue;
      // Only suggest a resume that `EvalRunner.resume` would not refuse outright.
      const stored = this.evalRequest(run.id) as { request?: { cache?: boolean } } | null;
      this.interruptEval(
        run.id,
        stored?.request && stored.request.cache !== false
          ? `interrupted by daemon restart; \`limitless eval resume ${run.id}\` reuses its finished trials`
          : "interrupted by daemon restart; submit a new eval to rerun it",
      );
    }
  }

  // ---- pub/sub -------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(msg: StreamMessage): void {
    if (this.pendingPublications) {
      this.pendingPublications.push(msg);
      return;
    }
    if (msg.kind !== "feed") this.publishFeed();
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // A broken subscriber must never break the pipeline.
      }
    }
  }

  /** Publish only after commit, including the run and its proposal linkage. */
  private chatTransaction<T>(fn: () => T): T {
    if (this.pendingPublications) return fn();
    const messages: StreamMessage[] = [];
    this.pendingPublications = messages;
    let result: T;
    try {
      result = this.db.transaction(fn)();
    } finally {
      this.pendingPublications = null;
    }
    for (const message of messages) this.publish(message);
    this.publishFeed();
    return result;
  }

  // Drain after commit, guarding reentrancy so subscriber mutations join this pass in id order.
  private publishFeed(): void {
    if (this.db.inTransaction || this.feedPublishing) return;
    this.feedPublishing = true;
    try {
      const query = this.db.query<Row, [number]>(`${FEED_SELECT} WHERE id > ? ORDER BY id LIMIT 1`);
      for (let row = query.get(this.feedPublished); row; row = query.get(this.feedPublished)) {
        this.feedPublished = row.id as number;
        this.publish({ kind: "feed", item: toFeedItem(row) });
      }
    } finally {
      this.feedPublishing = false;
    }
  }

  daemonStarted(bootId: string, version: string, sha: string): void {
    const data = json({ version, bootId, sha });
    this.db
      .query("INSERT INTO feed_add VALUES ('daemon.started', NULL, NULL, ?, ?, ?, ?)")
      .run(`Limitless ${version} started`, `Daemon ${version} (${sha}) started`, data, bootId);
    this.publishFeed();
  }

  readFeed(opts: { consumer?: string; after?: number; limit?: number } = {}): FeedPage {
    const after = opts.after ?? (opts.consumer === undefined ? 0 : this.feedCursor(opts.consumer));
    const query = this.db.query(`${FEED_SELECT} WHERE id > ? ORDER BY id LIMIT ?`);
    const items = (query.all(after, opts.limit ?? 100) as Row[]).map(toFeedItem);
    return { items, nextAfter: items.at(-1)?.id ?? after, pruned: this.getSetting(FEED_PRUNED, 0) > after };
  }

  feedCursor(consumer: string): number {
    return this.feedNumber("SELECT acked_id AS n FROM feed_cursors WHERE consumer = ?", consumer);
  }

  /** The highest id ever issued, counting AUTOINCREMENT gaps and pruned items. */
  private feedIssued(): number {
    return this.feedNumber("SELECT seq AS n FROM sqlite_sequence WHERE name = 'feed'");
  }

  private feedNumber(sql: string, ...params: string[]): number {
    return (this.db.query(sql).get(...params) as { n: number } | null)?.n ?? 0;
  }

  ackFeed(consumer: string, id: number): FeedAck {
    if (id > this.feedIssued()) throw new Error(`feed id ${id} has not been issued`);
    const upsert = `INSERT INTO feed_cursors VALUES (?, ?) ON CONFLICT (consumer)
      DO UPDATE SET acked_id = max(acked_id, excluded.acked_id) RETURNING acked_id`;
    return { consumer, id: (this.db.query(upsert).get(consumer, id) as Row).acked_id as number };
  }

  pruneFeed(cutoff: number, dryRun = false): number {
    return this.db.transaction(() => {
      const old = this.db
        .query("SELECT count(*) AS n, max(id) AS top FROM feed WHERE ts < ?")
        .get(cutoff) as Row;
      if (dryRun || old.top === null) return old.n as number;
      this.db.query("DELETE FROM feed WHERE ts < ?").run(cutoff);
      this.setSetting(FEED_PRUNED, Math.max(this.getSetting(FEED_PRUNED, 0), old.top as number));
      return old.n as number;
    })();
  }

  listChatMessages(conversationId: string, after = 0): ChatMessage[] {
    return (
      this.db
        .query("SELECT * FROM chat_messages WHERE conversation_id = ? AND id > ? ORDER BY id")
        .all(conversationId, after) as Row[]
    ).map((r) => ({
      id: r.id as number,
      conversationId: r.conversation_id as string,
      role: r.role as ChatMessage["role"],
      content: r.content as string,
      ts: r.ts as number,
      runId: r.run_id as string | null,
      outcome: parse(r.outcome_json, null),
    }));
  }

  addChatMessage(
    conversationId: string,
    role: ChatMessage["role"],
    content: string,
    outcome: ChatMessage["outcome"] = null,
    runId: string | null = null,
  ): ChatMessage {
    const ts = Date.now();
    const inserted = this.db
      .query(
        "INSERT INTO chat_messages (conversation_id, role, content, run_id, ts, outcome_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(conversationId, role, content, runId, ts, json(outcome));
    const message: ChatMessage = {
      id: Number(inserted.lastInsertRowid),
      conversationId,
      role,
      content,
      ts,
      runId,
      outcome,
    };
    this.publish({ kind: "chat", message });
    return message;
  }

  hasChatDelivery(conversationId: string, messageId: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM chat_receipts WHERE conversation_id = ? AND message_id = ?")
        .get(conversationId, messageId) !== null
    );
  }

  claimChatDelivery(conversationId: string, messageId: string): boolean {
    return (
      this.db
        .query("INSERT OR IGNORE INTO chat_receipts (conversation_id, message_id) VALUES (?, ?)")
        .run(conversationId, messageId).changes === 1
    );
  }

  listChatProposals(conversationId: string): ChatProposal[] {
    return (
      this.db
        .query("SELECT * FROM chat_proposals WHERE conversation_id = ? ORDER BY rowid")
        .all(conversationId) as Row[]
    ).map((r) => ({
      ...parse(r.fields_json, {} as ChatProposalFields),
      id: r.id as string,
      conversationId,
      state: r.state as ChatProposal["state"],
      confirmedAt: r.confirmed_at as number | null,
      runId: r.run_id as string | null,
      origin: parse(r.origin_json, {} as ChatOrigin),
    }));
  }

  chatProposal(conversationId: string, id: string): ChatProposal {
    const proposal = this.listChatProposals(conversationId).find((p) => p.id === id);
    if (!proposal) throw new Error("Unknown proposal in this conversation");
    return proposal;
  }

  proposeChat(conversationId: string, fields: ChatProposalFields, origin: ChatOrigin): ChatProposal {
    return this.chatTransaction(() => {
      const current = this.listChatProposals(conversationId).find(
        (p) => p.state === "pending" || p.state === "confirmed",
      );
      if (current?.state === "confirmed")
        throw new Error("Confirm the existing proposal again to finish creating its run");
      if (current) {
        this.db.query("UPDATE chat_proposals SET state = 'superseded' WHERE id = ?").run(current.id);
        this.addChatMessage(conversationId, "assistant", "Proposal replaced.", {
          proposal: { ...current, state: "superseded" },
        });
      }
      const proposal: ChatProposal = {
        ...fields,
        id: newId("proposal_"),
        conversationId,
        state: "pending",
        confirmedAt: null,
        runId: null,
        origin,
      };
      this.db
        .query(
          "INSERT INTO chat_proposals (id, conversation_id, fields_json, origin_json, state) VALUES (?, ?, ?, ?, 'pending')",
        )
        .run(proposal.id, conversationId, json(fields), json(origin));
      this.addChatMessage(conversationId, "assistant", "Review this proposal and confirm to create a run.", {
        action: { type: "propose_run", ...fields },
        proposal,
      });
      return proposal;
    });
  }

  confirmChat(conversationId: string, id: string): ChatProposal {
    return this.chatTransaction(() => {
      const proposal = this.chatProposal(conversationId, id);
      if (proposal.state === "superseded")
        throw new Error("Proposal has been superseded; confirm the current proposal");
      if (proposal.state !== "pending") return proposal;
      this.db
        .query("UPDATE chat_proposals SET state = 'confirmed', confirmed_at = ? WHERE id = ?")
        .run(Date.now(), id);
      const confirmed = this.chatProposal(conversationId, id);
      this.addChatMessage(conversationId, "assistant", "Proposal confirmed.", { proposal: confirmed });
      return confirmed;
    });
  }

  resetChatConfirmation(conversationId: string, id: string): void {
    this.chatTransaction(() => {
      const proposal = this.chatProposal(conversationId, id);
      // Creation can fail before consumption; never undo a committed run linkage.
      if (proposal.state !== "confirmed" || proposal.runId) return;
      this.db.query("UPDATE chat_proposals SET state = 'pending', confirmed_at = NULL WHERE id = ?").run(id);
      this.addChatMessage(
        conversationId,
        "assistant",
        "Run creation failed. Edit or confirm the proposal to retry.",
        {
          proposal: this.chatProposal(conversationId, id),
        },
      );
    });
  }

  createChatRun(repo: Repo, req: CreateRunRequest, conversationId: string, proposalId: string): Run {
    return this.chatTransaction(() => {
      const proposal = this.chatProposal(conversationId, proposalId);
      if (proposal.state === "consumed" && proposal.runId) {
        const run = this.getRun(proposal.runId);
        if (!run) throw new Error("Created run is no longer available");
        return run;
      }
      if (proposal.state !== "confirmed" || !proposal.confirmedAt)
        throw new Error("Explicit confirmation is required");
      if (
        req.repo !== proposal.repo ||
        req.prompt !== proposal.prompt ||
        req.profile !== proposal.profile ||
        req.title !== proposal.title ||
        json(validateAllow(req.allow)) !== json(validateAllow(proposal.allow))
      )
        throw new Error("Confirmed proposal fields cannot be changed");
      const input = { ...req, sourceRef: { ...req.sourceRef, proposalId } };
      const run = this.createRun(repo, input);
      this.db
        .query("UPDATE chat_proposals SET state = 'consumed', run_id = ? WHERE id = ?")
        .run(run.id, proposalId);
      this.addChatMessage(
        conversationId,
        "assistant",
        `Run ${run.id} created.`,
        {
          action: { type: "create_run", proposalId },
          proposal: this.chatProposal(conversationId, proposalId),
        },
        run.id,
      );
      return run;
    });
  }

  recordChatCall(
    conversationId: string,
    provider: string,
    modelId: string,
    startedAt: number,
    result: import("../harness/types.ts").AgentResult,
  ): void {
    this.db
      .query(
        "INSERT INTO chat_calls (conversation_id, provider, model_id, result_json, cost_usd, started_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        conversationId,
        provider,
        modelId,
        JSON.stringify(result),
        result.costUsd,
        startedAt,
        Math.max(0, Date.now() - startedAt),
      );
  }

  // ---- repos ---------------------------------------------------------------

  upsertRepo(repo: Omit<Repo, "id" | "createdAt"> & { id?: string }): Repo {
    const existing = this.getRepoBySlug(repo.slug);
    if (existing) {
      this.db
        .query(
          "UPDATE repos SET kind = ?, url = ?, local_path = ?, default_branch = ?, merge_policy = ? WHERE id = ?",
        )
        .run(repo.kind, repo.url, repo.localPath, repo.defaultBranch, repo.mergePolicy, existing.id);
      return this.getRepo(existing.id) as Repo;
    }
    const id = repo.id ?? newId("repo_");
    this.db
      .query(
        "INSERT INTO repos (id, slug, kind, url, local_path, default_branch, merge_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        repo.slug,
        repo.kind,
        repo.url,
        repo.localPath,
        repo.defaultBranch,
        repo.mergePolicy,
        Date.now(),
      );
    return this.getRepo(id) as Repo;
  }

  getRepo(id: string): Repo | null {
    const r = this.db.query("SELECT * FROM repos WHERE id = ?").get(id) as Row | null;
    return r ? toRepo(r) : null;
  }

  getRepoBySlug(slug: string): Repo | null {
    const r = this.db.query("SELECT * FROM repos WHERE slug = ?").get(slug) as Row | null;
    return r ? toRepo(r) : null;
  }

  listRepos(): Repo[] {
    return (this.db.query("SELECT * FROM repos ORDER BY slug").all() as Row[]).map(toRepo);
  }

  getRepoProfile<T>(repoId: string): T | null {
    const r = this.db.query("SELECT profile_json FROM repos WHERE id = ?").get(repoId) as Row | null;
    return r ? parse<T | null>(r.profile_json, null) : null;
  }

  setRepoProfile(repoId: string, profile: unknown): void {
    this.db.query("UPDATE repos SET profile_json = ? WHERE id = ?").run(json(profile), repoId);
  }

  // ---- runs ----------------------------------------------------------------

  // Provenance is an internal argument, never taken from the public request object.
  createRun(repo: Repo, req: CreateRunRequest, verifiedGitHubWebhook = false): Run {
    if (req.sourceRef?.kind === "review-round")
      throw new Error("review rounds are created only by a review verdict");
    return this.insertRun(repo, req, verifiedGitHubWebhook);
  }

  /** `round`: the review handler's grant; such a run's prompt quotes findings, so it allows nothing itself. */
  private insertRun(
    repo: Repo,
    req: CreateRunRequest,
    verifiedGitHubWebhook: boolean,
    round?: { prUrl: string; grant: FactoryBranchGrant },
  ): Run {
    assertExistingBranchDelivery(
      repo,
      { ...req, githubWebhookVerified: verifiedGitHubWebhook },
      round?.grant,
    );
    const id = newId();
    const dependsOn = this.validateDependencies(req.dependsOn, id);
    const dependency = this.dependencyStatus(dependsOn);
    const title = req.title ?? req.prompt.split("\n")[0]?.slice(0, 80) ?? "Untitled";
    // Composed/model prompts cannot grant allowances; these sources use explicit options only.
    const composed =
      verifiedGitHubWebhook ||
      !!round ||
      ["github", "mcp"].includes(req.source ?? "") ||
      !!req.sourceRef?.proposalId;
    const allow = validateAllow([...validateAllow(req.allow), ...(composed ? [] : parseAllow(req.prompt))]);
    this.db
      .query(
        `INSERT INTO runs (id, repo_id, title, prompt, source, source_ref, requested_by, profile, status, priority, base_branch, delivery_branch, github_webhook_verified, created_at, depends_on, error, finished_at, no_baseline_cache, audit_allow, pr_url, models_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        repo.id,
        title,
        req.prompt,
        req.source ?? "cli",
        json(req.sourceRef),
        req.requestedBy ?? null,
        req.profile ?? "auto",
        dependency.status,
        req.priority ?? 0,
        req.baseBranch ?? null,
        req.deliveryBranch ?? null,
        verifiedGitHubWebhook ? 1 : 0,
        Date.now(),
        json(dependsOn),
        dependency.error ?? null,
        dependency.finishedAt ?? null,
        req.noBaselineCache === true ? 1 : 0,
        json(allow),
        round?.prUrl ?? null,
        json(req.models ?? {}),
      );
    const run = this.getRun(id) as Run;
    this.publish({ kind: "run", run });
    return run;
  }

  // ---- review rounds and approvals -------------------------------------------

  /**
   * Creates a round run with the record that authorizes it, at most one in flight and `cap` in all
   * per PR. Over the cap it creates nothing and leaves `owner` needs_human instead.
   */
  createReviewRound(
    repo: Repo,
    owner: Run,
    review: { prUrl: string; reviewedSha: string; findings: ReviewFinding[]; cap: number },
    request: (round: number) => CreateRunRequest,
  ): { run: Run } | { active: ReviewRound } | { limited: Run } {
    return this.chatTransaction(() => {
      const rounds = this.reviewRounds(review.prUrl);
      const active = rounds.find((r) => !TERMINAL_STATUSES.includes(r.status));
      if (active) return { active };
      // The newest verdict wins: changes requested now outrank an earlier approval, even over the cap.
      this.db
        .query("UPDATE review_approvals SET stale_reason = ? WHERE pr_url = ? AND stale_reason IS NULL")
        .run(`changes requested at ${review.reviewedSha}`, review.prUrl);
      if (rounds.length >= review.cap)
        return {
          limited: this.updateRun(owner.id, { status: "needs_human", error: "review round limit reached" }),
        };
      const round = rounds.length + 1;
      const grant = { owner, prUrl: review.prUrl, head: review.reviewedSha };
      const run = this.insertRun(repo, request(round), false, { prUrl: review.prUrl, grant });
      this.db
        .query(
          "INSERT INTO review_rounds (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          run.id,
          owner.id,
          review.prUrl,
          round,
          review.reviewedSha,
          JSON.stringify(review.findings),
          Date.now(),
        );
      return { run };
    });
  }

  /** The review handler's record for `runId`, which alone authorizes it to push onto `owner`'s PR branch. */
  reviewRound(
    runId: string,
  ): { owner: Run; prUrl: string; round: number; reviewedSha: string; findings: ReviewFinding[] } | null {
    const sql = `SELECT source_run_id AS sourceRunId, pr_url AS prUrl, round, reviewed_sha AS reviewedSha, findings
      FROM review_rounds WHERE run_id = ?`;
    const row = this.db.query(sql).get(runId) as {
      sourceRunId: string;
      prUrl: string;
      round: number;
      reviewedSha: string;
      findings: string;
    } | null;
    const owner = row && this.getRun(row.sourceRunId);
    if (!row || !owner) return null;
    const { prUrl, round, reviewedSha } = row;
    return { owner, prUrl, round, reviewedSha, findings: parse(row.findings, []) };
  }

  reviewRounds(prUrl: string): ReviewRound[] {
    const sql = `SELECT rr.run_id AS runId, rr.round, runs.status, rr.reviewed_sha AS reviewedSha,
        rr.delivered_sha AS deliveredSha, rr.findings
      FROM review_rounds rr JOIN runs ON runs.id = rr.run_id WHERE rr.pr_url = ? ORDER BY rr.round`;
    return (this.db.query(sql).all(prUrl) as Row[]).map((r) => ({
      ...(r as unknown as ReviewRound),
      findings: parse(r.findings, []),
    }));
  }

  markRoundDelivered(runId: string, sha: string): void {
    this.db
      .query("UPDATE review_rounds SET delivered_sha = ? WHERE run_id = ? AND delivered_sha IS NULL")
      .run(sha, runId);
    this.publishFeed();
  }

  /** `findings_resolved` counts the findings of the PR's delivered rounds. */
  recordApproval(runId: string, prUrl: string, sha: string, reviewer: string): ReviewApproval {
    this.db
      .query(
        `INSERT INTO review_approvals (run_id, pr_url, sha, reviewer, findings_resolved, created_at)
        SELECT ?1, ?2, ?3, ?4, coalesce(sum(json_array_length(findings)), 0), ?5
        FROM review_rounds WHERE pr_url = ?2 AND delivered_sha IS NOT NULL`,
      )
      .run(runId, prUrl, sha, reviewer, Date.now());
    this.publishFeed();
    return this.approvalFor(prUrl) as ReviewApproval;
  }

  approvalFor(prUrl: string): ReviewApproval | null {
    const row = this.db
      .query("SELECT sha, stale_reason FROM review_approvals WHERE pr_url = ? ORDER BY id DESC LIMIT 1")
      .get(prUrl) as Row | null;
    return row ? { sha: row.sha as string, stale: row.stale_reason !== null } : null;
  }

  /** The last head seen on a PR, and its version (0 before any). */
  prHead(prUrl: string): { sha: string; version: number } | null {
    return this.db.query("SELECT sha, version FROM pr_heads WHERE pr_url = ?").get(prUrl) as {
      sha: string;
      version: number;
    } | null;
  }

  /**
   * Records a head seen on a PR; an approval of any other commit goes stale. With `since`, the
   * version read before looking, the observation is refused (false) while a round is pushing to the
   * PR or once the epoch has moved on at all, even to the same head: a head recorded when a push
   * began is only what the push intended, so agreeing with it proves nothing.
   */
  observePrHead(prUrl: string, head: string, since?: number): boolean {
    return this.db.transaction(() => {
      const last = this.prHead(prUrl);
      if (since !== undefined && (this.pushingTo(prUrl) || (last ? last.version : 0) !== since)) return false;
      if (last?.sha !== head) this.writePrHead(prUrl, head, null);
      this.staleApprovals(prUrl, head);
      return true;
    })();
  }

  /** A round's push begins: earlier lookups are overtaken and approvals of other heads go stale. */
  beginPrPush(prUrl: string, head: string, runId: string): void {
    this.db.transaction(() => {
      this.writePrHead(prUrl, head, runId);
      this.staleApprovals(prUrl, head);
    })();
  }

  /** It ends with `head` on the remote (null: unknown): the epoch moves on again, past any lookup made meanwhile. */
  endPrPush(prUrl: string, head: string | null): void {
    this.db.transaction(() => {
      if (head === null)
        this.db
          .query(
            "UPDATE pr_heads SET version = version + 1, observed_at = ?, pushing = NULL WHERE pr_url = ?",
          )
          .run(Date.now(), prUrl);
      else {
        this.writePrHead(prUrl, head, null);
        this.staleApprovals(prUrl, head);
      }
    })();
  }

  /** A round run, not yet finished, recorded as pushing to the PR (a crash can leave one behind). */
  private pushingTo(prUrl: string): boolean {
    const sql = `SELECT 1 FROM pr_heads h JOIN runs ON runs.id = h.pushing
      WHERE h.pr_url = ? AND runs.status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(", ")})`;
    return this.db.query(sql).get(prUrl, ...TERMINAL_STATUSES) !== null;
  }

  private writePrHead(prUrl: string, head: string, pushing: string | null): void {
    this.db
      .query(
        `INSERT INTO pr_heads (pr_url, sha, version, observed_at, pushing) VALUES (?1, ?2, 1, ?3, ?4)
        ON CONFLICT (pr_url) DO UPDATE SET sha = ?2, version = version + 1, observed_at = ?3, pushing = ?4`,
      )
      .run(prUrl, head, Date.now(), pushing);
  }

  private staleApprovals(prUrl: string, head: string): void {
    this.db
      .query(
        "UPDATE review_approvals SET stale_reason = 'head moved to ' || ?2 WHERE pr_url = ?1 AND stale_reason IS NULL AND sha <> ?2",
      )
      .run(prUrl, head);
  }

  private validateDependencies(input: unknown, candidateId: string): string[] {
    if (input === undefined) return [];
    if (!Array.isArray(input)) throw new Error("dependsOn must be an array of run IDs");
    const ids = new Set<string>();
    for (const value of input) {
      if (typeof value !== "string" || !value.trim())
        throw new Error(`Invalid dependency ID: ${JSON.stringify(value)}`);
      ids.add(value.trim());
    }
    const visited = new Set<string>();
    const active = new Set([candidateId]);
    const stack = [...ids].map((id) => ({ id, exit: false }));
    while (stack.length) {
      const entry = stack.pop();
      if (!entry) break;
      const { id, exit } = entry;
      if (exit) {
        active.delete(id);
        visited.add(id);
        continue;
      }
      if (active.has(id)) throw new Error(`Dependency cycle or self-dependency involving ${id}`);
      if (visited.has(id)) continue;
      const run = this.getRun(id);
      if (!run) throw new Error(`Unknown dependency run ${id}`);
      active.add(id);
      stack.push({ id, exit: true });
      for (const dependency of run.dependsOn) stack.push({ id: dependency, exit: false });
    }
    return [...ids];
  }

  private dependencyStatus(ids: string[]): RunPatch & { status: RunStatus } {
    let waiting = false;
    const pending = [...ids];
    const visited = new Set<string>();
    for (const id of pending) {
      if (visited.has(id)) continue;
      visited.add(id);
      const run = this.getRun(id);
      if (run?.merged) continue;
      // Preserve the original blocker, including after restart or a later ancestor merge.
      if (run?.status === "needs_human" && !run.prUrl && run.error?.startsWith("Dependency "))
        return { status: "needs_human", finishedAt: Date.now(), error: run.error };
      const cause = !run
        ? "is missing"
        : run.prClosedUnmerged
          ? "PR was closed unmerged"
          : run.status === "failed" || run.status === "cancelled"
            ? `run ${run.status}`
            : run.status === "resolved" // terminal: an unmerged resolved run never merges
              ? `run resolved as ${run.resolution?.kind ?? "unknown"} without merging`
              : run.status === "needs_human" && !run.prUrl
                ? `run needs_human without PR${run.error ? `: ${run.error}` : ""}`
                : null;
      if (cause)
        return { status: "needs_human", finishedAt: Date.now(), error: `Dependency ${id}: ${cause}` };
      waiting = true;
      if (run?.status === "waiting") pending.push(...run.dependsOn);
    }
    return { status: waiting ? "waiting" : "queued" };
  }

  reconcileWaitingRuns(): void {
    for (const run of this.listRuns({ status: ["waiting"], limit: Number.MAX_SAFE_INTEGER })) {
      const patch = this.dependencyStatus(run.dependsOn);
      if (patch.status === "waiting") continue;
      this.updateRun(run.id, patch);
      this.addEvent({
        runId: run.id,
        type: "status",
        message: patch.error ?? "Dependencies merged; run queued",
        data: { from: "waiting", to: patch.status },
      });
    }
  }

  getRun(id: string): Run | null {
    const r = this.db.query(`${RUN_SELECT} WHERE runs.id = ?`).get(id) as Row | null;
    return r ? toRun(r) : null;
  }

  setRunSourceRef(id: string, sourceRef: Record<string, unknown>): Run {
    this.db.query("UPDATE runs SET source_ref = ? WHERE id = ?").run(json(sourceRef), id);
    const run = this.getRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    this.publish({ kind: "run", run });
    return run;
  }

  getRunByDiscordThread(threadId: string): Run | null {
    const row = this.db
      .query(
        `${RUN_SELECT} WHERE runs.source = 'discord' AND json_extract(runs.source_ref, '$.kind') = 'discord' AND json_extract(runs.source_ref, '$.threadId') = ? LIMIT 1`,
      )
      .get(threadId) as Row | null;
    return row ? toRun(row) : null;
  }

  listRuns(opts: { status?: RunStatus[]; limit?: number; repoId?: string; ids?: string[] } = {}): Run[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.ids) {
      if (opts.ids.length > MAX_RUN_IDS || !opts.ids.every((id) => RUN_ID.test(id)))
        throw new Error(`ids must list at most ${MAX_RUN_IDS} valid run ids`);
      where.push(`runs.id IN (${opts.ids.map(() => "?").join(",")})`);
      params.push(...opts.ids);
    }
    if (opts.status?.length) {
      where.push(`runs.status IN (${opts.status.map(() => "?").join(",")})`);
      params.push(...opts.status);
    }
    if (opts.repoId) {
      where.push("runs.repo_id = ?");
      params.push(opts.repoId);
    }
    const sql = `${RUN_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY runs.created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 100);
    return (this.db.query(sql).all(...params) as Row[]).map(toRun);
  }

  /** Every finished run, without the UI list's default limit. */
  finishedRuns(): Run[] {
    return (
      this.db
        .query(
          `${RUN_SELECT} WHERE runs.status IN ('succeeded','failed','cancelled','needs_human','resolved') AND runs.finished_at IS NOT NULL ORDER BY runs.finished_at, runs.id`,
        )
        .all() as Row[]
    ).map(toRun);
  }

  /** Oldest-first queue of runs waiting to start. */
  nextQueuedRuns(limit: number): Run[] {
    return (
      this.db
        .query(
          `${RUN_SELECT} WHERE runs.status = 'queued' ORDER BY runs.priority DESC, runs.created_at ASC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map(toRun);
  }

  parkedRunIds(): string[] {
    return (
      this.db
        .query(
          "SELECT id FROM runs WHERE status = 'queued' AND json_extract(state_json, '$.parked') = 1 ORDER BY priority DESC, created_at ASC",
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  }

  /** Optional state is checkpointed atomically with the run's SHAs and other fields. */
  updateRun(id: string, patch: RunPatch, state?: unknown): Run {
    if (patch.merged && !this.pendingPublications)
      return this.chatTransaction(() => this.updateRun(id, patch, state));
    const { sets, values } = buildUpdate(patch, RUN_PATCH_COLUMNS);
    if (state !== undefined) {
      sets.push("state_json = ?");
      values.push(json(state));
    }
    if (sets.length)
      this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]), id);
    const run = this.getRun(id) as Run;
    if (run.prUrl && patch.prClosedUnmerged !== undefined)
      this.observeGithubPrState(run.prUrl, patch.prClosedUnmerged ? "CLOSED" : "OPEN");
    this.publish({ kind: "run", run });
    if (patch.merged) this.supersedeByIssue(run);
    return run;
  }

  /**
   * Resolve once while the run is still in one of `from`; null when it isn't (another caller won).
   * Keeps the original terminal evidence (finishedAt, error, stages, artifacts, costs).
   */
  resolveRun(
    id: string,
    input: { kind: ResolutionKind; by: string; ref?: string | null; note?: string | null; at?: number },
    opts: { from?: RunStatus[]; patch?: RunPatch; why?: string; data?: Record<string, unknown> } = {},
  ): Run | null {
    const { kind, by, ref = null, note = null, at = Date.now() } = input;
    const resolution: RunResolution = { kind, ref, note, by, at };
    return this.chatTransaction(() => {
      const from = this.getRun(id)?.status;
      if (!from || !(opts.from ?? ["needs_human", "failed"]).includes(from)) return null;
      const { sets, values } = buildUpdate({ ...opts.patch, status: "resolved" }, RUN_PATCH_COLUMNS);
      const sql = `UPDATE runs SET ${sets.join(", ")}, resolution = ? WHERE id = ? AND status = ?`;
      if (!this.db.query(sql).run(...(values as never[]), json(resolution), id, from).changes) return null;
      this.addEvent({
        runId: id,
        type: "status",
        message: `Run moved from ${from} to resolved ${opts.why ?? `as ${kind}`}`,
        data: { from, to: "resolved", ...(opts.data ?? { resolution }) },
      });
      const run = this.getRun(id) as Run;
      this.publish({ kind: "run", run });
      if (opts.patch?.merged) this.supersedeByIssue(run);
      return run;
    });
  }

  /** Record a confirmed merge, preserving any existing manual resolution and terminal evidence. */
  resolveMergedRun(id: string, mergedBy: string | null, mergedAt: number): boolean {
    const current = this.getRun(id);
    const prUrl = current?.prUrl;
    if (!current || !prUrl || (current.merged && current.status !== "needs_human")) return false;
    if (current.status === "resolved" || current.status === "succeeded") {
      this.updateRun(id, { merged: true, mergedBy, mergedAt });
      return true;
    }
    const run = this.resolveRun(
      id,
      { kind: "merged", ref: prUrl, by: "github", at: mergedAt },
      {
        from: ["needs_human"],
        patch: { merged: true, mergedBy, mergedAt },
        why: `after PR merged by ${mergedBy ?? "unknown"}`,
        data: { mergedBy, mergedAt },
      },
    );
    return run !== null;
  }

  /** A merged run supersedes needs_human runs in its repository that close one of the same issues. */
  supersedeByIssue(merged: Run): Run[] {
    const issues = closedIssues(merged.prompt);
    if (!issues.size) return [];
    const input = { kind: "superseded", ref: merged.prUrl ?? merged.id, by: "system" } as const;
    return this.listRuns({ status: ["needs_human"], repoId: merged.repoId, limit: Number.MAX_SAFE_INTEGER })
      .filter((r) => r.id !== merged.id && [...closedIssues(r.prompt)].some((n) => issues.has(n)))
      .flatMap((r) => this.resolveRun(r.id, input, { from: ["needs_human"] }) ?? []);
  }

  /** Recompute run totals from its invocations. */
  refreshRunTotals(runId: string): Run {
    this.db
      .query(
        `UPDATE runs SET
           cost_usd = (SELECT COALESCE(SUM(cost_usd),0) FROM invocations WHERE run_id = ?1),
           cost_equiv_usd = (SELECT COALESCE(SUM(cost_equiv_usd),0) FROM invocations WHERE run_id = ?1),
           tokens_in = (SELECT COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0) FROM invocations WHERE run_id = ?1),
           tokens_out = (SELECT COALESCE(SUM(output_tokens),0) FROM invocations WHERE run_id = ?1)
         WHERE id = ?1`,
      )
      .run(runId);
    const run = this.getRun(runId) as Run;
    this.publish({ kind: "run", run });
    return run;
  }

  getRunState<T>(runId: string): T | null {
    const r = this.db.query("SELECT state_json FROM runs WHERE id = ?").get(runId) as Row | null;
    return r ? parse<T | null>(r.state_json, null) : null;
  }

  setRunState(runId: string, state: unknown): void {
    this.db.query("UPDATE runs SET state_json = ? WHERE id = ?").run(json(state), runId);
  }

  getRunDetail(id: string): RunDetail | null {
    const run = this.getRun(id);
    if (!run) return null;
    const latest = this.listArtifacts(id).findLast((a) => a.kind === "review");
    const review = parse<{ blocking?: { title?: string }[] }>(this.getArtifact(id, latest?.name ?? ""), {});
    const state = this.getRunState<RunState>(id);
    const stages = this.listStages(id);
    // Draft delivery failures are secondary; the run retains the original stopping error.
    const evidence = stages.filter(
      (s) =>
        s.name !== "deliver" ||
        s.status !== "failed" ||
        (!!run.error && s.summary === run.error.slice(0, 500)),
    );
    const latestStages = new Map(evidence.map((s) => [s.name, s]));
    const blocked = [
      ["verify", state?.lastVerify?.overall === "fail"],
      ["review", state?.lastReview?.verdict === "request_changes"],
      ["audit", state?.lastAudit?.some((f) => f.severity === "block")],
      ["gates", state?.lastGates?.some((g) => g.blocking)],
    ] as const;
    const stopping = evidence.findLast(
      (s) =>
        latestStages.get(s.name) === s &&
        (s.status === "failed" || blocked.some(([name, blocks]) => blocks && name === s.name)),
    );
    return {
      stoppingStage: stopping?.name ?? blocked.find(([, blocks]) => blocks)?.[0] ?? null,
      blockingFindings: Array.isArray(review?.blocking)
        ? review.blocking.flatMap((f) => (typeof f?.title === "string" ? [f.title] : []))
        : [],
      prSnapshot: parse<RunDetail["prSnapshot"]>(run.prUrl && this.githubPrData(run.prUrl), null),
      run,
      stages: this.listStages(id),
      invocations: this.listInvocations(id),
      questions: this.listQuestions(id),
      artifacts: this.listArtifacts(id),
      ...(run.prUrl
        ? { review: { approval: this.approvalFor(run.prUrl), rounds: this.reviewRounds(run.prUrl) } }
        : {}),
    };
  }

  // ---- stages --------------------------------------------------------------

  startStage(runId: string, name: StageName, round = 0): Stage {
    const res = this.db
      .query("INSERT INTO stages (run_id, name, round, status, started_at) VALUES (?, ?, ?, 'running', ?)")
      .run(runId, name, round, Date.now());
    const stage = this.getStage(Number(res.lastInsertRowid)) as Stage;
    this.publish({ kind: "stage", stage });
    return stage;
  }

  finishStage(id: number, status: StageStatus, summary?: string): Stage {
    this.db
      .query("UPDATE stages SET status = ?, summary = COALESCE(?, summary), finished_at = ? WHERE id = ?")
      .run(status, summary ?? null, Date.now(), id);
    const stage = this.getStage(id) as Stage;
    this.publish({ kind: "stage", stage });
    return stage;
  }

  getStage(id: number): Stage | null {
    const r = this.db.query("SELECT * FROM stages WHERE id = ?").get(id) as Row | null;
    return r ? toStage(r) : null;
  }

  listStages(runId: string): Stage[] {
    return (this.db.query("SELECT * FROM stages WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map(
      toStage,
    );
  }

  // ---- invocations ---------------------------------------------------------

  createInvocation(inv: {
    waitMs?: number;
    fast?: boolean;
    runId: string;
    stageId: number | null;
    role: Invocation["role"];
    harness: string;
    provider: string;
    model: string;
    modelId: string;
    effort?: Invocation["effort"];
  }): Invocation {
    const res = this.db
      .query(
        `INSERT INTO invocations (run_id, stage_id, role, harness, provider, model, model_id, status, started_at, effort, fast, wait_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        inv.runId,
        inv.stageId,
        inv.role,
        inv.harness,
        inv.provider,
        inv.model,
        inv.modelId,
        Date.now(),
        inv.effort ?? null,
        inv.fast ? 1 : 0,
        Math.max(0, inv.waitMs ?? 0),
      );
    const invocation = this.getInvocation(Number(res.lastInsertRowid)) as Invocation;
    this.publish({ kind: "invocation", invocation });
    return invocation;
  }

  updateInvocation(id: number, patch: InvocationPatch): Invocation {
    const { sets, values } = buildUpdate(patch, INVOCATION_PATCH_COLUMNS);
    if (sets.length)
      this.db.query(`UPDATE invocations SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]), id);
    const invocation = this.getInvocation(id) as Invocation;
    this.publish({ kind: "invocation", invocation });
    return invocation;
  }

  latestFastInvocation(provider: string): Invocation | null {
    const row = this.db
      .query("SELECT * FROM invocations WHERE provider = ? AND fast = 1 ORDER BY id DESC LIMIT 1")
      .get(provider) as Row | null;
    return row ? toInvocation(row) : null;
  }

  getInvocation(id: number): Invocation | null {
    const r = this.db.query("SELECT * FROM invocations WHERE id = ?").get(id) as Row | null;
    return r ? toInvocation(r) : null;
  }

  listInvocations(runId: string): Invocation[] {
    return (this.db.query("SELECT * FROM invocations WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map(
      toInvocation,
    );
  }

  /** Spend on a provider since a timestamp (used for OpenRouter budget enforcement). */
  providerSpendSince(provider: string, since: number): number {
    const r = this.db
      .query("SELECT COALESCE(SUM(cost_usd),0) AS s FROM invocations WHERE provider = ? AND started_at >= ?")
      .get(provider, since) as Row;
    const chat = this.db
      .query("SELECT COALESCE(SUM(cost_usd),0) AS s FROM chat_calls WHERE provider = ? AND started_at >= ?")
      .get(provider, since) as Row;
    const evals = this.db
      .query(
        `SELECT COALESCE(SUM(CASE WHEN json_extract(details_json, '$.rounds[0].provider') IS NOT NULL
          THEN (SELECT COALESCE(SUM(json_extract(value, '$.costUsd')), 0)
            FROM json_each(details_json, '$.rounds') WHERE json_extract(value, '$.provider') = ?)
          WHEN json_extract(details_json, '$.provider') = ? THEN cost_usd ELSE 0 END), 0) AS s
         FROM eval_trials WHERE created_at >= ? AND json_extract(details_json, '$.cache') IS NULL
           AND json_extract(details_json, '$.resumedFrom') IS NULL`,
      )
      .get(provider, provider, since) as Row;
    return (r.s as number) + (chat.s as number) + (evals.s as number);
  }

  /** Completed costs in [since, before); boundary completions belong to the next reading. */
  providerSpendBetween(provider: string, since: number, before: number): number {
    const invocation = this.db
      .query(
        "SELECT COALESCE(SUM(cost_usd),0) AS s FROM invocations WHERE provider = ? AND finished_at >= ? AND finished_at < ?",
      )
      .get(provider, since, before) as Row;
    const chat = this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd),0) AS s FROM chat_calls WHERE provider = ?
         AND started_at + COALESCE(duration_ms, 0) >= ? AND started_at + COALESCE(duration_ms, 0) < ?`,
      )
      .get(provider, since, before) as Row;
    return (invocation.s as number) + (chat.s as number);
  }

  // ---- events --------------------------------------------------------------

  addEvent(ev: {
    runId: string;
    invocationId?: number | null;
    type: EventType;
    level?: RunEvent["level"];
    message: string;
    data?: unknown;
  }): RunEvent {
    const ts = Date.now();
    const res = this.db
      .query(
        "INSERT INTO events (run_id, invocation_id, ts, type, level, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ev.runId,
        ev.invocationId ?? null,
        ts,
        ev.type,
        ev.level ?? "info",
        ev.message.slice(0, 4000),
        clampData(ev.data),
      );
    const event: RunEvent = {
      id: Number(res.lastInsertRowid),
      runId: ev.runId,
      invocationId: ev.invocationId ?? null,
      ts,
      type: ev.type,
      level: ev.level ?? "info",
      message: ev.message.slice(0, 4000),
      data: ev.data ?? null,
    };
    this.publish({ kind: "event", event });
    return event;
  }

  listEvents(
    runId: string,
    opts: {
      after?: number;
      limit?: number;
      invocationId?: number;
      tail?: boolean;
      excludeDebug?: boolean;
    } = {},
  ): RunEvent[] {
    const params: (string | number)[] = [runId, opts.after ?? 0];
    let sql = "SELECT * FROM events WHERE run_id = ? AND id > ?";
    if (opts.invocationId !== undefined) {
      sql += " AND invocation_id = ?";
      params.push(opts.invocationId);
    }
    if (opts.excludeDebug) sql += " AND level != 'debug'";
    sql += ` ORDER BY id ${opts.tail ? "DESC" : "ASC"} LIMIT ?`;
    params.push(opts.limit ?? 1000);
    const events = (this.db.query(sql).all(...params) as Row[]).map(toEvent);
    return opts.tail ? events.reverse() : events;
  }

  countOldDebugEvents(before: number): number {
    const row = this.db
      .query("SELECT count(*) AS n FROM events WHERE level = 'debug' AND ts < ?")
      .get(before) as Row;
    return row.n as number;
  }

  deleteOldDebugEvents(before: number): number {
    return this.db.query("DELETE FROM events WHERE level = 'debug' AND ts < ?").run(before).changes;
  }

  // ---- baseline cache ------------------------------------------------------

  /** A cached baseline recorded after `since`; older entries are expired and never returned. */
  getBaselineCache<T>(key: BaselineCacheKey, since: number): T | null {
    const row = this.db
      .query(
        "SELECT gate_run FROM passing_baselines WHERE repo_id = ? AND base_sha = ? AND gates_hash = ? AND env_hash = ? AND created_at > ?",
      )
      .get(key.repoId, key.baseSha, key.gatesHash, key.envHash, since) as Row | null;
    return row ? parse<T | null>(row.gate_run, null) : null;
  }

  /** Callers store passing baselines only, so a refresh never replaces a pass with a failure. */
  putBaselineCache(key: BaselineCacheKey, gateRun: unknown, runId: string, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO passing_baselines (repo_id, base_sha, gates_hash, env_hash, gate_run, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, base_sha, gates_hash, env_hash) DO UPDATE SET gate_run = excluded.gate_run, run_id = excluded.run_id, created_at = excluded.created_at`,
      )
      .run(key.repoId, key.baseSha, key.gatesHash, key.envHash, JSON.stringify(gateRun), runId, now);
  }

  deleteBaselineCache(key: BaselineCacheKey): void {
    this.db
      .query(
        "DELETE FROM passing_baselines WHERE repo_id = ? AND base_sha = ? AND gates_hash = ? AND env_hash = ?",
      )
      .run(key.repoId, key.baseSha, key.gatesHash, key.envHash);
  }

  /** Drop every cached baseline, or one repo's (repair after a bad entry); returns the count removed. */
  clearBaselineCache(repoId?: string): number {
    if (repoId === undefined) return this.db.query("DELETE FROM passing_baselines").run().changes;
    return this.db.query("DELETE FROM passing_baselines WHERE repo_id = ?").run(repoId).changes;
  }

  countExpiredBaselineCache(before: number): number {
    const row = this.db
      .query("SELECT count(*) AS n FROM passing_baselines WHERE created_at <= ?")
      .get(before) as Row;
    return row.n as number;
  }

  deleteExpiredBaselineCache(before: number): number {
    return this.db.query("DELETE FROM passing_baselines WHERE created_at <= ?").run(before).changes;
  }

  // ---- artifacts -----------------------------------------------------------

  putArtifact(runId: string, name: string, kind: string, content: string): void {
    this.db
      .query(
        `INSERT INTO artifacts (run_id, name, kind, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, name) DO UPDATE SET kind = excluded.kind, content = excluded.content, created_at = excluded.created_at`,
      )
      .run(runId, name, kind, content, Date.now());
  }

  getArtifact(runId: string, name: string): string | null {
    const r = this.db
      .query("SELECT content FROM artifacts WHERE run_id = ? AND name = ?")
      .get(runId, name) as Row | null;
    return r ? (r.content as string) : null;
  }

  listArtifacts(runId: string): ArtifactMeta[] {
    return (
      this.db
        .query(
          "SELECT name, kind, length(content) AS size, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at",
        )
        .all(runId) as Row[]
    ).map((r) => ({
      name: r.name as string,
      kind: r.kind as string,
      size: r.size as number,
      createdAt: r.created_at as number,
    }));
  }

  // ---- questions -----------------------------------------------------------

  askQuestion(runId: string, question: string): Question {
    const res = this.db
      .query("INSERT INTO questions (run_id, question, asked_at) VALUES (?, ?, ?)")
      .run(runId, question, Date.now());
    const q = this.getQuestion(Number(res.lastInsertRowid)) as Question;
    this.publish({ kind: "question", question: q });
    return q;
  }

  answerQuestion(id: number, answer: string, by: string): Question {
    this.db
      .query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?")
      .run(answer, by, Date.now(), id);
    const q = this.getQuestion(id) as Question;
    this.publish({ kind: "question", question: q });
    return q;
  }

  getQuestion(id: number): Question | null {
    const r = this.db.query("SELECT * FROM questions WHERE id = ?").get(id) as Row | null;
    return r ? toQuestion(r) : null;
  }

  listQuestions(runId: string): Question[] {
    return (this.db.query("SELECT * FROM questions WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map(
      toQuestion,
    );
  }

  routingCells(): OperatorRoutingCell[] {
    return this.db
      .query<Row, []>("SELECT * FROM routing_cells ORDER BY role, cell")
      .all()
      .map((row) => ({
        role: row.role as OperatorRoutingCell["role"],
        cell: row.cell as OperatorRoutingCell["cell"],
        groups: JSON.parse(row.groups_json as string) as string[],
        note: row.note as string | null,
        updatedAt: row.updated_at as number,
        updatedBy: row.updated_by as string,
      }));
  }

  routingPrefer(): string[] | null {
    const row = this.db.query<Row, []>("SELECT providers_json FROM routing_prefer WHERE id = 1").get();
    return row ? (JSON.parse(row.providers_json as string) as string[]) : null;
  }

  routingHistory(): RoutingChange[] {
    return this.db
      .query<Row, []>("SELECT * FROM routing_history ORDER BY id DESC")
      .all()
      .map((row) => ({
        id: row.id as number,
        key: row.key as string,
        oldValue: parse<string[] | null>(row.old_json, null),
        newValue: parse<string[] | null>(row.new_json, null),
        note: row.note as string | null,
        at: row.at as number,
        by: row.actor as string,
      }));
  }

  writeRouting(key: string, value: string[] | null, note: string | null, by: string): RoutingChange {
    return this.db.transaction(() => {
      const at = Date.now();
      const [role, cell] = key.split(".");
      const old =
        key === "prefer"
          ? this.routingPrefer()
          : (this.routingCells().find((r) => r.role === role && r.cell === cell)?.groups ?? null);
      if (key === "prefer") {
        if (value === null) this.db.query("DELETE FROM routing_prefer WHERE id = 1").run();
        else
          this.db
            .query("INSERT OR REPLACE INTO routing_prefer VALUES (1, ?, ?, ?, ?)")
            .run(JSON.stringify(value), note, at, by);
      } else {
        if (value === null)
          this.db.query("DELETE FROM routing_cells WHERE role = ? AND cell = ?").run(role ?? "", cell ?? "");
        else
          this.db
            .query("INSERT OR REPLACE INTO routing_cells VALUES (?, ?, ?, ?, ?, ?)")
            .run(role ?? "", cell ?? "", JSON.stringify(value), note, at, by);
      }
      const result = this.db
        .query(
          "INSERT INTO routing_history (key, old_json, new_json, note, at, actor) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(key, json(old), json(value), note, at, by);
      return { id: Number(result.lastInsertRowid), key, oldValue: old, newValue: value, note, at, by };
    })();
  }

  publishRouting(change: RoutingChange): void {
    this.publish({ kind: "routing", change });
  }

  // ---- provider state ------------------------------------------------------

  listAlerts(now = Date.now()): QuotaAlert[] {
    return (
      this.db
        .query(
          "SELECT * FROM quota_alerts WHERE active = 1 AND (resets_at IS NULL OR resets_at > ?) ORDER BY created_at DESC",
        )
        .all(now) as Row[]
    ).map((r) => ({
      provider: r.provider as string,
      window: r.window as string,
      utilization: (r.utilization as number) ?? null,
      resetsAt: (r.resets_at as number) ?? null,
      severity: r.severity as QuotaAlert["severity"],
      source: (r.source as QuotaAlert["source"]) ?? null,
      routing: r.routing as string,
      createdAt: r.created_at as number,
    }));
  }

  putAlert(alert: QuotaAlert): boolean {
    const boundary = alert.resetsAt ?? 0;
    const previous = this.db
      .query(
        "SELECT severity, source, created_at FROM quota_alerts WHERE provider = ? AND window = ? AND boundary = ?",
      )
      .get(alert.provider, alert.window, boundary) as Row | null;
    const current: QuotaAlert = previous
      ? {
          ...alert,
          severity: previous.severity === "exhausted" ? "exhausted" : alert.severity,
          // Telemetry must not erase a rejection or disambiguate an older exhausted alert.
          source:
            previous.source === "rejection" || alert.source === "rejection"
              ? "rejection"
              : previous.severity === "exhausted" && previous.source == null
                ? null
                : alert.source,
          createdAt: previous.created_at as number,
        }
      : alert;
    this.db
      .query(
        "UPDATE quota_alerts SET active = 0 WHERE provider = ? AND window = ? AND boundary != ? AND active = 1",
      )
      .run(alert.provider, alert.window, boundary);
    const inserted =
      this.db
        .query(
          `INSERT OR IGNORE INTO quota_alerts (provider, window, boundary, resets_at, utilization, severity, source, routing, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.provider,
          current.window,
          boundary,
          current.resetsAt,
          current.utilization,
          current.severity,
          current.source ?? null,
          current.routing,
          current.createdAt,
        ).changes > 0;
    if (!inserted)
      this.db
        .query(
          "UPDATE quota_alerts SET utilization = ?, severity = ?, source = ?, routing = ?, active = 1 WHERE provider = ? AND window = ? AND boundary = ?",
        )
        .run(
          current.utilization,
          current.severity,
          current.source ?? null,
          current.routing,
          current.provider,
          current.window,
          boundary,
        );
    this.publish({
      kind: "alert",
      alert: current,
      provider: current.provider,
      window: current.window,
      created: inserted,
    });
    return inserted;
  }

  clearAlert(provider: string, window: string): void {
    const changed = this.db
      .query("UPDATE quota_alerts SET active = 0 WHERE provider = ? AND window = ? AND active = 1")
      .run(provider, window).changes;
    if (changed) this.publish({ kind: "alert", alert: null, provider, window, created: false });
  }

  expireAlerts(now: number): void {
    const expired = this.db
      .query("SELECT provider, window FROM quota_alerts WHERE active = 1 AND resets_at <= ?")
      .all(now) as Row[];
    for (const row of expired) this.clearAlert(row.provider as string, row.window as string);
  }

  setProviderFast(id: string, fast: boolean): void {
    this.db
      .query(`INSERT INTO provider_state (provider, state, updated_at, fast) VALUES (?, 'ok', ?, ?)
      ON CONFLICT(provider) DO UPDATE SET fast = excluded.fast`)
      .run(id, Date.now(), fast ? 1 : 0);
  }

  getProviderRow(provider: string): Row | null {
    return this.db.query("SELECT * FROM provider_state WHERE provider = ?").get(provider) as Row | null;
  }

  putProviderRow(row: {
    provider: string;
    state: string;
    reason: string | null;
    until: number | null;
    windows: unknown;
    windowObservedAt: Record<string, number>;
    consecutiveFailures: number;
  }): void {
    this.db
      .query(
        `INSERT INTO provider_state (provider, state, reason, until, windows_json, window_observed_at_json, consecutive_failures, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET state = excluded.state, reason = excluded.reason, until = excluded.until,
           windows_json = excluded.windows_json, window_observed_at_json = excluded.window_observed_at_json,
           consecutive_failures = excluded.consecutive_failures,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.provider,
        row.state,
        row.reason,
        row.until,
        json(row.windows),
        json(row.windowObservedAt),
        row.consecutiveFailures,
        Date.now(),
      );
  }

  putOpenRouterReading(reading: {
    usage: number;
    at: number;
    limit: number | null;
    remaining: number | null;
    reset: string | null;
    monthlyPeriod?: string | null;
    monthlyResetAt?: number | null;
  }): void {
    this.db
      .query(
        `INSERT INTO provider_state (provider, state, updated_at, reported_usage_usd, reported_at, key_limit, limit_remaining, limit_reset, monthly_period, monthly_reset_at)
       VALUES ('openrouter', 'ok', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET reported_usage_usd = excluded.reported_usage_usd,
         reported_at = excluded.reported_at, key_limit = excluded.key_limit,
         limit_remaining = excluded.limit_remaining, limit_reset = excluded.limit_reset,
         monthly_period = excluded.monthly_period, monthly_reset_at = excluded.monthly_reset_at`,
      )
      .run(
        reading.at,
        reading.usage,
        reading.at,
        reading.limit,
        reading.remaining,
        reading.reset,
        reading.monthlyPeriod ?? null,
        reading.monthlyResetAt ?? null,
      );
  }

  publishProvider(msg: Extract<StreamMessage, { kind: "provider" }>): void {
    this.publish(msg);
  }

  // ---- inbox (webhook audit + dedupe) --------------------------------------

  recordInbox(entry: {
    id: string;
    source: string;
    kind: string;
    payload: unknown;
    status: string;
    runId?: string | null;
    note?: string | null;
  }): boolean {
    const res = this.db
      .query(
        "INSERT OR IGNORE INTO inbox (id, source, kind, received_at, payload, status, run_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.id,
        entry.source,
        entry.kind,
        Date.now(),
        JSON.stringify(entry.payload),
        entry.status,
        entry.runId ?? null,
        entry.note ?? null,
      );
    return res.changes > 0;
  }

  finishInbox(id: string, status: "ignored" | "run_created" | "error", note: string, runId?: string): void {
    this.db
      .query("UPDATE inbox SET status = ?, note = ?, run_id = ? WHERE id = ?")
      .run(status, note, runId ?? null, id);
  }

  // ---- settings ------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as Row | null;
    return r ? parse<T>(r.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  // ---- land queue ----------------------------------------------------------

  createLandEntry(entry: {
    runId: string;
    repo: string;
    prUrl: string;
    baseBranch: string;
    headBranch: string;
    approvedSha: string;
  }): LandEntry {
    const now = Date.now();
    let id: number;
    try {
      const res = this.db
        .query(
          `INSERT INTO land_entries (run_id, repo, pr_url, base_branch, head_branch, approved_sha, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
        )
        .run(
          entry.runId,
          entry.repo,
          entry.prUrl,
          entry.baseBranch,
          entry.headBranch,
          entry.approvedSha,
          now,
          now,
        );
      id = Number(res.lastInsertRowid);
    } catch (error) {
      // The partial unique index holds at most one in-flight entry per PR.
      if (String(error).includes("land_entries.pr_url")) throw new Error("PR is already in the land queue");
      throw error;
    }
    return this.getLandEntry(id) as LandEntry;
  }

  getLandEntry(id: number): LandEntry | null {
    return (this.db.query(`${LAND_SELECT} WHERE id = ?`).get(id) as LandEntry | null) ?? null;
  }

  listLandEntries(opts: { repo?: string; active?: boolean; limit?: number } = {}): LandEntry[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.repo) {
      where.push("repo = ?");
      params.push(opts.repo);
    }
    if (opts.active) {
      where.push(`state IN (${ACTIVE_LAND_STATES.map(() => "?").join(", ")})`);
      params.push(...ACTIVE_LAND_STATES);
    }
    params.push(String(opts.limit ?? 100));
    const sql = `${LAND_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`;
    return this.db.query(sql).all(...params) as LandEntry[];
  }

  /**
   * The oldest entry this repository may start now, claimed by moving it into `checking`. A queued
   * entry is free; one already in flight is only taken when its claim has gone quiet for `staleMs`,
   * so the queue that owns it keeps it and `releaseLandClaims` (at startup) frees a dead one's. The
   * claim is a compare-and-swap on `attempts`, so two queues racing for one row see one winner, and
   * `land_entries_one_running` refuses a second entry while one runs for the repository.
   */
  claimLandEntry(repo: string, staleMs: number): LandEntry | null {
    try {
      return (
        this.db.transaction(() => {
          const row = this.db
            .query(
              `${LAND_SELECT} WHERE repo = ? AND state IN ('queued', 'checking', 'waiting_ci', 'merging')
                 AND (state = 'queued' OR updated_at <= ?) ORDER BY id LIMIT 1`,
            )
            .get(repo, Date.now() - staleMs) as Row | null;
          if (!row) return null;
          const claimed = this.db
            .query(
              `UPDATE land_entries SET state = 'checking', attempts = attempts + 1, updated_at = ?
               WHERE id = ? AND attempts = ? AND state IN ('queued', 'checking', 'waiting_ci', 'merging')`,
            )
            .run(Date.now(), row.id as number, row.attempts as number).changes;
          return claimed ? this.getLandEntry(row.id as number) : null;
        })() ?? null
      );
    } catch (error) {
      // The partial unique index names its column, not the index, when it refuses the update.
      if (String(error).includes("land_entries_one_running") || String(error).includes("land_entries.repo"))
        return null;
      throw error;
    }
  }

  /**
   * Every claim in the table belongs to a daemon that is gone, so what it left in flight may be
   * resumed now. One daemon owns this database, so this is its own right at startup.
   */
  releaseLandClaims(): number {
    return this.db
      .query(`UPDATE land_entries SET updated_at = 0 WHERE state IN ('checking', 'waiting_ci', 'merging')`)
      .run().changes;
  }

  updateLandEntry(
    id: number,
    patch: Partial<Pick<LandEntry, "state" | "pushedSha" | "logPath" | "attempts" | "reason">>,
  ): LandEntry {
    const { sets, values } = buildUpdate(patch, LAND_PATCH_COLUMNS);
    sets.push("updated_at = ?");
    values.push(Date.now());
    if (patch.state && !ACTIVE_LAND_STATES.includes(patch.state)) {
      sets.push("finished_at = ?");
      values.push(Date.now());
    }
    this.db.query(`UPDATE land_entries SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]), id);
    return this.getLandEntry(id) as LandEntry;
  }

  /** Feed items for the queue: the PR URL, the SHA and, when it failed, the reason. */
  landFeed(kind: LandFeedKind, entry: LandEntry, summary: string, data: Record<string, unknown> = {}): void {
    this.db.transaction(() =>
      this.addFeedItems([
        {
          kind,
          runId: entry.runId,
          repo: entry.repo,
          summary,
          data: { url: entry.prUrl, sha: entry.approvedSha, ...data },
          key: String(entry.id),
        },
      ]),
    )();
    this.publishFeed();
  }

  /** The newest run that opened `pr`: a pull request URL, or its number (`7`). */
  runForPr(pr: string): Run | null {
    const number = /^\d+$/.test(pr);
    const row = this.db
      .query(
        `${RUN_SELECT} WHERE runs.pr_url ${number ? "LIKE ?" : "= ?"} COLLATE NOCASE ORDER BY runs.created_at DESC LIMIT 1`,
      )
      .get(number ? `%/pull/${pr}` : pr) as Row | null;
    return row ? toRun(row) : null;
  }

  // ---- GitHub poller -------------------------------------------------------

  /** Unmerged PRs factory runs opened; PRs runs only verified, or abandoned over 7 days while open, are excluded. */
  githubTracked(now = Date.now()): TrackedPr[] {
    const sql = `SELECT r.pr_url AS url, repos.slug AS repo, min(r.id) AS runId, g.node_id AS nodeId, g.data,
        max(r.status IN ('succeeded', 'needs_human')) AS delivered
      FROM runs r JOIN repos ON repos.id = r.repo_id LEFT JOIN github_prs g ON g.url = r.pr_url
      LEFT JOIN github_pr_expiry e ON e.url = r.pr_url
      WHERE repos.kind = 'github' AND r.pr_url IS NOT NULL
        AND NOT r.merged AND r.delivery_branch IS NULL AND coalesce(g.data ->> 'state', '') <> 'MERGED'
        AND (e.closed_at IS NULL OR e.closed_at >= ?1 - 604800000)
        AND coalesce(json_extract(r.source_ref, '$.kind'), '') <> 'pull_request'
        AND (r.status NOT IN ('failed', 'cancelled') OR coalesce(r.finished_at, ?1) >= ?1 - 604800000
          OR r.pr_closed_unmerged OR g.data ->> 'state' = 'CLOSED' OR e.reopened_at >= ?1 - 604800000)
      GROUP BY r.pr_url ORDER BY repos.slug, r.pr_url`;
    return (this.db.query(sql).all(now) as TrackedPr[]).filter((pr) => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9][0-9]*$/.exec(pr.url);
      return match?.[1]?.toLowerCase() === pr.repo.toLowerCase();
    });
  }

  githubPrData(url: string): string | null {
    const query = this.db.query<{ data: string }, [string]>("SELECT data FROM github_prs WHERE url = ?");
    return query.get(url)?.data ?? null;
  }

  githubPrExpired(url: string, now = Date.now()): boolean {
    const row = this.db
      .query<{ closed_at: number | null }, [string]>("SELECT closed_at FROM github_pr_expiry WHERE url = ?")
      .get(url);
    return row?.closed_at != null && row.closed_at < now - 604800000;
  }

  /** Wake polling for known PRs even after closed snapshots have expired. */
  reopenGithubPr(url: string): void {
    const runs = this.db
      .query<{ id: string }, [string]>("SELECT id FROM runs WHERE pr_url = ? COLLATE NOCASE AND NOT merged")
      .all(url);
    for (const run of runs) this.updateRun(run.id, { prClosedUnmerged: false });
  }

  /** Reconciliation/reopen observations retain the poller's other saved fields. */
  observeGithubPrState(url: string, state: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db
        .query(`INSERT INTO github_pr_expiry (url, closed_at) VALUES (?, ?)
      ON CONFLICT(url) DO UPDATE SET reopened_at = CASE WHEN ? = 'OPEN' AND github_pr_expiry.closed_at IS NOT NULL
        THEN ? ELSE github_pr_expiry.reopened_at END, closed_at = CASE WHEN ? = 'CLOSED'
        THEN coalesce(github_pr_expiry.closed_at, excluded.closed_at) ELSE NULL END`)
        .run(url, state === "CLOSED" ? now : null, state, now, state);
      this.db
        .query("UPDATE github_prs SET data = json_set(data, '$.state', ?) WHERE url = ?")
        .run(state, url);
    })();
  }

  /** Advance a PR's saved state (when given) and write feed items in one transaction. */
  saveGithubPr(
    pr: TrackedPr | null,
    terminal = false,
    items: GitHubFeedInput[] = [],
    now = Date.now(),
  ): void {
    this.db.transaction(() => {
      const save = this.db.query(`INSERT INTO github_prs (url, node_id, data, terminal) VALUES (?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET node_id = excluded.node_id, data = excluded.data, terminal = excluded.terminal`);
      if (pr) {
        save.run(pr.url, pr.nodeId, pr.data, terminal);
        const state = pr.data && (JSON.parse(pr.data) as { state?: string }).state;
        if (state) this.observeGithubPrState(pr.url, state, now);
      }
      this.addFeedItems(items);
    })();
    this.publishFeed();
  }

  private addFeedItems(items: FeedInsert[]): void {
    const insert = this.db.query(`INSERT INTO feed (ts, kind, run_id, repo, title, summary, data, dedupe_key)
      VALUES (?, ?, ?, ?, substr(?, 1, 200), substr(?, 1, 500), ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`);
    for (const { kind, runId, repo, summary, data, key } of items) {
      const title = `${kind}: ${String(data.url ?? repo)}`;
      insert.run(Date.now(), kind, runId, repo, title, summary, JSON.stringify(data), `${kind}:${key}`);
    }
  }

  /** Open (once per episode) or clear a repository's access problem; `head` is the last known PR head. */
  setGithubAccess(repo: string, problem: { reason: string; detail: string } | null, head?: string | null) {
    this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM github_access WHERE repo = ?").get(repo) as Row | null;
      if (!problem === !row?.problem) return;
      const episode = Number(row?.episode ?? 0) + (problem ? 1 : 0);
      const saved = problem && JSON.stringify({ ...problem, since: Date.now() });
      this.db.query("INSERT OR REPLACE INTO github_access VALUES (?, ?, ?)").run(repo, saved, episode);
      if (!problem) return;
      const [kind, key] = ["github.access_problem", `${repo}:${episode}:${head ?? "unknown-head"}`] as const;
      const data = { reason: problem.reason, head: head ?? null };
      this.saveGithubPr(null, false, [{ kind, runId: null, repo, summary: problem.detail, data, key }]);
    })();
    this.publishFeed();
  }

  githubAccessProblems(): GitHubAccessProblem[] {
    const sql = `SELECT repo, problem ->> 'reason' AS reason, problem ->> 'detail' AS detail,
      problem ->> 'since' AS since FROM github_access WHERE problem IS NOT NULL ORDER BY repo`;
    return this.db.query(sql).all() as GitHubAccessProblem[];
  }

  getProviderEnabledOverride(id: string): boolean | null {
    const value = this.getSetting<unknown>(`provider_enabled:${id}`, null);
    return typeof value === "boolean" ? value : null;
  }

  setProviderEnabledOverride(id: string, enabled: boolean): void {
    this.setSetting(`provider_enabled:${id}`, enabled);
  }

  // ---- UI sign-in sessions -------------------------------------------------

  createAuthSession(tokenHash: string, method: AuthSession["method"], device: string, now: number) {
    const session: AuthSession = { id: newId("ses-"), method, device, createdAt: now, lastSeenAt: now };
    this.db
      .query(
        "INSERT INTO auth_sessions (id, token_hash, method, device, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(session.id, tokenHash, method, device, now, now);
    return session;
  }

  authSession(tokenHash: string): AuthSession | null {
    return this.db.query(`${AUTH_SESSION_SELECT} WHERE token_hash = ?`).get(tokenHash) as AuthSession | null;
  }

  touchAuthSession(id: string, now: number): void {
    this.db.query("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  listAuthSessions(): AuthSession[] {
    return this.db.query(`${AUTH_SESSION_SELECT} ORDER BY last_seen_at DESC`).all() as AuthSession[];
  }

  /** Revokes one session, or every session without an id; returns how many were removed. */
  revokeAuthSessions(id?: string): number {
    if (id === undefined) return this.db.query("DELETE FROM auth_sessions").run().changes;
    return this.db.query("DELETE FROM auth_sessions WHERE id = ?").run(id).changes;
  }

  addPasskey(credential: WebAuthnCredential, device: string, now: number): void {
    const { id, publicKey, counter, transports = [] } = credential;
    this.db
      .query(
        "INSERT INTO auth_passkeys (id, public_key, counter, transports, device, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, publicKey, counter, JSON.stringify(transports), device, now);
  }

  passkey(id: string): WebAuthnCredential | null {
    const row = this.db.query("SELECT * FROM auth_passkeys WHERE id = ?").get(id) as Row | null;
    if (!row) return null;
    const publicKey = new Uint8Array(row.public_key as Uint8Array);
    return { id, publicKey, counter: row.counter as number, transports: parse(row.transports, []) };
  }

  /**
   * Records a sign-in only if the passkey still exists and its counter moves forward, so a concurrent
   * sign-in can't rewind it; authenticators that always report 0 (most synced passkeys) stay at 0.
   */
  usePasskey(id: string, counter: number, now: number): boolean {
    const sql = `UPDATE auth_passkeys SET counter = ?1, last_used_at = ?2
      WHERE id = ?3 AND (counter < ?1 OR (counter = 0 AND ?1 = 0))`;
    return this.db.query(sql).run(counter, now, id).changes === 1;
  }

  listPasskeys(): AuthPasskey[] {
    const sql = `SELECT id, device, created_at AS createdAt, last_used_at AS lastUsedAt
      FROM auth_passkeys ORDER BY created_at`;
    return this.db.query(sql).all() as AuthPasskey[];
  }

  removePasskey(id: string): number {
    return this.db.query("DELETE FROM auth_passkeys WHERE id = ?").run(id).changes;
  }

  expireAuthSessions(createdBefore: number, seenBefore: number): number {
    return this.db
      .query("DELETE FROM auth_sessions WHERE created_at <= ? OR last_seen_at <= ?")
      .run(createdBefore, seenBefore).changes;
  }
}
