import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Role } from "../core/types.ts";
import type { ExecutionEvent, GateRequest } from "../gates/executor.ts";
import { redactGateData } from "../gates/output.ts";
import type { GateRun } from "../gates/run.ts";
import type { AgentFullSuite, SlottedCommands } from "../harness/slotted-config.ts";
import type { AgentSpec } from "../harness/types.ts";
import { loadOutputPrivacy, privateOutputData } from "../util/private-output.ts";
import {
  processBirthSync,
  recoverProcessCleanups,
  redactCredentialData,
  registerCredential,
} from "../util/proc.ts";
import {
  AgentCapabilities,
  type Capabilities,
  Claim,
  Heartbeat,
  pairingCode,
  timing,
  type WorkerTiming,
} from "../workers/protocol.ts";
import { attemptBudget, credentialBearing, credentialInText } from "../workers/validation.ts";
import type { Store } from "./store.ts";

export const tokenHash = (s: string) => createHash("sha256").update(s).digest("hex");
export class PairingLimitError extends Error {}
export interface WorkerRun {
  runId: string;
  title: string;
  agentJobs: number;
  gateJobs: number;
  workers: string[];
  lastAt: number;
}
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
  agent_capabilities: string | null;
  setup_warning: string | null;
}
export interface JobRow {
  in_place: number;
  stopped: number;
  id: string;
  run_id: string | null;
  request: string;
  state: "queued" | "leased" | "done" | "failed" | "cancelled";
  worker: string | null;
  attempt: number;
  lease_expires_at: number | null;
  attempt_deadline_at: number | null;
  result: string | null;
  failure_reason: string | null;
  setup_fallback: number;
  setup_order: number;
  excluded: string;
  events: string;
  created_at: number;
  updated_at: number;
}

/** Persisted session inputs; runtime callbacks and confinement are supplied by a later dispatcher. */
export interface AgentJobRequest
  extends Pick<AgentSpec, "prompt" | "target" | "timeoutMs">,
    Partial<
      Pick<
        AgentSpec,
        | "mode"
        | "systemAppend"
        | "jsonSchema"
        | "idleTimeoutMs"
        | "maxToolCalls"
        | "fast"
        | "privateSession"
        | "confineReads"
      >
    > {
  runId: string;
  invocationId: number;
  parentSha: string;
  baseSha?: string;
  role?: Role;
  branch?: string;
  slottedCommands?: SlottedCommands;
  agentFullSuite?: AgentFullSuite;
  commit?: {
    message: string;
    authorName: string;
    authorEmail: string;
    committerName: string;
    committerEmail: string;
  };
  repoUrl?: string;
  expectedRemoteSha?: string | null;
  privateStringsDigest?: string;
  discreet?: boolean;
  uiUrl?: string;
}
export interface AgentJobRow
  extends Omit<JobRow, "setup_fallback" | "setup_order" | "events" | "in_place" | "stopped"> {
  invocation_id: number;
  parent_sha: string;
  result_sha: string | null;
}

