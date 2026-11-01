import { afterEach, beforeEach, test as bunTest, expect, mock, spyOn } from "bun:test";
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
import { withRepoLock } from "../src/git/repos.ts";
import {
  bootIdentity,
  type ProcessCleanup,
  type ProcessDiscovery,
  ProcessTerminationError,
  processBirth,
  processBirthInspection,
  processBirthSync,
  processBootInspection,
  processCleanupStore,
  processInspection,
  processOwnerInspection,
  processRecoveryInspection,
  processScope,
  recoverProcessCleanups,
  recoverScopedProcesses,
  recoveryProcessStopped,
  registerCredential,
  runProcess,
} from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";
import { loadNativeInspection } from "./darwin-inspection-support.ts";
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
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return "Z";
      throw error;
    }
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

async function expectProcessFrozen(pid: number) {
  const deadline = performance.now() + 2_000;
  while ((await processState(pid)) !== "T" && performance.now() < deadline) await Bun.sleep(10);
  expect(await processState(pid)).toBe("T");
}

async function sleeper(cwd = directory): Promise<ProcessCleanup> {
  const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
    cwd,
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
    directory: cwd,
    pid,
    birth,
    boot: bootIdentity(),
    createdAt: Date.now(),
    discovery: { group: pid, started: Date.now(), directories: [cwd], leader: null, spawnedAt: "0" },
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

function snapshot(pids: readonly number[], withEnvironment: boolean, marker: string): string {
  const uid = process.getuid?.();
  return [
    `${process.pid} ${uid} S scanner LIMITLESS_PROCESS_SCAN=${marker}`,
    ...pids.map((pid) => `${pid} ${uid} S member${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`),
  ].join("\n");
}

async function expectRecoveryRefusal(reason: string) {
  const current = scope();
  const sentinel = join(directory, "must-not-start");
  await processScope.run(current, async () => {
    await expect(
      runProcess({
        cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
        cwd: directory,
        env: {},
      }),
    ).rejects.toThrow(reason);
    expect(current.terminationError).toBeInstanceOf(ProcessTerminationError);
    expect(store.listProcessCleanups().length).toBeGreaterThan(0);
    expect(existsSync(sentinel)).toBe(false);
    await expect(
      Promise.resolve().then(() => runProcess({ cmd: ["unused"], cwd: directory, env: {} })),
    ).rejects.toBe(current.terminationError);
  });
  return current.terminationError;
}

test("persisted scope ownership precedes spawn and survives explicit command environments", async () => {
  const marker = crypto.randomUUID();
  let persisted: string | undefined;
  const current = {
    ...scope(),
    ownershipMarker: marker,
    beforeSpawn: (invocation?: string) => {
      persisted = invocation;
    },
  };
  const result = await processScope.run(current, () =>
    runProcess({
      cmd: [
        process.execPath,
        "-e",
        `console.log(process.env[${JSON.stringify(`LIMITLESS_INVOCATION_${marker.replaceAll("-", "_")}`)}]); console.log(process.env.LIMITLESS_INVOCATION)`,
      ],
      cwd: directory,
      env: {},
      onStdoutLine: () => expect(persisted).toEqual(expect.any(String)),
    }),
  );
  const lines = result.stdout.trim().split("\n");
  expect(lines[0]).toBe("1");
  expect(lines[1]).toBe(persisted);
  const sentinel = join(directory, "must-not-spawn");
  await expect(
    processScope.run(
      {
        ...current,
        beforeSpawn: () => {
          throw new Error("persistence failed");
        },
      },
      () =>
        runProcess({
          cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
          cwd: directory,
          env: {},
        }),
    ),
  ).rejects.toThrow("persistence failed");
  expect(existsSync(sentinel)).toBe(false);
});

for (const recovery of ["startup", "scoped"] as const) {
  for (const outcome of ["crash", "live"] as const) {
    test(`coordinator ${recovery} ${outcome} recovery respects discovery ownership`, async () => {
      const database = join(directory, "coordinator.db");
      const ready = join(directory, "children.json");
      const persisted = join(directory, "persisted");
      const finish = join(directory, "finish");
      const childReady = join(directory, "child-ready");
      const script = join(directory, "supervisor.ts");
      const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).pathname);
      // The shell stays alive alongside its child, with no dependency on its stdout reader.
      const shell = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[2], ""); setInterval(() => { if (require("fs").existsSync(process.argv[1])) process.exit(0); }, 10)' ${JSON.stringify(finish)} ${JSON.stringify(childReady)} & child=$!; printf '{"shell":%s,"grandchild":%s}' "$$" "$child" > "$1.tmp"; /bin/mv "$1.tmp" "$1"; wait "$child"`;
      writeFileSync(
        script,
        `
      import { writeFileSync, renameSync } from 'node:fs';
      import { Store } from ${source("../src/db/store.ts")};
      import { processScope, processBootInspection, runProcess } from ${source("../src/util/proc.ts")};
      const store = new Store(${JSON.stringify(database)});
      const controller = new AbortController();
      process.on('SIGTERM', () => controller.abort());
      const record = store.recordProcessDiscovery.bind(store);
      store.recordProcessDiscovery = (row) => {
        record(row);
        writeFileSync(${JSON.stringify(`${persisted}.tmp`)}, 'ready');
        renameSync(${JSON.stringify(`${persisted}.tmp`)}, ${JSON.stringify(persisted)});
      };
      try {
        const result = await processBootInspection.run(() => 'test-boot', () => processScope.run({
          signal: controller.signal, killGraceMs: 0, children: new Map(), scratchDirs: new Set(),
          runId: 'a', checkout: () => ${JSON.stringify(directory)}, cleanups: store,
        }, () => runProcess({
          cmd: ['/bin/sh', '-c', ${JSON.stringify(shell)}, 'probe', ${JSON.stringify(ready)}],
          cwd: ${JSON.stringify(directory)}, env: {}, timeoutMs: 20000,
        })));
        if (result.exitCode !== 0) throw new Error('Invocation failed');
      } finally { store.close(); }
    `,
      );
      const supervisor = Bun.spawn([process.execPath, script], {
        cwd: directory,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      });
      let pids: number[] = [];
      try {
        await waitFor(() => existsSync(ready) && existsSync(persisted) && existsSync(childReady));
        const members = JSON.parse(readFileSync(ready, "utf8")) as { shell: number; grandchild: number };
        pids = [members.shell, members.grandchild];
        store.close();
        store = new Store(database);
        expect(store.listProcessCleanups()).toEqual([]);
        const discoveries = store.listProcessDiscoveries();
        expect(discoveries).toHaveLength(1);
        const discovery = discoveries[0];
        if (!discovery) throw new Error("Missing discovery");
        expect(discovery.ownerId).toEqual(expect.any(String));
        expect(discovery.ownerPid).toBe(supervisor.pid);
        expect(discovery.ownerBirth).toBe(processBirthSync(supervisor.pid));
        if (outcome === "crash") {
          supervisor.kill("SIGKILL");
          await supervisor.exited;
        } else {
          const birth = await processBirth(members.grandchild);
          if (!birth) throw new Error("Missing descendant identity");
          store.recordProcessCleanup({ ...discovery, pid: members.grandchild, birth });
        }
        for (const pid of pids) expect(recoveryProcessStopped(pid)).toBe(false);
        const cleanups = store.listProcessCleanups();
        const assertRecovered = () => {
          if (outcome === "crash") for (const pid of pids) expectProcessStopped(pid);
          else {
            for (const pid of [supervisor.pid, ...pids]) expect(recoveryProcessStopped(pid)).toBe(false);
            expect(store.listProcessDiscoveries()).toEqual(discoveries);
            expect(store.listProcessCleanups()).toEqual(cleanups);
          }
        };
        if (recovery === "startup") await recoverProcessCleanups(store);
        else {
          const sentinel = join(directory, "stage-started");
          await processScope.run(scope(), async () => {
            await recoverScopedProcesses();
            assertRecovered();
            await runProcess({
              cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
              cwd: directory,
              env: {},
            });
          });
          expect(existsSync(sentinel)).toBe(true);
        }
        assertRecovered();
        if (outcome === "live") {
          writeFileSync(finish, "");
          await waitFor(() => supervisor.exitCode !== null);
          expect(await supervisor.exited).toBe(0);
        }
        for (const pid of pids) expectProcessStopped(pid);
        expect(store.listProcessCleanups()).toEqual([]);
        expect(store.listProcessDiscoveries()).toEqual([]);
      } finally {
        if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
        await supervisor.exited;
        if (existsSync(ready)) {
          const members = JSON.parse(readFileSync(ready, "utf8")) as { shell: number; grandchild: number };
          pids = [members.shell, members.grandchild];
        }
        for (const pid of pids) if (!recoveryProcessStopped(pid)) process.kill(pid, "SIGKILL");
        await waitFor(() => pids.every(recoveryProcessStopped));
      }
    }, 30_000);
  }
}

