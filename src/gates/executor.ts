import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WorkerStore } from "../db/workers.ts";
import { worktreeGit } from "../git/command.ts";
import { withScratch } from "../harness/scratch.ts";
import { registeredCredentials } from "../util/proc.ts";
import type { GateConfig } from "./detect.ts";
import type { ActionsProgress } from "./github-actions.ts";
import { lanExecutor } from "./lan.ts";
import { redactGateData, redactGateOutput } from "./output.ts";
import { loadPrivateStrings, type PrivateStrings, redactPrivate } from "./private.ts";
import {
  type GateHooks,
  type GateResult,
  type GateRetryOptions,
  type GateRun,
  runLocalGates,
} from "./run.ts";
import { bindGateSlotScope, type GatePriority } from "./slots.ts";

export interface Executor<Req, Res> {
  readonly kind: "local" | "github-actions" | "lan" | "inplace" | "claude-cloud";
  start(req: Req, signal: AbortSignal): Promise<ExecutionHandle>;
  attach(
    handle: ExecutionHandle,
    signal: AbortSignal,
    req?: Req,
    hooks?: GateHooks,
    persist?: (handle: ExecutionHandle) => Promise<void>,
  ): Execution<Res>;
  discard?(handle: ExecutionHandle): void | Promise<void>;
}
export interface ExecutionHandle {
  kind: Executor<unknown, unknown>["kind"];
  id: string;
  startedAt: number;
  url?: string;
  githubActions?: ActionsProgress;
}
export interface Execution<Res> {
  events: AsyncIterable<ExecutionEvent>;
  result: Promise<Res>;
  cancel(reason?: unknown): Promise<void>;
}
export type ExecutionEvent =
  | { type: "status"; text: string }
  | { type: "check"; phase: "setup" | "check"; result: GateResult };
export interface GateRequest {
  env?: Record<string, string>;
  releaseSha?: string;
  daemonPort?: number;
  scratch?: string;
  implementerIssue?: boolean;
  fallbackSetup?: string[];
  runId?: string;
  priority?: GatePriority;
  repo: string;
  cwd: string;
  baseSha: string;
  headSha: string;
  gates: GateConfig;
  checks?: string[];
  skipGateSlot?: boolean;
}
export type GateExecutor = Executor<GateRequest, GateRun> & {
  canResume?: (handle: ExecutionHandle, env?: Record<string, string>, daemonPort?: number) => boolean;
  freshCheckoutFor?: (repo: string) => boolean;
};
export type GateRunner = (gates: GateConfig, options?: GateRetryOptions) => Promise<GateRun>;

/** Inspect the checkout that executed the gate; an echoed request SHA is not provenance. */
export async function gateProvenance(cwd: string, signal: AbortSignal, checkedSha = "HEAD") {
  try {
    const result = await worktreeGit(["git", "rev-parse", "HEAD", "HEAD^{tree}"], { cwd, signal });
    const [sha, treeHash] = result.stdout.trim().split("\n");
    const hash = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
    if (sha && treeHash && hash.test(sha) && hash.test(treeHash)) {
      const diffs = await withScratch(cwd, async (scratch) => {
        // A fresh index has no gate-set assume-unchanged/skip-worktree flags or stat cache.
        const opts = { cwd, signal, env: { ...process.env, GIT_INDEX_FILE: join(scratch, "index") } };
        await worktreeGit(["git", "read-tree", checkedSha], opts);
        const refresh = await worktreeGit(["git", "update-index", "--refresh"], { ...opts, allowFail: true });
        if (refresh.exitCode !== 0 && refresh.exitCode !== 1) throw new Error("Index refresh failed");
        const working = await worktreeGit(["git", "diff", "--name-only", "-z", "--no-renames", "--"], opts);
        const staged = await worktreeGit(
          ["git", "diff", "--cached", "--name-only", "-z", "--no-renames", checkedSha, "--"],
          { cwd, signal },
        );
        signal.throwIfAborted();
        return [working, staged];
      });
      const paths = [...new Set(diffs.flatMap((diff) => diff.stdout.split("\0").filter(Boolean)))].map(
        redactGateOutput,
      );
      return {
        sha,
        treeHash,
        trackedClean: paths.length === 0,
        provenanceError: paths.length ? `tracked files changed: ${JSON.stringify(paths)}` : undefined,
      };
    }
  } catch {
    // A completed gate still returns its result when Git inspection is unavailable.
  }
  return { trackedClean: false, provenanceError: "execution provenance could not be confirmed" };
}

