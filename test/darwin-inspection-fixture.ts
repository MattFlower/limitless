// Synthetic libproc snapshots: a visible member carries no invocation marker.
export const leaderPid = 424242;
export const memberPid = 424243;
let birth: bigint | null = 1n;
let membership: "session" | "group" = "session";

export function setLeaderBirth(value: bigint | null): void {
  birth = value;
}
export function setMembership(value: "session" | "group"): void {
  membership = value;
}

export const FFIType = { ptr: 0, i32: 1, u32: 2, u64: 3 };
export const ptr = (buffer: ArrayBufferView) => buffer;
export const toArrayBuffer = () => new Int32Array([3 /* ESRCH */]).buffer;
export const dlopen = () => ({
  symbols: {
    __error: () => 1,
    proc_listpids: (_kind: number, _uid: number, buffer: Int32Array | null) => {
      const pids = [process.pid, memberPid, ...(birth === null ? [] : [leaderPid])];
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
        if (pid !== leaderPid) throw new Error("Unexpected birth inspection");
        if (birth === null) return 0;
        new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setBigUint64(120, birth, true);
      } else if (kind === 13 && buffer instanceof Uint32Array) {
        buffer[0] = pid;
        buffer[1] = 1;
        buffer[2] = pid === leaderPid || (pid === memberPid && membership === "group") ? leaderPid : pid;
        buffer[3] = 2;
        buffer[9] = process.getuid?.() ?? 0;
      } else throw new Error(`Unexpected inspection: ${kind}`);
      return size;
    },
    getsid: (pid: number) =>
      pid === leaderPid || (pid === memberPid && membership === "session") ? leaderPid : pid,
    sysctl: (_mib: Int32Array, _length: number, buffer: Uint8Array, size: BigUint64Array) => {
      const bytes = Buffer.concat([
        Buffer.from(new Int32Array([1]).buffer),
        Buffer.from("/visible-command\0visible-command\0PATH=/usr/bin\0"),
      ]);
      buffer.set(bytes);
      size[0] = BigInt(bytes.length);
      return 0;
    },
  },
});
