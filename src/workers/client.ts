import { mkdirSync } from "node:fs";
import { cpus, hostname, release, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "../config.ts";
import { gateSlots } from "../gates/slots.ts";
import { agentEnv, sh } from "../util/proc.ts";
import { type Capabilities, timing } from "./protocol.ts";
import { certificate, privateFile, registerWorkerToken, workerRequest } from "./tls.ts";

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
      .object({ code: z.string(), secret: z.string(), expiresAt: z.number() })
      .parse(first.json());
    print(`Worker pairing code: ${pending.code}`);
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
    heartbeatMs?: number;
    machineState?: typeof machineState;
    request?: typeof workerRequest;
    retryMs?: number;
  } = {},
) {
  if (process.platform !== "darwin" && !options.machineState)
    throw new Error("Workers require macOS Seatbelt");
  const home = join(cfg.paths.home, "worker");
  mkdirSync(home, { recursive: true });
  const token = privateFile(join(home, "token")),
    pin = privateFile(join(home, "coordinator-fingerprint"));
  registerWorkerToken(token.value);
  try {
    const call = async (body: Capabilities) => {
      let delay = options.retryMs ?? 1000;
      for (;;) {
        signal.throwIfAborted();
        const reply = await (options.request ?? workerRequest)(coordinator, "/worker/heartbeat", body, {
          token: token.value,
          pin: pin.value,
          signal,
        }).catch(() => {
          signal.throwIfAborted();
          return undefined;
        });
        if (reply?.status === 200) return;
        if (reply && reply.status < 500)
          throw new Error(`Coordinator refused worker request (${reply.status})`);
        await sleep(delay, undefined, { signal });
        delay = Math.min(delay * 2, 10_000);
      }
    };
    while (!signal.aborted) {
      const slots = gateSlots.snapshot(),
        state = await (options.machineState ?? machineState)();
      await call({
        releaseSha,
        bunVersion: Bun.version,
        os: "darwin",
        osVersion: release(),
        cpuCount: cpus().length,
        ramBytes: totalmem(),
        freeSlots: Math.max(0, slots.limit - slots.occupied),
        ...state,
        jobs: [],
      });
      await sleep(options.heartbeatMs ?? timing.heartbeat, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    token.release();
    pin.release();
  }
}
