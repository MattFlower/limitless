import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { cpus, hostname, release, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "../config.ts";
import { isBranchName } from "../core/delivery.ts";
import { Store } from "../db/store.ts";
import type { GateRequest } from "../gates/executor.ts";
import { redactGateData } from "../gates/output.ts";
import { loadPrivateStrings, privateStringsDigest } from "../gates/private.ts";
import { runLocalGates } from "../gates/run.ts";
import { gateSlots } from "../gates/slots.ts";
import { worktreeGit } from "../git/command.ts";
import { addDetachedWorktree, withRepoLock } from "../git/repos.ts";
import { runClaude } from "../harness/claude.ts";
import { runCodex } from "../harness/codex.ts";
import { readPolicyScope } from "../harness/read-policy.ts";
import { type ConfinementBackend, confinementScope, seatbeltForPort } from "../harness/sandbox.ts";
import { removeScratch, restoreDirectoryPermissions } from "../harness/scratch.ts";
import type { AgentEvent, AgentSpec, Harness } from "../harness/types.ts";
import { runToolAgent } from "../pipeline/agent-executor.ts";
import { protectPrivateFile } from "../util/private-reads.ts";
import {
  agentEnv,
  assertProcessesStopped,
  bootIdentity,
  type ProcessCleanup,
  type ProcessCleanupStore,
  type ProcessDiscovery,
  ProcessTerminationError,
  processScope,
  recoverProcessCleanups,
  redactCredentials,
  registerCredential,
  sh,
} from "../util/proc.ts";
import { AgentResultReport } from "./agent-protocol.ts";
import { type Capabilities, pairingCode, timing } from "./protocol.ts";
import { publicationFields, publishAgentChanges } from "./publication.ts";
import { agentPathMask } from "./reporting.ts";
import { certificate, privateFile, registerWorkerToken, workerRequest } from "./tls.ts";
import { updateWorker, WorkerUpdateError } from "./update.ts";
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
const AgentRequest = z.object({
  // Validate publication metadata per job so a malformed lease cannot stop the worker.
  privateStringsDigest: z.unknown().optional(),
  commit: z.unknown().optional(),
  repoUrl: z.unknown().optional(),
  expectedRemoteSha: z.unknown().optional(),
  discreet: z.unknown().optional(),
  uiUrl: z.unknown().optional(),
  runId: z.string(),
  invocationId: z.number().int(),
  parentSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  baseSha: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
    .optional(),
  prompt: z.string(),
  timeoutMs: z.number().finite().positive(),
  target: z.object({
    modelId: z.string(),
    provider: z.string(),
    harness: z.string(),
    model: z.string(),
    vendor: z.string(),
    tier: z.number(),
    billing: z.enum(["free", "subscription", "metered"]),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    targetId: z.string().optional(),
    effortMapping: z.enum(["openrouter", "generic", "qwen"]).optional(),
    price: z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional() }).optional(),
  }),
  role: z
    .enum([
      "triage",
      "spec",
      "plan",
      "plan_review",
      "holdout",
      "implement",
      "review",
      "verify",
      "summarize",
      "chat",
    ])
    .optional(),
  mode: z.enum(["edit", "readonly"]).optional(),
  systemAppend: z.string().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  idleTimeoutMs: z.number().finite().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  fast: z.boolean().optional(),
  privateSession: z.boolean().optional(),
  confineReads: z.boolean().optional(),
  slottedCommands: z.array(z.array(z.string())).optional(),
  branch: z.string().optional(),
});
const Lease = z.object({
  agentJob: z
    .object({
      id: z.string().uuid(),
      request: AgentRequest,
      remainingMs: z.number().finite().nonnegative().optional(),
    })
    .nullish(),
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

class CoordinatorRefusal extends Error {
  constructor(readonly status: number) {
    super(`Coordinator refused worker request (${status})`);
  }
}

type FenceTimer = {
  set: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout> | undefined) => void;
};

export async function runWorker(
  coordinator: string,
  cfg: Config,
  releaseSha: string,
  signal: AbortSignal,
  options: {
    confinement?: ConfinementBackend;
    harnesses?: Partial<Record<"claude" | "codex", Harness>>;
    tokenLookup?: Parameters<typeof publishAgentChanges>[4];
    heartbeatMs?: number;
    leaseMs?: number;
    fenceTimer?: FenceTimer;
    machineState?: typeof machineState;
    request?: typeof workerRequest;
    retryMs?: number;
    log?: (text: string) => void;
    update?: Parameters<typeof updateWorker>[1];
    updateRetry?: { initialMs?: number; maxMs?: number; deadlineMs?: number; now?: () => number };
  } = {},
) {
  if (process.platform !== "darwin" && !options.confinement)
    throw new Error("Workers require macOS Seatbelt");
  const home = join(cfg.paths.home, "worker");
  mkdirSync(home, { recursive: true });
  const held = [protectPrivateFile(join(home, "key.pem"))];
  const store = new Store(join(home, "worker.db"));
  type RetainedJob = {
    root: string;
    cache: string;
    scratch: string[];
    discoveries?: ProcessDiscovery[];
    pending?: string[];
    ownership?: { marker: string; runId: string; started: number; boot?: string };
  };
  const retained = store.getSetting<Record<string, RetainedJob>>("worker.cleanups", {});
  const save = () => store.setSetting("worker.cleanups", retained);
  const updateJob = (job: RetainedJob, changes: Partial<RetainedJob>) => {
    const next = { ...job, ...changes };
    store.setSetting("worker.cleanups", { ...retained, [job.root]: next });
    Object.assign(job, next);
  };
  const unresolved = (error: unknown) =>
    (options.log ?? console.error)(redactCredentials(`Worker cleanup unresolved: ${String(error)}`));
  const cleanups: ProcessCleanupStore = {
    recordProcessCleanup: store.recordProcessCleanup.bind(store),
    listProcessCleanups: store.listProcessCleanups.bind(store),
    deleteProcessCleanup: store.deleteProcessCleanup.bind(store),
    listProcessDiscoveries: () => Object.values(retained).flatMap((job) => job.discoveries ?? []),
    deleteInvocationCleanups(invocation) {
      const next = Object.fromEntries(
        Object.entries(retained).map(([root, job]) => [
          root,
          {
            ...job,
            discoveries: job.discoveries?.filter((row) => row.invocation !== invocation),
            pending: job.pending?.filter((marker) => marker !== invocation),
          },
        ]),
      );
      store.db.transaction(() => {
        store.deleteInvocationCleanups(invocation);
        store.setSetting("worker.cleanups", next);
      })();
      for (const [root, job] of Object.entries(next)) {
        const current = retained[root];
        if (current) Object.assign(current, job);
      }
    },
  };
  const active = new Set<string>();
  const belongsTo = (row: ProcessCleanup, job: RetainedJob) =>
    row.directory === join(job.root, "checkout") ||
    row.invocation === job.ownership?.marker ||
    job.pending?.includes(row.invocation) ||
    job.discoveries?.some((discovery) => discovery.invocation === row.invocation);
  const inspectBoot = () => {
    try {
      return bootIdentity();
    } catch {
      return undefined;
    }
  };
  const confirm = async (job: RetainedJob) => {
    const records = store.listProcessCleanups().filter((row) => belongsTo(row, job));
    const local: ProcessCleanupStore = {
      ...cleanups,
      listProcessCleanups: () => records,
      listProcessDiscoveries: () => job.discoveries ?? [],
    };
    const owner = job.ownership;
    if (owner) {
      const boot = inspectBoot();
      if (boot && owner.boot && boot !== owner.boot) {
        for (const invocation of new Set([
          ...records.map((row) => row.invocation),
          ...(job.discoveries ?? []).map((row) => row.invocation),
          ...(job.pending ?? []),
        ]))
          cleanups.deleteInvocationCleanups(invocation);
      } else {
        if (
          job.pending?.some(
            (marker) =>
              !job.discoveries?.some((row) => row.invocation === marker) &&
              !records.some((row) => row.invocation === marker && row.discovery),
          )
        ) {
          if (boot && !owner.boot) updateJob(job, { ownership: { ...owner, boot } });
          throw new Error("missing worker discovery evidence for pending invocation; awaiting changed boot");
        }
        await recoverProcessCleanups(local, undefined, undefined, undefined, {
          runId: owner.runId,
          invocation: owner.marker,
          directory: join(job.root, "checkout"),
          boot: owner.boot ?? "",
          createdAt: owner.started,
          discovery: {
            group: 0,
            started: owner.started,
            directories: [job.root, ...job.scratch].map((directory) => {
              try {
                return realpathSync(directory);
              } catch {
                return directory;
              }
            }),
            leader: null,
            spawnedAt: "0",
          },
        });
      }
    } else {
      // Legacy identities and invocation context remain useful, but an empty list proves nothing.
      if (!job.discoveries?.length && !records.some((row) => row.discovery))
        throw new Error("missing worker discovery evidence");
      await recoverProcessCleanups(local);
    }
  };
  const cleanup = async ({ root, cache, scratch }: RetainedJob) => {
    if (dirname(root) !== cfg.paths.work || !basename(root).startsWith("worker-"))
      throw new Error("Invalid worker cleanup directory");
    const cwd = join(root, "checkout");
    try {
      if (existsSync(cwd))
        await withRepoLock(cache, async () => {
          restoreDirectoryPermissions(cwd);
          await worktreeGit(["git", "worktree", "remove", "--force", cwd], {
            cwd: cache,
            additionalWriteRoots: [cwd],
          });
        });
    } catch (error) {
      if (error instanceof ProcessTerminationError) throw error;
      (options.log ?? console.error)("Worker checkout cleanup failed");
    }
    for (const directory of [...scratch, root]) removeScratch(directory);
  };
  const scoped = (
    id: string,
    root: string,
    jobSignal: AbortSignal,
    run: () => Promise<void>,
    scratch: string[] = [],
  ) =>
    processScope.run(
      {
        signal: jobSignal,
        killGraceMs: 100,
        children: new Map(),
        scratchDirs: new Set(scratch),
        runId: id,
        checkout: () => join(root, "checkout"),
        cleanups: {
          ...cleanups,
          recordProcessDiscovery(row) {
            const job = retained[root];
            if (!job) throw new Error("Missing worker ownership evidence");
            updateJob(job, {
              discoveries: [...(job.discoveries ?? []), row],
              pending: job.pending?.filter((marker) => marker !== row.invocation),
            });
          },
        } satisfies ProcessCleanupStore,
        ownershipMarker: retained[root]?.ownership?.marker,
        beforeSpawn(invocation) {
          const job = retained[root];
          if (!job) throw new Error("Missing worker ownership evidence");
          updateJob(job, {
            scratch: [...(processScope.getStore()?.scratchDirs ?? [])],
            pending: [...new Set([...(job.pending ?? []), ...(invocation ? [invocation] : [])])],
          });
        },
      },
      run,
    );
  let recovery: Promise<void> | undefined;
  const recover = () => {
    if (recovery) return recovery;
    recovery = (async () => {
      for (const [id, job] of Object.entries(retained)) {
        if (active.has(id)) continue;
        try {
          await confirm(job);
          if (active.has(id) || retained[id] !== job) continue;
          await scoped(
            id,
            job.root,
            new AbortController().signal,
            async () => {
              try {
                await cleanup(job);
              } catch (error) {
                const termination = processScope.getStore()?.terminationError;
                if (error instanceof ProcessTerminationError || termination) throw termination ?? error;
                (options.log ?? console.error)("Worker checkout cleanup failed");
              }
            },
            job.scratch,
          );
          delete retained[id];
          save();
        } catch (error) {
          unresolved(error);
        }
      }
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  try {
    // Also recover identities from older workers that have no retained-directory entry.
    await recoverProcessCleanups(
      store,
      store
        .listProcessCleanups()
        .filter((row) => !Object.values(retained).some((job) => belongsTo(row, job))),
    ).catch(unresolved);
    await recover();
    const token = privateFile(join(home, "token"));
    held.push(token.release);
    const pin = privateFile(join(home, "coordinator-fingerprint"));
    held.push(pin.release);
    registerWorkerToken(token.value);
    const stop = new AbortController(),
      combined = AbortSignal.any([signal, stop.signal]);
    const jobs = new Map<string, { controller: AbortController; task: Promise<void>; reported: boolean }>();
    const agentJobs: typeof jobs = new Map();
    const leaseMs = options.leaseMs ?? timing.lease;
    const fenceTimer: FenceTimer = options.fenceTimer ?? { set: setTimeout, clear: clearTimeout };
    let fence: ReturnType<typeof setTimeout> | undefined;
    const allJobs = () => [...jobs, ...agentJobs];
    const cancel = (id: string) => {
      jobs.get(id)?.controller.abort();
      agentJobs.get(id)?.controller.abort();
    };
    type UpdateEpisode = {
      target: string;
      deadline?: number;
      nextAt: number;
      attempts: number;
      exhausted: boolean;
      controller: AbortController;
    };
    let update: UpdateEpisode | undefined,
      updateWarning: string | undefined,
      supportsUpdates = false,
      updating = false,
      restorationFailed = false;
    const now = options.updateRetry?.now ?? Date.now;
    const updateBlocked = () => update !== undefined || updating || restorationFailed;
    const observeRelease = (target: string | undefined) => {
      supportsUpdates = target !== undefined;
      if (target === undefined || target === update?.target) return;
      update?.controller.abort();
      update =
        target === releaseSha
          ? undefined
          : {
              target,
              nextAt: 0,
              attempts: 0,
              exhausted: false,
              controller: new AbortController(),
            };
      if (!updating && !restorationFailed) updateWarning = undefined;
    };
    const heldJobs = () =>
      allJobs()
        .filter(([, job]) => job.reported && !job.controller.signal.aborted)
        .map(([id]) => id);
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
          const error = new CoordinatorRefusal(reply.status);
          if (reply.status === 401 || reply.status === 403) stop.abort(error);
          throw error;
        }
        // Keep gates and heartbeat requests alive across a coordinator restart.
        await sleep(delay, undefined, { signal: requestSignal });
        delay = Math.min(delay * 2, 10_000);
      }
    };
    const heartbeat = async () => {
      // Retained cleanup must not delay lease renewal for unrelated active jobs.
      void recover().catch(unresolved);
      const slots = gateSlots.snapshot(),
        state = await (options.machineState ?? machineState)();
      const body: Capabilities = {
        releaseSha,
        bunVersion: Bun.version,
        os: "darwin",
        osVersion: release(),
        cpuCount: cpus().length,
        ramBytes: totalmem(),
        freeSlots: updateBlocked()
          ? 0
          : Math.max(0, Math.min(slots.limit - slots.occupied, slots.limit - jobs.size)),
        ...(supportsUpdates && updateWarning ? { updateWarning } : {}),
        ...state,
        jobs: heldJobs(),
      };
      let response: Awaited<ReturnType<typeof call>>;
      try {
        response = await call("/worker/heartbeat", body);
      } catch (error) {
        // A running coordinator can roll back to the previous strict schema.
        if (!(error instanceof CoordinatorRefusal) || error.status !== 400 || !body.updateWarning)
          throw error;
        supportsUpdates = false;
        delete body.updateWarning;
        response = await call("/worker/heartbeat", body);
      }
      const reply = z
        .object({ cancelled: z.array(z.string()), releaseSha: z.string().optional() })
        .parse(response.json());
      fenceTimer.clear(fence);
      // A request may finish after shutdown; only live workers can renew the deadline.
      if (!combined.aborted)
        fence = fenceTimer.set(() => {
          for (const job of agentJobs.values()) job.controller.abort();
        }, leaseMs);
      for (const id of reply.cancelled) cancel(id);
      observeRelease(reply.releaseSha);
    };
    const withCheckout = async (
      id: string,
      root: string,
      cache: string,
      expectedSha: string,
      path: string,
      jobSignal: AbortSignal,
      invoke: (cwd: string) => Promise<() => Promise<unknown>>,
      onError?: (error: unknown) => Promise<void>,
    ): Promise<void> => {
      active.add(root);
      retained[root] = {
        root,
        cache,
        scratch: [],
        discoveries: [],
        pending: [],
        ownership: { marker: randomUUID(), runId: id, started: Date.now(), boot: inspectBoot() },
      };
      return scoped(id, root, jobSignal, async () => {
        save();
        const cwd = join(root, "checkout");
        const finish = async () => {
          const scope = processScope.getStore();
          if (!scope) return;
          // Cleanup must finish even when the job's deadline or cancellation has fired.
          scope.signal = new AbortController().signal;
          try {
            assertProcessesStopped();
            const job = retained[root];
            if (!job) throw new Error("Missing worker ownership evidence");
            try {
              await confirm(job);
            } catch (error) {
              if (error instanceof ProcessTerminationError) throw error;
              throw new ProcessTerminationError(
                `${ProcessTerminationError.prefix}: ${redactCredentials(error instanceof Error ? error.message : String(error))}`,
                { cause: error },
              );
            }
            await cleanup({ root, cache, scratch: [...scope.scratchDirs] });
          } catch (error) {
            if (error instanceof ProcessTerminationError || scope.terminationError) {
              retained[root] = {
                ...retained[root],
                root,
                cache,
                scratch: [...scope.scratchDirs],
              };
              save();
              throw scope.terminationError ?? error;
            }
            (options.log ?? console.error)("Worker checkout cleanup failed");
          }
          delete retained[root];
          save();
        };
        try {
          let report: (() => Promise<unknown>) | undefined;
          try {
            const bundle = join(root, "job.bundle");
            writeFileSync(bundle, (await call(`${path}/bundle`, undefined, jobSignal)).data);
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
                    `--object-format=${expectedSha.length === 64 ? "sha256" : "sha1"}`,
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
                await addDetachedWorktree(cache, expectedSha, cwd, jobSignal);
              } finally {
                const scope = processScope.getStore();
                if (scope) scope.signal = new AbortController().signal;
                try {
                  const refs = await worktreeGit(["git", "for-each-ref", "--format=%(refname)", prefix], {
                    cwd: cache,
                  });
                  for (const ref of refs.stdout.trim().split("\n").filter(Boolean))
                    await worktreeGit(["git", "update-ref", "-d", ref], { cwd: cache });
                } finally {
                  if (scope) scope.signal = jobSignal;
                }
              }
            });
            const sha = (
              await worktreeGit(["git", "rev-parse", "HEAD"], { cwd, signal: jobSignal })
            ).stdout.trim();
            if (sha !== expectedSha) throw new Error("Worker checkout SHA mismatch");
            report = await invoke(cwd);
            assertProcessesStopped();
          } catch (error) {
            const scope = processScope.getStore();
            if (scope && error instanceof ProcessTerminationError) scope.terminationError = error;
            throw error;
          } finally {
            await finish();
          }
          await report?.();
        } catch (error) {
          if (!onError) throw error;
          await onError(error);
        }
      }).finally(() => active.delete(root));
    };
    const run = async (id: string, req: GateRequest, cancelled: AbortSignal, budget: number) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), Math.min(budget, 2_147_483_647));
      const jobSignal = AbortSignal.any([cancelled, deadline.signal]);
      const root = mkdtempSync(join(cfg.paths.work, "worker-")),
        cache = join(cfg.paths.repos, `${encodeURIComponent(req.repo)}.git`);
      const failure = async (error: unknown) => {
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
      };
      try {
        await withCheckout(
          id,
          root,
          cache,
          req.headSha,
          `/worker/jobs/${id}`,
          jobSignal,
          async (cwd) => {
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
            assertProcessesStopped();
            return () =>
              call(`/worker/jobs/${id}/result`, redactGateData({ run, sha: req.headSha }), jobSignal);
          },
          failure,
        );
      } finally {
        clearTimeout(timer);
        const job = jobs.get(id);
        if (job) job.reported = false;
      }
    };
    const runAgent = async (
      id: string,
      request: z.infer<typeof AgentRequest>,
      jobSignal: AbortSignal,
      deadline: number,
    ) => {
      const path = `/worker/agent-jobs/${id}`;
      let root: string | undefined;
      let sanitize = agentPathMask([]);
      let posts = Promise.resolve(),
        seq = 0;
      let events: AgentEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        clearTimeout(flushTimer);
        flushTimer = undefined;
        if (!events.length) return;
        const body = sanitize({ seq: seq++, events });
        events = [];
        posts = posts.then(() => call(`${path}/events`, body, jobSignal)).then(() => {});
        void posts.catch(() => agentJobs.get(id)?.controller.abort());
      };
      try {
        const publication = z.object(publicationFields).safeParse(request);
        if (!publication.success) throw new Error("Invalid agent publication metadata");
        const req = {
          ...request,
          privateStringsDigest: publication.data.privateStringsDigest,
          commit: publication.data.commit,
          repoUrl: publication.data.repoUrl,
          expectedRemoteSha: publication.data.expectedRemoteSha,
          discreet: publication.data.discreet,
          uiUrl: publication.data.uiUrl,
        };
        if (
          req.commit &&
          req.privateStringsDigest !== privateStringsDigest(loadPrivateStrings(cfg.paths.configDir))
        )
          throw new Error("Worker private-strings list differs from the coordinator's; publication blocked");
        const { privateStringsDigest: digest, ...session } = req;
        const name = req.target.harness;
        const harness =
          name === "claude" || name === "codex"
            ? (options.harnesses ?? { claude: runClaude, codex: runCodex })[name]
            : undefined;
        if (!harness || (name !== "claude" && name !== "codex"))
          throw new Error("provider unavailable on worker");
        if (!req.branch || !isBranchName(req.branch)) throw new Error("Missing or invalid agent branch");
        root = mkdtempSync(join(cfg.paths.work, "worker-agent-"));
        sanitize = agentPathMask([root, join(root, "checkout")]);
        await withCheckout(id, root, join(root, "repo.git"), req.parentSha, path, jobSignal, async (cwd) => {
          sanitize = agentPathMask([cwd, root ?? cwd]);
          const spec: AgentSpec = {
            ...session,
            target: { ...req.target, harness: name },
            cwd,
            mode: req.mode ?? "edit",
            idleTimeoutMs: req.idleTimeoutMs ?? 600_000,
            maxToolCalls: req.maxToolCalls ?? (req.mode === "readonly" ? 150 : 400),
            signal: jobSignal,
            logPath: join(root ?? cwd, "agent.jsonl"),
            onEvent(event) {
              if (jobSignal.aborted) return;
              events.push(event);
              if (events.length === 200) flush();
              else flushTimer ??= setTimeout(flush, 250);
            },
          };
          const result = await readPolicyScope.run(cfg.readPolicy, () =>
            confinementScope.run(options.confinement ?? seatbeltForPort(cfg.port), () =>
              runToolAgent(
                spec,
                (spec) => {
                  sanitize = agentPathMask([cwd, ...(spec.scratchDir ? [spec.scratchDir] : []), root ?? cwd]);
                  return harness(spec);
                },
                req.confineReads ? [] : (req.slottedCommands ?? []),
              ),
            ),
          );
          flush();
          await posts;
          jobSignal.throwIfAborted();
          assertProcessesStopped();
          const sha = await publishAgentChanges(
            cwd,
            { ...req, target: spec.target },
            cfg,
            jobSignal,
            options.tokenLookup,
          );
          const report = AgentResultReport.parse(
            sanitize({
              ...result,
              parentSha: req.parentSha,
              sha,
              branch: req.branch,
              ...(req.commit ? { privateStringsDigest: digest } : {}),
            }),
          );
          assertProcessesStopped();
          return () =>
            call(
              `${path}/result`,
              report,
              sha === req.parentSha
                ? jobSignal
                : AbortSignal.any([combined, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]),
            );
        });
      } catch (error) {
        if (!jobSignal.aborted)
          await call(
            `${path}/failure`,
            { reason: sanitize(String(error instanceof Error ? error.message : error)).slice(0, 4000) },
            jobSignal,
          ).catch(() => {});
        if (combined.aborted) throw error;
      } finally {
        clearTimeout(flushTimer);
        await posts.catch(() => {});
        const job = agentJobs.get(id);
        if (job) job.reported = false;
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
        if (updateBlocked()) {
          await Promise.all(allJobs().map(([, job]) => job.task));
          // Heartbeats may have changed the target while jobs and cleanup drained.
          const episode = update;
          if (!updateBlocked()) continue;
          if (episode && !episode.exhausted && now() >= episode.nextAt) {
            episode.deadline ??= now() + (options.updateRetry?.deadlineMs ?? 60_000);
            if (now() >= episode.deadline) episode.exhausted = true;
            else {
              updating = true;
              episode.attempts++;
              try {
                await updateWorker(episode.target, {
                  ...options.update,
                  signal: AbortSignal.any([
                    combined,
                    episode.controller.signal,
                    AbortSignal.timeout(Math.max(1, episode.deadline - now())),
                  ]),
                });
                episode.exhausted = true; // Native exec never returns; injected exec can.
              } catch (error) {
                const restored = error instanceof WorkerUpdateError && error.restored;
                if (!restored) restorationFailed = true;
                else if (error.restoredRelease === releaseSha) restorationFailed = false;
                if (update === episode || !restored) {
                  updateWarning = redactCredentials(`Worker update failed: ${String(error)}`).slice(0, 4000);
                  episode.exhausted =
                    !(error instanceof WorkerUpdateError && error.retryable) || now() >= episode.deadline;
                  const delay = Math.min(
                    (options.updateRetry?.initialMs ?? 1000) * 2 ** (episode.attempts - 1),
                    options.updateRetry?.maxMs ?? 10_000,
                  );
                  episode.nextAt = Math.min(now() + delay, episode.deadline);
                }
              } finally {
                updating = false;
                if (!update && !restorationFailed) updateWarning = undefined;
              }
            }
          }
          const delay =
            episode && !episode.exhausted
              ? Math.max(1, Math.min(options.heartbeatMs ?? timing.heartbeat, episode.nextAt - now()))
              : (options.heartbeatMs ?? timing.heartbeat);
          await sleep(delay, undefined, { signal: combined });
          continue;
        }
        const leased = Lease.parse((await call("/worker/lease", { jobs: heldJobs() })).json());
        for (const id of leased.cancelled) cancel(id);
        if (leased.agentJob) {
          const { id, request, remainingMs } = leased.agentJob;
          if (updateBlocked())
            await call(`/worker/agent-jobs/${id}/failure`, { reason: "Worker update pending" }).catch(
              () => {},
            );
          else {
            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort(),
              Math.min(remainingMs ?? request.timeoutMs + 360_000, 2_147_483_647),
            );
            const task = runAgent(
              id,
              request,
              AbortSignal.any([combined, controller.signal]),
              Date.now() + Math.min(remainingMs ?? request.timeoutMs + 360_000, 2_147_483_647),
            ).finally(() => {
              clearTimeout(timer);
              agentJobs.delete(id);
            });
            agentJobs.set(id, { controller, task, reported: true });
            void task.catch(() => stop.abort());
          }
        }
        if (!leased.job) continue;
        if (updateBlocked()) {
          await call(`/worker/jobs/${leased.job.id}/failure`, {}).catch(() => {});
          continue;
        }
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
      fenceTimer.clear(fence);
      for (const [, job] of allJobs()) job.controller.abort();
      await Promise.allSettled([
        ...(beats ? [beats] : []),
        ...allJobs().map(([, j]) => j.task),
        ...(recovery ? [recovery] : []),
      ]);
    }
  } finally {
    store.close();
    for (const release of held) release();
  }
}
