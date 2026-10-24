import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { agentEnv, type ProcOptions, type ProcResult, runProcess } from "../util/proc.ts";
import { landlockCommand } from "./landlock.ts";
import { ancestorReadPolicy, ConfinementError, specificReadDenies } from "./read-policy.ts";
import type { ConfinementBackend } from "./sandbox.ts";
import type { WriteRoots } from "./scratch.ts";

export const BWRAP = "/usr/bin/bwrap";

const within = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Mount targets resolve symlinks, so only existing canonical paths are mounted. */
function canonical(paths: readonly string[] = []): string[] {
  const resolved = paths.flatMap((path) => {
    if (!isAbsolute(path) || [...path].some((c) => c < " " || c === "\x7f"))
      throw new ConfinementError(`Cannot confine an unusual policy path: ${path}`);
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
  return [...new Set(resolved)].sort((a, b) => a.length - b.length);
}

/** Empty, mode-000 sources for masks: outside every write root, so no candidate can change them. */
let masks: { dir: string; file: string } | undefined;
function maskSources(): { dir: string; file: string } {
  if (masks && existsSync(masks.dir) && existsSync(masks.file)) return masks;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "limitless-bwrap-")));
  masks = { dir: join(root, "dir"), file: join(root, "file") };
  mkdirSync(masks.dir, { mode: 0 });
  writeFileSync(masks.file, "", { mode: 0 });
  return masks;
}

/**
 * bwrap arguments equivalent to `seatbeltProfile`: a read-only root; private /run, /tmp and /var/tmp
 * (hiding $XDG_RUNTIME_DIR and every host socket); denied reads masked, then allowances, write roots and
 * protected paths bound in that order, and specific denies masked again so they beat every allowance.
 * Denies inside `hidden`, the private tmpfs mounts, need a mask only when binds pass through them.
 */
export function bwrapArgs(
  roots: WriteRoots,
  sources = maskSources(),
  hidden = ["/run", "/tmp", "/var/tmp"],
): string[] {
  if (
    roots.daemonPort !== undefined &&
    (!Number.isInteger(roots.daemonPort) || roots.daemonPort < 1 || roots.daemonPort > 65535)
  )
    throw new ConfinementError("Invalid daemon port for confinement");
  const deny = canonical(roots.denyRead);
  const allow = canonical(roots.allowRead);
  const write = canonical(roots.write);
  const own = canonical(roots.commands?.own);
  const commandRoots = canonical(roots.commands?.root);
  const bound = [...allow, ...write, ...own];
  const outer = deny.filter(
    (d) =>
      (!hidden.some((h) => within(h, d)) || bound.some((b) => within(d, b))) &&
      !deny.some((o) => o !== d && within(o, d)),
  );
  // A mask that later binds pass through stays traversable but unlistable.
  const traversable = outer.filter((d) => bound.some((b) => within(d, b)));
  const masked = [...hidden, ...outer];
  const mask = (path: string) =>
    statSync(path).isDirectory() ? ["--ro-bind", sources.dir, path] : ["--ro-bind", sources.file, path];
  const resolv = canonical(["/etc/resolv.conf"]).filter((p) => within("/run", p));
  const literals = canonical(ancestorReadPolicy(allow, deny).literals).filter(
    (p) => masked.some((m) => within(m, p)) && statSync(p).isFile(),
  );
  return [
    ...["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"],
    ...["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"],
    ...["--perms", "0755", "--tmpfs", "/run", ...resolv.flatMap((p) => ["--ro-bind", p, p])],
    // Private and writable: Codex's own bubblewrap keeps its mount registry in /tmp.
    ...["--perms", "1777", "--tmpfs", "/tmp", "--perms", "1777", "--tmpfs", "/var/tmp"],
    ...outer.flatMap((d) => (traversable.includes(d) ? ["--perms", "0111", "--tmpfs", d] : mask(d))),
    ...[...allow, ...literals]
      .filter((p) => masked.some((m) => within(m, p)))
      .flatMap((p) => ["--ro-bind", p, p]),
    ...write.flatMap((p) => ["--bind", p, p]),
    ...canonical(roots.protect)
      .filter((p) => write.some((w) => within(w, p)))
      .flatMap((p) => ["--ro-bind", p, p]),
    ...specificReadDenies(allow, deny)
      .filter((d) => bound.some((b) => within(b, d)))
      .flatMap(mask),
    // Other invocations' command capabilities: hidden; this invocation's own: readable, not writable.
    ...commandRoots.flatMap((r) => ["--perms", "0111", "--tmpfs", r]),
    ...own.flatMap((p) => ["--ro-bind", p, p]),
    ...["/run", ...traversable, ...commandRoots].flatMap((p) => ["--remount-ro", p]),
  ];
}

const command = (cmd: string[], roots: WriteRoots, bwrap: string) => [
  ...landlockCommand(roots.daemonPort ?? 0),
  "--",
  bwrap,
  ...bwrapArgs(roots),
  "--",
  ...cmd,
];

