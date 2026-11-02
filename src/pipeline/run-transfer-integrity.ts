import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readOfflineProjection, readProjectionSemantics } from "../db/portable-projection.ts";
import { formatManifest, manifestDigest, type PortableManifest, parseManifest } from "./portable.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import { encodeTransferJson } from "./run-transfer-json.ts";
import { policyCanonical } from "./run-transfer-policy-schema.ts";
import type { RunPayloadV1 } from "./run-transfer-schema.ts";

export const transferHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const transferConflict = (): never => {
  throw new RunTransferError("conflict");
};
export function receiptManifest(text: string, digest: string, runId: string): PortableManifest {
  const m = parseManifest(text);
  if (
    typeof m !== "object" ||
    !("runId" in m) ||
    m.runId !== runId ||
    formatManifest(m) !== text ||
    manifestDigest(m) !== digest
  )
    return transferConflict();
  return m;
}
export function receiptDescriptors({ blobs }: PortableManifest) {
  return [blobs.state, ...blobs.artifacts, ...blobs.objects];
}
export function verifyReceiptPayload(m: PortableManifest, blobs: ReadonlyMap<string, Uint8Array>) {
  const refs = receiptDescriptors(m);
  if (new Set(refs.map((r) => r.key)).size !== blobs.size) return transferConflict();
  for (const r of refs) {
    const bytes = blobs.get(r.key);
    if (!bytes || bytes.length !== r.size || transferHash(bytes) !== r.digest) return transferConflict();
  }
  const state = blobs.get(m.blobs.state.key);
  if (!state) return transferConflict();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(state)) as RunPayloadV1;
}
export function verifyProjectionIntegrity(db: Database, p: RunPayloadV1): void {
  const id = p.run.id;
  for (const [table, key, columns] of [
    ["runs", "id", ["merged", "github_webhook_verified", "pr_closed_unmerged", "no_baseline_cache"]],
    ["invocations", "run_id", ["fast"]],
  ] as const) {
    const invalid = columns.map((c) => `typeof(${c}) != 'integer' OR ${c} NOT IN (0, 1)`).join(" OR ");
    if (db.query(`SELECT 1 FROM ${table} WHERE ${key} = ? AND (${invalid})`).get(id)) transferConflict();
  }
  // The private reader drops absent optional fields; check their stored defaults first.
  const stored = db
    .query<Record<string, unknown>, [string]>(
      "SELECT no_baseline_cache AS noBaselineCache, models_json AS models, audit_allow AS allow, title_provenance AS titleProvenance FROM runs WHERE id = ?",
    )
    .get(id);
  const defaults = { noBaselineCache: 0, models: "{}", allow: "[]", titleProvenance: null };
  for (const [key, value] of Object.entries(defaults))
    if (!Object.hasOwn(p.run, key) && stored?.[key] !== value) transferConflict();
  const byOrdinal = <T extends { ordinal: number }>(rows: T[]) =>
    rows.toSorted((a, b) => a.ordinal - b.ordinal);
  const ordered = {
    ...p,
    stages: byOrdinal(p.stages),
    invocations: byOrdinal(p.invocations),
    questions: byOrdinal(p.questions),
  };
  if (policyCanonical(readOfflineProjection(db, id)) !== policyCanonical(ordered)) transferConflict();
  const semantic = readProjectionSemantics(db, id);
  const fields = ["header", "state", "jobs", "commits", "policyIdentity", "runExtras", "runFields"];
  if (p.followUp) fields.push("followUp");
  if (
    !semantic ||
    policyCanonical(Object.keys(semantic).sort()) !== policyCanonical(fields.sort()) ||
    policyCanonical(semantic.runFields.toSorted()) !== policyCanonical(Object.keys(p.run).sort())
  )
    transferConflict();
  for (const kind of ["stages", "invocations", "questions"] as const) {
    const mapped = db
      .query<{ ordinal: number; local_id: number }, [string, string]>(
        "SELECT ordinal, local_id FROM run_projection_ids WHERE run_id = ? AND kind = ? ORDER BY ordinal",
      )
      .all(id, kind);
    const rows = db.query<{ id: number }, [string]>(`SELECT id FROM ${kind} WHERE run_id = ?`).all(id);
    if (
      mapped.length !== p[kind].length ||
      rows.length !== mapped.length ||
      mapped.some((r, i) => r.ordinal !== ordered[kind][i]?.ordinal || !rows.some((v) => v.id === r.local_id))
    )
      transferConflict();
  }
  const versions = db
    .query(
      "SELECT policy_id, version, kind, digest, record_json, created_at FROM run_policy_versions WHERE run_id = ? ORDER BY version",
    )
    .all(id);
  const expected = p.policy.history.map((r) => ({
    policy_id: r.policyId,
    version: r.version,
    kind: r.kind,
    digest: r.recordId,
    record_json: policyCanonical(r),
    created_at: p.run.createdAt,
  }));
  const last = p.policy.history.at(-1);
  const selection = db
    .query("SELECT policy_id, selected_version, selected_digest FROM run_policy_selections WHERE run_id = ?")
    .get(id);
  if (
    !last ||
    policyCanonical(versions) !== policyCanonical(expected) ||
    policyCanonical(selection) !==
      policyCanonical({
        policy_id: last.policyId,
        selected_version: last.version,
        selected_digest: last.recordId,
      })
  )
    transferConflict();
  const run = db
    .query<{ slug: string; state_json: string | null }, [string]>(
      "SELECT repos.slug, runs.state_json FROM runs JOIN repos ON repos.id = runs.repo_id WHERE runs.id = ?",
    )
    .get(id);
  if (
    !run ||
    run.slug.toLowerCase() !== p.run.repoSlug.toLowerCase() ||
    run.state_json !== null ||
    db.query("SELECT id FROM invocations WHERE run_id = ? AND session_id IS NOT NULL").get(id)
  )
    transferConflict();
}
export const payloadFingerprint = (p: RunPayloadV1): string => transferHash(encodeTransferJson(p));
