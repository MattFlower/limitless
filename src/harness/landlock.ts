import { dlopen, FFIType, ptr } from "bun:ffi";
import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { PACKAGED_BUILD } from "../release.ts";

/** Scoped abstract sockets and signals arrived in ABI 6 (Linux 6.12); confined Git needs only ABI 1. */
export const LANDLOCK_MIN_ABI = 6;
const CONNECT_TCP = 2n;
const SCOPE_ABSTRACT_AND_SIGNAL = 3n;
const RULE_NET_PORT = 2;
const ACCESS_FS_EXECUTE = 1n;
const RULE_PATH_BENEATH = 1;
const [O_PATH, O_CLOEXEC] = [0o10000000, 0o2000000];
const [OPENAT2, AT_FDCWD, RESOLVE_NO_SYMLINKS] = [437, -100, 4n];
/** The payload's environment, JSON-encoded in the launcher's own (never a command line's) environment. */
export const PAYLOAD_ENV = "LIMITLESS_PAYLOAD_ENV";
/** bwrap reads it from this descriptor (`--ro-bind-data`); the payload's shell sources it inside the sandbox. */
export const ENV_FD = 9;
export const ENV_FILE = "/run/limitless-env";
// Read-only in some shells, so sourcing an assignment to them would abort the loader.
const SHELL_OWNED = new Set(["UID", "EUID", "PPID", "GROUPS", "BASHOPTS", "SHELLOPTS", "BASH_VERSINFO"]);

/** Shell `export` lines for the payload's variables; a name that is not a plain identifier is dropped. */
export function envScript(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SHELL_OWNED.has(name))
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'\n`)
    .join("");
}

/**
 * The launcher that confines a Linux command before bwrap starts. A source checkout runs it with a
 * trusted config so the candidate's cwd cannot add Bun preloads or env files before Landlock applies.
 */
export function landlockCommand(port: number): string[] {
  return PACKAGED_BUILD
    ? [process.execPath, "__landlock", String(port)]
    : [
        process.execPath,
        "--no-env-file",
        "--config=/dev/null",
        join(import.meta.dir, "landlock.ts"),
        String(port),
      ];
}

/** How many values each bwrap option in the Linux backend's plans takes. */
const BWRAP_OPTIONS: Record<string, number> = {
  ...Object.fromEntries(
    ["user", "pid", "ipc", "uts", "cgroup-try", "net"].map((ns) => [`--unshare-${ns}`, 0]),
  ),
  ...{ "--die-with-parent": 0, "--new-session": 0 },
  ...Object.fromEntries(
    ["--dev", "--proc", "--tmpfs", "--perms", "--remount-ro", "--chdir"].map((o) => [o, 1]),
  ),
  ...Object.fromEntries(
    ["--bind", "--bind-try", "--ro-bind", "--ro-bind-try", "--symlink", "--ro-bind-data"].map((o) => [o, 2]),
  ),
};

/** bwrap's options before the `--` that starts the command, one array each; an unknown option throws. */
export function bwrapOptions(args: string[]): { options: string[][]; command: string[] } {
  const options: string[][] = [];
  let i = 0;
  for (; args[i] !== "--"; i += options.at(-1)?.length ?? 0) {
    const arity = BWRAP_OPTIONS[args[i] ?? ""];
    if (arity === undefined || i + arity >= args.length)
      throw new Error(`unexpected bwrap argument ${args[i]}`);
    options.push(args.slice(i, i + arity + 1));
  }
  return { options, command: args.slice(i) };
}

/** What the launcher itself reads, so a sandbox that hides their directories can bind them back. */
export const launcherFiles = (): string[] =>
  PACKAGED_BUILD ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "..")];

const ARCHITECTURES: Record<string, { audit: number; socket: number; socketpair: number }> = {
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53 },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199 },
};
const X32_SYSCALL_BIT = 0x40000000;
const IO_URING_SETUP = 425;

/**
 * A classic-BPF seccomp program that makes `socket(AF_UNIX, …)` and `socketpair(AF_UNIX, …)` fail with
 * EACCES and kills anything running under another architecture. `--unshare-net` leaves pathname Unix
 * sockets on the host reachable (connect needs no write access), and seccomp cannot read the address, so
 * creating one is what is refused. x32 calls (x86_64 numbers with bit 30 set) and io_uring, which creates
 * sockets without a syscall the filter sees, fail with ENOSYS.
 */
