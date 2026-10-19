import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import {
  type ProcessCleanupRecord,
  ProcessTerminationError,
  processBirth,
  processBirthInspection,
  processBootIdentity,
  processBootInspection,
  processInspection,
  processScope,
  recoverProcessCleanups,
  runProcess,
} from "../src/util/proc.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-cleanup-")));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const scope = (runId = "run") => ({
  signal: new AbortController().signal,
  killGraceMs: 0,
  children: new Map<ChildProcess, Promise<void>>(),
  scratchDirs: new Set<string>(),
  cleanup: { store, runId },
});
const record = (pid: number, birth = "original", invocation = "invocation"): ProcessCleanupRecord => ({
  runId: "run",
  invocation,
  cwd: dir,
  pid,
  birth,
  boot: processBootIdentity(),
});
const command = () => ({
  cmd: ["/bin/sh", "-c", "printf sentinel > sentinel; printf sentinel"],
  cwd: dir,
  env: {},
});
const reopen = () => {
  store.close();
  store = new Store(join(dir, "db.sqlite"));
};
const waitFor = async (ready: () => boolean) => {
  const deadline = Date.now() + 15_000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for owned subprocess");
    await Bun.sleep(10);
  }
};
const closed = (child: ChildProcess) => new Promise<void>((resolve) => child.once("close", () => resolve()));

// No OS signals reach these synthetic PIDs.
test("recovery resolves reused and absent PIDs without signalling replacements", async () => {
  store.recordProcessCleanup(record(424241));
  store.recordProcessCleanup(record(424242));
  reopen();
  const reads: number[] = [];
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw new Error("unexpected signal");
  });
  try {
    await processBirthInspection.run(
      {
        read: async (pid) => {
          reads.push(pid);
          return pid === 424241 ? "replacement" : null;
        },
      },
      () => recoverProcessCleanups(store),
    );
    expect(reads).toEqual([424241, 424242]);
    expect(kill).not.toHaveBeenCalled();
    expect(store.pendingProcessCleanups()).toEqual([]);
    await recoverProcessCleanups(store);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

test("a different boot retires matching live identities without signalling", async () => {
  const writer = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const exit = closed(writer);
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw new Error("unexpected signal");
  });
  try {
    const pid = writer.pid;
    if (pid === undefined) throw new Error("Missing owned PID");
    const birth = await processBirth(pid);
    if (birth === null) throw new Error("Missing owned birth");
    store.recordProcessCleanup({ ...record(pid, birth), boot: "previous-boot" });
    reopen();
    expect(store.pendingProcessCleanups()[0]?.boot).toBe("previous-boot");
    await processBootInspection.run(
      () => "current-boot",
      () => recoverProcessCleanups(store),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(await processBirth(pid)).toBe(birth);
    expect(store.pendingProcessCleanups()).toEqual([]);
  } finally {
    kill.mockRestore();
    writer.kill("SIGKILL");
    await exit;
  }
});

test.each(["throws", "empty"])("unconfirmed boot (%s) stays durable and blocks commands", async (failure) => {
  store.recordProcessCleanup(record(424246));
  reopen();
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw new Error("unexpected signal");
  });
  try {
    await processBootInspection.run(
      () => {
        if (failure === "throws") throw new Error("boot inspection denied");
        return "";
      },
      () =>
        processScope.run(scope(), async () => {
          await expect(runProcess(command())).rejects.toThrow(
            failure === "throws" ? "boot inspection denied" : "Boot identity could not be confirmed",
          );
          await expect(runProcess(command())).rejects.toBeInstanceOf(ProcessTerminationError);
          expect(existsSync(join(dir, "sentinel"))).toBe(false);
        }),
    );
    expect(kill).not.toHaveBeenCalled();
    reopen();
    expect(store.pendingProcessCleanups()).toHaveLength(1);
  } finally {
    kill.mockRestore();
  }
});

