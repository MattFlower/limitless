#!/usr/bin/env bun
// Seeds a realistic demo database for UI development, under LIMITLESS_HOME.
//
// IMPORTANT: every run is left in "running" / "waiting_input" / a terminal status — never
// "queued" — and provider_state is seeded directly. The scheduler must never see this data:
// start the server with LIMITLESS_NO_SCHEDULER=1 (see src/app.ts Factory#start), otherwise it
// will try to launch queued runs against real, paid LLM providers.
//
// Usage: LIMITLESS_HOME=/tmp/limitless-ui-dev bun scripts/seed-demo.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Complexity,
  EventType,
  InvocationStatus,
  Profile,
  Repo,
  ResolvedProfile,
  Role,
  RunEvent,
  RunSource,
  RunStatus,
  StageName,
  StageStatus,
  TaskClass,
} from "../src/core/types.ts";
import { newId, Store } from "../src/db/store.ts";
import { priceOf, type Usage } from "../src/harness/types.ts";
import { MODELS, PROVIDERS } from "../src/router/catalog.ts";

const home = process.env.LIMITLESS_HOME;
if (!home) {
  console.error(
    "LIMITLESS_HOME must be set, e.g. LIMITLESS_HOME=/tmp/limitless-ui-dev bun scripts/seed-demo.ts",
  );
  process.exit(1);
}

mkdirSync(home, { recursive: true });
const dbPath = join(home, "limitless.db");
// Reseeding should start from a clean slate.
for (const suffix of ["", "-wal", "-shm"]) {
  const p = `${dbPath}${suffix}`;
  if (existsSync(p)) rmSync(p);
}

const store = new Store(dbPath);
const db = store.db;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();

/** Integer random value in [min, min+span) — every timestamp/token count must be a whole number. */
function rand(min: number, span: number): number {
  return Math.round(min + Math.random() * span);
}

function modelOf(id: string) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown seed model ${id}`);
  return m;
}
function providerOf(id: string) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown seed provider ${id}`);
  return p;
}

// ---------------------------------------------------------------------------
// low-level inserts (the Store's own methods always stamp Date.now(), which we need to override
// to backdate this demo data across the last few days)

function insertRun(r: {
  id: string;
  repoId: string;
  title: string;
  prompt: string;
  source: RunSource;
  requestedBy?: string | null;
  profile: Profile;
  resolvedProfile?: ResolvedProfile | null;
  taskClass?: TaskClass | null;
  complexity?: Complexity | null;
  status: RunStatus;
  stage?: StageName | null;
  baseBranch?: string | null;
  baseSha?: string | null;
  branch?: string | null;
  headSha?: string | null;
  prUrl?: string | null;
  merged?: boolean;
  error?: string | null;
  priority?: number;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}): void {
  db.query(
    `INSERT INTO runs (id, repo_id, title, prompt, source, source_ref, requested_by, profile, resolved_profile,
       task_class, complexity, status, stage, base_branch, base_sha, branch, head_sha, pr_url, merged,
       cost_usd, cost_equiv_usd, tokens_in, tokens_out, error, priority, state_json, created_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,?,NULL,?,?,?)`,
  ).run(
    r.id,
    r.repoId,
    r.title,
    r.prompt,
    r.source,
    null,
    r.requestedBy ?? null,
    r.profile,
    r.resolvedProfile ?? null,
    r.taskClass ?? null,
    r.complexity ?? null,
    r.status,
    r.stage ?? null,
    r.baseBranch ?? "main",
    r.baseSha ?? "0".repeat(40),
    r.branch ?? null,
    r.headSha ?? null,
    r.prUrl ?? null,
    r.merged ? 1 : 0,
    r.error ?? null,
    r.priority ?? 0,
    r.createdAt,
    r.startedAt ?? null,
    r.finishedAt ?? null,
  );
}

function addStage(args: {
  runId: string;
  name: StageName;
  round?: number;
  status: StageStatus;
  summary?: string | null;
  startedAt: number;
  finishedAt: number | null;
}): number {
  const res = db
    .query(
      "INSERT INTO stages (run_id, name, round, status, summary, started_at, finished_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      args.runId,
      args.name,
      args.round ?? 0,
      args.status,
      args.summary ?? null,
      args.startedAt,
      args.finishedAt,
    );
  return Number(res.lastInsertRowid);
}

