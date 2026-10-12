import { createServer } from "node:net";
import type { DiffInfo } from "../git/repos.ts";
import { runConfined, withCommandScratch } from "../harness/sandbox.ts";
import { createScratch, removeScratch } from "../harness/scratch.ts";
import { agentEnv, ProcessTerminationError, type ProcResult } from "../util/proc.ts";

export interface PreviewConfig {
  paths: string[];
  build: string;
  serve: string;
  seed?: string;
  ready: string;
  env: Record<string, string>;
}

function command(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid [preview].${key}: expected a nonempty command`);
  return value;
}

export function readPreviewConfig(contents: string | null): PreviewConfig | null {
  if (contents === null) return null;
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(contents) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid .limitless.toml: ${(error as Error).message}`);
  }
  if (raw.preview === undefined) return null;
  const p = raw.preview;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Invalid [preview]: expected a table");
  const v = p as Record<string, unknown>;
  if (
    !Array.isArray(v.paths) ||
    !v.paths.length ||
    !v.paths.every((path) => typeof path === "string" && /^(?!\/|\.)(?!.*\.\.)[^*]+\/$/.test(path))
  )
    throw new Error("Invalid [preview].paths: expected nonempty relative directory prefixes ending in /");
  if (
    !v.env ||
    typeof v.env !== "object" ||
    Array.isArray(v.env) ||
    !Object.entries(v.env).every(
      ([key, value]) =>
        /^[A-Za-z_][A-Za-z_0-9]*$/.test(key) && typeof value === "string" && !value.includes(".."),
    )
  )
    throw new Error('Invalid [preview].env: expected string variables without ".."');
  if (typeof v.ready !== "string" || !v.ready.startsWith("/") || v.ready.startsWith("//"))
    throw new Error("Invalid [preview].ready: expected an absolute URL path");
  readinessUrl(v.ready, "http://127.0.0.1");
  if (v.seed !== undefined) command(v.seed, "seed");
  return {
    paths: v.paths as string[],
    build: command(v.build, "build"),
    serve: command(v.serve, "serve"),
    ...(v.seed === undefined ? {} : { seed: v.seed as string }),
    ready: v.ready,
    env: v.env as Record<string, string>,
  };
}

function readinessUrl(ready: string, previewUrl: string): URL {
  const url = new URL(ready, previewUrl);
  if (url.origin !== new URL(previewUrl).origin)
    throw new Error("Invalid [preview].ready: must have the preview origin");
  return url;
}

export function needsPreview(config: PreviewConfig | null, diff: DiffInfo): boolean {
  return Boolean(
    config &&
      diff.files.some((file) =>
        [file.path, file.from].some((path) => path && config.paths.some((prefix) => path.startsWith(prefix))),
      ),
  );
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("No preview port")),
      );
    });
  });
}

export interface Preview {
  url: string;
  scratch: string;
  stop(): Promise<void>;
}

export async function startPreview(
  cwd: string,
  config: PreviewConfig,
  signal: AbortSignal,
  readinessMs = 20_000,
  commandTimeoutMs = 120_000,
): Promise<Preview> {
  const scratch = createScratch(cwd);
  const controller = new AbortController();
  const commandSignal = AbortSignal.any([signal, controller.signal]);
  let serving: Promise<ProcResult> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      await serving?.catch((error: unknown) => {
        if (error instanceof ProcessTerminationError) throw error;
      });
      removeScratch(scratch);
    })();
    return stopping;
  };
  const onAbort = () => {
    void stop();
  };
  return withCommandScratch(
    cwd,
    async () => {
      try {
        if (signal.aborted) throw new Error("Preview cancelled");
        const port = await availablePort();
        const url = `http://127.0.0.1:${port}`;
        const readyUrl = readinessUrl(config.ready, url);
        if (Object.values(config.env).some((value) => value.includes("..")))
          throw new Error('Invalid [preview].env: values must not contain ".."');
        const expanded = Object.fromEntries(
          Object.entries(config.env).map(([key, value]) => [
            key,
            value.replaceAll("{scratch}", scratch).replaceAll("{port}", String(port)),
          ]),
        );
        const reserved = agentEnv();
        const env = { ...reserved, ...expanded };
        for (const key of Object.keys(env)) {
          if (key === "GH_TOKEN" || key.startsWith("GIT_")) {
            delete env[key];
            if (reserved[key] !== undefined) env[key] = reserved[key];
          }
        }
        Object.assign(env, {
          HOME: scratch,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          LIMITLESS_NO_SCHEDULER: "1",
        });
        for (const [step, commandText] of [
          ["build", config.build],
          ["seed", config.seed],
        ] as const) {
          if (!commandText) continue;
          const result = await runConfined({
            command: commandText,
            cwd,
            env,
            signal: commandSignal,
            timeoutMs: commandTimeoutMs,
            tailLimit: 4_000,
          });
          if (signal.aborted) throw new Error("Preview cancelled");
          if (result.exitCode !== 0 || result.timedOut)
            throw new Error(
              `Preview ${step} ${result.timedOut ? "timed out" : "failed"}: ${(result.stderr || result.stdout).trim().slice(-4_000)}`,
            );
        }
        if (signal.aborted) throw new Error("Preview cancelled");
        let output = "";
        let started = false;
        let exit: Error | null = null;
        const collect = (line: string) => {
          output = `${output}${line}\n`.slice(-4_000);
        };
        serving = runConfined({
          command: config.serve,
          cwd,
          env,
          signal: commandSignal,
          tailLimit: 4_000,
          onStarted: () => {
            started = true;
          },
          onStdoutLine: collect,
          onStderrLine: collect,
        });
        void serving.then(
          (result) => {
            exit = new Error(
              `Preview serve exited early (exit ${result.exitCode ?? result.signal}): ${(result.stderr || result.stdout).trim()}`,
            );
          },
          (error: unknown) => {
            exit = error instanceof Error ? error : new Error(String(error));
          },
        );
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) throw new Error("Preview cancelled");
        const deadline = Date.now() + readinessMs;
        while (Date.now() < deadline) {
          if (signal.aborted) throw new Error("Preview cancelled");
          if (exit) throw exit;
          try {
            const response = await fetch(readyUrl, {
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
              ]),
              redirect: "error",
            });
            await response.body?.cancel();
            if (signal.aborted) throw new Error("Preview cancelled");
            if (response.ok && started && !exit) return { url, scratch, stop };
          } catch {
            /* Retry until the bounded readiness deadline. */
          }
          await Bun.sleep(100);
        }
        throw new Error(`Preview readiness timed out at ${url}${config.ready}: ${output.trim()}`);
      } catch (error) {
        await stop();
        throw error;
      }
    },
    scratch,
  );
}
