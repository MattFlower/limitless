import type { Invocation, Repo, Run } from "../core/types.ts";
import { exportPolicySelection, type PolicyPin } from "../db/portable-policies.ts";
import type { Store } from "../db/store.ts";
import { redactCredentials, registeredCredentials } from "../util/proc.ts";
import type { RunState } from "./context.ts";
import { formatManifest, type PortableManifest } from "./portable.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import type { FollowUpInput } from "./run-transfer-followups.ts";
import { sourceOrdinals } from "./run-transfer-ordinals.ts";
import { boundary, preflight, type TransferRepository } from "./run-transfer-rows.ts";
import { decodeRunPayload, encodeRunPayload, type RunPayloadV1 } from "./run-transfer-schema.ts";

export interface SnapshotManifestContext {
  manifest: PortableManifest;
  byteInputs?: readonly Uint8Array[];
}
export interface SnapshotSourceContext {
  run: Run;
  state: RunState;
  repository: Pick<Repo, "kind" | "slug">;
  policyPin: PolicyPin;
}
// Paths omit array indices: each entry has the same stored schema.
const review = "state/(?:(?:lastVerifiedEvidence/)?lastReview|completedChecks/values/review)";
const finding = `(?:${review}/(?:findings|panel/(?:reports/findings|candidates))|state/(?:(?:lastVerifiedEvidence/)?reviewHistory/(?:blocking|followUps)|reviewFollowUps))`;
const verification = `(?:${finding}/verification|${review}/panel/verdicts)`;
const verify =
  "state/(?:(?:lastVerifiedEvidence/)?lastVerify|pendingVerify/modelOutput|verifyResults)(?:/modelOutput)?";
const gates =
  "state/(?:(?:lastVerifiedEvidence/)?lastGates|preRebaseGates|gateEvidence/checks|postMergeGates/result/comparison|completedChecks/values/gates)";
const gateRun = "state/gateExecution/(?:githubActions/completed|previous/result)";
const result = `(?:${gateRun}/(?:setup|checks)|${gates}/(?:result|firstAttempt|coordinatorConfirmation/result)|state/coveringTestRuns/result)(?:/(?:firstAttempt|targetedRetry|retryAttempt))*`;
const descriptive = new RegExp(
  `^(?:${[
    "(?:run|followUp/owner)/(?:title|prompt|error|resolution/note|githubWait/reason)",
    "stages/summary|invocations/(?:error|fastModeDisabledReason)|questions/(?:question|answer)|followUp/findings/(?:title|detail)",
    "state/(?:answers|feedback|implementerReport|implementerIssue|rebaseNote|terminalReason|needsHumanReason|githubWait/reason|reviewResolution/feedback|postMergeRejection/reason)",
    "state/triage/(?:title|summary|blocking_questions)",
    "state/spec/(?:summary|assumptions|requirements|out_of_scope|blocking_questions|acceptance_criteria/criterion)",
    "state/holdout/scenarios/(?:description|steps|expected)",
    `${review}/(?:summary|checklist/(?:item|applies|checked|finding)|panel/(?:warnings|reports/summary|finders/(?:prompt|skipped)))`,
    `${finding}(?:/duplicates)?/(?:title|detail|suggestion|failure_scenario)`,
    `${verification}/(?:evidence|trigger|attributionEvidence/(?:change|obligation|obligationSource|base/result|head))`,
    `${verify}/(?:notes|criteria/(?:evidence|publicSummary|requirementCitation|requirement))`,
    "state/(?:(?:lastVerifiedEvidence/)?lastAudit|completedChecks/values/audit)/detail",
    `${gates}/coordinatorConfirmation/reason|${result}/(?:output|failures|incomplete|failureAttributionReason|executionProvenance/provenanceError|docsOnly/reason|coveringTests?/reason)`,
    `${gateRun}/provenanceError|state/coveringTestRuns/reason|state/gateExecution/githubActions/(?:interrupted|diagnostic)`,
    "state/acceptance/(?:snapshot/(?:ticket(?:/parent)?|parent)/(?:title|body)|manifest/(?:text|item)|output/items/note|outcome/(?:summary|units/(?:note|refusals)))",
    "state/sizeReport/(?:unavailable|error|stated/text)",
    "jobs/(?:failure_reason|result/(?:finalText|error|fastModeDisabledReason|decline/reason|structured/(?:description|summary|notes|error)))",
  ].join("|")})$`,
);
// Unknown strings are identities or executable inputs until classified otherwise.
// Policy is content-addressed and already refuses credentials; never rewrite its history.
function privateText<T>(value: T, credentials: readonly string[], path = "", locked = false): T {
  const hasSecret = (s: string) =>
    credentials.some((c) => c.length > 0 && s.includes(c)) || redactCredentials(s) !== s;
  if (typeof value === "string" && hasSecret(value)) {
    if (locked || !descriptive.test(path)) throw new RunTransferError("invalid");
    return credentials
      .filter(Boolean)
      .reduce((s, c) => s.split(c).join("[redacted]"), redactCredentials(value)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => privateText(v, credentials, path, locked)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (hasSecret(k)) throw new RunTransferError("invalid");
        return [k, privateText(v, credentials, path ? `${path}/${k}` : k, locked)];
      }),
    ) as T;
  if (typeof value === "number" && hasSecret(String(value))) throw new RunTransferError("invalid");
  return value;
}

