// Domain types shared by the daemon, the CLI and the web UI.
// Keep this file free of runtime imports so the UI can import it too.

export type RunStatus =
  | "queued"
  | "waiting"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_human"
  | "resolved";

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "needs_human",
  "resolved",
];

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
  | "preview"
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
  | "google"
  | "meta"
  | "ibm"
  | "nvidia"
  | "mistral"
  | "typesafe"
  | "other";

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** Persisted effort: "default" = deliberately unset (backend default); null = legacy, unknown. */
export type RecordedEffort = Effort | "default";

/** A saved routing selection; null explicitly leaves backend effort unset. */
export interface ModelSelection {
  modelId: string;
  effort: Effort | null;
}

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
  flow?: "build" | "verify-change";
  id: string;
  repoId: string;
  repoSlug: string;
  title: string;
  prompt: string;
  source: RunSource;
  githubWebhookVerified: boolean;
  sourceRef: Record<string, unknown> | null;
  requestedBy: string | null;
  profile: Profile;
  resolvedProfile: ResolvedProfile | null;
  taskClass: TaskClass | null;
  complexity: Complexity | null;
  status: RunStatus;
  dependsOn: string[];
  prClosedUnmerged: boolean;
  stage: StageName | null;
  baseBranch: string | null;
  deliveryBranch: string | null;
  baseSha: string | null;
  branch: string | null;
  headSha: string | null;
  prUrl: string | null;
  merged: boolean;
  mergedBy: string | null;
  mergedAt: number | null;
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
  effort: RecordedEffort | null;
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
  windows: Record<string, QuotaWindow & { observedAt: number | null }>;
  spendUsd: number | null; // metered providers
  budgetUsd: number | null;
  reportedUsageUsd?: number | null;
  reportedAt?: number | null;
  limit?: number | null;
  limitRemaining?: number | null;
  limitReset?: string | null;
  inFlight: number;
  maxConcurrent: number;
  updatedAt: number;
}

export interface QuotaAlert {
  provider: string;
  window: string;
  utilization: number | null;
  resetsAt: number | null;
  severity: "warning" | "exhausted";
  routing: string;
  createdAt: number;
}

export interface CreateRunRequest {
  dependsOn?: string[];
  repo: string;
  prompt: string;
  title?: string;
  profile?: Profile;
  source?: RunSource;
  sourceRef?: Record<string, unknown>;
  requestedBy?: string;
  priority?: number;
  baseBranch?: string;
  /** Existing same-repository PR head; accepted only from a verified GitHub webhook. */
  deliveryBranch?: string;
}

/** Messages pushed on the global SSE stream. */
export type StreamMessage =
  | ChatStreamMessage
  | { kind: "run"; run: Run }
  | { kind: "stage"; stage: Stage }
  | { kind: "invocation"; invocation: Invocation }
  | { kind: "event"; event: RunEvent }
  | { kind: "provider"; provider: ProviderStatus }
  | { kind: "alert"; alert: QuotaAlert | null; provider: string; window: string; created: boolean }
  | { kind: "question"; question: Question };

/** Process-local scheduler state; active includes executions waiting for input or capacity. */
export interface DrainState {
  draining: boolean;
  active: string[];
  parked?: string[];
}

export interface HealthResponse extends DrainState {
  ok: boolean;
  uptimeMs: number;
  sha: string;
}

export interface ChatProposalFields {
  repo: string;
  prompt: string;
  profile: Profile;
  title: string;
}

export type ChatAction =
  | { type: "reply"; text: string }
  | ({ type: "propose_run" } & ChatProposalFields)
  | { type: "create_run"; proposalId: string }
  | { type: "status"; target: string }
  | { type: "answer_question"; runId: string; answer: string };

export type ChatRequest =
  | { type: "text"; text: string }
  | { type: "confirm"; proposalId: string }
  | { type: "edit"; proposalId: string; proposal: ChatProposalFields };

export interface ChatOrigin {
  source: "chat" | "discord";
  requestedBy: string;
  channelId?: string;
  messageId?: string;
}

export interface ChatProposal extends ChatProposalFields {
  id: string;
  conversationId: string;
  state: "pending" | "superseded" | "confirmed" | "consumed";
  confirmedAt: number | null;
  runId: string | null;
  origin: ChatOrigin;
}

