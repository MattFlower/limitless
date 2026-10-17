import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, hostname, release, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { GateRequest } from "../gates/executor.ts";
import { redactGateData } from "../gates/output.ts";
import { runLocalGates } from "../gates/run.ts";
import { gateSlots } from "../gates/slots.ts";
import { worktreeGit } from "../git/command.ts";
import { addDetachedWorktree, withRepoLock } from "../git/repos.ts";
import { readPolicyScope } from "../harness/read-policy.ts";
import { type ConfinementBackend, confinementScope, seatbeltForPort } from "../harness/sandbox.ts";
import { removeScratch, restoreDirectoryPermissions } from "../harness/scratch.ts";
import { protectPrivateFile } from "../util/private-reads.ts";
import { agentEnv, registerCredential, sh } from "../util/proc.ts";
import { type Capabilities, pairingCode, timing } from "./protocol.ts";
import { certificate, privateFile, registerWorkerToken, workerRequest } from "./tls.ts";
import { attemptBudget, requestedChecks } from "./validation.ts";

export async function pairWorker(
  coordinator: string,
  home: string,
  name = hostname(),
  print = console.log,
  signal = new AbortController().signal,
) {
  const cert = await certificate(home);
  const paths = [join(home, "token"), join(home, "coordinator-fingerprint")];
  const held: (() => void)[] = [];
  try {
    const first = await workerRequest(
      coordinator,
      "/worker/pair",
      { name, fingerprint: cert.fingerprint },
      { signal },
    );
    if (first.status !== 200) throw new Error(`Pairing refused (${first.status})`);
    const pending = z
      .object({
        nonce: z.string().regex(/^[a-f0-9]{64}$/),
        secret: z.string().regex(/^[a-f0-9]{64}$/),
        expiresAt: z.number(),
      })
      .parse(first.json());
    registerCredential("LIMITLESS_WORKER_CLAIM_SECRET", pending.secret);
    print(`Worker pairing code: ${pairingCode(first.fingerprint, cert.fingerprint, pending.nonce)}`);
    while (Date.now() < pending.expiresAt) {
      const reply = await workerRequest(
        coordinator,
        "/worker/pair/claim",
        { secret: pending.secret },
        { pin: first.fingerprint, signal },
      );
      if (reply.status !== 200) throw new Error("Pairing expired or revoked");
      const claim = z
        .object({ token: z.string().optional(), pending: z.boolean().optional() })
        .parse(reply.json());
      if (claim.token) {
        registerWorkerToken(claim.token);
        held.push(privateFile(paths[1] ?? "", first.fingerprint).release);
        held.push(privateFile(paths[0] ?? "", claim.token).release);
        return;
      }
      await Bun.sleep(1000);
      signal.throwIfAborted();
    }
    throw new Error("Pairing expired");
  } finally {
    cert.release();
    for (const release of held) release();
  }
}

const WireRequest = z.object({
  repo: z.string(),
  cwd: z.string(),
  runId: z.string().optional(),
  priority: z.enum(["ship", "finish", "start"]).optional(),
  baseSha: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{40,64}$/)]),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  checks: z.array(z.string()).optional(),
  gates: z.object({
    setup: z.array(z.string()),
    checks: z.array(
      z.object({ name: z.string(), run: z.string(), timeoutSec: z.number().positive().optional() }),
    ),
    source: z.enum([".limitless.toml", "detected", "none"]),
    protectedPaths: z.array(z.string()),
    retryFiles: z.string().optional(),
    merge: z.enum(["auto", "pr", "none"]).optional(),
  }),
});
const Lease = z.object({
  job: z
    .object({
      id: z.string().uuid(),
      request: WireRequest,
      remainingMs: z.number().finite().nonnegative().optional(),
    })
    .nullable(),
  cancelled: z.array(z.string()).default([]),
});

async function machineState(): Promise<{ onAC: boolean; idleSeconds: number }> {
  const [power, idle] = await Promise.all([
    sh(["/usr/bin/pmset", "-g", "batt"], { cwd: process.cwd(), env: agentEnv(), timeoutMs: 5000 }),
    sh(["/usr/sbin/ioreg", "-c", "IOHIDSystem"], { cwd: process.cwd(), env: agentEnv(), timeoutMs: 5000 }),
  ]);
  const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(idle.stdout)?.[1];
  if (!ns) throw new Error("Cannot observe worker idle time");
  return { onAC: power.stdout.includes("AC Power"), idleSeconds: Number(ns) / 1e9 };
}

