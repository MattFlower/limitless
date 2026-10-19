import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentEnv, sh } from "../src/util/proc.ts";

const wrapper = resolve("scripts/ci-check.sh");
const linuxTest = test.skipIf(process.platform !== "linux");

// runProcess cleans descendants on exit, which would mask a broken wrapper's cleanup.
async function runWrapper(args: string[], dir: string) {
  const log = join(dir, "output");
  const fd = openSync(log, "w");
  const child = spawn("bash", [wrapper, ...args], {
    env: agentEnv({ CI_CHECK_GRACE: "1s" }),
    stdio: ["ignore", fd, fd],
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    return { exitCode: child.exitCode, stdout: readFileSync(log, "utf8") };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    closeSync(fd);
  }
}

linuxTest("CI timeout preserves success and ordinary failure (GNU timeout on Linux)", async () => {
  for (const status of [0, 7]) {
    const result = await sh(["bash", wrapper, "10s", "bash", "-c", `exit ${status}`], {
      cwd: process.cwd(),
      allowFail: true,
    });
    expect(result.exitCode).toBe(status);
    expect(result.stdout).not.toContain("CI check timed out");
  }
});

function stopped(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function stopFixture(pid: number): void {
  if (pid <= 1 || stopped(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

linuxTest(
  "CI timeout prints the tree before TERM and kills TERM-ignoring children (Linux)",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-check-"));
    const pidFile = join(dir, "pids");
    try {
      const result = await runWrapper(
        [
          "2s",
          "bash",
          "-c",
          `sleep 60 &
         normal=$!
         (trap '' TERM; exec sleep 60) &
         stubborn=$!
         echo "$$ $normal $stubborn" > "$1"
         wait`,
          "fixture",
          pidFile,
        ],
        dir,
      );
      expect(result.exitCode).toBe(137);
      const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(3);
      expect(result.stdout).toContain("runner process tree (PID PPID COMMAND)");
      for (const pid of pids) expect(result.stdout).toMatch(new RegExp(`\\b${pid}\\s+\\d+\\s+`));
      for (const pid of pids.slice(1))
        expect(result.stdout).toMatch(new RegExp(`\\b${pid}\\s+${pids[0]}\\s+`));
      // The wrapper's final group kill may still be being delivered when wait returns.
      for (let attempt = 0; attempt < 100 && pids.some((pid) => !stopped(pid)); attempt++)
        await Bun.sleep(10);
      for (const pid of pids) expect(stopped(pid)).toBe(true);
    } finally {
      // Only PIDs recorded by our own fixture can be signalled if the regression leaves them alive.
      try {
        if (existsSync(pidFile)) {
          for (const pid of readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)) {
            stopFixture(pid);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
  15_000,
);

test("CI file-start markers bypass parallel Bun buffering and are opt-in", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-test-start-")));
  const marker = join(dir, "starts");
  const pidFile = join(dir, "hang.pid");
  const setup = resolve("test/setup.ts");
  try {
    writeFileSync(join(dir, "bunfig.toml"), "");
    writeFileSync(join(dir, "ok.test.ts"), 'import { test } from "bun:test"; test("ok", () => {});');
    writeFileSync(
      join(dir, "hang.test.ts"),
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       test("hang", () => Bun.sleep(60000), 120000);`,
    );
    for (const enabled of [false, true]) {
      writeFileSync(marker, "");
      const env = agentEnv();
      delete env.LIMITLESS_CI_TEST_LOG;
      if (enabled) env.LIMITLESS_CI_TEST_LOG = marker;
      // runProcess owns cancellation of this deliberately hanging synthetic suite.
      const result = await sh([process.execPath, "test", "--parallel=2", "--preload", setup, dir], {
        cwd: dir,
        env,
        allowFail: true,
        timeoutMs: 1000,
      });
      expect(result.exitCode).not.toBe(0);
      const starts = readFileSync(marker, "utf8");
      if (enabled) {
        expect(starts).toContain(`[test:start] ${join(dir, "hang.test.ts")}`);
        expect(starts).toContain(`[test:start] ${join(dir, "ok.test.ts")}`);
      } else {
        expect(starts).toBe("");
        expect(result.stdout + result.stderr).not.toContain("[test:start]");
      }
    }
    if (process.platform === "linux") {
      const stderr = join(dir, "stderr");
      // sh() captures stderr with a socket, which Linux cannot reopen via /proc (ENXIO).
      // Give the step shell a real log fd so the preload reaches the hang, as it does in CI.
      const result = await sh(
        [
          "bash",
          "-c",
          'exec 2>>"$1"; shift; export LIMITLESS_CI_TEST_LOG="/proc/$$/fd/2"; bash "$@"',
          "fixture",
          stderr,
          wrapper,
          "1s",
          process.execPath,
          "test",
          "--parallel=2",
          "--preload",
          setup,
          dir,
        ],
        { cwd: dir, env: agentEnv({ CI_CHECK_GRACE: "1s" }), allowFail: true, timeoutMs: 10_000 },
      );
      const diagnostics = readFileSync(stderr, "utf8");
      expect(result.exitCode, result.stdout + result.stderr + diagnostics).toBe(137);
      expect(diagnostics).toContain(`[test:start] ${join(dir, "hang.test.ts")}`);
      expect(diagnostics).toContain(`[test:start] ${join(dir, "ok.test.ts")}`);
      expect(result.stdout).toContain("runner process tree (PID PPID COMMAND)");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(result.stdout).toMatch(new RegExp(`\\b${pid}\\s+\\d+\\s+`));
      expect(stopped(pid)).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
