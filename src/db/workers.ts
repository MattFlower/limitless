import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { ExecutionEvent, GateRequest } from "../gates/executor.ts";
import { redactGateData } from "../gates/output.ts";
import { loadOutputPrivacy, privateOutputData } from "../util/private-output.ts";
import { registerCredential } from "../util/proc.ts";
import { type Capabilities, Heartbeat, timing, type WorkerTiming } from "../workers/protocol.ts";
import type { Store } from "./store.ts";

export const tokenHash = (s: string) => createHash("sha256").update(s).digest("hex");
export class PairingLimitError extends Error {}
export interface WorkerRow {
  name: string;
  fingerprint: string;
  token_hash: string | null;
  state: "pending" | "approved" | "revoked";
  pairing_code: string;
  pairing_secret_hash: string;
  pairing_expires_at: number;
  last_heartbeat_at: number | null;
  capabilities: string | null;
}
export interface JobRow {
  id: string;
  run_id: string | null;
  request: string;
  state: "queued" | "leased" | "done" | "failed" | "cancelled";
  worker: string | null;
  attempt: number;
  lease_expires_at: number | null;
  result: string | null;
  failure_reason: string | null;
  excluded: string;
  events: string;
  created_at: number;
  updated_at: number;
}

/** All worker transitions are synchronous SQLite transactions; no observation crosses an await. */
export class WorkerStore {
  pairingKey?: string;
  readonly times: WorkerTiming;
  constructor(
    readonly store: Store,
    readonly releaseSha: string | undefined,
    times: Partial<WorkerTiming> = {},
    readonly now = Date.now,
  ) {
    this.times = { ...timing, ...times };
  }
  sanitize<T>(data: T): T {
    return privateOutputData(
      redactGateData(data),
      loadOutputPrivacy() ?? (() => "[withheld: private policy unavailable]"),
    );
  }
  pair(name: string, fingerprint: string) {
    const now = this.now();
    const existing = this.worker(name);
    if (
      existing &&
      (existing.state === "approved" || (existing.state === "pending" && existing.pairing_expires_at > now))
    )
      throw new Error("Worker name already paired or pending");
    const count =
      this.store.db
        .query<{ n: number }, [number]>(
          "SELECT count(*) n FROM workers WHERE state='pending' AND pairing_expires_at>?",
        )
        .get(now)?.n ?? 0;
    if (count >= 100) throw new PairingLimitError("Too many pending requests");
    const secret = randomBytes(32).toString("hex"),
      code = [...randomBytes(8)].map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    this.store.db
      .query(
        "INSERT OR REPLACE INTO workers (name,fingerprint,state,pairing_code,pairing_secret_hash,pairing_expires_at,created_at) VALUES (?,?,'pending',?,?,?,?)",
      )
      .run(name, fingerprint, code, tokenHash(secret), now + 600_000, now);
    return { code, secret, expiresAt: now + 600_000 };
  }
  // Reconstruct an issued token after a restart without persisting its plaintext.
  private issued(w: WorkerRow) {
    if (!this.pairingKey) throw new Error("Worker listener is disabled");
    const token = createHmac("sha256", this.pairingKey).update(w.pairing_secret_hash).digest("hex");
    registerCredential(`worker:${w.name}`, token);
    return token;
  }
  approve(code: string) {
    const w = this.store.db
      .query<WorkerRow, [string]>("SELECT * FROM workers WHERE pairing_code=?")
      .get(code);
    if (w?.state !== "pending" || w.pairing_expires_at <= this.now())
      throw new Error("No pending pairing with that code");
    this.store.db
      .query(
        "UPDATE workers SET state='approved',token_hash=?,approved_at=? WHERE name=? AND state='pending'",
      )
      .run(tokenHash(this.issued(w)), this.now(), w.name);
    return { name: w.name, state: "approved" };
  }
  claim(secret: string) {
    const w = this.store.db
      .query<WorkerRow, [string]>("SELECT * FROM workers WHERE pairing_secret_hash=?")
      .get(tokenHash(secret));
    if (!w || w.state === "revoked" || w.pairing_expires_at <= this.now())
      throw new Error("Pairing expired or revoked");
    return w.state === "approved" ? { token: this.issued(w) } : { pending: true };
  }
  worker(name: string) {
    return this.store.db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE name=?").get(name);
  }
  authenticate(token: string) {
    const worker = this.store.db
      .query<WorkerRow, [string]>("SELECT * FROM workers WHERE state='approved' AND token_hash=?")
      .get(tokenHash(token));
    if (worker) registerCredential(`worker:${worker.name}`, token);
    return worker;
  }
  revoke(name: string) {
    this.store.db.transaction(() => {
      this.store.db
        .query("UPDATE workers SET state='revoked',token_hash=NULL,revoked_at=? WHERE name=?")
        .run(this.now(), name);
      for (const job of this.jobs("state='leased' AND worker=?", name)) this.fail(job.id, "Worker revoked");
    })();
  }
  available(w: WorkerRow) {
    const c = w.capabilities ? Heartbeat.parse(JSON.parse(w.capabilities)) : null;
    return (
      w.state === "approved" &&
      w.last_heartbeat_at !== null &&
      this.now() - w.last_heartbeat_at <= this.times.fresh &&
      !!this.releaseSha &&
      c?.releaseSha === this.releaseSha &&
      c.bunVersion === Bun.version &&
      c.freeSlots > 0
    );
  }
  list() {
    return this.store.db
      .query<WorkerRow, []>("SELECT * FROM workers ORDER BY name")
      .all()
      .map((w) => {
        const c: Capabilities | null = w.capabilities ? JSON.parse(w.capabilities) : null;
        return this.sanitize({
          name: w.name,
          fingerprint: w.fingerprint,
          code: w.state === "pending" ? w.pairing_code : undefined,
          lastHeartbeatAt: w.last_heartbeat_at,
          capabilities: c,
          state:
            w.state !== "approved"
              ? w.state
              : c && (c.releaseSha !== this.releaseSha || c.bunVersion !== Bun.version)
                ? "needs update"
                : this.available(w)
                  ? "available"
                  : "offline",
        });
      });
  }
  heartbeat(w: WorkerRow, c: Capabilities) {
    this.sweep();
    this.store.db
      .query("UPDATE workers SET last_heartbeat_at=?,capabilities=? WHERE name=? AND state='approved'")
      .run(this.now(), JSON.stringify(c), w.name);
    const cancelled: string[] = [];
    for (const id of c.jobs) {
      const j = this.job(id);
      if (j?.state !== "leased" || j.worker !== w.name) cancelled.push(id);
      else
        this.store.db
          .query(
            "UPDATE gate_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND state='leased' AND worker=?",
          )
          .run(this.now() + this.times.lease, this.now(), id, w.name);
    }
    return { cancelled };
  }
  jobs(where: string, ...args: string[]) {
    return this.store.db.query<JobRow, string[]>(`SELECT * FROM gate_jobs WHERE ${where}`).all(...args);
  }
  job(id: string) {
    return this.store.db.query<JobRow, [string]>("SELECT * FROM gate_jobs WHERE id=?").get(id);
  }
  enqueue(req: GateRequest) {
    const id = randomUUID(),
      now = this.now();
    this.store.db
      .query(
        "INSERT INTO gate_jobs (id,run_id,request,state,created_at,updated_at) VALUES (?,?,?,'queued',?,?)",
      )
      .run(id, req.runId ?? null, JSON.stringify(req), now, now);
    return id;
  }
  lease(name: string) {
    return this.store.db.transaction(() => {
      this.sweep();
      const w = this.worker(name);
      if (!w || !this.available(w)) return null;
      const c: Capabilities = JSON.parse(w.capabilities ?? "{}");
      const unreported = this.jobs("state='leased' AND worker=?", name).filter((j) => !c.jobs.includes(j.id));
      if (unreported.length >= c.freeSlots) return null;
      const j = this.jobs("state='queued'").find(
        (job) => !(JSON.parse(job.excluded) as string[]).includes(name),
      );
      if (!j) return null;
      this.store.db
        .query(
          "UPDATE gate_jobs SET state='leased',worker=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='queued'",
        )
        .run(name, this.now() + this.times.lease, this.now(), j.id);
      return this.job(j.id);
    })();
  }
  holds(id: string, name: string) {
    this.sweep();
    const j = this.job(id);
    return j?.state === "leased" && j.worker === name ? j : null;
  }
  event(id: string, event: ExecutionEvent) {
    const j = this.job(id);
    if (!j || !["queued", "leased", "failed"].includes(j.state)) return;
    const events: ExecutionEvent[] = JSON.parse(j.events);
    events.push(this.sanitize(event));
    this.store.db.query("UPDATE gate_jobs SET events=? WHERE id=?").run(JSON.stringify(events), id);
  }
  fail(id: string, reason: string) {
    const j = this.job(id);
    if (!j || !["queued", "leased"].includes(j.state)) return;
    this.event(id, { type: "status", text: `LAN infrastructure failure: ${reason}` });
    if (j.run_id)
      this.store.addEvent({
        runId: j.run_id,
        type: "gate",
        level: "warn",
        message: `LAN infrastructure failure: ${reason}`,
      });
    const excluded: string[] = JSON.parse(j.excluded);
    if (j.worker) excluded.push(j.worker);
    this.store.db
      .query(
        "UPDATE gate_jobs SET state=?,attempt=?,worker=NULL,lease_expires_at=NULL,failure_reason=?,excluded=?,updated_at=? WHERE id=? AND state IN ('queued','leased')",
      )
      .run(
        j.attempt < 2 ? "queued" : "failed",
        Math.min(2, j.attempt + 1),
        reason,
        JSON.stringify(excluded),
        this.now(),
        id,
      );
  }
  sweep() {
    const now = this.now();
    for (const j of this.jobs("state IN ('queued','leased')")) {
      if (j.state === "queued" && now - j.updated_at >= this.times.pickup)
        this.fail(j.id, "No worker picked up job");
      else if (j.state === "leased") {
        const w = j.worker ? this.worker(j.worker) : null;
        if (w?.state !== "approved") this.fail(j.id, "Worker disconnected or revoked");
        else if ((j.lease_expires_at ?? 0) <= now) this.fail(j.id, "Lease expired");
        else if (now - (w.last_heartbeat_at ?? 0) > this.times.fresh) this.fail(j.id, "Worker disconnected");
      }
    }
  }
  cancel(id: string) {
    this.store.db
      .query(
        "UPDATE gate_jobs SET state='cancelled',updated_at=? WHERE id=? AND state IN ('queued','leased','failed')",
      )
      .run(this.now(), id);
  }
  complete(id: string, run: unknown, local = false) {
    this.store.db
      .query("UPDATE gate_jobs SET state='done',result=?,updated_at=? WHERE id=? AND state=?")
      .run(JSON.stringify(this.sanitize(run)), this.now(), id, local ? "failed" : "leased");
  }
}