export interface ChatMessage {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  runId: string | null;
  outcome: {
    action?: ChatAction;
    proposal?: ChatProposal;
    error?: boolean;
  } | null;
}

export interface ChatConversation {
  messages: ChatMessage[];
  proposals: ChatProposal[];
}

export type ChatStreamMessage = { kind: "chat"; message: ChatMessage };

export type EvalStatus = "queued" | "running" | "completed" | "budget_exhausted" | "failed";
export type EvalStrategy = "retry" | "effort" | "switch";
/** One review finder; production may omit `target` (routed), evals may not. */
export interface ReviewFinder {
  target?: string;
  prompt: "standard";
}
/** How a review is performed. Only `mode: "single"` with one standard finder is implemented. */
export interface ReviewSystem {
  name: string;
  mode: "single";
  finders: ReviewFinder[];
  implementerReport: "include" | "omit";
}
export interface EvalRun {
  rounds?: number;
  strategy?: EvalStrategy;
  /** Review candidates, finder targets resolved at submission. Absent on older and non-review runs. */
  systems?: ReviewSystem[];
  id: string;
  role: "triage" | "review" | "verify" | "implement";
  models: string[];
  k: number;
  maxUsd: number;
  status: EvalStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}
export interface EvalGrade {
  pass: boolean | null;
  score: number | null;
  fields: Record<
    string,
    { predicted: string | boolean; accepted: (string | boolean)[]; match: boolean; weight: number }
  >;
  riskUnderCall: boolean | null;
  implement?: {
    reason: "hidden_tests" | "gates" | "audit" | "error" | "timeout" | null;
    error?: string;
    commit: string | null;
    gates: import("../gates/run.ts").GateComparison[];
    auditBlocks: import("../gates/audit.ts").AuditFinding[];
    auditWarnings: import("../gates/audit.ts").AuditFinding[];
    hidden: { exitCode: number | null; timedOut: boolean; output: string } | null;
  };
  review?: {
    /** Required defects caught by a round-1 blocking finding. */
    requiredMatched: number;
    requiredTotal: number;
    recall: number | null;
    // Absent on grades stored before blocking-recall grading; those don't count as review evidence.
    underRated?: number;
    blockingFindings?: number;
    bySeverity?: Record<"high" | "medium" | "low", { caught: number; total: number }>;
    /** Production-derived verdict, not the model's. */
    requestChanges: boolean;
    falseBlock: boolean | null;
    verdictMatch: boolean;
  };
  verify?: {
    matched: number;
    total: number;
    falseAccepts: number;
    unmetTotal: number;
    falseRejects: number;
    metTotal: number;
    criteria: Record<
      string,
      {
        gold: "met" | "unmet";
        predictions: ("met" | "unmet" | "unclear" | "blocked")[];
        predicted: "met" | "unmet" | "unclear" | "blocked" | "missing" | "duplicate";
        match: boolean;
        falseAccept: boolean;
        falseReject: boolean;
      }
    >;
  };
}
export interface EvalTrial {
  effort: RecordedEffort | null;
  evalRunId: string;
  caseId: string;
  modelId: string;
  trial: number;
  cacheKey: string;
  harness: string;
  status: "queued" | "running" | "ok" | "error" | "skipped";
  output: unknown;
  pass: boolean | null;
  score: number | null;
  details: {
    /** Review system name; distinguishes candidates that share a target. */
    system?: string;
    switchChain?: (ModelSelection & { tier: number })[];
    rounds?: EvalRound[];
    roundsUsed?: number;
    stopReason?: string;
    complexity?: "trivial" | "small" | "medium";
    provider?: string;
    reason?: string;
    grade?: EvalGrade;
    invocationStatus?: InvocationStatus;
    preparationFailed?: boolean;
    interrupted?: boolean;
    cache?: {
      evalRunId: string;
      caseId: string;
      costUsd: number;
      costEquivUsd: number;
      tokensIn: number;
      tokensOut: number;
      durationMs: number;
    };
  };
  costUsd: number;
  costEquivUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  createdAt: number;
}

export interface EvalRound {
  harness?: string;
  resumeFailed?: boolean;
  provider?: string;
  round: number;
  modelId: string;
  effort: RecordedEffort;
  status: InvocationStatus;
  pass: boolean | null;
  reason: string | null;
  costUsd: number;
  costEquivUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}