export function seccompFilter(arch: string = process.arch): Buffer {
  const target = ARCHITECTURES[arch];
  if (!target) throw new Error(`no Unix-socket filter for ${arch}`);
  const [LD, JEQ, JGE, RET] = [0x20, 0x15, 0x35, 0x06];
  // Instructions are [code, k, jump-if-true label, jump-if-false label]; strings mark labels. Jumps fall
  // through when a label is omitted and, as classic BPF requires, only go forward.
  const program: (string | [number, number, string?, string?])[] = [
    [LD, 4], // seccomp_data.arch
    [JEQ, target.audit, undefined, "kill"],
    [LD, 0], // nr
    ...(arch === "x64" ? [[JGE, X32_SYSCALL_BIT, "nosys"] as [number, number, string]] : []),
    [JEQ, IO_URING_SETUP, "nosys"],
    [JEQ, target.socket, "domain"],
    [JEQ, target.socketpair, "domain", "allow"],
    "domain",
    [LD, 16], // the low word of args[0], the domain the kernel reads as an int
    [JEQ, 1, "deny", "allow"], // AF_UNIX
    "allow",
    [RET, 0x7fff0000],
    "deny",
    [RET, 0x00050000 | 13], // ERRNO(EACCES)
    "nosys",
    [RET, 0x00050000 | 38], // ERRNO(ENOSYS)
    "kill",
    [RET, 0x80000000], // KILL_PROCESS
  ];
  const labels = new Map<string, number>();
  let count = 0;
  for (const op of program) typeof op === "string" ? labels.set(op, count) : count++;
  const insns = program.filter((op) => typeof op !== "string");
  return Buffer.concat(
    insns.map(([code, k, jt, jf], i) => {
      const offset = (label?: string) => (label === undefined ? 0 : (labels.get(label) ?? -1) - i - 1);
      const out = Buffer.alloc(8);
      out.writeUInt16LE(code, 0);
      out.writeUInt8(offset(jt), 2);
      out.writeUInt8(offset(jf), 3);
      out.writeUInt32LE(k >>> 0, 4);
      return out;
    }),
  );
}