function discoveryFor(row: ProcessCleanup, owner: ProcessCleanup): ProcessDiscovery {
  if (!row.discovery) throw new Error("Missing discovery context");
  return {
    runId: row.runId,
    invocation: row.invocation,
    directory: row.directory,
    boot: row.boot,
    createdAt: row.createdAt,
    discovery: row.discovery,
    ownerId: crypto.randomUUID(),
    ownerPid: owner.pid,
    ownerBirth: processBirthSync(owner.pid),
  };
}

for (const kind of ["legacy", "reused PID"] as const) {
  test(`discovery recovery supports ${kind} owners after reopening`, async () => {
    store.close();
    const database = join(directory, "owners.db");
    store = new Store(database);
    const owner = await sleeper();
    const row = await sleeper();
    const evidence = discoveryFor(row, owner);
    if (kind === "legacy") {
      // The previous release's explicit column list must still work after migration.
      store.db
        .query(`INSERT INTO process_discoveries
        (invocation, run_id, directory, boot, created_at, discovery) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          row.invocation,
          row.runId,
          row.directory,
          row.boot,
          row.createdAt,
          JSON.stringify(row.discovery),
        );
    } else {
      evidence.ownerBirth = `different-${evidence.ownerBirth}`;
      store.recordProcessDiscovery(evidence);
    }
    store.recordProcessCleanup(row);
    store.close();
    store = new Store(database);
    const saved = store.listProcessDiscoveries()[0];
    expect(saved).toEqual(
      kind === "legacy" ? { ...evidence, ownerId: null, ownerPid: null, ownerBirth: null } : evidence,
    );
    await recoverProcessCleanups(store);
    expectProcessStopped(row.pid);
    expect(recoveryProcessStopped(owner.pid)).toBe(false);
    expect(processBirthSync(owner.pid)).toBe(evidence.ownerBirth?.replace(/^different-/, "") ?? null);
    expect(store.listProcessCleanups()).toEqual([]);
    expect(store.listProcessDiscoveries()).toEqual([]);
  });
}

for (const failure of ["throws", "empty", "ownerId", "ownerPid", "ownerBirth"] as const) {
  test(`owner inspection ${failure} preserves work and warns once per failure episode`, async () => {
    store.close();
    store = new Store(join(directory, "inspection.db"));
    const owner = await sleeper();
    const row = await sleeper();
    const healthy = await sleeper();
    const evidence = discoveryFor(row, owner);
    const secret = crypto.randomUUID();
    registerCredential("TEST_CLEANUP_OWNER_SECRET", secret);
    evidence.ownerId = secret;
    const partial = failure !== "throws" && failure !== "empty";
    const retained = { ...evidence, ...(partial ? { [failure]: null } : {}) };
    store.recordProcessDiscovery(retained);
    store.recordProcessCleanup(row);
    const unrelated = await sleeper();
    const orphan = discoveryFor(healthy, unrelated);
    orphan.ownerBirth = `different-${orphan.ownerBirth}`;
    store.recordProcessDiscovery(orphan);
    store.recordProcessCleanup(healthy);
    const inspect = (pid: number) => {
      if (failure === "throws") throw new Error(`inspection unavailable ${secret}`);
      if (failure === "empty") return "";
      return processBirthSync(pid);
    };
    // The independent orphan is inspectable even while this owner's inspection fails.
    const failing = (pid: number) => (pid === owner.pid ? inspect(pid) : processBirthSync(pid));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const recoverBoth = async () => {
      await recoverProcessCleanups(store);
      await processScope.run(scope(), recoverScopedProcesses);
    };
    try {
      await processOwnerInspection.run(failing, recoverBoth);
      expectProcessStopped(healthy.pid);
      expect(recoveryProcessStopped(row.pid)).toBe(false);
      expect(recoveryProcessStopped(owner.pid)).toBe(false);
      expect(store.listProcessDiscoveries()).toEqual([retained]);
      expect(store.listProcessCleanups()).toEqual([row]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      if (failure === "throws")
        expect(JSON.stringify(warn.mock.calls)).toContain("inspection unavailable [redacted]");
      // A confirmed live identity ends the failure episode, including repaired partial metadata.
      store.db
        .query(
          "UPDATE process_discoveries SET owner_id = ?, owner_pid = ?, owner_birth = ? WHERE invocation = ?",
        )
        .run(
          evidence.ownerId ?? null,
          evidence.ownerPid ?? null,
          evidence.ownerBirth ?? null,
          row.invocation,
        );
      await recoverBoth();
      expect(recoveryProcessStopped(row.pid)).toBe(false);
      if (partial)
        store.db
          .query(
            `UPDATE process_discoveries SET ${
              failure === "ownerId" ? "owner_id" : failure === "ownerPid" ? "owner_pid" : "owner_birth"
            } = NULL WHERE invocation = ?`,
          )
          .run(row.invocation);
      await processOwnerInspection.run(failing, recoverBoth);
      expect(warn).toHaveBeenCalledTimes(2);
      store.db
        .query(
          "UPDATE process_discoveries SET owner_id = ?, owner_pid = ?, owner_birth = ? WHERE invocation = ?",
        )
        .run(
          evidence.ownerId ?? null,
          evidence.ownerPid ?? null,
          evidence.ownerBirth ?? null,
          row.invocation,
        );
      process.kill(owner.pid, "SIGKILL");
      await waitFor(() => processBirthSync(owner.pid) === null);
      await recoverBoth();
      expectProcessStopped(row.pid);
      expect(store.listProcessDiscoveries()).toEqual([]);
      expect(store.listProcessCleanups()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
}

for (const failure of ["throws", "missing"] as const) {
  test(`spawn owner identity ${failure} uses persistence failure cleanup`, async () => {
    const current = scope();
    let pid: number | undefined;
    await processOwnerInspection.run(
      () => {
        if (failure === "throws") throw new Error("owner inspection unavailable");
        return null;
      },
      () =>
        processScope.run(current, async () => {
          const command = runProcess({
            cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            cwd: directory,
            env: {},
            timeoutMs: 100,
          });
          pid = [...current.children.keys()][0]?.pid;
          await expect(command).rejects.toThrow(
            failure === "throws" ? "owner inspection unavailable" : "Process owner identity is unavailable",
          );
        }),
    );
    if (process.platform === "linux") expect(pid).toBeUndefined();
    else {
      if (pid === undefined) throw new Error("Missing spawned process");
      expectProcessStopped(pid);
    }
    expect(store.listProcessDiscoveries()).toEqual([]);
    expect(store.listProcessCleanups()).toEqual([]);
  });
}

test("unknown boot requires current ownership before signalling recorded identities", async () => {
  const row = await sleeper();
  store.recordProcessCleanup(row);
  const owner: ProcessDiscovery = {
    ...row,
    boot: "",
    discovery: {
      group: 0,
      started: 0,
      directories: [directory],
      leader: null,
      spawnedAt: "0",
    },
  };
  const kill = spyOn(process, "kill");
  try {
    await processBootInspection.run(
      () => {
        throw new Error("boot unavailable");
      },
      async () => {
        await processRecoveryInspection.run(
          {
            stopped: recoveryProcessStopped,
            timeoutMs: 1000,
            discover: async () => [],
          },
          () =>
            expect(recoverProcessCleanups(store, undefined, undefined, undefined, owner)).rejects.toThrow(
              "Process boot identity could not be confirmed",
            ),
        );
        expect(kill).not.toHaveBeenCalled();
        expect(store.listProcessCleanups()).toEqual([row]);
        await processRecoveryInspection.run(
          {
            stopped: recoveryProcessStopped,
            timeoutMs: 1000,
            discover: async () => (recoveryProcessStopped(row.pid) ? [] : [row.pid]),
          },
          () => recoverProcessCleanups(store, undefined, undefined, undefined, owner),
        );
      },
    );
    expectProcessStopped(row.pid);
    expect(store.listProcessCleanups()).toEqual([]);
  } finally {
    kill.mockRestore();
  }
});

for (const source of ["cleanup", "discovery", "both-denied"] as const) {
  test(`reopened Darwin ${source} roots preserve recovery coverage and evidence`, async () => {
    const native = await loadNativeInspection(directory);
    const scratch = join(directory, "scratch");
    mkdirSync(scratch);
    native.setLeaderBirth(null);
    native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: directory } });
    const discovery = {
      group: native.leaderPid,
      started: 2000,
      directories: [scratch, directory],
      leader: { pid: native.leaderPid, birth: "1:0", session: native.leaderPid, group: native.leaderPid },
      spawnedAt: "0",
    };
    const row: ProcessCleanup = {
      runId: "a",
      invocation: "vanished-leader",
      directory,
      pid: native.leaderPid,
      birth: "1:0",
      boot: "test-boot",
      createdAt: 0,
      discovery,
    };
    store.close();
    const database = join(directory, "roots.db");
    store = new Store(database);
    if (source !== "discovery") store.recordProcessCleanup(row);
    if (source !== "cleanup") store.recordProcessDiscovery({ ...row, discovery });
    store.close();
    rmSync(scratch, { recursive: true });
    store = new Store(database);
    if (source === "both-denied") native.setRealpathFailure({ path: directory, code: "EIO" });
    let alive = true;
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(native.unreadablePid);
      expect(signal).toBe("SIGKILL");
      // Evidence must exist before signalling and until quiescence is confirmed.
      expect(store.listProcessCleanups().some((entry) => entry.pid === pid)).toBe(true);
      alive = false;
      native.setUnreadableProcess(null);
      return true;
    });
    try {
      await processRecoveryInspection.run(
        {
          stopped: (pid) => pid !== native.unreadablePid || !alive,
          birth: async (pid) => (pid === native.unreadablePid && alive ? "2:0" : null),
          timeoutMs: 1000,
          discover: async (marker, group, started, roots, leader, protectedPids, spawnedAt) => {
            expect(leader).toBeNull();
            return native.markedDarwinProcesses(
              process.getuid?.() ?? 0,
              marker,
              group,
              started,
              roots,
              leader,
              protectedPids,
              spawnedAt,
            );
          },
        },
        async () => {
          if (source === "both-denied") {
            const cleanups = store.listProcessCleanups();
            const discoveries = store.listProcessDiscoveries();
            await expect(recoverProcessCleanups(store)).rejects.toThrow(
              "Process cwd root validation failed (EIO)",
            );
            store.close();
            store = new Store(database);
            await expectRecoveryRefusal("Process cwd root validation failed (EIO)");
            expect(store.listProcessCleanups()).toEqual(cleanups);
            expect(store.listProcessDiscoveries()).toEqual(discoveries);
            expect(kill).not.toHaveBeenCalled();
          } else {
            await recoverProcessCleanups(store);
            expect(kill.mock.calls).toEqual([[native.unreadablePid, "SIGKILL"]]);
            expect(store.listProcessCleanups()).toEqual([]);
            expect(store.listProcessDiscoveries()).toEqual([]);
          }
        },
      );
    } finally {
      kill.mockRestore();
    }
  });
}

test("discovery context survives reopening and legacy-column inserts remain compatible", async () => {
  const row = await sleeper();
  const scratch = join(directory, "scratch");
  mkdirSync(scratch);
  row.discovery = {
    group: row.pid,
    started: 1234,
    directories: [realpathSync(directory), realpathSync(scratch)],
    leader: { pid: row.pid, birth: row.birth, session: row.pid, group: row.pid },
    spawnedAt: "12345678901234567890",
  };
  store.close();
  const database = join(directory, "store.db");
  store = new Store(database);
  store.recordProcessCleanup(row);
  const { pid: _pid, birth: _birth, ...discovery } = row;
  if (!discovery.discovery) throw new Error("Missing discovery");
  const evidence: ProcessDiscovery = {
    ...discovery,
    discovery: discovery.discovery,
    ownerId: crypto.randomUUID(),
    ownerPid: row.pid,
    ownerBirth: processBirthSync(row.pid),
  };
  store.recordProcessDiscovery(evidence);
  store.db
    .query(`INSERT INTO process_cleanups
    (run_id, invocation, directory, pid, birth, boot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.runId, "legacy", directory, row.pid, row.birth, row.boot, row.createdAt);
  store.close();
  rmSync(scratch, { recursive: true });
  store = new Store(database);
  expect(store.listProcessDiscoveries()).toEqual([evidence]);
  expect(store.listProcessCleanups().find((record) => record.invocation === row.invocation)).toEqual(row);
  expect(store.listProcessCleanups().find((record) => record.invocation === "legacy")?.discovery).toBeNull();
  store.deleteInvocationCleanups(row.invocation);
  expect(store.listProcessDiscoveries()).toEqual([]);
  const kill = spyOn(process, "kill");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const discover = mock(async () => {
    throw new Error("Legacy recovery must not rediscover");
  });
  try {
    await processRecoveryInspection.run(
      { stopped: recoveryProcessStopped, timeoutMs: 10_000, discover },
      () =>
        processScope.run(scope(), async () => {
          const result = await runProcess({
            cmd: [process.execPath, "-e", "console.log('next')"],
            cwd: directory,
            env: {},
            onStdoutLine: () => {
              expectProcessStopped(row.pid);
              expect(store.listProcessCleanups()).toEqual([]);
            },
          });
          expect(result.stdout.trim()).toBe("next");
          expect(result.exitCode).toBe(0);
        }),
    );
    expect(kill.mock.calls).toContainEqual([row.pid, "SIGKILL"]);
    expect(discover).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Cleanup recovery for legacy: legacy record; skipping process rediscovery",
    );
  } finally {
    kill.mockRestore();
    warn.mockRestore();
  }
});

for (const failure of ["identity", "discovery"] as const) {
  test(`batch recovery isolates ${failure} failures and aggregates refusals`, async () => {
    const failed = [await sleeper(), await sleeper()].map((row) =>
      failure === "identity" ? { ...row, discovery: null } : row,
    );
    const healthy = await sleeper();
    const unrecorded = await sleeper();
    const [first, last] = failed;
    if (!first || !last) throw new Error("Missing failed invocations");
    for (const row of [first, healthy, last]) store.recordProcessCleanup(row);
    const secret = crypto.randomUUID();
    registerCredential("TEST_CLEANUP_BATCH_SECRET", secret);
    const reason = (invocation: string, credential = "[redacted]") =>
      `${failure} unavailable for ${invocation} ${credential}`;
    await processRecoveryInspection.run(
      {
        stopped: recoveryProcessStopped,
        timeoutMs: 10_000,
        birth: async (pid) => {
          const row = failed.find((row) => row.pid === pid);
          if (failure === "identity" && row) throw new Error(reason(row.invocation, secret));
          return processBirth(pid);
        },
      },
      () =>
        processInspection.run(
          async (environment, marker) => {
            if (failed.some((row) => row.invocation === marker)) throw new Error(reason(marker, secret));
            return snapshot(
              recoveryProcessStopped(unrecorded.pid) ? [] : [unrecorded.pid],
              environment,
              marker,
            );
          },
          async () => {
            const error = await expectRecoveryRefusal(reason(first.invocation));
            expect(error?.message).toContain(reason(last.invocation));
            expect(error?.message).not.toContain(secret);
          },
        ),
    );
    expectProcessStopped(healthy.pid);
    expectProcessStopped(unrecorded.pid);
    expect(store.listProcessCleanups()).toEqual(failed);
  });
}

for (const state of ["gone", "reused", "unconfirmed", "lost", "confirmed"] as const) {
  test(`recovery checks saved Darwin leader continuity on every scan (${state})`, async () => {
    const original = await sleeper();
    const unrelated = await sleeper();
    const leaderProcess = await sleeper();
    const leader = {
      pid: leaderProcess.pid,
      birth: leaderProcess.birth,
      group: leaderProcess.pid,
      session: leaderProcess.pid,
    };
    if (!original.discovery) throw new Error("Missing discovery fixture");
    original.discovery = { ...original.discovery, group: leader.pid, leader };
    if (state === "gone") {
      children[0]?.kill("SIGKILL");
      children[2]?.kill("SIGKILL");
      await waitFor(() => recoveryProcessStopped(original.pid) && recoveryProcessStopped(leader.pid));
    }
    store.recordProcessCleanup(original);
    let scans = 0;
    const observedLeaders: (typeof leader | null)[] = [];
    const kill = spyOn(process, "kill");
    try {
      await processRecoveryInspection.run(
        {
          stopped: (pid) =>
            pid === leader.pid
              ? state === "gone" || (state === "lost" && scans > 0)
              : recoveryProcessStopped(pid),
          timeoutMs: 10_000,
          birth: async (pid) =>
            pid === leader.pid && state === "reused"
              ? "different-birth"
              : pid === leader.pid && state === "unconfirmed"
                ? null
                : processBirth(pid),
          discover: async (_marker, group, _started, _directories, savedLeader) => {
            scans++;
            expect(group).toBe(leader.pid);
            observedLeaders.push(savedLeader);
            const continuous = state === "confirmed" || (state === "lost" && scans === 1);
            // Simulate an unrelated survivor in a reused numeric group after continuity ends.
            return savedLeader && !continuous ? [unrelated.pid] : [];
          },
        },
        () => recoverProcessCleanups(store),
      );
      expect(scans).toBeGreaterThanOrEqual(2);
      expect(kill.mock.calls).toEqual(state === "gone" ? [] : [[original.pid, "SIGKILL"]]);
      expect(observedLeaders[0]).toEqual(state === "confirmed" || state === "lost" ? leader : null);
      for (const observed of observedLeaders.slice(1))
        expect(observed).toEqual(state === "confirmed" ? leader : null);
      expect(recoveryProcessStopped(unrelated.pid)).toBe(false);
      expect(store.listProcessCleanups()).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });
}

for (const state of ["gone", "reused"] as const) {
  test(`legacy recovery retires ${state} members without signalling and redacts its diagnostic`, async () => {
    const row = await sleeper();
    const secret = crypto.randomUUID();
    registerCredential("TEST_LEGACY_CLEANUP_SECRET", secret);
    const legacy = { ...row, invocation: secret, discovery: null };
    if (state === "gone") {
      children[0]?.kill("SIGKILL");
      await waitFor(() => recoveryProcessStopped(row.pid));
    } else legacy.birth = "different-birth";
    store.recordProcessCleanup(legacy);
    const kill = spyOn(process, "kill");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recoverProcessCleanups(store);
      expect(kill).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Cleanup recovery for [redacted]: legacy record; skipping process rediscovery",
      );
      expect(store.listProcessCleanups()).toEqual([]);
      if (state === "reused") expect(recoveryProcessStopped(row.pid)).toBe(false);
    } finally {
      kill.mockRestore();
      warn.mockRestore();
    }
  });
}

for (const stopped of [false, true]) {
  test(`rediscovery records later members before signalling (original stopped=${stopped})`, async () => {
    const original = await sleeper();
    const first = await sleeper();
    const later = await sleeper();
    store.recordProcessCleanup(original);
    if (stopped) {
      children[0]?.kill("SIGKILL");
      await waitFor(() => recoveryProcessStopped(original.pid));
    }
    let scans = 0;
    const signal = process.kill.bind(process);
    const kill = spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (sig === "SIGKILL") {
        const expected = [original, first, later].find((row) => row.pid === pid);
        expect(expected).toBeDefined();
        expect(store.listProcessCleanups()).toContainEqual(
          expect.objectContaining({
            invocation: original.invocation,
            pid,
            birth: expected?.birth,
            discovery: original.discovery,
          }),
        );
      }
      return signal(pid, sig);
    });
    try {
      await processInspection.run(
        async (environment, marker) => {
          if (environment) scans++;
          const round = scans - Number(stopped);
          if (environment && round === 2) await waitFor(() => recoveryProcessStopped(first.pid));
          const members = round === 1 ? [first.pid] : round === 2 ? [later.pid] : [];
          return snapshot(members, environment, marker);
        },
        () =>
          processScope.run(scope(), async () => {
            const result = await runProcess({
              cmd: [process.execPath, "-e", "console.log('next')"],
              cwd: directory,
              env: {},
              onStdoutLine: () => {
                for (const row of [original, first, later]) expectProcessStopped(row.pid);
                expect(store.listProcessCleanups()).toEqual([]);
              },
            });
            expect(result.exitCode).toBe(0);
          }),
      );
      for (const row of [first, later]) expect(kill.mock.calls).toContainEqual([row.pid, "SIGKILL"]);
      expect(scans).toBeGreaterThanOrEqual(3);
    } finally {
      kill.mockRestore();
    }
  });
}

