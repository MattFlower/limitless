import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { realpathSync } from "node:fs";
import { sep } from "node:path";

// libproc and KERN_PROCARGS2 are also what macOS ps uses. Unlike ps, these calls
// don't require launching a setuid executable (which worker sandboxes deny).
const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
  __error: { args: [], returns: FFIType.ptr },
  getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_pidinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  sysctl: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
});

/** Roots are canonicalized at invocation start; cwd inspection is lazy for older processes. */
export function hiddenDarwinProcessMember(
  pid: number,
  born: number,
  started: number,
  directories: readonly string[],
  readCwd: () => { path: string } | { errno: number },
): boolean {
  if (born < started) return false;
  const cwd = readCwd();
  if ("errno" in cwd) {
    if (cwd.errno === 3 /* ESRCH */) return false;
    throw new Error(`Process cwd inspection failed for ${pid} (errno ${cwd.errno})`);
  }
  const path = realpathSync(cwd.path);
  // A detached platform tool that chdirs outside these roots and writes by absolute
  // path cannot be recognized. WorktreeCleanError then becomes a round failure.
  return directories.some(
    (directory) =>
      path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`),
  );
}

export function markedDarwinProcesses(
  uid: number,
  marker: string,
  group: number,
  started: number,
  directories: readonly string[],
): number[] {
  const bytes = symbols.proc_listpids(4 /* PROC_UID_ONLY */, uid, null, 0);
  if (bytes <= 0) throw new Error("Process enumeration failed");
  const processes = new Int32Array(Math.ceil(bytes / 4) + 256);
  const count = symbols.proc_listpids(4, uid, ptr(processes), processes.byteLength);
  if (count <= 0 || count >= processes.byteLength || !processes.includes(process.pid))
    throw new Error("Process enumeration could not be confirmed");

  const info = new Uint32Array(16); // proc_bsdshortinfo: 64 bytes
  const args = new Uint8Array(1024 * 1024);
  const size = new BigUint64Array(1);
  const token = Buffer.from(`\0LIMITLESS_INVOCATION=${marker}\0`);
  const inheritedToken = Buffer.from(`\0LIMITLESS_INVOCATION_${marker.replaceAll("-", "_")}=1\0`);
  const marked: number[] = [];
  const bsd = new Uint8Array(136); // proc_bsdinfo includes the process birth time
  const vnode = new Uint8Array(2352); // proc_vnodepathinfo: two vnode_info_path structs
  const errno = () => {
    const address = symbols.__error();
    return address === null ? 0 : (new Int32Array(toArrayBuffer(address, 0, 4))[0] ?? 0);
  };
  const gone = () => {
    return errno() === 3 /* ESRCH */;
  };
  for (const pid of processes.subarray(0, count / 4)) {
    if (!pid) continue;
    if (
      symbols.proc_pidinfo(pid, 13 /* PROC_PIDT_SHORTBSDINFO */, 0, ptr(info), info.byteLength) !==
      info.byteLength
    ) {
      if (gone()) continue;
      throw new Error(`Process ownership inspection failed for ${pid}`);
    }
    if (info[9] !== uid || info[3] === 5 /* SZOMB */) continue;
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
      throw new Error(`Process environment inspection failed for ${pid}`);
    }
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
    // SIP omits environment data for platform tools. Our session/group still proves
    // membership; detached tools need birth time and cwd evidence instead.
    if (
      environment.includes(token, offset - 1) ||
      environment.includes(inheritedToken, offset - 1) ||
      (offset === length && (session === group || info[2] === group))
    )
      marked.push(pid);
    else if (offset === length) {
      if (
        symbols.proc_pidinfo(pid, 3 /* PROC_PIDTBSDINFO */, 0, ptr(bsd), bsd.byteLength) !== bsd.byteLength
      ) {
        if (gone()) continue;
        throw new Error(`Process birth time inspection failed for ${pid}`);
      }
      const view = new DataView(bsd.buffer);
      const born = Number(view.getBigUint64(120, true)) * 1000 + Number(view.getBigUint64(128, true)) / 1000;
      if (
        hiddenDarwinProcessMember(pid, born, started, directories, () => {
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
        })
      )
        marked.push(pid);
    }
  }
  return marked;
}
