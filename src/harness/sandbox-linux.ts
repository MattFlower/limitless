import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { type ProcOptions, type ProcResult, runProcess } from "../util/proc.ts";
import { ENV_FD, ENV_FILE, landlockCommand, PAYLOAD_ENV } from "./landlock.ts";
import { ancestorReadPolicy, ConfinementError, specificReadDenies } from "./read-policy.ts";
import { type ConfinementBackend, killedByCancel } from "./sandbox.ts";
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

/** The existing ancestor a not-yet-existing deny would be created under, and the name it would start as. */
function creatableUnder(path: string): { dir: string; name: string } {
  for (let child = path, dir = dirname(path); ; child = dir, dir = dirname(dir)) {
    try {
      return { dir: realpathSync(dir), name: basename(child) };
    } catch {
      if (dir === dirname(dir)) return { dir, name: basename(child) };
    }
  }
}

/** `path` as an entry of its canonical parent: how `readdir` of that parent spells it. */
function entryOf(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
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
 * A read-only tmpfs over `dir` holding its current entries bound back, except `denied`: a deny that does
 * not exist yet stays absent even if a host process creates it later, which the read-only root bind would
 * show. Entries the host adds afterwards stay hidden too; one removed before bwrap binds it is skipped.
 */
export function shadow(dir: string, denied: ReadonlySet<string> = new Set()): string[] {
  const mode = (statSync(dir).mode & 0o7777).toString(8).padStart(4, "0");
  return [
    ...["--perms", mode, "--tmpfs", dir],
    ...readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      // Matched by name, so a denied entry created after the policy was inspected is not bound back.
      if (denied.has(path)) return [];
      if (!entry.isSymbolicLink()) return ["--ro-bind-try", path, path];
      try {
        return ["--symlink", readlinkSync(path), path];
      } catch {
        return [];
      }
    }),
  ];
}

/**
 * bwrap arguments equivalent to `seatbeltProfile`: a read-only root; private /run, /tmp and /var/tmp
 * (hiding $XDG_RUNTIME_DIR and every host socket); denied reads masked, then allowances, write roots and
 * protected paths bound in that order, and specific denies masked again so they beat every allowance.
 * Denies inside `hidden`, the private tmpfs mounts, need a mask only when binds pass through them; an
 * absent deny anywhere else is shadowed at its nearest existing ancestor.
 */
