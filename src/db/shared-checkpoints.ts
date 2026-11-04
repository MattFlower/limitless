import type { SQLQueryBindings } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Store } from "./store.ts";
export type CheckpointEntry = {
  generation: number;
  sequence: number;
  pointer: string;
  manifest: string;
  commits: string[];
};
export type CheckpointRecord = {
  runId: string;
  committed: CheckpointEntry | null;
  pending: CheckpointEntry | null;
  terminal: string | null;
  indexed: boolean;
  updatedAt: number;
};
type Stored = Omit<CheckpointRecord, "committed" | "pending" | "indexed"> & {
  committed: string | null;
  pending: string | null;
  indexed: number;
};
const fields = ["generation", "sequence", "pointer", "manifest", "commits"];
const assignments = (prefix: string, value: string) => fields.map((f) => `${prefix}_${f}=${value}`).join(",");
const clear = assignments("pending", "NULL");
const entry = (prefix: string) =>
  `CASE WHEN ${prefix}_pointer IS NOT NULL THEN json_object(${fields.map((f) => `'${f}',${f === "commits" ? `json(${prefix}_${f})` : `${prefix}_${f}`}`).join(",")}) END AS ${prefix}`;
export function checkpointMethods(store: Store) {
  const pending = new Map<string, Promise<unknown>>();
  const read = (runId: string): CheckpointRecord | null => {
    const r = store.db
      .query<Stored, [string]>(
        `SELECT run_id AS runId,${entry("committed")},${entry("pending")},terminal_json AS terminal,indexed,updated_at AS updatedAt FROM shared_checkpoints WHERE run_id=?`,
      )
      .get(runId);
    if (!r) return null;
    return {
      ...r,
      committed: r.committed === null ? null : JSON.parse(r.committed),
      pending: r.pending === null ? null : JSON.parse(r.pending),
      indexed: !!r.indexed,
    };
  };
  const tx =
    <A extends unknown[], T>(fn: (runId: string, ...args: A) => T) =>
    (runId: string, ...args: A): T =>
      store.db.transaction(() => fn(runId, ...args)).immediate();
  const update = (runId: string, sets: string, values: SQLQueryBindings[] = []) =>
    store.db
      .query(`UPDATE shared_checkpoints SET ${sets},updated_at=? WHERE run_id=?`)
      .run(...values, Date.now(), runId);
  const ensure = (runId: string) =>
    store.db
      .query("INSERT OR IGNORE INTO shared_checkpoints (run_id,updated_at) VALUES (?,?)")
      .run(runId, Date.now());
  return {
    // Publishers wrap journal/publish/confirm together; settleCheckpoint takes this same, non-reentrant scope.
    async coordinateCheckpoint<T>(runId: string, fn: () => Promise<T>): Promise<T> {
      const work = (pending.get(runId) ?? Promise.resolve()).catch(() => {}).then(fn);
      pending.set(runId, work);
      return work.finally(() => {
        if (pending.get(runId) === work) pending.delete(runId);
      });
    },
    checkpointRecord: tx(read),
    journalCheckpoint: tx((runId, e: CheckpointEntry) => {
      if (read(runId)?.pending) throw new Error("Checkpoint already pending");
      ensure(runId);
      update(runId, assignments("pending", "?"), [
        e.generation,
        e.sequence,
        e.pointer,
        e.manifest,
        JSON.stringify([...e.commits].sort()),
      ]);
    }),
    confirmCheckpoint: tx((runId, pointer: string, expected: CheckpointRecord | null) => {
      if (expected?.pending?.pointer !== pointer || !isDeepStrictEqual(read(runId), expected)) return false;
      update(runId, `${fields.map((f) => `committed_${f}=pending_${f}`).join(",")},${clear}`);
      return true;
    }),
    dropPendingCheckpoint: tx((runId, expected: CheckpointRecord | null) => {
      if (!expected?.pending || !isDeepStrictEqual(read(runId), expected)) return false;
      update(runId, clear);
      return true;
    }),
    markRunIndexed: tx((runId) => {
      ensure(runId);
      update(runId, "indexed=1");
    }),
    setTerminalIntent: tx((runId, json: string) => {
      ensure(runId);
      update(runId, "terminal_json=?", [json]);
    }),
    clearTerminalIntent: tx((runId) => update(runId, "terminal_json=NULL")),
  };
}
