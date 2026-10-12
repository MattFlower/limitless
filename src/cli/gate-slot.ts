import { spawn } from "node:child_process";
import { constants } from "node:os";
import { parseArgs } from "node:util";
import { GATE_LEASE_EXPIRY_MS } from "../gates/slots.ts";
import { redactCredentials } from "../util/proc.ts";
import { apiTokenHeaders } from "./api-token.ts";
import { resolveClientPort } from "./client-port.ts";
import { bounded, DaemonTimeoutError, type DeployClock, deployClock, parseMaxWait } from "./deploy-wait.ts";

type Reply = {
  id: string;
  acquired: boolean;
  expired?: boolean;
  busy?: boolean;
  reused?: boolean;
  capped?: boolean;
  capMs?: number;
  holder?: string;
};
export type LeaseClient = (
  body: Record<string, unknown>,
  signal: AbortSignal,
  /** A timed-out transport can still return a lease that must be adopted or released. */
  onLateReply?: (reply: Reply) => void,
  /** Retain transport diagnostics even when the enclosing request budget expires. */
  onFailure?: (error: unknown) => void,
) => Promise<Reply>;
export class LeaseRejected extends Error {}
class LeaseWaitExhausted extends LeaseRejected {}
function transportDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  const cause = "cause" in error && error.cause !== error ? `; cause: ${String(error.cause)}` : "";
  return `${error}${code}${cause}`;
}
export class LeaseTransportFailures extends Error {
  constructor(
    readonly http: unknown,
    readonly unix: unknown,
    readonly preconnection: boolean,
  ) {
    super(redactCredentials(`HTTP: ${transportDetail(http)}; Unix socket: ${transportDetail(unix)}`));
  }
}
export const localLeaseClient =
  (port?: number, unix?: string): LeaseClient =>
  async (body, signal) => {
    const url = `http://127.0.0.1:${port ?? resolveClientPort()}/api/admin/gate-slot`;
    const response = await fetch(url, {
      method: "POST",
      // An agent's per-invocation capability is its only credential; the daemon accepts it for this route only.
      headers: {
        "content-type": "application/json",
        ...(typeof body.token === "string"
          ? { authorization: `Bearer ${body.token}` }
          : apiTokenHeaders(url)),
      },
      body: JSON.stringify(body),
      signal,
      ...(unix ? { unix } : {}),
    });
    if ([404, 405, 501].includes(response.status) && body.token === undefined)
      throw new Error("gate-slot endpoint unsupported");
    if (!response.ok) {
      // Keep the daemon's reason (an authentication error names the fix); it is redacted before display.
      const detail: unknown = await response.json().catch(() => undefined);
      const message =
        detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string"
          ? `: ${redactCredentials(detail.error)}`
          : "";
      throw new LeaseRejected(`gate-slot: HTTP ${response.status}${message}`);
    }
    const result: Reply = await response.json().catch(() => {
      throw new LeaseRejected("invalid gate-slot JSON");
    });
    if (
      typeof result?.id !== "string" ||
      (!result.id && result.busy !== true) ||
      typeof result.acquired !== "boolean" ||
      (result.expired !== undefined && typeof result.expired !== "boolean") ||
      (result.expired && result.acquired) ||
      (result.busy !== undefined && typeof result.busy !== "boolean") ||
      (result.busy && (result.acquired || result.id !== "")) ||
      (result.reused !== undefined && typeof result.reused !== "boolean") ||
      (result.capped !== undefined && typeof result.capped !== "boolean") ||
      (result.capped && (!result.expired || result.acquired)) ||
      (result.capMs !== undefined && (!Number.isFinite(result.capMs) || result.capMs <= 0)) ||
      (result.holder !== undefined && typeof result.holder !== "string")
    )
      throw new LeaseRejected("invalid gate-slot response");
    return result;
  };

