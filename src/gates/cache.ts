import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineCacheKey } from "../db/store.ts";
import type { GateConfig } from "./detect.ts";
import type { GateResult, GateRun } from "./run.ts";

/** Bump whenever how gates execute changes (environment, retries, result shape): old entries then miss. */
export const GATE_ENV_VERSION = 2;
export const BASELINE_CACHE_TTL_MS = 7 * 86_400_000;

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
];

/** Gate-relevant variables only; values are hashed, never stored, and secrets are never read. */
const GATE_ENV_VARS = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_INSTALL",
  "GOPATH",
  "GOFLAGS",
  "CARGO_HOME",
  "RUSTFLAGS",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "JAVA_HOME",
];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}

/** Key-order-independent hash of the gate configuration detected from the base commit. */
export function gatesHash(cfg: GateConfig): string {
  return sha256(JSON.stringify(stable(cfg)));
}

/** Hash of the root lockfiles present in `dir`. */
export function lockfileHash(dir: string): string {
  const hash = createHash("sha256");
  for (const name of LOCKFILES) {
    const path = join(dir, name);
    if (existsSync(path)) hash.update(`${name}\0`).update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

/** Digest of the gate-relevant part of the environment gates run with. */
export function gateEnvDigest(env: Record<string, string>): string {
  return sha256(JSON.stringify(GATE_ENV_VARS.map((k) => [k, env[k] ?? null])));
}

export interface BaselineKeyInputs {
  repoId: string;
  baseSha: string;
  gates: GateConfig;
  lockfileHash: string;
  bunVersion: string;
  platform: string;
  arch: string;
  buildSha: string;
  envDigest: string;
}

export function baselineCacheKey(i: BaselineKeyInputs): BaselineCacheKey {
  const { repoId, baseSha, gates, ...env } = i;
  return {
    repoId,
    baseSha,
    gatesHash: gatesHash(gates),
    envHash: sha256(JSON.stringify(stable({ ...env, version: GATE_ENV_VERSION }))),
  };
}

/** A shell reports a child killed by signal N as 128+N, so those exits are interruptions too. */
function finished(r: GateResult): boolean {
  return (
    r.exitCode !== null && r.exitCode <= 128 && !r.timedOut && (!r.firstAttempt || finished(r.firstAttempt))
  );
}

/**
 * Whether a baseline may be cached: setup and every configured check ran and passed. A failing
 * baseline is never cached, so a flaky base failure can't hide later regressions as `still_failing`.
 */
export function cacheableBaseline(run: GateRun, cfg: GateConfig): boolean {
  return (
    run.setupOk &&
    run.setup.length === cfg.setup.length &&
    run.checks.length === cfg.checks.length &&
    run.checks.every((c, i) => c.name === cfg.checks[i]?.name && c.command === cfg.checks[i]?.run) &&
    [...run.setup, ...run.checks].every((r) => r.ok && finished(r))
  );
}

const flights = new Map<string, Promise<unknown>>();

function settled(flight: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    flight.then(
      () => resolve(),
      () => resolve(),
    );
    flight.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

/** Run `fn` once per key at a time: a concurrent caller waits, then runs (and usually hits the cache). */
export async function singleFlight<T>(key: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  for (let prior = flights.get(key); prior; prior = flights.get(key)) await settled(prior, signal);
  const flight = fn();
  flights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}
