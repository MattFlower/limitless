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
  | "unavailable"
  /** A decision model answered but was not confident enough; routing falls through to the next model. */
  | "declined";

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
  /** How a `resolved` run was dealt with; null for every other status. */
  resolution: RunResolution | null;
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
  /** Execute the baseline gates and bypass the baseline cache (`--no-baseline-cache`). */
  noBaselineCache?: boolean;
  /** Persisted at creation from requester-authored text or options only; legacy runs allow nothing. */
  allow?: AuditAllowance[];
}

export type ResolutionKind = "merged" | "done_elsewhere" | "superseded" | "wont_do" | "pr_closed";
/** `ref`: a run id or PR URL; `by`: "human", "github" or "system"; `at`: epoch ms. */
export interface RunResolution {
  kind: ResolutionKind;
  ref: string | null;
  note: string | null;
  by: string;
  at: number;
}

/** Blocking audit rules a requester may explicitly allow. */
export type AuditAllowance = "submodules" | "gitattributes" | "binary";

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
  waitMs: number;
  fast: boolean;
  fastModeState: string | null;
  fastModeDisabledReason: string | null;
  id: number;
  runId: string;
  stageId: number | null;
  /** `review_shadow`: a shadow panel call, routed as `review` but kept out of review stats and work logs. */
  role: Role | "review_shadow";
  harness: string;
  provider: string;
  model: string;
  effort: RecordedEffort | null;
  modelId: string; // catalog id, e.g. "claude/opus"
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
  fast?: boolean;
  supportsFast?: boolean;
  fastModeUnavailableReason?: string | null;
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
  /** Latest confined-reader sandbox probe of the provider's CLI (Codex). */
  confinement?: ConfinementProbe;
}

/** Fixed probe diagnostics: the CLI's own output can echo config, including tokens. */
export type ConfinementFailure =
  | "reader profile not enforced"
  | "write profile not enforced"
  | "probe inconclusive"
  | "probe timed out"
  | "codex sandbox failed to start";

/** Whether a CLI's sandbox let a confined reader read its cwd but denied every private root. */
export interface ConfinementProbe {
  ok: boolean;
  path: string | null;
  version: string | null;
  reason: ConfinementFailure | null;
  exitCode: number | null;
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
  /** Execute the baseline gates and bypass the baseline cache for reads and writes. */
  noBaselineCache?: boolean;
  /** Audit exemptions the requester explicitly allows (`--allow`); also parsed from CLI/API/UI prompts. */
  allow?: AuditAllowance[];
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
  | { kind: "question"; question: Question }
  | { kind: "feed"; item: FeedItem };

export type FeedKind =
  | "run.gate_timeout_retry"
  | `run.${"pr_opened" | "question" | "needs_human" | "failed" | "succeeded" | "cancelled" | "released" | "merged" | "resolved"}`
  | "eval.finished"
  | "daemon.started"
  | GitHubFeedKind;
export type GitHubFeedKind =
  | `pr.${"ci_passed" | "ci_failed" | "conflicting" | "behind" | "review" | "comment" | "merged" | "closed"}`
  | "github.access_problem";
/** A factory PR the poller observes; `delivered` (0/1): a run waits on its merge; `data`: its saved state. */
export type TrackedPr = { url: string; repo: string; runId: string; delivered: number } & {
  nodeId: string | null;
  data: string | null;
};
export type GitHubAccessProblem = { repo: string; reason: string; detail: string; since: number };
export interface FeedItem {
  id: number;
  ts: number;
  kind: FeedKind;
  runId: string | null;
  evalId: string | null;
  repo: string | null;
  title: string;
  summary: string;
  data: Record<string, unknown>;
}
/** `nextAfter`: the last returned id, else the effective cursor. `pruned`: retention removed items after it. */
export type FeedPage = { items: FeedItem[]; nextAfter: number; pruned: boolean };
export type FeedAck = { consumer: string; id: number };

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

/** A browser sign-in to the UI from a non-loopback address. */
export interface AuthSession {
  id: string;
  method: "password" | "passkey";
  /** The browser's User-Agent at sign-in. */
  device: string;
  createdAt: number;
  lastSeenAt: number;
}

/** A WebAuthn passkey registered for UI sign-in. */
export interface AuthPasskey {
  id: string;
  /** The browser's User-Agent at registration. */
  device: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ChatProposalFields {
  repo: string;
  prompt: string;
  profile: Profile;
  title: string;
  allow?: AuditAllowance[];
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

/** `interrupted`: stopped by a restart, a cancel or a resume; its partial results never feed policy. */
export type EvalStatus = "queued" | "running" | "completed" | "budget_exhausted" | "failed" | "interrupted";
export type EvalStrategy = "retry" | "effort" | "switch";
/** Panel finder prompts: coverage-first `standard`, `adversarial`, or one `careful` senior pass. */
export type FinderPrompt = "standard" | "adversarial" | "careful";
/**
 * One review finder; production may omit `target` (routed), evals may not. A single-mode review
 * always uses the reviewer prompt, named `standard`.
 */
export interface ReviewFinder {
  target?: string;
  prompt: FinderPrompt;
  /** A lens finder: the standard prompt plus this focus. */
  lens?: ReviewLens;
  /** Routed finders avoid the implementer's vendor (`cross`); `implementer` is a fresh session from its family. */
  family?: "cross" | "implementer";
  /** Only a local (free) model, under a shorter timeout; skipped when none answers. */
  local?: boolean;
}
export interface ReviewLens {
  name: string;
  focus: string;
}
/** A lens from the base commit's `.limitless.toml`, added as a finder in the listed profiles. */
export interface RepoReviewLens extends ReviewLens {
  profiles: ResolvedProfile[];
}
/** How a review is performed: one finder (`single`), or finders whose candidates a verifier checks (`panel`). */
export interface ReviewSystem {
  /** Eval only: the source panel system for stored finder replay. */
  replayFrom?: string;
  name: string;
  mode: "single" | "panel";
  finders: ReviewFinder[];
  /** Panel only; production may omit `target` (routed), evals may not. */
  verifier?: { target?: string; targets?: string[] };
  implementerReport: "include" | "omit";
  /** Opt-in panel eval experiment: attribute verifier claims to the change. */
  causalAttribution?: true;
}
/** Trials an eval runs at once per provider, capped at the provider's `maxConcurrent` − 1 (at least 1). */
export const DEFAULT_EVAL_CONCURRENCY = 2;
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
  /**
   * Most trials run at once per provider (also capped by its maxConcurrent − 1). Absent on runs
   * recorded before this option existed, which ran one trial at a time.
   */
  concurrency?: number;
  status: EvalStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  /** The interrupted eval this one resumed, and the eval that resumed this one. */
  resumedFrom?: string;
  resumedBy?: string;
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
    fast?: boolean;
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
    /** `[triage] decision_confidence` a decision-model trial ran with. */
    decisionConfidence?: number;
    preparationFailed?: boolean;
    interrupted?: boolean;
    /** Eval the trial ran in before a resume copied it; its spend was already charged to the provider there. */
    resumedFrom?: string;
    /** Panel verifier calls in order, retries included: the model each ran on and the candidates it was sent. */
    verifiers?: { modelId: string; effort: RecordedEffort; candidates: string[] }[];
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
