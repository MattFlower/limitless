import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { RunTransferError } from "../pipeline/run-transfer-errors.ts";
import { policyCanonical, type TransferPolicyRecord } from "../pipeline/run-transfer-policy-schema.ts";
import { mapPayloadReferences } from "../pipeline/run-transfer-references.ts";
import type { RunPayloadV1 } from "../pipeline/run-transfer-schema.ts";

type Payload = RunPayloadV1;
type Kind = "stages" | "invocations" | "questions";
export type ProjectionIds = Record<Kind, Map<number, number>>;
type Semantics = Pick<Payload, "header" | "state" | "jobs" | "commits" | "followUp"> & {
  policyIdentity: Payload["policy"]["identity"];
  runExtras: Pick<Payload["run"], "repoSlug" | "flow" | "githubWait">;
  runFields: string[];
};
const keys = (s: string) => s.split(" ");
const runKeys = keys(
  "id title prompt source sourceRef requestedBy profile resolvedProfile taskClass complexity status stage baseBranch deliveryBranch baseSha branch headSha prUrl merged mergedBy mergedAt costUsd costEquivUsd tokensIn tokensOut error priority createdAt startedAt finishedAt githubWebhookVerified dependsOn prClosedUnmerged resolution titleProvenance noBaselineCache models allow",
);
const columns = {
  stages: keys("runId name round status summary startedAt finishedAt"),
  invocations: keys(
    "runId stageId role harness provider model modelId effort status costUsd costEquivUsd inputTokens outputTokens cacheReadTokens cacheWriteTokens numTurns waitMs fast fastModeState fastModeDisabledReason error startedAt finishedAt sessionId",
  ),
  questions: keys("runId question answer askedAt answeredAt answeredBy"),
};
const jsonKeys = new Set(keys("sourceRef dependsOn resolution models allow"));
const boolKeys = new Set(keys("merged githubWebhookVerified prClosedUnmerged noBaselineCache fast"));
const aliases: Record<string, string> = { models: "models_json", allow: "audit_allow" };
const jsonDefaults: Record<string, string> = { models: "{}", allow: "[]" };
const column = (key: string) => aliases[key] ?? key.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`);
function insert(db: Database, table: string, fields: string[], row: object): number {
  const values = fields.map((key): SQLQueryBindings => {
    const value: unknown = Reflect.get(row, key);
    if (boolKeys.has(key)) return value ? 1 : 0;
    if (jsonKeys.has(key)) return value == null ? (jsonDefaults[key] ?? null) : JSON.stringify(value);
    return (value ?? null) as SQLQueryBindings;
  });
  const statement = db.query(
    `INSERT INTO ${table} (${fields.map(column).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
  );
  return Number(statement.run(...values).lastInsertRowid);
}
function rows<T>(db: Database, table: string, fields: string[], runId: string): T[] {
  return db
    .query<Record<string, unknown>, [string]>(
      `SELECT ${fields.map((k) => `${column(k)} AS ${k}`).join(", ")} FROM ${table} WHERE ${table === "runs" ? "id" : "run_id"} = ?`,
    )
    .all(runId)
    .map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            boolKeys.has(key)
              ? value === 1
              : jsonKeys.has(key) && typeof value === "string"
                ? JSON.parse(value)
                : value,
          ]),
        ) as T,
    );
}
const requireId = (ids: Map<number, number>, id: number): number => {
  const found = ids.get(id);
  if (found === undefined) throw new RunTransferError("corrupt");
  return found;
};
export function readProjectionIds(db: Database, runId: string): ProjectionIds {
  const ids: ProjectionIds = { stages: new Map(), invocations: new Map(), questions: new Map() };
  for (const row of db
    .query<{ kind: Kind; ordinal: number; local_id: number }, [string]>(
      "SELECT kind, ordinal, local_id FROM run_projection_ids WHERE run_id = ? ORDER BY ordinal",
    )
    .all(runId))
    ids[row.kind].set(row.ordinal, row.local_id);
  return ids;
}
// These primitives require exclusive ownership of an OFFLINE database. No daemon caller exists.
// The caller owns commit/rollback; even a late failure must escape its enclosing transaction.
export function writeOfflineProjection(db: Database, payload: Payload): ProjectionIds {
  if (!db.inTransaction) throw new Error("Offline projection requires an enclosing transaction");
  if (db.query("SELECT id FROM runs WHERE id = ?").get(payload.run.id))
    throw new RunTransferError("conflict");
  // Existing SQL triggers publish questions and blocked runs; silence only this offline write.
  db.exec(
    "CREATE TEMP TRIGGER offline_projection_feed BEFORE INSERT ON main.feed BEGIN SELECT RAISE(IGNORE); END",
  );
  try {
    const slug = payload.run.repoSlug.toLowerCase();
    let repo = db.query<{ id: string }, [string]>("SELECT id FROM repos WHERE lower(slug) = ?").get(slug);
    if (!repo) {
      repo = { id: randomUUID() };
      insert(db, "repos", keys("id slug kind defaultBranch mergePolicy createdAt"), {
        ...repo,
        slug,
        kind: "github",
        defaultBranch: "main",
        mergePolicy: "none",
        createdAt: payload.run.createdAt,
      });
    }
    insert(db, "runs", [...runKeys, "repoId"], { ...payload.run, repoId: repo.id });
    const ids: ProjectionIds = { stages: new Map(), invocations: new Map(), questions: new Map() };
    const remember = db.query(
      "INSERT INTO run_projection_ids (run_id, kind, ordinal, local_id) VALUES (?, ?, ?, ?)",
    );
    for (const kind of ["stages", "invocations", "questions"] as const) {
      for (const row of payload[kind]) {
        const local = insert(
          db,
          kind,
          columns[kind],
          kind === "invocations" && "stageOrdinal" in row
            ? {
                ...row,
                stageId: row.stageOrdinal === null ? null : requireId(ids.stages, row.stageOrdinal),
                sessionId: null,
              }
            : row,
        );
        ids[kind].set(row.ordinal, local);
        remember.run(payload.run.id, kind, row.ordinal, local);
      }
    }
    const p = mapPayloadReferences(
      payload,
      (n) => requireId(ids.stages, n),
      (n) => requireId(ids.invocations, n),
    );
    for (const record of p.policy.history)
      db.query(`INSERT INTO run_policy_versions (run_id, policy_id, version, kind, digest, record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        p.run.id,
        record.policyId,
        record.version,
        record.kind,
        record.recordId,
        policyCanonical(record),
        p.run.createdAt,
      );
    const selected = p.policy.history.at(-1);
    if (!selected) throw new RunTransferError("incomplete");
    db.query(`INSERT INTO run_policy_selections (run_id, policy_id, selected_version, selected_digest)
    VALUES (?, ?, ?, ?)`).run(p.run.id, selected.policyId, selected.version, selected.recordId);
    const semantic: Semantics = {
      header: p.header,
      state: p.state,
      jobs: p.jobs,
      commits: p.commits,
      ...(p.followUp ? { followUp: p.followUp } : {}),
      policyIdentity: p.policy.identity,
      runExtras: { repoSlug: p.run.repoSlug, flow: p.run.flow, githubWait: p.run.githubWait },
      runFields: Object.keys(p.run),
    };
    db.query("INSERT INTO run_projections (run_id, semantic_json) VALUES (?, ?)").run(
      p.run.id,
      JSON.stringify(semantic),
    );
    return ids;
  } finally {
    db.exec("DROP TRIGGER temp.offline_projection_feed");
  }
}
// References here are destination IDs; execution identity stays portable, never an executable handle.
export function readProjectionSemantics(db: Database, runId: string): Semantics | null {
  const row = db
    .query<{ semantic_json: string }, [string]>("SELECT semantic_json FROM run_projections WHERE run_id = ?")
    .get(runId);
  return row ? (JSON.parse(row.semantic_json) as Semantics) : null;
}
export function readOfflineProjection(db: Database, runId: string): Payload | null {
  const semantic = readProjectionSemantics(db, runId);
  if (!semantic) return null;
  const ids = readProjectionIds(db, runId);
  const inverse = (kind: Kind) => new Map([...ids[kind]].map(([a, b]) => [b, a]));
  const stage = inverse("stages"),
    invocation = inverse("invocations");
  const read = <K extends Kind>(kind: K): Payload[K] => {
    const back = inverse(kind);
    return rows<Record<string, unknown>>(db, kind, ["id", ...columns[kind]], runId)
      .map(({ id, stageId, sessionId: _session, ...row }) => ({
        ...row,
        ordinal: requireId(back, id as number),
        ...(kind === "invocations" ? { stageOrdinal: stageId } : {}),
      }))
      .sort((a, b) => a.ordinal - b.ordinal) as Payload[K];
  };
  const run = rows<Payload["run"]>(db, "runs", runKeys, runId)[0];
  if (!run) throw new RunTransferError("corrupt");
  for (const key of Object.keys(run)) if (!semantic.runFields.includes(key)) Reflect.deleteProperty(run, key);
  const history = db
    .query<{ record_json: string }, [string]>(`SELECT v.record_json FROM run_policy_versions v
    JOIN run_policy_selections s ON s.run_id = v.run_id WHERE v.run_id = ? AND v.version <= s.selected_version ORDER BY v.version`)
    .all(runId)
    .map((row) => JSON.parse(row.record_json) as TransferPolicyRecord);
  return mapPayloadReferences(
    {
      header: semantic.header,
      commits: semantic.commits,
      state: semantic.state,
      jobs: semantic.jobs,
      ...(semantic.followUp ? { followUp: semantic.followUp } : {}),
      run: { ...run, ...semantic.runExtras },
      stages: read("stages"),
      invocations: read("invocations"),
      questions: read("questions"),
      policy: { identity: semantic.policyIdentity, history },
    },
    (n) => requireId(stage, n),
    (n) => requireId(invocation, n),
  );
}
