import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { DeployClient, DeployClock } from "../src/cli/deploy-wait.ts";
import { restart } from "../src/cli/service.ts";
import type { HealthResponse } from "../src/core/types.ts";
import { sh } from "../src/util/proc.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "limitless-restart-"));
  dirs.push(dir);
  const agentsDir = join(dir, "LaunchAgents");
  mkdirSync(agentsDir);
  mkdirSync(join(dir, "src", "cli"), { recursive: true });
  writeFileSync(join(dir, "src", "cli", "main.ts"), "");
  mkdirSync(join(dir, ".git"));
  writeFileSync(
    join(agentsDir, "installed.plist"),
    JSON.stringify({
      Label: "custom.daemon",
      ProgramArguments: ["bun", join(dir, "src", "cli", "main.ts"), "serve"],
    }),
  );
  const calls: string[] = [],
    logs: string[] = [],
    sleeps: number[] = [];
  let time = 0,
    draining = false,
    restartedAt: number | undefined;
  const clock: DeployClock = {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    timeout: () => () => {},
  };
  const client: DeployClient = {
    admin: async (action) => {
      calls.push(action);
      draining = action === "drain";
      return { draining, active: [] };
    },
    health: async () => {
      calls.push("health");
      return {
        ok: true,
        sha: "release",
        startedAt: restartedAt === undefined ? 1 : 2,
        uptimeMs: restartedAt === undefined ? 100_000 + time : time - restartedAt,
        draining,
        active: restartedAt === undefined && time < 10_000 ? ["active-run"] : [],
      };
    },
    run: async (id) => {
      calls.push(`run ${id}`);
      return { stage: "review" };
    },
  };
  const command: typeof sh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "launchctl" && args[1] === "kickstart") {
      restartedAt = time;
      draining = false;
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: args[0] === "plutil" ? readFileSync(args.at(-1) ?? "", "utf8") : "release subject",
    };
  };
  return {
    calls,
    logs,
    sleeps,
    clock,
    client,
    opts: {
      agentsDir,
      releaseDir: dir,
      lockPath: join(dir, "deploy.lock"),
      client,
      clock,
      command,
      log: (message: string) => logs.push(message),
    },
  };
}

const kickstart = `launchctl kickstart -k gui/${userInfo().uid}/custom.daemon`;

for (const now of [false, true]) {
  test(`restart drains and verifies a new boot on the installed SHA (now: ${now})`, async () => {
    const f = setup();
    const health = f.client.health;
    let stale = true;
    f.client.health = async (signal) => {
      const state = await health(signal);
      if (f.calls.includes(kickstart) && stale) {
        stale = false;
        return { ...state, startedAt: 1, draining: false };
      }
      return state;
    };
    await restart(7400, { ...f.opts, now });
    expect(f.calls.filter((call) => !call.startsWith("plutil"))).toEqual([
      "health",
      "drain",
      "health",
      ...(!now ? ["run active-run", "health", "run active-run", "health"] : []),
      kickstart,
      "health",
      "health",
    ]);
    expect(f.sleeps).toEqual(now ? [1000] : [5000, 5000, 1000]);
    expect(f.logs.at(-1)).toBe("daemon after: release; new boot healthy");
    expect(existsSync(f.opts.lockPath)).toBe(false);
  });
}