/** bwrap for the filesystem and PID namespace, Landlock for the daemon port, abstract sockets and signals. */
export function linuxForPort(
  port: number,
  bwrap = BWRAP,
  platform: string = process.platform,
): ConfinementBackend {
  const rootsForPort = (roots: WriteRoots) => ({ ...roots, daemonPort: port || undefined });
  return {
    verify: (roots, opts, run) => verifyLinux(rootsForPort(roots), opts, run, bwrap, platform),
    wrap: (cmd, roots) => command(cmd, rootsForPort(roots), bwrap),
  };
}

// Started by this supervisor: the sibling is another sandbox and `outer` an unconfined process.
// Writes outside may land in the sandbox's private /tmp, so only the host can tell they were refused.
const LINUX_PROBE = `
ready=$1 inside=$2 outside=$3 beside=$4; shift 4
sleep 30 & outer=$!
sibling=""
trap 'kill "$outer" $sibling 2>/dev/null; wait 2>/dev/null' EXIT
"$@" /bin/sh -c 'echo ready > "$1"; exec sleep 30' sh "$ready" & sibling=$!
i=0; while [ ! -f "$ready" ]; do i=$((i+1)); [ "$i" -lt 1000 ] || exit 1; sleep .01; done
"$@" /bin/sh -c '
  kill -TERM "$1" 2>/dev/null && exit 1
  kill -TERM "$2" 2>/dev/null && exit 1
  sleep 30 & child=$!; kill -TERM "$child"; wait "$child"; [ "$?" -gt 128 ] || exit 1
  printf ok > "$3" || exit 1
  printf no 2>/dev/null > "$4"; printf no 2>/dev/null > "$5"
  printf "%s\\n" "$LIMITLESS_PROBE_DENIED" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ -d "$file" ]; then ls -A "$file"; else head -c 1 "$file"; fi >/dev/null 2>&1 && exit 1
    :
  done || exit 1
' sh "$outer" "$sibling" "$inside" "$outside" "$beside" || exit 1
kill -0 "$outer" && kill -0 "$sibling" && printf linux-verified
`;

const conclusive = (result: ProcResult, marker: string) =>
  result.exitCode === 0 &&
  result.stdout === marker &&
  !result.cancelled &&
  !result.timedOut &&
  !result.idleTimedOut &&
  !result.signal;

/** Probes the effective roots on every launch, like `verifySeatbelt`; any doubt fails closed. */
export async function verifyLinux(
  roots: WriteRoots,
  opts: Pick<ProcOptions, "signal">,
  run: typeof runProcess = runProcess,
  bwrap = BWRAP,
  platform: string = process.platform,
): Promise<void> {
  opts.signal?.throwIfAborted();
  if (platform !== "linux" || !existsSync(bwrap))
    throw new ConfinementError(`Write confinement unavailable: ${platform} has no bubblewrap (${bwrap})`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "limitless-bwrap-probe-")));
  const allowed = mkdtempSync(join(roots.write[0] ?? root, "bwrap-allowed-"));
  const probeRoots = roots.write.length ? roots : { ...roots, write: [allowed] };
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const abstract = `limitless-probe-${crypto.randomUUID()}`;
  const unix = Bun.listen({ unix: `\0${abstract}`, socket: { data() {} } });
  let written: string[] = [];
  const step = async (cmd: string[], env: Record<string, string> = {}) => {
    const result = await run({
      cmd,
      cwd: allowed,
      env: { ...agentEnv(), ...env },
      timeoutMs: 30_000,
      signal: opts.signal,
    });
    opts.signal?.throwIfAborted();
    return result;
  };
  try {
    const [inside, outside] = [join(allowed, "file"), join(root, "denied")];
    const beside = join(
      dirname(realpathSync(roots.write[0] ?? root)),
      `.limitless-denied-${crypto.randomUUID()}`,
    );
    written = [outside, beside];
    const denied = canonical(roots.denyRead).filter((p) => existsSync(p));
    const sandbox = await step(
      [
        "/bin/sh",
        "-c",
        LINUX_PROBE,
        "sh",
        join(allowed, "ready"),
        inside,
        outside,
        beside,
        ...command([], probeRoots, bwrap),
      ],
      { LIMITLESS_PROBE_DENIED: denied.join("\n") },
    );
    if (
      written.some((p) => existsSync(p)) ||
      !conclusive(sandbox, "linux-verified") ||
      readFileSync(inside, "utf8") !== "ok"
    )
      throw new ConfinementError(
        `Write, read or signal confinement not verified: bubblewrap did not enforce its policy (exit ${sandbox.exitCode}); ${sandbox.stderr.trim()}`,
      );
    const network = await step([...landlockCommand(tcp.port), "--probe", abstract, String(process.pid)]);
    if (!conclusive(network, "landlock-verified"))
      throw new ConfinementError(`Network and signal confinement not verified: ${network.stderr.trim()}`);
  } catch (error) {
    if (error instanceof ConfinementError || (opts.signal?.aborted && error === opts.signal.reason))
      throw error;
    throw new ConfinementError(`Linux confinement preflight failed: ${String(error)}`);
  } finally {
    tcp.stop(true);
    unix.stop(true);
    for (const path of [allowed, ...written]) rmSync(path, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}