test.each(["inspection", "signal", "confirmation"])(
  "%s failure stays durable and blocks the next checkout command",
  async (failure) => {
    store.recordProcessCleanup(record(424243));
    reopen();
    let reads = 0;
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const kill = spyOn(process, "kill").mockImplementation(() => {
      if (failure === "signal") throw new Error("cleanup signal denied");
      now = 10_001;
      return true;
    });
    try {
      await processBirthInspection.run(
        {
          read: async () => {
            reads++;
            if (failure === "inspection") throw new Error("birth inspection denied");
            return "original";
          },
        },
        async () => {
          await processScope.run(scope(), async () => {
            const error = await runProcess(command()).catch((error: unknown) => error);
            expect(error).toBeInstanceOf(ProcessTerminationError);
            expect(String(error)).toContain("run run, invocation invocation");
            expect(String(error)).toContain(
              failure === "inspection"
                ? "birth inspection denied"
                : failure === "signal"
                  ? "cleanup signal denied"
                  : "Recorded process still alive",
            );
            await expect(runProcess(command())).rejects.toBeInstanceOf(ProcessTerminationError);
            expect(existsSync(join(dir, "sentinel"))).toBe(false);
          });
        },
      );
      expect(reads).toBeGreaterThan(0);
      expect(kill).toHaveBeenCalledTimes(failure === "inspection" ? 0 : 1);
      reopen();
      expect(store.pendingProcessCleanups()).toHaveLength(1);
    } finally {
      kill.mockRestore();
      clock.mockRestore();
    }
    await processBirthInspection.run({ read: async () => null }, () =>
      processScope.run(scope(), async () => {
        expect((await runProcess(command())).stdout).toBe("sentinel");
      }),
    );
    expect(store.pendingProcessCleanups()).toEqual([]);
  },
);

test.each([false, true])(
  "initial and later-sweep claims are persisted before signalling (write failure=%s)",
  async (failWrite) => {
    const writers = [
      spawn("/bin/sleep", ["30"], { stdio: "ignore" }),
      spawn("/bin/sleep", ["30"], { stdio: "ignore" }),
    ];
    const exits = writers.map(closed);
    const pids = writers.map((w) => w.pid);
    if (pids.some((pid) => pid === undefined)) throw new Error("Missing owned writer PID");
    const births = await Promise.all(pids.map((pid) => processBirth(pid ?? 0)));
    const sent: { pid: number; signal: string | number | undefined }[] = [];
    let recovery: Promise<unknown> | undefined;
    const kill = process.kill.bind(process);
    const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pids.includes(pid)) {
        expect(store.pendingProcessCleanups()).toContainEqual(
          record(pid, births[pids.indexOf(pid)] ?? "", store.pendingProcessCleanups()[0]?.invocation),
        );
        sent.push({ pid, signal });
        if (!recovery && signal === "SIGSTOP")
          recovery = recoverProcessCleanups(store).catch((error: unknown) => error);
      }
      return kill(pid, signal);
    });
    const write = store.recordProcessCleanup.bind(store);
    const writeSpy = spyOn(store, "recordProcessCleanup").mockImplementation((member) => {
      if (failWrite && member.pid === pids[1]) throw new Error("ownership disk unavailable");
      write(member);
    });
    let sweeps = 0;
    const active = scope();
    try {
      await processInspection.run(
        async (environment, marker) => {
          if (environment) sweeps++;
          return (
            `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}\n` +
            pids
              .filter(
                (pid, index) =>
                  (index === 0 || sweeps > 1) && !sent.some((s) => s.pid === pid && s.signal === "SIGKILL"),
              )
              .map(
                (pid) =>
                  `${pid} ${process.getuid?.()} S writer${environment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`,
              )
              .join("\n")
          );
        },
        () =>
          processScope.run(active, async () => {
            const result = runProcess(command());
            if (failWrite) {
              await expect(result).rejects.toThrow("Could not persist cleanup ownership");
              await expect(runProcess(command())).rejects.toBeInstanceOf(ProcessTerminationError);
              expect(sent.some((s) => s.pid === pids[1])).toBe(false);
              expect(store.pendingProcessCleanups()).toHaveLength(1);
            } else {
              expect((await result).stdout).toBe("sentinel");
              expect(sent.map((s) => [s.pid, s.signal])).toEqual([
                [pids[0], "SIGSTOP"],
                [pids[1], "SIGSTOP"],
                [pids[0], "SIGKILL"],
                [pids[1], "SIGKILL"],
              ]);
              expect(store.pendingProcessCleanups()).toEqual([]);
            }
          }),
      );
      const recovered = await recovery;
      if (failWrite) expect(recovered).toBeInstanceOf(ProcessTerminationError);
      else expect(recovered).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
      killSpy.mockRestore();
      for (const writer of writers)
        if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
      await Promise.all(exits);
    }
  },
);

