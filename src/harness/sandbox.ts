import { AsyncLocalStorage } from "node:async_hooks";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, type ProcOptions, type ProcResult, runProcess } from "../util/proc.ts";
import { type WriteRoots, withScratch, writeRoots } from "./scratch.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A command could not run confined: an operational failure, never a gate or grading result. */
export class ConfinementError extends Error {}

/** Seatbelt: everything as usual except writes, which only the roots minus `protect` take; the last match wins. */
export function seatbeltProfile(roots: WriteRoots): string {
  const paths = (list: string[]) =>
    list
      .map((path) => {
        if (/["\\]/.test(path) || [...path].some((c) => c < " "))
          throw new ConfinementError("Cannot confine writes to an unusual path");
        return `(subpath "${path}")`;
      })
      .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny signal)",
    "(allow signal (target self) (target same-sandbox))",
    "(deny file-write*)",
    `(allow file-write* ${paths(roots.write)} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(fd/|tty|ptmx$)"))`,
    ...(roots.protect.length ? [`(deny file-write* ${paths(roots.protect)})`] : []),
  ].join("\n");
}

const observed = (roots: WriteRoots): WriteRoots => ({ ...roots, write: [...roots.write, ...observerRoots] });

export interface ConfinementBackend {
  verify(roots: WriteRoots, opts: ProcOptions, run: typeof runProcess): Promise<void>;
  wrap(cmd: string[], roots: WriteRoots): string[];
}
export const confinementScope = new AsyncLocalStorage<ConfinementBackend>();
export const seatbeltBackend: ConfinementBackend = {
  verify: (roots, opts, run) => verifySeatbelt(run, SANDBOX_EXEC, process.platform, roots, opts.signal),
  wrap: (cmd, roots) => [SANDBOX_EXEC, "-p", seatbeltProfile(roots), ...cmd],
};

/** Seatbelt verifies the effective profile every launch; Codex capability probes cache by CLI/version. */
export async function verifySeatbelt(
  run: typeof runProcess = runProcess,
  executable = SANDBOX_EXEC,
  platform: string = process.platform,
  roots?: WriteRoots,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  try {
    await probeSeatbelt(run, executable, platform, roots, signal);
  } catch (error) {
    if (error instanceof ConfinementError) throw error;
    throw new ConfinementError(`Signal confinement preflight failed: ${String(error)}`);
  }
}

// All targets are created by this trusted supervisor; no PID/name from the host is accepted.
const SIGNAL_PROBE = `
sleep 30 & outside=$!
sibling=""
trap 'kill "$outside" $sibling 2>/dev/null; wait 2>/dev/null' EXIT
"$1" -p "$2" /bin/sh -c 'echo ready > "$1"; exec sleep 30' sh "$3" & sibling=$!
i=0; while [ ! -f "$3" ]; do i=$((i+1)); [ "$i" -lt 100 ] || exit 1; sleep .01; done
"$1" -p "$2" /bin/sh -c '
  kill -TERM "$1" 2>/dev/null && exit 1
  kill -TERM "$2" 2>/dev/null && exit 1
  /bin/sh -c "$3" || exit 1
' sh "$outside" "$sibling" 'sleep 30 & child=$!; kill -TERM "$child"; wait "$child"; [ "$?" -gt 128 ]' || exit 1
kill -0 "$outside" && kill -0 "$sibling" && printf signals-verified
`;

const WRITE_BOTH = 'printf ok > "$1" && ! printf no > "$2" && printf verified';

