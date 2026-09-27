import type { DrainState, HealthResponse, Run, RunDetail } from "../core/types.ts";

export const DEFAULT_MAX_WAIT_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 5000;

export function parseMaxWait(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_WAIT_MS;
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds * 1000)) {
    throw new Error("--max-wait must be a non-negative integer number of seconds within the safe range");
  }
  return seconds * 1000;
}

export interface DeployClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  timeout(fn: () => void, ms: number): () => void;
}

export const deployClock: DeployClock = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
  timeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** The running daemon has no drain endpoint: it predates graceful deploys. */
export class DrainUnsupportedError extends Error {}

export interface DeployClient {
  admin(action: "drain" | "resume", signal: AbortSignal): Promise<DrainState>;
  health(signal: AbortSignal): Promise<HealthResponse>;
  run(id: string, signal: AbortSignal): Promise<Pick<Run, "stage">>;
}

function validDrain(value: unknown): value is DrainState {
  if (!value || typeof value !== "object") return false;
  return (
    "draining" in value &&
    typeof value.draining === "boolean" &&
    "active" in value &&
    Array.isArray(value.active) &&
    value.active.every((id: unknown) => typeof id === "string")
  );
}

export function validateHealth(value: unknown): HealthResponse {
  if (
    !validDrain(value) ||
    !("ok" in value) ||
    value.ok !== true ||
    !("uptimeMs" in value) ||
    typeof value.uptimeMs !== "number" ||
    !Number.isFinite(value.uptimeMs) ||
    value.uptimeMs < 0
  ) {
    throw new Error("invalid or unhealthy daemon health response");
  }
  const sha = "sha" in value && typeof value.sha === "string" ? value.sha.trim() : "";
  return { ...value, sha: sha || "unknown" } as HealthResponse;
}

export function localDeployClient(port: number): DeployClient {
  async function request(path: string, signal: AbortSignal, method = "GET"): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal,
      headers: { "content-type": "application/json" },
    });
    if (response.status === 404 && path.startsWith("/api/admin/"))
      throw new DrainUnsupportedError(`${method} ${path}: HTTP 404`);
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }
  return {
    async admin(action, signal) {
      const result = await request(`/api/admin/${action}`, signal, "POST");
      if (!validDrain(result)) throw new Error(`invalid ${action} response`);
      return result;
    },
    async health(signal) {
      return validateHealth(await request("/api/health", signal));
    },
    async run(id, signal) {
      const detail = (await request(`/api/runs/${encodeURIComponent(id)}`, signal)) as RunDetail;
      if (!detail?.run) throw new Error("invalid run detail");
      return detail.run;
    },
  };
}

/** The race also bounds injected clients that fail to honor cancellation. */
export async function bounded<T>(
  clock: DeployClock,
  operation: (signal: AbortSignal) => Promise<T>,
  ms = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let cancel = () => {};
  const timeout = new Promise<never>((_, reject) => {
    cancel = clock.timeout(() => {
      reject(new Error("daemon request timed out"));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    cancel();
    controller.abort();
  }
}

export async function requestAdmin(
  client: DeployClient,
  clock: DeployClock,
  action: "drain" | "resume",
): Promise<void> {
  const state = await bounded(clock, (signal) => client.admin(action, signal));
  if (!validDrain(state) || state.draining !== (action === "drain")) {
    throw new Error(`daemon did not acknowledge ${action}`);
  }
}

export async function waitForDrain(
  client: DeployClient,
  clock: DeployClock,
  maxWaitMs: number,
  now: boolean,
  log: (message: string) => void,
): Promise<void> {
  const start = clock.now();
  const remaining = () => Math.max(0, maxWaitMs - (clock.now() - start));
  // Even immediate deployments verify that the daemon supports the drain protocol.
  const budget = () =>
    now || maxWaitMs === 0 ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, remaining());
  let health = validateHealth(await bounded(clock, (signal) => client.health(signal), budget()));
  for (;;) {
    if (!health.draining) throw new Error("daemon resumed unexpectedly while deploying");
    if (!health.active.length) {
      log(
        `${now ? "--now: restarting immediately; " : ""}Drain complete: no active runs (${Math.floor((clock.now() - start) / 1000)}s elapsed)`,
      );
      return;
    }
    if (!now && remaining() > 0) {
      log(
        `Draining (${Math.ceil(remaining() / 1000)}s remaining); active run IDs: ${health.active.join(", ")}`,
      );
    }
    const stages = await Promise.all(
      health.active.map(async (id) => {
        if (now || remaining() === 0) return `${id} (unknown stage)`;
        try {
          const run = await bounded(clock, (signal) => client.run(id, signal), budget());
          return `${id} (${run.stage ?? "unknown stage"})`;
        } catch {
          return `${id} (unknown stage)`;
        }
      }),
    );
    const active = stages.join(", ");
    if (now) {
      log(`--now: restarting immediately; active runs: ${active}`);
      return;
    }
    if (remaining() === 0) {
      log(
        `Drain timeout after ${Math.floor((clock.now() - start) / 1000)}s; restarting with active runs: ${active}`,
      );
      return;
    }
    log(`Draining (${Math.ceil(remaining() / 1000)}s remaining); active runs: ${active}`);
    await clock.sleep(Math.min(5000, remaining()));
    if (remaining() === 0) {
      log(
        `Drain timeout after ${Math.floor((clock.now() - start) / 1000)}s; restarting with active runs: ${active}`,
      );
      return;
    }
    health = validateHealth(await bounded(clock, (signal) => client.health(signal), budget()));
  }
}

export async function waitForHealthy(
  client: DeployClient,
  clock: DeployClock,
  target: string,
  log: (message: string) => void = console.warn,
): Promise<HealthResponse> {
  const start = clock.now();
  let lastError: unknown;
  while (clock.now() - start < 45_000) {
    try {
      const state = validateHealth(
        await bounded(
          clock,
          (signal) => client.health(signal),
          Math.min(2000, 45_000 - (clock.now() - start)),
        ),
      );
      if (state.sha !== "unknown" && state.sha !== target) {
        lastError = new Error(`replacement daemon runs ${state.sha}, expected ${target}`);
      } else if (!state.draining) {
        if (state.sha === "unknown")
          log("warning: replacement daemon does not report a boot SHA; cannot verify its commit");
        return state;
      } else lastError = new Error("replacement daemon is still draining");
    } catch (error) {
      lastError = error;
    }
    await clock.sleep(Math.min(1000, Math.max(0, 45_000 - (clock.now() - start))));
  }
  throw new Error(`new version is unhealthy: ${String(lastError)}`);
}
