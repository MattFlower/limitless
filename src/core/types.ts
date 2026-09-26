// Domain types shared by the daemon, the CLI and the web UI.
// Keep this file free of runtime imports so the UI can import it too.

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_human";

export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "needs_human"];

export type Profile = "auto" | "quick" | "standard" | "deep";
export type ResolvedProfile = Exclude<Profile, "auto">;

export type TaskClass =
  | "dependency_update"
  | "bugfix"
  | "feature"
  | "refactor"
  | "docs"
  | "test"
  | "chore"
  | "question";

export type Complexity = "trivial" | "small" | "medium" | "large";

export type RunSource = "ui" | "cli" | "chat" | "discord" | "github" | "webhook" | "mcp";

export type StageName =
  | "prepare"
  | "triage"
  | "clarify"
  | "spec"
  | "plan"
  | "holdout"
  | "implement"
  | "gates"
  | "audit"
  | "review"
  | "verify"
  | "deliver";

export type StageStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type Role =
  | "triage"
  | "spec"
  | "plan"
  | "plan_review"
  | "holdout"
  | "implement"
  | "review"
  | "verify"
  | "summarize"
  | "chat";

export type Vendor =
  | "anthropic"
  | "openai"
  | "qwen"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "other";

export type Billing = "subscription" | "metered" | "free";

export type InvocationStatus =
  | "running"
  | "ok"
  | "error"
  | "cancelled"
  | "timeout"
  | "stuck"
  | "quota"
  | "unavailable";

export interface Repo {
  id: string;
  slug: string; // "owner/name" for GitHub, or "local/<name>"
  kind: "github" | "local";
  url: string | null;
  localPath: string | null;
  defaultBranch: string;
  mergePolicy: "auto" | "pr" | "none";
  createdAt: number;
}

export interface Run {
  id: string;
  repoId: string;
  repoSlug: string;
  title: string;
  prompt: string;
  source: RunSource;
  sourceRef: Record<string, unknown> | null;
  requestedBy: string | null;
  profile: Profile;
  resolvedProfile: ResolvedProfile | null;
  taskClass: TaskClass | null;
  complexity: Complexity | null;
  status: RunStatus;
  stage: StageName | null;
  baseBranch: string | null;
  deliveryBranch: string | null;
  baseSha: string | null;
  branch: string | null;
  headSha: string | null;
  prUrl: string | null;
  merged: boolean;
  costUsd: number; // real money (metered providers)
  costEquivUsd: number; // what the work would have cost at API list prices
  tokensIn: number;
  tokensOut: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  priority: number;
}

export interface Stage {
  id: number;
  runId: string;
  name: StageName;
  round: number;
  status: StageStatus;
  summary: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface Invocation {
  id: number;
  runId: string;
  stageId: number | null;
  role: Role;
  harness: string;
  provider: string;
  model: string;
  modelId: string; // catalog id, e.g. "claude/sonnet"
  status: InvocationStatus;
  costUsd: number;
  costEquivUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  numTurns: number;
  sessionId: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export type EventType =
  | "log"
  | "status"
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "rate_limit"
  | "gate"
  | "audit"
  | "stderr"
  | "error";

export interface RunEvent {
  id: number;
  runId: string;
  invocationId: number | null;
  ts: number;
  type: EventType;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data: unknown;
}

export interface Question {
  id: number;
  runId: string;
  question: string;
  answer: string | null;
  askedAt: number;
  answeredAt: number | null;
  answeredBy: string | null;
}

export interface ArtifactMeta {
  name: string;
  kind: string;
  size: number;
  createdAt: number;
}

export interface RunDetail {
  run: Run;
  stages: Stage[];
  invocations: Invocation[];
  questions: Question[];
  artifacts: ArtifactMeta[];
}

export interface QuotaWindow {
  utilization: number; // 0..1
  resetsAt: number | null; // epoch ms
}

export interface ProviderStatus {
  id: string;
  label: string;
  billing: Billing;
  enabled: boolean;
  state: "ok" | "degraded" | "down" | "exhausted" | "disabled";
  reason: string | null;
  until: number | null;
  windows: Record<string, QuotaWindow>;
  spendUsd: number | null; // metered providers
  budgetUsd: number | null;
  inFlight: number;
  maxConcurrent: number;
  updatedAt: number;
}

export interface CreateRunRequest {
  repo: string;
  prompt: string;
  title?: string;
  profile?: Profile;
  source?: RunSource;
  sourceRef?: Record<string, unknown>;
  requestedBy?: string;
  priority?: number;
  baseBranch?: string;
  /** Existing same-repository PR head to update after verification. */
  deliveryBranch?: string;
}

/** Messages pushed on the global SSE stream. */
export type StreamMessage =
  | { kind: "run"; run: Run }
  | { kind: "stage"; stage: Stage }
  | { kind: "invocation"; invocation: Invocation }
  | { kind: "event"; event: RunEvent }
  | { kind: "provider"; provider: ProviderStatus }
  | { kind: "question"; question: Question };
