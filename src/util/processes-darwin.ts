import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { realpathSync } from "node:fs";
import { sep } from "node:path";

// libproc and KERN_PROCARGS2 are also what macOS ps uses. Unlike ps, these calls
// don't require launching a setuid executable (which worker sandboxes deny).
const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
  __error: { args: [], returns: FFIType.ptr },
  getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  mach_absolute_time: { args: [], returns: FFIType.u64 },
  proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  proc_pidfdinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  proc_pidinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  sysctl: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  sysctlbyname: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  sandbox_check: {
    // Darwin arm64 passes variadic arguments on the stack, after the eight register slots.
    args: [
      FFIType.i32,
      FFIType.ptr,
      FFIType.i32,
      ...(process.arch === "arm64" ? Array<FFIType>(5).fill(FFIType.u64) : []),
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
});

export function darwinBootIdentity(): string {
  const value = Buffer.alloc(128);
  const size = new BigUint64Array([BigInt(value.length)]);
  if (symbols.sysctlbyname(ptr(Buffer.from("kern.bootsessionuuid\0")), ptr(value), ptr(size), null, 0))
    throw new Error("Boot identity inspection failed");
  return value.toString("utf8", 0, Number(size[0])).replaceAll("\0", "").trim();
}

/** Recovery alone accepts zombies as stopped; live cleanup retains its identity semantics. */
export function darwinProcessStopped(pid: number): boolean {
  const info = new Uint32Array(16);
  if (symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) === info.byteLength) return info[3] === 5; // SZOMB
  const address = symbols.__error();
  const errno = address === null ? 0 : new Int32Array(toArrayBuffer(address, 0, 4))[0];
  if (errno === 3) return true; // ESRCH
  throw new Error(`Recovery liveness inspection failed for ${pid} (errno ${errno})`);
}

function readAllowlistConfined(directories: readonly string[]): boolean {
  const check = (operation: string, filter: number, value: string) =>
    symbols.sandbox_check(
      process.pid,
      ptr(Buffer.from(`${operation}\0`)),
      filter | 0x40000000 /* NO_REPORT */,
      ...(process.arch === "arm64" ? [0, 0, 0, 0, 0] : []),
      ptr(Buffer.from(`${value}\0`)),
    );
  // This permission pair exists only in the factory's home read-allowlist profile.
  // Neither an environment marker nor being inside some other sandbox is sufficient.
  return (
    check("mach-lookup", 2 /* GLOBAL_NAME */, "com.limitless.read-allowlist.denied") === 1 &&
    check("mach-lookup", 2, "com.limitless.read-allowlist.allowed") === 0 &&
    directories.length > 0 &&
    directories.every((path) => check("file-read-data", 1 /* PATH */, path) === 0)
  );
}

function darwinDescendant(
  pid: number,
  parents: ReadonlyMap<number, number>,
  members: ReadonlySet<number>,
): boolean {
  const seen = new Set([pid]);
  let parent = parents.get(pid);
  while (parent !== undefined && parent > 1 && !seen.has(parent)) {
    if (members.has(parent)) return true;
    seen.add(parent);
    parent = parents.get(parent);
  }
  return false;
}

