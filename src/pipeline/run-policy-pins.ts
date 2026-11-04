import { type Config, repoSettings } from "../config.ts";
import type { Repo, Run } from "../core/types.ts";
import {
  appendPolicySupplement,
  finalizePreparePolicy,
  type PolicyPin,
  recordProvisionalPolicy,
} from "../db/portable-policies.ts";
import type { Store } from "../db/store.ts";
import { ClaimWaitError } from "../integrations/claim-errors.ts";
import { claimGuard } from "../integrations/claim-guard.ts";
import { initialRunState, NeedsHumanError, type RunState } from "./context.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import {
  parseTransferPolicyHistory,
  parseTransferPolicyRecord,
  policyCanonical,
  type TransferPolicyRecord,
  transferAdmissionPolicySchema,
  transferPolicyRecordId,
  transferPreparedPolicySchema,
} from "./run-transfer-policy-schema.ts";

const pinOf = (record: TransferPolicyRecord): PolicyPin => ({
  version: record.version,
  digest: record.recordId,
});
const seal = (record: object) =>
  parseTransferPolicyRecord({ ...record, recordId: transferPolicyRecordId(record) });

export function admissionPolicy(
  cfg: Config,
  repo: Repo,
  profile: unknown,
  runId: string,
): TransferPolicyRecord {
  return seal({
    formatVersion: 1,
    kind: "provisional",
    policyId: runId,
    version: 1,
    parent: null,
    trustedBase: null,
    repository: {
      slug: repo.slug,
      kind: repo.kind,
      defaultBranch: repo.defaultBranch,
      mergePolicy: repo.mergePolicy,
      profile: profile ?? {},
    },
    settings: Object.fromEntries(
      Object.entries(repoSettings(cfg, repo.slug)).filter(([, v]) => v !== undefined),
    ),
    engine: Object.fromEntries(
      Object.keys(transferAdmissionPolicySchema.shape).map((key) => [
        key,
        key === "workers"
          ? {
              agents: [...new Set(cfg.workers.agents)].sort(),
              repoEligible: cfg.workers.repos.includes(repo.slug),
            }
          : Reflect.get(cfg, key),
      ]),
    ),
  });
}

function selectedHistory(store: Store, runId: string): TransferPolicyRecord[] {
  const pin = store.db
    .query<PolicyPin, [string]>(
      "SELECT selected_version AS version, selected_digest AS digest FROM run_policy_selections WHERE run_id = ?",
    )
    .get(runId);
  if (!pin) return [];
  const rows = store.db
    .query<{ record_json: string }, [string, number]>(
      "SELECT record_json FROM run_policy_versions WHERE run_id = ? AND version <= ? ORDER BY version",
    )
    .all(runId, pin.version);
  const records = parseTransferPolicyHistory(rows.map((row) => JSON.parse(row.record_json)));
  const last = records.at(-1);
  if (last?.version !== pin.version || last.recordId !== pin.digest) throw new RunTransferError("corrupt");
  return records;
}

export function ensureAdmissionPin(store: Store, cfg: Config, run: Run, repo: Repo): PolicyPin | null {
  const selected = selectedHistory(store, run.id).at(-1);
  if (selected) return pinOf(selected);
  if (run.startedAt !== null) return null;
  const stored = store.getRunState<RunState>(run.id);
  return recordProvisionalPolicy(store, {
    runId: run.id,
    record: admissionPolicy(cfg, repo, store.getRepoProfile(repo.id), run.id),
    expected: null,
    expectedState: stored,
    state: stored ?? initialRunState(run),
  });
}

export type PinStep =
  | { kind: "prepared"; trustedBase: string }
  | { kind: "review-finalized"; mode: "single" | "panel" }
  | { kind: "scripts-refreshed"; scriptSource: string };

export function pinPolicy(store: Store, runId: string, state: RunState, step: PinStep): PolicyPin {
  // Match Store writes: optional in-memory members are absent in persisted JSON.
  state = JSON.parse(JSON.stringify(state)) as RunState;
  const history = selectedHistory(store, runId);
  const recorded = history.find(
    (record) =>
      record.kind === step.kind &&
      (step.kind !== "scripts-refreshed" ||
        (record.kind === "scripts-refreshed" &&
          record.scriptSource === step.scriptSource &&
          policyCanonical(record.fields.baselineScripts ?? null) ===
            policyCanonical(state.baselineScripts ?? null))),
  );
  if (recorded) return pinOf(recorded);
  const parent = history.at(-1);
  if (!parent) throw new RunTransferError("incomplete");
  const record = seal({
    ...parent,
    kind: step.kind,
    parent: { recordId: parent.recordId, version: parent.version },
    version: parent.version + 1,
    trustedBase: step.kind === "prepared" ? step.trustedBase : parent.trustedBase,
    scriptSource:
      step.kind === "prepared"
        ? step.trustedBase
        : step.kind === "scripts-refreshed"
          ? step.scriptSource
          : Reflect.get(parent, "scriptSource"),
    fields: Object.fromEntries(
      Object.keys(transferPreparedPolicySchema.shape)
        .filter((key) => Object.hasOwn(state, key))
        .map((key) => [key, Reflect.get(state, key)]),
    ),
    ...(step.kind === "review-finalized" ? { effectiveReviewMode: step.mode } : {}),
  });
  claimGuard();
  return (step.kind === "prepared" ? finalizePreparePolicy : appendPolicySupplement)(store, {
    runId,
    record,
    state,
    expected: pinOf(parent),
    expectedState: store.getRunState(runId),
  });
}

export function requirePinnedPolicy(cfg: Config, store: Store, run: Run, repo: Repo): void {
  let selected = selectedHistory(store, run.id).at(-1);
  if (!selected) {
    if (!ensureAdmissionPin(store, cfg, run, repo)) throw new ClaimWaitError("unavailable");
    selected = selectedHistory(store, run.id).at(-1);
  }
  if (!selected) throw new RunTransferError("incomplete");
  const liveRepo = store.getRepo(repo.id);
  if (!liveRepo) throw new NeedsHumanError("shared run policy changed");
  let live: TransferPolicyRecord;
  try {
    live = admissionPolicy(cfg, liveRepo, store.getRepoProfile(repo.id), run.id);
  } catch (error) {
    if (error instanceof RunTransferError) throw new NeedsHumanError("shared run policy changed");
    throw error;
  }
  const policy = (record: TransferPolicyRecord) => [record.engine, record.settings, record.repository];
  if (policyCanonical(policy(live)) === policyCanonical(policy(selected))) return;
  if (
    live.engine.reviewShadow === "off" &&
    selected.engine.reviewShadow === "panel" &&
    policyCanonical(policy({ ...live, engine: { ...live.engine, reviewShadow: "panel" } })) ===
      policyCanonical(policy(selected))
  )
    throw new ClaimWaitError("policy");
  throw new NeedsHumanError("shared run policy changed");
}