/** Read-only capture. Object storage and all other asynchronous work belong to the consumer. */
export const captureRunTransferSnapshot = boundary(
  (
    store: Store,
    runId: string,
    manifestContext: (source: SnapshotSourceContext) => SnapshotManifestContext,
  ) =>
    store.db
      .transaction(() => {
        const run = store.getRun(runId);
        if (!run) throw new RunTransferError("missing");
        const round = store.db
          .query<
            Omit<NonNullable<FollowUpInput["round"]>, "findings" | "repoSlug"> & { findings: string },
            [string]
          >(
            `SELECT run_id AS runId, source_run_id AS ownerId, pr_url AS prUrl, round, kind,
           reviewed_sha AS reviewedSha, delivered_sha AS deliveredSha, findings, created_at AS createdAt
           FROM review_rounds WHERE run_id = ?`,
          )
          .get(runId);
        const owner = round ? store.getRun(round.ownerId) : null;
        preflight({ run }, owner);
        const state = store.getRunState<RunState>(runId),
          repository = store.db
            .query<TransferRepository, [string]>("SELECT id, kind, slug FROM repos WHERE id = ?")
            .get(run.repoId);
        if (!state || !repository || (round && !owner)) throw new RunTransferError("incomplete");
        const selection = store.db
          .query<{ version: number }, [string]>(
            "SELECT selected_version AS version FROM run_policy_selections WHERE run_id = ?",
          )
          .get(runId);
        const count =
          selection &&
          store.db
            .query<{ n: number }, [string, number]>(
              "SELECT COUNT(*) AS n FROM run_policy_versions WHERE run_id = ? AND version <= ?",
            )
            .get(runId, selection.version);
        if (!selection || count?.n !== selection.version) throw new RunTransferError("incomplete");
        const policy = exportPolicySelection(store, runId),
          selected = policy.history.at(-1);
        if (!selected) throw new RunTransferError("incomplete");
        const policyPin = { version: policy.version, digest: policy.digest };
        const rows = {
          run,
          stages: store.listStages(runId),
          invocations: store.db
            .query<Omit<Invocation, "sessionId" | "fast"> & { fast: number }, [string]>(
              `SELECT id, run_id AS runId, stage_id AS stageId, role, harness, provider, model,
             model_id AS modelId, effort, status, cost_usd AS costUsd, cost_equiv_usd AS costEquivUsd,
             input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
             cache_write_tokens AS cacheWriteTokens, num_turns AS numTurns, wait_ms AS waitMs, fast,
             fast_mode_state AS fastModeState, fast_mode_disabled_reason AS fastModeDisabledReason,
             error, started_at AS startedAt, finished_at AS finishedAt FROM invocations WHERE run_id = ?`,
            )
            .all(runId)
            .map((row) => ({ ...row, fast: row.fast === 1 })),
          questions: store.listQuestions(runId),
        };
        const jobs = store.db
          .query(
            `SELECT id, run_id, invocation_id, parent_sha, state, attempt, result_sha, failure_reason,
         created_at, updated_at, attempt_deadline_at, result FROM agent_jobs
         WHERE run_id = ? OR invocation_id IN (SELECT id FROM invocations WHERE run_id = ?) OR id = ?`,
          )
          .all(runId, runId, state.agentJob?.id ?? null);
        const captured = manifestContext(
          structuredClone({
            run,
            state,
            repository: { kind: repository.kind, slug: repository.slug },
            policyPin,
          }),
        );
        const credentials = registeredCredentials();
        const manifest = privateText(structuredClone(captured.manifest), credentials, "", true);
        formatManifest(manifest);
        const byteInputs = captured.byteInputs?.map((bytes) => {
          if (!(bytes instanceof Uint8Array)) throw new RunTransferError("invalid");
          return new Uint8Array(bytes);
        });
        const payload = encodeRunPayload(
          {
            ...rows,
            state,
            jobs,
            policy: {
              history: policy.history,
              identity: { policyId: selected.policyId, repository: selected.repository },
            },
            ...(round
              ? {
                  followUp: {
                    owner,
                    round: { ...round, repoSlug: repository.slug, findings: JSON.parse(round.findings) },
                  },
                }
              : {}),
          },
          repository,
          manifest,
        );
        const validated: RunPayloadV1 = decodeRunPayload(
          privateText(payload, credentials),
          repository,
          manifest,
        );
        return {
          payload: validated,
          context: { manifest, policyPin, ...(byteInputs ? { byteInputs } : {}) },
          ordinals: sourceOrdinals(rows),
        };
      })
      .deferred(),
);