async function probeSeatbelt(
  run: typeof runProcess,
  executable: string,
  platform: string,
  roots?: WriteRoots,
  signal?: AbortSignal,
) {
  if (platform !== "darwin" || !existsSync(executable))
    throw new ConfinementError(`Write confinement unavailable: ${platform} has no Seatbelt (${executable})`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "limitless-seatbelt-")));
  const allowed = mkdtempSync(join(roots?.write[0] ?? root, "seatbelt-allowed-"));
  try {
    const [inside, outside] = [join(allowed, "file"), join(root, "denied")];
    const proc = await run({
      cmd: [
        executable,
        "-p",
        seatbeltProfile(roots ?? { write: [allowed], protect: [] }),
        "/bin/sh",
        "-c",
        WRITE_BOTH,
      ].concat(["sh", inside, outside]),
      cwd: root,
      env: agentEnv(),
      timeoutMs: 30_000,
      signal,
    });
    const wrote = existsSync(inside) && readFileSync(inside, "utf8") === "ok";
    if (
      proc.cancelled ||
      proc.timedOut ||
      proc.idleTimedOut ||
      proc.exitCode !== 0 ||
      proc.signal ||
      proc.stdout !== "verified" ||
      !wrote ||
      existsSync(outside)
    )
      throw new ConfinementError(
        `Write confinement not verified: Seatbelt did not enforce its profile; ${proc.stderr.trim()}`,
      );
    const profile = seatbeltProfile(roots ?? { write: [allowed], protect: [] });
    const cmd = ["/bin/sh", "-c", SIGNAL_PROBE, "sh", executable, profile, join(allowed, "ready")];
    const p = await run({ cmd, cwd: root, env: agentEnv(), timeoutMs: 30_000, signal });
    // An interrupted probe is inconclusive even when its marker was printed.
    if (
      p.exitCode !== 0 ||
      p.stdout !== "signals-verified" ||
      p.cancelled ||
      p.timedOut ||
      p.idleTimedOut ||
      p.signal
    )
      throw new ConfinementError(`Signal confinement not verified: ${p.stderr}`);
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

/** Extra roots confined commands may write: only test fixtures that observe gate runs add any. */
export const observerRoots = new Set<string>();

/** One owned scratch for dependent setup/check commands; inner scopes reuse it. */
const commandScratch = new AsyncLocalStorage<{ dir: string; initialized: boolean }>();
export const withCommandScratch = <T>(cwd: string, fn: () => Promise<T>): Promise<T> =>
  commandScratch.getStore()
    ? fn()
    : withScratch(cwd, (dir) => commandScratch.run({ dir, initialized: false }, fn));

export const commandScope =
  <T>(cwd: string, fn: () => Promise<T>) =>
  () =>
    withCommandScratch(cwd, fn);

/** Confine the entire process, including native tools, before any CLI code runs. */
export async function runSandboxed(
  opts: ProcOptions,
  roots: WriteRoots,
  run = runProcess,
  verify?: () => Promise<void>,
  backend: ConfinementBackend = confinementScope.getStore() ?? seatbeltBackend,
): Promise<ProcResult> {
  await (verify ? verify() : backend.verify(roots, opts, run));
  opts.signal?.throwIfAborted();
  const token = `limitless-started-${crypto.randomUUID()}`;
  let started = false;
  const payload: ProcOptions = {
    ...opts,
    cmd: [
      // Confirm sandbox startup separately from the candidate's exit status.
      "/bin/sh",
      "-c",
      'printf "%s\\n" "$1"; shift; exec "$@"',
      "sh",
      token,
      ...opts.cmd,
    ],
    onStdoutLine: (line) => {
      if (line === token) started = true;
      else opts.onStdoutLine?.(line);
    },
  };
  const result = await run({ ...payload, cmd: backend.wrap(payload.cmd, roots) });
  if (!started)
    throw new ConfinementError(
      `Write confinement payload did not start: ${result.stderr || result.exitCode}`,
    );
  return { ...result, stdout: result.stdout.replace(`${token}\n`, "") };
}

/** Keep installed toolchains readable; writable package caches belong to the suite scratch. */
export async function runConfined(
  opts: Omit<ProcOptions, "cmd"> & { command: string },
  verify?: () => Promise<void>,
  run = runProcess,
): Promise<ProcResult> {
  return withCommandScratch(opts.cwd, async () => {
    const scope = commandScratch.getStore();
    if (!scope) throw new ConfinementError("Missing command scratch");
    const scratch = scope.dir;
    const home = opts.env.HOME ?? homedir();
    const cargo = join(scratch, "cargo");
    if (!scope.initialized) {
      mkdirSync(cargo);
      for (const name of ["config", "config.toml"]) {
        const source = join(opts.env.CARGO_HOME ?? join(home, ".cargo"), name);
        if (existsSync(source)) copyFileSync(source, join(cargo, name));
      }
      scope.initialized = true; // Never perform trusted copies into scratch after candidate code runs.
    }
    return runSandboxed(
      {
        ...opts,
        cmd: ["/bin/sh", "-c", opts.command],
        env: {
          ...opts.env,
          GIT_OPTIONAL_LOCKS: "0",
          LIMITLESS_CONFINED: "1",
          HOME: scratch,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          XDG_CACHE_HOME: join(scratch, "cache"),
          npm_config_cache: join(scratch, "npm"),
          CARGO_HOME: cargo,
          RUSTUP_HOME: opts.env.RUSTUP_HOME ?? join(home, ".rustup"),
          GOCACHE: join(scratch, "go-build"),
          GOPATH: join(scratch, "go"),
        },
      },
      observed(writeRoots(opts.cwd, scratch)),
      run,
      verify,
    );
  });
}