export interface LeaseOptions {
  client?: LeaseClient;
  clock?: DeployClock;
  maxWaitMs?: number;
  signal?: AbortSignal;
  warn?: (s: string) => void;
  /** Agent wrappers fail on queue exhaustion and prove nested reuse and running recovery. */
  agentTest?: { lane: string; parentId?: string; onLease: (id: string) => void };
}
export async function withGateLease<T>(
  name: string,
  work: () => Promise<T>,
  opts: LeaseOptions = {},
): Promise<T> {
  const client = opts.client ?? localLeaseClient(),
    clock = opts.clock ?? deployClock;
  const maxWait = opts.maxWaitMs ?? 1_800_000,
    started = clock.now(),
    deadline = started + maxWait;
  if (!name.trim() || !Number.isSafeInteger(maxWait) || maxWait < 0)
    throw new Error("invalid gate-slot name or wait budget");
  const warn = (e: unknown) =>
    (opts.warn ?? console.warn)(redactCredentials(`warning: gate-slot coordination unavailable: ${e}`));
  let id: string | undefined,
    stopped = false,
    cancel = () => {},
    lastReply = clock.now();
  const beat = (ms = 10_000) => {
    cancel();
    cancel = clock.timeout(() => {
      const leaseId = id;
      void request({ id: leaseId })
        .then(async (r) => {
          if (r.capped && opts.agentTest) {
            (opts.warn ?? console.warn)(
              `warning: agent-test ${name} reached its ${r.capMs ?? "unknown"}ms duration cap (${opts.agentTest.lane} lane); letting the command finish`,
            );
            return;
          }
          if (r.expired && !stopped && id === leaseId) {
            await request({ name, running: true, ...(opts.agentTest ? { recover: leaseId } : {}) });
          }
          if (!stopped) beat();
        })
        .catch((e) => {
          warn(e);
          if (!stopped && !(opts.agentTest && e instanceof LeaseRejected)) beat(1000);
        });
    }, ms);
  };
  const request = async (body: Record<string, unknown>, ms = 2000) => {
    let failure: unknown;
    try {
      return await bounded(
        clock,
        async (signal) => {
          const previous = id;
          const observe = (result: Reply, late = false) => {
            lastReply = clock.now();
            // A late recovery still belongs to running work unless another reply recovered it first.
            if (body.running && !stopped && id === previous && result.id && !result.busy && !result.capped) {
              id = result.id;
              opts.agentTest?.onLease(result.id);
              beat();
            } else if (
              body.name &&
              result.id &&
              (late || signal.aborted || body.running) &&
              (stopped || result.id !== id)
            )
              void request({ id: result.id, release: true }).catch(warn);
          };
          const result = await client(
            body,
            signal,
            (result) => observe(result, true),
            (error) => {
              failure = error;
            },
          );
          observe(result);
          return result;
        },
        ms,
      );
    } catch (error) {
      throw error instanceof DaemonTimeoutError && failure ? failure : error;
    }
  };
  const release = async () => {
    if (id) await request({ id, release: true }).catch(warn);
  };
  try {
    try {
      opts.signal?.throwIfAborted();
      let reused = false;
      let state: Reply | undefined;
      let first = true,
        holder: string | undefined,
        failure: unknown,
        parentChecked = false;
      const pastDeadline = () =>
        opts.agentTest
          ? new LeaseWaitExhausted(
              redactCredentials(
                `agent-test: ${name} waited ${clock.now() - started}ms for the ${opts.agentTest.lane} lane` +
                  `${holder ? ` (holder: ${holder})` : ""}; try a targeted run: bun test <file>` +
                  `${failure ? `; last failure: ${failure}` : ""}`,
              ),
            )
          : new Error("gate-slot wait passed the acquisition deadline");
      while (!state?.acquired) {
        opts.signal?.throwIfAborted();
        if (!first) {
          if (clock.now() >= deadline) throw pastDeadline();
          await clock.sleep(Math.min(250, deadline - clock.now()));
          if (clock.now() >= deadline) throw pastDeadline();
        }
        try {
          if (opts.agentTest?.parentId && !parentChecked) {
            const parent = await request(
              { reuse: opts.agentTest.parentId },
              maxWait ? Math.max(1, Math.min(2000, deadline - clock.now())) : 2000,
            );
            parentChecked = true;
            if (parent.reused === true && parent.acquired && parent.id === opts.agentTest.parentId) {
              opts.agentTest.onLease(parent.id);
              reused = true;
              state = parent;
              break;
            }
            if (maxWait && clock.now() >= deadline) throw pastDeadline();
          }
          state = await request(
            id ? { id } : { name, immediate: maxWait === 0 },
            maxWait ? Math.max(1, Math.min(2000, deadline - clock.now())) : 2000,
          );
          id = state.busy ? undefined : state.id;
          holder = state.holder ?? holder;
        } catch (e) {
          if (e instanceof LeaseRejected || opts.signal?.aborted) throw e;
          failure = e;
          // Agent commands wait through stalls; silence alone cannot justify running unslotted.
          if (
            opts.agentTest
              ? first && e instanceof LeaseTransportFailures && e.preconnection
              : (first && !(e instanceof DaemonTimeoutError)) ||
                clock.now() - lastReply > GATE_LEASE_EXPIRY_MS
          )
            throw opts.agentTest ? e : new Error(`gate-slot daemon is unreachable: ${e}`);
          if (clock.now() >= deadline) throw pastDeadline();
        }
        first = false;
        if (state?.expired && maxWait) {
          if (opts.agentTest) throw new LeaseRejected("agent-test lease expired while waiting");
          throw new Error("gate-slot lease expired");
        }
      }
      if (!reused && maxWait && clock.now() >= deadline) throw pastDeadline();
      if (id) opts.agentTest?.onLease(id);
      if (!reused) beat();
    } catch (e) {
      await release();
      id = undefined;
      if (e instanceof LeaseRejected || opts.signal?.aborted) throw e;
      if (opts.agentTest && !(e instanceof LeaseTransportFailures && e.preconnection)) throw e;
      warn(e);
    }
    opts.signal?.throwIfAborted();
    return await work();
  } finally {
    stopped = true;
    cancel();
    await release();
  }
}

