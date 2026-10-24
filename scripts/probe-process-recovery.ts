/** bun scripts/probe-process-recovery.ts
 * Requires python3. No system-scan result is ever used as a signal target.
 * Direct spawns deliberately bypass runProcess: its cleanup would erase the experiment.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentEnv,
  linuxCallerAncestors,
  markedProcesses,
  processBirth,
  recoveryProcessStopped,
} from "../src/util/proc.ts";

interface Scenario {
  name: string;
  detached?: boolean;
  outside?: boolean;
  platform?: boolean;
  orphan?: boolean;
  nullLeader?: boolean;
  emptyEnv?: boolean;
}

// Each fork PID is returned directly by its creator while the child waits on a pipe.
// The parent cleans up if readiness/inspection fails before release. After release,
// the caller retains the birth identity. Alarms also bound lifetimes if the probe dies.
const helper = `
import os, sys, signal, json
signal.alarm(45)
r, w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(w)
    signal.alarm(45)
    if os.read(r, 1) != b'g': os._exit(0)
    os.close(r)
    if sys.argv[1] == '1': os.setsid()
    os.chdir(sys.argv[2])
    if sys.argv[3] == '1':
        if sys.argv[5] == '1': os.execve('/usr/bin/env', ['env', '-i', '/bin/sleep', '40'], {})
        os.execl('/bin/sleep', 'sleep', '40')
    while True: signal.pause()
os.close(r)
try:
    print(json.dumps({'pid': pid}), flush=True)
    if sys.stdin.readline().strip() != 'go': sys.exit(1)
    os.write(w, b'g')
    os.close(w)
    if sys.argv[4] == '1': os._exit(0)
    sys.stdin.readline()
finally:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.waitpid(pid, 0)
`;

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error(`Unavailable: timed out waiting for ${label}`);
}

const native = process.platform === "darwin" ? await import("../src/util/processes-darwin.ts") : undefined;
const lib =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        getsid: { args: [FFIType.i32], returns: FFIType.i32 },
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        sysctl: {
          args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
      })
    : undefined;

async function state(pid: number) {
  if (lib && native) {
    const info = new Uint32Array(16);
    const vnode = new Uint8Array(2352);
    const args = new Uint8Array(1024 * 1024);
    const size = new BigUint64Array([BigInt(args.length)]);
    const mib = new Int32Array([1, 49, pid]);
    if (
      lib.symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength ||
      lib.symbols.proc_pidinfo(pid, 9, 0, ptr(vnode), vnode.byteLength) !== vnode.byteLength ||
      lib.symbols.sysctl(ptr(mib), mib.length, ptr(args), ptr(size), null, 0) !== 0
    )
      throw new Error("Unavailable: kernel process state/environment inspection denied or process gone");
    const session = lib.symbols.getsid(pid);
    if (session < 0) throw new Error("Unavailable: session inspection denied");
    const length = Number(size[0]);
    const argc = new DataView(args.buffer).getInt32(0, true);
    let offset = args.indexOf(0, 4);
    if (argc <= 0 || offset < 0 || offset >= length) throw new Error("Unavailable: invalid kernel argv");
    while (offset < length && args[offset] === 0) offset++;
    for (let i = 0; i < argc; i++) {
      const end = args.indexOf(0, offset);
      if (end < offset || end >= length) throw new Error("Unavailable: incomplete kernel argv");
      offset = end + 1;
    }
    let name = "";
    native.darwinProcessBirth(pid, (value) => {
      name = value;
    });
    return {
      parent: info[1],
      group: info[2],
      session,
      name,
      cwd: Buffer.from(vnode.subarray(152, 1176)).toString().split("\0")[0],
      hidden: offset === length,
      marker: Buffer.from(args.subarray(offset, length)).toString().split("\0"),
    };
  }
  const row = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = row
    .slice(row.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const { readlink } = await import("node:fs/promises");
  return {
    parent: Number(fields[1]),
    group: Number(fields[2]),
    session: Number(fields[3]),
    name: row.slice(row.indexOf("(") + 1, row.lastIndexOf(")")),
    cwd: await readlink(`/proc/${pid}/cwd`),
    hidden: false,
    marker: (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0"),
  };
}

async function launch(scenario: Scenario, root: string, outside: string, marker: string, detached = true) {
  const child = spawn(
    "python3",
    [
      "-c",
      helper,
      scenario.detached ? "1" : "0",
      scenario.outside ? outside : root,
      scenario.platform ? "1" : "0",
      scenario.orphan ? "1" : "0",
      scenario.emptyEnv ? "1" : "0",
    ],
    {
      cwd: root,
      detached,
      env: { ...agentEnv(), LIMITLESS_INVOCATION: marker },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  child.on("error", (cause) => {
    error += cause.message;
  });
  child.stdin.on("error", (cause) => {
    error += cause.message;
  });
  const lines = createInterface({ input: child.stdout });
  let pid: number | undefined;
  let birth: string | null = null;
  let released = false;
  const stop = async () => {
    child.stdin.end();
    try {
      if (released && pid !== undefined && birth !== null && (await processBirth(pid)) === birth) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
        }
      }
      await until(
        async () =>
          child.pid === undefined || child.exitCode !== null || child.signalCode !== null ? true : undefined,
        "helper exit",
      );
      await exited;
      const targetPid = pid;
      if (targetPid !== undefined)
        await until(
          async () => (recoveryProcessStopped(targetPid) ? true : undefined),
          "owned target stopped",
        );
    } finally {
      lines.close();
    }
  };
  try {
    let line: string | undefined;
    lines.once("line", (value) => {
      line = value;
    });
    const message: unknown = JSON.parse(
      await until(async () => {
        if (error) throw new Error(`Unavailable: helper failed: ${error.trim()}`);
        return line;
      }, "fork PID readiness"),
    );
    if (
      typeof message !== "object" ||
      message === null ||
      !("pid" in message) ||
      typeof message.pid !== "number" ||
      !Number.isSafeInteger(message.pid) ||
      message.pid <= 1
    )
      throw new Error("Invalid fork PID acknowledgement");
    const targetPid = message.pid;
    pid = targetPid;
    birth = await processBirth(pid);
    if (!birth || child.pid === undefined) throw new Error("Unavailable: initial identity inspection failed");
    const leader = native?.captureDarwinInvocationLeader(child.pid) ?? null;
    if (native && !leader) throw new Error("Unavailable: leader capture failed");
    const original = await state(child.pid);
    child.stdin.write("go\n");
    released = true;
    const observed = await until(async () => {
      const current = await state(targetPid);
      if (
        current.cwd !== (scenario.outside ? outside : root) ||
        (scenario.platform && current.name !== "sleep") ||
        (scenario.orphan && current.parent !== 1) ||
        (!scenario.orphan && current.parent !== child.pid) ||
        (scenario.detached && (current.session !== pid || current.group !== pid))
      )
        return;
      if (!scenario.detached && (current.session !== original.session || current.group !== original.group))
        return;
      return current;
    }, "verified exec/cwd/session/parent state");
    if ((await processBirth(pid)) !== birth) throw new Error("Target identity changed");
    return { pid: targetPid, group: child.pid, birth, leader, observed, stop };
  } catch (cause) {
    await stop();
    throw cause;
  }
}

async function probe() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.log("UNAVAILABLE: only Darwin and Linux discovery are supported");
    return;
  }
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "process-recovery-probe-")));
  const { mkdir } = await import("node:fs/promises");
  const root = join(scratch, "invocation");
  const outside = join(scratch, "outside");
  await mkdir(root);
  await mkdir(outside);
  const marker = crypto.randomUUID();
  const controls: Awaited<ReturnType<typeof launch>>[] = [];
  console.log(`Platform ${process.platform}; shared markedProcesses; 5s readiness bound; 45s safety alarms`);
  console.log(
    process.platform === "darwin"
      ? "UNAVAILABLE: Linux env -i measurement (requires Linux); Linux membership unchanged"
      : "UNAVAILABLE: Darwin individual/combined/null-leader measurements (requires macOS)",
  );
  try {
    // Own both controls independently: one in another session, one in the caller's.
    for (const detached of [true, false])
      controls.push(
        await launch(
          { name: "control", outside: true, platform: true },
          outside,
          outside,
          crypto.randomUUID(),
          detached,
        ),
      );
    for (const [index, control] of controls.entries()) {
      const { marker: _environment, ...observed } = control.observed;
      console.log(
        JSON.stringify({
          control: index === 0 ? "independent session" : "caller session/group",
          pid: control.pid,
          helperPid: control.group,
          state: observed,
        }),
      );
    }
    const protectedPids = native?.darwinCallerAncestors() ?? linuxCallerAncestors();
    const scenarios: Scenario[] = native
      ? [
          { name: "setsid only", detached: true },
          { name: "cwd only", outside: true },
          { name: "platform only", platform: true },
          { name: "orphan only", orphan: true },
          { name: "all four", detached: true, outside: true, platform: true, orphan: true },
          {
            name: "null leader: hidden orphan outside roots, original session/group",
            outside: true,
            platform: true,
            orphan: true,
            nullLeader: true,
          },
        ]
      : [{ name: "Linux env -i, original session/group", platform: true, emptyEnv: true }];
    for (const scenario of scenarios) {
      const started = Date.now();
      const spawnedAt = native?.darwinClock() ?? 0n;
      let target: Awaited<ReturnType<typeof launch>> | undefined;
      try {
        target = await launch(scenario, root, outside, marker);
        const { marker: environment, ...observed } = target.observed;
        const carriesMarker = environment.includes(`LIMITLESS_INVOCATION=${marker}`);
        if (!scenario.platform && !carriesMarker)
          throw new Error("UNAVAILABLE: Python environment is hidden; cannot isolate non-platform cases");
        if (scenario.emptyEnv && environment.some((entry) => entry.length))
          throw new Error("env -i did not replace environment");
        if (native && scenario.platform && !observed.hidden)
          throw new Error("UNAVAILABLE: platform environment is visible on this host");
        console.log(
          JSON.stringify({
            scenario: scenario.name,
            pid: target.pid,
            helperPid: target.group,
            state: observed,
            carriesMarker,
            leaderCaptured: target.leader !== null,
            savedLeader: scenario.nullLeader ? null : target.leader,
          }),
        );
        const samples: number[] = [];
        let found: number[] = [];
        const watched = [target, ...controls];
        const assertLive = async () => {
          for (const owned of watched) {
            if ((await processBirth(owned.pid)) !== owned.birth || recoveryProcessStopped(owned.pid))
              throw new Error("UNAVAILABLE: target or negative control ended before measurement completed");
          }
        };
        for (let i = 0; i < 3; i++) {
          await assertLive();
          const start = performance.now();
          found = await markedProcesses(
            marker,
            target.group,
            started,
            [root],
            scenario.nullLeader ? null : target.leader,
            protectedPids,
            spawnedAt,
          );
          samples.push(Number((performance.now() - start).toFixed(2)));
          await assertLive();
          if (controls.some((control) => found.includes(control.pid)))
            throw new Error("Unrelated control claimed");
        }
        console.log(
          JSON.stringify({
            scenario: scenario.name,
            discovered: found.includes(target.pid),
            controlsExcluded: true,
            scanMs: samples,
          }),
        );
      } catch (cause) {
        console.log(`${scenario.name}: UNAVAILABLE/FAILED: ${String(cause)}`);
        process.exitCode = 1;
      } finally {
        if (target) {
          await target.stop();
          console.log(`${scenario.name}: cleanup confirmed`);
        }
      }
    }
  } finally {
    const cleanup = await Promise.allSettled(controls.map((control) => control.stop()));
    const failures = cleanup.filter((result) => result.status === "rejected");
    lib?.close();
    if (failures.length) {
      console.error(
        "Control cleanup UNCONFIRMED",
        failures.map((result) => String(result.reason)),
      );
      process.exitCode = 1;
    } else {
      await rm(scratch, { recursive: true, force: true });
      console.log("Cleanup confirmed for all owned controls; temporary directories removed");
    }
  }
}
if (import.meta.main) await probe();
