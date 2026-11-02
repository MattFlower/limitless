import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Repo } from "../core/types.ts";
import { probePushAccess } from "../git/repos.ts";
import { codexReaderProbe } from "../harness/codex.ts";
import { readPolicyScope } from "../harness/read-policy.ts";
import { type ConfinementBackend, platformConfinement } from "../harness/sandbox.ts";
import type { AgentSpec } from "../harness/types.ts";
import { type ClockSample, type ClockSource, windowOpen } from "../util/claim-clock.ts";
import { runProcess, sh } from "../util/proc.ts";
import { type CapabilityRunner, probeAgents } from "../workers/capabilities.ts";
import { machineState, verifyWorkerConfinement as preflight } from "../workers/client.ts";
import { Agents } from "../workers/protocol.ts";
export const CAPABILITY_FRESH_MS = 60_000;
export const CAPABILITY_REFRESH_MS = 30_000;
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const nullable = (pattern: RegExp) => z.string().regex(pattern).nullable();
const release = nullable(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const parity = z.enum(["match", "differs", "unknown"]);
const cli = object({ version: nullable(/^\d+\.\d+\.\d+$/), loggedIn: z.boolean() });
export const capabilitiesSchema = object({
  protocol: z.literal(1),
  release,
  checkpoints: z.array(z.literal([1, 2])),
  os: z.enum(["darwin", "linux"]),
  arch: z.enum(["arm64", "x64"]),
  confinement: object({
    backend: z.enum(["seatbelt", "bwrap-landlock"]),
    verified: z.boolean(),
    codex: object({ edit: z.boolean(), read: z.boolean(), confinedRead: z.boolean() }),
  }),
  agents: object({ claude: cli, codex: cli }),
  privateStrings: object({ parity, policy: nullable(/^[0-9a-f]{40}$/) }),
  freeSlots: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  power: z.enum(["ac", "battery", "unknown"]),
  draining: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Observed<T> = { at: ClockSample; value: T };
export type ProbeDeps = Partial<Pick<Capabilities, "release" | "arch">> & {
  cfg: Config;
  cwd: string;
  scratch: string;
  platform?: string;
  runner?: CapabilityRunner;
  confinement?: ConfinementBackend;
  codex?: (spec: AgentSpec) => Promise<{ ok: boolean; path: string | null }>;
  machineState?: typeof machineState;
  parity?: () => Capabilities["privateStrings"];
  slots: () => number;
  draining: () => boolean;
};
export type MonitorDeps = Omit<ProbeDeps, "cwd" | "scratch"> & {
  clock: ClockSource;
  timer?: (tick: () => void, ms: number) => () => void;
  pushAccess?: typeof probePushAccess;
};
export interface CapabilityMonitor {
  current(now: ClockSample): Observed<Capabilities> | null;
  refresh(signal?: AbortSignal): Promise<Observed<Capabilities>>;
  access(repo: Repo, signal?: AbortSignal): Promise<Observed<boolean>>;
  start(): () => void;
}
export async function probeCapabilities(deps: ProbeDeps, signal: AbortSignal): Promise<Capabilities> {
  const { cfg, cwd, scratch } = deps;
  const platform = deps.platform ?? process.platform;
  const safe = async <T>(probe: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await probe();
    } catch {
      signal.throwIfAborted();
      return fallback;
    }
  };
  signal.throwIfAborted();
  const agents = Agents.parse(await probeAgents(deps.runner ?? sh, signal, cfg.secrets));
  for (const agent of Object.values(agents))
    agent.version = agent.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  const confinement = deps.confinement ?? platformConfinement(cfg.port, platform);
  const verified = await safe(() => preflight(cfg, confinement, signal).then(() => true), false);
  const identity = { modelId: "", provider: "codex", model: "", vendor: "openai" };
  const codex: Capabilities["confinement"]["codex"] = { edit: false, read: false, confinedRead: false };
  for (const key of ["edit", "read", "confinedRead"] as const) {
    const spec: AgentSpec = {
      cwd,
      scratchDir: scratch,
      mode: key === "edit" ? "edit" : "readonly",
      ...(key === "confinedRead" ? { confineReads: true } : {}),
      prompt: "",
      target: { ...identity, harness: "codex", tier: 0, billing: "subscription" },
      timeoutMs: 30_000,
      idleTimeoutMs: 30_000,
      maxToolCalls: 1,
      signal,
      logPath: join(scratch, "probe.log"),
      onEvent: () => {},
    };
    codex[key] = await safe(async () => {
      const verdict = await (deps.codex ?? ((spec) => codexReaderProbe.verify(spec, runProcess)))(spec);
      return verdict.ok && verdict.path !== null;
    }, false);
  }
  const state =
    platform === "darwin" ? await safe(() => (deps.machineState ?? machineState)(platform), null) : null;
  signal.throwIfAborted();
  const backend = platform === "darwin" ? "seatbelt" : "bwrap-landlock";
  return capabilitiesSchema.parse({
    protocol: 1,
    checkpoints: [1, 2],
    release: release.safeParse(deps.release).data ?? null,
    os: platform,
    arch: deps.arch ?? process.arch,
    confinement: { backend, verified, codex },
    agents,
    privateStrings: deps.parity?.() ?? { parity: "unknown", policy: null },
    freeSlots: deps.slots(),
    power: state === null ? "unknown" : state.onAC ? "ac" : "battery",
    draining: deps.draining(),
  });
}
function interval(tick: () => void, ms: number) {
  const id = setInterval(tick, ms);
  return () => clearInterval(id);
}
function wait<T>(flight: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return flight;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    flight.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createCapabilityMonitor(deps: MonitorDeps): CapabilityMonitor {
  const captured = AsyncLocalStorage.snapshot();
  const own = new AbortController();
  let dir: string | undefined;
  let clear: (() => void) | undefined;
  const context = <T>(probe: () => Promise<T>) =>
    captured(() => readPolicyScope.run(deps.cfg.readPolicy, async () => probe()));
  function cache<T>(probe: () => Promise<T>, duration: number) {
    let value: Observed<T> | null = null;
    let last: Observed<Promise<Observed<T>>> | undefined;
    let running = false;
    let failed = false;
    return {
      current: (now: ClockSample) => (value && windowOpen(value.at, now, CAPABILITY_FRESH_MS) ? value : null),
      async refresh(signal?: AbortSignal): Promise<Observed<T>> {
        signal?.throwIfAborted();
        own.signal.throwIfAborted();
        const at = deps.clock.sample();
        const age = last ? at.inclusive - last.at.inclusive : Infinity;
        if (!last || (!running && age >= (failed ? CAPABILITY_REFRESH_MS : duration))) {
          running = true;
          const result = context(probe)
            .then((result) => {
              own.signal.throwIfAborted();
              failed = false;
              running = false;
              value = { at, value: result };
              return value;
            })
            .catch((error: unknown) => {
              failed = true;
              running = false;
              throw error;
            });
          last = { at, value: result };
        }
        return wait(last.value, signal);
      },
      settled: () => last?.value ?? Promise.resolve(),
    };
  }
  const capabilities = cache(async () => {
    if (!dir) {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-member-capabilities-")));
      for (const name of ["cwd", "scratch"]) mkdirSync(join(dir, name));
    }
    return probeCapabilities({ ...deps, cwd: join(dir, "cwd"), scratch: join(dir, "scratch") }, own.signal);
  }, CAPABILITY_REFRESH_MS);
  const access = new Map<string, ReturnType<typeof cache<boolean>>>();
  return {
    current: capabilities.current,
    refresh: capabilities.refresh,
    access(repo, signal) {
      const key = repo.url ?? `local:${repo.id}`;
      const probe = () => (deps.pushAccess ?? probePushAccess)(deps.cfg.paths, repo, own.signal);
      const entry = access.get(key) ?? cache(probe, CAPABILITY_FRESH_MS);
      access.set(key, entry);
      return entry.refresh(signal);
    },
    start() {
      const tick = () => void capabilities.refresh().catch(() => {});
      if (!clear && !own.signal.aborted) {
        tick();
        clear = (deps.timer ?? interval)(tick, CAPABILITY_REFRESH_MS);
      }
      return () => {
        clear?.();
        own.abort();
        const remove = () => dir && rmSync(dir, { recursive: true, force: true });
        const settled = capabilities.settled();
        void settled.then(remove, remove).catch(() => {});
      };
    },
  };
}