function addInvocation(args: {
  runId: string;
  stageId: number;
  role: Role;
  modelId: string;
  status: InvocationStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  numTurns: number;
  startedAt: number;
  finishedAt: number | null;
  error?: string | null;
}): number {
  const model = modelOf(args.modelId);
  const provider = providerOf(model.provider);
  const usage: Usage = {
    input: args.inputTokens,
    output: args.outputTokens,
    cacheRead: args.cacheReadTokens ?? 0,
    cacheWrite: 0,
  };
  const equiv = priceOf(usage, model.price);
  const costUsd = provider.billing === "metered" ? equiv : 0;
  const res = db
    .query(
      `INSERT INTO invocations (run_id, stage_id, role, harness, provider, model, model_id, status, cost_usd,
         cost_equiv_usd, input_tokens, output_tokens, cache_read_tokens, num_turns, session_id, error, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      args.runId,
      args.stageId,
      args.role,
      provider.harness,
      model.provider,
      model.model,
      model.id,
      args.status,
      costUsd,
      equiv,
      args.inputTokens,
      args.outputTokens,
      args.cacheReadTokens ?? 0,
      args.numTurns,
      `sess_${newId()}`,
      args.error ?? null,
      args.startedAt,
      args.finishedAt,
    );
  return Number(res.lastInsertRowid);
}

let eventCount = 0;
function addEvent(args: {
  runId: string;
  invocationId?: number | null;
  ts: number;
  type: EventType;
  level?: RunEvent["level"];
  message: string;
  data?: unknown;
}): void {
  eventCount++;
  db.query(
    "INSERT INTO events (run_id, invocation_id, ts, type, level, message, data) VALUES (?,?,?,?,?,?,?)",
  ).run(
    args.runId,
    args.invocationId ?? null,
    args.ts,
    args.type,
    args.level ?? "info",
    args.message.slice(0, 4000),
    args.data !== undefined ? JSON.stringify(args.data) : null,
  );
}

function addQuestion(args: {
  runId: string;
  question: string;
  askedAt: number;
  answer?: string | null;
  answeredAt?: number | null;
  answeredBy?: string | null;
}): void {
  db.query(
    "INSERT INTO questions (run_id, question, answer, asked_at, answered_at, answered_by) VALUES (?,?,?,?,?,?)",
  ).run(
    args.runId,
    args.question,
    args.answer ?? null,
    args.askedAt,
    args.answeredAt ?? null,
    args.answeredBy ?? null,
  );
}

function addArtifact(runId: string, name: string, kind: string, content: string, createdAt: number): void {
  db.query(
    `INSERT INTO artifacts (run_id, name, kind, content, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(run_id, name) DO UPDATE SET kind = excluded.kind, content = excluded.content, created_at = excluded.created_at`,
  ).run(runId, name, kind, content, createdAt);
}

function seedProvider(
  id: string,
  state: string,
  windows: Record<string, { utilization: number; resetsAt: number | null }>,
  reason: string | null = null,
  until: number | null = null,
): void {
  db.query(
    `INSERT INTO provider_state (provider, state, reason, until, windows_json, consecutive_failures, updated_at)
     VALUES (?,?,?,?,?,0,?)
     ON CONFLICT(provider) DO UPDATE SET state=excluded.state, reason=excluded.reason, until=excluded.until,
       windows_json=excluded.windows_json, updated_at=excluded.updated_at`,
  ).run(id, state, reason, until, JSON.stringify(windows), NOW);
}

// A believable slice of an agent transcript: a status line, a handful of tool call/result pairs
// (shell commands for "edit" invocations, read-only inspection for "readonly" ones), then a
// closing text note. Spread evenly across [startAt, endAt].
const EDIT_CMDS: [string, string][] = [
  ["Bash", "bun run typecheck"],
  ["Bash", "bun test"],
  ["Edit", "src/scheduler.ts"],
  ["Write", "src/router/providers.ts"],
  ["Bash", "bunx biome check --write src/scheduler.ts"],
  ["Bash", "git add -A && git status --porcelain"],
  ["Read", "src/pipeline/engine.ts"],
  ["Bash", "bun test test/gates.test.ts"],
];
const READONLY_CMDS: [string, string][] = [
  ["Bash", 'rg -n "resolveRepo" src/git/repos.ts'],
  ["Read", "src/pipeline/engine.ts"],
  ["Grep", "TODO"],
  ["Bash", "git log --oneline -8"],
  ["Bash", "git diff --stat HEAD~1"],
  ["Glob", "src/**/*.ts"],
];

function simulateSession(opts: {
  runId: string;
  invocationId: number;
  role: string;
  startAt: number;
  endAt: number;
  mode: "edit" | "readonly";
  toolCalls: number;
  closingNote: string;
  fail?: boolean;
}): void {
  const span = Math.max(2000, opts.endAt - opts.startAt);
  const step = span / (opts.toolCalls * 2 + 2);
  let t = opts.startAt;
  addEvent({
    runId: opts.runId,
    invocationId: opts.invocationId,
    ts: t,
    type: "status",
    level: "debug",
    message: `session sess_${opts.invocationId} started`,
  });
  const pool = opts.mode === "edit" ? EDIT_CMDS : READONLY_CMDS;
  for (let i = 0; i < opts.toolCalls; i++) {
    t += step;
    const [name, cmd] = pool[i % pool.length] as [string, string];
    const id = `tc_${opts.invocationId}_${i}`;
    addEvent({
      runId: opts.runId,
      invocationId: opts.invocationId,
      ts: t,
      type: "tool_call",
      message: `${name}: ${cmd}`,
      data: { id, input: { command: cmd } },
    });
    t += step;
    const isLastAndFails = opts.fail && i === opts.toolCalls - 1;
    addEvent({
      runId: opts.runId,
      invocationId: opts.invocationId,
      ts: t,
      type: "tool_result",
      level: isLastAndFails ? "warn" : "debug",
      message: isLastAndFails ? "exit code 1" : "ok",
      data: { id, output: isLastAndFails ? "Error: exit code 1\n" : "ok\n", isError: !!isLastAndFails },
    });
  }
  t += step;
  addEvent({
    runId: opts.runId,
    invocationId: opts.invocationId,
    ts: t,
    type: "text",
    message: opts.closingNote,
  });
}

// ---------------------------------------------------------------------------
// repos

const repo1: Repo = store.upsertRepo({
  slug: "mattflower/limitless",
  kind: "github",
  url: "git@github.com:MattFlower/limitless.git",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
});
const repo2: Repo = store.upsertRepo({
  slug: "mattflower/relay",
  kind: "github",
  url: "git@github.com:MattFlower/relay.git",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "auto",
});

// ---------------------------------------------------------------------------
// provider quota telemetry (so the dashboard/models providers panel looks alive immediately)

seedProvider("claude", "ok", {
  five_hour: { utilization: 0.47, resetsAt: NOW + 2 * HOUR + 10 * MIN },
  seven_day: { utilization: 0.63, resetsAt: NOW + 3 * DAY },
});
seedProvider(
  "codex",
  "exhausted",
  {
    five_hour: { utilization: 0.94, resetsAt: NOW + 55 * MIN },
    seven_day: { utilization: 0.58, resetsAt: NOW + 4 * DAY },
  },
  "at reserve limit",
  NOW + 55 * MIN,
);
// openrouter starts disabled (no OPENROUTER_API_KEY in this dev environment) and mtplx/twilight
// start down (no local model server running) — both realistic and require no seeding beyond the
// invocations below, which give openrouter its spend-vs-budget gauge.

// ===========================================================================
// R1 — running, standard profile, implement stage in progress "live"

{
  const id = newId();
  const createdAt = NOW - 7 * MIN;
  const startedAt = createdAt;
  insertRun({
    id,
    repoId: repo1.id,
    title: "Add per-run SSE reconnect telemetry",
    prompt:
      "The run detail stream should log a rate_limit-style breadcrumb whenever the browser reconnects, " +
      "so we can see flaky-network runs in the event log instead of just a gap in timestamps.",
    source: "ui",
    requestedBy: "mattflower",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "feature",
    complexity: "medium",
    status: "running",
    stage: "implement",
    branch: `limitless/${id}-add-per-run-sse-reconnect-telemetry`,
    createdAt,
    startedAt,
  });

  let t = startedAt;
  addStage({
    runId: id,
    name: "prepare",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 6 * SEC,
  });
  addEvent({
    runId: id,
    ts: t + 1000,
    type: "log",
    message: "Gates (detected): bun run typecheck | bun test",
  });
  addEvent({
    runId: id,
    ts: t + 5000,
    type: "gate",
    level: "info",
    message: "typecheck: pass (3s)",
    data: {
      name: "typecheck",
      command: "bun run typecheck",
      ok: true,
      exitCode: 0,
      durationMs: 2800,
      output: "",
    },
  });
  t += 6 * SEC;

  const triageStage = addStage({
    runId: id,
    name: "triage",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 9 * SEC,
    summary: "feature, medium, risk low → standard (claude/haiku)",
  });
  const triageInv = addInvocation({
    runId: id,
    stageId: triageStage,
    role: "triage",
    modelId: "claude/haiku",
    status: "ok",
    inputTokens: 3200,
    outputTokens: 260,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 9 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: triageInv,
    role: "triage",
    startAt: t,
    endAt: t + 9 * SEC,
    mode: "readonly",
    toolCalls: 2,
    closingNote: "triage: feature, medium complexity, low risk",
  });
  t += 9 * SEC;

  const specStage = addStage({
    runId: id,
    name: "spec",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 52 * SEC,
    summary: "4 acceptance criteria (claude/sonnet)",
  });
  const specInv = addInvocation({
    runId: id,
    stageId: specStage,
    role: "spec",
    modelId: "claude/sonnet",
    status: "ok",
    inputTokens: 5400,
    outputTokens: 980,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 52 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: specInv,
    role: "spec",
    startAt: t,
    endAt: t + 52 * SEC,
    mode: "readonly",
    toolCalls: 3,
    closingNote: "Wrote spec.md with 4 acceptance criteria.",
  });
  addArtifact(
    id,
    "spec.md",
    "spec",
    "# Add per-run SSE reconnect telemetry\n\n## Summary\nEmit a breadcrumb event whenever a run's SSE connection reconnects.\n\n" +
      "## Requirements\n- Detect EventSource reconnects on the run stream\n- Log a `rate_limit`-free breadcrumb via the event log\n- Cover it with a test in test/server.test.ts\n\n" +
      "## Acceptance criteria\n- **AC-1** Reconnecting the run stream adds a `status` event visible in the UI\n  - verify: open two run-stream connections and diff event counts\n- **AC-2** No duplicate terminal events after reconnect\n  - verify: `bun test test/server.test.ts`\n\n## Assumptions\n- (none)\n\n## Out of scope\n- Reconnect telemetry for the global `/api/stream`\n",
    t,
  );
  t += 52 * SEC;

  const implStage = addStage({
    runId: id,
    name: "implement",
    round: 0,
    status: "running",
    startedAt: t,
    finishedAt: null,
  });
  const implInv = addInvocation({
    runId: id,
    stageId: implStage,
    role: "implement",
    modelId: "codex/sol",
    status: "running",
    inputTokens: 9100,
    outputTokens: 2600,
    numTurns: 6,
    startedAt: t,
    finishedAt: null,
  });
  simulateSession({
    runId: id,
    invocationId: implInv,
    role: "implement",
    startAt: t,
    endAt: NOW - 4 * SEC,
    mode: "edit",
    toolCalls: 6,
    closingNote: "Wiring reconnect detection into the SSE client…",
  });
  addEvent({
    runId: id,
    invocationId: implInv,
    ts: NOW - 2 * SEC,
    type: "thinking",
    level: "debug",
    message: "Checking whether EventSource exposes readyState transitions cleanly…",
  });

  store.refreshRunTotals(id);
}

// ===========================================================================
// R2 — waiting_input, open question

{
  const id = newId();
  const createdAt = NOW - DAY - 40 * MIN;
  const startedAt = createdAt;
  insertRun({
    id,
    repoId: repo2.id,
    title: "Fix flaky retry backoff in scheduler",
    prompt:
      "Retries after a provider timeout seem to use a fixed 30s backoff regardless of attempt count — make it exponential with a sane cap.",
    source: "cli",
    requestedBy: "mattflower",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "bugfix",
    complexity: "small",
    status: "waiting_input",
    stage: "clarify",
    branch: `limitless/${id}-fix-flaky-retry-backoff`,
    createdAt,
    startedAt,
  });

  let t = startedAt;
  addStage({ runId: id, name: "prepare", status: "succeeded", startedAt: t, finishedAt: t + 5 * SEC });
  t += 5 * SEC;
  const triageStage = addStage({
    runId: id,
    name: "triage",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 11 * SEC,
    summary: "bugfix, small, ambiguity high → standard",
  });
  const triageInv = addInvocation({
    runId: id,
    stageId: triageStage,
    role: "triage",
    modelId: "mtplx/qwen-27b",
    status: "ok",
    inputTokens: 2100,
    outputTokens: 190,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 11 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: triageInv,
    role: "triage",
    startAt: t,
    endAt: t + 11 * SEC,
    mode: "readonly",
    toolCalls: 2,
    closingNote: "Ambiguous: backoff cap unspecified. Flagging for clarification.",
  });
  t += 11 * SEC;
  addStage({ runId: id, name: "clarify", status: "running", startedAt: t, finishedAt: null });
  addEvent({
    runId: id,
    ts: t + 1000,
    type: "log",
    level: "warn",
    message: "Waiting for answers to 1 question(s)",
  });

  addQuestion({
    runId: id,
    question:
      "Should the retry backoff cap at 60s, or scale unbounded with attempt count (e.g. up to the provider's own timeout)?",
    askedAt: t + 2000,
  });

  store.refreshRunTotals(id);
}

// ===========================================================================
// R3 — needs_human, rich failure artifacts (3 implement rounds, still failing)

{
  const id = newId();
  const createdAt = NOW - 2 * DAY - 3 * HOUR;
  const startedAt = createdAt;
  const finishedAt = createdAt + 58 * MIN;
  insertRun({
    id,
    repoId: repo1.id,
    title: "Extract provider tracker persistence into its own module",
    prompt:
      "src/router/providers.ts mixes health/quota logic with SQLite persistence. Split the persistence (provider_state table reads/writes) into src/router/provider-store.ts, keeping behavior identical.",
    source: "ui",
    requestedBy: "mattflower",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "refactor",
    complexity: "large",
    status: "needs_human",
    stage: null,
    branch: `limitless/${id}-extract-provider-tracker-persistence`,
    error:
      "Still failing after 3 implementation rounds. Last feedback:\n" +
      "### Gate failures\n- typecheck: regressed (2 new errors in src/router/provider-store.ts)\n\n" +
      "### Code review requested changes\nCircular import between provider-store.ts and providers.ts reintroduces the coupling this refactor was meant to remove.",
    createdAt,
    startedAt,
    finishedAt,
  });

  let t = startedAt;
  addStage({ runId: id, name: "prepare", status: "succeeded", startedAt: t, finishedAt: t + 7 * SEC });
  const baseline = {
    setupOk: true,
    setup: [
      {
        name: "setup",
        command: "bun install",
        ok: true,
        exitCode: 0,
        durationMs: 4200,
        output: "bun install v1.4.0\n82 packages installed",
      },
    ],
    checks: [
      {
        name: "typecheck",
        command: "bun run typecheck",
        ok: true,
        exitCode: 0,
        durationMs: 6100,
        output: "",
      },
      {
        name: "test",
        command: "bun test",
        ok: true,
        exitCode: 0,
        durationMs: 18400,
        output: "212 pass, 0 fail",
      },
    ],
  };
  addArtifact(id, "baseline-gates.json", "gates", JSON.stringify(baseline, null, 2), t);
  t += 7 * SEC;

  const triageStage = addStage({
    runId: id,
    name: "triage",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 14 * SEC,
    summary: "refactor, large, risk medium → standard (claude/haiku)",
  });
  const triageInv = addInvocation({
    runId: id,
    stageId: triageStage,
    role: "triage",
    modelId: "claude/haiku",
    status: "ok",
    inputTokens: 4400,
    outputTokens: 310,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 14 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: triageInv,
    role: "triage",
    startAt: t,
    endAt: t + 14 * SEC,
    mode: "readonly",
    toolCalls: 2,
    closingNote: "refactor, large, medium risk",
  });
  t += 14 * SEC;

  const specStage = addStage({
    runId: id,
    name: "spec",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 63 * SEC,
    summary: "3 acceptance criteria (claude/opus)",
  });
  const specInv = addInvocation({
    runId: id,
    stageId: specStage,
    role: "spec",
    modelId: "claude/opus",
    status: "ok",
    inputTokens: 8200,
    outputTokens: 1400,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 63 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: specInv,
    role: "spec",
    startAt: t,
    endAt: t + 63 * SEC,
    mode: "readonly",
    toolCalls: 4,
    closingNote: "Wrote spec.md.",
  });
  addArtifact(
    id,
    "spec.md",
    "spec",
    "# Extract provider tracker persistence into its own module\n\n## Summary\nMove SQLite reads/writes for provider state out of ProviderTracker into a dedicated module.\n\n" +
      '## Acceptance criteria\n- **AC-1** ProviderTracker has no direct `Store` import\n  - verify: `rg "import.*Store" src/router/providers.ts` returns nothing\n' +
      "- **AC-2** All existing provider tracker tests still pass\n  - verify: `bun test test/providers.test.ts`\n" +
      "- **AC-3** No circular imports between the two modules\n  - verify: `bunx tsc --noEmit -p .`\n\n## Out of scope\n- Changing the provider_state schema\n",
    t,
  );
  t += 63 * SEC;

  for (let round = 0; round < 3; round++) {
    // Two failed rounds on one implementer escalate it a tier.
    const implementer = round < 2 ? "claude/sonnet" : "claude/opus";
    const implStage = addStage({
      runId: id,
      name: "implement",
      round,
      status: "succeeded",
      startedAt: t,
      finishedAt: t + 210 * SEC,
      summary: `${implementer}: ok, committed ${newId().slice(0, 8)}`,
    });
    const implInv = addInvocation({
      runId: id,
      stageId: implStage,
      role: "implement",
      modelId: implementer,
      status: "ok",
      inputTokens: 14000 + round * 2000,
      outputTokens: 4200 + round * 600,
      numTurns: 12,
      startedAt: t,
      finishedAt: t + 210 * SEC,
    });
    simulateSession({
      runId: id,
      invocationId: implInv,
      role: "implement",
      startAt: t,
      endAt: t + 210 * SEC,
      mode: "edit",
      toolCalls: 6,
      closingNote: `Round ${round + 1}: extracted provider-store.ts.`,
      fail: round < 2,
    });
    t += 210 * SEC;

    addStage({
      runId: id,
      name: "gates",
      round,
      status: "succeeded",
      startedAt: t,
      finishedAt: t + 26 * SEC,
    });
    const gateOk = round === 2 ? false : round === 1;
    const cmp = [
      {
        name: "typecheck",
        verdict: gateOk ? "pass" : "regressed",
        blocking: !gateOk,
        result: {
          name: "typecheck",
          command: "bun run typecheck",
          ok: gateOk,
          exitCode: gateOk ? 0 : 2,
          durationMs: 5900,
          output: gateOk
            ? ""
            : "src/router/provider-store.ts(14,3): error TS2322\nsrc/router/provider-store.ts(41,10): error TS2345",
        },
      },
      {
        name: "test",
        verdict: "pass",
        blocking: false,
        result: {
          name: "test",
          command: "bun test",
          ok: true,
          exitCode: 0,
          durationMs: 17800,
          output: "214 pass, 0 fail",
        },
      },
    ];
    addArtifact(id, `gates-${round}.json`, "gates", JSON.stringify(cmp, null, 2), t);
    addEvent({
      runId: id,
      ts: t + 1000,
      type: "gate",
      level: gateOk ? "info" : "warn",
      message: `typecheck: ${gateOk ? "pass" : "FAIL"} (6s)`,
      data: cmp[0]?.result,
    });
    addEvent({
      runId: id,
      ts: t + 2000,
      type: "gate",
      level: "info",
      message: "test: pass (18s)",
      data: cmp[1]?.result,
    });
    t += 26 * SEC;

    addStage({
      runId: id,
      name: "audit",
      round,
      status: "succeeded",
      startedAt: t,
      finishedAt: t + 2 * SEC,
      summary: "+142/-98 in 4 files; 0 blocking, 1 warnings",
    });
    addEvent({
      runId: id,
      ts: t + 500,
      type: "audit",
      level: "warn",
      message: "[lint-config] biome.json: Lint configuration changed.",
      data: {
        rule: "lint-config",
        severity: "warn",
        file: "biome.json",
        detail: "Lint configuration changed.",
      },
    });
    addArtifact(
      id,
      "diff.patch",
      "diff",
      'diff --git a/src/router/provider-store.ts b/src/router/provider-store.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/router/provider-store.ts\n@@ -0,0 +1,58 @@\n+import type { Store } from "../db/store.ts";\n+import type { ProviderStatus } from "../core/types.ts";\n+\n+export class ProviderStore {\n+  constructor(private readonly store: Store) {}\n+\n+  load(id: string) {\n+    return this.store.getProviderRow(id);\n+  }\n+}\ndiff --git a/src/router/providers.ts b/src/router/providers.ts\n--- a/src/router/providers.ts\n+++ b/src/router/providers.ts\n@@ -1,6 +1,7 @@\n-import type { Store } from "../db/store.ts";\n+import type { ProviderStore } from "./provider-store.ts";\n import type { Reserves } from "../config.ts";\n',
      t,
    );
    t += 2 * SEC;

    if (!gateOk) continue;

    const reviewStage = addStage({
      runId: id,
      name: "review",
      round,
      status: "succeeded",
      startedAt: t,
      finishedAt: t + 48 * SEC,
      summary: "request_changes by codex/sol: 1 blocking, 1 minor",
    });
    const reviewInv = addInvocation({
      runId: id,
      stageId: reviewStage,
      role: "review",
      modelId: "codex/sol",
      status: "ok",
      inputTokens: 9800,
      outputTokens: 1100,
      numTurns: 1,
      startedAt: t,
      finishedAt: t + 48 * SEC,
    });
    simulateSession({
      runId: id,
      invocationId: reviewInv,
      role: "review",
      startAt: t,
      endAt: t + 48 * SEC,
      mode: "readonly",
      toolCalls: 3,
      closingNote: "Found a circular import.",
    });
    const review = {
      verdict: "request_changes" as const,
      summary: "The extraction reintroduces the coupling it was meant to remove via a circular import.",
      findings: [
        {
          severity: "blocker" as const,
          file: "src/router/provider-store.ts",
          line: 3,
          title: "Circular import between provider-store.ts and providers.ts",
          detail:
            "provider-store.ts imports ProviderRuntime from providers.ts, which imports ProviderStore back — this is the exact coupling AC-3 asks to remove.",
          suggestion:
            "Define ProviderRuntime (or a narrower persisted-row type) in provider-store.ts and have providers.ts import from there instead.",
        },
        {
          severity: "minor" as const,
          file: "src/router/provider-store.ts",
          line: 41,
          title: "load() swallows JSON.parse errors silently",
          detail: "Same behavior as before, but worth a comment now that it's isolated in its own module.",
          suggestion: "Add a one-line comment explaining the fallback.",
        },
      ],
      model: "codex/sol",
    };
    addArtifact(id, `review-${round}.json`, "review", JSON.stringify(review, null, 2), t);
    t += 48 * SEC;
  }

  store.refreshRunTotals(id);
}

// ===========================================================================
// R4 — failed (hard failure during deliver)

{
  const id = newId();
  const createdAt = NOW - 3 * DAY - 2 * HOUR;
  const startedAt = createdAt;
  const finishedAt = createdAt + 5 * MIN;
  insertRun({
    id,
    repoId: repo2.id,
    title: "Bump lockfile for security patch",
    prompt: "Dependabot flagged a moderate advisory in a transitive dependency — update the lockfile.",
    source: "github",
    requestedBy: "dependabot[bot]",
    profile: "quick",
    resolvedProfile: "quick",
    taskClass: "dependency_update",
    complexity: "trivial",
    status: "failed",
    stage: null,
    branch: `limitless/${id}-bump-lockfile-security-patch`,
    error:
      "gh pr create returned unexpected output: HTTP 422: A pull request already exists for MattFlower:limitless/... (422)",
    createdAt,
    startedAt,
    finishedAt,
  });
  let t = startedAt;
  addStage({ runId: id, name: "prepare", status: "succeeded", startedAt: t, finishedAt: t + 4 * SEC });
  t += 4 * SEC;
  const triageStage = addStage({
    runId: id,
    name: "triage",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 6 * SEC,
    summary: "dependency_update, trivial, risk low → quick",
  });
  const triageInv = addInvocation({
    runId: id,
    stageId: triageStage,
    role: "triage",
    modelId: "mtplx/qwen-27b",
    status: "ok",
    inputTokens: 1200,
    outputTokens: 90,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 6 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: triageInv,
    role: "triage",
    startAt: t,
    endAt: t + 6 * SEC,
    mode: "readonly",
    toolCalls: 1,
    closingNote: "dependency_update, trivial",
  });
  t += 6 * SEC;
  const implStage = addStage({
    runId: id,
    name: "implement",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 40 * SEC,
    summary: "claude/haiku: ok, committed",
  });
  const implInv = addInvocation({
    runId: id,
    stageId: implStage,
    role: "implement",
    modelId: "claude/haiku",
    status: "ok",
    inputTokens: 2100,
    outputTokens: 340,
    numTurns: 3,
    startedAt: t,
    finishedAt: t + 40 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: implInv,
    role: "implement",
    startAt: t,
    endAt: t + 40 * SEC,
    mode: "edit",
    toolCalls: 3,
    closingNote: "Ran bun update and refreshed the lockfile.",
  });
  t += 40 * SEC;
  addStage({ runId: id, name: "gates", status: "succeeded", startedAt: t, finishedAt: t + 12 * SEC });
  addArtifact(
    id,
    "gates-0.json",
    "gates",
    JSON.stringify(
      [
        {
          name: "test",
          verdict: "pass",
          blocking: false,
          result: {
            name: "test",
            command: "bun test",
            ok: true,
            exitCode: 0,
            durationMs: 11200,
            output: "88 pass",
          },
        },
      ],
      null,
      2,
    ),
    t,
  );
  t += 12 * SEC;
  addStage({
    runId: id,
    name: "audit",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 1 * SEC,
    summary: "+6/-6 in 1 files; 0 blocking, 0 warnings",
  });
  t += 1 * SEC;
  addStage({
    runId: id,
    name: "deliver",
    status: "failed",
    startedAt: t,
    finishedAt: t + 8 * SEC,
    summary: "gh pr create returned unexpected output",
  });
  addEvent({
    runId: id,
    ts: t + 2000,
    type: "error",
    level: "error",
    message: "Run failed: gh pr create returned unexpected output: HTTP 422",
    data: {
      stack:
        "Error: gh pr create returned unexpected output\n    at createPullRequest (src/git/repos.ts:214:9)",
    },
  });

  store.refreshRunTotals(id);
}

// ===========================================================================
// R5 — cancelled mid-implement

{
  const id = newId();
  const createdAt = NOW - DAY - 3 * HOUR;
  const startedAt = createdAt;
  const finishedAt = createdAt + 8 * MIN;
  insertRun({
    id,
    repoId: repo1.id,
    title: "Document the router headroom algorithm",
    prompt:
      "Add a section to docs/ARCHITECTURE.md walking through ProviderTracker#headroom with a worked example.",
    source: "cli",
    requestedBy: "mattflower",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "docs",
    complexity: "small",
    status: "cancelled",
    stage: null,
    branch: `limitless/${id}-document-router-headroom`,
    createdAt,
    startedAt,
    finishedAt,
  });
  let t = startedAt;
  addStage({ runId: id, name: "prepare", status: "succeeded", startedAt: t, finishedAt: t + 5 * SEC });
  t += 5 * SEC;
  const triageStage = addStage({
    runId: id,
    name: "triage",
    status: "succeeded",
    startedAt: t,
    finishedAt: t + 8 * SEC,
    summary: "docs, small, risk low → standard",
  });
  const triageInv = addInvocation({
    runId: id,
    stageId: triageStage,
    role: "triage",
    modelId: "claude/haiku",
    status: "ok",
    inputTokens: 1800,
    outputTokens: 140,
    numTurns: 1,
    startedAt: t,
    finishedAt: t + 8 * SEC,
  });
  simulateSession({
    runId: id,
    invocationId: triageInv,
    role: "triage",
    startAt: t,
    endAt: t + 8 * SEC,
    mode: "readonly",
    toolCalls: 1,
    closingNote: "docs, small",
  });
  t += 8 * SEC;
  const implStage = addStage({
    runId: id,
    name: "implement",
    status: "cancelled",
    startedAt: t,
    finishedAt: t + 7 * MIN,
    summary: "cancelled",
  });
  const implInv = addInvocation({
    runId: id,
    stageId: implStage,
    role: "implement",
    modelId: "claude/sonnet",
    status: "cancelled",
    inputTokens: 3900,
    outputTokens: 780,
    numTurns: 4,
    startedAt: t,
    finishedAt: t + 7 * MIN,
  });
  simulateSession({
    runId: id,
    invocationId: implInv,
    role: "implement",
    startAt: t,
    endAt: t + 6 * MIN,
    mode: "edit",
    toolCalls: 3,
    closingNote: "Drafting the headroom walkthrough…",
  });
  addEvent({ runId: id, ts: t + 7 * MIN, type: "log", level: "warn", message: "Run cancelled" });

  store.refreshRunTotals(id);
}

// ===========================================================================
// R6..R12 — succeeded runs, spread across the last few days

interface SucceededSpec {
  repo: Repo;
  title: string;
  prompt: string;
  profile: Profile;
  resolvedProfile: ResolvedProfile;
  taskClass: TaskClass;
  complexity: Complexity;
  implementModel: string;
  reviewModel: string;
  daysAgo: number;
  hour: number;
  merged: boolean;
  deep?: boolean;
  showcase?: boolean;
}

const succeededSpecs: SucceededSpec[] = [
  {
    repo: repo1,
    title: "Pin bun version in CI workflow",
    prompt: "CI occasionally picks up a newer bun than we test with locally — pin it via .bun-version.",
    profile: "quick",
    resolvedProfile: "quick",
    taskClass: "chore",
    complexity: "trivial",
    implementModel: "claude/haiku",
    reviewModel: "codex/sol",
    daysAgo: 4,
    hour: 9,
    merged: true,
  },
  {
    repo: repo2,
    title: "Add webhook signature verification for generic webhook",
    prompt:
      "POST /webhooks/generic/<token> only checks the token — add an HMAC signature check like the GitHub webhook has.",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "feature",
    complexity: "medium",
    implementModel: "codex/sol",
    reviewModel: "openrouter/deepseek-v4-pro",
    daysAgo: 4,
    hour: 15,
    merged: true,
  },
  {
    repo: repo1,
    title: "Fix race in worktree cleanup on cancel",
    prompt:
      "Cancelling a run right after `deliver` starts can remove the worktree while git is still writing the pack — guard removeWorktree with a check.",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "bugfix",
    complexity: "small",
    implementModel: "claude/sonnet",
    reviewModel: "codex/sol",
    daysAgo: 3,
    hour: 11,
    merged: false,
  },
  {
    repo: repo2,
    title: "Add OpenRouter budget alerts to provider tracker",
    prompt:
      "When OpenRouter spend crosses 80% of the monthly budget, log a warning event so it shows up in the dashboard before it's fully exhausted.",
    profile: "deep",
    resolvedProfile: "deep",
    taskClass: "feature",
    complexity: "large",
    implementModel: "claude/opus",
    reviewModel: "codex/sol-6.1",
    daysAgo: 3,
    hour: 20,
    merged: true,
    deep: true,
  },
  {
    repo: repo1,
    title: "Add regression test for gate comparison verdicts",
    prompt:
      "compareGates() has no direct unit test — add one covering pass/fixed/regressed/still_failing/new_pass/new_failure.",
    profile: "quick",
    resolvedProfile: "quick",
    taskClass: "test",
    complexity: "trivial",
    implementModel: "mtplx/qwen-27b",
    reviewModel: "claude/haiku",
    daysAgo: 2,
    hour: 10,
    merged: true,
  },
  {
    repo: repo2,
    title: "Simplify router candidate scoring",
    prompt:
      "Router#route's scoring loop repeats the same headroom lookup three times per candidate — factor it out and cover with a table test.",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "refactor",
    complexity: "medium",
    implementModel: "claude/sonnet",
    reviewModel: "codex/sol",
    daysAgo: 1,
    hour: 14,
    merged: true,
  },
  {
    repo: repo1,
    title: "Add /api/repos slug validation",
    prompt:
      "POST /api/runs silently 400s on a malformed repo slug — validate it in resolveRepo and return a clearer error message.",
    profile: "standard",
    resolvedProfile: "standard",
    taskClass: "feature",
    complexity: "small",
    implementModel: "claude/sonnet",
    reviewModel: "codex/sol",
    daysAgo: 0,
    hour: -3, // 3 hours ago
    merged: true,
    showcase: true,
  },
];

for (const spec of succeededSpecs) {
  const id = newId();
  const dayStart = NOW - spec.daysAgo * DAY;
  const createdAt =
    spec.hour >= 0
      ? new Date(dayStart).setHours(spec.hour, Math.floor(Math.random() * 50), 0, 0)
      : NOW + spec.hour * HOUR;
  const startedAt = createdAt;
  let t = startedAt;

  const prepStart = t;
  const prepDur = rand(5 * SEC, 4 * SEC);
  t += prepDur;

  const triageDur = rand(8 * SEC, 8 * SEC);
  const triageStart = t;
  t += triageDur;

  let specStart = 0;
  let specDur = 0;
  let planStart = 0;
  let planDur = 0;
  let holdoutStart = 0;
  let holdoutDur = 0;
  if (spec.profile !== "quick") {
    specDur = rand(40 * SEC, 40 * SEC);
    specStart = t;
    t += specDur;
    if (spec.deep) {
      planDur = rand(60 * SEC, 30 * SEC);
      planStart = t;
      t += planDur;
      holdoutDur = rand(90 * SEC, 60 * SEC);
      holdoutStart = t;
      t += holdoutDur;
    }
  }

  const rounds = spec.deep ? 2 : 1;
  const roundTimeline: {
    round: number;
    implStart: number;
    implDur: number;
    gatesStart: number;
    gatesDur: number;
    auditStart: number;
    auditDur: number;
    reviewStart: number;
    reviewDur: number;
    verifyStart: number;
    verifyDur: number;
  }[] = [];
  for (let round = 0; round < rounds; round++) {
    const implDur = rand(120 * SEC, 180 * SEC);
    const implStart = t;
    t += implDur;
    const gatesDur = rand(15 * SEC, 20 * SEC);
    const gatesStart = t;
    t += gatesDur;
    const auditDur = rand(1 * SEC, 2 * SEC);
    const auditStart = t;
    t += auditDur;
    const reviewDur = rand(30 * SEC, 40 * SEC);
    const reviewStart = t;
    t += reviewDur;
    let verifyStart = 0;
    let verifyDur = 0;
    if (spec.profile !== "quick") {
      verifyDur = rand(25 * SEC, 30 * SEC);
      verifyStart = t;
      t += verifyDur;
    }
    roundTimeline.push({
      round,
      implStart,
      implDur,
      gatesStart,
      gatesDur,
      auditStart,
      auditDur,
      reviewStart,
      reviewDur,
      verifyStart,
      verifyDur,
    });
  }
  const deliverDur = rand(8 * SEC, 10 * SEC);
  const deliverStart = t;
  t += deliverDur;
  const finishedAt = t;

  const branch = `limitless/${id}-${spec.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/-+$/, "")}`;
  const prUrl = `https://github.com/${spec.repo.slug}/pull/${100 + Math.floor(Math.random() * 900)}`;

  insertRun({
    id,
    repoId: spec.repo.id,
    title: spec.title,
    prompt: spec.prompt,
    source: "ui",
    requestedBy: "mattflower",
    profile: spec.profile,
    resolvedProfile: spec.resolvedProfile,
    taskClass: spec.taskClass,
    complexity: spec.complexity,
    status: "succeeded",
    stage: null,
    branch,
    prUrl,
    merged: spec.merged,
    createdAt,
    startedAt,
    finishedAt,
  });

  addStage({
    runId: id,
    name: "prepare",
    status: "succeeded",
    startedAt: prepStart,
    finishedAt: prepStart + prepDur,
  });

  const triageStage = addStage({
    runId: id,
    name: "triage",
    status: "succeeded",
    startedAt: triageStart,
    finishedAt: triageStart + triageDur,
    summary: `${spec.taskClass}, ${spec.complexity}, risk low → ${spec.resolvedProfile}`,
  });
  const triageInv = addInvocation({
    runId: id,
    stageId: triageStage,
    role: "triage",
    modelId: "claude/haiku",
    status: "ok",
    inputTokens: rand(2000, 2000),
    outputTokens: rand(150, 150),
    numTurns: 1,
    startedAt: triageStart,
    finishedAt: triageStart + triageDur,
  });
  simulateSession({
    runId: id,
    invocationId: triageInv,
    role: "triage",
    startAt: triageStart,
    endAt: triageStart + triageDur,
    mode: "readonly",
    toolCalls: 2,
    closingNote: `${spec.taskClass}, ${spec.complexity} complexity`,
  });

  if (spec.profile !== "quick") {
    const specStage = addStage({
      runId: id,
      name: "spec",
      status: "succeeded",
      startedAt: specStart,
      finishedAt: specStart + specDur,
      summary: "3 acceptance criteria (claude/sonnet)",
    });
    const specInv = addInvocation({
      runId: id,
      stageId: specStage,
      role: "spec",
      modelId: "claude/sonnet",
      status: "ok",
      inputTokens: rand(5000, 3000),
      outputTokens: rand(900, 500),
      numTurns: 1,
      startedAt: specStart,
      finishedAt: specStart + specDur,
    });
    simulateSession({
      runId: id,
      invocationId: specInv,
      role: "spec",
      startAt: specStart,
      endAt: specStart + specDur,
      mode: "readonly",
      toolCalls: 3,
      closingNote: "Wrote spec.md.",
    });
    const specMd = `# ${spec.title}\n\n## Summary\n${spec.prompt}\n\n## Acceptance criteria\n- **AC-1** Behavior matches the prompt under normal input\n  - verify: \`bun test\`\n- **AC-2** No regression in existing gates\n  - verify: \`bun run typecheck && bun test\`\n- **AC-3** Change is scoped to the described area\n  - verify: \`git diff --stat\`\n`;
    addArtifact(id, "spec.md", "spec", specMd, specStart);

    if (spec.deep) {
      const planStage = addStage({
        runId: id,
        name: "plan",
        status: "succeeded",
        startedAt: planStart,
        finishedAt: planStart + planDur,
        summary: "2-vendor plan review, both approved",
      });
      const planInv = addInvocation({
        runId: id,
        stageId: planStage,
        role: "plan",
        modelId: "claude/opus",
        status: "ok",
        inputTokens: 7000,
        outputTokens: 1800,
        numTurns: 1,
        startedAt: planStart,
        finishedAt: planStart + planDur,
      });
      simulateSession({
        runId: id,
        invocationId: planInv,
        role: "plan",
        startAt: planStart,
        endAt: planStart + planDur,
        mode: "readonly",
        toolCalls: 3,
        closingNote: "Drafted a 3-step implementation plan.",
      });

      const holdoutStage = addStage({
        runId: id,
        name: "holdout",
        status: "succeeded",
        startedAt: holdoutStart,
        finishedAt: holdoutStart + holdoutDur,
        summary: "5 blind acceptance scenarios authored",
      });
      const holdoutInv = addInvocation({
        runId: id,
        stageId: holdoutStage,
        role: "holdout",
        modelId: "codex/sol",
        status: "ok",
        inputTokens: 6500,
        outputTokens: 2100,
        numTurns: 1,
        startedAt: holdoutStart,
        finishedAt: holdoutStart + holdoutDur,
      });
      simulateSession({
        runId: id,
        invocationId: holdoutInv,
        role: "holdout",
        startAt: holdoutStart,
        endAt: holdoutStart + holdoutDur,
        mode: "readonly",
        toolCalls: 2,
        closingNote: "Authored 5 scenarios, blind to the diff.",
      });
    }
  }

  for (const rt of roundTimeline) {
    const implStage = addStage({
      runId: id,
      name: "implement",
      round: rt.round,
      status: "succeeded",
      startedAt: rt.implStart,
      finishedAt: rt.implStart + rt.implDur,
      summary: `${spec.implementModel}: ok, committed ${id.slice(-8)}`,
    });
    const implInv = addInvocation({
      runId: id,
      stageId: implStage,
      role: "implement",
      modelId: spec.implementModel,
      status: "ok",
      inputTokens: rand(8000, 12000),
      outputTokens: rand(2500, 3500),
      numTurns: 8 + Math.floor(Math.random() * 10),
      startedAt: rt.implStart,
      finishedAt: rt.implStart + rt.implDur,
    });
    simulateSession({
      runId: id,
      invocationId: implInv,
      role: "implement",
      startAt: rt.implStart,
      endAt: rt.implStart + rt.implDur,
      mode: "edit",
      toolCalls: 5,
      closingNote: `Implemented: ${spec.title.toLowerCase()}.`,
    });

    addStage({
      runId: id,
      name: "gates",
      round: rt.round,
      status: "succeeded",
      startedAt: rt.gatesStart,
      finishedAt: rt.gatesStart + rt.gatesDur,
      summary: "2 checks ok",
    });
    const gatesCmp = [
      {
        name: "typecheck",
        verdict: "pass",
        blocking: false,
        result: {
          name: "typecheck",
          command: "bun run typecheck",
          ok: true,
          exitCode: 0,
          durationMs: Math.round(rt.gatesDur * 0.4),
          output: "",
        },
      },
      {
        name: "test",
        verdict: "pass",
        blocking: false,
        result: {
          name: "test",
          command: "bun test",
          ok: true,
          exitCode: 0,
          durationMs: Math.round(rt.gatesDur * 0.6),
          output: `${200 + Math.floor(Math.random() * 40)} pass, 0 fail`,
        },
      },
    ];
    addArtifact(id, `gates-${rt.round}.json`, "gates", JSON.stringify(gatesCmp, null, 2), rt.gatesStart);
    addEvent({
      runId: id,
      ts: rt.gatesStart + 500,
      type: "gate",
      level: "info",
      message: "typecheck: pass (0s)",
      data: gatesCmp[0]?.result,
    });
    addEvent({
      runId: id,
      ts: rt.gatesStart + 1000,
      type: "gate",
      level: "info",
      message: "test: pass (0s)",
      data: gatesCmp[1]?.result,
    });

    const added = 20 + Math.floor(Math.random() * 180);
    const removed = 5 + Math.floor(Math.random() * 60);
    addStage({
      runId: id,
      name: "audit",
      round: rt.round,
      status: "succeeded",
      startedAt: rt.auditStart,
      finishedAt: rt.auditStart + rt.auditDur,
      summary: `+${added}/-${removed} in ${1 + Math.floor(Math.random() * 4)} files; 0 blocking, 0 warnings`,
    });
    addArtifact(
      id,
      "diff.patch",
      "diff",
      `diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,7 +10,7 @@\n-  // TODO\n+  // implemented for: ${spec.title}\n+  export function handle() {\n+    return true;\n+  }\n`,
      rt.auditStart,
    );

    const reviewStage = addStage({
      runId: id,
      name: "review",
      round: rt.round,
      status: "succeeded",
      startedAt: rt.reviewStart,
      finishedAt: rt.reviewStart + rt.reviewDur,
      summary: `approve by ${spec.reviewModel}: 0 blocking, 1 minor`,
    });
    const reviewInv = addInvocation({
      runId: id,
      stageId: reviewStage,
      role: "review",
      modelId: spec.reviewModel,
      status: "ok",
      inputTokens: rand(6000, 6000),
      outputTokens: rand(900, 600),
      numTurns: 1,
      startedAt: rt.reviewStart,
      finishedAt: rt.reviewStart + rt.reviewDur,
    });
    simulateSession({
      runId: id,
      invocationId: reviewInv,
      role: "review",
      startAt: rt.reviewStart,
      endAt: rt.reviewStart + rt.reviewDur,
      mode: "readonly",
      toolCalls: 3,
      closingNote: "Looks good, one small nit.",
    });
    const review = {
      verdict: "approve" as const,
      summary: "Implementation matches the spec; gates and audit are clean.",
      findings: [
        {
          severity: "minor" as const,
          file: "src/example.ts",
          line: 12,
          title: "Consider a doc comment",
          detail: "A one-line comment would help future readers understand why this branch exists.",
          suggestion: "Add `// handles <case>` above the new block.",
        },
      ],
      model: spec.reviewModel,
    };
    addArtifact(id, `review-${rt.round}.json`, "review", JSON.stringify(review, null, 2), rt.reviewStart);

    if (spec.profile !== "quick") {
      const verifyStage = addStage({
        runId: id,
        name: "verify",
        round: rt.round,
        status: "succeeded",
        startedAt: rt.verifyStart,
        finishedAt: rt.verifyStart + rt.verifyDur,
        summary: "pass: 3/3 criteria met",
      });
      const verifyInv = addInvocation({
        runId: id,
        stageId: verifyStage,
        role: "verify",
        modelId: "claude/sonnet",
        status: "ok",
        inputTokens: 4500,
        outputTokens: 700,
        numTurns: 1,
        startedAt: rt.verifyStart,
        finishedAt: rt.verifyStart + rt.verifyDur,
      });
      simulateSession({
        runId: id,
        invocationId: verifyInv,
        role: "verify",
        startAt: rt.verifyStart,
        endAt: rt.verifyStart + rt.verifyDur,
        mode: "readonly",
        toolCalls: 3,
        closingNote: "All acceptance criteria met.",
      });
      const verify = {
        criteria: [
          { id: "AC-1", status: "met" as const, evidence: "bun test — 3 new assertions pass" },
          { id: "AC-2", status: "met" as const, evidence: "bun run typecheck && bun test — clean" },
          { id: "AC-3", status: "met" as const, evidence: "git diff --stat — 1 file changed, within scope" },
        ],
        overall: "pass" as const,
        notes: "No regressions observed.",
        model: "claude/sonnet",
      };
      addArtifact(id, `verify-${rt.round}.json`, "verify", JSON.stringify(verify, null, 2), rt.verifyStart);
    }
  }

  addStage({
    runId: id,
    name: "deliver",
    status: "succeeded",
    startedAt: deliverStart,
    finishedAt: deliverStart + deliverDur,
    summary: `PR ${prUrl} — ${spec.merged ? "merged" : "left open (merge policy: pr)"}`,
  });
  addEvent({ runId: id, ts: deliverStart + 1000, type: "log", message: `Pull request: ${prUrl}` });
  const report = `# ${spec.title}\n\n${spec.merged ? "Merged" : "Open"} — [${prUrl}](${prUrl})\n\n## What changed\n${spec.prompt}\n\n## Verification\nAll gates passed; reviewer approved${spec.profile !== "quick" ? "; all acceptance criteria met." : "."}\n`;
  addArtifact(id, "report.md", "report", report, finishedAt);
  // spec.showcase ("Add /api/repos slug validation") already carries the full artifact set by
  // construction: spec.md, diff.patch, gates-0.json, review-0.json, verify-0.json, report.md.

  store.refreshRunTotals(id);
}

// ---------------------------------------------------------------------------

console.log(`Seeded ${home}`);
console.log(`  repos: ${repo1.slug}, ${repo2.slug}`);
console.log(`  runs: ${(db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n}`);
console.log(`  stages: ${(db.query("SELECT COUNT(*) AS n FROM stages").get() as { n: number }).n}`);
console.log(`  invocations: ${(db.query("SELECT COUNT(*) AS n FROM invocations").get() as { n: number }).n}`);
console.log(`  events: ${eventCount}`);
console.log(`  artifacts: ${(db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n}`);
store.close();