for (const afterKill of [false, true]) {
  test(`unavailable discovery retains context and blocks commands (after kill=${afterKill})`, async () => {
    const row = await sleeper();
    store.recordProcessCleanup(row);
    let scans = 0;
    const secret = crypto.randomUUID();
    registerCredential("TEST_CLEANUP_DISCOVERY_SECRET", secret);
    await processInspection.run(
      async (environment, marker) => {
        if (environment && ++scans > (afterKill ? 1 : 0)) {
          if (afterKill) {
            await waitFor(() => recoveryProcessStopped(row.pid));
            expectProcessStopped(row.pid);
          }
          throw new Error(`injected recovery discovery unavailable ${secret}`);
        }
        return snapshot([], environment, marker);
      },
      () => expectRecoveryRefusal("injected recovery discovery unavailable [redacted]"),
    );
    expect(store.listProcessCleanups()).toEqual([row]);
  });
}

test("continued rediscovery shares one recovery deadline and retains newly recorded members", async () => {
  const original = await sleeper();
  const later = await sleeper();
  const latest = await sleeper();
  store.recordProcessCleanup(original);
  let scans = 0;
  const now = performance.now();
  let elapsed = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now + elapsed);
  try {
    await processRecoveryInspection.run({ stopped: recoveryProcessStopped, timeoutMs: 100 }, () =>
      processInspection.run(
        async (environment, marker) => {
          if (environment && ++scans === 2) elapsed = 100;
          return snapshot([scans === 1 ? later.pid : latest.pid], environment, marker);
        },
        () => expectRecoveryRefusal("process rediscovery did not quiesce"),
      ),
    );
    expect(scans).toBe(2);
    for (const row of [later, latest])
      expect(store.listProcessCleanups()).toContainEqual(
        expect.objectContaining({
          invocation: original.invocation,
          pid: row.pid,
          birth: row.birth,
        }),
      );
  } finally {
    clock.mockRestore();
  }
});