test.each(["write", "null identity", "throwing identity"])(
  "a live direct child is killed despite %s failure",
  async (failure) => {
    const active = scope();
    const controller = new AbortController();
    let pid: number | undefined;
    let childExit: Promise<void> | undefined;
    let childKill: ReturnType<typeof spyOn<ChildProcess, "kill">> | undefined;
    const sent: number[] = [];
    const kill = process.kill.bind(process);
    const killSpy = spyOn(process, "kill").mockImplementation((target, signal) => {
      sent.push(target);
      return kill(target, signal);
    });
    const write = spyOn(store, "recordProcessCleanup").mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    try {
      await processBirthInspection.run(
        {
          read: async (target) => {
            if (failure === "null identity") return null;
            if (failure === "throwing identity") throw new Error("birth inspection denied");
            return processBirth(target);
          },
        },
        () =>
          processInspection.run(
            async (environment, marker) => {
              if (failure === "write")
                return `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}\n${pid} ${process.getuid?.()} S writer${environment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`;
              throw new Error("discovery unavailable");
            },
            () =>
              processScope.run(active, async () => {
                await expect(
                  runProcess({
                    cmd: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
                    cwd: dir,
                    env: process.env as Record<string, string>,
                    signal: controller.signal,
                    onStdoutLine(line) {
                      pid = Number(line);
                      const child = [...active.children.keys()][0];
                      if (!child) throw new Error("Missing owned child handle");
                      childExit = closed(child);
                      childKill = spyOn(child, "kill");
                      controller.abort();
                    },
                  }),
                ).rejects.toThrow(
                  failure === "write"
                    ? "disk unavailable"
                    : failure === "null identity"
                      ? "Direct child identity could not be confirmed"
                      : "birth inspection denied",
                );
                expect(pid).toBeGreaterThan(0);
                expect(sent).not.toContain(pid);
                expect(childKill).toHaveBeenCalledWith("SIGKILL");
                await childExit;
                const child = [...active.children.keys()][0];
                if (!child) throw new Error("Missing owned child handle");
                expect(child.signalCode).toBe("SIGKILL");
                expect(await processBirth(pid ?? 0)).toBeNull();
                await expect(runProcess(command())).rejects.toBeInstanceOf(ProcessTerminationError);
                expect(existsSync(join(dir, "sentinel"))).toBe(false);
              }),
          ),
      );
    } finally {
      childKill?.mockRestore();
      killSpy.mockRestore();
      write.mockRestore();
      for (const child of active.children.keys()) {
        const exit = child.exitCode === null && child.signalCode === null ? closed(child) : Promise.resolve();
        child.kill("SIGKILL");
        await exit;
      }
    }
  },
);

