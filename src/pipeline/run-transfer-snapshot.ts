import type { Repo, Run } from "../core/types.ts";
import { exportPolicySelection, type PolicyPin } from "../db/portable-policies.ts";
import type { Store } from "../db/store.ts";
import { redactCredentials, registeredCredentials } from "../util/proc.ts";
import type { RunState } from "./context.ts";
import { formatManifest, type PortableManifest } from "./portable.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import type { FollowUpInput } from "./run-transfer-followups.ts";
import { sourceOrdinals } from "./run-transfer-ordinals.ts";
import { boundary, preflight } from "./run-transfer-rows.ts";
import { decodeRunPayload, encodeRunPayload, type RunPayloadV1 } from "./run-transfer-schema.ts";

export interface SnapshotManifestContext {
  manifest: PortableManifest;
  byteInputs?: readonly Uint8Array[];
}
export interface SnapshotSourceContext {
  run: Run;
  state: RunState;
  repository: Repo;
  policyPin: PolicyPin;
}
const descriptive = new Set(
  (
    "title prompt summary question answer answers feedback error note notes detail evidence publicSummary " +
    "requirement requirementCitation reason finalText output failures diagnostic interrupted incomplete " +
    "implementerReport implementerIssue rebaseNote terminalReason needsHumanReason fastModeDisabledReason " +
    "failure_reason provenanceError failureAttributionReason description steps expected body text item"
  ).split(" "),
);
// Unknown strings are identities or executable inputs until classified otherwise.
// Policy is content-addressed and already refuses credentials; never rewrite its history.
function privateText<T>(value: T, credentials: readonly string[], key = "", locked = false): T {
  const hasSecret = (s: string) =>
    credentials.some((c) => c.length > 0 && s.includes(c)) || redactCredentials(s) !== s;
  if (typeof value === "string" && hasSecret(value)) {
    if (locked || !descriptive.has(key)) throw new RunTransferError("invalid");
    return credentials
      .filter(Boolean)
      .reduce((s, c) => s.split(c).join("[redacted]"), redactCredentials(value)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => privateText(v, credentials, key, locked)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (hasSecret(k)) throw new RunTransferError("invalid");
        return [k, privateText(v, credentials, k, locked || k === "policy")];
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
          repository = store.getRepo(run.repoId);
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
          invocations: store.listInvocations(runId),
          questions: store.listQuestions(runId),
        };
        const jobs = store.db
          .query(
            `SELECT id, run_id, invocation_id, parent_sha, state, attempt, result_sha, failure_reason,
         created_at, updated_at, attempt_deadline_at, result FROM agent_jobs
         WHERE run_id = ? OR invocation_id IN (SELECT id FROM invocations WHERE run_id = ?) OR id = ?`,
          )
          .all(runId, runId, state.agentJob?.id ?? null);
        const captured = manifestContext(structuredClone({ run, state, repository, policyPin }));
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