for (const failure of ["unconfirmed", "reused", "protected", "persistence"] as const) {
  test(`rediscovery never signals a ${failure} member`, async () => {
    const original = await sleeper();
    const found = await sleeper();
    children[0]?.kill("SIGKILL");
    await waitFor(() => recoveryProcessStopped(original.pid));
    store.recordProcessCleanup(original);
    const persist = spyOn(store, "recordProcessCleanup");
    if (failure === "persistence")
      persist.mockImplementation(() => {
        throw new Error("record unavailable");
      });
    const kill = spyOn(process, "kill");
    let births = 0;
    try {
      await processRecoveryInspection.run(
        {
          stopped: recoveryProcessStopped,
          timeoutMs: 10_000,
          birth: async (pid) =>
            pid === found.pid
              ? failure === "unconfirmed"
                ? null
                : failure === "reused" && ++births > 1
                  ? "reused"
                  : found.birth
              : processBirth(pid),
        },
        () =>
          processInspection.run(
            async (environment, marker) =>
              snapshot([failure === "protected" ? process.pid : found.pid], environment, marker),
            async () => {
              if (failure !== "protected")
                await expectRecoveryRefusal(
                  failure === "unconfirmed"
                    ? "identity could not be confirmed"
                    : failure === "reused"
                      ? "identity changed during recovery"
                      : "record unavailable",
                );
              else await recoverProcessCleanups(store);
            },
          ),
      );
      expect(kill).not.toHaveBeenCalled();
      if (failure === "unconfirmed" || failure === "persistence")
        expect(store.listProcessCleanups()).toEqual([original]);
      else if (failure === "reused") expect(store.listProcessCleanups()).toHaveLength(2);
      else expect(store.listProcessCleanups()).toEqual([]);
    } finally {
      persist.mockRestore();
      kill.mockRestore();
    }
  });
}