const linuxRecoverySkip = process.platform !== "linux" ? "requires Linux procfs and zombie states" : null;
test.skipIf(linuxRecoverySkip !== null)(
  `recovery kills every frozen member before polling (${linuxRecoverySkip ?? "Linux"})`,
  async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exit = closed(parent);
    let childPid: number | undefined;
    let childBirth: string | null = null;
    let killSpy: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    parent.stdout?.on("data", (chunk) => {
      childPid = Number(String(chunk).trim());
    });
    try {
      await waitFor(() => childPid !== undefined);
      const parentPid = parent.pid;
      if (parentPid === undefined || childPid === undefined) throw new Error("Missing owned PIDs");
      const parentBirth = await processBirth(parentPid);
      childBirth = await processBirth(childPid);
      if (parentBirth === null || childBirth === null) throw new Error("Missing owned birth");
      process.kill(parentPid, "SIGSTOP");
      await waitFor(() => {
        const stat = readFileSync(`/proc/${parentPid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
      });
      store.recordProcessCleanup(record(childPid, childBirth));
      store.recordProcessCleanup(record(parentPid, parentBirth));
      reopen();
      const signals: number[] = [];
      const kill = process.kill.bind(process);
      killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === childPid || pid === parentPid) {
          expect(signal).toBe("SIGKILL");
          signals.push(pid);
        }
        return kill(pid, signal);
      });
      const reads: number[] = [];
      await processBirthInspection.run(
        {
          read: async (pid) => {
            if (pid === childPid || pid === parentPid) {
              reads.push(pid);
              if (pid === parentPid && signals.length === 1) {
                await waitFor(() => {
                  const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
                  return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
                });
                expect(await processBirth(Number(childPid))).toBeNull();
              }
              if (reads.length > 2) expect(signals).toEqual([Number(childPid), parentPid]);
            }
            return processBirth(pid);
          },
        },
        () =>
          processScope.run(scope(), async () => {
            expect((await runProcess(command())).stdout).toBe("sentinel");
          }),
      );
      await exit;
      expect(signals).toEqual([Number(childPid), parentPid]);
      expect(await processBirth(childPid)).toBeNull();
      expect(store.pendingProcessCleanups()).toEqual([]);
      expect(readFileSync(join(dir, "sentinel"), "utf8")).toBe("sentinel");
    } finally {
      killSpy?.mockRestore();
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await exit;
      if (childPid !== undefined && childBirth !== null && (await processBirth(childPid)) === childBirth)
        process.kill(childPid, "SIGKILL");
    }
  },
);

test.each(["own", "shared", "inside", "equal", "sibling"])(
  "command recovery selects %s records using the current worktree",
  async (location) => {
    const worktree = join(dir, "worktree");
    mkdirSync(join(worktree, "subdir"), { recursive: true });
    const worktreeAlias = join(dir, "worktree-alias");
    symlinkSync(worktree, worktreeAlias);
    const sibling = `${worktree}-sibling`;
    mkdirSync(sibling);
    const own = location === "own";
    const member = {
      ...record(424247),
      runId: own ? "run" : "other",
      cwd:
        location === "inside"
          ? join(worktree, "subdir")
          : location === "equal"
            ? worktree
            : location === "sibling"
              ? sibling
              : dir,
    };
    store.recordProcessCleanup(member);
    const blocked = own || location === "inside" || location === "equal";
    const active = scope();
    let currentWorktree: string | undefined;
    const cleanup = { ...active.cleanup, worktreePath: () => currentWorktree };
    const reads: number[] = [];
    await processBirthInspection.run(
      {
        read: async (pid) => {
          if (pid === member.pid) {
            reads.push(pid);
            throw new Error("birth inspection denied");
          }
          return processBirth(pid);
        },
      },
      () =>
        processScope.run({ ...active, cleanup }, async () => {
          // The worktree can be created after the run's process scope.
          currentWorktree = own ? undefined : worktreeAlias;
          if (blocked) await expect(runProcess(command())).rejects.toThrow("birth inspection denied");
          else expect((await runProcess(command())).stdout).toBe("sentinel");
        }),
    );
    expect(existsSync(join(dir, "sentinel"))).toBe(!blocked);
    expect(reads).toEqual(blocked ? [member.pid] : []);
    expect(store.pendingProcessCleanups()).toEqual([member]);
  },
);

test("a fresh process recovers a crash between freeze and kill before its next command", async () => {
  const procUrl = new URL("../src/util/proc.ts", import.meta.url).href;
  const storeUrl = new URL("../src/db/store.ts", import.meta.url).href;
  const pidFile = join(dir, "sleeper.pid");
  const stopped = join(dir, "stopped");
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  const supervisorFile = join(dir, "supervisor.ts");
  writeFileSync(
    supervisorFile,
    `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { Store } from ${JSON.stringify(storeUrl)};
    import { processScope, processBootInspection, invocationScratch, runProcess } from ${JSON.stringify(procUrl)};
    processBootInspection.enterWith(() => "test-boot");
      const store = new Store(${JSON.stringify(join(dir, "db.sqlite"))});
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      const result = kill(pid, signal);
      if (signal === 'SIGSTOP' && pid === Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8'))) {
        writeFileSync(${JSON.stringify(stopped)}, String(pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return result;
    };
    await processScope.run({ signal: new AbortController().signal, killGraceMs: 0, children: new Map(), scratchDirs: new Set(), cleanup: {store, runId:'run'} }, () =>
      invocationScratch.run(${JSON.stringify(scratch)}, () => runProcess({
        cmd: [process.execPath, '-e', ${JSON.stringify(`
          const { spawn } = require('node:child_process');
          const { existsSync } = require('node:fs');
          spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { detached: true, stdio: 'ignore' }).unref();
          const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); process.exit(0); } }, 5);
        `)}], cwd: ${JSON.stringify(dir)}, env: process.env
      })));
  `,
  );
  const supervisor = spawn(process.execPath, [supervisorFile], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const supervisorExit = closed(supervisor);
  let resume: ChildProcess | undefined;
  let resumeExit: Promise<void> | undefined;
  let sleeper: number | undefined;
  let birth: string | null = null;
  let errors = "";
  supervisor.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  try {
    await waitFor(() => existsSync(stopped) || supervisor.exitCode !== null);
    expect(errors).toBe("");
    expect(existsSync(stopped)).toBe(true);
    sleeper = Number(readFileSync(pidFile, "utf8"));
    const pid = sleeper;
    if (process.platform === "linux") {
      await waitFor(() => {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
      });
    } else {
      const { dlopen, FFIType, ptr } = await import("bun:ffi");
      const native = dlopen("/usr/lib/libSystem.B.dylib", {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      });
      const info = new Uint32Array(34);
      try {
        await waitFor(
          () =>
            native.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.byteLength) === info.byteLength &&
            info[1] === 4 /* SSTOP */,
        );
      } finally {
        native.close();
      }
    }
    birth = await processBirth(sleeper);
    expect(birth).not.toBeNull();
    if (birth === null) throw new Error("Missing owned sleeper birth identity");
    expect(store.pendingProcessCleanups()).toContainEqual(
      expect.objectContaining({ pid: sleeper, birth, runId: "run" }),
    );
    supervisor.kill("SIGKILL");
    await supervisorExit;
    rmSync(scratch, { recursive: true });
    const resumed = join(dir, "resume.ts");
    const checked = join(dir, "checked");
    const sentinel = join(dir, "sentinel");
    writeFileSync(
      resumed,
      `
      import { writeFileSync } from 'node:fs';
      import { Store } from ${JSON.stringify(storeUrl)};
      import { processScope, processBirth, processBirthInspection, processBootInspection, runProcess } from ${JSON.stringify(procUrl)};
      processBootInspection.enterWith(() => "test-boot");
      const store = new Store(${JSON.stringify(join(dir, "db.sqlite"))});
      await processBirthInspection.run({ read: async (pid) => {
        const birth = await processBirth(pid);
        if (pid === ${sleeper} && birth === ${JSON.stringify(birth)}) writeFileSync(${JSON.stringify(checked)}, birth);
        return birth;
      } }, () => processScope.run({signal:new AbortController().signal, killGraceMs:0, children:new Map(), scratchDirs:new Set(), cleanup:{store, runId:'run'}}, () =>
        runProcess({cmd:[process.execPath, '-e', ${JSON.stringify(`
          const { processBirth } = await import(${JSON.stringify(procUrl)});
          if (await processBirth(${sleeper}) !== null) throw new Error('previous descendant survived');
          require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'continued');
        `)}], cwd:${JSON.stringify(dir)}, env:process.env})));
      store.close();
    `,
    );
    resume = spawn(process.execPath, [resumed], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    resumeExit = closed(resume);
    resume.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    await resumeExit;
    expect({ exitCode: resume.exitCode, errors }).toEqual({ exitCode: 0, errors: "" });
    expect(readFileSync(checked, "utf8")).toBe(birth);
    expect(readFileSync(sentinel, "utf8")).toBe("continued");
    expect(await processBirth(sleeper)).toBeNull();
    expect(store.pendingProcessCleanups()).toEqual([]);
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    await supervisorExit;
    if (resume && resume.exitCode === null && resume.signalCode === null) resume.kill("SIGKILL");
    await resumeExit;
    if (sleeper === undefined && existsSync(pidFile)) {
      sleeper = Number(readFileSync(pidFile, "utf8"));
      birth = await processBirth(sleeper);
    }
    if (sleeper !== undefined && birth !== null && (await processBirth(sleeper)) === birth) {
      try {
        process.kill(sleeper, "SIGKILL");
      } catch {}
    }
  }
}, 30_000);

test("startup serves health while cancelled-run recovery is pending and legacy runs still resume", async () => {
  const { fixture } = await import("./mcp-support.ts");
  const { startDaemon } = await import("../src/cli/daemon.ts");
  const { executeRun } = await import("../src/pipeline/engine.ts");
  const f = await fixture();
  f.factory.cfg.port = 0;
  f.factory.cfg.listenLan = null;
  const writer = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const exit = closed(writer);
  const start = spyOn(f.factory, "start").mockImplementation(() => {});
  const kill = process.kill.bind(process);
  const signals: number[] = [];
  const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === writer.pid) signals.push(pid);
    return kill(pid, signal);
  });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const run = await f.factory.createRun({ repo: f.repo, prompt: "cancelled cleanup" });
    f.factory.store.updateRun(run.id, { status: "cancelled" });
    const pid = writer.pid;
    if (pid === undefined) throw new Error("Missing owned writer PID");
    const birth = await processBirth(pid);
    if (birth === null) throw new Error("Missing owned writer identity");
    f.factory.store.recordProcessCleanup({ ...record(pid, birth), runId: run.id });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      await processBirthInspection.run(
        {
          read: async (target) => {
            if (target === pid) {
              entered.resolve();
              await release.promise;
            }
            return processBirth(target);
          },
        },
        async () => {
          daemon = await startDaemon(f.factory, {}, async () => ({
            routes: {},
            notes: [],
            stop: async () => {},
          }));
          await entered.promise;
          expect(f.factory.store.pendingProcessCleanups()).toHaveLength(1);
          expect((await fetch(`http://127.0.0.1:${daemon.server.port}/api/health`)).status).toBe(200);
          expect(await processBirth(pid)).toBe(birth);
          const guarded = processScope.run(
            { ...scope(run.id), cleanup: { store: f.factory.store, runId: run.id } },
            () => runProcess(command()),
          );
          expect(existsSync(join(dir, "sentinel"))).toBe(false);
          release.resolve();
          await guarded;
          await waitFor(() => f.factory.store.pendingProcessCleanups().length === 0);
        },
      );
    } finally {
      release.resolve();
    }
    await daemon?.server.stop(true);
    daemon = await startDaemon(f.factory, {}, async () => ({ routes: {}, notes: [], stop: async () => {} }));
    await daemon.server.stop(true);
    daemon = undefined;
    expect(signals).toEqual([pid]);
    expect(f.factory.store.getRun(run.id)?.status).toBe("cancelled");
    const legacy = await f.factory.createRun({ repo: f.repo, prompt: "legacy resume" });
    f.factory.store.setRunState(legacy.id, {
      phase: "done",
      previewConfig: null,
      slottedCommands: [],
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    });
    expect(await executeRun(f.factory.deps, legacy.id, new AbortController().signal)).toBe("succeeded");
  } finally {
    await daemon?.server.stop(true);
    start.mockRestore();
    killSpy.mockRestore();
    if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    await exit;
    await f.close();
  }
});

test("unresolved startup recovery is reported against its run without stopping the daemon", async () => {
  const { fixture } = await import("./mcp-support.ts");
  const { startDaemon } = await import("../src/cli/daemon.ts");
  const f = await fixture();
  f.factory.cfg.port = 0;
  f.factory.cfg.listenLan = null;
  const start = spyOn(f.factory, "start").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const run = await f.factory.createRun({ repo: f.repo, prompt: "stuck cleanup" });
    f.factory.store.updateRun(run.id, { status: "failed" });
    // Synthetic PID: inspection fails, so nothing is signalled.
    f.factory.store.recordProcessCleanup({ ...record(424245), runId: run.id });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      await processBirthInspection.run(
        {
          read: async () => {
            entered.resolve();
            await release.promise;
            throw new Error("birth inspection denied");
          },
        },
        async () => {
          daemon = await startDaemon(f.factory, {}, async () => ({
            routes: {},
            notes: [],
            stop: async () => {},
          }));
          await entered.promise;
          expect((await fetch(`http://127.0.0.1:${daemon.server.port}/api/health`)).status).toBe(200);
          expect(f.factory.store.listEvents(run.id).filter((e) => e.level === "error")).toEqual([]);
          release.resolve();
          await waitFor(() => f.factory.store.listEvents(run.id).some((e) => e.level === "error"));
          await processScope.run(
            { ...scope(run.id), cleanup: { store: f.factory.store, runId: run.id } },
            async () => {
              await expect(runProcess(command())).rejects.toThrow("birth inspection denied");
              expect(existsSync(join(dir, "sentinel"))).toBe(false);
            },
          );
        },
      );
    } finally {
      release.resolve();
    }
    expect(start).toHaveBeenCalled();
    expect(f.factory.store.pendingProcessCleanups()).toHaveLength(1);
    const events = f.factory.store.listEvents(run.id).filter((e) => e.level === "error");
    expect(events.map((e) => e.message).join("\n")).toContain(`run ${run.id}, invocation invocation`);
    expect(events.map((e) => e.message).join("\n")).toContain("birth inspection denied");
  } finally {
    await daemon?.server.stop(true);
    start.mockRestore();
    error.mockRestore();
    await f.close();
  }
});

