import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

// libproc and KERN_PROCARGS2 are also what macOS ps uses. Unlike ps, these calls
// don't require launching a setuid executable (which worker sandboxes deny).
const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
  __error: { args: [], returns: FFIType.ptr },
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

export function markedDarwinProcesses(uid: number, marker: string, group: number, started: number): number[] {
  const bytes = symbols.proc_listpids(4 /* PROC_UID_ONLY */, uid, null, 0);
  if (bytes <= 0) throw new Error("Process enumeration failed");
  const processes = new Int32Array(Math.ceil(bytes / 4) + 256);
  const count = symbols.proc_listpids(4, uid, ptr(processes), processes.byteLength);
  if (count <= 0 || count >= processes.byteLength || !processes.includes(process.pid))
    throw new Error("Process enumeration could not be confirmed");

  const info = new Uint32Array(16); // proc_bsdshortinfo: 64 bytes
  const birth = new Uint8Array(136); // proc_bsdinfo, with start timeval at offsets 120/128
  const args = new Uint8Array(1024 * 1024);
  const size = new BigUint64Array(1);
  const token = Buffer.from(`\0LIMITLESS_INVOCATION=${marker}\0`);
  const marked: number[] = [];
  const gone = () => {
    const errno = symbols.__error();
    return errno !== null && new Int32Array(toArrayBuffer(errno, 0, 4))[0] === 3 /* ESRCH */;
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
    // SIP omits environment data for platform tools such as sh/sleep. Members of the
    // group we created still inherit our marker; detached processes need an exact match.
    if (environment.includes(token, offset - 1) || (offset === length && info[2] === group)) marked.push(pid);
    else if (offset === length && info[1] === 1) {
      if (
        symbols.proc_pidinfo(pid, 3 /* PROC_PIDTBSDINFO */, 0, ptr(birth), birth.byteLength) !==
        birth.byteLength
      ) {
        if (gone()) continue;
        throw new Error(`Process start time inspection failed for ${pid}`);
      }
      const view = new DataView(birth.buffer);
      const created =
        Number(view.getBigUint64(120, true)) * 1000 + Number(view.getBigUint64(128, true)) / 1000;
      // A new orphan with a withheld environment could be an escaped tagged child.
      // Refuse cleanup instead of signalling a process we cannot attribute.
      if (created >= started) throw new Error(`Cannot inspect environment of reparented process ${pid}`);
    }
  }
  return marked;
}