bunTest.skipIf(process.platform !== "linux")("real Linux boot identity is stable", () => {
  const inspection = spyOn(processBootInspection, "getStore").mockReturnValue(undefined);
  try {
    const boot = bootIdentity();
    expect(boot.length).toBeGreaterThan(0);
    expect(bootIdentity()).toBe(boot);
  } finally {
    inspection.mockRestore();
  }
});

bunTest.skipIf(seatbeltSkip !== null)(
  `real macOS boot identity is stable (${seatbeltSkip ?? "unconfined"})`,
  () => {
    const inspection = spyOn(processBootInspection, "getStore").mockReturnValue(undefined);
    try {
      const boot = bootIdentity();
      expect(boot.length).toBeGreaterThan(0);
      expect(bootIdentity()).toBe(boot);
    } finally {
      inspection.mockRestore();
    }
  },
);

test("pre-command recovery waits for live cleanup paused after freezing a member", async () => {
  const frozen = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const controller = new AbortController();
  const current = scope();
  const signal = process.kill.bind(process);
  let member = 0;
  let paused = false;
  const kill = spyOn(process, "kill").mockImplementation((pid, sig) => {
    const result = signal(pid, sig);
    if (pid === member && sig === "SIGSTOP") paused = true;
    return result;
  });
  const deletion = spyOn(store, "deleteProcessCleanup");
  const invocationDeletion = spyOn(store, "deleteInvocationCleanups");
  const recoveryBirth = mock(async () => processBirth(member));
  const running = processBirthInspection.run(
    {
      read: async (pid, name) => {
        if (pid === member && paused) {
          frozen.resolve();
          await resume.promise;
        }
        return processBirth(pid, name);
      },
    },
    () =>
      processScope.run(current, () =>
        runProcess({
          cmd: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
          cwd: directory,
          env: {},
          signal: controller.signal,
          onStdoutLine: (line) => {
            member = Number(line);
            controller.abort();
          },
        }),
      ),
  );
  let next: ReturnType<typeof runProcess> | undefined;
  let background: Promise<void> | undefined;
  try {
    await frozen.promise;
    await expectProcessFrozen(member);
    const records = store.listProcessCleanups();
    expect(records).toHaveLength(1);
    const birth = records[0]?.birth;
    if (!birth) throw new Error("Missing recorded member");
    recoveryBirth.mockImplementation(async () => birth);
    next = processRecoveryInspection.run(
      { stopped: recoveryProcessStopped, timeoutMs: 10_000, birth: recoveryBirth },
      () =>
        processScope.run(current, () =>
          runProcess({
            cmd: [process.execPath, "-e", "console.log('next')"],
            cwd: directory,
            env: {},
            onStdoutLine: () => {
              expectProcessStopped(member);
              expect(store.listProcessCleanups()).toEqual([]);
            },
          }),
        ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recoveryBirth).not.toHaveBeenCalled();
    expect(kill.mock.calls.filter(([pid, sig]) => pid === member && sig === "SIGKILL")).toEqual([]);
    expect(deletion).not.toHaveBeenCalled();
    expect(invocationDeletion).not.toHaveBeenCalled();
    expect(store.listProcessCleanups()).toEqual(records);
    // An unrelated invocation can still recover while this one holds ownership.
    const other = await sleeper();
    store.recordProcessCleanup(other);
    background = recoverProcessCleanups(store);
    await recoverProcessCleanups(store, [other]);
    expectProcessStopped(other.pid);
    resume.resolve();
    await running;
    expect((await next).exitCode).toBe(0);
    await background;
    expect(store.listProcessCleanups()).toEqual([]);
  } finally {
    resume.resolve();
    controller.abort();
    await Promise.allSettled([running, next, background]);
    kill.mockRestore();
    deletion.mockRestore();
    invocationDeletion.mockRestore();
  }
});

for (const fail of [false, true]) {
  test(`concurrent recoveries re-read ownership after ${fail ? "failure" : "completion"}`, async () => {
    const row = await sleeper();
    store.recordProcessCleanup(row);
    const records = store.listProcessCleanups();
    const inspecting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const kill = spyOn(process, "kill");
    const deletion = spyOn(store, "deleteInvocationCleanups");
    const retryInspection = mock(processBirth);
    const retryDiscovery = mock(async (environment: boolean, marker: string) =>
      snapshot([], environment, marker),
    );
    const first = processRecoveryInspection.run(
      {
        stopped: recoveryProcessStopped,
        timeoutMs: 10_000,
        birth: async (pid) => {
          inspecting.resolve();
          await resume.promise;
          if (fail) throw new Error("injected recovery inspection failure");
          return processBirth(pid);
        },
      },
      () => recoverProcessCleanups(store, records),
    );
    let results: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await inspecting.promise;
      const second = processInspection.run(retryDiscovery, () =>
        processRecoveryInspection.run(
          { stopped: recoveryProcessStopped, timeoutMs: 10_000, birth: retryInspection },
          () => recoverProcessCleanups(store, records),
        ),
      );
      results = Promise.allSettled([first, second]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retryInspection).not.toHaveBeenCalled();
      expect(retryDiscovery).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(store.listProcessCleanups()).toEqual(records);
      resume.resolve();
      const [initial, retry] = await results;
      expect(initial?.status).toBe(fail ? "rejected" : "fulfilled");
      if (initial?.status === "rejected")
        expect(initial.reason).toHaveProperty("message", expect.stringContaining("injected recovery"));
      expect(retry?.status).toBe("fulfilled");
      expect(retryInspection).toHaveBeenCalledTimes(fail ? 1 : 0);
      if (fail) expect(retryDiscovery).toHaveBeenCalled();
      else expect(retryDiscovery).not.toHaveBeenCalled();
      expect(kill.mock.calls).toEqual([[row.pid, "SIGKILL"]]);
      expect(deletion.mock.calls).toEqual([[row.invocation]]);
      expectProcessStopped(row.pid);
      expect(store.listProcessCleanups()).toEqual([]);
    } finally {
      resume.resolve();
      await (results ?? Promise.allSettled([first]));
      deletion.mockRestore();
      kill.mockRestore();
    }
  });
}

