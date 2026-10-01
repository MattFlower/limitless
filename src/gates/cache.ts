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

/**
 * Gate-relevant variables known to be nonsecret settings: values are hashed, never stored. Some
 * (GOPRIVATE, NODE_TLS_REJECT_UNAUTHORIZED) look like credentials to SECRET_NAME but aren't.
 */
const GATE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "TZ",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "GEM_HOME",
  "GEM_PATH",
  "CC",
  "CXX",
  "CFLAGS",
  "CXXFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "PKG_CONFIG_PATH",
  "CGO_ENABLED",
  "GOROOT",
  "GOPATH",
  "GOFLAGS",
  "GOOS",
  "GOARCH",
  "GOPROXY",
  "GOPRIVATE",
  "GONOSUMDB",
  "GOTOOLCHAIN",
  "GOEXPERIMENT",
  "GOMODCACHE",
  "GOINSECURE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]);
/**
 * Toolchain configuration families (npm/Bun/Node, dynamic linker, Rust, Python, JVM, locale).
 * These admit credentials too (`npm_config__authToken`, `CARGO_REGISTRY_TOKEN`), so names matched
 * only by prefix are also screened by SECRET_NAME.
 */
const GATE_ENV_PREFIXES =
  /^(npm_config_|NPM_CONFIG_|BUN_|NODE_|YARN_|PNPM_|COREPACK_|LD_|DYLD_|LC_|CARGO_|RUST|PYTHON|PIP_|UV_|POETRY_|JAVA_|JDK_|GRADLE_|MAVEN_)/;
const SECRET_NAME = /TOKEN|SECRET|PASS|AUTH|CRED|KEY|PRIVATE|SESSION|COOKIE/i;

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

/**
 * Digest of the gate-relevant part of the environment gates run with: the known toolchain
 * variables plus `extra` (config `[gates] baseline_env`). Names known or declared to be gate
 * settings are always included; a prefix-family name is included only if it doesn't look secret.
 */
export function gateEnvDigest(env: Record<string, string>, extra: readonly string[] = []): string {
  const relevant = (k: string) =>
    GATE_ENV_VARS.has(k) || extra.includes(k) || (GATE_ENV_PREFIXES.test(k) && !SECRET_NAME.test(k));
  const entries = Object.keys(env)
    .filter(relevant)
    .sort()
    .map((k) => [k, env[k]]);
  return sha256(JSON.stringify(entries));
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

const flights = new Map<string, Promise<boolean>>();

/** Resolves with whether the flight's result can be reused; a rejected flight can't. */
function settled(flight: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    flight.then(resolve, () => resolve(false));
    flight.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

/**
 * Run `fn` once per key at a time: a concurrent caller waits, then runs (and usually hits the cache).
 * When a flight's result is not `reusable`, there is nothing to hit, so its waiters run concurrently.
 */
export async function singleFlight<T>(
  key: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
  reusable: (result: T) => boolean,
): Promise<T> {
  for (let prior = flights.get(key); prior; prior = flights.get(key))
    if (!(await settled(prior, signal))) return fn();
  const result = fn();
  const flight = result.then(reusable, () => false);
  flights.set(key, flight);
  try {
    return await result;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}