test("restart uses deploy's default drain budget and honors --max-wait", async () => {
  for (const maxWaitMs of [undefined, 2000]) {
    const f = setup();
    const health = f.client.health;
    f.client.health = async (signal) => {
      const state = await health(signal);
      return f.calls.includes(kickstart) ? state : { ...state, active: ["active-run"] };
    };
    await restart(7400, { ...f.opts, maxWaitMs });
    const seconds = maxWaitMs === undefined ? 2700 : 2;
    expect(f.logs).toContain(
      `Drain timeout after ${seconds}s; restarting with active runs: active-run (review)`,
    );
    expect(f.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(seconds * 1000);
  }
});

test("restart refuses a held deploy lock before doing any work", async () => {
  const f = setup();
  writeFileSync(f.opts.lockPath, `${process.pid}\n`);
  await expect(restart(7400, f.opts)).rejects.toThrow("deploy already running");
  expect(f.calls).toEqual([]);
  expect(readFileSync(f.opts.lockPath, "utf8")).toBe(`${process.pid}\n`);
});

test("restart refuses without an installed daemon agent", async () => {
  const f = setup();
  rmSync(join(f.opts.agentsDir, "installed.plist"));
  await expect(restart(7400, f.opts)).rejects.toThrow(
    "no installed daemon agent; run limitless service install",
  );
  expect(f.calls).toEqual([]);
  expect(existsSync(f.opts.lockPath)).toBe(false);
});

test("interrupted restart before kickstart resumes scheduling and releases signal handlers", async () => {
  const f = setup();
  const listeners = process.listenerCount("SIGINT");
  const admin = f.client.admin;
  f.client.admin = async (action, signal) => {
    const state = await admin(action, signal);
    if (action === "drain") {
      process.emit("SIGINT");
      return new Promise(() => {});
    }
    return state;
  };
  await expect(restart(7400, f.opts)).rejects.toThrow("restart interrupted by SIGINT");
  expect(f.calls).toContain("resume");
  expect(f.calls).not.toContain(kickstart);
  expect(process.listenerCount("SIGINT")).toBe(listeners);
  expect(existsSync(f.opts.lockPath)).toBe(false);
});

for (const resumeFails of [false, true]) {
  test(`failed kickstart recovers the draining scheduler (resume fails: ${resumeFails})`, async () => {
    const f = setup();
    const command = f.opts.command;
    f.opts.command = async (args, opts) => {
      if (args[0] === "launchctl" && args[1] === "kickstart") {
        f.calls.push(args.join(" "));
        throw new Error("kickstart failed: service not found");
      }
      return command(args, opts);
    };
    if (resumeFails) {
      const admin = f.client.admin;
      f.client.admin = async (action, signal) => {
        if (action === "resume") {
          f.calls.push(action);
          throw new Error("resume denied");
        }
        return admin(action, signal);
      };
    }
    await expect(restart(7400, { ...f.opts, now: true })).rejects.toThrow(
      "kickstart failed: service not found",
    );
    expect(f.calls.slice(f.calls.indexOf(kickstart), f.calls.indexOf(kickstart) + 3)).toEqual([
      kickstart,
      "health",
      "resume",
    ]);
    if (resumeFails) {
      expect(f.logs.join("\n")).toContain("resume scheduler: Error: resume denied");
      expect(f.logs.join("\n")).toContain("daemon is left DRAINING");
      expect(f.logs.join("\n")).toContain("Recover with: curl");
      expect(f.logs.join("\n")).toContain("http://127.0.0.1:7400/api/admin/resume");
    } else {
      expect((await f.client.health(new AbortController().signal)).draining).toBe(false);
    }
    expect(f.logs).toContain("custom.daemon: loaded");
    expect(existsSync(f.opts.lockPath)).toBe(false);
  });
}

for (const failure of ["old boot", "wrong SHA", "missing SHA", "unreachable"]) {
  test(`restart health timeout reports service status without rollback: ${failure}`, async () => {
    const f = setup();
    const health = f.client.health;
    f.client.health = async (signal) => {
      const state = await health(signal);
      if (!f.calls.includes(kickstart)) return state;
      if (failure === "unreachable") throw new Error("offline");
      return {
        ...state,
        draining: failure === "old boot" ? !f.calls.includes("resume") : state.draining,
        startedAt: failure === "old boot" ? 1 : state.startedAt,
        sha: failure === "wrong SHA" ? "other" : failure === "missing SHA" ? "unknown" : state.sha,
      };
    };
    await expect(restart(7400, { ...f.opts, now: true })).rejects.toThrow("new version is unhealthy");
    expect(f.calls.filter((call) => call === kickstart)).toHaveLength(1);
    expect(f.calls).toContain(`launchctl print gui/${userInfo().uid}/custom.daemon`);
    expect(f.calls).toContain("git log -1 --format=%h %s");
    expect(f.calls.filter((call) => call === "resume")).toHaveLength(failure === "old boot" ? 1 : 0);
    expect(f.logs).toContain("custom.daemon: loaded");
    expect(f.logs).toContain("release: release subject");
    expect(f.logs).toContain(`health: ${failure === "unreachable" ? "unreachable" : "ok"}`);
    expect(f.clock.now()).toBe(45_000);
    expect(existsSync(f.opts.lockPath)).toBe(false);
  });
}

test("older daemon uptime proves a new process started even after a long drain", async () => {
  const f = setup();
  const health = f.client.health;
  let stale = true;
  f.client.health = async (signal): Promise<HealthResponse> => {
    const { startedAt: _startedAt, ...state } = await health(signal);
    if (f.calls.includes(kickstart) && stale) {
      stale = false;
      return { ...state, uptimeMs: 100_000 + f.clock.now() };
    }
    return state;
  };
  await restart(7400, f.opts);
  expect(stale).toBe(false);
  expect(f.sleeps).toEqual([5000, 5000, 1000]);
  expect(f.logs.at(-1)).toBe("daemon after: release; new boot healthy");
});

test("restart refuses to claim SHA verification when the running boot SHA is unknown", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({ ...(await health(signal)), sha: "unknown" });
  await expect(restart(7400, f.opts)).rejects.toThrow("daemon boot SHA is unknown");
  expect(f.calls).not.toContain("drain");
  expect(f.calls).not.toContain(kickstart);
});

test("restart CLI dispatches wait options and refuses invalid arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-restart-cli-"));
  dirs.push(dir);
  const preload = join(dir, "preload.ts");
  writeFileSync(
    preload,
    `import { mock } from "bun:test";
    mock.module(${JSON.stringify(join(import.meta.dir, "../src/cli/service.ts"))}, () => ({
      restart: async (port, opts) => console.log(JSON.stringify({ port, ...opts }))
    }));`,
  );
  const command = async (args: string[]) => {
    const result = await sh([process.execPath, "--preload", preload, "src/cli/main.ts", "restart", ...args], {
      allowFail: true,
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LIMITLESS_PORT: "8765", LIMITLESS_CONFIG_DIR: dir, LIMITLESS_HOME: dir },
    });
    return result;
  };
  for (const [args, now, maxWaitMs] of [
    [[], false, 2_700_000],
    [["--now", "--max-wait", "12"], true, 12_000],
  ] as const) {
    const result = await command([...args]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ port: 8765, now, maxWaitMs });
  }
  for (const args of [["extra"], ["--now", "--max-wait=-1"]]) {
    const result = await command(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(args[0] === "extra" ? "usage: limitless restart" : "--max-wait");
  }
});
