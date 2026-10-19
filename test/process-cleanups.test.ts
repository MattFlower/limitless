import { afterEach, beforeEach, test as bunTest, expect, spyOn } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import {
  bootIdentity,
  type ProcessCleanup,
  ProcessTerminationError,
  processBirth,
  processBootInspection,
  processRecoveryInspection,
  processScope,
  recoverProcessCleanups,
  recoverScopedProcesses,
  recoveryProcessStopped,
  runProcess,
} from "../src/util/proc.ts";
import { expectProcessStopped } from "./process-support.ts";

const test = (name: string, run: () => Promise<void>, timeout?: number) =>
  bunTest(name, () => processBootInspection.run(() => "test-boot", run), timeout);

let directory: string;
let store: Store;
const children: ChildProcess[] = [];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "limitless-cleanups-")));
  store = new Store(":memory:");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function waitFor(check: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Readiness not observed");
    await Bun.sleep(10);
  }
}

async function processState(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
  }
  const { dlopen, ptr, FFIType } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  try {
    const info = new Uint32Array(16);
    expect(library.symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength)).toBe(info.byteLength);
    return info[3] === 4 ? "T" : info[3] === 5 ? "Z" : "running";
  } finally {
    library.close();
  }
}

async function sleeper(): Promise<ProcessCleanup> {
  const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
  const pid = child.pid;
  if (pid === undefined) throw new Error("Sleeper failed to start");
  const birth = await processBirth(pid);
  if (birth === null) throw new Error("Sleeper exited early");
  return {
    runId: "a",
    invocation: crypto.randomUUID(),
    directory,
    pid,
    birth,
    boot: bootIdentity(),
    createdAt: Date.now(),
  };
}

function scope() {
  return {
    signal: new AbortController().signal,
    killGraceMs: 0,
    children: new Map<ChildProcess, Promise<void>>(),
    scratchDirs: new Set<string>(),
    runId: "a",
    checkout: () => directory,
    cleanups: store,
    terminationError: undefined as ProcessTerminationError | undefined,
  };
}