export async function runWorker(
  coordinator: string,
  cfg: Config,
  releaseSha: string,
  signal: AbortSignal,
  options: {
    confinement?: ConfinementBackend;
    heartbeatMs?: number;
    machineState?: typeof machineState;
    request?: typeof workerRequest;
    retryMs?: number;
    log?: (text: string) => void;
  } = {},
) {
  if (process.platform !== "darwin" && !options.confinement)
    throw new Error("Workers require macOS Seatbelt");
  const home = join(cfg.paths.home, "worker");
  mkdirSync(home, { recursive: true });
  const held = [protectPrivateFile(join(home, "key.pem"))];
  try {
    const token = privateFile(join(home, "token"));
    held.push(token.release);
    const pin = privateFile(join(home, "coordinator-fingerprint"));
    held.push(pin.release);
    registerWorkerToken(token.value);
    const stop = new AbortController(),
      combined = AbortSignal.any([signal, stop.signal]);
    const jobs = new Map<string, { controller: AbortController; task: Promise<void>; reported: boolean }>();
    const heldJobs = () =>
      [...jobs].filter(([, job]) => job.reported && !job.controller.signal.aborted).map(([id]) => id);
    const call = async (path: string, body?: unknown, requestSignal = combined) => {
      let delay = options.retryMs ?? 1000;
      for (;;) {
        requestSignal.throwIfAborted();
        const reply = await (options.request ?? workerRequest)(coordinator, path, redactGateData(body), {
          token: token.value,
          pin: pin.value,
          signal: requestSignal,
          timeoutMs: path.endsWith("/bundle") ? 300_000 : undefined,
        }).catch(() => {
          requestSignal.throwIfAborted();
          return undefined;
        });
        if (reply?.status === 200) return reply;
        if (reply && reply.status < 500) {
          const error = new Error(`Coordinator refused worker request (${reply.status})`);
          if (reply.status === 401 || reply.status === 403) stop.abort(error);
          throw error;
        }
        // Keep gates and heartbeat requests alive across a coordinator restart.
        await sleep(delay, undefined, { signal: requestSignal });
        delay = Math.min(delay * 2, 10_000);
      }
    };
    const heartbeat = async () => {
      const slots = gateSlots.snapshot(),
        state = await (options.machineState ?? machineState)();
      const body: Capabilities = {
        releaseSha,
        bunVersion: Bun.version,
        os: "darwin",
        osVersion: release(),
        cpuCount: cpus().length,
        ramBytes: totalmem(),
        freeSlots: Math.max(0, Math.min(slots.limit - slots.occupied, slots.limit - jobs.size)),
        ...state,
        jobs: heldJobs(),
      };
      const reply = z
        .object({ cancelled: z.array(z.string()) })
        .parse((await call("/worker/heartbeat", body)).json());
      for (const id of reply.cancelled) jobs.get(id)?.controller.abort();
    };
    const run = async (id: string, req: GateRequest, cancelled: AbortSignal, budget: number) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), Math.min(budget, 2_147_483_647));
      const jobSignal = AbortSignal.any([cancelled, deadline.signal]);
      const root = mkdtempSync(join(cfg.paths.work, "worker-")),
        cwd = join(root, "checkout"),
        cache = join(cfg.paths.repos, `${encodeURIComponent(req.repo)}.git`);
      try {
        const bundle = join(root, "job.bundle");
        writeFileSync(bundle, (await call(`/worker/jobs/${id}/bundle`, undefined, jobSignal)).data);
        await withRepoLock(cache, async () => {
          if (!existsSync(cache)) {
            for (const dir of ["objects", "refs"]) mkdirSync(join(cache, dir), { recursive: true });
            writeFileSync(join(cache, "HEAD"), "ref: refs/heads/main\n");
            await worktreeGit(
              [
                "git",
                "init",
                "--bare",
                "--template=",
                `--object-format=${req.headSha.length === 64 ? "sha256" : "sha1"}`,
              ],
              { cwd: cache, signal: jobSignal },
            );
          }
          const prefix = `refs/limitless-bundles/${id}/`;
          try {
            await worktreeGit(["git", "bundle", "verify", bundle], { cwd: cache, signal: jobSignal });
            await worktreeGit(["git", "fetch", "--no-tags", bundle, `+${prefix}*:${prefix}*`], {
              cwd: cache,
              signal: jobSignal,
            });
            await addDetachedWorktree(cache, req.headSha, cwd, jobSignal);
          } finally {
            const refs = await worktreeGit(["git", "for-each-ref", "--format=%(refname)", prefix], {
              cwd: cache,
            });
            for (const ref of refs.stdout.trim().split("\n").filter(Boolean))
              await worktreeGit(["git", "update-ref", "-d", ref], { cwd: cache });
          }
        });
        const sha = (
          await worktreeGit(["git", "rev-parse", "HEAD"], { cwd, signal: jobSignal })
        ).stdout.trim();
        if (sha !== req.headSha) throw new Error("Worker checkout SHA mismatch");
        let posts = Promise.resolve();
        const gates = { ...req.gates, checks: requestedChecks(req) };
        const run = await readPolicyScope.run(cfg.readPolicy, () =>
          confinementScope.run(options.confinement ?? seatbeltForPort(cfg.port), () =>
            runLocalGates(cwd, gates, jobSignal, {
              priority: req.priority,
              onResult(result, phase) {
                posts = posts.then(async () => {
                  await call(
                    `/worker/jobs/${id}/events`,
                    redactGateData({ type: "check", phase, result }),
                    jobSignal,
                  );
                });
                void posts.catch(() => jobs.get(id)?.controller.abort());
              },
            }),
          ),
        );
        await posts;
        jobSignal.throwIfAborted();
        await call(`/worker/jobs/${id}/result`, redactGateData({ run, sha }), jobSignal);
      } catch (error) {
        if (!jobSignal.aborted) await call(`/worker/jobs/${id}/failure`, {}, jobSignal).catch(() => {});
        else if (deadline.signal.aborted && !combined.aborted) {
          // One bounded, best-effort notification after expiry; store expiry remains authoritative.
          await (options.request ?? workerRequest)(
            coordinator,
            `/worker/jobs/${id}/failure`,
            {},
            {
              token: token.value,
              pin: pin.value,
              signal: AbortSignal.any([combined, AbortSignal.timeout(1000)]),
              timeoutMs: 1000,
            },
          ).catch(() => {});
        }
        if (combined.aborted) throw error;
      } finally {
        clearTimeout(timer);
        const job = jobs.get(id);
        if (job) job.reported = false;
        const diagnostic = () => (options.log ?? console.error)("Worker checkout cleanup failed");
        try {
          if (existsSync(cwd))
            await withRepoLock(cache, async () => {
              restoreDirectoryPermissions(cwd);
              await worktreeGit(["git", "worktree", "remove", "--force", cwd], { cwd: cache });
            });
        } catch {
          diagnostic();
        }
        try {
          removeScratch(root);
        } catch {
          diagnostic();
        }
      }
    };
    let beats: Promise<void> | undefined;
    try {
      await heartbeat();
      beats = (async () => {
        while (!combined.aborted) {
          await sleep(options.heartbeatMs ?? timing.heartbeat, undefined, { signal: combined });
          if (!combined.aborted) await heartbeat();
        }
      })();
      void beats.catch((error: unknown) => stop.abort(error));
      while (!combined.aborted) {
        const leased = Lease.parse((await call("/worker/lease", { jobs: heldJobs() })).json());
        for (const id of leased.cancelled) jobs.get(id)?.controller.abort();
        if (!leased.job) continue;
        const { id, request, remainingMs } = leased.job,
          controller = new AbortController();
        const task = run(
          id,
          request,
          AbortSignal.any([combined, controller.signal]),
          remainingMs ?? attemptBudget(request),
        ).finally(() => jobs.delete(id));
        jobs.set(id, { controller, task, reported: true });
        void task.catch(() => stop.abort());
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      stop.abort();
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...(beats ? [beats] : []), ...[...jobs.values()].map((j) => j.task)]);
    }
  } finally {
    for (const release of held) release();
  }
}
