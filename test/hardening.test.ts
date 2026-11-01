// Regression tests for defects found by the cross-vendor (Codex) review of the M1 core.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
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
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { gateScriptNames, pickScripts } from "../src/gates/detect.ts";
import { compareGates } from "../src/gates/run.ts";
import { parseNameStatus, resolveRepo } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { withScratch } from "../src/harness/scratch.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { startHttp } from "../src/server/http.ts";
import {
  agentEnv,
  invocationScratch,
  linuxAncestryInspection,
  linuxBirthClock,
  linuxCallerAncestors,
  ProcessTerminationError,
  processBirth,
  processBirthInspection,
  processInspection,
  processScope,
  registerCredential,
  runProcess,
  sh,
} from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { loadNativeInspection } from "./darwin-inspection-support.ts";
import { expectProcessStopped } from "./process-support.ts";
import { findingEvidence } from "./review-support.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-hard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };

describe("process handling", () => {
  test("Linux ancestry fails closed when an ancestor disappears or is inaccessible", () => {
    const ancestor = 424245;
    for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO"])
      for (const failedPid of [process.ppid, ancestor]) {
        const inspected: number[] = [];
        expect(() =>
          linuxCallerAncestors((pid) => {
            inspected.push(pid);
            if (pid === failedPid) throw Object.assign(new Error("ancestor unavailable"), { code });
            return `${pid} (parent with spaces) S ${ancestor} 0 0`;
          }),
        ).toThrow("Process ancestry could not be confirmed");
        expect(inspected).toEqual(failedPid === ancestor ? [process.ppid, ancestor] : [process.ppid]);
      }
    expect(
      linuxCallerAncestors((pid) => `${pid} (parent) S ${pid === process.ppid ? ancestor : 1} 0 0`),
    ).toEqual(new Set([1, process.pid, process.ppid, ancestor]));
  });

  test("unreadable Linux parent prevents discovery and signalling of a marked grandparent", async () => {
    const ancestor = 424245;
    const uid = process.getuid?.() ?? 0;
    const controller = new AbortController();
    const selected: number[] = [];
    const signals: number[] = [];
    const kill = process.kill.bind(process);
    const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === "SIGSTOP" || signal === "SIGTERM" || signal === "SIGKILL") {
        signals.push(pid);
        if (pid === ancestor) return true;
      }
      return kill(pid, signal);
    });
    try {
      const outcome = await linuxAncestryInspection.run(
        (pid) => {
          if (pid === process.ppid) throw Object.assign(new Error("hidden parent"), { code: "EACCES" });
          return `${pid} (ancestor) S 1 0 0`;
        },
        () =>
          processInspection.run(
            async (withEnvironment, marker, pids) => {
              if (pids) selected.push(...pids);
              return [
                `${process.pid} ${uid} S scanner LIMITLESS_PROCESS_SCAN=${marker}`,
                `${ancestor} ${uid} S ancestor${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`,
              ].join("\n");
            },
            () =>
              runProcess({
                cmd: [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
                cwd: dir,
                env: {},
                signal: controller.signal,
                onStdoutLine: () => controller.abort(),
              }).catch((error: unknown) => error),
          ),
      );
      expect(outcome).toBeInstanceOf(ProcessTerminationError);
      expect(String(outcome)).toContain("Process ancestry could not be confirmed");
      expect(selected).toEqual([]);
      expect(signals).not.toContain(ancestor);
    } finally {
      killSpy.mockRestore();
    }
  });

  test("Darwin discovery fails closed on unavailable ancestry and still cleans confirmed members", async () => {
    const native = await loadNativeInspection(dir);
    native.setProtectedMarker("protected-caller");
    const leader = native.captureDarwinInvocationLeader(native.leaderPid);
    const discover = () =>
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "protected-caller",
        native.leaderPid,
        100,
        [dir],
        leader,
      );
    for (const errno of [1, 2, 3, 13, 5])
      for (const pid of [process.ppid, native.ancestorPid]) {
        native.setAncestorFailure({ pid, errno });
        expect(() => native.darwinCallerAncestors()).toThrow("Process ancestry could not be confirmed");
        expect(discover).toThrow("Process ancestry could not be confirmed");
      }
    native.setAncestorFailure(null);
    expect(discover()).toEqual([native.memberPid, native.leaderPid]);
  });

  test("nested scratch restores the invocation root and unregisters cleaned paths", async () => {
    const scope = {
      signal: new AbortController().signal,
      killGraceMs: 0,
      children: new Map<ChildProcess, Promise<void>>(),
      scratchDirs: new Set<string>(),
    };
    await processScope.run(scope, () =>
      withScratch(dir, async (outer) => {
        expect(invocationScratch.getStore()).toBe(outer);
        await withScratch(dir, async (inner) => {
          expect(invocationScratch.getStore()).toBe(inner);
          expect(scope.scratchDirs.size).toBe(2);
        });
        expect(invocationScratch.getStore()).toBe(outer);
        expect(scope.scratchDirs.size).toBe(1);
      }),
    );
    expect(invocationScratch.getStore()).toBeUndefined();
    expect(scope.scratchDirs.size).toBe(0);
  });

  test("native discovery excludes marked ancestors before deriving descendant membership", async () => {
    const native = await loadNativeInspection(dir);
    native.setProtectedMarker("protected-caller");
    native.setUnreadableProcess({ parent: process.pid, born: 0n, cwd: { path: dir } });
    const leader = native.captureDarwinInvocationLeader(native.leaderPid);
    expect(
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "protected-caller",
        native.leaderPid,
        100,
        [dir],
        leader,
      ),
    ).toEqual([native.memberPid, native.leaderPid]);
  });

  test.each(["caller-session", "caller-group"] as const)(
    "native discovery never claims a process solely through the %s",
    async (membership) => {
      const native = await loadNativeInspection(dir);
      native.setMembership(membership);
      expect(
        native.markedDarwinProcesses(process.getuid?.() ?? 0, "unmarked", process.pid, 100, [dir], {
          pid: process.pid,
          birth: "1:0",
          session: process.pid,
          group: process.pid,
        }),
      ).toEqual([]);
    },
  );

  test("native discovery rejects a recycled leader's session/group identity", async () => {
    const native = await loadNativeInspection(dir);
    const selected = (leader: ReturnType<typeof native.captureDarwinInvocationLeader>) =>
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "original-invocation",
        native.leaderPid,
        Date.now(),
        [],
        leader,
      );
    for (const membership of ["session", "group"] as const) {
      native.setMembership(membership);
      native.setLeaderBirth(1n);
      const original = native.captureDarwinInvocationLeader(native.leaderPid);
      expect(original?.birth).toBe("1:0");
      expect(selected(original)).toContain(native.memberPid);
      native.setLeaderBirth(null);
      // Membership observed with the original live leader remains usable after exit.
      expect(selected(original)).toEqual([native.memberPid]);
      expect(selected(null)).toEqual([]);
      native.setLeaderBirth(2n);
      expect(selected(original)).toEqual([]);
    }
  });

  test("native unreadable argv uses hidden membership rules and candidate lookups fail closed", async () => {
    const native = await loadNativeInspection(dir);
    const leader = native.captureDarwinInvocationLeader(native.leaderPid);
    const selected = () =>
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "original-invocation",
        native.leaderPid,
        2000,
        [realpathSync(dir)],
        leader,
      );
    const unread = { errno: 1 };
    // An unreadable child of the live test runner is unrelated even inside our roots.
    native.setUnreadableProcess({ parent: process.pid, born: unread, cwd: unread });
    expect(selected()).toEqual([native.memberPid, native.leaderPid]);
    // Enumerated before its parent, but still claimed through proven membership.
    native.setUnreadableProcess({ parent: native.memberPid, born: unread, cwd: unread });
    expect(selected()).toContain(native.unreadablePid);
    native.setUnreadableProcess({ parent: process.pid, born: unread, cwd: unread, inGroup: true });
    expect(selected()).toContain(native.unreadablePid);
    // The same unreadable argv cannot establish numeric ownership after PID reuse.
    native.setLeaderBirth(2n);
    expect(selected()).not.toContain(native.unreadablePid);
    native.setLeaderBirth(1n);
    native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: dir } });
    expect(selected()).toContain(native.unreadablePid);
    native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { errno: 22 } });
    expect(selected).toThrow(`Process cwd inspection failed for ${native.unreadablePid}`);
    native.setUnreadableProcess({ parent: 1, born: unread, cwd: unread });
    expect(selected).toThrow(`Process birth time inspection failed for ${native.unreadablePid}`);
  });

  test("native discovery skips marked processes that started before the spawn unless the start is unreadable", async () => {
    const native = await loadNativeInspection(dir);
    native.setMemberMarker("this-invocation");
    const selected = (spawnedAt: bigint) =>
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "this-invocation",
        native.leaderPid,
        100,
        [dir],
        null,
        new Set([process.pid]),
        spawnedAt,
      );
    native.setMemberStart(5n);
    expect(selected(5n)).toEqual([native.memberPid]);
    expect(selected(6n)).toEqual([]);
    native.setMemberStart({ errno: 1 });
    expect(selected(6n)).toEqual([native.memberPid]);
    native.setMemberStart(0n);
    expect(selected(6n)).toEqual([native.memberPid]);
  });

  test.each([
    "root",
    "home",
    "ancestor",
    "mixed",
    "root-alias",
    "root-dotdot",
    "home-alias",
    "ancestor-alias",
    "symlinked-home",
    "home-trailing",
    "home-dotdot",
  ] as const)("Darwin cwd discovery refuses unsafe %s roots", async (scenario) => {
    const native = await loadNativeInspection(dir);
    const users = join(dir, "users");
    const home = join(users, "owner");
    const checkout = join(home, "checkout");
    const scratch = join(dir, "scratch");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(scratch);
    symlinkSync("/", join(dir, "root-alias"));
    symlinkSync(home, join(dir, "home-alias"));
    symlinkSync(users, join(dir, "ancestor-alias"));
    native.setHome(scenario === "symlinked-home" ? join(dir, "home-alias") : home);
    const cases = {
      root: { roots: ["/"], cwd: "/" },
      home: { roots: [home], cwd: checkout },
      ancestor: { roots: [users], cwd: checkout },
      mixed: { roots: [home, scratch], cwd: scratch },
      "root-alias": { roots: [join(dir, "root-alias"), scratch], cwd: scratch },
      "root-dotdot": {
        roots: [process.platform === "darwin" ? "/private/.." : "/..", scratch],
        cwd: scratch,
      },
      "home-alias": { roots: [join(dir, "home-alias"), scratch], cwd: scratch },
      "ancestor-alias": { roots: [join(dir, "ancestor-alias"), scratch], cwd: scratch },
      "symlinked-home": { roots: [home], cwd: checkout },
      "home-trailing": { roots: [`${home}///`, scratch], cwd: scratch },
      "home-dotdot": { roots: [`${checkout}/..`, scratch], cwd: scratch },
    };
    const { roots, cwd } = cases[scenario];
    native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: cwd } });
    // This shared entry point also receives legacy persisted discovery roots verbatim.
    const selected = () =>
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "unmarked",
        native.leaderPid,
        2000,
        roots,
        null,
        new Set([process.pid]),
      );
    expect(selected()).not.toContain(native.unreadablePid);
    expect(
      native.hiddenDarwinProcessMember(
        42,
        new Map([[42, 1]]),
        new Set(),
        2000,
        roots,
        () => 2000,
        () => ({ path: cwd }),
      ),
    ).toBe(false);
    // Unsafe roots must not turn unrelated, inaccessible processes into scan errors.
    native.setUnreadableProcess({ parent: 1, born: { errno: 1 }, cwd: { errno: 1 } });
    expect(selected()).not.toContain(native.unreadablePid);
  });

  test.each(["home", "root"] as const)(
    "Darwin cwd discovery retains surviving roots with an unresolvable %s",
    async (missing) => {
      const native = await loadNativeInspection(dir);
      const home = join(dir, "home");
      const scratch = join(dir, "scratch");
      mkdirSync(home);
      mkdirSync(scratch);
      native.setHome(missing === "home" ? join(home, "missing") : home);
      const roots = [scratch, ...(missing === "root" ? [join(dir, "missing")] : [])];
      const selected = () =>
        native.markedDarwinProcesses(
          process.getuid?.() ?? 0,
          "this-invocation",
          native.leaderPid,
          2000,
          roots,
          null,
          new Set([process.pid]),
        );
      native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: scratch } });
      expect(selected()).toContain(native.unreadablePid);
      native.setMemberMarker("this-invocation");
      native.setUnreadableProcess({ parent: native.memberPid, born: { errno: 1 }, cwd: { errno: 1 } });
      expect(selected().sort()).toEqual([native.memberPid, native.unreadablePid]);
    },
  );

  test.each(["EPERM", "EACCES"])(
    "Darwin discovery skips %s roots without losing ownership evidence",
    async (code) => {
      const native = await loadNativeInspection(dir);
      const denied = join(dir, "denied");
      const checkout = join(dir, "checkout");
      const scratch = join(dir, "scratch");
      for (const root of [denied, checkout, scratch]) mkdirSync(root);
      native.setRealpathFailure({ path: denied, code });
      const selected = (roots: string[]) =>
        native.markedDarwinProcesses(
          process.getuid?.() ?? 0,
          "this-invocation",
          native.leaderPid,
          2000,
          roots,
          null,
          new Set([process.pid]),
        );
      const hiddenMember = (roots: string[], cwd: string, parent = 1, members = new Set<number>()) =>
        native.hiddenDarwinProcessMember(
          native.unreadablePid,
          new Map([[native.unreadablePid, parent]]),
          members,
          2000,
          roots,
          () => 2000,
          () => ({ path: cwd }),
        );
      for (const surviving of [checkout, scratch]) {
        const roots = [denied, surviving];
        for (const cwd of [denied, surviving]) {
          native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: cwd } });
          expect(selected(roots).includes(native.unreadablePid)).toBe(cwd === surviving);
          expect(hiddenMember(roots, cwd)).toBe(cwd === surviving);
        }
      }
      // Without any readable cwd roots, unrelated orphans stay excluded even when
      // their birth time and cwd cannot be inspected; markers and ancestry still work.
      native.setUnreadableProcess({ parent: 1, born: { errno: 1 }, cwd: { errno: 1 } });
      expect(selected([denied])).toEqual([]);
      expect(hiddenMember([denied], denied)).toBe(false);
      native.setMemberMarker("this-invocation");
      expect(selected([denied])).toEqual([native.memberPid]);
      native.setUnreadableProcess({ parent: native.memberPid, born: { errno: 1 }, cwd: { errno: 1 } });
      expect(selected([denied]).sort()).toEqual([native.memberPid, native.unreadablePid]);
      expect(hiddenMember([denied], denied, native.memberPid, new Set([native.memberPid]))).toBe(true);
    },
  );

  test("unreadable Darwin home preserves safe roots and refuses its configured spelling", async () => {
    const native = await loadNativeInspection(dir);
    const home = join(dir, "home");
    const checkout = join(home, "checkout");
    const scratch = join(dir, "scratch");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(scratch);
    native.setHome(`${home}/./`);
    native.setRealpathFailure({ path: home, code: "EACCES" });
    for (const cwd of [checkout, scratch]) {
      native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: cwd } });
      for (const roots of [
        [checkout, scratch],
        [home, scratch],
        [dir, scratch],
      ]) {
        const expected = roots[0] === checkout;
        expect(
          native
            .markedDarwinProcesses(
              process.getuid?.() ?? 0,
              "unmarked",
              native.leaderPid,
              2000,
              roots,
              null,
              new Set([process.pid]),
            )
            .includes(native.unreadablePid),
        ).toBe(expected);
        expect(
          native.hiddenDarwinProcessMember(
            42,
            new Map([[42, 1]]),
            new Set(),
            2000,
            roots,
            () => 2000,
            () => ({ path: cwd }),
          ),
        ).toBe(expected);
      }
    }
    // A case alias is meaningful only on a filesystem that resolves it to this home.
    native.setRealpathFailure(null);
    const caseAlias = join(dir, "HOME");
    if (existsSync(caseAlias)) {
      native.setHome(home);
      expect(
        native.hiddenDarwinProcessMember(
          42,
          new Map([[42, 1]]),
          new Set(),
          2000,
          [caseAlias, scratch],
          () => 2000,
          () => ({ path: scratch }),
        ),
      ).toBe(false);
    }
  });

  test("unsafe Darwin roots preserve marker, ancestry and session/group discovery without cwd", async () => {
    const native = await loadNativeInspection(dir);
    const selected = (leader: ReturnType<typeof native.captureDarwinInvocationLeader>) =>
      native.markedDarwinProcesses(
        process.getuid?.() ?? 0,
        "this-invocation",
        native.leaderPid,
        2000,
        ["/", dir],
        leader,
        new Set([process.pid]),
      );
    native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: dir } });
    expect(selected(null)).not.toContain(native.unreadablePid);
    native.setMemberMarker("this-invocation");
    native.setUnreadableProcess({ parent: native.memberPid, born: { errno: 1 }, cwd: { errno: 1 } });
    expect(selected(null).sort()).toEqual([native.memberPid, native.unreadablePid]);
    for (const membership of ["session", "group"] as const) {
      native.setMembership(membership);
      native.setUnreadableProcess({ parent: 1, born: { errno: 1 }, cwd: { errno: 1 }, inGroup: true });
      expect(selected(native.captureDarwinInvocationLeader(native.leaderPid))).toContain(
        native.unreadablePid,
      );
    }
  });

  test("safe Darwin checkout and scratch roots retain orphan birth, parent and path boundaries", async () => {
    const native = await loadNativeInspection(dir);
    const home = join(dir, "home");
    const checkout = join(home, "checkout");
    const scratch = join(dir, "scratch");
    const homeSibling = `${home}-sibling`;
    for (const path of [checkout, scratch, homeSibling]) mkdirSync(path, { recursive: true });
    native.setHome(home);
    for (const root of [checkout, scratch, homeSibling]) {
      const nested = join(root, "nested");
      mkdirSync(nested);
      const alias = join(dir, "safe-alias");
      symlinkSync(root, alias);
      const selected = () =>
        native.markedDarwinProcesses(
          process.getuid?.() ?? 0,
          "unmarked",
          native.leaderPid,
          2000,
          [alias],
          null,
          new Set([process.pid]),
        );
      for (const cwd of [root, nested]) {
        native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: cwd } });
        expect(selected()).toContain(native.unreadablePid);
      }
      native.setUnreadableProcess({ parent: 1, born: 2n, cwd: { path: `${realpathSync(root)}-sibling` } });
      expect(selected()).not.toContain(native.unreadablePid);
      native.setUnreadableProcess({ parent: 1, born: 1n, cwd: { errno: 1 } });
      expect(selected()).not.toContain(native.unreadablePid);
      native.setUnreadableProcess({ parent: process.pid, born: { errno: 1 }, cwd: { errno: 1 } });
      expect(selected()).not.toContain(native.unreadablePid);
      rmSync(alias);
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "finishing one invocation never signals another invocation's hidden scratch orphan",
    async () => {
      const scope = {
        signal: new AbortController().signal,
        killGraceMs: 20,
        children: new Map<ChildProcess, Promise<void>>(),
        scratchDirs: new Set<string>(),
      };
      const start = join(dir, "start-writer");
      const release = join(dir, "release-owner");
      const pidFile = join(dir, "other-writer-pid");
      const output = join(dir, "other-writer-output");
      const launcher = join(dir, "other-launcher.js");
      const kill = process.kill.bind(process);
      const signals: number[] = [];
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGSTOP" || signal === "SIGTERM" || signal === "SIGKILL") signals.push(pid);
        return kill(pid, signal);
      });
      let owner: Promise<unknown> | undefined;
      let ownerScratch = "";
      try {
        await processScope.run(scope, async () => {
          const ready = Promise.withResolvers<void>();
          owner = withScratch(dir, (scratch) => {
            ownerScratch = scratch;
            writeFileSync(
              launcher,
              `require("node:child_process").spawn("/bin/sh",
              ["-c", 'trap "" TERM; echo $$ > "$1"; while [ -d "$2" ]; do printf x >> "$3"; done', "sh",
                ${JSON.stringify(pidFile)}, ${JSON.stringify(scratch)}, ${JSON.stringify(output)}],
              {cwd:${JSON.stringify(scratch)}, env:{}, detached:true, stdio:"ignore"}).unref();`,
            );
            return runProcess({
              cmd: [
                process.execPath,
                "-e",
                `const fs = require("node:fs"); console.log("ready");
                let launched = false;
                setInterval(() => {
                  if (!launched && fs.existsSync(${JSON.stringify(start)})) {
                    launched = true;
                    require("node:child_process").spawn(process.execPath, [${JSON.stringify(launcher)}], {stdio:"ignore"}).unref();
                  }
                  if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
                }, 5);`,
              ],
              cwd: dir,
              env: process.env as Record<string, string>,
              timeoutMs: 5000,
              onStdoutLine: () => ready.resolve(),
            });
          });
          await ready.promise;
          const finished = await withScratch(dir, () =>
            runProcess({
              cmd: [
                process.execPath,
                "-e",
                `console.log("ready"); setInterval(() => {
              if (require("node:fs").existsSync(${JSON.stringify(output)})) process.exit(0);
            }, 5);`,
              ],
              cwd: dir,
              env: process.env as Record<string, string>,
              timeoutMs: 3000,
              onStdoutLine: () => writeFileSync(start, ""),
            }),
          );
          const writerPid = Number(readFileSync(pidFile, "utf8"));
          expect(finished.exitCode).toBe(0);
          expect(finished.timedOut).toBe(false);
          expect(writerPid).toBeGreaterThan(0);
          expect(signals).not.toContain(writerPid);
          expect(kill(writerPid, 0)).toBe(true);
          expect(scope.children.size).toBe(1);
          expect(scope.scratchDirs.size).toBe(1);
          expect(existsSync(ownerScratch)).toBe(true);
          writeFileSync(release, "");
          await owner;
          expectProcessStopped(writerPid);
          expect(scope.scratchDirs.size).toBe(0);
          expect(existsSync(ownerScratch)).toBe(false);
        });
      } finally {
        killSpy.mockRestore();
        writeFileSync(release, "");
        await owner?.catch(() => {});
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8"));
          if (pid > 0) {
            try {
              kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
    },
  );

  test("a child that exits before reading stdin does not crash us (EPIPE)", async () => {
    const res = await runProcess({
      cmd: ["/bin/sh", "-c", "exit 3"],
      cwd: dir,
      env: process.env as Record<string, string>,
      stdin: "x".repeat(5_000_000),
    });
    expect(res.exitCode).toBe(3);
  });

  test.each(["", ">/dev/null 2>&1"])(
    "background processes left by the child are reaped (%s)",
    async (stdio) => {
      const marker = join(dir, "alive");
      const pidFile = join(dir, "pid");
      // The leftover keeps touching the marker; the child exits only once it is running. Should reaping
      // fail, the leftover still stops once afterEach removes `dir`, or after about 5 s.
      const leftover = `i=0; while [ $i -lt 100 ] && [ -d ${dir} ]; do touch ${marker}; i=$((i+1)); sleep 0.05; done`;
      await runProcess({
        cmd: [
          "/bin/sh",
          "-c",
          `(${leftover}) ${stdio} & echo $! > ${pidFile}; while [ ! -e ${marker} ]; do sleep 0.01; done`,
        ],
        cwd: dir,
        env: process.env as Record<string, string>,
      });
      expectProcessStopped(Number(readFileSync(pidFile, "utf8")));
      await Bun.sleep(20);
      rmSync(marker);
      await Bun.sleep(300);
      expect(await Bun.file(marker).exists()).toBe(false);
    },
  );

  test("a descendant ignoring SIGTERM cannot recreate removed scratch after return", async () => {
    const scratch = join(dir, "scratch");
    const pidFile = join(dir, "descendant-pid");
    const child = join(dir, "child.js");
    const parent = join(dir, "parent.js");
    writeFileSync(
      child,
      `const fs = require("node:fs"); process.on("SIGTERM", () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => { fs.mkdirSync(${JSON.stringify(scratch)}, {recursive:true}); }, 5);
      setTimeout(() => process.exit(), 15000);`,
    );
    writeFileSync(
      parent,
      `const {spawn} = require("node:child_process");
      const fs = require("node:fs");
      spawn(process.execPath, [${JSON.stringify(child)}], {stdio:"ignore"}).unref();
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(scratch)})) { clearInterval(timer); process.exit(0); } }, 5);`,
    );
    try {
      await runProcess({
        cmd: [process.execPath, parent],
        cwd: dir,
        env: process.env as Record<string, string>,
        timeoutMs: 3000,
      });
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expectProcessStopped(pid);
      expect(existsSync(scratch)).toBe(true);
      rmSync(scratch, { recursive: true, force: true });
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    }
  });

  test.each(["normal", "error", "cancelled", "timeout", "stuck"])(
    "detached reparented writer is gone before cleanup on %s",
    async (ending) => {
      const pidFile = join(dir, "detached-pid");
      const ready = join(dir, "writer-ready");
      const writer = join(dir, "writer.js");
      const launcher = join(dir, "launcher.js");
      const parent = join(dir, "parent.js");
      writeFileSync(
        writer,
        `const fs = require("node:fs");
        process.on("SIGTERM", () => {});
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => fs.appendFileSync(${JSON.stringify(ready)}, "x"), 5);
        setTimeout(() => process.exit(), 15000);`,
      );
      writeFileSync(
        launcher,
        `const {runProcess, agentEnv} = await import(${JSON.stringify(join(process.cwd(), "src/util/proc.ts"))});
        runProcess({cmd:["/bin/sh", "-c", 'exec "$1" "$2"', "sh", process.execPath, ${JSON.stringify(writer)}],
          cwd:process.cwd(), env:agentEnv()});
        process.exit(0);`,
      );
      writeFileSync(
        parent,
        `const {spawn} = require("node:child_process"); const fs = require("node:fs");
        const launcher = spawn(process.execPath, [${JSON.stringify(launcher)}], {stdio:"ignore"});
        launcher.on("exit", () => {
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(ready)})) return;
            clearInterval(timer); console.log(process.env.LIMITLESS_INVOCATION);
            ${ending === "normal" || ending === "error" ? `process.exit(${ending === "error" ? 3 : 0});` : "setInterval(() => {}, 1000);"}
          }, 5);
        });`,
      );
      const env = { ...process.env };
      delete env.LIMITLESS_INVOCATION;
      const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env,
        stdio: "ignore",
      });
      let argumentControl: ChildProcess | undefined;
      const controller = new AbortController();
      let writerPid: number | undefined;
      let cleanup = false;
      try {
        const res = await runProcess({
          cmd: [process.execPath, parent],
          cwd: dir,
          env: env as Record<string, string>,
          signal: controller.signal,
          onStdoutLine: (marker) => {
            writerPid = Number(readFileSync(pidFile, "utf8"));
            argumentControl = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)", `LIMITLESS_INVOCATION=${marker}`],
              {
                env: {
                  ...env,
                  LIMITLESS_INVOCATION: `${marker}-other`,
                  OTHER_LIMITLESS_INVOCATION: marker,
                  UNMARKED_VALUE: `prefix LIMITLESS_INVOCATION=${marker} suffix`,
                },
                stdio: "ignore",
              },
            );
            if (ending === "cancelled" || ending === "stuck") controller.abort(new Error(ending));
          },
          timeoutMs: ending === "timeout" ? 1500 : undefined,
        });
        // A real wall timeout must be the reason the invocation ended.
        if (ending === "timeout") expect(res.timedOut).toBe(true);
        if (ending === "cancelled" || ending === "stuck") expect(res.cancelled).toBe(true);
        if (ending === "normal" || ending === "error") expect(res.exitCode).toBe(ending === "error" ? 3 : 0);
        expect(writerPid).toBeGreaterThan(0);
        await (async () => {
          expectProcessStopped(writerPid ?? 0);
          expect(control.pid).toBeGreaterThan(0);
          expect(process.kill(control.pid ?? 0, 0)).toBe(true);
          expect(argumentControl?.pid).toBeGreaterThan(0);
          expect(process.kill(argumentControl?.pid ?? 0, 0)).toBe(true);
          cleanup = true;
          rmSync(ready);
        })();
        expect(cleanup).toBe(true);
      } finally {
        controller.abort();
        control.kill("SIGKILL");
        argumentControl?.kill("SIGKILL");
        await new Promise<void>((resolve) => control.once("close", () => resolve()));
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {}
        }
      }
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "a pre-aborted invocation whose leader cannot be inspected rejects instead of hanging",
    async () => {
      const darwin = await import("../src/util/processes-darwin.ts");
      const capture = spyOn(darwin, "captureDarwinInvocationLeader").mockImplementation(() => {
        throw new Error("leader inspection failed");
      });
      const controller = new AbortController();
      controller.abort();
      const dir = mkdtempSync(join(tmpdir(), "limitless-preabort-"));
      try {
        const outcome = await Promise.race([
          runProcess({
            cmd: ["/bin/sh", "-c", "sleep 5"],
            cwd: dir,
            env: process.env as Record<string, string>,
            signal: controller.signal,
          }).then(
            () => "resolved",
            (error: unknown) => error,
          ),
          // A bound on a hang, not an ordering: the rejection arrives within milliseconds.
          Bun.sleep(3_000).then(() => "pending"),
        ]);
        expect(outcome).toBeInstanceOf(ProcessTerminationError);
      } finally {
        capture.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("empty startup snapshots cannot confirm shutdown before the direct child exits", async () => {
    const controller = new AbortController();
    const uid = process.getuid?.() ?? 0;
    let pid: number | undefined;
    let snapshots = 0;
    try {
      await processInspection.run(
        async (withEnvironment, marker) => {
          if (withEnvironment) snapshots++;
          let alive = false;
          if (pid !== undefined) {
            try {
              alive = process.kill(pid, 0);
            } catch {}
          }
          return [
            `${process.pid} ${uid} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
            ...(alive && snapshots > 2
              ? [`${pid} ${uid} S child${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`]
              : []),
          ].join("\n");
        },
        async () => {
          const result = await runProcess({
            cmd: [
              process.execPath,
              "-e",
              "console.log(process.pid); setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 3000)",
            ],
            cwd: dir,
            env: process.env as Record<string, string>,
            signal: controller.signal,
            onStdoutLine: (line) => {
              pid = Number(line);
              controller.abort();
            },
          });
          expect(result.cancelled).toBe(true);
          expect(snapshots).toBeGreaterThan(2);
          expect(pid).toBeGreaterThan(0);
          expectProcessStopped(pid ?? 0);
          // This callback represents the cleanup that is allowed only after shutdown.
          writeFileSync(join(dir, "cleanup-started"), "");
        },
      );
      expect(existsSync(join(dir, "cleanup-started"))).toBe(true);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });

  test("marked caller and ancestors are never signalled, while an owned child is stopped", async () => {
    const uid = process.getuid?.() ?? 0;
    const protectedPids = [process.pid, process.ppid];
    const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const controller = new AbortController();
    const kill = process.kill.bind(process);
    const signals: number[] = [];
    let pid: number | undefined;
    const killSpy = spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === "SIGSTOP" || signal === "SIGTERM" || signal === "SIGKILL") {
        signals.push(target);
        // A regression must record the unsafe target without killing the test or its ancestors.
        if (protectedPids.includes(target)) throw new Error("protected process signalled");
      }
      return kill(target, signal);
    });
    try {
      await processInspection.run(
        async (withEnvironment, marker) => {
          const tagged = (target: number, command: string) =>
            `${target} ${uid} S ${command}${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`;
          let alive = false;
          if (pid !== undefined) {
            try {
              alive = kill(pid, 0);
            } catch {}
          }
          return [
            ...protectedPids.map(
              (target) =>
                tagged(target, "protected") +
                (target === process.pid && withEnvironment ? ` LIMITLESS_PROCESS_SCAN=${marker}` : ""),
            ),
            // This unmarked sibling shares the caller's group/session, but is not owned.
            `${control.pid} ${uid} S control`,
            ...(alive && pid !== undefined ? [tagged(pid, "child")] : []),
          ].join("\n");
        },
        () =>
          runProcess({
            cmd: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
            cwd: dir,
            env: {},
            signal: controller.signal,
            onStdoutLine: (line) => {
              pid = Number(line);
              controller.abort();
            },
          }),
      );
      expect(signals).toContain(pid ?? 0);
      expect(signals.some((target) => protectedPids.includes(target))).toBe(false);
      expect(signals).not.toContain(control.pid);
      expect(kill(control.pid ?? 0, 0)).toBe(true);
      expectProcessStopped(pid ?? 0);
      pid = undefined;
    } finally {
      killSpy.mockRestore();
      control.kill("SIGKILL");
      if (pid !== undefined) {
        try {
          kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });

  test.each([false, true])(
    "inspection selects exact markers and uid, excluding argv matches (exec race: %p)",
    async (changing) => {
      const children = Array.from({ length: 3 }, () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
      );
      const [writer, control, foreign] = children;
      const uid = process.getuid?.() ?? 0;
      const kill = process.kill.bind(process);
      const signalled: number[] = [];
      let plainInspections = 0;
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGSTOP" || signal === "SIGTERM" || signal === "SIGKILL") signalled.push(pid);
        return kill(pid, signal);
      });
      try {
        await processInspection.run(
          async (withEnvironment, marker) => {
            const writerCommand =
              changing && withEnvironment && plainInspections === 0 ? "starting" : "writer";
            if (!withEnvironment) plainInspections++;
            const alive = (child: ChildProcess | undefined) => {
              if (!child?.pid) return false;
              try {
                return kill(child.pid, 0);
              } catch {
                return false;
              }
            };
            return [
              `${process.pid} ${uid} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
              ...(alive(writer)
                ? [
                    `${writer?.pid} ${uid} S ${writerCommand}${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`,
                  ]
                : []),
              `${control?.pid} ${uid} S control LIMITLESS_INVOCATION=${marker}${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}-other OTHER_LIMITLESS_INVOCATION=${marker}` : ""}`,
              `${foreign?.pid} ${uid + 1} S foreign${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`,
            ].join("\n");
          },
          () =>
            runProcess({
              cmd: ["/bin/sh", "-c", "exit 0"],
              cwd: dir,
              env: process.env as Record<string, string>,
            }),
        );
        expect(signalled.length).toBeGreaterThan(0);
        expect(signalled.every((pid) => pid === writer?.pid)).toBe(true);
        expect(kill(control?.pid ?? 0, 0)).toBe(true);
        expect(kill(foreign?.pid ?? 0, 0)).toBe(true);
      } finally {
        killSpy.mockRestore();
        for (const child of children) child.kill("SIGKILL");
        await Promise.all(
          children.map((child) =>
            child.exitCode !== null || child.signalCode !== null
              ? Promise.resolve()
              : new Promise<void>((resolve) => child.once("close", () => resolve())),
          ),
        );
      }
    },
  );

  test.skipIf(process.platform !== "darwin").each([false, true])(
    "macOS native inspection ignores an older hidden orphan (inherited marker: %p)",
    async (marked) => {
      const { markedDarwinProcesses } = await import("../src/util/processes-darwin.ts");
      const pidFile = join(dir, "hidden-pid");
      // The orphan works in this test's own directory, so only its birth time keeps the invocations
      // below from claiming it; in a shared directory another file's invocation could. It outlives
      // the test's 30 s timeout and is killed in finally.
      const launcher = spawn(
        process.execPath,
        [
          "-e",
          `require("node:child_process").spawn("/bin/sh", ["-c", 'echo $$ > "$1"; exec sleep 60', "sh", ${JSON.stringify(pidFile)}],
          {detached:true, stdio:"ignore", env:${marked ? '{LIMITLESS_INVOCATION:"hidden-writer"}' : "{}"}}).unref();`,
        ],
        { stdio: "ignore", cwd: dir },
      );
      let pid: number | undefined;
      let birth: string | null = null;
      let spawning = true;
      const churn = (async () => {
        while (spawning) {
          const children = Array.from({ length: 8 }, () => spawn("/usr/bin/true", [], { stdio: "ignore" }));
          await Promise.all(
            children.map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))),
          );
        }
      })();
      try {
        await new Promise<void>((resolve) => launcher.once("close", () => resolve()));
        const deadline = Date.now() + 3000;
        while ((!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) && Date.now() < deadline)
          await Bun.sleep(10);
        pid = Number(readFileSync(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
        birth = await processBirth(pid);
        expect(
          markedDarwinProcesses(process.getuid?.() ?? 0, "hidden-writer", launcher.pid ?? 0, Date.now(), [
            realpathSync(dir),
          ]),
        ).not.toContain(pid);
        const result = await runProcess({
          cmd: [process.execPath, "-e", "process.exit(0)"],
          cwd: dir,
          env: process.env as Record<string, string>,
        });
        expect(result.exitCode).toBe(0);
        expect(process.kill(pid, 0)).toBe(true);
      } finally {
        spawning = false;
        await churn;
        launcher.kill("SIGKILL");
        // Under load finally can run after the sleep ends and the pid is reused; signal only our orphan.
        if (pid !== undefined && birth !== null && (await processBirth(pid)) === birth) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "macOS native inspection claims a marked process started after the spawn, not one started before",
    async () => {
      const { darwinCallerAncestors, darwinClock, markedDarwinProcesses } = await import(
        "../src/util/processes-darwin.ts"
      );
      const marker = "spawn-boundary";
      // Not a platform binary, so the kernel exposes its environment.
      const holder = () =>
        spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
          env: { ...process.env, LIMITLESS_INVOCATION: marker },
          stdio: ["ignore", "pipe", "ignore"],
        });
      const ready = (child: ChildProcess) =>
        new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
      const older = holder();
      const spawnedAt = darwinClock();
      const newer = holder();
      try {
        await Promise.all([ready(older), ready(newer)]);
        const [olderPid, newerPid] = [older.pid, newer.pid];
        if (olderPid === undefined || newerPid === undefined) throw new Error("holder did not start");
        const scan = (since: bigint) =>
          markedDarwinProcesses(
            process.getuid?.() ?? 0,
            marker,
            newerPid,
            0,
            [realpathSync(dir)],
            null,
            darwinCallerAncestors(),
            since,
          );
        expect(scan(0n)).toEqual(expect.arrayContaining([olderPid, newerPid]));
        const found = scan(spawnedAt);
        expect(found).toContain(newerPid);
        expect(found).not.toContain(olderPid);
      } finally {
        older.kill("SIGKILL");
        newer.kill("SIGKILL");
      }
    },
  );

  test.skipIf(process.platform !== "darwin").each(["outside", "sibling", "inside"])(
    "a new hidden platform process in a %s cwd is never signalled",
    async (location) => {
      const controlCwd =
        location === "inside"
          ? dir
          : location === "sibling"
            ? `${dir}-sibling`
            : mkdtempSync(join(tmpdir(), "limitless-control-"));
      mkdirSync(controlCwd, { recursive: true });
      const release = join(dir, "release");
      let control: ChildProcess | undefined;
      const kill = process.kill.bind(process);
      const signals: number[] = [];
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGSTOP" || signal === "SIGTERM" || signal === "SIGKILL") signals.push(pid);
        return kill(pid, signal);
      });
      try {
        const result = await runProcess({
          cmd: [
            process.execPath,
            "-e",
            `console.log("ready"); setInterval(() => {
            if (require("node:fs").existsSync(${JSON.stringify(release)})) process.exit(0);
          }, 5);`,
          ],
          cwd: dir,
          env: process.env as Record<string, string>,
          onStdoutLine: () => {
            // Born after invocation start, but a child of the test process without its marker.
            control = spawn("/bin/sleep", ["15"], {
              cwd: controlCwd,
              detached: location !== "inside",
              stdio: "ignore",
              env: {},
            });
            control.once("spawn", () => writeFileSync(release, ""));
          },
          timeoutMs: 3000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(control?.pid).toBeGreaterThan(0);
        expect(signals).not.toContain(control?.pid);
        expect(kill(control?.pid ?? 0, 0)).toBe(true);
      } finally {
        killSpy.mockRestore();
        if (control && control.exitCode === null && control.signalCode === null) {
          const closed = new Promise<void>((resolve) => control?.once("close", () => resolve()));
          control.kill("SIGKILL");
          await closed;
        }
        if (controlCwd !== dir) rmSync(controlCwd, { recursive: true, force: true });
      }
    },
  );

  test("cwd permission errors are ignored only under the read allowlist", async () => {
    const native = await loadNativeInspection(dir);
    native.setHome(`${dir}-unreadable-home`);
    native.setRealpathFailure({ path: native.homedir(), code: "EACCES" });
    const decide = (errno: number) =>
      native.hiddenDarwinProcessMember(
        42,
        new Map([[42, 1]]),
        new Set(),
        100,
        [realpathSync(dir)],
        () => 101,
        () => ({ errno }),
      );
    for (const confined of [false, true]) {
      native.setReadAllowlist(confined);
      for (const errno of [1, 13]) {
        if (confined) expect(decide(errno)).toBe(false);
        else expect(() => decide(errno)).toThrow("Process cwd inspection failed for 42");
      }
      expect(decide(3)).toBe(false);
      for (const errno of [5, 22])
        expect(() => decide(errno)).toThrow("Process cwd inspection failed for 42");
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "hidden cwd membership uses canonical roots and fails closed",
    async () => {
      const { hiddenDarwinProcessMember } = await loadNativeInspection(dir);
      const nested = join(dir, "nested");
      mkdirSync(nested);
      const alias = join(dir, "alias");
      symlinkSync(nested, alias);
      const roots = [realpathSync(dir)];
      const parents = new Map([[42, 1]]);
      const members = new Set<number>();
      const decide = (
        readBorn: () => number | { errno: number },
        readCwd: () => { path: string } | { errno: number },
      ) => hiddenDarwinProcessMember(42, parents, members, 100, roots, readBorn, readCwd);
      expect(
        decide(
          () => 100,
          () => ({ path: dir }),
        ),
      ).toBe(true);
      expect(
        decide(
          () => 101,
          () => ({ path: alias }),
        ),
      ).toBe(true);
      expect(
        decide(
          () => 99,
          () => {
            throw new Error("must not inspect older cwd");
          },
        ),
      ).toBe(false);
      const sibling = `${dir}-sibling`;
      mkdirSync(join(sibling, "inner"), { recursive: true });
      try {
        expect(
          decide(
            () => 101,
            () => ({ path: sibling }),
          ),
        ).toBe(false);
        // Any new orphan is a candidate. Unrelated ones may sit where realpath fails (a
        // sandbox container, a deleted directory); that must not block our shutdown.
        chmodSync(sibling, 0o000);
        expect(
          decide(
            () => 101,
            () => ({ path: join(sibling, "inner") }),
          ),
        ).toBe(false);
        expect(
          decide(
            () => 101,
            () => ({ path: join(`${dir}-deleted`, "inner") }),
          ),
        ).toBe(false);
        // Our own orphan whose cwd was deleted is still recognised by its reported path.
        expect(
          decide(
            () => 101,
            () => ({ path: join(roots[0] ?? dir, "deleted") }),
          ),
        ).toBe(true);
      } finally {
        chmodSync(sibling, 0o700);
        rmSync(sibling, { recursive: true, force: true });
      }
      expect(
        decide(
          () => 101,
          () => ({ errno: 3 }),
        ),
      ).toBe(false);
      const unread = () => {
        throw new Error("must not inspect cwd after a failed birth time lookup");
      };
      expect(decide(() => ({ errno: 3 }), unread)).toBe(false);
      for (const errno of [1, 5, 22]) {
        expect(() =>
          decide(
            () => 101,
            () => ({ errno }),
          ),
        ).toThrow("Process cwd inspection failed for 42");
        expect(() => decide(() => ({ errno }), unread)).toThrow(
          "Process birth time inspection failed for 42",
        );
      }
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "hidden membership follows proven ancestry and ignores live non-members without lookups",
    async () => {
      const { hiddenDarwinProcessMember } = await import("../src/util/processes-darwin.ts");
      const parents = new Map([
        [42, 43],
        [43, 44],
        [44, 1],
      ]);
      const members = new Set<number>();
      const unread = () => {
        throw new Error("live-parent candidates must not inspect birth time or cwd");
      };
      const decide = () =>
        hiddenDarwinProcessMember(42, parents, members, 100, [realpathSync(dir)], unread, unread);
      expect(decide()).toBe(false);
      members.add(43); // Direct child of a marker/session/group member, even outside the cwd roots.
      expect(decide()).toBe(true);
      members.clear();
      members.add(44); // Grandchild, even before its intermediate parent has been identified.
      expect(decide()).toBe(true);
      members.clear();
      expect(
        hiddenDarwinProcessMember(
          44,
          parents,
          members,
          100,
          [realpathSync(dir)],
          () => 101,
          () => ({ path: dir }),
        ),
      ).toBe(true);
      members.add(44); // The orphan rule also seeds ancestry membership.
      expect(decide()).toBe(true);
      members.clear();
      parents.delete(44); // An absent parent is not evidence of orphaning.
      expect(decide()).toBe(false);
      parents.set(43, 42); // Defensive cycle handling must not hang inspection.
      expect(decide()).toBe(false);
      parents.set(42, 0);
      expect(decide()).toBe(false);
    },
  );

  test.skipIf(process.platform !== "darwin").each(["normal", "error", "cancelled", "timeout", "stuck"])(
    "a detached reparented shell with a hidden environment is stopped on %s",
    async (ending) => {
      const pidFile = join(dir, "shell-pid");
      const output = join(dir, "shell-output");
      const launcher = join(dir, "shell-launcher.js");
      const parent = join(dir, "shell-parent.js");
      writeFileSync(
        launcher,
        `require("node:child_process").spawn("/bin/sh",
        ["-c", 'printf "%s" "$$" > "$1"; while [ -d "$2" ]; do printf x >> "$3"; done', "sh",
          ${JSON.stringify(pidFile)}, ${JSON.stringify(dir)}, ${JSON.stringify(output)}],
        {detached:true, stdio:"ignore"}).unref();`,
      );
      writeFileSync(
        parent,
        `const {spawn} = require("node:child_process"); const fs = require("node:fs");
        spawn(process.execPath, [${JSON.stringify(launcher)}], {stdio:"ignore"}).on("exit", () => {
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(output)})) return;
            clearInterval(timer); console.log("ready");
            ${ending === "normal" || ending === "error" ? `process.exit(${ending === "error" ? 3 : 0});` : "setInterval(() => {}, 1000);"}
          }, 5);
        });`,
      );
      const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      const controller = new AbortController();
      try {
        await processScope.run(
          { signal: controller.signal, killGraceMs: 0, children: new Map(), scratchDirs: new Set() },
          async () => {
            const result = await runProcess({
              cmd: [process.execPath, parent],
              cwd: dir,
              env: process.env as Record<string, string>,
              timeoutMs: ending === "timeout" ? 1500 : undefined,
              onStdoutLine: () => {
                if (ending === "cancelled" || ending === "stuck") controller.abort(new Error(ending));
              },
            });
            expect(result.exitCode).toBe(ending === "normal" ? 0 : ending === "error" ? 3 : null);
            expect(result.cancelled).toBe(ending === "cancelled" || ending === "stuck");
            expect(result.timedOut).toBe(ending === "timeout");
            expect(processScope.getStore()?.terminationError).toBeUndefined();
            const writerPid = Number(readFileSync(pidFile, "utf8"));
            expect(writerPid).toBeGreaterThan(0);
            expectProcessStopped(writerPid);
            expect(process.kill(control.pid ?? 0, 0)).toBe(true);
            rmSync(output);
            await Bun.sleep(30);
            expect(existsSync(output)).toBe(false);
          },
        );
      } finally {
        controller.abort();
        control.kill("SIGKILL");
        await new Promise<void>((resolve) => control.once("close", () => resolve()));
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {}
        }
      }
    },
  );

  test.skipIf(process.platform !== "darwin").each(["cwd", "scratch"])(
    "a detached hidden shell ignoring TERM stops writing in %s before cleanup",
    async (location) => {
      const scope = {
        signal: new AbortController().signal,
        killGraceMs: 20,
        children: new Map<ChildProcess, Promise<void>>(),
        scratchDirs: new Set<string>(),
      };
      let scratchPath = "";
      await processScope.run(scope, () =>
        withScratch(dir, async (scratch) => {
          scratchPath = scratch;
          expect(scope.scratchDirs.has(scratch)).toBe(true);
          const writerCwd = location === "scratch" ? scratch : dir;
          const pidFile = join(dir, "transient-pid");
          const output = join(dir, "transient-output");
          const launcher = join(dir, "transient-launcher.js");
          const parent = join(dir, "transient-parent.js");
          writeFileSync(
            launcher,
            `require("node:child_process").spawn("/bin/sh",
      ["-c", 'trap "" TERM; printf "%s" "$$" > "$1"; while [ -d "$2" ]; do printf x >> "$3"; done', "sh",
        ${JSON.stringify(pidFile)}, ${JSON.stringify(writerCwd)}, ${JSON.stringify(output)}],
        {cwd:${JSON.stringify(writerCwd)}, detached:true, stdio:"ignore"}).unref();`,
          );
          writeFileSync(
            parent,
            `const fs = require("node:fs");
      require("node:child_process").spawn(process.execPath, [${JSON.stringify(launcher)}], {stdio:"ignore"})
        .on("exit", () => { setInterval(() => {
          if (fs.existsSync(${JSON.stringify(output)})) { console.log("ready"); process.exit(0); }
        }, 5); });`,
          );
          const kill = process.kill.bind(process);
          const signals: { pid: number; signal: string | number | undefined }[] = [];
          const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
            signals.push({ pid, signal });
            return kill(pid, signal);
          });
          try {
            const result = await runProcess({
              cmd: [process.execPath, parent],
              cwd: dir,
              env: process.env as Record<string, string>,
            });
            expect(result.exitCode).toBe(0);
            const writerPid = Number(readFileSync(pidFile, "utf8"));
            const writerSignals = signals.filter(({ pid }) => pid === writerPid).map(({ signal }) => signal);
            expect(writerSignals[0]).toBe("SIGSTOP");
            expect(writerSignals.slice(1)).toContain("SIGKILL");
            expect(writerSignals.slice(1).every((signal) => signal === "SIGKILL")).toBe(true);
            expectProcessStopped(writerPid);
            expect(readFileSync(output).length).toBeGreaterThan(0);
            // Simulate worktree cleanup immediately after invocation shutdown is confirmed.
            rmSync(output);
            await Bun.sleep(30);
            expect(existsSync(output)).toBe(false);
          } finally {
            killSpy.mockRestore();
            if (existsSync(pidFile)) {
              const pid = Number(readFileSync(pidFile, "utf8"));
              if (pid > 0) {
                try {
                  kill(pid, "SIGKILL");
                } catch {}
              }
            }
          }
        }),
      );
      expect(scope.scratchDirs.size).toBe(0);
      expect(existsSync(scratchPath)).toBe(false);
    },
  );

  test.skipIf(process.platform !== "darwin").each(["hidden", "scrubbed-group", "scrubbed-ancestry"])(
    "claimed descendants remain owned after their marked parent exits (%s)",
    async (kind) => {
      const outside = mkdtempSync(join(tmpdir(), "limitless-outside-"));
      const pidFile = join(dir, "claimed-pid");
      const middlePid = join(dir, "middle-pid");
      const output = join(dir, "claimed-output");
      const middle = join(dir, "middle.js");
      const parent = join(dir, "parent.js");
      const writer = join(dir, "scrubbed.js");
      writeFileSync(
        writer,
        `const fs = require("node:fs"); process.on("SIGTERM", () => {});
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, "x"), 5);`,
      );
      const command =
        kind === "hidden"
          ? `["/bin/sh", ["-c", 'trap "" TERM; echo $$ > "$1"; while :; do printf x >> "$2"; done', "sh", ${JSON.stringify(pidFile)}, ${JSON.stringify(output)}]]`
          : `[process.execPath, [${JSON.stringify(writer)}]]`;
      writeFileSync(
        middle,
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(middlePid)}, String(process.pid));
        const [bin, args] = ${command};
        require("node:child_process").spawn(bin, args, {
          cwd:${JSON.stringify(outside)}, detached:${kind !== "scrubbed-group"}, stdio:"ignore"
          ${kind === "hidden" ? "" : ", env:{PATH:process.env.PATH}"}
        }).unref(); setInterval(() => {}, 1000);`,
      );
      writeFileSync(
        parent,
        `const fs = require("node:fs");
        require("node:child_process").spawn(process.execPath, [${JSON.stringify(middle)}],
          {detached:${kind !== "scrubbed-group"}, stdio:"ignore"}).unref();
        setInterval(() => { if (fs.existsSync(${JSON.stringify(output)})) process.exit(0); }, 5);`,
      );
      const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: dir,
        env: { PATH: process.env.PATH },
        stdio: "ignore",
      });
      const kill = process.kill.bind(process);
      const signals: { pid: number; signal: string | number | undefined }[] = [];
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        signals.push({ pid, signal });
        return kill(pid, signal);
      });
      try {
        const result = await processScope.run(
          {
            signal: new AbortController().signal,
            killGraceMs: 100,
            children: new Map(),
            scratchDirs: new Set(),
          },
          () =>
            runProcess({
              cmd: [process.execPath, parent],
              cwd: dir,
              env: process.env as Record<string, string>,
            }),
        );
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(result.exitCode).toBe(0);
        expect(pid).toBeGreaterThan(0);
        expect(signals.filter((s) => s.pid === pid).map((s) => s.signal)).toContain("SIGSTOP");
        expect(signals.filter((s) => s.pid === pid).map((s) => s.signal)).toContain("SIGKILL");
        expectProcessStopped(pid);
        expect(kill(control.pid ?? 0, 0)).toBe(true);
        expect(signals.some((s) => s.pid === control.pid)).toBe(false);
      } finally {
        killSpy.mockRestore();
        control.kill("SIGKILL");
        if (control.exitCode === null && control.signalCode === null)
          await new Promise<void>((resolve) => control.once("close", () => resolve()));
        for (const file of [pidFile, middlePid]) {
          if (!existsSync(file)) continue;
          const pid = Number(readFileSync(file, "utf8"));
          if (pid > 0) {
            try {
              kill(pid, "SIGKILL");
            } catch {}
          }
        }
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  test.each(["empty", "gone", "claimed"])(
    "an unavailable growth clock does not block cleanup or later scoped commands (%s)",
    async (state) => {
      const writer = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      const closed = new Promise<void>((resolve) => writer.once("close", () => resolve()));
      const signals: (string | number | undefined)[] = [];
      const kill = process.kill.bind(process);
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === writer.pid) signals.push(signal);
        return kill(pid, signal);
      });
      let clockCalls = 0;
      try {
        await processBirthInspection.run(
          {
            now: () => {
              clockCalls++;
              throw new Error("diagnostic clock unavailable");
            },
            read: async () => (state === "gone" || signals.includes("SIGKILL") ? null : "1"),
          },
          () =>
            processInspection.run(
              async (withEnvironment, marker) =>
                `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker} LIMITLESS_INVOCATION=${marker}\n` +
                (state !== "empty" && !signals.includes("SIGKILL")
                  ? `${writer.pid} ${process.getuid?.()} S writer${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`
                  : ""),
              () =>
                processScope.run(
                  {
                    signal: new AbortController().signal,
                    killGraceMs: 0,
                    children: new Map(),
                    scratchDirs: new Set(),
                  },
                  async () => {
                    const result = await runProcess({
                      cmd: ["/bin/sh", "-c", "exit 0"],
                      cwd: dir,
                      env: {},
                    });
                    expect(result.exitCode).toBe(0);
                    expect(signals).toEqual(state === "claimed" ? ["SIGSTOP", "SIGKILL"] : []);
                    expect(processScope.getStore()?.terminationError).toBeUndefined();
                    expect(await sh(["/bin/sh", "-c", "printf continued"], { cwd: dir })).toEqual({
                      stdout: "continued",
                      stderr: "",
                      exitCode: 0,
                      timedOut: false,
                    });
                    expect(clockCalls).toBe(state === "claimed" ? 1 : 0);
                  },
                ),
            ),
        );
      } finally {
        killSpy.mockRestore();
        if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
        await closed;
      }
    },
  );

  test.each([
    { started: 1000, births: ["999", "1000"], growing: false },
    { started: 1000, births: ["999", "1001"], growing: false },
    { started: 1000, births: ["999", "1002"], growing: true },
    { started: 100_500_000, births: ["99:999999", "100:500000"], growing: false },
    { started: 100_500_000, births: ["100:499999", "100:500999"], growing: false },
    { started: 100_500_000, births: ["100:499999", "100:501000"], growing: false },
    { started: 100_500_000, births: ["100:501000", "100:499999"], growing: false },
    { started: 100_500_000, births: ["100:499999", "100:501001"], growing: true },
    { started: 100_500_000, births: ["100:501001", "100:499999"], growing: true },
    { started: 1000, births: ["1002", "999"], growing: true },
    { uptime: "10.03 0.00\n", births: ["1003", "1004"], growing: false },
    { uptime: "10.03 0.00\n", births: ["1004", "1003"], growing: false },
    { uptime: "10.03 0.00\n", births: ["1003", "1005"], growing: true },
    { uptime: "10.03 0.00\n", births: ["1005", "1003"], growing: true },
    { started: null, births: ["999", "1002"], growing: null },
  ])(
    "surviving descendants report birth-time growth, not discovery order (%j)",
    async ({ started: cleanupStart, uptime, births, growing }) => {
      const children = new Map<ChildProcess, Promise<void>>();
      const kill = process.kill.bind(process);
      registerCredential("CLEANUP_COMMAND", "sleep");
      const writers = Array.from({ length: births.length }, () =>
        spawn("/bin/sleep", ["30"], { stdio: "ignore" }),
      );
      let scans = 0;
      let clockCalls = 0;
      let kills = 0;
      const signals: (string | number | undefined)[] = [];
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (
          writers.some((writer) => pid === writer.pid) &&
          (signal === "SIGSTOP" || signal === "SIGTERM" || signal === "SIGKILL")
        ) {
          kills++;
          signals.push(signal);
          return true;
        }
        return kill(pid, signal);
      });
      const elapsed = performance.now.bind(performance);
      const started = elapsed();
      let now = 0;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      try {
        await processBirthInspection.run(
          {
            now: () => {
              clockCalls++;
              if (cleanupStart === null) throw new Error("diagnostic clock unavailable");
              return uptime === undefined ? (cleanupStart ?? 0) : linuxBirthClock(uptime, 100n);
            },
            read: async (pid, name) => {
              name?.("sleep");
              return births[writers.findIndex((writer) => writer.pid === pid)] ?? null;
            },
          },
          () =>
            processInspection.run(
              async (withEnvironment, marker) => {
                if (withEnvironment) {
                  scans++;
                  now += 2500;
                }
                return (
                  writers
                    .slice(0, scans > 1 ? writers.length : 1)
                    .map(
                      (writer) =>
                        `${writer.pid} ${process.getuid?.()} S writer${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}\n`,
                    )
                    .join("") +
                  `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`
                );
              },
              () =>
                processScope.run(
                  {
                    signal: new AbortController().signal,
                    killGraceMs: 0,
                    children,
                    scratchDirs: new Set(),
                  },
                  async () => {
                    const invocation = runProcess({
                      cmd: ["/bin/sh", "-c", "exit 0"],
                      cwd: dir,
                      env: process.env as Record<string, string>,
                    });
                    let stopped = false;
                    void Promise.all(children.values()).then(() => {
                      stopped = true;
                    });
                    await expect(invocation).rejects.toBeInstanceOf(ProcessTerminationError);
                    expect(stopped).toBe(false);
                    const message = processScope.getStore()?.terminationError?.message;
                    expect(message).toContain(`Marked processes still alive: ${writers.length}:`);
                    expect(message).toContain("([redacted])");
                    expect(message).not.toContain("(sleep)");
                    expect(message).toContain(
                      growing === null
                        ? "growth unknown"
                        : growing
                          ? "set kept growing"
                          : "set remained stable",
                    );
                    let cleanup = false;
                    try {
                      await sh(["/bin/sh", "-c", "touch cleanup-started"], { cwd: dir });
                      cleanup = true;
                    } catch (error) {
                      expect(error).toBeInstanceOf(ProcessTerminationError);
                    }
                    expect(cleanup).toBe(false);
                    expect(existsSync(join(dir, "cleanup-started"))).toBe(false);
                  },
                ),
            ),
        );
        expect(kills).toBeGreaterThan(1);
        expect(clockCalls).toBe(1);
        expect(signals.slice(0, writers.length)).toEqual(writers.map(() => "SIGSTOP"));
        expect(signals[writers.length]).toBe("SIGKILL");
        expect(elapsed() - started).toBeLessThan(15_000);
        expect(now).toBe(10_000);
        expect(children.size).toBe(1);
        for (const writer of writers) expect(kill(writer.pid ?? 0, 0)).toBe(true);
      } finally {
        clock.mockRestore();
        killSpy.mockRestore();
        await Promise.all(
          writers.map(async (writer) => {
            if (writer.exitCode !== null || writer.signalCode !== null) return;
            const closed = new Promise<void>((resolve) => writer.once("close", () => resolve()));
            writer.kill("SIGKILL");
            await closed;
          }),
        );
      }
    },
    20_000,
  );

  test.each(["unavailable", "changed", "gone", "killed", "signal-failure"])(
    "identity failures kill only eligible successfully frozen members (%s)",
    async (state) => {
      const writers = Array.from({ length: 3 }, () => spawn("/bin/sleep", ["30"], { stdio: "ignore" }));
      const closed = writers.map(
        (writer) =>
          new Promise<NodeJS.Signals | null>((resolve) =>
            writer.once("close", (_code, signal) => resolve(signal)),
          ),
      );
      const signals = writers.map(() => [] as (string | number | undefined)[]);
      const reads = writers.map(() => 0);
      const kill = process.kill.bind(process);
      const secret = "cleanup-inspection-secret";
      registerCredential("CLEANUP_INSPECTION", secret);
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        const index = writers.findIndex((writer) => writer.pid === pid);
        if (index >= 0) {
          signals[index]?.push(signal);
          // Keep the PID alive after a reported KILL to exercise loss of the frozen exception.
          if (state === "killed" && index === 0 && signal === "SIGKILL") return true;
          if (state === "signal-failure" && index === 0 && signal === "SIGKILL")
            throw new Error("cleanup signal denied");
        }
        return kill(pid, signal);
      });
      try {
        await processBirthInspection.run(
          {
            now: () => 10,
            read: async (pid) => {
              const index = writers.findIndex((writer) => writer.pid === pid);
              if (index < 0) return null;
              reads[index] = (reads[index] ?? 0) + 1;
              const stopped = signals[index]?.includes("SIGSTOP");
              if (index === 0 && stopped && state === "changed") return "2";
              if (index === 0 && stopped && state === "gone") return null;
              if (index === 0 && stopped && state === "killed" && !signals[index]?.includes("SIGKILL"))
                return "1";
              if (stopped || (index === 2 && (reads[index] ?? 0) > (state === "killed" ? 2 : 1)))
                throw new Error(`identity inspection failed for ${pid}: ${secret}`);
              return "1";
            },
          },
          () =>
            processInspection.run(
              async (withEnvironment, marker) =>
                writers
                  .map(
                    (writer) =>
                      `${writer.pid} ${process.getuid?.()} S writer${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}\n`,
                  )
                  .join("") +
                `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
              async () => {
                const error = await runProcess({ cmd: ["/bin/sh", "-c", "exit 0"], cwd: dir, env: {} }).catch(
                  (error: unknown) => error,
                );
                expect(error).toBeInstanceOf(ProcessTerminationError);
                expect(signals[1]).toEqual(["SIGSTOP", "SIGKILL"]);
                expect(String(error)).toContain("identity inspection failed");
                expect(String(error)).toContain("[redacted]");
                expect(String(error)).not.toContain(secret);
                expect(String(error instanceof Error ? error.cause : "")).not.toContain(secret);
                if (state === "signal-failure") expect(String(error)).toContain("cleanup signal denied");
              },
            ),
        );
        expect(signals[0]).toEqual(
          state === "changed" || state === "gone" ? ["SIGSTOP"] : ["SIGSTOP", "SIGKILL"],
        );
        expect(signals[2]).toEqual(state === "killed" ? ["SIGSTOP", "SIGKILL"] : []);
        expect(reads.every((count) => count <= 7)).toBe(true);
        if (state === "unavailable") expect(await closed[0]).toBe("SIGKILL");
        expect(await closed[1]).toBe("SIGKILL");
        if (state === "killed") expect(await closed[2]).toBe("SIGKILL");
      } finally {
        killSpy.mockRestore();
        for (const writer of writers)
          if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
        await Promise.all(closed);
      }
    },
  );

  test("a frozen member is killed when cleanup reaches its deadline", async () => {
    const children = new Map<ChildProcess, Promise<void>>();
    const kill = process.kill.bind(process);
    const writer = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      writer.once("close", (_code, signal) => resolve(signal)),
    );
    const signals: (string | number | undefined)[] = [];
    const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === writer.pid && (signal === "SIGSTOP" || signal === "SIGKILL")) {
        signals.push(signal);
        kill(pid, signal);
        // Report the freeze as lost so the sweep never reaches its own SIGKILL.
        if (signal === "SIGSTOP") throw Object.assign(new Error("lost"), { code: "ESRCH" });
        return true;
      }
      return kill(pid, signal);
    });
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      await processInspection.run(
        async (withEnvironment, marker) => {
          if (withEnvironment) now += 2500;
          return (
            `${writer.pid} ${process.getuid?.()} S writer${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}\n` +
            `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`
          );
        },
        () =>
          processScope.run(
            { signal: new AbortController().signal, killGraceMs: 0, children, scratchDirs: new Set() },
            async () => {
              const invocation = runProcess({
                cmd: ["/bin/sh", "-c", "exit 0"],
                cwd: dir,
                env: process.env as Record<string, string>,
              });
              await expect(invocation).rejects.toBeInstanceOf(ProcessTerminationError);
              expect(processScope.getStore()?.terminationError?.message).toContain(
                "Marked processes still alive: 1:",
              );
            },
          ),
      );
      expect(signals[0]).toBe("SIGSTOP");
      expect(signals.at(-1)).toBe("SIGKILL");
      expect(signals.filter((signal) => signal === "SIGKILL")).toHaveLength(1);
      expect(await closed).toBe("SIGKILL");
    } finally {
      clock.mockRestore();
      killSpy.mockRestore();
      if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
      await closed;
    }
  }, 20_000);

  test.each(["stdout", "stderr"])("runner reports only %s as truncated", async (stream) => {
    const res = await runProcess({
      cmd: [
        process.execPath,
        "-e",
        `process.${stream}.write('x'.repeat(200)); process.${stream === "stdout" ? "stderr" : "stdout"}.write('short diagnostic')`,
      ],
      cwd: dir,
      env: process.env as Record<string, string>,
      tailLimit: 100,
    });
    expect(res.truncated).toBe(true);
    expect(res.stdoutTruncated).toBe(stream === "stdout");
    expect(res.stderrTruncated).toBe(stream === "stderr");
    expect(stream === "stdout" ? res.stderr : res.stdout).toBe("short diagnostic");
  });

  test("sh refuses to return truncated output", async () => {
    const res = await sh(["/bin/sh", "-c", "head -c 70000 /dev/zero | tr '\\0' a"], { cwd: dir });
    expect(res.stdout.length).toBe(70_000);
  });
});

describe("repos", () => {
  test("two local repos with the same basename get distinct slugs", async () => {
    const store = new Store(join(dir, "db.sqlite"));
    for (const p of ["a/service", "b/service"]) {
      mkdirSync(join(dir, p), { recursive: true });
      await sh(["git", "init", "-q"], { cwd: join(dir, p) });
    }
    const a = await resolveRepo(store, join(dir, "a/service"));
    const b = await resolveRepo(store, join(dir, "b/service"));
    expect(a.id).not.toBe(b.id);
    expect(b.localPath).toBe(join(dir, "b/service"));
    expect((await resolveRepo(store, join(dir, "b/service"))).id).toBe(b.id);
    store.close();
  });

  test("name-status keeps both sides of a rename", () => {
    expect(parseNameStatus("R100\tprotected/x.test.ts\tsrc/disabled.txt\nM\ta.ts\n")).toEqual([
      { status: "R100", path: "src/disabled.txt", from: "protected/x.test.ts" },
      { status: "M", path: "a.ts" },
    ]);
  });
});

describe("audit hardening", () => {
  const diff = (files: ReturnType<typeof parseNameStatus>, patch = "") => ({
    patch,
    files,
    stat: "",
    added: 0,
    removed: 0,
  });

  test("renaming a protected file or moving a test out of the runner's reach is blocked", () => {
    const f = auditDiff(diff(parseNameStatus("R100\tprotected/x.test.ts\tsrc/disabled.txt")), {
      taskClass: "feature",
      protectedPaths: ["protected/**"],
    });
    const rules = f.map((x) => `${x.rule}:${x.severity}`);
    expect(rules).toContain("protected-path:block");
    expect(rules).toContain("test-moved-out:block");
  });

  test.each([
    [
      "changing",
      { test: "true", lint: "biome check ." },
      ['Changed the "test" script that a factory check runs ("bun test" → "true").'],
    ],
    [
      "removing",
      {},
      [
        'Removed the "test" script that a factory check runs.',
        'Removed the "lint" script that a factory check runs.',
      ],
    ],
  ] as [string, Record<string, string>, string[]][])(
    "%s a script a gate runs is blocked",
    (_kind, after, details) => {
      const f = auditDiff(diff([{ status: "M", path: "package.json" }]), {
        taskClass: "bugfix",
        protectedPaths: [],
        gateScripts: { before: { test: "bun test", lint: "biome check ." }, after },
      });
      expect(f).toEqual(
        details.map((detail) => ({
          rule: "gate-script-changed",
          severity: "block",
          file: "package.json",
          detail,
        })),
      );
    },
  );

  test("skip markers inside string literals are not flagged", () => {
    const patch = [
      "diff --git a/t/a.test.ts b/t/a.test.ts",
      "+++ b/t/a.test.ts",
      `+  const src = "it.skip('x', () => {})";`,
    ].join("\n");
    const f = auditDiff(diff([{ status: "M", path: "t/a.test.ts" }], patch), {
      taskClass: "test",
      protectedPaths: [],
    });
    expect(f.find((x) => x.rule === "test-skipped")).toBeUndefined();
  });

  test("gate script names come from the gate commands", () => {
    const names = gateScriptNames({
      setup: ["bun install --frozen-lockfile"],
      checks: [
        { name: "lint", run: "bun run lint" },
        { name: "t", run: "npm test" },
        { name: "b", run: "bun test" },
      ],
      source: "detected",
      protectedPaths: [],
    });
    expect(names.sort()).toEqual(["lint", "test"]);
    expect(pickScripts(JSON.stringify({ scripts: { lint: "biome", other: "x" } }), ["lint", "test"])).toEqual(
      {
        lint: "biome",
      },
    );
  });

  test("setup failing after the change blocks, even if it also failed before", () => {
    const r = (name: string, ok: boolean) => ({
      name,
      command: name,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 1,
      output: "",
    });
    const cmp = compareGates(
      { setupOk: false, setup: [r("setup", false)], checks: [r("test", true)] },
      { setupOk: false, setup: [r("setup", false)], checks: [] },
    );
    expect(cmp.every((c) => c.blocking)).toBe(true);
    expect(cmp.map((c) => c.verdict)).toEqual(["regressed", "not_run"]);
  });
});

describe("provider tracker hardening", () => {
  test("a cancelled waiter does not strand the next one", async () => {
    const store = new Store(join(dir, "db.sqlite"));
    const tracker = new ProviderTracker(
      [{ id: "p", label: "p", harness: "fake", billing: "free", maxConcurrent: 1 }],
      store,
      reserves,
      {},
    );
    const release = await tracker.acquire("p", new AbortController().signal);
    const cancelled = new AbortController();
    const first = tracker.acquire("p", cancelled.signal).catch(() => "cancelled");
    let secondGot = false;
    const second = tracker.acquire("p", new AbortController().signal).then((r) => {
      secondGot = true;
      return r;
    });
    cancelled.abort();
    expect(await first).toBe("cancelled");
    release();
    const release2 = await second;
    expect(secondGot).toBe(true);
    release2();
    store.close();
  });

  test("a zero budget means the provider is never used", () => {
    const store = new Store(join(dir, "db.sqlite"));
    const tracker = new ProviderTracker(
      [{ id: "or", label: "or", harness: "claude", billing: "metered", maxConcurrent: 1 }],
      store,
      reserves,
      {},
      { or: 0 },
    );
    expect(tracker.unavailableReason("or")).toBe("at reserve limit");
    store.close();
  });
});

describe("HTTP API", () => {
  test("refuses cross-origin and non-JSON mutations", async () => {
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg"), port: 0 });
    const factory = new Factory(cfg, {
      confinement: fakeConfinement,
      harnesses: { fake: fakeHarness(() => ({})) },
    });
    const server = await startHttp(factory);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const evil = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ repo: "x/y", prompt: "rm -rf" }),
      });
      expect(evil.status).toBe(403);
      const textPlain = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ repo: "x/y", prompt: "p" }),
      });
      expect(textPlain.status).toBe(415);
      const tunnel = await fetch(`${base}/api/runs`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
      expect(tunnel.status).toBe(403);
      const ok = await fetch(`${base}/api/runs`);
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
      factory.store.close();
    }
  });
});

describe("pipeline hardening", () => {
  async function setupRepo(files: Record<string, string>): Promise<string> {
    const repo = join(dir, "target");
    mkdirSync(repo);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, p), c);
    await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    return repo;
  }

  const providers = [
    { id: "a", label: "a", harness: "fake" as const, billing: "subscription" as const, maxConcurrent: 2 },
    { id: "b", label: "b", harness: "fake" as const, billing: "subscription" as const, maxConcurrent: 2 },
  ];
  const models = [
    {
      id: "a/m",
      provider: "a",
      model: "a",
      vendor: "anthropic" as const,
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: [],
      tier: 4 as const,
      price: { input: 0, output: 0 },
    },
    {
      id: "b/m",
      provider: "b",
      model: "b",
      vendor: "openai" as const,
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: [],
      tier: 4 as const,
      price: { input: 0, output: 0 },
    },
  ];
  const everyone = { default: ["a/m", "b/m"] };
  const policy = {
    triage: everyone,
    spec: everyone,
    holdout: everyone,
    implement: everyone,
    review: everyone,
    verify: everyone,
  } as never;

  const role = (prompt: string) =>
    prompt.startsWith("Classify")
      ? "triage"
      : prompt.startsWith("Write the specification")
        ? "spec"
        : prompt.startsWith("Write holdout checks")
          ? "holdout"
          : prompt.startsWith("You are an adversarial")
            ? "review"
            : prompt.startsWith("You are the acceptance verifier")
              ? "verify"
              : "implement";

  async function waitDone(f: Factory, id: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const s = f.store.getRun(id)?.status as string;
      if (["succeeded", "failed", "needs_human", "cancelled"].includes(s)) return s;
      if (Date.now() > deadline) throw new Error(`timeout (${s})`);
      await Bun.sleep(25);
    }
  }

  test("a fake-harness round continues only after freezing and reaping a forking leftover", () =>
    processInspection.run(
      async (_environment, marker) =>
        `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
      async () => {
        const repo = await setupRepo({ "a.txt": "a\n" });
        const forks = join(dir, "forks");
        const writerPid = join(dir, "forker-pid");
        const release = join(dir, "release-forker");
        const script = `trap '' TERM; echo $$ > "$1"; i=0; while [ $i -lt 100 ]; do sleep 0.05 & p=$!; echo "$p" >> "$2"; wait "$p"; i=$((i+1)); done`;
        const launcher = `
      const {spawn}=require('node:child_process'), fs=require('node:fs');
      spawn('/bin/sh', ['-c', ${JSON.stringify(script)}, 'sh', ${JSON.stringify(writerPid)}, ${JSON.stringify(forks)}], {stdio:'ignore'}).unref();
      let ready=false;
      setInterval(()=>{
        if(!ready && fs.existsSync(${JSON.stringify(forks)}) && fs.readFileSync(${JSON.stringify(forks)},'utf8').trim().split('\\n').length>=2) {
          ready=true; console.log(fs.readFileSync(${JSON.stringify(writerPid)},'utf8').trim());
        }
        if(fs.existsSync(${JSON.stringify(release)})) process.exit(0);
      }, 5);
    `;
        const signals: { pid: number; signal: string | number | undefined }[] = [];
        const kill = process.kill.bind(process);
        const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
          signals.push({ pid, signal });
          return kill(pid, signal);
        });
        let continued = false;
        let pid: number | undefined;
        let birth: string | null = null;
        const f = new Factory(loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") }), {
          confinement: fakeConfinement,
          providers,
          models,
          policy,
          harnesses: {
            fake: fakeHarness(async (spec) => {
              if (role(spec.prompt) === "triage")
                return {
                  structured: {
                    title: "t",
                    task_class: "feature",
                    complexity: "small",
                    risk: "low",
                    ambiguity: "low",
                    blocking_questions: [],
                    summary: "s",
                    suggested_profile: "quick",
                  },
                };
              if (role(spec.prompt) === "implement") {
                let cleanupStarted = 0;
                const result = await processInspection.exit(() =>
                  runProcess({
                    cmd: [process.execPath, "-e", launcher],
                    cwd: spec.cwd,
                    env: agentEnv(),
                    timeoutMs: 5000,
                    onStdoutLine: async (line) => {
                      pid = Number(line);
                      birth = await processBirth(pid);
                      cleanupStarted = performance.now();
                      writeFileSync(release, "");
                    },
                  }),
                );
                expect(result.timedOut).toBe(false);
                const forker = Number(readFileSync(writerPid, "utf8"));
                expect(readFileSync(forks, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
                expect(signals.filter((s) => s.pid === forker).map((s) => s.signal)).toEqual([
                  "SIGSTOP",
                  "SIGKILL",
                ]);
                expect(await processBirth(forker)).toBeNull();
                expect(performance.now() - cleanupStarted).toBeLessThan(10_100);
                return { files: { "a.txt": "changed\n" } };
              }
              continued = true;
              expect(await processBirth(Number(readFileSync(writerPid, "utf8")))).toBeNull();
              return {
                structured: {
                  verdict: "approve",
                  summary: "Checked the changed file and confirmed invocation cleanup completed",
                  findings: [],
                },
              };
            }),
          },
        });
        f.start();
        try {
          const run = await f.createRun({ repo, prompt: "change a" });
          const status = await waitDone(f, run.id);
          expect({ status, error: f.store.getRun(run.id)?.error }).toMatchObject({ status: "succeeded" });
          expect(continued).toBe(true);
          expect(
            f.store
              .listStages(run.id)
              .some((s) => s.name === "gates" && s.round === 0 && s.status === "succeeded"),
          ).toBe(true);
        } finally {
          await f.stop();
          f.store.close();
          killSpy.mockRestore();
          if (pid !== undefined && birth !== null && (await processBirth(pid)) === birth)
            kill(pid, "SIGKILL");
        }
      },
    ));

  test.each([false, true])("an unconfirmed termination blocks cleanup and resume (shutdown=%s)", (shutdown) =>
    processInspection.run(
      async (_withEnvironment, marker) =>
        `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
      async () => {
        const repo = await setupRepo({ "a.txt": "a\n" });
        let implementCalls = 0;
        const controller = new AbortController();
        const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
        const f = new Factory(cfg, {
          confinement: fakeConfinement,
          providers,
          models,
          policy,
          harnesses: {
            fake: fakeHarness(async (spec) => {
              if (role(spec.prompt) === "triage")
                return {
                  structured: {
                    title: "t",
                    task_class: "feature",
                    complexity: "small",
                    risk: "low",
                    ambiguity: "low",
                    blocking_questions: [],
                    summary: "s",
                    suggested_profile: "quick",
                  },
                };
              implementCalls++;
              return processInspection.run(
                async () => {
                  throw new Error("cannot inspect marked descendant");
                },
                async () => {
                  try {
                    await runProcess({
                      cmd: ["/bin/sh", "-c", "exit 0"],
                      cwd: spec.cwd,
                      env: process.env as Record<string, string>,
                    });
                  } finally {
                    if (shutdown) controller.abort(new Error("shutdown"));
                  }
                  return {};
                },
              );
            }),
          },
        });
        if (!shutdown) f.start();
        try {
          const run = await f.createRun({ repo, prompt: "change a" });
          if (shutdown) {
            expect(await executeRun(f.deps, run.id, controller.signal)).toBe("queued");
            expect(f.store.getRunState<{ needsHumanReason: string }>(run.id)?.needsHumanReason).toContain(
              "cannot inspect marked descendant",
            );
            expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("needs_human");
          }
          expect(await waitDone(f, run.id)).toBe("needs_human");
          expect(implementCalls).toBe(1);
          expect(f.store.getRun(run.id)?.error).toContain("Invocation termination could not be confirmed");
          expect(f.store.getRunState<{ feedback: string }>(run.id)?.feedback).toContain(
            "cannot inspect marked descendant",
          );
          const invocation = f.store.listInvocations(run.id).find((i) => i.role === "implement");
          if (shutdown) expect(invocation?.status).toBe("cancelled");
          else
            expect(invocation).toMatchObject({
              status: "error",
              error: expect.stringContaining("cannot inspect marked descendant"),
            });
          expect(f.store.listStages(run.id).find((s) => s.name === "implement")).toMatchObject({
            status: shutdown ? "cancelled" : "failed",
            round: 0,
          });
          expect(f.store.listStages(run.id).some((s) => s.name === "gates" && s.round === 0)).toBe(false);
        } finally {
          await f.stop();
          f.store.close();
        }
      },
    ),
  );

  test("a verifier that skips criteria cannot pass, and an 'approve' with a blocker is a rejection", async () => {
    const repo = await setupRepo({ "a.txt": "a\n" });
    let verifies = 0;
    let reviews = 0;
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
    const f = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const r = role(s.prompt);
          if (r === "triage")
            return {
              structured: {
                title: "t",
                task_class: "feature",
                complexity: "small",
                risk: "low",
                ambiguity: "low",
                blocking_questions: [],
                summary: "s",
                suggested_profile: "standard",
              },
            };
          if (r === "spec")
            return {
              structured: {
                summary: "s",
                assumptions: [],
                requirements: [],
                acceptance_criteria: [
                  { id: "AC-1", criterion: "one", how_to_verify: "x" },
                  { id: "AC-2", criterion: "two", how_to_verify: "y" },
                ],
                out_of_scope: [],
                blocking_questions: [],
              },
            };
          if (r === "holdout")
            return {
              structured: {
                scenarios: [
                  { id: "H-1", description: "case 1", steps: "cat a.txt", expected: "a", edge_case: false },
                  {
                    id: "H-2",
                    description: "case 2",
                    steps: "test -s a.txt",
                    expected: "exit zero",
                    edge_case: true,
                  },
                  {
                    id: "H-3",
                    description: "case 3",
                    steps: "test ! -e b.txt",
                    expected: "exit zero",
                    edge_case: true,
                  },
                ],
              },
            };
          if (r === "review") {
            reviews++;
            return {
              structured: {
                verdict: "approve",
                summary: "fine: checked the diff against every requirement",
                findings:
                  reviews === 1
                    ? [
                        {
                          severity: "blocker",
                          security: false,
                          ...findingEvidence,
                          file: "a.txt",
                          line: 1,
                          title: "broken",
                          detail: "d",
                          suggestion: "s",
                        },
                      ]
                    : [],
              },
            };
          }
          if (r === "verify") {
            verifies++;
            // Incomplete verification overlaps the rejected review, then fails an approved round too.
            return {
              structured:
                verifies <= 2
                  ? {
                      criteria: [{ id: "AC-1", status: "met", evidence: "e", publicSummary: "" }],
                      overall: "pass",
                      notes: "",
                    }
                  : {
                      criteria: [
                        { id: "AC-1", status: "met", evidence: "e", publicSummary: "" },
                        { id: "AC-2", status: "met", evidence: "e", publicSummary: "" },
                        { id: "H-1", status: "met", evidence: "e", publicSummary: "" },
                        { id: "H-2", status: "met", evidence: "e", publicSummary: "" },
                        { id: "H-3", status: "met", evidence: "e", publicSummary: "" },
                      ],
                      overall: "pass",
                      notes: "",
                    },
            };
          }
          return { files: { "a.txt": `a${Math.random()}\n` } };
        }),
      },
    });
    f.start();
    try {
      const run = await f.createRun({ repo, prompt: "change a" });
      expect(await waitDone(f, run.id)).toBe("succeeded");
      expect(reviews).toBe(3); // round 0 rejected (blocker), round 1 approved, round 2 approved
      expect(verifies).toBe(3); // round 0 overlaps rejection, round 1 incomplete → fail, round 2 pass
      const review0 = JSON.parse(f.store.getArtifact(run.id, "review-0.json") as string);
      expect(review0.verdict).toBe("request_changes");
      const verify1 = JSON.parse(f.store.getArtifact(run.id, "verify-1.json") as string);
      expect(verify1.overall).toBe("fail");
      expect(verify1.criteria.find((c: { id: string }) => c.id === "AC-2").status).toBe("unclear");
    } finally {
      await f.stop();
      f.store.close();
    }
  });

  test("weakening the test script is caught even though gates then pass", async () => {
    const repo = await setupRepo({
      "package.json": JSON.stringify({ scripts: { test: "exit 1" } }),
      ".limitless.toml": '[gates]\nchecks = [{ name = "test", run = "npm run test" }]\n',
    });
    let rounds = 0;
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
    const f = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const r = role(s.prompt);
          if (r === "triage")
            return {
              structured: {
                title: "t",
                task_class: "bugfix",
                complexity: "small",
                risk: "low",
                ambiguity: "low",
                blocking_questions: [],
                summary: "s",
                suggested_profile: "quick",
              },
            };
          if (r === "review")
            return {
              structured: {
                verdict: "approve",
                summary: "ok: checked the diff against every requirement",
                findings: [],
              },
            };
          rounds++;
          return { files: { "package.json": JSON.stringify({ scripts: { test: "true" } }) } };
        }),
      },
    });
    f.start();
    try {
      const run = await f.createRun({ repo, prompt: "make the tests pass" });
      expect(await waitDone(f, run.id)).toBe("needs_human");
      const events = f.store.listEvents(run.id, { limit: 5000 });
      expect(events.some((e) => e.type === "audit" && e.message.includes("gate-script-changed"))).toBe(true);
      expect(rounds).toBeGreaterThan(1);
    } finally {
      await f.stop();
      f.store.close();
    }
  });
});

describe("resume after restart", () => {
  test("a restart during review resumes at the checks without re-implementing", async () => {
    const repo = join(dir, "target");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

    const providers = [
      { id: "a", label: "a", harness: "fake" as const, billing: "free" as const, maxConcurrent: 2 },
    ];
    const models = [
      {
        id: "a/m",
        provider: "a",
        model: "a",
        vendor: "anthropic" as const,
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        tier: 4 as const,
        price: { input: 0, output: 0 },
      },
    ];
    const everyone = { default: ["a/m"] };
    const policy = { triage: everyone, implement: everyone, review: everyone } as never;
    let implementCalls = 0;
    let reviewDelay = 30_000;
    const harness = fakeHarness((s) => {
      if (s.prompt.startsWith("Classify"))
        return {
          structured: {
            title: "t",
            task_class: "feature",
            complexity: "small",
            risk: "low",
            ambiguity: "low",
            blocking_questions: [],
            summary: "s",
            suggested_profile: "quick",
          },
        };
      if (s.prompt.startsWith("You are an adversarial"))
        return {
          delayMs: reviewDelay,
          structured: {
            verdict: "approve",
            summary: "ok: checked the diff against every requirement",
            findings: [],
          },
        };
      implementCalls++;
      return { files: { "b.txt": "b\n" } };
    });
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });

    const first = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: { fake: harness },
    });
    first.start();
    const run = await first.createRun({ repo, prompt: "add b" });
    const deadline = Date.now() + 10_000;
    while (first.store.getRun(run.id)?.stage !== "review" && Date.now() < deadline) await Bun.sleep(20);
    first.scheduler.drain();
    expect(first.scheduler.draining).toBe(true);
    await first.stop(); // simulated restart mid-review
    expect(first.store.getRun(run.id)?.status).toBe("queued");
    first.store.close();

    reviewDelay = 0;
    const second = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: { fake: harness },
    });
    expect(second.scheduler.draining).toBe(false);
    // Also cover an abrupt shutdown that left a persisted running status.
    second.store.updateRun(run.id, { status: "running" });
    second.start();
    try {
      const end = Date.now() + 10_000;
      while (second.store.getRun(run.id)?.status !== "succeeded" && Date.now() < end) await Bun.sleep(20);
      expect(second.store.getRun(run.id)?.status).toBe("succeeded");
      expect(implementCalls).toBe(1);
      expect(
        second.store.listEvents(run.id).some((event) => event.message.includes("re-queued to resume")),
      ).toBe(true);
    } finally {
      await second.stop();
      second.store.close();
    }
  });
});

describe("repo cache concurrency", () => {
  test("concurrent runs share one clone of a remote repo", async () => {
    const { ensureCache, fetchBase } = await import("../src/git/repos.ts");
    const origin = join(dir, "origin");
    mkdirSync(origin);
    writeFileSync(join(origin, "a.txt"), "a\n");
    await sh(["git", "init", "-q", "-b", "main"], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: origin });
    const paths = {
      home: dir,
      db: "",
      repos: join(dir, "repos"),
      work: join(dir, "work"),
      runs: "",
      configDir: "",
    };
    const repo = {
      id: "r",
      slug: "o/origin",
      kind: "github" as const,
      url: origin,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr" as const,
      createdAt: 0,
    };
    const caches = await Promise.all([
      ensureCache(paths, repo),
      ensureCache(paths, repo),
      ensureCache(paths, repo),
    ]);
    for (const c of caches) {
      const r = await sh(["git", "rev-parse", "origin/main"], { cwd: c });
      expect(r.stdout.trim()).toHaveLength(40);
    }

    writeFileSync(join(origin, "b.txt"), "b\n");
    await sh(["git", "add", "."], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "advance"], {
      cwd: origin,
    });
    const tip = (await sh(["git", "rev-parse", "HEAD"], { cwd: origin })).stdout.trim();
    const fetched = await Promise.all([
      ...Array.from({ length: 8 }, () => fetchBase(paths, repo, "main")),
      ensureCache(paths, repo),
    ]);
    expect(fetched.slice(0, -1)).toEqual(Array(8).fill(tip));
    expect((await sh(["git", "rev-parse", "origin/main"], { cwd: caches[0] })).stdout.trim()).toBe(tip);
  });
});

test("adding a file under a protected path warns; editing one blocks", () => {
  const f = auditDiff(
    {
      patch: "",
      files: [
        { status: "A", path: "test/fixtures/new.json" },
        { status: "M", path: "test/fixtures/old.json" },
        { status: "M", path: "test/fixtures/a/b.ts" },
        { status: "M", path: "docs/notguide.md" },
        { status: "M", path: "docs/a/guide.md" },
      ],
      stat: "",
      added: 0,
      removed: 0,
    },
    { taskClass: "feature", protectedPaths: ["test/fixtures/**", "docs/**/guide.md"] },
  );
  expect(f.map((x) => `${x.file}:${x.severity}`)).toEqual([
    "test/fixtures/new.json:warn",
    "test/fixtures/old.json:block",
    "test/fixtures/a/b.ts:block",
    "docs/a/guide.md:block",
  ]);
});

test.each(["test/fixtures/**/", "test/fixtures/", "**/"])(
  "directory protected pattern blocks edits: %s",
  (pattern) => {
    const findings = auditDiff(
      {
        patch: "",
        files: [
          { status: "M", path: "test/fixtures/a.json" },
          { status: "M", path: "test/fixturesx/a.json" },
        ],
        stat: "",
        added: 0,
        removed: 0,
      },
      { taskClass: "feature", protectedPaths: [pattern] },
    );
    expect(findings).toHaveLength(pattern === "**/" ? 2 : 1);
    expect(findings[0]).toMatchObject({
      file: "test/fixtures/a.json",
      rule: "protected-path",
      severity: "block",
    });
  },
);

test("review/verify timeouts scale with the size of the change", async () => {
  const { readingTimeout } = await import("../src/pipeline/engine.ts");
  expect(readingTimeout(0)).toBe(20 * 60_000);
  expect(readingTimeout(935)).toBe(40 * 60_000);
  expect(readingTimeout(935, 25)).toBe(45 * 60_000);
  expect(readingTimeout(10_000)).toBe(60 * 60_000);
});
