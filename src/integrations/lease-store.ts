import type { SQLQueryBindings } from "bun:sqlite";
import { repoName } from "../config.ts";
import type { Store } from "../db/store.ts";
import { type ClaimClient, type ClaimRecord, formatRecord, parseRecord } from "./claim-ref.ts";

export function canonicalRepo(slug: string): string {
  const repo = slug.toLowerCase();
  if (!repoName.test(repo)) throw new Error("Invalid repository slug");
  return repo;
}
export type Confirmed = { generation: number; tip: string; state: "held" | "released" | "lost" };
export type Intent = { op: "acquire" | "renew" | "update" | "release" } & {
  before: string;
  record: ClaimRecord;
  commit: string | null;
};
export type LeaseRow = { repo: string; ref: string; runId: string } & {
  confirmed: Confirmed | null;
  intent: Intent | null;
};
type Stored = Omit<LeaseRow, "confirmed" | "intent"> & { confirmed: string | null; intent: string | null };
const select = `SELECT repo,ref,run_id AS runId,
  CASE WHEN confirmed_generation IS NOT NULL THEN json_object('generation',confirmed_generation,'tip',confirmed_tip,'state',confirmed_state) END AS confirmed,
  CASE WHEN intent_op IS NOT NULL THEN json_object('op',intent_op,'before',intent_before,'record',intent_record,'commit',intent_commit) END AS intent FROM claim_leases`;