/** All worker transitions are synchronous SQLite transactions; no observation crosses an await. */
export class WorkerStore {
  resumedAt?: number | null;
  pairingKey?: string;
  readonly times: WorkerTiming;
  constructor(
    readonly store: Store,
    readonly releaseSha: string | undefined,
    times: Partial<WorkerTiming> = {},
    readonly now = Date.now,
    readonly agentSlots = 2,
  ) {
    this.times = { ...timing, ...times };
  }
  sanitize<T>(data: T): T {
    return privateOutputData(
      redactGateData(data),
      loadOutputPrivacy() ?? (() => "[withheld: private policy unavailable]"),
    );
  }
  pair(name: string, fingerprint: string, coordinator: string) {
    return this.store.db.transaction(() => {
      const now = this.now();
      this.store.db.query("DELETE FROM workers WHERE state='pending' AND pairing_expires_at<=?").run(now);
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
        nonce = randomBytes(32).toString("hex"),
        code = pairingCode(coordinator, fingerprint, nonce);
      registerCredential("LIMITLESS_WORKER_CLAIM_SECRET", secret);
      this.store.db
        .query(
          "INSERT OR REPLACE INTO workers (name,fingerprint,state,pairing_code,pairing_secret_hash,pairing_expires_at,created_at) VALUES (?,?,'pending',?,?,?,?)",
        )
        .run(name, fingerprint, code, tokenHash(secret), now + 600_000, now);
      return { code, secret, nonce, expiresAt: now + 600_000 };
    })();
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
    Claim.parse({ secret });
    const w = this.store.db
      .query<WorkerRow, [string]>("SELECT * FROM workers WHERE pairing_secret_hash=?")
      .get(tokenHash(secret));
    if (!w) throw new Error("Pairing expired or revoked");
    registerCredential("LIMITLESS_WORKER_CLAIM_SECRET", secret);
    if (w.state === "revoked" || w.pairing_expires_at <= this.now())
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
  available(w: WorkerRow, agent = false) {
    const c = w.capabilities ? Heartbeat.parse(JSON.parse(w.capabilities)) : null;
    return (
      w.state === "approved" &&
      w.last_heartbeat_at !== null &&
      this.now() - w.last_heartbeat_at <= this.times.fresh &&
      !!this.releaseSha &&
      c?.releaseSha === this.releaseSha &&
      c.bunVersion === Bun.version &&
      (agent || c.freeSlots > 0)
    );
  }
  private agentCapabilities(w: WorkerRow) {
    try {
      return AgentCapabilities.parse(JSON.parse(w.agent_capabilities ?? "null"));
    } catch {
      return { privateStrings: "unknown" as const, agents: undefined };
    }
  }
  list() {
    return this.store.db
      .query<WorkerRow, [number]>(
        "SELECT * FROM workers WHERE state!='pending' OR pairing_expires_at>? ORDER BY name",
      )
      .all(this.now())
      .map((w) => {
        const c: Capabilities | null = w.capabilities ? JSON.parse(w.capabilities) : null;
        const { agents, privateStrings } = this.agentCapabilities(w);
        const result = this.sanitize({
          name: w.name,
          fingerprint: w.fingerprint,
          code: w.state === "pending" ? w.pairing_code : undefined,
          lastHeartbeatAt: w.last_heartbeat_at,
          capabilities: c,
          agents,
          agentJobs: this.store.db
            .query<{ id: string; attempt: number; runId: string }, [string]>(
              "SELECT id,attempt,run_id AS runId FROM agent_jobs WHERE state='leased' AND worker=? ORDER BY id",
            )
            .all(w.name),
          setupWarning: c?.updateWarning ?? w.setup_warning ?? undefined,
          state:
            w.state !== "approved"
              ? w.state
              : c && (c.releaseSha !== this.releaseSha || c.bunVersion !== Bun.version)
                ? "needs update"
                : this.available(w)
                  ? "available"
                  : c?.freeSlots === 0 &&
                      this.releaseSha &&
                      w.last_heartbeat_at !== null &&
                      this.now() - w.last_heartbeat_at <= this.times.fresh
                    ? "busy"
                    : "offline",
        });
        return { ...result, privateStrings };
      });
  }
  runs(limit = 50): WorkerRun[] {
    limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    const rows = this.store.db
      .query<Omit<WorkerRun, "workers"> & { workers: string }, [number]>(`
        SELECT r.id AS runId,r.title,sum(j.agent) AS agentJobs,sum(j.gate) AS gateJobs,
          json_group_array(DISTINCT j.worker) AS workers,max(j.updated_at) AS lastAt
        FROM (
          SELECT run_id,worker,updated_at,1 AS agent,0 AS gate FROM agent_jobs
            WHERE state='done' AND worker IS NOT NULL
          UNION ALL
          SELECT run_id,worker,updated_at,0 AS agent,1 AS gate FROM gate_jobs
            WHERE state='done' AND worker IS NOT NULL AND setup_fallback=0
        ) j JOIN runs r ON r.id=j.run_id
        GROUP BY r.id ORDER BY lastAt DESC,r.id LIMIT ?
      `)
      .all(limit);
    return this.sanitize(rows.map((r) => ({ ...r, workers: (JSON.parse(r.workers) as string[]).sort() })));
  }
  heartbeat(w: WorkerRow, c: Capabilities, privateStrings: "match" | "differs" | "unknown" = "unknown") {
    const { agents, privateStringsDigest: _digest, ...legacy } = c;
    c = legacy;
    this.sweep();
    this.sweepAgentJobs();
    if (c.updateWarning !== undefined) c = { ...c, updateWarning: this.sanitize(c.updateWarning) };
    this.store.db
      .query(
        "UPDATE workers SET last_heartbeat_at=?,capabilities=?,agent_capabilities=? WHERE name=? AND state='approved'",
      )
      .run(this.now(), JSON.stringify(c), JSON.stringify({ agents, privateStrings }), w.name);
    const cancelled: string[] = [];
    for (const id of c.jobs) {
      const gate = this.job(id);
      const table = gate ? "gate_jobs" : "agent_jobs";
      const j = gate ?? this.agentJob(id);
      if (j?.state !== "leased" || j.worker !== w.name) cancelled.push(id);
      else
        this.store.db
          .query(
            `UPDATE ${table} SET lease_expires_at=?,updated_at=? WHERE id=? AND state='leased' AND worker=?`,
          )
          .run(Math.min(this.now() + this.times.lease, j.attempt_deadline_at ?? 0), this.now(), id, w.name);
    }
    return { cancelled, ...(this.releaseSha ? { releaseSha: this.releaseSha } : {}) };
  }
  jobs(where: string, ...args: string[]) {
    return this.store.db.query<JobRow, string[]>(`SELECT * FROM gate_jobs WHERE ${where}`).all(...args);
  }
  job(id: string) {
    return this.store.db.query<JobRow, [string]>("SELECT * FROM gate_jobs WHERE id=?").get(id);
  }
  enqueue(req: GateRequest, id: string = randomUUID(), inplace = false) {
    const now = this.now();
    this.store.db
      .query(
        "INSERT INTO gate_jobs (id,run_id,request,state,created_at,updated_at,in_place) VALUES (?,?,?,'queued',?,?,?)",
      )
      .run(id, req.runId ?? null, JSON.stringify(req), now, now, Number(inplace));
    if (!inplace) this.keepLocal(this.job(id));
    return id;
  }
  lease(name: string, sweep = true) {
    return this.store.db.transaction(() => {
      if (sweep) this.sweep();
      const w = this.worker(name);
      if (!w || !this.available(w)) return null;
      const c: Capabilities = JSON.parse(w.capabilities ?? "{}");
      const unreported = this.jobs("state='leased' AND worker=?", name).filter((j) => !c.jobs.includes(j.id));
      if (unreported.length >= c.freeSlots) return null;
      const j = this.jobs("state='queued' AND in_place=0").find(
        (job) => !(JSON.parse(job.excluded) as string[]).includes(name),
      );
      if (!j) return null;
      const deadline = this.now() + attemptBudget(JSON.parse(j.request));
      const changed = this.store.db
        .query(
          "UPDATE gate_jobs SET state='leased',worker=?,lease_expires_at=?,attempt_deadline_at=?,updated_at=?,setup_order=(SELECT setup_order+1 FROM workers WHERE name=?) WHERE id=? AND state='queued'",
        )
        .run(name, Math.min(this.now() + this.times.lease, deadline), deadline, this.now(), name, j.id);
      if (changed.changes === 1)
        this.store.db.query("UPDATE workers SET setup_order=setup_order+1 WHERE name=?").run(name);
      return changed.changes === 1 ? this.job(j.id) : null;
    })();
  }
  executor(id?: string, sameRelease = true) {
    if (sameRelease && !this.releaseSha) return undefined;
    return this.store.db
      .query<{ id: string; pid: number; birth: string; release_sha: string }, []>("SELECT * FROM executors")
      .all()
      .find((e) => {
        if ((id && e.id !== id) || (sameRelease && e.release_sha !== this.releaseSha)) return false;
        try {
          return processBirthSync(e.pid) === e.birth;
        } catch {
          return false;
        }
      });
  }
  async waitStopped(id: string, signal?: AbortSignal) {
    while (this.job(id)?.stopped === 0) {
      signal?.throwIfAborted();
      const job = this.job(id);
      const worker = job?.worker;
      if (!worker || !this.executor(worker, false)) {
        if (!job) return;
        const { cwd } = JSON.parse(job.request) as GateRequest;
        const records = () => [
          ...this.store.listProcessDiscoveries(undefined, cwd),
          ...this.store.listProcessCleanups(undefined, cwd),
        ];
        await recoverProcessCleanups(this.store, records());
        if (records().length) throw new Error("In-place gate stop is unconfirmed; process recovery required");
        this.store.db
          .query("UPDATE gate_jobs SET stopped=1 WHERE id=? AND worker IS ? AND stopped=0")
          .run(id, worker ?? null);
        continue;
      }
      await Bun.sleep(this.times.tick);
    }
  }
  leaseInplace(owner: string) {
    if (this.store.getSetting("executor.daemonRelease", "") !== this.releaseSha || !this.executor(owner))
      return null;
    const j = this.jobs("state='queued' AND in_place=1").find(
      (j) => (JSON.parse(j.request) as GateRequest).releaseSha === this.releaseSha,
    );
    if (!j) return null; // Idle polling must not open a write transaction.
    return this.store.db
      .transaction(() => {
        if (this.store.getSetting("executor.daemonRelease", "") !== this.releaseSha) return null;
        const deadline = this.now() + attemptBudget(JSON.parse(j.request));
        const changed = this.store.db
          .query(
            "UPDATE gate_jobs SET state='leased',worker=?,stopped=0,lease_expires_at=?,attempt_deadline_at=?,updated_at=? WHERE id=? AND state='queued'",
          )
          .run(owner, this.now() + this.times.lease, deadline, this.now(), j.id);
        return changed.changes === 1 ? this.job(j.id) : null;
      })
      .immediate();
  }
  agentJob(id: string) {
    return this.store.db.query<AgentJobRow, [string]>("SELECT * FROM agent_jobs WHERE id=?").get(id);
  }
  enqueueAgentJob(req: AgentJobRequest, id: string = randomUUID()) {
    if ("backend" in req.target || "openai" in req.target || "decisions" in req.target) return null;
    let credentials = false;
    const request = JSON.stringify(req, (key, value: unknown) => {
      credentials ||= credentialInText(key) || (typeof value === "string" && credentialInText(value));
      return value;
    });
    if (credentials || credentialInText(request)) return null;
    const now = this.now();
    this.store.db
      .query(
        "INSERT INTO agent_jobs (id,run_id,invocation_id,request,parent_sha,state,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)",
      )
      .run(id, req.runId, req.invocationId, request, req.parentSha, now, now);
    return id;
  }
  leaseAgentJob(name: string) {
    return this.store.db
      .transaction(() => {
        this.sweepAgentJobs();
        const w = this.worker(name);
        if (!w || !this.available(w, true)) return null;
        const { agents, privateStrings } = this.agentCapabilities(w);
        if (!agents) return null;
        const held =
          this.store.db
            .query<{ n: number }, [string]>(
              "SELECT count(*) n FROM agent_jobs WHERE state='leased' AND worker=?",
            )
            .get(name)?.n ?? 0;
        if (held >= this.agentSlots) return null;
        const j = this.store.db
          .query<AgentJobRow, [string, number, number, string]>(
            "SELECT * FROM agent_jobs WHERE state='queued' AND NOT EXISTS (SELECT 1 FROM json_each(excluded) WHERE value=?) AND ((json_extract(request,'$.target.harness')='claude' AND ?=1) OR (json_extract(request,'$.target.harness')='codex' AND ?=1)) AND (json_extract(request,'$.commit') IS NULL OR ?='match') ORDER BY created_at, rowid LIMIT 1",
          )
          .get(
            name,
            Number(agents.claude?.loggedIn === true),
            Number(agents.codex?.loggedIn === true),
            privateStrings,
          );
        if (!j) return null;
        const req: AgentJobRequest = JSON.parse(j.request);
        const now = this.now(),
          deadline = now + Math.min(2_147_483_647, req.timeoutMs + 360_000);
        const changed = this.store.db
          .query(
            "UPDATE agent_jobs SET state='leased',worker=?,lease_expires_at=?,attempt_deadline_at=?,updated_at=? WHERE id=? AND state='queued'",
          )
          .run(name, Math.min(now + this.times.lease, deadline), deadline, now, j.id);
        return changed.changes === 1 ? this.agentJob(j.id) : null;
      })
      .immediate();
  }
  holdsAgentJob(id: string, name: string) {
    this.sweepAgentJobs();
    const j = this.agentJob(id);
    return j?.state === "leased" && j.worker === name ? j : null;
  }
  agentJobEvents(id: string, attempt: number, seq: number, events: unknown) {
    this.store.db
      .query(
        "INSERT INTO agent_job_attempt_events (job_id,attempt,seq,events,created_at) VALUES (?,?,?,?,?) ON CONFLICT(job_id,attempt,seq) DO NOTHING",
      )
      .run(id, attempt, seq, JSON.stringify(redactCredentialData(events)), this.now());
  }
  listAgentJobEvents(id: string) {
    // Legacy batches have no recorded attempt; retain them before the known attempts.
    return this.store.db
      .query<{ attempt: number | null; seq: number; events: string; created_at: number }, [string, string]>(
        "SELECT NULL AS attempt,seq,events,created_at FROM agent_job_events WHERE job_id=? UNION ALL SELECT attempt,seq,events,created_at FROM agent_job_attempt_events WHERE job_id=? ORDER BY attempt,seq",
      )
      .all(id, id);
  }
  agentJobEventsAfter(id: string, cursor = { attempt: -1, seq: -1 }) {
    return this.store.db
      .query<
        { attempt: number; seq: number; events: string; created_at: number },
        [string, string, number, number, number]
      >(
        "SELECT * FROM (SELECT -1 AS attempt,seq,events,created_at FROM agent_job_events WHERE job_id=? UNION ALL SELECT attempt,seq,events,created_at FROM agent_job_attempt_events WHERE job_id=?) WHERE attempt>? OR (attempt=? AND seq>?) ORDER BY attempt,seq",
      )
      .all(id, id, cursor.attempt, cursor.attempt, cursor.seq);
  }
  failAgentJob(id: string, reason: string) {
    this.store.db
      .transaction(() => {
        const j = this.agentJob(id);
        if (!j || !["queued", "leased"].includes(j.state)) return;
        const excluded: string[] = JSON.parse(j.excluded);
        if (j.worker) excluded.push(j.worker);
        this.store.db
          .query(
            "UPDATE agent_jobs SET state=?,attempt=?,worker=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,failure_reason=?,excluded=?,updated_at=? WHERE id=? AND state IN ('queued','leased')",
          )
          .run(
            j.attempt < 2 ? "queued" : "failed",
            Math.min(2, j.attempt + 1),
            this.sanitize(reason),
            JSON.stringify(excluded),
            this.now(),
            id,
          );
      })
      .immediate();
  }
  sweepAgentJobs() {
    this.store.db
      .transaction(() => {
        const now = this.now();
        for (const j of this.store.db
          .query<AgentJobRow, []>("SELECT * FROM agent_jobs WHERE state IN ('queued','leased')")
          .all()) {
          if (
            j.state === "queued" &&
            now - Math.max(j.updated_at, this.resumedAt ?? Number.NEGATIVE_INFINITY) >= this.times.pickup
          )
            this.failAgentJob(j.id, "No worker picked up job");
          else if (j.state === "leased") {
            const w = j.worker ? this.worker(j.worker) : null;
            if (w?.state !== "approved") this.failAgentJob(j.id, "Worker disconnected or revoked");
            else if ((j.attempt_deadline_at ?? 0) <= now) this.failAgentJob(j.id, "Attempt deadline expired");
            else if (
              Math.max(
                j.lease_expires_at ?? 0,
                (this.resumedAt ?? Number.NEGATIVE_INFINITY) + this.times.lease,
              ) <= now
            )
              this.failAgentJob(j.id, "Lease expired");
            else if (
              now - Math.max(w.last_heartbeat_at ?? 0, this.resumedAt ?? Number.NEGATIVE_INFINITY) >
              this.times.fresh
            )
              this.failAgentJob(j.id, "Worker disconnected");
          }
        }
      })
      .immediate();
  }
  completeAgentJob(id: string, result: unknown, resultSha: string) {
    return (
      this.store.db
        .query(
          "UPDATE agent_jobs SET state='done',result=?,result_sha=?,updated_at=? WHERE id=? AND state='leased'",
        )
        .run(JSON.stringify(this.sanitize(result)), this.sanitize(resultSha), this.now(), id).changes === 1
    );
  }
  cancelAgentJob(id: string) {
    this.store.db
      .query(
        "UPDATE agent_jobs SET state='cancelled',updated_at=? WHERE id=? AND state IN ('queued','leased','failed')",
      )
      .run(this.now(), id);
  }
  cancelOpenAgentJobs(keep: ReadonlySet<string>) {
    this.store.db
      .query(
        "UPDATE agent_jobs SET state='cancelled',updated_at=? WHERE state IN ('queued','leased') AND id NOT IN (SELECT value FROM json_each(?))",
      )
      .run(this.now(), JSON.stringify([...keep]));
  }
  cancelRunAgentJobs(runId: string) {
    this.store.db
      .query(
        "UPDATE agent_jobs SET state='cancelled',updated_at=? WHERE run_id=? AND state IN ('queued','leased','failed')",
      )
      .run(this.now(), runId);
  }
  cancelledHeld(ids: string[], name: string) {
    const owned = new Set(
      this.store.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM (SELECT id,worker,state FROM gate_jobs UNION ALL SELECT id,worker,state FROM agent_jobs) WHERE state='leased' AND worker=? AND id IN (SELECT value FROM json_each(?))",
        )
        .all(name, JSON.stringify(ids))
        .map((j) => j.id),
    );
    return ids.filter((id) => !owned.has(id));
  }
  private keepLocal(j: JobRow | null) {
    if (j?.state !== "queued" || j.in_place || !credentialBearing(JSON.parse(j.request))) return false;
    this.event(j.id, {
      type: "status",
      text: "LAN gates executing locally: executable inputs contain a registered credential",
    });
    this.store.db
      .query(
        "UPDATE gate_jobs SET state='failed',worker=NULL,lease_expires_at=NULL WHERE id=? AND state='queued'",
      )
      .run(j.id);
    return true;
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
    if (event.type === "status" && j.run_id)
      this.store.addEvent({
        runId: j.run_id,
        type: "gate",
        level: "warn",
        message: this.sanitize(event.text),
      });
  }
  fail(id: string, reason: string) {
    const j = this.job(id);
    if (!j || !["queued", "leased"].includes(j.state)) return;
    reason = this.sanitize(reason);
    if (j.in_place) {
      this.event(id, { type: "status", text: `In-place executor failure: ${reason}` });
      this.store.db
        .query(
          "UPDATE gate_jobs SET state='failed',failure_reason=?,updated_at=? WHERE id=? AND state IN ('queued','leased')",
        )
        .run(reason, this.now(), id);
      return;
    }
    this.event(id, { type: "status", text: `LAN infrastructure failure: ${reason}` });
    const excluded: string[] = JSON.parse(j.excluded);
    if (j.worker) excluded.push(j.worker);
    this.store.db
      .query(
        "UPDATE gate_jobs SET state=?,attempt=?,worker=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,failure_reason=?,excluded=?,updated_at=? WHERE id=? AND state IN ('queued','leased')",
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
    const resumedAt = this.resumedAt ?? Number.NEGATIVE_INFINITY;
    for (const j of this.jobs("state IN ('queued','leased')")) {
      if (j.state === "queued" && this.keepLocal(j)) continue;
      if (j.state === "queued" && now - Math.max(j.updated_at, resumedAt) >= this.times.pickup)
        this.fail(j.id, "No worker picked up job");
      else if (j.state === "leased") {
        // Older leases acquire a deadline once, using their persisted last renewal.
        const deadline = j.attempt_deadline_at ?? j.updated_at + attemptBudget(JSON.parse(j.request));
        if (j.attempt_deadline_at === null)
          this.store.db
            .query(
              "UPDATE gate_jobs SET attempt_deadline_at=?,lease_expires_at=min(lease_expires_at,?) WHERE id=?",
            )
            .run(deadline, deadline, j.id);
        if (j.in_place) {
          if (!j.worker || !this.executor(j.worker))
            this.fail(j.id, "Executor unavailable or release changed");
          else if (deadline <= now) this.fail(j.id, "Attempt deadline expired");
          else if (Math.max(j.lease_expires_at ?? 0, resumedAt + this.times.lease) <= now)
            this.fail(j.id, "Lease expired");
          continue;
        }
        const w = j.worker ? this.worker(j.worker) : null;
        if (w?.state !== "approved") this.fail(j.id, "Worker disconnected or revoked");
        else if (deadline <= now) this.fail(j.id, "Attempt deadline expired");
        else if (Math.max(j.lease_expires_at ?? 0, resumedAt + this.times.lease) <= now)
          this.fail(j.id, "Lease expired");
        else if (now - Math.max(w.last_heartbeat_at ?? 0, resumedAt) > this.times.fresh)
          this.fail(j.id, "Worker disconnected");
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
  fallbackSetup(id: string, command: string) {
    return this.store.db.transaction(() => {
      const j = this.job(id);
      if (j?.state !== "done" || !j.worker || j.setup_fallback) return false;
      const text = this.sanitize(
        `Worker setup failed: ${command}; LAN gates falling back to local execution`,
      );
      // Historical worker completions can retain infrastructure failure reasons; mark fallback separately.
      this.store.db
        .query(
          "UPDATE gate_jobs SET state='failed',result=NULL,setup_fallback=1,failure_reason=?,updated_at=? WHERE id=? AND state='done' AND setup_fallback=0",
        )
        .run(text, this.now(), id);
      this.event(id, { type: "status", text });
      return true;
    })();
  }
  complete(id: string, run: GateRun, local = false) {
    return this.store.db.transaction(() => {
      const j = this.job(id);
      const changed =
        this.store.db
          .query(
            "UPDATE gate_jobs SET state='done',result=?,failure_reason=CASE WHEN ? THEN failure_reason ELSE NULL END,updated_at=? WHERE id=? AND state=?",
          )
          .run(JSON.stringify(this.sanitize(run)), local, this.now(), id, local ? "failed" : "leased")
          .changes === 1;
      if (changed && !j?.in_place && j?.worker && run.setupOk && (!local || j.setup_fallback)) {
        // Retain the order after recovery too: an older pending fallback must not re-flag it.
        this.store.db
          .query(
            "UPDATE workers SET setup_warning=?,setup_warning_order=? WHERE name=? AND setup_warning_order<?",
          )
          .run(local ? this.sanitize(j.failure_reason) : null, j.setup_order, j.worker, j.setup_order);
      }
      return changed;
    })();
  }
}
