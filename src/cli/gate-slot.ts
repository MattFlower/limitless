import { spawn } from "node:child_process";
import { constants } from "node:os";
import { parseArgs } from "node:util";
import { bounded, type DeployClock, deployClock, parseMaxWait } from "./deploy-wait.ts";

type Reply = { id: string; acquired: boolean; expired?: boolean };
export type LeaseClient = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Reply>;
class LeaseRejected extends Error {}
export const localLeaseClient =
  (port = Number(process.env.LIMITLESS_PORT ?? 7400)): LeaseClient =>
  async (body, signal) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/gate-slot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if ([404, 405, 501].includes(response.status)) throw new Error("gate-slot endpoint unsupported");
    if (!response.ok) throw new LeaseRejected(`gate-slot: HTTP ${response.status}`);
    const result: Reply = await response.json().catch(() => {
      throw new LeaseRejected("invalid gate-slot JSON");
    });
    if (
      typeof result?.id !== "string" ||
      !result.id ||
      typeof result.acquired !== "boolean" ||
      (result.expired !== undefined && typeof result.expired !== "boolean") ||
      (result.expired && result.acquired)
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
}
export async function withGateLease<T>(
  name: string,
  work: () => Promise<T>,
  opts: LeaseOptions = {},
): Promise<T> {
  const client = opts.client ?? localLeaseClient(),
    clock = opts.clock ?? deployClock;
  const maxWait = opts.maxWaitMs ?? 1_800_000,
    deadline = clock.now() + maxWait;
  if (!name.trim() || !Number.isSafeInteger(maxWait) || maxWait < 0)
    throw new Error("invalid gate-slot name or wait budget");
  const warn = (e: unknown) =>
    (opts.warn ?? console.warn)(`warning: gate-slot coordination unavailable: ${e}`);
  let id: string | undefined,
    stopped = false,
    cancel = () => {};
  const request = (body: Record<string, unknown>, ms = 2000) =>
    bounded(
      clock,
      async (signal) => {
        const result = await client(body, signal);
        // A transport may finish after its deadline; retire even a late reservation.
        if (signal.aborted && !body.release) void request({ id: result.id, release: true }).catch(warn);
        return result;
      },
      ms,
    );
  const release = async () => {
    if (id) await request({ id, release: true }).catch(warn);
  };
  try {
    try {
      opts.signal?.throwIfAborted();
      let state = await request({ name, immediate: maxWait === 0 }, maxWait ? Math.min(2000, maxWait) : 2000);
      id = state.id;
      while (!state.acquired) {
        opts.signal?.throwIfAborted();
        if (clock.now() >= deadline) throw new Error("gate-slot acquisition deadline exceeded");
        await clock.sleep(Math.min(250, deadline - clock.now()));
        if (clock.now() >= deadline) throw new Error("gate-slot acquisition deadline exceeded");
        state = await request({ id }, Math.max(1, Math.min(2000, deadline - clock.now())));
        if (state.expired) throw new Error("gate-slot lease expired");
      }
      if (maxWait && clock.now() >= deadline) throw new Error("gate-slot acquisition deadline exceeded");
      const beat = () => {
        cancel = clock.timeout(() => {
          void request({ id })
            .then((r) => {
              if (r.expired) throw new Error("gate-slot lease expired");
              if (!stopped) beat();
            })
            .catch(warn);
        }, 10_000);
      };
      beat();
    } catch (e) {
      await release();
      id = undefined;
      if (e instanceof LeaseRejected || opts.signal?.aborted) throw e;
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
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
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
    return await withGateLease(
      values.name ?? executable,
      () =>
        new Promise<number>((resolve, reject) => {
          child = spawn(executable, command.slice(1), { stdio: "inherit", detached: true });
          child.once("error", reject);
          child.once("exit", (code, signal) =>
            resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)),
          );
        }),
      { client, maxWaitMs, signal: controller.signal },
    );
  } finally {
    process.off("SIGINT", int);
    process.off("SIGTERM", term);
  }
}