test("executeRun recovers only its own run and checkout records", async () => {
  const { fixture } = await import("./mcp-support.ts");
  const { executeRun } = await import("../src/pipeline/engine.ts");
  const f = await fixture();
  const worktree = join(dir, "worktree");
  mkdirSync(join(worktree, "nested"), { recursive: true });
  mkdirSync(`${worktree}-sibling`);
  try {
    for (const location of ["own", "inside", "equal", "shared", "sibling"]) {
      const run = await f.factory.createRun({ repo: f.repo, prompt: "resume recovery selection" });
      f.factory.store.setRunState(run.id, {
        phase: "done",
        previewConfig: null,
        slottedCommands: [],
        answers: [],
        round: 0,
        roundsOnImplementer: 0,
        triedImplementers: [],
        feedback: null,
        toolCommands: [],
        ...(location === "own" ? {} : { worktreePath: worktree }),
      });
      const member = {
        ...record(424248),
        runId: location === "own" ? run.id : "other",
        cwd:
          location === "inside"
            ? join(worktree, "nested")
            : location === "equal"
              ? worktree
              : location === "sibling"
                ? `${worktree}-sibling`
                : dir,
      };
      f.factory.store.recordProcessCleanup(member);
      const blocked = ["own", "inside", "equal"].includes(location);
      let reads = 0;
      await processBirthInspection.run(
        {
          read: async () => {
            reads++;
            throw new Error("birth inspection denied");
          },
        },
        async () => {
          expect(await executeRun(f.factory.deps, run.id, new AbortController().signal)).toBe(
            blocked ? "failed" : "succeeded",
          );
        },
      );
      expect(reads).toBe(blocked ? 1 : 0);
      expect(f.factory.store.pendingProcessCleanups()).toEqual([member]);
      f.factory.store.completeProcessCleanup(member.invocation);
    }
  } finally {
    await f.close();
  }
});

test("run resume is blocked by pending identity inspection and continues once recovery succeeds", async () => {
  const { fixture } = await import("./mcp-support.ts");
  const { executeRun } = await import("../src/pipeline/engine.ts");
  const f = await fixture();
  try {
    const run = await f.factory.createRun({ repo: f.repo, prompt: "resume" });
    f.factory.store.setRunState(run.id, {
      phase: "done",
      previewConfig: null,
      slottedCommands: [],
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    });
    f.factory.store.recordProcessCleanup({ ...record(424244), runId: run.id });
    await processBirthInspection.run(
      {
        read: async () => {
          throw new Error("birth inspection denied");
        },
      },
      async () => {
        expect(await executeRun(f.factory.deps, run.id, new AbortController().signal)).toBe("failed");
        expect(f.factory.store.getRun(run.id)?.error).toContain("birth inspection denied");
        expect(f.factory.store.pendingProcessCleanups()).toHaveLength(1);
      },
    );
    await processBirthInspection.run({ read: async () => null }, async () => {
      expect(await executeRun(f.factory.deps, run.id, new AbortController().signal)).toBe("succeeded");
    });
    expect(f.factory.store.pendingProcessCleanups()).toEqual([]);
  } finally {
    await f.close();
  }
});