export const gateDigest = (gates: GateConfig) =>
  createHash("sha256").update(JSON.stringify(gates)).digest("hex");
export const protectedEntries = (cwd?: string): PrivateStrings => [
  ...loadPrivateStrings(undefined, [cwd]),
  ...registeredCredentials().map((value) => ({ value, entry: 1 })),
];

/** Actions work attaches only under its full binding and replays only completed, uninterrupted work. */
export const bound = (p: ActionsProgress | undefined, run?: string, sha?: string, key?: string) =>
  !!p?.owner && p.owner === run && p.headSha === sha && !!key && p.gateKey === key;
export const replayable = (p: ActionsProgress | undefined, run?: string, sha?: string, key?: string) =>
  p && !p.interrupted && bound(p, run, sha, key) ? p.completed : undefined;

/** Operational failure, never a gate result or feedback; unredactable detail keeps only its class. */
export class GateBlockedError extends Error {
  readonly classification: string;
  constructor(classification: string, message: string, cwd?: string) {
    super(`GitHub Actions gate blocked (${classification})`);
    this.classification = classification;
    try {
      this.message = redactPrivate(redactGateOutput(`${this.message}: ${message}`), protectedEntries(cwd));
    } catch {}
  }
}

/** Interrupted Actions work is cleaned up, then stays blocked: never replaced, redispatched or replayed. */
export async function blockInterrupted(handle: ExecutionHandle, ex?: GateExecutor, save = async () => {}) {
  const p = handle.githubActions;
  try {
    // Recorded only once cleanup succeeds, so a failed or unavailable cleanup is retried.
    if (!p?.interrupted || p.cleanupFailed) await cancelGateExecution(handle, ex);
    if (p?.cleanupFailed) throw new Error("cleanup remains pending");
    if (p) p.interrupted ??= "interrupted";
  } catch (error) {
    throw error instanceof GateBlockedError ? error : new GateBlockedError("cleanup", String(error), p?.cwd);
  } finally {
    await save();
  }
  throw new GateBlockedError(p?.interrupted ?? "interrupted", "interrupted execution is not replaced");
}

/** Shutdown detaches durable jobs; owner cancellation discards them. */
export const gateShutdown = (signal: AbortSignal): boolean =>
  signal.aborted && signal.reason instanceof Error && signal.reason.message === "shutdown";

const liveExecutions = new WeakMap<GateExecutor, Map<string, Execution<GateRun>>>();

/** Cancel live work or ask its owning executor to discard the durable identity. */
export async function cancelGateExecution(handle: ExecutionHandle, executor?: GateExecutor): Promise<void> {
  if (handle.kind !== "local" && executor?.kind !== handle.kind)
    throw new Error(`Unavailable gate executor: ${handle.kind}; cleanup remains pending`);
  const execution = executor?.kind === handle.kind ? liveExecutions.get(executor)?.get(handle.id) : undefined;
  if (execution) {
    await execution.cancel();
    await execution.result.catch(() => {});
  } else if (executor?.kind === handle.kind) {
    if (!executor.discard && handle.kind === "github-actions")
      throw new Error(`Unavailable gate executor cleanup: ${handle.kind}`);
    await executor.discard?.(handle);
  }
}

export function gateExecutorFor(
  kind: "local" | "lan",
  workers?: WorkerStore,
  repos: readonly string[] = [],
  inplace = false,
): GateExecutor {
  switch (kind) {
    case "local":
      return inplace && workers ? lanExecutor(workers, [], true) : localExecutor();
    case "lan":
      if (!workers) throw new Error("LAN executor requires a worker store");
      return lanExecutor(workers, repos);
  }
}

