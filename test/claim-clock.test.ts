import { expect, mock, test } from "bun:test";
import {
  createClockSource,
  LEASE,
  loadNativeClockBindings,
  suspendedBetween,
  windowOpen,
} from "../src/util/claim-clock.ts";
import { sh } from "../src/util/proc.ts";

test("imports defer native loading, and loader failures name the platform", async () => {
  // Keep the FFI mock in a child so it cannot affect this file's real native smoke test.
  const script = `
    import { expect, spyOn } from "bun:test";
    import * as ffi from "bun:ffi";
    const load = spyOn(ffi, "dlopen").mockImplementation(() => {
      throw new Error("Injected library load failure");
    });
    const clock = await import(${JSON.stringify(new URL("../src/util/claim-clock.ts", import.meta.url).href)});
    await import(${JSON.stringify(new URL("../src/integrations/github-time.ts", import.meta.url).href)});
    expect(load).not.toHaveBeenCalled();
    for (const platform of ["darwin", "linux"]) {
      Object.defineProperty(process, "platform", { value: platform });
      expect(() => clock.loadNativeClockBindings()).toThrow("Cannot load native claim clocks on " + platform);
    }
    expect(load).toHaveBeenCalledTimes(2);
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(() => clock.loadNativeClockBindings()).toThrow("Unsupported claim clock platform: win32");
    expect(load).toHaveBeenCalledTimes(2);
  `;
  const result = await sh([process.execPath, "-e", script], { cwd: process.cwd(), timeoutMs: 5_000 });
  expect(result.exitCode).toBe(0);
});

test("Darwin selects monotonic raw and uptime raw, preserving fractional milliseconds", () => {
  const ids: number[] = [];
  const clock = createClockSource({
    platform: "darwin",
    darwin: {
      clockGettimeNsecNp(id) {
        ids.push(id);
        // Independently specified Darwin header IDs, including forbidden CLOCK_MONOTONIC (6).
        if (id === 4) return 12_345_678_901n;
        if (id === 8) return 9_876_543_210n;
        throw new Error(`Unexpected clock ${id}`);
      },
    },
  });
  expect(ids).toEqual([]); // Construction does not sample.
  expect(clock.sample()).toEqual({ inclusive: 12_345.678901, exclusive: 9_876.54321 });
  expect(ids).toEqual([4, 8]);
});

test("Linux selects boottime and monotonic and decodes a native 16-byte timespec", () => {
  const ids: number[] = [];
  const clock = createClockSource({
    platform: "linux",
    linux: {
      clockGettime(id, ts) {
        ids.push(id);
        expect(ts.byteLength).toBe(16);
        const timespec = new BigInt64Array(ts.buffer, ts.byteOffset, 2);
        if (id === 7) timespec.set([12n, 345_678_901n]);
        else if (id === 1) timespec.set([9n, 876_543_210n]);
        else throw new Error(`Unexpected clock ${id}`);
        return 0;
      },
    },
  });
  expect(ids).toEqual([]);
  expect(clock.sample()).toEqual({ inclusive: 12_345.678901, exclusive: 9_876.54321 });
  expect(ids).toEqual([7, 1]);
});

test.each([-1, 1])("Linux syscall return %i throws without fallback", (result) => {
  const ids: number[] = [];
  const clock = createClockSource({
    platform: "linux",
    linux: {
      clockGettime: (id) => {
        ids.push(id);
        return result;
      },
    },
  });
  expect(() => clock.sample()).toThrow("clock_gettime failed on linux");
  expect(ids).toEqual([7]);
});

test.each(["darwin", "linux"] as const)("%s rejects zero on either clock", (platform) => {
  for (const zeroIndex of [0, 1]) {
    let index = 0;
    const clock = createClockSource({
      platform,
      darwin: { clockGettimeNsecNp: () => (index++ === zeroIndex ? 0n : 1_000_000n) },
      linux: {
        clockGettime(_id, ts) {
          new BigInt64Array(ts.buffer).set([0n, index++ === zeroIndex ? 0n : 1_000_000n]);
          return 0;
        },
      },
    });
    expect(() => clock.sample()).toThrow(`Zero claim clock reading on ${platform}`);
  }
});

test("unsupported and missing native bindings fail at construction naming the platform", () => {
  expect(() => createClockSource({ platform: "win32" })).toThrow("win32");
  expect(() => createClockSource({ platform: "linux" })).toThrow("linux");
  expect(() => createClockSource({ platform: "darwin" })).toThrow("darwin");
});

test("lease policy constants", () => {
  expect(LEASE).toEqual({
    renewMs: 180_000,
    expireMs: 600_000,
    windowMs: 420_000,
    suspendToleranceMs: 1_000,
    sampleRoundTripMs: 30_000,
    sampleMaxAgeMs: 60_000,
  });
});

test.each([
  [0, true],
  [360_000, true],
  [419_000, true],
  [420_000, false],
  [480_000, false],
])("window at elapsed %i ms is %s", (elapsed, open) => {
  const anchor = { inclusive: 10_000, exclusive: 8_000 };
  expect(windowOpen(anchor, { inclusive: 10_000 + elapsed, exclusive: 8_000 + elapsed })).toBe(open);
});

test("null anchor cannot open a window", () => {
  expect(windowOpen(null, { inclusive: 0, exclusive: 0 })).toBe(false);
});

test.each([
  [900, true],
  [1_000, true],
  [1_100, false],
  [120_000, false],
])("suspended time %i ms makes the window %s", (suspended, open) => {
  const anchor = { inclusive: 10_000, exclusive: 5_000 };
  const now = { inclusive: 10_000 + suspended, exclusive: 5_000 };
  expect(suspendedBetween(anchor, now)).toBe(suspended);
  expect(windowOpen(anchor, now)).toBe(open);
});

test("fifteen minutes asleep closes the window despite a wall rollback", () => {
  const wall = mock((): number => {
    throw new Error("Wall clock must not be read");
  });
  const caller = {
    wall,
    wallOffset: -900_000,
    anchor: { inclusive: 10_000, exclusive: 8_000 },
    now: { inclusive: 910_000, exclusive: 8_000 },
    allowed() {
      return windowOpen(this.anchor, this.now);
    },
  };
  expect(caller.allowed()).toBe(false);
  expect(wall).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "real native clocks load and are non-decreasing (requires macOS or Linux)",
  () => {
    const clock = createClockSource(loadNativeClockBindings());
    const first = clock.sample();
    const second = clock.sample();
    expect(second.inclusive).toBeGreaterThanOrEqual(first.inclusive);
    expect(second.exclusive).toBeGreaterThanOrEqual(first.exclusive);
  },
);