const clear = "intent_op=NULL,intent_before=NULL,intent_record=NULL,intent_commit=NULL";
function decode(r: Stored): LeaseRow {
  const confirmed: Confirmed | null = r.confirmed === null ? null : JSON.parse(r.confirmed);
  const intent: (Omit<Intent, "record"> & { record: string }) | null =
    r.intent === null ? null : JSON.parse(r.intent);
  const record = intent && parseRecord(intent.record, r.ref);
  if (record === "malformed") throw new Error("Invalid stored lease intent");
  return { ...r, confirmed, intent: intent && record ? { ...intent, record } : null };
}
export function leaseMethods(store: Store) {
  function rows(where: string, values: string[] = []): LeaseRow[] {
    const raw = store.db.query<Stored, string[]>(`${select} ${where}`).all(...values);
    return raw.map(decode);
  }
  const read = (repo: string, ref: string) => rows("WHERE repo=? AND ref=?", [repo, ref])[0] ?? null;
  function tx<A extends unknown[], T>(fn: (repo: string, ref: string, ...args: A) => T) {
    return (repo: string, ref: string, ...args: A): T =>
      store.db.transaction(() => fn(canonicalRepo(repo), ref, ...args)).immediate();
  }
  function update(repo: string, ref: string, sets: string, values: SQLQueryBindings[] = []): void {
    store.db
      .query(`UPDATE claim_leases SET ${sets},updated_at=? WHERE repo=? AND ref=?`)
      .run(...values, Date.now(), repo, ref);
  }
  return {
    leaseRow: tx(read),
    beginLeaseIntent: tx((repo, ref, runId: string, intent: Intent) => {
      const row = read(repo, ref);
      if (row && (row.intent || row.runId !== runId))
        throw new Error("Lease has a pending intent or belongs to another run");
      const record = formatRecord(intent.record);
      if (!/^[0-9a-f]{40}$/.test(intent.before) || parseRecord(record, ref) === "malformed")
        throw new Error("Invalid lease intent");
      store.db
        .query(
          "INSERT INTO claim_leases (repo,ref,run_id,updated_at) VALUES (?,?,?,?) ON CONFLICT (repo,ref) DO NOTHING",
        )
        .run(repo, ref, runId, Date.now());
      const { op, before, commit } = intent;
      update(repo, ref, "intent_op=?,intent_before=?,intent_record=?,intent_commit=?", [
        op,
        before,
        record,
        commit,
      ]);
    }),
    setLeaseIntentCommit: tx((repo, ref, sha: string) => {
      if (!read(repo, ref)?.intent) throw new Error("No pending lease intent");
      update(repo, ref, "intent_commit=?", [sha]);
    }),
    confirmLease: tx((repo, ref, c: Confirmed, clearIntent = true) => {
      const sets = `confirmed_generation=?,confirmed_tip=?,confirmed_state=?${clearIntent ? `,${clear}` : ""}`;
      update(repo, ref, sets, [c.generation, c.tip, c.state]);
    }),
    dropLeaseIntent: tx((repo, ref) => update(repo, ref, clear)),
    markLeaseLost: tx((repo, ref) => {
      const sets = `confirmed_state=CASE WHEN confirmed_generation IS NULL THEN NULL ELSE 'lost' END,${clear}`;
      update(repo, ref, sets);
    }),
    forgetLease: tx((repo, ref) => {
      const row = read(repo, ref);
      if (!row || row.intent || row.confirmed?.state === "held") throw new Error("Lease cannot be forgotten");
      store.db.query("DELETE FROM claim_leases WHERE repo=? AND ref=?").run(repo, ref);
    }),
    leaseRowsWithIntent: () =>
      store.db.transaction(() => rows("WHERE intent_op IS NOT NULL ORDER BY repo,ref")).immediate(),
  };
}
type Deps = { client: ClaimClient; store: Store; signal?: AbortSignal };
type Settlement = "applied" | "replayed" | "dropped" | "superseded" | "pending";
export async function reconcileLeaseIntent(
  { client, store, signal }: Deps,
  repo: string,
  ref: string,
): Promise<Settlement | "none"> {
  repo = canonicalRepo(repo);
  signal?.throwIfAborted();
  const row = store.leaseRow(repo, ref);
  if (!row?.intent) return "none";
  const { intent, confirmed } = row;
  const { generation, state } = intent.record;
  const confirm = (tip: string) => store.confirmLease(repo, ref, { generation, tip, state });
  const read = await client.read(repo, ref, signal);
  signal?.throwIfAborted();
  if (read.kind === "unconfirmed") return "pending";
  if (read.kind === "absent" && intent.before !== "0".repeat(40)) return "pending";
  let tip = read.kind === "tip" ? read.tip : null;
  if (tip?.record === "malformed") return "pending";
  if (read.kind === "absent" || read.tip.sha === intent.before) {
    if (intent.op !== "release" || read.kind !== "tip" || intent.before !== confirmed?.tip) {
      store.dropLeaseIntent(repo, ref);
      return "dropped";
    }
    const result = await client.write(repo, ref, read.tip, intent.record, {
      signal,
      onCommit: (sha) => store.setLeaseIntentCommit(repo, ref, sha),
    });
    signal?.throwIfAborted();
    if (result.kind === "applied") {
      confirm(result.tip.sha);
      return "replayed";
    }
    if (result.kind !== "moved") return "pending";
    tip = result.tip;
  }
  const record = tip?.record;
  if (!tip || tip.sha === intent.before || record === "malformed") return "pending";
  if (tip.sha === intent.commit || (record && formatRecord(record) === formatRecord(intent.record))) {
    confirm(tip.sha);
    return "applied";
  }
  const previous = confirmed?.generation ?? generation;
  if (
    record &&
    (record.generation > previous ||
      (record.generation === previous &&
        (record.holder !== intent.record.holder || record.run !== intent.record.run)))
  ) {
    store.markLeaseLost(repo, ref);
    return "superseded";
  }
  return "pending";
}
type Recovery = Record<Settlement, string[]>;
export async function recoverLeases(deps: Deps): Promise<Recovery> {
  const results: Recovery = { applied: [], replayed: [], dropped: [], superseded: [], pending: [] };
  deps.signal?.throwIfAborted();
  for (const row of deps.store.leaseRowsWithIntent()) {
    const result = await reconcileLeaseIntent(deps, row.repo, row.ref);
    if (result !== "none") results[result].push(row.ref);
  }
  return results;
}
