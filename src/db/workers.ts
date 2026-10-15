import { createHash, createHmac, randomBytes } from "node:crypto";
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
    this.store.db
      .query("UPDATE workers SET state='revoked',token_hash=NULL,revoked_at=? WHERE name=?")
      .run(this.now(), name);
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
    this.store.db
      .query("UPDATE workers SET last_heartbeat_at=?,capabilities=? WHERE name=? AND state='approved'")
      .run(this.now(), JSON.stringify(c), w.name);
    return { cancelled: c.jobs };
  }
}
