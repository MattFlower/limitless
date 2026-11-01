import { RunTransferError } from "../pipeline/run-transfer-errors.ts";
import { parseTransferPolicy } from "../pipeline/run-transfer-policy-equality.ts";
import {
  parseTransferPolicyHistory,
  parseTransferPolicyRecord,
  policyCanonical,
  type TransferPolicyRecord,
  transferPreparedPolicySchema,
} from "../pipeline/run-transfer-policy-schema.ts";
import type { Store } from "./store.ts";

export interface PolicyPin {
  version: number;
  digest: string;
}
export interface PolicyTransition {
  runId: string;
  record: unknown;
  state: unknown;
  expected: PolicyPin | null;
  expectedState: unknown;
}
type Selection = PolicyPin & { policyId: string };
type PolicyRow = {
  policy_id: string;
  version: number;
  kind: string;
  digest: string;
  record_json: string;
};
const fail = (code: "conflict" | "corrupt" | "incomplete" | "invalid"): never => {
  throw new RunTransferError(code);
};
function storedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail("corrupt");
  }
}
function current(store: Store, runId: string) {
  const row = store.db
    .query<{ state_json: string | null }, [string]>("SELECT state_json FROM runs WHERE id = ?")
    .get(runId);
  if (!row) return fail("conflict");
  const selection = store.db
    .query<Selection, [string]>(
      `SELECT policy_id AS policyId, selected_version AS version, selected_digest AS digest
     FROM run_policy_selections WHERE run_id = ?`,
    )
    .get(runId);
  return { selection, state: row.state_json === null ? null : storedJson(row.state_json) };
}
function history(store: Store, runId: string, selection: Selection): TransferPolicyRecord[] {
  const rows = store.db
    .query<PolicyRow, [string, number]>(
      `SELECT policy_id, version, kind, digest, record_json FROM run_policy_versions
     WHERE run_id = ? AND version <= ? ORDER BY version`,
    )
    .all(runId, selection.version);
  const records = rows.map((row) => {
    const record = parseTransferPolicyRecord(storedJson(row.record_json));
    if (
      record.policyId !== row.policy_id ||
      record.policyId !== selection.policyId ||
      record.version !== row.version ||
      record.kind !== row.kind ||
      record.recordId !== row.digest ||
      policyCanonical(record) !== row.record_json
    )
      return fail("corrupt");
    return record;
  });
  const pin = records.at(-1);
  if (pin?.version !== selection.version || pin.recordId !== selection.digest) return fail("corrupt");
  return parseTransferPolicyHistory(records);
}
const identity = (record: TransferPolicyRecord) => ({
  policyId: record.policyId,
  repository: record.repository,
});
const pinOf = (record: TransferPolicyRecord): PolicyPin => ({
  version: record.version,
  digest: record.recordId,
});

// Only trusted checkpoint callers may use these operations; production wiring belongs to C11.
function transition(
  store: Store,
  input: PolicyTransition,
  kind: "provisional" | "prepared" | "supplement",
): PolicyPin {
  const apply = () => {
    const record = parseTransferPolicyRecord(input.record);
    if (
      kind === "supplement"
        ? record.kind !== "review-finalized" && record.kind !== "scripts-refreshed"
        : record.kind !== kind
    )
      return fail("invalid");
    const { selection, state } = current(store, input.runId);
    const previous = selection ? history(store, input.runId, selection) : [];
    const pin = pinOf(record);
    const samePin = selection?.version === pin.version && selection.digest === pin.digest;
    if (samePin && policyCanonical(state) === policyCanonical(input.state)) {
      parseTransferPolicy(previous, identity(record), state);
      return pin;
    }
    if (selection && record.version <= selection.version) return fail("conflict");
    if (
      (selection
        ? !input.expected ||
          selection.version !== input.expected.version ||
          selection.digest !== input.expected.digest
        : input.expected !== null) ||
      policyCanonical(state) !== policyCanonical(input.expectedState)
    )
      return fail("conflict");
    if (kind === "provisional" ? selection !== null : selection === null) return fail("conflict");
    const records = parseTransferPolicyHistory([...previous, record]);
    parseTransferPolicy(records, identity(record), input.state);
    const duplicate = store.db
      .query<{ digest: string }, [string, number, string]>(
        "SELECT digest FROM run_policy_versions WHERE (run_id = ? AND version = ?) OR digest = ?",
      )
      .get(input.runId, record.version, record.recordId);
    if (duplicate) return fail("conflict");
    store.db
      .query(
        `INSERT INTO run_policy_versions (run_id, policy_id, version, kind, digest, record_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        record.policyId,
        record.version,
        record.kind,
        record.recordId,
        policyCanonical(record),
        Date.now(),
      );
    store.db
      .query("UPDATE runs SET state_json = ? WHERE id = ?")
      .run(policyCanonical(input.state), input.runId);
    store.db
      .query(
        `INSERT INTO run_policy_selections (run_id, policy_id, selected_version, selected_digest)
       VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET
       policy_id = excluded.policy_id, selected_version = excluded.selected_version,
       selected_digest = excluded.selected_digest`,
      )
      .run(input.runId, record.policyId, record.version, record.recordId);
    return pin;
  };
  // Bun's nested transaction uses a savepoint; Store.transaction alone joins its caller.
  return store.transaction(() => store.db.transaction(apply).immediate(), true);
}
export const recordProvisionalPolicy = (store: Store, input: PolicyTransition): PolicyPin =>
  transition(store, input, "provisional");
export const finalizePreparePolicy = (store: Store, input: PolicyTransition): PolicyPin =>
  transition(store, input, "prepared");
export const appendPolicySupplement = (store: Store, input: PolicyTransition): PolicyPin =>
  transition(store, input, "supplement");

export function exportPolicySelection(store: Store, runId: string) {
  return store.transaction(() => {
    const { selection, state } = current(store, runId);
    if (!selection) return fail("incomplete");
    const records = history(store, runId, selection);
    const record = records.at(-1);
    if (!record) return fail("corrupt");
    if (
      record.kind === "provisional" &&
      state &&
      typeof state === "object" &&
      Object.keys(transferPreparedPolicySchema.shape).some((key) => Object.hasOwn(state, key))
    )
      return fail("incomplete");
    parseTransferPolicy(records, identity(record), state);
    return { version: selection.version, digest: selection.digest, history: records };
  }, true);
}
export function requireReviewPolicy(store: Store, runId: string): TransferPolicyRecord {
  const record = exportPolicySelection(store, runId).history.at(-1);
  if (!record || !("effectiveReviewMode" in record) || record.effectiveReviewMode === undefined)
    return fail("incomplete");
  return record;
}