export async function gateSlotCommand(args: string[], client?: LeaseClient): Promise<number> {
  const split = args.indexOf("--"),
    command = args.slice(split + 1);
  const { values } = parseArgs({
    args: args.slice(0, split < 0 ? args.length : split),
    options: { name: { type: "string" }, "max-wait": { type: "string" } },
  });
  const executable = command[0],
    maxWaitMs = parseMaxWait(values["max-wait"] ?? "1800");
  if (split < 0 || !executable)
    throw new Error("usage: limitless gate-slot [--name holder] [--max-wait seconds] -- command...");
  return runLeasedCommand(command, { client, name: values.name ?? executable, maxWaitMs });
}

/** The wrapper and gate-slot CLI share process-group signal and exit-code handling. */
export async function runLeasedCommand(
  command: string[],
  lease?: LeaseOptions & { name: string },
  signalExitCode = false,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const executable = command[0];
  if (!executable) throw new Error("missing executable");
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal;
    controller.abort();
    if (child?.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already exited */
      }
    }
  };
  const int = () => interrupt("SIGINT"),
    term = () => interrupt("SIGTERM");
  process.on("SIGINT", int);
  process.on("SIGTERM", term);
  try {
    const work = () =>
      new Promise<number>((resolve, reject) => {
        child = spawn(executable, command.slice(1), { stdio: "inherit", detached: true, env });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
      });
    return await (lease ? withGateLease(lease.name, work, { ...lease, signal: controller.signal }) : work());
  } catch (error) {
    if (signalExitCode && interrupted) return 128 + constants.signals[interrupted];
    if (error instanceof LeaseWaitExhausted) {
      (lease?.warn ?? console.warn)(error.message);
      return 75;
    }
    throw error;
  } finally {
    process.off("SIGINT", int);
    process.off("SIGTERM", term);
  }
}
