import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { Store } from "../db/store.ts";
import { canonicalGateCwd, WorkerStore } from "../db/workers.ts";
import { readPolicyScope } from "../harness/read-policy.ts";
import { confinementScope, seatbeltForPort, withCommandScratch } from "../harness/sandbox.ts";
import { processBirthSync, processCleanupStore, redactCredentials } from "../util/proc.ts";
import { executeGate, type GateRequest } from "./executor.ts";
import { attachSlotPools } from "./slots.ts";

/** A foreground owner whose jobs and capacity survive coordinator shutdown. */
export async function runInplaceExecutor(cfg: Config, releaseSha: string, signal: AbortSignal) {
  const store = new Store(cfg.paths.db);
  const workers = new WorkerStore(store, releaseSha);
  const owner = randomUUID();
  const birth = processBirthSync(process.pid);
  if (!birth) {
    store.close();
    throw new Error("Executor process identity unavailable");
  }
  const detach = attachSlotPools(store.db, cfg.maxConcurrentGates);
  store.db
    .query("INSERT INTO executors (id,pid,birth,release_sha) VALUES (?,?,?,?)")
    .run(owner, process.pid, birth, releaseSha);
  try {
    await processCleanupStore.run(store, () =>
      readPolicyScope.run(cfg.readPolicy, async () => {
        while (!signal.aborted) {
          const job = workers.leaseInplace(owner);
          if (!job) {
            await Bun.sleep(workers.times.tick);
            continue;
          }
          const controller = new AbortController();
          const req: GateRequest = JSON.parse(job.request);
          const checkLease = () => {
            const current = workers.job(job.id);
            const changed = store.getSetting("executor.daemonRelease", "") !== releaseSha;
            if (
              signal.aborted ||
              changed ||
              current?.state !== "leased" ||
              (current.attempt_deadline_at ?? 0) <= Date.now() ||
              (current.lease_expires_at ?? 0) <= Date.now()
            ) {
              const reason = changed
                ? "Daemon release changed; stopping in-place gate"
                : "Executor stopped or lease lost";
              if (!controller.signal.aborted) console.log(redactCredentials(reason));
              controller.abort(new Error(reason));
            } else
              store.db
                .query(
                  "UPDATE gate_jobs SET lease_expires_at=min(?,attempt_deadline_at),updated_at=? WHERE id=? AND state='leased' AND worker=?",
                )
                .run(Date.now() + workers.times.lease, Date.now(), job.id, owner);
          };
          const abort = () => checkLease();
          signal.addEventListener("abort", abort, { once: true });
          const renewal = setInterval(checkLease, workers.times.tick);
          try {
            if (!req.env) throw new Error("In-place gate is missing its environment");
            if (
              !Number.isInteger(req.daemonPort) ||
              !req.daemonPort ||
              req.daemonPort < 1 ||
              req.daemonPort > 65535
            )
              throw new Error("In-place gate is missing a valid daemon port");
            const run = await confinementScope.run(
              confinementScope.getStore() ?? seatbeltForPort(req.daemonPort),
              () =>
                withCommandScratch(
                  req.cwd,
                  () =>
                    executeGate({ ...req, skipGateSlot: false }, controller.signal, {
                      onResult: (result, phase) => workers.event(job.id, { type: "check", phase, result }),
                    }),
                  req.scratch,
                ),
            );
            checkLease();
            controller.signal.throwIfAborted();
            workers.complete(job.id, run);
          } catch (error) {
            workers.fail(job.id, redactCredentials(String(error)));
          } finally {
            clearInterval(renewal);
            signal.removeEventListener("abort", abort);
            // A failed process cleanup must never authorize another gate in this worktree.
            const cwd = canonicalGateCwd(req.cwd);
            if (
              !store.listProcessDiscoveries(undefined, cwd).length &&
              !store.listProcessCleanups(undefined, cwd).length
            )
              store.db.query("UPDATE gate_jobs SET stopped=1 WHERE id=? AND worker=?").run(job.id, owner);
          }
        }
      }),
    );
  } finally {
    store.db.query("DELETE FROM executors WHERE id=?").run(owner);
    detach();
    store.close();
  }
}