for (const mismatch of ["birth", "boot"] as const) {
  test(`recovery retires a different ${mismatch} without signalling a live PID`, async () => {
    const row = await sleeper();
    store.recordProcessCleanup({
      ...row,
      [mismatch]: `different-${row[mismatch]}`,
      discovery: mismatch === "boot" ? null : row.discovery,
    });
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
  const rows = [await sleeper(), { ...(await sleeper()), discovery: null }];
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

for (const failure of ["inspection", "non-quiescence"] as const) {
  test(`discovery-only ${failure} retains evidence and blocks stage work`, async () => {
    const row = await sleeper();
    const evidence: ProcessDiscovery = {
      runId: row.runId,
      invocation: row.invocation,
      directory: row.directory,
      boot: row.boot,
      createdAt: row.createdAt,
      discovery: { group: row.pid, started: 0, directories: [], leader: null, spawnedAt: "0" },
      ownerId: null,
      ownerPid: null,
      ownerBirth: null,
    };
    store.recordProcessDiscovery(evidence);
    const current = scope();
    const sentinel = join(directory, "stage-started");
    await processRecoveryInspection.run(
      {
        stopped: () => false,
        timeoutMs: 0,
        discover: async () => {
          if (failure === "inspection") throw new Error("injected discovery inspection failure");
          return [row.pid];
        },
      },
      () =>
        processScope.run(current, async () => {
          await expect(
            runProcess({
              cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
              cwd: directory,
              env: {},
            }),
          ).rejects.toThrow(ProcessTerminationError.prefix);
          expect(current.terminationError).toBeInstanceOf(ProcessTerminationError);
          expect(current.terminationError?.message).toContain(
            failure === "inspection" ? "injected discovery inspection failure" : "did not quiesce",
          );
          expect(store.listProcessDiscoveries()).toEqual([evidence]);
          expect(existsSync(sentinel)).toBe(false);
        }),
    );
  });
}

test("changed-boot discovery is retired without inspection or signalling", async () => {
  const row = await sleeper();
  store.recordProcessDiscovery({
    runId: row.runId,
    invocation: row.invocation,
    directory,
    boot: "previous-boot",
    createdAt: 0,
    discovery: { group: row.pid, started: 0, directories: [directory], leader: null, spawnedAt: "0" },
  });
  const kill = spyOn(process, "kill");
  const discover = mock(async () => {
    throw new Error("must not inspect a previous boot");
  });
  try {
    await processRecoveryInspection.run({ stopped: recoveryProcessStopped, timeoutMs: 0, discover }, () =>
      recoverProcessCleanups(store),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(recoveryProcessStopped(row.pid)).toBe(false);
    expect(store.listProcessDiscoveries()).toEqual([]);
  } finally {
    kill.mockRestore();
  }
});

test("discovery scope selection respects run IDs, checkout boundaries and missing checkouts", async () => {
  const checkout = join(directory, "work", "a");
  mkdirSync(checkout, { recursive: true });
  const add = (invocation: string, runId: string, path: string) =>
    store.recordProcessDiscovery({
      invocation,
      runId,
      directory: path,
      boot: "test-boot",
      createdAt: 0,
      discovery: { group: 0, started: 0, directories: [], leader: null, spawnedAt: "0" },
    });
  add("shared", "b", join(directory, "repos"));
  add("sibling", "b", `${checkout}-sibling`);
  add("nested", "b", join(checkout, "nested"));
  add("checkout", "b", checkout);
  const current = { ...scope(), checkout: () => checkout };
  await processRecoveryInspection.run(
    { stopped: recoveryProcessStopped, timeoutMs: 1000, discover: async () => [] },
    () => processScope.run(current, recoverScopedProcesses),
  );
  expect(
    store
      .listProcessDiscoveries()
      .map((row) => row.invocation)
      .sort(),
  ).toEqual(["shared", "sibling"]);
  rmSync(checkout, { recursive: true });
  add("own", "a", join(directory, "gone"));
  await processRecoveryInspection.run(
    { stopped: recoveryProcessStopped, timeoutMs: 1000, discover: async () => [] },
    () => processScope.run(current, recoverScopedProcesses),
  );
  expect(
    store
      .listProcessDiscoveries()
      .map((row) => row.invocation)
      .sort(),
  ).toEqual(["shared", "sibling"]);
});

for (const recovery of ["startup", "scoped"] as const) {
  test(`same-owner abandoned invocation recovers through ${recovery} in a fresh scope`, async () => {
    store.close();
    store = new Store(join(directory, "abandoned.db"));
    const failed = scope();
    const sentinel = join(directory, "stage-started");
    let descendant: number | undefined;
    try {
      await processInspection.run(
        async () => {
          throw new Error("injected shutdown scan failure");
        },
        () =>
          processScope.run(failed, async () => {
            await expect(
              runProcess({
                cmd: [
                  process.execPath,
                  "-e",
                  `const child = require('node:child_process').spawn(process.execPath,
                    ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
                    { stdio: ['ignore', 'pipe', 'ignore'] });
                  child.stdout.once('data', () => {
                    console.log(child.pid); child.stdout.destroy(); child.unref();
                  });`,
                ],
                cwd: directory,
                env: {},
                onStdoutLine: (line) => {
                  descendant = Number(line);
                },
              }),
            ).rejects.toThrow("injected shutdown scan failure");
          }),
      );
      expect(failed.terminationError).toBeInstanceOf(ProcessTerminationError);
      if (descendant === undefined) throw new Error("Missing descendant pid");
      expect(recoveryProcessStopped(descendant)).toBe(false);
      const evidence = store.listProcessDiscoveries();
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.ownerPid).toBe(process.pid);
      expect(evidence[0]?.ownerBirth).toBe(processBirthSync(process.pid));
      expect(store.listProcessCleanups()).toEqual([]);
      const pid = descendant;
      await processScope.run(scope(), async () => {
        if (recovery === "startup") await recoverProcessCleanups(store);
        else await recoverScopedProcesses();
        expectProcessStopped(pid);
        expect(store.listProcessDiscoveries()).toEqual([]);
        expect(store.listProcessCleanups()).toEqual([]);
        expect(existsSync(sentinel)).toBe(false);
        const result = await runProcess({
          cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
          cwd: directory,
          env: {},
        });
        expect(result.exitCode).toBe(0);
      });
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      const pid = descendant;
      if (pid !== undefined && !recoveryProcessStopped(pid)) {
        process.kill(pid, "SIGKILL");
        await waitFor(() => recoveryProcessStopped(pid));
      }
    }
  });
}

test("live parallel discoveries survive scoped and background startup recovery", async () => {
  const controller = new AbortController();
  const current = { ...scope(), signal: controller.signal };
  let ready = 0;
  const recorded = spyOn(store, "recordProcessDiscovery");
  const commands: ReturnType<typeof runProcess>[] = [];
  try {
    await processScope.run(current, async () => {
      for (let i = 0; i < 2; i++)
        commands.push(
          runProcess({
            cmd: [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
            cwd: directory,
            env: {},
            onStdoutLine: () => {
              ready++;
            },
          }),
        );
      expect(current.children.size).toBe(2);
      await waitFor(() => ready === 2);
      const evidence = store.listProcessDiscoveries();
      expect(evidence).toHaveLength(2);
      expect(new Set(evidence.map((row) => row.ownerId)).size).toBe(1);
      for (const row of evidence) {
        expect(row.ownerId).toEqual(expect.any(String));
        expect(row.ownerPid).toBe(process.pid);
        expect(row.ownerBirth).toBe(processBirthSync(process.pid));
      }
      expect(recorded).toHaveBeenCalledTimes(2);
      await Promise.all([recoverProcessCleanups(store), recoverScopedProcesses()]);
      expect(store.listProcessDiscoveries()).toEqual(evidence);
      expect(current.children.size).toBe(2);
      for (const child of current.children.keys()) {
        if (child.pid === undefined) throw new Error("Missing spawned process");
        expect(recoveryProcessStopped(child.pid)).toBe(false);
      }
      expect(
        (await runProcess({ cmd: [process.execPath, "-e", ""], cwd: directory, env: {} })).exitCode,
      ).toBe(0);
      expect(recorded).toHaveBeenCalledTimes(3);
      expect(store.listProcessDiscoveries()).toEqual(evidence);
    });
  } finally {
    controller.abort();
    await Promise.allSettled(commands);
    recorded.mockRestore();
  }
  expect(store.listProcessDiscoveries()).toEqual([]);
  expect(store.listProcessCleanups()).toEqual([]);
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

for (const ambient of [false, true]) {
  test(`repository lock recovers shared cache ownership using ${ambient ? "ambient" : "scoped"} store`, async () => {
    const cache = join(directory, "cache.git");
    const alias = join(directory, "alias");
    const checkout = join(directory, "next-checkout");
    for (const path of [cache, checkout]) mkdirSync(path);
    symlinkSync(directory, alias);
    const row = await sleeper(cache);
    const sibling = { ...(await sleeper()), directory: `${cache}-sibling` };
    store.recordProcessCleanup({ ...row, directory: join(alias, "cache.git") });
    store.recordProcessCleanup(sibling);
    const current = { ...scope(), runId: "next-job", checkout: () => checkout };
    const recover = mock(processBirth);
    const operation = () =>
      withRepoLock(cache, async () => {
        expectProcessStopped(row.pid);
        expect(store.listProcessCleanups()).toEqual([sibling]);
        expect(recoveryProcessStopped(sibling.pid)).toBe(false);
        return "ran";
      });
    const result = await processRecoveryInspection.run(
      { stopped: recoveryProcessStopped, timeoutMs: 10_000, birth: recover },
      () =>
        processInspection.run(
          async (environment, marker) => snapshot([], environment, marker),
          () => (ambient ? processCleanupStore.run(store, operation) : processScope.run(current, operation)),
        ),
    );
    expect(result).toBe("ran");
    expect(recover).toHaveBeenCalledWith(row.pid);
    expect(recover).not.toHaveBeenCalledWith(sibling.pid);
  });
}

test("queued cache callers inspect after release and retry a failed cleanup before entering", async () => {
  const cache = join(directory, "cache.git");
  const alias = join(directory, "alias");
  symlinkSync(directory, alias);
  // Lock aliases must agree even before the cache exists.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inspect = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const retryInspect = Promise.withResolvers<void>();
  const retryResume = Promise.withResolvers<void>();
  const recovered = mock(async (environment: boolean, marker: string) => {
    retryInspect.resolve();
    await retryResume.promise;
    return snapshot([], environment, marker);
  });
  const callback = mock(async () => {});
  const holder = withRepoLock(cache, async () => {
    entered.resolve();
    await release.promise;
  });
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let failed: Promise<void> | undefined;
  let retry: Promise<string> | undefined;
  try {
    await entered.promise;
    failed = processScope.run({ ...scope(), runId: "failed-job" }, () =>
      processInspection.run(
        async () => {
          inspect.resolve();
          await resume.promise;
          throw new Error("injected cache discovery failure");
        },
        () => withRepoLock(join(alias, "cache.git"), callback),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(callback).not.toHaveBeenCalled();
    // This record appears only after the next caller has queued for the lock.
    mkdirSync(cache);
    const row = await sleeper(cache);
    store.recordProcessCleanup(row);
    const records = store.listProcessCleanups();
    retry = processScope.run({ ...scope(), runId: "retry-job" }, () =>
      processInspection.run(recovered, () =>
        withRepoLock(cache, async () => {
          expectProcessStopped(row.pid);
          expect(store.listProcessCleanups()).toEqual([]);
          return "recovered";
        }),
      ),
    );
    pending = Promise.allSettled([failed, retry]);
    release.resolve();
    await inspect.promise;
    expect(callback).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
    expect(store.listProcessCleanups()).toEqual(records);
    expect(recoveryProcessStopped(row.pid)).toBe(false);
    resume.resolve();
    await retryInspect.promise;
    await expect(failed).rejects.toBeInstanceOf(ProcessTerminationError);
    expect(store.listProcessCleanups()).toEqual(records);
    expect(recoveryProcessStopped(row.pid)).toBe(false);
    retryResume.resolve();
    const [failure, success] = await pending;
    expect(failure?.status).toBe("rejected");
    if (failure?.status === "rejected") {
      expect(failure.reason).toBeInstanceOf(ProcessTerminationError);
      expect(failure.reason.message).toContain("injected cache discovery failure");
    }
    expect(success).toEqual({ status: "fulfilled", value: "recovered" });
    expect(callback).not.toHaveBeenCalled();
    expect(recovered).toHaveBeenCalled();
  } finally {
    release.resolve();
    resume.resolve();
    retryResume.resolve();
    await (pending ?? Promise.allSettled([failed, retry]));
    await holder;
  }
});

test("cache cleanup inspection failure refuses the callback and keeps pending records", async () => {
  const row = await sleeper();
  store.recordProcessCleanup(row);
  const callback = mock(async () => {});
  const list = spyOn(store, "listProcessCleanups").mockImplementation(() => {
    throw new Error("cleanup store unavailable");
  });
  try {
    await processCleanupStore.run(store, async () => {
      await expect(withRepoLock(directory, callback)).rejects.toThrow(
        `${ProcessTerminationError.prefix}: repository cache cleanup: cleanup store unavailable`,
      );
    });
    expect(callback).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
  }
  expect(store.listProcessCleanups()).toEqual([row]);
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

test("an interrupted sweep rediscovers a frozen parent's unrecorded child before the next command", async () => {
  store.close();
  const database = join(directory, "store.db");
  store = new Store(database);
  const ready = join(directory, "frozen");
  const scratch = join(directory, "scratch");
  mkdirSync(scratch);
  const memberFile = join(directory, "member");
  const script = join(directory, "supervisor.ts");
  const parentScript = join(directory, "parent.cjs");
  writeFileSync(
    parentScript,
    `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore','pipe','ignore'] });
    child.stdout.once('data', () => {
      require('fs').writeFileSync(${JSON.stringify(memberFile)}, JSON.stringify([process.pid, child.pid]));
      console.log('ready');
    });
    setInterval(() => {}, 1000);
  `,
  );
  const proc = new URL("../src/util/proc.ts", import.meta.url).pathname;
  const db = new URL("../src/db/store.ts", import.meta.url).pathname;
  writeFileSync(
    script,
    `
    import { Store } from ${JSON.stringify(db)};
    import { invocationScratch, processBirth, processBirthInspection, processBootInspection, processInspection, processScope, runProcess } from ${JSON.stringify(proc)};
    import { readFileSync, writeFileSync } from 'node:fs';
    const store = new Store(${JSON.stringify(database)});
    let frozen;
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      const result = kill(pid, signal);
      if (signal === 'SIGSTOP') frozen = pid;
      return result;
    };
    await invocationScratch.run(${JSON.stringify(scratch)}, () => processInspection.run(async (environment, marker) => {
      // The child exists, but the interrupted sweep's last snapshot missed it.
      const [pid] = JSON.parse(readFileSync(${JSON.stringify(memberFile)}, 'utf8'));
      return ${snapshot.toString()}([pid], environment, marker);
    }, () => processBootInspection.run(() => "test-boot", () => processBirthInspection.run({ read: async (pid, name) => {
      if (pid === frozen) {
        writeFileSync(${JSON.stringify(ready)}, String(pid));
        await new Promise(() => {});
      }
      return processBirth(pid, name);
    } }, () => processScope.run({signal: new AbortController().signal, killGraceMs: 0,
      children: new Map(), scratchDirs: new Set(), runId: 'a', cleanups: store }, () => runProcess({
        cmd: [process.execPath, '-e', ${JSON.stringify(`
          const {spawn} = require('node:child_process');
          const child = spawn(process.execPath, [${JSON.stringify(parentScript)}], { detached: true, stdio: ['ignore','pipe','ignore'] });
          child.stdout.once('data', () => process.exit(0));
        `)}], cwd: ${JSON.stringify(directory)}, env: process.env
      }))))));
  `,
  );
  const supervisor = spawn(process.execPath, [script], { cwd: directory, stdio: "ignore" });
  children.push(supervisor);
  let member: number | undefined;
  let omitted: number | undefined;
  const signal = process.kill.bind(process);
  const kill = spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (pid === omitted && sig === "SIGKILL")
      expect(store.listProcessCleanups()).toContainEqual(
        expect.objectContaining({ pid, birth: omittedBirth }),
      );
    return signal(pid, sig);
  });
  let omittedBirth: string | null = null;
  try {
    await waitFor(() => existsSync(ready) && /^[1-9]\d*$/.test(readFileSync(ready, "utf8").trim()));
    [member, omitted] = JSON.parse(readFileSync(memberFile, "utf8"));
    if (member === undefined || omitted === undefined) throw new Error("Missing invocation members");
    omittedBirth = await processBirth(omitted);
    expect(Number(readFileSync(ready, "utf8"))).toBe(member);
    const rows = store.listProcessCleanups();
    expect(rows).toHaveLength(1);
    expect(recoveryProcessStopped(omitted)).toBe(false);
    expect(rows[0]).toMatchObject({
      runId: "a",
      directory,
      pid: member,
      birth: await processBirth(member),
      boot: bootIdentity(),
      discovery: expect.objectContaining({
        directories: process.platform === "darwin" ? [directory, scratch] : [],
        group: expect.any(Number),
        spawnedAt: expect.any(String),
      }),
    });
    await expectProcessFrozen(member);
    supervisor.kill("SIGKILL");
    await new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
    store.close();
    rmSync(scratch, { recursive: true });
    store = new Store(database);
    for (const row of store.listProcessCleanups()) {
      if (!row.discovery) throw new Error("Missing interrupted discovery context");
      store.recordProcessCleanup({ ...row, discovery: { ...row.discovery, leader: null } });
    }
    await processScope.run(scope(), async () => {
      const result = await runProcess({
        cmd: [process.execPath, "-e", "console.log('next')"],
        cwd: directory,
        env: {},
        onStdoutLine: () => {
          expectProcessStopped(member ?? 0);
          expectProcessStopped(omitted ?? 0);
          expect(store.listProcessCleanups()).toEqual([]);
        },
      });
      expect(result.exitCode).toBe(0);
    });
    expect(kill.mock.calls).toContainEqual([omitted, "SIGKILL"]);
  } finally {
    kill.mockRestore();
    if (member === undefined && existsSync(memberFile))
      [member, omitted] = JSON.parse(readFileSync(memberFile, "utf8"));
    for (const pid of [member, omitted])
      if (pid !== undefined && !recoveryProcessStopped(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
  }
}, 20_000);
