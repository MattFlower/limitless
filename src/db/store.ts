import { Database } from "bun:sqlite";
import type {
  ArtifactMeta,
  CreateRunRequest,
  EventType,
  Invocation,
  InvocationStatus,
  Question,
  Repo,
  Role,
  Run,
  RunDetail,
  RunEvent,
  RunStatus,
  Stage,
  StageName,
  StageStatus,
  StreamMessage,
} from "../core/types.ts";
import { MIGRATIONS } from "./migrations.ts";

type Row = Record<string, unknown>;
type Listener = (msg: StreamMessage) => void;

const MAX_EVENT_DATA = 16_000;

export function newId(prefix = ""): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${prefix}${time}${rand}`;
}

function json(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

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
  sourceRef: parse(r.source_ref, null),
  requestedBy: (r.requested_by as string) ?? null,
  profile: r.profile as Run["profile"],
  resolvedProfile: (r.resolved_profile as Run["resolvedProfile"]) ?? null,
  taskClass: (r.task_class as Run["taskClass"]) ?? null,
  complexity: (r.complexity as Run["complexity"]) ?? null,
  status: r.status as RunStatus,
  stage: (r.stage as StageName) ?? null,
  baseBranch: (r.base_branch as string) ?? null,
  baseSha: (r.base_sha as string) ?? null,
  branch: (r.branch as string) ?? null,
  headSha: (r.head_sha as string) ?? null,
  prUrl: (r.pr_url as string) ?? null,
  merged: Boolean(r.merged),
  costUsd: r.cost_usd as number,
  costEquivUsd: r.cost_equiv_usd as number,
  tokensIn: r.tokens_in as number,
  tokensOut: r.tokens_out as number,
  error: (r.error as string) ?? null,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number) ?? null,
  finishedAt: (r.finished_at as number) ?? null,
  priority: r.priority as number,
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
  id: r.id as number,
  runId: r.run_id as string,
  stageId: (r.stage_id as number) ?? null,
  role: r.role as Role,
  harness: r.harness as string,
  provider: r.provider as string,
  model: r.model as string,
  modelId: r.model_id as string,
  status: r.status as InvocationStatus,
  costUsd: r.cost_usd as number,
  costEquivUsd: r.cost_equiv_usd as number,
  inputTokens: r.input_tokens as number,
  outputTokens: r.output_tokens as number,
  cacheReadTokens: r.cache_read_tokens as number,
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
  error: "error",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export interface InvocationPatch {
  status?: InvocationStatus;
  costUsd?: number;
  costEquivUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  numTurns?: number;
  sessionId?: string | null;
  error?: string | null;
  finishedAt?: number;
}

const INVOCATION_PATCH_COLUMNS: Record<keyof InvocationPatch, string> = {
  status: "status",
  costUsd: "cost_usd",
  costEquivUsd: "cost_equiv_usd",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
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

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(
      (this.db.query("SELECT version FROM schema_migrations").all() as Row[]).map((r) => r.version as number),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.name, Date.now());
      })();
    }
  }

  // ---- pub/sub -------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(msg: StreamMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // A broken subscriber must never break the pipeline.
      }
    }
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

  createRun(repo: Repo, req: CreateRunRequest): Run {
    const id = newId();
    const title = req.title ?? req.prompt.split("\n")[0]?.slice(0, 80) ?? "Untitled";
    this.db
      .query(
        `INSERT INTO runs (id, repo_id, title, prompt, source, source_ref, requested_by, profile, status, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
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
        req.priority ?? 0,
        Date.now(),
      );
    const run = this.getRun(id) as Run;
    this.publish({ kind: "run", run });
    return run;
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

  listRuns(opts: { status?: RunStatus[]; limit?: number; repoId?: string } = {}): Run[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
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

  updateRun(id: string, patch: RunPatch): Run {
    const { sets, values } = buildUpdate(patch, RUN_PATCH_COLUMNS);
    if (sets.length)
      this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]), id);
    const run = this.getRun(id) as Run;
    this.publish({ kind: "run", run });
    return run;
  }

  /** Recompute run totals from its invocations. */
  refreshRunTotals(runId: string): Run {
    this.db
      .query(
        `UPDATE runs SET
           cost_usd = (SELECT COALESCE(SUM(cost_usd),0) FROM invocations WHERE run_id = ?1),
           cost_equiv_usd = (SELECT COALESCE(SUM(cost_equiv_usd),0) FROM invocations WHERE run_id = ?1),
           tokens_in = (SELECT COALESCE(SUM(input_tokens + cache_read_tokens),0) FROM invocations WHERE run_id = ?1),
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
    return {
      run,
      stages: this.listStages(id),
      invocations: this.listInvocations(id),
      questions: this.listQuestions(id),
      artifacts: this.listArtifacts(id),
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
    runId: string;
    stageId: number | null;
    role: Role;
    harness: string;
    provider: string;
    model: string;
    modelId: string;
  }): Invocation {
    const res = this.db
      .query(
        `INSERT INTO invocations (run_id, stage_id, role, harness, provider, model, model_id, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(inv.runId, inv.stageId, inv.role, inv.harness, inv.provider, inv.model, inv.modelId, Date.now());
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
    return r.s as number;
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
    opts: { after?: number; limit?: number; invocationId?: number } = {},
  ): RunEvent[] {
    const params: (string | number)[] = [runId, opts.after ?? 0];
    let sql = "SELECT * FROM events WHERE run_id = ? AND id > ?";
    if (opts.invocationId !== undefined) {
      sql += " AND invocation_id = ?";
      params.push(opts.invocationId);
    }
    sql += " ORDER BY id LIMIT ?";
    params.push(opts.limit ?? 1000);
    return (this.db.query(sql).all(...params) as Row[]).map(toEvent);
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

  // ---- provider state ------------------------------------------------------

  getProviderRow(provider: string): Row | null {
    return this.db.query("SELECT * FROM provider_state WHERE provider = ?").get(provider) as Row | null;
  }

  putProviderRow(row: {
    provider: string;
    state: string;
    reason: string | null;
    until: number | null;
    windows: unknown;
    consecutiveFailures: number;
  }): void {
    this.db
      .query(
        `INSERT INTO provider_state (provider, state, reason, until, windows_json, consecutive_failures, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET state = excluded.state, reason = excluded.reason, until = excluded.until,
           windows_json = excluded.windows_json, consecutive_failures = excluded.consecutive_failures,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.provider,
        row.state,
        row.reason,
        row.until,
        json(row.windows),
        row.consecutiveFailures,
        Date.now(),
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
}