function libc() {
  const i64 = FFIType.i64;
  return dlopen("libc.so.6", {
    syscall: { args: [i64, i64, i64, i64, i64], returns: i64 },
    prctl: { args: [FFIType.i32, i64, i64, i64, i64], returns: FFIType.i32 },
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    lseek: { args: [FFIType.i32, i64, FFIType.i32], returns: i64 },
    dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    chdir: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

/** Refuse TCP connects to `port` (0: none) and signals or abstract sockets outside this domain. */
function restrict(sys: ReturnType<typeof libc>, port: number): void {
  const abi = Number(sys.syscall(444, 0, 0, 1, 0));
  if (abi < LANDLOCK_MIN_ABI)
    throw new Error(`Landlock ABI ${abi < 0 ? "unavailable" : abi} is older than 6`);
  const attr = new BigUint64Array([0n, port ? CONNECT_TCP : 0n, SCOPE_ABSTRACT_AND_SIGNAL]);
  const fd = Number(sys.syscall(444, ptr(attr), attr.byteLength, 0, 0));
  if (fd < 0) throw new Error("Cannot create a Landlock ruleset");
  // Landlock has no port ranges or denies: every other port gets its own allow rule.
  const rule = new BigUint64Array([CONNECT_TCP, 0n]);
  for (let other = 0; port && other < 65536; other++) {
    if (other === port) continue;
    rule[1] = BigInt(other);
    if (Number(sys.syscall(445, fd, RULE_NET_PORT, ptr(rule), 0)) !== 0)
      throw new Error("Cannot add a Landlock port rule");
  }
  if (sys.prctl(38, 1, 0, 0, 0) !== 0) throw new Error("Cannot set no_new_privs");
  if (Number(sys.syscall(446, fd, 0, 0, 0)) !== 0) throw new Error("Cannot apply Landlock");
}

/** Allow executing only beneath `executables`, then refuse Unix sockets; both survive the exec. */
function restrictExec(sys: ReturnType<typeof libc>, executables: string[]): void {
  const abi = Number(sys.syscall(444, 0, 0, 1, 0));
  if (abi < 1) throw new Error("Landlock is unavailable");
  const attr = new BigUint64Array([ACCESS_FS_EXECUTE]);
  const fd = Number(sys.syscall(444, ptr(attr), attr.byteLength, 0, 0));
  if (fd < 0) throw new Error("Cannot create a Landlock ruleset");
  for (const path of executables) {
    const target = sys.open(ptr(Buffer.from(`${path}\0`)), O_PATH | O_CLOEXEC);
    if (target < 0) throw new Error(`Cannot open ${path}`);
    // struct landlock_path_beneath_attr is packed: the access mask, then the descriptor.
    const rule = Buffer.alloc(12);
    rule.writeBigUInt64LE(ACCESS_FS_EXECUTE, 0);
    rule.writeInt32LE(target, 8);
    const added = Number(sys.syscall(445, fd, RULE_PATH_BENEATH, ptr(rule), 0));
    sys.close(target);
    if (added !== 0) throw new Error(`Cannot add a Landlock rule for ${path}`);
  }
  if (sys.prctl(38, 1, 0, 0, 0) !== 0) throw new Error("Cannot set no_new_privs");
  if (Number(sys.syscall(446, fd, 0, 0, 0)) !== 0) throw new Error("Cannot apply Landlock");
  sys.close(fd);
  const filter = seccompFilter();
  const prog = Buffer.alloc(16);
  prog.writeUInt16LE(filter.length / 8, 0);
  prog.writeBigUInt64LE(BigInt(ptr(filter)), 8);
  if (sys.prctl(22, 2, ptr(prog), 0, 0) !== 0) throw new Error("Cannot apply the Unix-socket filter");
}

const PINNED: Record<string, string> = {
  "--bind": "--bind-fd",
  "--bind-try": "--bind-fd",
  "--ro-bind": "--ro-bind-fd",
  "--ro-bind-try": "--ro-bind-fd",
};

/**
 * Opens every bind source without following a symlink anywhere along its path and has bwrap mount the
 * descriptor, so a host rename or symlink swap after this point cannot change what is mounted. bwrap
 * closes the descriptors before the command starts. A `-try` source that is gone, or is now reached
 * through a symlink, is left out: not binding it only hides more.
 */
function pinSources(sys: ReturnType<typeof libc>, args: string[]): string[] {
  const { options, command } = bwrapOptions(args);
  const how = new BigUint64Array([BigInt(O_PATH), 0n, RESOLVE_NO_SYMLINKS]);
  const pinned = options.flatMap((option) => {
    const [name = "", source = "", dest = ""] = option;
    const fdOption = PINNED[name];
    if (!fdOption) return option;
    const fd = Number(
      sys.syscall(OPENAT2, AT_FDCWD, ptr(Buffer.from(`${source}\0`)), ptr(how), how.byteLength),
    );
    if (fd >= 0) return [fdOption, String(fd), dest];
    if (name.endsWith("-try")) {
      const entry = lstatSync(source, { throwIfNoEntry: false });
      if (!entry || entry.isSymbolicLink()) return [];
    }
    throw new Error(`Cannot open bind source ${source} without following a symlink`);
  });
  return [...pinned, ...command];
}

/** The payload's own variables plus the process-cleanup markers `runProcess` gave the launcher. */
function payloadVars(payload: string): Record<string, string> {
  const vars = { ...(JSON.parse(payload) as Record<string, string>) };
  for (const [key, value] of Object.entries(process.env))
    if (key.startsWith("LIMITLESS_INVOCATION")) vars[key] = value ?? "";
  return vars;
}

const cstrings = (values: string[]) => {
  const buffers = values.map((value) => Buffer.from(`${value}\0`));
  const pointers = new BigUint64Array(buffers.length + 1);
  buffers.forEach((buffer, i) => {
    pointers[i] = BigInt(ptr(buffer));
  });
  return { buffers, pointers };
};

/** Run with the probe's own listeners and pid: any connection or signal that succeeds is a leak. */
async function probe(port: number, abstract: string, pid: number): Promise<number> {
  const attempt = (options: { host: string; port: number } | { path: string }) =>
    new Promise<boolean>((resolve) => {
      const socket = connect(options);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  let signalled = true;
  try {
    process.kill(pid, 0);
  } catch {
    signalled = false;
  }
  const leaks = [
    (await attempt({ host: "127.0.0.1", port })) && "daemon port",
    (await attempt({ path: `\0${abstract}` })) && "abstract socket",
    signalled && "signal",
  ].filter(Boolean);
  if (leaks.length) console.error(`landlock: reached ${leaks.join(", ")}`);
  else process.stdout.write("landlock-verified");
  return leaks.length ? 1 : 0;
}

/**
 * `<port> -- /abs/cmd args…` execs under Landlock; `<port> --probe <abstract> <pid>` reports leaks;
 * `0 --git <cwd> <executable>… -- /abs/git args…` runs inside Git's bubblewrap, where it allows executing
 * only the listed paths, refuses Unix sockets, enters `cwd` and execs git with the payload's environment.
 */
export async function landlockEntry(args: string[]): Promise<number> {
  const [portArg = "", mode, ...rest] = args;
  const port = Number(portArg);
  const split = rest.indexOf("--");
  const command = mode === "--git" ? rest.slice(split + 1) : rest;
  const git = rest.slice(0, split);
  if (
    !/^\d+$/.test(portArg) ||
    port > 65535 ||
    (mode === "--" || mode === "--bwrap"
      ? !isAbsolute(command[0] ?? "")
      : mode === "--git"
        ? port !== 0 || split < 2 || ![...git, command[0] ?? ""].every(isAbsolute)
        : mode !== "--probe" || rest.length !== 2)
  ) {
    console.error(
      "landlock: usage: <port> -- /absolute/command [args…] | <port> --bwrap /absolute/bwrap [options…] -- command… | <port> --probe <abstract> <pid> | 0 --git /cwd /executable… -- /absolute/git [args…]",
    );
    return 2;
  }
  let sys: ReturnType<typeof libc>;
  let gitEnv: string[] | undefined;
  try {
    sys = libc();
    if (mode === "--git") {
      const payload = process.env[PAYLOAD_ENV];
      if (payload === undefined) throw new Error("Missing the payload environment");
      gitEnv = Object.entries(payloadVars(payload)).map(([key, value]) => `${key}=${value}`);
      restrictExec(sys, git.slice(1));
      if (sys.chdir(ptr(Buffer.from(`${git[0]}\0`))) !== 0) throw new Error(`Cannot enter ${git[0]}`);
    } else restrict(sys, port);
  } catch (error) {
    console.error(`landlock: ${error instanceof Error ? error.message : String(error)}`);
    return 125;
  }
  if (mode === "--probe") return probe(port, rest[0] ?? "", Number(rest[1]));
  // A launch from `launch()` carries the payload's environment privately: bwrap and its loader get only
  // the process-cleanup markers, and the payload's shell reads the rest from a descriptor inside.
  const payload = process.env[PAYLOAD_ENV];
  let inherited = Object.entries(process.env).filter(([key]) => key !== PAYLOAD_ENV);
  if (payload !== undefined && gitEnv === undefined) {
    try {
      const vars = payloadVars(payload);
      inherited = inherited.filter(([key]) => key.startsWith("LIMITLESS_INVOCATION"));
      const body = Buffer.from(envScript(vars));
      const fd = sys.memfd_create(ptr(Buffer.from("limitless-env\0")), 0);
      if (fd < 0 || Number(sys.write(fd, ptr(body), BigInt(body.length))) !== body.length)
        throw new Error("cannot stage the payload environment");
      sys.lseek(fd, 0n, 0);
      if (sys.dup2(fd, ENV_FD) !== ENV_FD) throw new Error("cannot stage the payload environment");
    } catch (error) {
      console.error(`landlock: ${error instanceof Error ? error.message : String(error)}`);
      return 125;
    }
  }
  let argv: ReturnType<typeof cstrings>;
  try {
    // After the payload's descriptor is staged, so no pinned source can take its number.
    argv = cstrings(mode === "--bwrap" ? [command[0] ?? "", ...pinSources(sys, command.slice(1))] : command);
  } catch (error) {
    console.error(`landlock: ${error instanceof Error ? error.message : String(error)}`);
    return 125;
  }
  const env = cstrings(gitEnv ?? inherited.map(([key, value]) => `${key}=${value ?? ""}`));
  sys.execve(ptr(argv.buffers[0] ?? Buffer.from("\0")), ptr(argv.pointers), ptr(env.pointers));
  console.error(`landlock: cannot execute ${command[0]}`);
  return 127;
}

if (import.meta.main) process.exitCode = await landlockEntry(Bun.argv.slice(2));