export function bwrapArgs(
  roots: WriteRoots,
  sources = maskSources(),
  hidden = ["/run", "/tmp", "/var/tmp"],
  envFd?: number,
): string[] {
  if (
    roots.daemonPort !== undefined &&
    (!Number.isInteger(roots.daemonPort) || roots.daemonPort < 1 || roots.daemonPort > 65535)
  )
    throw new ConfinementError("Invalid daemon port for confinement");
  // One lookup per denied path decides between masking and shadowing it: a path the host created
  // between two lookups would get neither.
  const denied = (roots.denyRead ?? []).map((path) => ({ path, real: canonical([path])[0] }));
  const deny = [...new Set(denied.flatMap(({ real }) => (real ? [real] : [])))].sort(
    (a, b) => a.length - b.length,
  );
  const allow = canonical(roots.allowRead);
  const write = canonical(roots.write);
  const own = canonical(roots.commands?.own);
  const commandRoots = canonical(roots.commands?.root);
  const bound = [...allow, ...write, ...own];
  // A mount cannot hide a path that does not exist yet, and a candidate could create it inside a bound
  // directory; a write root under a deny without an allowance, or inside a protected path, would be
  // bound over its ancestor's rule. Seatbelt's pathname rules cover these; bind mounts cannot.
  const absent = denied.flatMap(({ path, real }) => (real ? [] : [{ path, ...creatableUnder(path) }]));
  for (const { path, dir } of absent)
    if (bound.some((b) => within(b, dir)))
      throw new ConfinementError(`Cannot confine a denied path that does not exist yet: ${path}`);
  for (const w of write) {
    if (deny.some((d) => d !== w && within(d, w)) && !allow.some((a) => within(a, w)))
      throw new ConfinementError(`Cannot confine a write root under a denied path: ${w}`);
    if (canonical(roots.protect).some((p) => p !== w && within(p, w)))
      throw new ConfinementError(`Cannot confine a write root inside a protected path: ${w}`);
  }
  const outer = deny.filter(
    (d) =>
      (!hidden.some((h) => within(h, d)) || bound.some((b) => within(d, b))) &&
      !deny.some((o) => o !== d && within(o, d)),
  );
  // A mask that later binds pass through stays traversable but unlistable.
  const traversable = outer.filter((d) => bound.some((b) => within(d, b)));
  const masked = [...hidden, ...outer];
  // Ancestors already behind a mask, a private tmpfs or another invocation's hidden command root show
  // nothing the host creates there later.
  // Each absent deny's first missing name, which its shadow leaves out.
  const excluded = absent.map(({ dir, name }) => join(dir, name));
  const shadowed = [...new Set(absent.map(({ dir }) => dir))]
    .filter((dir) => ![...masked, ...commandRoots].some((m) => within(m, dir)))
    // A directory a later lookup found inside an entry another shadow leaves out is already hidden by
    // that shadow's tmpfs; shadowing it too would bind its contents back.
    .filter((dir) => !excluded.some((entry) => within(entry, dir)))
    .sort((a, b) => a.length - b.length);
  if (shadowed.includes("/"))
    throw new ConfinementError("Cannot confine a denied path whose only existing ancestor is /");
  // Every denied path as a shadowed directory's entry, present or absent when it was looked up; an
  // absent one counts from the first name that was missing, so its future ancestor stays out too.
  const unbound = new Set([
    ...denied.flatMap(({ path, real }) => (real ? [real, entryOf(path)] : [])),
    ...excluded,
  ]);
  const mask = (path: string) =>
    statSync(path).isDirectory() ? ["--ro-bind", sources.dir, path] : ["--ro-bind", sources.file, path];
  const resolv = canonical(["/etc/resolv.conf"]).filter((p) => within("/run", p));
  const literals = canonical(ancestorReadPolicy(allow, deny).literals).filter(
    (p) => masked.some((m) => within(m, p)) && statSync(p).isFile(),
  );
  return [
    ...["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"],
    ...["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"],
    // Before the private tmpfs mounts and every mask, which must cover what the shadows bind back.
    ...shadowed.flatMap((dir) => shadow(dir, unbound)),
    ...["--perms", "0755", "--tmpfs", "/run", ...resolv.flatMap((p) => ["--ro-bind", p, p])],
    ...(envFd === undefined ? [] : ["--ro-bind-data", String(envFd), ENV_FILE]),
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
    ...["/run", ...shadowed, ...traversable, ...commandRoots].flatMap((p) => ["--remount-ro", p]),
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

const MAX_PAYLOAD_ENV = 100_000;
// Sources the payload's variables inside the sandbox, from the descriptor the launcher staged.
const LOAD_ENV = `. ${ENV_FILE} || exit 125; exec "$@"`;

/**
 * The launcher and bwrap run from "/" with only the cleanup markers (added by `runProcess`) and the
 * payload environment in one variable the launcher consumes: BUN_OPTIONS, NODE_OPTIONS, LD_* and the
 * checkout's files cannot run before confinement applies. bwrap --chdir enters the payload's cwd.
 */
function launch(cmd: string[], roots: WriteRoots, payload: { env: Record<string, string>; cwd: string }) {
  const env = JSON.stringify(payload.env);
  if (Buffer.byteLength(env) > MAX_PAYLOAD_ENV)
    throw new ConfinementError("The confined command's environment is too large to stage");
  if (!isAbsolute(payload.cwd)) throw new ConfinementError("The confined command's cwd must be absolute");
  return {
    cmd: [
      ...landlockCommand(roots.daemonPort ?? 0),
      "--",
      BWRAP,
      ...bwrapArgs(roots, undefined, undefined, ENV_FD),
      ...["--chdir", payload.cwd, "--", "/bin/sh", "-c", LOAD_ENV, "sh", ...cmd],
    ],
    env: { PATH: "/usr/bin:/bin", [PAYLOAD_ENV]: env },
    cwd: "/",
  };
}

/** bwrap for the filesystem and PID namespace, Landlock for the daemon port, abstract sockets and signals. */
export const linuxBackend: ConfinementBackend = {
  verify: (roots, opts, run) => verifyLinux(roots, opts, run),
  wrap: (cmd, roots) => command(cmd, roots, BWRAP),
  launch,
};

export function linuxForPort(port: number): ConfinementBackend {
  const rootsForPort = (roots: WriteRoots) => ({ ...roots, daemonPort: port || undefined });
  return {
    verify: (roots, opts, run) => linuxBackend.verify(rootsForPort(roots), opts, run),
    wrap: (cmd, roots) => linuxBackend.wrap(cmd, rootsForPort(roots)),
    launch: (cmd, roots, payload) =>
      (linuxBackend.launch ?? ((c) => ({ cmd: c, ...payload })))(cmd, rootsForPort(roots), payload),
  };
}

// Started by this supervisor: the sibling is another sandbox and `outer` an unconfined process.
// Writes outside may land in the sandbox's private /tmp, so only the host can tell they were refused.
const LINUX_PROBE = `
ready=$1 inside=$2 outside=$3 beside=$4 denied=$5; shift 5
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
  printf "%s\\n" "$6" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ -d "$file" ]; then ls -A "$file"; else head -c 1 "$file"; fi >/dev/null 2>&1 && exit 1
    :
  done || exit 1
' sh "$outer" "$sibling" "$inside" "$outside" "$beside" "$denied" || exit 1
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
  const listeners: { stop(force?: boolean): void }[] = [];
  const created: string[] = [];
  const temp = (parent: string, prefix: string) => {
    const dir = mkdtempSync(join(parent, prefix));
    created.push(dir);
    return dir;
  };
  // The cancel kills a step before it reaches a verdict only when it is surfaced first; evidence of a
  // leak, such as a write outside, still fails closed even when the cancel arrived afterwards.
  const surfaceCancel = (result: ProcResult) => {
    if (killedByCancel(result)) opts.signal?.throwIfAborted();
  };
  const step = (cmd: string[]) =>
    run({
      cmd,
      cwd: "/",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 30_000,
      signal: opts.signal,
    });
  try {
    const root = realpathSync(temp(tmpdir(), "limitless-bwrap-probe-"));
    const allowed = temp(roots.write[0] ?? root, "bwrap-allowed-");
    const probeRoots = roots.write.length ? roots : { ...roots, write: [allowed] };
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    listeners.push(tcp);
    const abstract = `limitless-probe-${crypto.randomUUID()}`;
    listeners.push(Bun.listen({ unix: `\0${abstract}`, socket: { data() {} } }));
    const [inside, outside] = [join(allowed, "file"), join(root, "denied")];
    const beside = join(
      dirname(realpathSync(roots.write[0] ?? root)),
      `.limitless-denied-${crypto.randomUUID()}`,
    );
    created.push(outside, beside);
    const denied = canonical(roots.denyRead).filter((p) => existsSync(p));
    const sandbox = await step([
      "/bin/sh",
      "-c",
      LINUX_PROBE,
      "sh",
      join(allowed, "ready"),
      inside,
      outside,
      beside,
      denied.join("\n"),
      ...command([], probeRoots, bwrap),
    ]);
    if (![outside, beside].some((p) => existsSync(p))) surfaceCancel(sandbox);
    if (
      [outside, beside].some((p) => existsSync(p)) ||
      !conclusive(sandbox, "linux-verified") ||
      !existsSync(inside) ||
      readFileSync(inside, "utf8") !== "ok"
    )
      throw new ConfinementError(
        `Write, read or signal confinement not verified: bubblewrap did not enforce its policy (exit ${sandbox.exitCode}); ${sandbox.stderr.trim()}`,
      );
    const network = await step([...landlockCommand(tcp.port), "--probe", abstract, String(process.pid)]);
    const leaked =
      /^landlock: reached (daemon port|abstract socket|signal)(, (daemon port|abstract socket|signal))*$/m;
    if (!leaked.test(network.stderr)) surfaceCancel(network);
    if (!conclusive(network, "landlock-verified"))
      throw new ConfinementError(`Network and signal confinement not verified: ${network.stderr.trim()}`);
  } catch (error) {
    if (error instanceof ConfinementError || (opts.signal?.aborted && error === opts.signal.reason))
      throw error;
    throw new ConfinementError(`Linux confinement preflight failed: ${String(error)}`);
  } finally {
    for (const listener of listeners) listener.stop(true);
    for (const path of created) rmSync(path, { recursive: true, force: true });
  }
}