export function localExecutor(hooks: GateHooks = {}): GateExecutor {
  const executions = new Map<string, Execution<GateRun>>();
  const starts = new Map<
    string,
    { request: GateRequest; signal: AbortSignal; context: ReturnType<typeof AsyncLocalStorage.snapshot> }
  >();
  const executor: GateExecutor = {
    kind: "local",
    async start(request, signal) {
      signal.throwIfAborted();
      const id = randomUUID();
      starts.set(id, { request, signal, context: AsyncLocalStorage.snapshot() });
      return { kind: "local", id, startedAt: Date.now() };
    },
    attach(handle, signal, request, slotHooks = hooks) {
      const started = starts.get(handle.id);
      if (started) signal = AbortSignal.any([started.signal, signal]);
      const known = executions.get(handle.id);
      if (known) {
        if (signal.aborted) void known.cancel();
        else {
          const abort = () => void known.cancel();
          signal.addEventListener("abort", abort, { once: true });
          const cleanup = () => signal.removeEventListener("abort", abort);
          void known.result.then(cleanup, cleanup);
        }
        return known;
      }
      const req = request ?? started?.request;
      if (!req) throw new Error("Local gate execution is missing its request");
      const controller = new AbortController();
      const cancel = async () => {
        if (!controller.signal.aborted) controller.abort();
      };
      const abort = () => void cancel();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const results: ExecutionEvent[] = [];
      let done = false;
      let changed = Promise.withResolvers<void>();
      const notify = () => {
        const previous = changed;
        changed = Promise.withResolvers<void>();
        previous.resolve();
      };
      const local = bindGateSlotScope(runLocalGates);
      const run = (...args: Parameters<typeof runLocalGates>) =>
        started ? started.context(local, ...args) : local(...args);
      const result = run(
        req.cwd,
        {
          ...req.gates,
          checks: req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name)),
        },
        controller.signal,
        {
          onWait: slotHooks.onWait,
          holder: slotHooks.holder,
          skipGateSlot: req.skipGateSlot,
          priority: req.priority,
          env: req.env,
          onLocalSetup: slotHooks.onLocalSetup,
          onResult(r, phase) {
            results.push({ type: "check", phase, result: r });
            notify();
          },
        },
      ).finally(() => {
        executions.delete(handle.id);
        starts.delete(handle.id);
        done = true;
        notify();
        signal.removeEventListener("abort", abort);
      });
      const execution = {
        result,
        cancel,
        events: {
          async *[Symbol.asyncIterator]() {
            let index = 0;
            while (!done || index < results.length) {
              const event = results[index++];
              if (event) yield event;
              else {
                index--;
                await changed.promise;
              }
            }
            await result;
          },
        },
      };
      executions.set(handle.id, execution);
      return execution;
    },
  };
  liveExecutions.set(executor, executions);
  return executor;
}

/**
 * Start, checkpoint, attach and cancel through the same path for all daemon gates.
 * Interrupted Actions handles stay blocked; completed results bound to this request are reused.
 */
export async function executeGate(
  req: GateRequest,
  signal: AbortSignal,
  hooks: GateHooks = {},
  injected?: GateExecutor,
  stored?: ExecutionHandle,
  persist: (handle: ExecutionHandle) => Promise<void> = async () => {},
  onSettled: () => void = () => {},
): Promise<GateRun> {
  const executor =
    stored?.kind === "local" && injected?.kind !== "local"
      ? localExecutor(hooks)
      : (injected ?? localExecutor(hooks));
  if (stored && stored.kind !== executor.kind) throw new Error(`Unavailable gate executor: ${stored.kind}`);
  if (
    stored?.githubActions &&
    !replayable(stored.githubActions, req.runId, req.headSha, gateDigest(req.gates))
  )
    await blockInterrupted(stored, executor, () => persist(stored));
  const handle = stored ?? (await executor.start(req, signal));
  if (!stored) await persist(handle);
  let execution: Execution<GateRun>;
  try {
    execution = executor.attach(handle, signal, req, hooks, persist);
  } catch (error) {
    onSettled();
    throw error;
  }
  let live = liveExecutions.get(executor);
  if (!live) {
    live = new Map();
    liveExecutions.set(executor, live);
  }
  live.set(handle.id, execution);
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation ??= execution.cancel(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const events = (async () => {
      for await (const event of execution.events)
        if (event.type === "check") hooks.onResult?.(redactGateData(event.result), event.phase);
    })();
    const [result] = await Promise.all([execution.result, events]);
    if (handle.kind === "local") Object.assign(result, await gateProvenance(req.cwd, signal, req.headSha));
    return result;
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await cancellation;
    await execution.result.catch(() => {});
    live.delete(handle.id);
    onSettled();
  }
}
