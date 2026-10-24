import { dlopen, FFIType, ptr } from "bun:ffi";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { PACKAGED_BUILD } from "../release.ts";

/** Scoped abstract sockets and signals arrived in ABI 6 (Linux 6.12). */
export const LANDLOCK_MIN_ABI = 6;
const CONNECT_TCP = 2n;
const SCOPE_ABSTRACT_AND_SIGNAL = 3n;
const RULE_NET_PORT = 2;
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

/** `<port> -- /abs/cmd args…` execs under Landlock; `<port> --probe <abstract> <pid>` reports leaks. */
export async function landlockEntry(args: string[]): Promise<number> {
  const [portArg = "", mode, ...rest] = args;
  const port = Number(portArg);
  const command = rest[0] ?? "";
  if (
    !/^\d+$/.test(portArg) ||
    port > 65535 ||
    (mode === "--" ? !isAbsolute(command) : mode !== "--probe" || rest.length !== 2)
  ) {
    console.error("landlock: usage: <port> -- /absolute/command [args…] | <port> --probe <abstract> <pid>");
    return 2;
  }
  let sys: ReturnType<typeof libc>;
  try {
    sys = libc();
    restrict(sys, port);
  } catch (error) {
    console.error(`landlock: ${error instanceof Error ? error.message : String(error)}`);
    return 125;
  }
  if (mode === "--probe") return probe(port, rest[0] ?? "", Number(rest[1]));
  const argv = cstrings(rest);
  // A launch from `launch()` carries the payload's environment privately: bwrap and its loader get only
  // the process-cleanup markers, and the payload's shell reads the rest from a descriptor inside.
  const payload = process.env[PAYLOAD_ENV];
  let inherited = Object.entries(process.env).filter(([key]) => key !== PAYLOAD_ENV);
  if (payload !== undefined) {
    try {
      const vars = { ...(JSON.parse(payload) as Record<string, string>) };
      inherited = inherited.filter(([key]) => key.startsWith("LIMITLESS_INVOCATION"));
      for (const [key, value] of inherited) vars[key] = value ?? "";
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
  const env = cstrings(inherited.map(([key, value]) => `${key}=${value ?? ""}`));
  sys.execve(ptr(argv.buffers[0] ?? Buffer.from("\0")), ptr(argv.pointers), ptr(env.pointers));
  console.error(`landlock: cannot execute ${command}`);
  return 127;
}

if (import.meta.main) process.exitCode = await landlockEntry(Bun.argv.slice(2));