/** Roots are canonicalized at invocation start; only orphans need birth time and cwd inspection. */
export function hiddenDarwinProcessMember(
  pid: number,
  parents: ReadonlyMap<number, number>,
  members: ReadonlySet<number>,
  started: number,
  directories: readonly string[],
  readBorn: () => number | { errno: number },
  readCwd: () => { path: string } | { errno: number },
): boolean {
  if (darwinDescendant(pid, parents, members)) return true;
  // Hidden descendants of proven members are ours. Otherwise cwd can identify only
  // orphans (ppid 1) born during this invocation, never a live non-member's children.
  // Residuals: a detached platform tool that leaves the worktree and writes by absolute
  // path, or a hidden process whose parent is still alive but not a member, is unrecognized.
  // On Linux, a descendant that replaces its environment is not recognised unless
  // already claimed; discovery there relies only on environment markers.
  if (parents.get(pid) !== 1) return false;
  const born = readBorn();
  if (typeof born !== "number") {
    if (born.errno === 3 /* ESRCH */) return false;
    throw new Error(`Process birth time inspection failed for ${pid} (errno ${born.errno})`);
  }
  if (born < started) return false;
  const cwd = readCwd();
  if ("errno" in cwd) {
    if (cwd.errno === 3 /* ESRCH */) return false;
    // Under this profile a denied cwd cannot be in the invocation's readable roots.
    if ((cwd.errno === 1 /* EPERM */ || cwd.errno === 13) /* EACCES */ && readAllowlistConfined(directories))
      return false;
    throw new Error(`Process cwd inspection failed for ${pid} (errno ${cwd.errno})`);
  }
  // The kernel reports a symlink-free path; canonicalizing only resolves aliases. Any orphan
  // can be a candidate, and unrelated ones often sit where we cannot look (a sandbox container,
  // a deleted directory), so failing to canonicalize compares the reported path instead.
  let path = cwd.path;
  try {
    path = realpathSync(cwd.path);
  } catch {}
  return directories.some(
    (directory) =>
      path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`),
  );
}

export function darwinProcessBirth(pid: number, name?: (value: string) => void): string | null {
  const bsd = new Uint8Array(136);
  if (symbols.proc_pidinfo(pid, 3 /* PROC_PIDTBSDINFO */, 0, ptr(bsd), bsd.byteLength) !== bsd.byteLength) {
    const address = symbols.__error();
    const errno = address === null ? 0 : (new Int32Array(toArrayBuffer(address, 0, 4))[0] ?? 0);
    if (errno === 3 /* ESRCH */) return null;
    throw new Error(`Process birth time inspection failed for ${pid} (errno ${errno})`);
  }
  const view = new DataView(bsd.buffer);
  name?.(Buffer.from(bsd.subarray(48, 64)).toString("utf8").split("\0")[0] ?? "unknown");
  return `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
}

export interface DarwinInvocationLeader {
  pid: number;
  birth: string;
  session: number;
  group: number;
}

/** Capture membership at spawn, bracketed by the original leader's birth identity. */
export function captureDarwinInvocationLeader(pid: number): DarwinInvocationLeader | null {
  const birth = darwinProcessBirth(pid);
  if (birth === null) return null;
  const info = new Uint32Array(16);
  if (symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength) {
    if (darwinProcessBirth(pid) === null) return null;
    throw new Error(`Process leader inspection failed for ${pid}`);
  }
  const session = symbols.getsid(pid);
  if (darwinProcessBirth(pid) !== birth) return null;
  if (info[3] === 5 /* SZOMB */) return null;
  if (session < 0) throw new Error(`Process session inspection failed for ${pid}`);
  return { pid, birth, session, group: info[2] ?? 0 };
}

/**
 * The path of the file an open descriptor of this process refers to (PROC_PIDFDVNODEPATHINFO; fcntl's
 * F_GETPATH is variadic), or null when the kernel doesn't report one.
 */
export function darwinDescriptorPath(fd: number): string | null {
  // struct vnode_fdinfowithpath: proc_fileinfo (24 bytes), vnode_info (152), then vip_path[MAXPATHLEN].
  const info = new Uint8Array(24 + 152 + 1024);
  if (symbols.proc_pidfdinfo(process.pid, fd, 2, ptr(info), info.byteLength) !== info.byteLength) return null;
  const path = info.subarray(176);
  const end = path.indexOf(0);
  return end > 0 ? Buffer.from(path.subarray(0, end)).toString("utf8") : null;
}

/** Monotonic, in the units of a process's start time from proc_pid_rusage; read it before spawning. */
export function darwinClock(): bigint {
  return BigInt(symbols.mach_absolute_time());
}

export function darwinCallerAncestors(): Set<number> {
  const protectedPids = new Set([1, process.pid, process.ppid]);
  const info = new Uint32Array(16);
  let pid = process.ppid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    protectedPids.add(pid);
    if (symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength) {
      const address = symbols.__error();
      const errno = address === null ? 0 : (new Int32Array(toArrayBuffer(address, 0, 4))[0] ?? 0);
      throw new Error(`Process ancestry could not be confirmed for ${pid} (errno ${errno})`);
    }
    pid = info[1] ?? 0;
  }
  if (pid > 1) throw new Error(`Process ancestry could not be confirmed for ${pid}: cycle`);
  return protectedPids;
}