for (const mismatch of ["birth", "boot"] as const) {
  test(`recovery retires a different ${mismatch} without signalling a live PID`, async () => {
    const row = await sleeper();
    store.recordProcessCleanup({ ...row, [mismatch]: `different-${row[mismatch]}` });
    const kill = spyOn(process, "kill");
    try {
      await recoverProcessCleanups(store);
      expect(kill).not.toHaveBeenCalled();
      expect(await processBirth(row.pid)).toBe(row.birth);
      expect(recoveryProcessStopped(row.pid)).toBe(false);
      expect(["T", "Z"]).not.toContain(await processState(row.pid));
      expect(process.kill(row.pid, 0)).toBe(true);
      expect(store.listProcessCleanups()).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });
}

test("an unavailable boot identity refuses recovery without signalling or retiring ownership", async () => {
  const row = await sleeper();
  store.recordProcessCleanup(row);
  const kill = spyOn(process, "kill");
  try {
    await processBootInspection.run(
      () => {
        throw new Error("boot unavailable");
      },
      async () => {
        await expect(recoverProcessCleanups(store)).rejects.toThrow(
          `${ProcessTerminationError.prefix}: boot unavailable`,
        );
      },
    );
    expect(kill).not.toHaveBeenCalled();
    expect(store.listProcessCleanups()).toEqual([row]);
  } finally {
    kill.mockRestore();
  }
});

test("one deadline covers every killed member; refusal retains rows and blocks subsequent commands", async () => {
  const rows = [await sleeper(), await sleeper()];
  for (const row of rows) store.recordProcessCleanup(row);
  const current = scope();
  const sentinel = join(directory, "spawned");
  await processRecoveryInspection.run({ stopped: () => false, timeoutMs: 0 }, () =>
    processScope.run(current, async () => {
      await expect(
        runProcess({
          cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
          cwd: directory,
          env: {},
        }),
      ).rejects.toThrow(ProcessTerminationError.prefix);
      expect(current.terminationError).toBeInstanceOf(ProcessTerminationError);
      for (const row of rows) expect(current.terminationError?.message).toContain(String(row.pid));
      expect(store.listProcessCleanups()).toHaveLength(2);
      await expect(
        Promise.resolve().then(() => runProcess({ cmd: ["unused"], cwd: directory, env: {} })),
      ).rejects.toBe(current.terminationError);
      expect(existsSync(sentinel)).toBe(false);
    }),
  );
  await waitFor(() => rows.every((row) => recoveryProcessStopped(row.pid)));
  for (const row of rows) expectProcessStopped(row.pid);
});

test("shared directories and path siblings do not link runs; missing checkouts still recover own rows", async () => {
  const shared = join(directory, "repos");
  const checkout = join(directory, "work", "a");
  mkdirSync(checkout, { recursive: true });
  const other = await sleeper();
  store.recordProcessCleanup({ ...other, runId: "b", directory: shared });
  store.recordProcessCleanup({
    ...other,
    invocation: "sibling",
    runId: "b",
    directory: `${checkout}-sibling`,
  });
  const current = { ...scope(), checkout: () => checkout };
  await processRecoveryInspection.run(
    {
      stopped: () => {
        throw new Error("unrelated recovery");
      },
      timeoutMs: 0,
    },
    () =>
      processScope.run(current, async () => {
        const result = await runProcess({
          cmd: [process.execPath, "-e", "console.log('ok')"],
          cwd: checkout,
          env: {},
        });
        expect(result.stdout.trim()).toBe("ok");
      }),
  );
  expect(store.listProcessCleanups()).toHaveLength(2);
  rmSync(checkout, { recursive: true });
  const own = await sleeper();
  children.at(-1)?.kill("SIGKILL");
  await waitFor(() => recoveryProcessStopped(own.pid));
  store.recordProcessCleanup(own);
  await processScope.run(current, recoverScopedProcesses);
  expect(store.listProcessCleanups("a")).toEqual([]);
  expect(store.listProcessCleanups()).toHaveLength(2);
});

test("records inside the checkout are recovered even when owned by another run", async () => {
  const row = await sleeper();
  store.recordProcessCleanup({ ...row, runId: "b", directory: join(directory, "subdirectory") });
  await processScope.run(scope(), async () => {
    const result = await runProcess({
      cmd: [process.execPath, "-e", "console.log('next')"],
      cwd: directory,
      env: {},
      onStdoutLine: () => {
        expectProcessStopped(row.pid);
        expect(store.listProcessCleanups()).toEqual([]);
      },
    });
    expect(result.exitCode).toBe(0);
  });
});

test("a supervisor killed after freeze leaves a durable member recovered before the next command", async () => {
  store.close();
  const database = join(directory, "store.db");
  store = new Store(database);
  const ready = join(directory, "frozen");
  const memberFile = join(directory, "member");
  const script = join(directory, "supervisor.ts");
  const proc = new URL("../src/util/proc.ts", import.meta.url).pathname;
  const db = new URL("../src/db/store.ts", import.meta.url).pathname;
  writeFileSync(
    script,
    `
    import { Store } from ${JSON.stringify(db)};
    import { processBirth, processBirthInspection, processBootInspection, processScope, runProcess } from ${JSON.stringify(proc)};
    import { writeFileSync } from 'node:fs';
    const store = new Store(${JSON.stringify(database)});
    let frozen;
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      const result = kill(pid, signal);
      if (signal === 'SIGSTOP') frozen = pid;
      return result;
    };
    await processBootInspection.run(() => "test-boot", () => processBirthInspection.run({ read: async (pid, name) => {
      if (pid === frozen) {
        writeFileSync(${JSON.stringify(ready)}, String(pid));
        await new Promise(() => {});
      }
      return processBirth(pid, name);
    } }, () => processScope.run({signal: new AbortController().signal, killGraceMs: 0,
      children: new Map(), scratchDirs: new Set(), runId: 'a', cleanups: store }, () => runProcess({
        cmd: [process.execPath, '-e', ${JSON.stringify(`
          const {spawn} = require('node:child_process');
          const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore','pipe','ignore'] });
          child.stdout.once('data', () => { require('fs').writeFileSync(${JSON.stringify(memberFile)}, String(child.pid)); process.exit(0); });
        `)}], cwd: ${JSON.stringify(directory)}, env: process.env
      }))));
  `,
  );
  const supervisor = spawn(process.execPath, [script], { cwd: directory, stdio: "ignore" });
  children.push(supervisor);
  let member: number | undefined;
  try {
    await waitFor(() => existsSync(ready));
    member = Number(readFileSync(memberFile, "utf8"));
    expect(Number(readFileSync(ready, "utf8"))).toBe(member);
    const rows = store.listProcessCleanups();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "a",
      directory,
      pid: member,
      birth: await processBirth(member),
      boot: bootIdentity(),
    });
    expect(await processState(member)).toBe("T");
    supervisor.kill("SIGKILL");
    await new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
    store.close();
    store = new Store(database);
    await processScope.run(scope(), async () => {
      const result = await runProcess({
        cmd: [process.execPath, "-e", "console.log('next')"],
        cwd: directory,
        env: {},
        onStdoutLine: () => {
          expectProcessStopped(member ?? 0);
          expect(store.listProcessCleanups()).toEqual([]);
        },
      });
      expect(result.exitCode).toBe(0);
    });
  } finally {
    if (member === undefined && existsSync(memberFile)) member = Number(readFileSync(memberFile, "utf8"));
    if (member !== undefined && !recoveryProcessStopped(member)) {
      try {
        process.kill(member, "SIGKILL");
      } catch {}
    }
  }
}, 20_000);
