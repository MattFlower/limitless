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
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { launchFailureScan } from "../gates/output.ts";
import { agentEnv, invocationScratch, type ProcOptions, type ProcResult, runProcess } from "../util/proc.ts";
import {
  ancestorReadPolicy,
  ConfinementError,
  READ_PROBE,
  resolvedHome,
  specificReadDenies,
} from "./read-policy.ts";
import { linuxForPort } from "./sandbox-linux.ts";
import { scratchEnv, type WriteRoots, withScratch, writeRoots } from "./scratch.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A command could not run confined: an operational failure, never a gate or grading result. */
export { ConfinementError } from "./read-policy.ts";

/** Seatbelt: restrict writes, signals and policy reads; later specific read rules preserve exceptions. */
export function seatbeltProfile(roots: WriteRoots, browser?: { host: string; port: number }): string {
  if (
    browser &&
    (!["127.0.0.1", "localhost", "::1"].includes(browser.host) ||
      !Number.isInteger(browser.port) ||
      browser.port < 1 ||
      browser.port > 65535 ||
      !roots.allowRead?.length)
  )
    throw new ConfinementError("Invalid browser confinement policy");
  if (
    roots.daemonPort !== undefined &&
    (!Number.isInteger(roots.daemonPort) || roots.daemonPort < 1 || roots.daemonPort > 65535)
  )
    throw new ConfinementError("Invalid daemon port for confinement");
  const paths = (list: string[], filter = "subpath") =>
    list
      .map((path) => {
        if (/["\\]/.test(path) || [...path].some((c) => c < " "))
          throw new ConfinementError(`Cannot confine an unusual policy path: ${path}`);
        return `(${filter} "${path}")`;
      })
      .join(" ");
  const ancestors = ancestorReadPolicy(roots.allowRead ?? [], roots.denyRead ?? []);
  const specificDenies = browser
    ? (roots.denyRead ?? [])
    : specificReadDenies(roots.allowRead ?? [], roots.denyRead ?? []);
  const readHoles = [...specificDenies, ...(roots.commands?.root ?? [])].filter((deny) =>
    (roots.allowRead ?? []).some((allow) => {
      const rel = relative(allow, deny);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    }),
  );
  return [
    "(version 1)",
    "(allow default)",
    ...(browser
      ? [
          "(deny network-outbound)",
          // Seatbelt rejects literal IPs ("host must be * or localhost"), so the address family selects
          // the preview's loopback address: ip4 for 127.0.0.1, ip6 for ::1, both for localhost.
          ...(browser.host === "::1"
            ? []
            : [`(allow network-outbound (remote ip4 "localhost:${browser.port}"))`]),
          ...(browser.host === "127.0.0.1"
            ? []
            : [`(allow network-outbound (remote ip6 "localhost:${browser.port}"))`]),
          "(deny file-read*)",
        ]
      : []),
    // Seatbelt's localhost selector covers IPv4 and IPv6 loopback.
    ...(roots.daemonPort ? [`(deny network-outbound (remote ip "localhost:${roots.daemonPort}"))`] : []),
    "(deny signal)",
    "(allow signal (target self) (target same-sandbox))",
    "(deny file-write*)",
    `(allow file-write* ${paths(roots.write)} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(fd/|tty|ptmx$)"))`,
    ...(roots.protect.length ? [`(deny file-write* ${paths(roots.protect)})`] : []),
    ...(roots.commands ? [`(deny file-write* ${paths(roots.commands.root)})`] : []),
    // Other invocations' lease capabilities: contents and listings, not the metadata path lookups need.
    ...(roots.commands ? [`(deny file-read-data ${paths(roots.commands.root)})`] : []),
    ...(roots.commands?.own.length ? [`(allow file-read-data ${paths(roots.commands.own)})`] : []),
    ...(roots.denyRead?.length ? [`(deny file-read* ${paths(roots.denyRead)})`] : []),
    ...(roots.allowRead?.length ? [`(allow file-read* ${paths(roots.allowRead)})`] : []),
    // A denied cwd proves non-membership only when no read allowance contains unreadable subtrees.
    // Private denies and command roots outside the allowances do not invalidate that proof.
    ...(roots.denyRead?.length && roots.allowRead?.length && readHoles.length === 0
      ? [
          '(deny mach-lookup (global-name "com.limitless.read-allowlist.denied"))',
          '(allow mach-lookup (global-name "com.limitless.read-allowlist.allowed"))',
        ]
      : []),
    // realpath/Git inspect every ancestor; literal metadata grants do not allow directory listings.
    ...(!browser && ancestors.literals.length
      ? [`(allow file-read* ${paths(ancestors.literals, "literal")})`]
      : []),
    ...(ancestors.metadata.length
      ? [`(allow file-read-metadata ${paths(ancestors.metadata, "literal")})`]
      : []),
    // Specific denies (e.g. a registered database inside a checkout) still beat read allowances.
    ...(specificDenies.length ? [`(deny file-read* ${paths(specificDenies)})`] : []),
  ].join("\n");
}

const observed = (roots: WriteRoots): WriteRoots => ({ ...roots, write: [...roots.write, ...observerRoots] });

export interface ConfinementBackend {
  verify(roots: WriteRoots, opts: ProcOptions, run: typeof runProcess): Promise<void>;
  wrap(cmd: string[], roots: WriteRoots): string[];
  /**
   * Optional: launch the confined command from a trusted environment and cwd, so nothing the payload
   * controls runs before confinement applies. The payload's own environment and cwd reach only the payload.
   */
  launch?(
    cmd: string[],
    roots: WriteRoots,
    payload: { env: Record<string, string>; cwd: string },
  ): { cmd: string[]; env: Record<string, string>; cwd: string };
}
export const confinementScope = new AsyncLocalStorage<ConfinementBackend>();
export const seatbeltBackend: ConfinementBackend = {
  verify: (roots, opts, run) => verifySeatbelt(run, SANDBOX_EXEC, process.platform, roots, opts.signal),
  wrap: (cmd, roots) => [SANDBOX_EXEC, "-p", seatbeltProfile(roots), ...cmd],
};

/** Carry the factory port through every editor, gate and land command in its backend scope. */
export function seatbeltForPort(port: number): ConfinementBackend {
  const rootsForPort = (roots: WriteRoots) => ({ ...roots, daemonPort: port || undefined });
  return {
    verify: (roots, opts, run) => seatbeltBackend.verify(rootsForPort(roots), opts, run),
    wrap: (cmd, roots) => seatbeltBackend.wrap(cmd, rootsForPort(roots)),
  };
}

/** The factory's backend for this platform; anything but Linux gets Seatbelt, which refuses off macOS. */
export const platformConfinement = (port: number, platform: string = process.platform): ConfinementBackend =>
  platform === "linux" ? linuxForPort(port) : seatbeltForPort(port);

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
    // The probe rethrows our cancel's reason only when that cancel, not the probe, stopped it.
    if (error instanceof ConfinementError || (signal?.aborted && error === signal.reason)) throw error;
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
  // Our signal first: under a run's process scope, runProcess would throw the scope's reason instead.
  const step = async (cmd: string[]) => {
    signal?.throwIfAborted();
    const launch = launchFailureScan();
    const result = await run({
      cmd,
      cwd: root,
      env: agentEnv(),
      timeoutMs: 30_000,
      signal,
      onRawChunk: launch.observe,
    });
    return { result, killed: killedByCancel(result) && !launch.failed() };
  };
  // Our cancel killed the step before it reached a verdict: surface the cancel. Anything else,
  // including a step that finished as the cancel arrived, keeps failing closed below.
  const surfaceCancel = (killed: boolean) => {
    if (killed) signal?.throwIfAborted();
  };
  try {
    const [inside, outside] = [join(allowed, "file"), join(root, "denied")];
    const write = await step([
      executable,
      "-p",
      seatbeltProfile(roots ?? { write: [allowed], protect: [] }),
      "/bin/sh",
      "-c",
      WRITE_BOTH,
      "sh",
      inside,
      outside,
    ]);
    const proc = write.result;
    // A write outside the profile is a leak even when our cancel killed the probe afterwards.
    if (!existsSync(outside)) surfaceCancel(write.killed);
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
    for (const file of roots?.denyRead ?? []) {
      if (!existsSync(file)) continue;
      const { result: read, killed } = await step([
        executable,
        "-p",
        profile,
        "/bin/sh",
        "-c",
        READ_PROBE,
        "sh",
        file,
      ]);
      surfaceCancel(killed);
      if (
        read.exitCode !== 1 ||
        read.cancelled ||
        read.timedOut ||
        !/Operation not permitted|Permission denied/.test(read.stderr)
      )
        throw new ConfinementError(`Private read confinement not verified: ${file}`);
    }
    const signals = await step([
      "/bin/sh",
      "-c",
      SIGNAL_PROBE,
      "sh",
      executable,
      profile,
      join(allowed, "ready"),
    ]);
    surfaceCancel(signals.killed);
    const p = signals.result;
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

/** Inner scopes reuse scratch; a caller supplying ownedScratch must stop commands before removing it. */
const commandScratch = new AsyncLocalStorage<{ dir: string; initialized: boolean }>();
export const withCommandScratch = <T>(
  cwd: string,
  fn: () => Promise<T>,
  ownedScratch?: string,
): Promise<T> =>
  ownedScratch
    ? invocationScratch.run(ownedScratch, () =>
        commandScratch.run({ dir: ownedScratch, initialized: false }, fn),
      )
    : commandScratch.getStore()
      ? fn()
      : withScratch(cwd, (dir) => commandScratch.run({ dir, initialized: false }, fn));

export const commandScope =
  <T>(cwd: string, fn: () => Promise<T>) =>
  () =>
    withCommandScratch(cwd, fn);

/** Confine the entire process, including native tools, before any CLI code runs. */
export async function runSandboxed(
  opts: ProcOptions & { onStarted?: () => void },
  roots: WriteRoots,
  run = runProcess,
  verify?: () => Promise<void>,
  backend: ConfinementBackend = confinementScope.getStore() ?? seatbeltBackend,
): Promise<ProcResult> {
  await (verify ? verify() : backend.verify(roots, opts, run));
  opts.signal?.throwIfAborted();
  const token = `limitless-started-${crypto.randomUUID()}`;
  let started = false;
  const lineLimit = opts.maxLineLength ?? Infinity;
  const forwardLine = (line: string, onLine?: (line: string) => void) =>
    onLine?.(line.length > lineLimit ? `${line.slice(0, lineLimit)} [truncated]` : line);
  // Raw streams, before redaction and tail cuts, as gate classification scans them.
  const launch = launchFailureScan();
  const payload: ProcOptions = {
    ...opts,
    onRawChunk: (chunk, stream) => {
      launch.observe(chunk, stream);
      opts.onRawChunk?.(chunk, stream);
    },
    // The startup token must fit even when candidate output has a smaller cap.
    maxLineLength: Math.max(lineLimit, token.length),
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
      if (line === token) {
        started = true;
        opts.onStarted?.();
      } else forwardLine(line, opts.onStdoutLine);
    },
    onStderrLine: (line) => forwardLine(line, opts.onStderrLine),
  };
  const launched = backend.launch?.(payload.cmd, roots, { env: payload.env, cwd: payload.cwd }) ?? {
    cmd: backend.wrap(payload.cmd, roots),
    env: payload.env,
    cwd: payload.cwd,
  };
  const result = await run({ ...payload, ...launched });
  if (!started) {
    // Our cancel stopped the launch before the trusted shell ran, so the payload never did.
    if (killedByCancel(result) && !launch.failed()) return result;
    throw new ConfinementError(
      `Write confinement payload did not start: ${result.stderr || result.exitCode}`,
    );
  }
  return { ...result, stdout: result.stdout.replace(`${token}\n`, "") };
}

/**
 * A cancel's termination freezes, then SIGKILLs the invocation (`runProcess`), and `cancelKilled`
 * records that the cancel began it while the child still ran. An exit, a timeout, another signal,
 * a child that was already dead or a Seatbelt diagnostic is a failed launch even with a cancel.
 */
export const killedByCancel = (result: ProcResult): boolean =>
  result.cancelled &&
  result.cancelKilled === true &&
  !result.timedOut &&
  !result.idleTimedOut &&
  result.exitCode === null &&
  result.signal === "SIGKILL";

/** Keep installed toolchains readable; writable package caches belong to the suite scratch. */
export async function runConfined(
  opts: Omit<ProcOptions, "cmd"> & { command: string; args?: string[]; onStarted?: () => void },
  verify?: () => Promise<void>,
  run = runProcess,
): Promise<ProcResult> {
  return withCommandScratch(opts.cwd, async () => {
    const scope = commandScratch.getStore();
    if (!scope) throw new ConfinementError("Missing command scratch");
    const scratch = scope.dir;
    const home = resolvedHome();
    const roots = observed(writeRoots(opts.cwd, scratch, true));
    const cargo = join(scratch, "cargo");
    if (!scope.initialized) {
      let created = false;
      try {
        mkdirSync(cargo);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Another job/process may have initialized shared scratch. Never copy into candidate paths.
      if (created)
        for (const name of ["config", "config.toml"]) {
          const source = join(opts.env.CARGO_HOME ?? join(home, ".cargo"), name);
          if (existsSync(source)) copyFileSync(source, join(cargo, name));
        }
      scope.initialized = true; // Never perform trusted copies into scratch after candidate code runs.
    }
    return runSandboxed(
      {
        ...opts,
        cmd: opts.args
          ? ["/bin/sh", "-c", `${opts.command} "$@"`, "gate", ...opts.args]
          : ["/bin/sh", "-c", opts.command],
        env: {
          ...opts.env,
          GIT_OPTIONAL_LOCKS: "0",
          LIMITLESS_CONFINED: "1",
          HOME: scratch,
          ...scratchEnv({ scratchDir: scratch }),
          XDG_CACHE_HOME: join(scratch, "cache"),
          npm_config_cache: join(scratch, "npm"),
          BUN_INSTALL_CACHE_DIR: join(scratch, "bun"),
          CARGO_HOME: cargo,
          RUSTUP_HOME: opts.env.RUSTUP_HOME ?? join(home, ".rustup"),
          GOCACHE: join(scratch, "go-build"),
          GOPATH: join(scratch, "go"),
        },
      },
      roots,
      run,
      verify,
    );
  });
}