export function markedDarwinProcesses(
  uid: number,
  marker: string,
  group: number,
  started: number,
  directories: readonly string[],
  leader: DarwinInvocationLeader | null = null,
  protectedPids: ReadonlySet<number> = darwinCallerAncestors(),
  /** `darwinClock()` before the invocation spawned; 0n inspects every process. */
  spawnedAt = 0n,
): number[] {
  const bytes = symbols.proc_listpids(4 /* PROC_UID_ONLY */, uid, null, 0);
  if (bytes <= 0) throw new Error("Process enumeration failed");
  const processes = new Int32Array(Math.ceil(bytes / 4) + 256);
  const count = symbols.proc_listpids(4, uid, ptr(processes), processes.byteLength);
  if (count <= 0 || count >= processes.byteLength || !processes.includes(process.pid))
    throw new Error("Process enumeration could not be confirmed");

  const info = new Uint32Array(16); // proc_bsdshortinfo: 64 bytes
  if (symbols.proc_pidinfo(process.pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength)
    throw new Error("Caller process group inspection failed");
  const callerGroup = info[2];
  const callerSession = symbols.getsid(process.pid);
  if (callerSession < 0) throw new Error("Caller process session inspection failed");
  const args = new Uint8Array(1024 * 1024);
  const size = new BigUint64Array(1);
  const token = Buffer.from(`\0LIMITLESS_INVOCATION=${marker}\0`);
  const inheritedToken = Buffer.from(`\0LIMITLESS_INVOCATION_${marker.replaceAll("-", "_")}=1\0`);
  const marked = new Set<number>();
  const membership = new Set<number>();
  const parents = new Map<number, number>();
  const unmarked: number[] = [];
  const hidden = new Set<number>();
  const bsd = new Uint8Array(136); // proc_bsdinfo includes the process birth time
  const vnode = new Uint8Array(2352); // proc_vnodepathinfo: two vnode_info_path structs
  const usage = new BigUint64Array(12); // rusage_info_v0: ri_proc_start_abstime is the 11th word
  // A process forked before the spawn cannot descend from it: orphans reparent to launchd, and
  // the child's new session and group admit only its descendants. Only the random marker could
  // still match it, and it was not started by this invocation (hiddenDarwinProcessMember drops
  // orphans born before `started` for the same reason). Reading argv is most of a scan's cost,
  // and almost every process predates the spawn. An unreadable or unset (zero) start time is
  // inspected as before.
  const predatesSpawn = (pid: number) => {
    if (spawnedAt <= 0n || symbols.proc_pid_rusage(pid, 0 /* RUSAGE_INFO_V0 */, ptr(usage)) !== 0)
      return false;
    const start = usage[10] ?? 0n;
    return start > 0n && start < spawnedAt;
  };
  const errno = () => {
    const address = symbols.__error();
    return address === null ? 0 : (new Int32Array(toArrayBuffer(address, 0, 4))[0] ?? 0);
  };
  const gone = () => {
    return errno() === 3 /* ESRCH */;
  };
  for (const pid of processes.subarray(0, count / 4)) {
    // A marked caller must not seed ancestry membership for unrelated children.
    if (!pid || protectedPids.has(pid)) continue;
    if (
      symbols.proc_pidinfo(pid, 13 /* PROC_PIDT_SHORTBSDINFO */, 0, ptr(info), info.byteLength) !==
      info.byteLength
    ) {
      if (gone()) continue;
      throw new Error(`Process ownership inspection failed for ${pid}`);
    }
    if (info[9] !== uid || info[3] === 5 /* SZOMB */) continue;
    parents.set(pid, info[1] ?? 0);
    if (predatesSpawn(pid)) continue;
    const processGroup = info[2];
    const session = symbols.getsid(pid);
    if (session < 0) {
      if (gone()) continue;
      throw new Error(`Process session inspection failed for ${pid}`);
    }
    const mib = new Int32Array([1 /* CTL_KERN */, 49 /* KERN_PROCARGS2 */, pid]);
    size[0] = BigInt(args.byteLength);
    if (symbols.sysctl(ptr(mib), mib.length, ptr(args), ptr(size), null, 0) !== 0) {
      // Processes may disappear or become zombies between enumeration and reading argv.
      if (gone()) continue;
      const inspected = symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength);
      if ((inspected === 0 && gone()) || (inspected === info.byteLength && info[3] === 5)) continue;
      // Fork/exec can leave argv unreadable, just like a SIP-hidden environment.
      // Only proven session/group, ancestry or a new orphan's cwd can claim these;
      // unrelated live parents must not block cleanup. Candidate lookup failures
      // still fail closed below, as do identity checks for already-claimed members.
      hidden.add(pid);
    } else {
      const length = Number(size[0]);
      const argc = new DataView(args.buffer).getInt32(0, true);
      let offset = args.indexOf(0, 4); // executable path, followed by padding
      if (length < 4 || argc <= 0 || offset < 0 || offset >= length || length > args.byteLength)
        throw new Error(`Invalid process arguments for ${pid}`);
      while (offset < length && args[offset] === 0) offset++;
      for (let i = 0; i < argc; i++) {
        const end = args.indexOf(0, offset);
        if (end < offset || end >= length) throw new Error(`Incomplete process arguments for ${pid}`);
        offset = end + 1;
      }
      // Read only NUL-delimited environment entries: argv and other variables cannot match.
      const environment = Buffer.from(args.buffer, 0, length);
      if (environment.includes(token, offset - 1) || environment.includes(inheritedToken, offset - 1)) {
        marked.add(pid);
        continue;
      }
      if (offset === length) hidden.add(pid);
    }
    // Our session/group proves membership even when a descendant replaces its
    // environment. Detached descendants also belong through a proven parent chain.
    if (
      leader?.pid === group &&
      group !== callerSession &&
      group !== callerGroup &&
      ((leader.session === group && session === group) || (leader.group === group && processGroup === group))
    )
      membership.add(pid);
    unmarked.push(pid);
  }
  // Validate immediately before accepting numeric membership. An exited leader's
  // observed session/group remains ours; a recycled leader does not. Without the
  // spawn identity, numeric IDs alone cannot establish ownership.
  if (leader && membership.size) {
    const birth = darwinProcessBirth(leader.pid);
    if (birth === leader.birth || birth === null) for (const pid of membership) marked.add(pid);
  }
  const isMember = (pid: number) =>
    hiddenDarwinProcessMember(
      pid,
      parents,
      marked,
      started,
      directories,
      () => {
        if (
          symbols.proc_pidinfo(pid, 3 /* PROC_PIDTBSDINFO */, 0, ptr(bsd), bsd.byteLength) !== bsd.byteLength
        )
          return { errno: errno() };
        const view = new DataView(bsd.buffer);
        return Number(view.getBigUint64(120, true)) * 1000 + Number(view.getBigUint64(128, true)) / 1000;
      },
      () => {
        if (
          symbols.proc_pidinfo(pid, 9 /* PROC_PIDVNODEPATHINFO */, 0, ptr(vnode), vnode.byteLength) !==
          vnode.byteLength
        )
          return { errno: errno() };
        // pvi_cdir.vip_path follows the 152-byte vnode_info, with MAXPATHLEN = 1024.
        const path = Buffer.from(vnode.buffer, 152, 1024);
        const end = path.indexOf(0);
        if (end <= 0) throw new Error(`Invalid process cwd for ${pid}`);
        return { path: path.toString("utf8", 0, end) };
      },
    );
  // Seed orphan members before resolving ancestry, independent of enumeration order.
  for (const pid of hidden) if (parents.get(pid) === 1 && isMember(pid)) marked.add(pid);
  for (const pid of unmarked)
    if (darwinDescendant(pid, parents, marked) || (hidden.has(pid) && isMember(pid))) marked.add(pid);
  return [...marked];
}
