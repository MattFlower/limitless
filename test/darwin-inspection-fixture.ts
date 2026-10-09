// Synthetic libproc snapshots: a visible member carries no invocation marker.
export const leaderPid = 424242;
export const memberPid = 424243;
export const unreadablePid = 424244;
export const ancestorPid = 424245;
let birth: bigint | null = 1n;
let membership: "session" | "group" | "caller-session" | "caller-group" = "session";
let protectedMarker: string | null = null;
let unreadable: {
  parent: number;
  born: bigint | { errno: number };
  cwd: { path: string } | { errno: number };
  inGroup?: boolean;
} | null = null;
let errno = 3;

export function setLeaderBirth(value: bigint | null): void {
  birth = value;
}
export function setMembership(value: typeof membership): void {
  membership = value;
}
export function setProtectedMarker(value: string): void {
  protectedMarker = value;
}
export function setUnreadableProcess(value: typeof unreadable): void {
  unreadable = value;
}

export const FFIType = { ptr: 0, i32: 1, u32: 2, u64: 3 };
export const ptr = (buffer: ArrayBufferView) => buffer;
export const toArrayBuffer = () => new Int32Array([errno]).buffer;
export const dlopen = () => ({
  symbols: {
    __error: () => 1,
    proc_listpids: (_kind: number, _uid: number, buffer: Int32Array | null) => {
      const pids = [
        process.pid,
        ...(protectedMarker ? [process.ppid, ancestorPid] : []),
        ...(unreadable ? [unreadablePid] : []),
        memberPid,
        ...(birth === null ? [] : [leaderPid]),
      ];
      buffer?.set(pids);
      return pids.length * 4;
    },
    proc_pidinfo: (
      pid: number,
      kind: number,
      _zero: number,
      buffer: Uint8Array | Uint32Array,
      size: number,
    ) => {
      buffer.fill(0);
      if (kind === 3) {
        const born = pid === unreadablePid && unreadable ? unreadable.born : birth;
        if (pid !== leaderPid && pid !== unreadablePid && pid !== process.pid)
          throw new Error("Unexpected birth inspection");
        if (born === null || typeof born !== "bigint") {
          errno = born === null ? 3 : born.errno;
          return 0;
        }
        new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setBigUint64(120, born, true);
      } else if (kind === 13 && buffer instanceof Uint32Array) {
        buffer[0] = pid;
        buffer[1] =
          pid === process.ppid && protectedMarker
            ? ancestorPid
            : pid === unreadablePid && unreadable
              ? unreadable.parent
              : 1;
        buffer[2] =
          pid === leaderPid ||
          (pid === memberPid && membership === "group") ||
          (pid === unreadablePid && unreadable?.inGroup)
            ? leaderPid
            : pid === memberPid && membership === "caller-group"
              ? process.pid
              : pid;
        buffer[3] = 2;
        buffer[9] = process.getuid?.() ?? 0;
      } else if (kind === 9 && pid === unreadablePid && unreadable) {
        if ("errno" in unreadable.cwd) {
          errno = unreadable.cwd.errno;
          return 0;
        }
        new Uint8Array(buffer.buffer, buffer.byteOffset + 152).set(Buffer.from(`${unreadable.cwd.path}\0`));
      } else throw new Error(`Unexpected inspection: ${kind}`);
      return size;
    },
    getsid: (pid: number) =>
      pid === leaderPid || (pid === memberPid && membership === "session")
        ? leaderPid
        : pid === memberPid && membership === "caller-session"
          ? process.pid
          : pid,
    sysctl: (mib: Int32Array, _length: number, buffer: Uint8Array, size: BigUint64Array) => {
      if (mib[2] === unreadablePid && unreadable) {
        errno = 22; // EINVAL during fork/exec, while the process is still alive.
        return -1;
      }
      const bytes = Buffer.concat([
        Buffer.from(new Int32Array([1]).buffer),
        Buffer.from(
          `/visible-command\0visible-command\0PATH=/usr/bin\0${
            protectedMarker && [process.pid, process.ppid, ancestorPid].includes(mib[2] ?? 0)
              ? `LIMITLESS_INVOCATION=${protectedMarker}\0`
              : ""
          }`,
        ),
      ]);
      buffer.set(bytes);
      size[0] = BigInt(bytes.length);
      return 0;
    },
  },
});
