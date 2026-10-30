import { dlopen, FFIType, ptr } from "bun:ffi";

export type ClockSample = { inclusive: number; exclusive: number };
export interface ClockSource {
  sample(): ClockSample;
}
export type NativeClockBindings = {
  platform: NodeJS.Platform;
  darwin?: { clockGettimeNsecNp(id: number): bigint };
  linux?: { clockGettime(id: number, ts: Uint8Array): number };
};

const CLOCK_MONOTONIC_RAW = 4; // Darwin <time.h>
const CLOCK_UPTIME_RAW = 8; // Darwin <time.h>
const CLOCK_BOOTTIME = 7; // Linux <time.h>
const CLOCK_MONOTONIC = 1; // Linux <time.h>; never used on Darwin.

export function loadNativeClockBindings(): NativeClockBindings {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
        clock_gettime_nsec_np: { args: [FFIType.i32], returns: FFIType.u64 },
      });
      return { platform, darwin: { clockGettimeNsecNp: (id) => BigInt(symbols.clock_gettime_nsec_np(id)) } };
    }
    if (platform === "linux") {
      const { symbols } = dlopen("libc.so.6", {
        clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      });
      return { platform, linux: { clockGettime: (id, ts) => symbols.clock_gettime(id, ptr(ts)) } };
    }
  } catch (cause) {
    throw new Error(`Cannot load native claim clocks on ${platform}`, { cause });
  }
  throw new Error(`Unsupported claim clock platform: ${platform}`);
}

export function createClockSource(bindings: NativeClockBindings = loadNativeClockBindings()): ClockSource {
  const { platform, darwin, linux } = bindings;
  let read: (id: number) => number;
  if (platform === "darwin" && darwin) {
    read = (id) => Number(darwin.clockGettimeNsecNp(id)) / 1_000_000;
  } else if (platform === "linux" && linux) {
    read = (id) => {
      const ts = new Uint8Array(16);
      if (linux.clockGettime(id, ts) !== 0) throw new Error(`clock_gettime failed on ${platform}`);
      const [seconds, nanos] = new BigInt64Array(ts.buffer);
      return Number(seconds) * 1_000 + Number(nanos) / 1_000_000;
    };
  } else {
    throw new Error(`Unsupported or missing native claim clock bindings for ${platform}`);
  }
  return {
    sample() {
      const inclusive = read(platform === "darwin" ? CLOCK_MONOTONIC_RAW : CLOCK_BOOTTIME);
      const exclusive = read(platform === "darwin" ? CLOCK_UPTIME_RAW : CLOCK_MONOTONIC);
      if (inclusive === 0 || exclusive === 0) throw new Error(`Zero claim clock reading on ${platform}`);
      return { inclusive, exclusive };
    },
  };
}

export const LEASE = {
  renewMs: 180_000,
  expireMs: 600_000,
  windowMs: 420_000,
  suspendToleranceMs: 1_000,
  sampleRoundTripMs: 30_000,
  sampleMaxAgeMs: 60_000,
};

export function suspendedBetween(a: ClockSample, b: ClockSample): number {
  return b.inclusive - a.inclusive - (b.exclusive - a.exclusive);
}

/** The anchor is sampled immediately before sending the write that created the tip. */
export function windowOpen(anchor: ClockSample | null, now: ClockSample): boolean {
  return (
    anchor !== null &&
    now.inclusive - anchor.inclusive < LEASE.windowMs &&
    suspendedBetween(anchor, now) <= LEASE.suspendToleranceMs
  );
}
