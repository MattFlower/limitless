import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { DiffInfo } from "../git/repos.ts";
import { createScratch, removeScratch } from "../harness/scratch.ts";
import { agentEnv, runProcess } from "../util/proc.ts";

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

function stopTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const exited = child.exitCode !== null || child.signalCode !== null;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      kill("SIGKILL");
      // A detached grandchild may retain the pipes after the direct child exits.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
    };
    if (exited || child.pid === undefined) {
      finish();
      return;
    }
    timer = setTimeout(() => kill("SIGKILL"), 2_000);
    child.once("exit", finish);
    kill("SIGTERM");
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
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      if (child) await stopTree(child);
      removeScratch(scratch);
    })();
    return stopping;
  };
  const onAbort = () => {
    void stop();
  };
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
      const result = await runProcess({
        cmd: ["/bin/sh", "-c", commandText],
        cwd,
        env,
        signal,
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
    child = spawn("/bin/sh", ["-c", config.serve], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let exit: string | null = null;
    child.on("error", (error) => {
      exit = error.message;
    });
    child.on("exit", (code, sig) => {
      exit = `exit ${code ?? sig}`;
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) throw new Error("Preview cancelled");
    const deadline = Date.now() + readinessMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Preview cancelled");
      if (exit) throw new Error(`Preview serve exited early (${exit}): ${output.trim()}`);
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
        if (response.ok) return { url, scratch, stop };
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
}
