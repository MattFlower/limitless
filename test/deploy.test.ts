import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bounded,
  DEFAULT_MAX_WAIT_MS,
  type DeployClient,
  type DeployClock,
  DrainUnsupportedError,
  parseMaxWait,
} from "../src/cli/deploy-wait.ts";
import { deploy } from "../src/cli/service.ts";
import type { HealthResponse } from "../src/core/types.ts";
import type { sh } from "../src/util/proc.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "limitless-deploy-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"));
  const calls: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  let time = 0;
  let selected = "previous";
  let draining = false;
  let restarted = false;
  const pending = new Set<() => void>();
  const clock: DeployClock = {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    timeout(fn, ms) {
      timeouts.push(ms);
      pending.add(fn);
      return () => {
        pending.delete(fn);
      };
    },
  };
  const command: typeof sh = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    if (args[1] === "checkout") selected = args[4] ?? selected;
    return {
      stdout: args[1] === "rev-parse" ? (args[2] === "HEAD" ? selected : "next") : "",
      stderr: "",
      exitCode: 0,
    };
  };
  const client: DeployClient = {
    async admin(action) {
      calls.push(action);
      draining = action === "drain";
      return { draining, active: [] };
    },
    async health() {
      calls.push("health");
      return { ok: true, uptimeMs: 1, draining, active: restarted || time >= 10_000 ? [] : ["run-a"] };
    },
    async run(id) {
      calls.push(`run ${id}`);
      return { stage: time ? "review" : "implement" };
    },
  };
  const restart = async () => {
    calls.push("restart");
    restarted = true;
    draining = false;
  };
  return {
    calls,
    logs,
    sleeps,
    timeouts,
    pending,
    client,
    clock,
    selected: () => selected,
    opts: { releaseDir: dir, command, client, clock, restart, log: (s: string) => logs.push(s) },
  };
}

test("deploy gates, drains, refreshes stages and restarts once after completion", async () => {
  const f = setup();
  await deploy(7400, "feature", true, f.opts);
  expect(f.calls.slice(0, 8)).toEqual([
    "git rev-parse HEAD",
    "git fetch origin --prune",
    "git rev-parse feature",
    "git checkout -q --detach next",
    "bun install --frozen-lockfile",
    "bun run check",
    "bun run smoke",
    "drain",
  ]);
  expect(f.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(f.sleeps).toEqual([5000, 5000]);
  expect(f.logs.join("\n")).toContain("run-a (implement)");
  expect(f.logs.join("\n")).toContain("run-a (review)");
  expect(f.logs.join("\n")).toContain("Drain complete");
  expect(f.calls.slice(-3)).toEqual(["health", "restart", "health"]);
});

test("initially empty and unchanged ref do not wait", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({ ...(await health(signal)), active: [] });
  await deploy(7400, "feature", false, f.opts);
  expect(f.sleeps).toEqual([]);
  f.calls.length = 0;
  await deploy(7400, "feature", false, f.opts);
  expect(f.calls).toEqual(["git rev-parse HEAD", "git fetch origin --prune", "git rev-parse feature"]);
  f.calls.length = 0;
  await deploy(7400, "feature", true, f.opts);
  expect(f.calls.slice(-2)).toEqual(["bun run check", "bun run smoke"]);
  expect(f.calls).not.toContain("drain");
});

test("default and configured deadlines expire without excessive sleeps", async () => {
  expect(parseMaxWait(undefined)).toBe(2700000);
  expect(DEFAULT_MAX_WAIT_MS).toBe(2700000);
  for (const maxWaitMs of [undefined, 1200, 0]) {
    const f = setup();
    const health = f.client.health;
    f.client.health = async (signal) => ({ ...(await health(signal)), active: ["held"] });
    await deploy(7400, "feature", false, { ...f.opts, ...(maxWaitMs === undefined ? {} : { maxWaitMs }) });
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBe(maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    expect(f.logs.join("\n")).toContain("timeout");
    expect(f.logs.join("\n")).toContain("held");
  }
});

test("--now retains gates and drain without sleeps; disappearing details are explicit", async () => {
  const f = setup();
  await deploy(7400, "feature", true, { ...f.opts, now: true, maxWaitMs: 3000 });
  expect(f.sleeps).toEqual([]);
  expect(f.calls).toContain("bun run smoke");
  expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf("restart"));
  expect(f.logs.join("\n")).toContain("--now");
  const other = setup();
  other.client.run = async () => {
    throw new Error("gone");
  };
  await deploy(7400, "feature", false, other.opts);
  expect(other.logs.join("\n")).toContain("run-a (unknown stage)");
});

test("failure after a possible drain restores release and resumes, retaining cleanup errors", async () => {
  for (const failure of ["gate", "drain", "health", "restart", "replacement"]) {
    const f = setup();
    const originalAdmin = f.client.admin;
    f.client.admin = async (action, signal) => {
      const state = await originalAdmin(action, signal);
      if (failure === "drain" && action === "drain") throw new Error("lost acknowledgement");
      return state;
    };
    if (failure === "gate") {
      const command = f.opts.command;
      f.opts.command = async (args, opts) => {
        if (args.join(" ") === "bun run check") throw new Error("bad gate");
        return command(args, opts);
      };
    }
    if (failure === "health")
      f.client.health = async () => {
        throw new Error("bad health");
      };
    if (failure === "restart")
      f.opts.restart = async () => {
        f.calls.push("restart");
        throw new Error("restart failed");
      };
    if (failure === "replacement") {
      const health = f.client.health;
      f.client.health = async (signal) => {
        if (f.calls.includes("restart")) return { ...(await health(signal)), draining: true };
        return health(signal);
      };
    }
    await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow(
      failure === "gate" ? "deploy gate failed" : "deploy failed",
    );
    expect(f.selected()).toBe("previous");
    if (failure === "gate") expect(f.calls).not.toContain("resume");
    else expect(f.calls.at(-1)).toBe("resume");
    if (["restart", "replacement"].includes(failure))
      expect(f.calls.filter((c) => c === "restart")).toHaveLength(2);
  }
  const f = setup();
  f.client.admin = async (action) => {
    throw new Error(action === "drain" ? "original failure" : "cleanup failure");
  };
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow(
    /original failure[\s\S]*Cleanup failures:[\s\S]*cleanup failure/,
  );
});

test("malformed health fails closed and never restarts", async () => {
  const f = setup();
  f.client.health = async () => ({ ok: true }) as HealthResponse;
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("invalid or unhealthy");
  expect(f.calls).not.toContain("restart");
  expect(f.calls.at(-1)).toBe("resume");
});

test("requests are bounded even if a client ignores abort", async () => {
  const f = setup();
  let signal: AbortSignal | undefined;
  const result = bounded(
    f.clock,
    async (s) => {
      signal = s;
      return new Promise<never>(() => {});
    },
    123,
  );
  for (const timeout of [...f.pending]) timeout();
  await expect(result).rejects.toThrow("timed out");
  expect(f.timeouts).toEqual([123]);
  expect(signal?.aborted).toBe(true);
  expect(f.pending.size).toBe(0);
});

test("wait request budgets shrink to the remaining deadline", async () => {
  const f = setup();
  await deploy(7400, "feature", false, { ...f.opts, maxWaitMs: 700 });
  expect(f.timeouts.slice(0, 3)).toEqual([5000, 700, 700]);
  expect(f.sleeps).toEqual([700]);
});

test("CLI rejects invalid waits before deployment, including with --now", async () => {
  for (const value of ["-1", "1.2", "Infinity", "NaN", "foo", "", "9007199254740991", "1e3"]) {
    expect(() => parseMaxWait(value)).toThrow("--max-wait");
    const result = Bun.spawnSync(["bun", "src/cli/main.ts", "deploy", "--now", `--max-wait=${value}`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--max-wait");
  }
  const missing = Bun.spawnSync(["bun", "src/cli/main.ts", "deploy", "--now", "--max-wait"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("--max-wait");
  expect(parseMaxWait("0")).toBe(0);
  expect(parseMaxWait("12")).toBe(12000);
});

test("polling failures after progress resume scheduling without restarting", async () => {
  const f = setup();
  const health = f.client.health;
  let reads = 0;
  f.client.health = async (signal) => {
    if (++reads === 2) throw new Error("poll connection lost");
    return health(signal);
  };
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("poll connection lost");
  expect(f.logs.join("\n")).toContain("run-a (implement)");
  expect(f.sleeps).toEqual([5000]);
  expect(f.calls).not.toContain("restart");
  expect(f.calls.at(-1)).toBe("resume");
});

test("a stalled deployment health request is bounded and cleans up", async () => {
  const f = setup();
  let signal: AbortSignal | undefined;
  let entered = () => {};
  const inHealth = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.client.health = async (s) => {
    signal = s;
    entered();
    return new Promise<HealthResponse>(() => {});
  };
  const result = deploy(7400, "feature", false, { ...f.opts, maxWaitMs: 123 });
  await inHealth;
  expect(f.timeouts.at(-1)).toBe(123);
  for (const timeout of [...f.pending]) timeout();
  await expect(result).rejects.toThrow("daemon request timed out");
  expect(signal?.aborted).toBe(true);
  expect(f.calls).not.toContain("restart");
  expect(f.calls.at(-1)).toBe("resume");
});

test("progress tracks changing active membership and post-restart rejects unhealthy data", async () => {
  const f = setup();
  const health = f.client.health;
  let reads = 0;
  f.client.health = async (signal) => {
    const state = await health(signal);
    if (++reads === 2) return { ...state, active: ["run-b"] };
    return state;
  };
  await deploy(7400, "feature", false, f.opts);
  expect(f.logs.join("\n")).toContain("run-b (review)");
  const other = setup();
  const otherHealth = other.client.health;
  other.client.health = async (signal) => ({
    ...(await otherHealth(signal)),
    ok: !other.calls.includes("restart"),
  });
  await expect(deploy(7400, "feature", false, other.opts)).rejects.toThrow("new version is unhealthy");
  expect(other.selected()).toBe("previous");
  expect(other.calls.at(-1)).toBe("resume");
});

test("release restoration failure does not prevent the bounded resume attempt", async () => {
  const f = setup();
  const command = f.opts.command;
  f.opts.command = async (args, opts) => {
    if (args[1] === "checkout" && args[4] === "previous") throw new Error("restore failed");
    return command(args, opts);
  };
  f.client.health = async () => {
    throw new Error("original health failure");
  };
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow(
    /original health failure[\s\S]*restore failed/,
  );
  expect(f.calls.at(-1)).toBe("resume");
});

test("a daemon without the drain endpoint is restarted only with --now", async () => {
  const legacy = () => {
    const t = setup();
    t.client.admin = async (action) => {
      t.calls.push(action);
      throw new DrainUnsupportedError(`POST /api/admin/${action}: HTTP 404`);
    };
    return t;
  };
  const refused = legacy();
  await expect(deploy(7400, "origin/main", false, refused.opts)).rejects.toThrow("re-run with --now");
  expect(refused.calls).not.toContain("restart");
  expect(refused.calls).not.toContain("resume");
  expect(refused.selected()).toBe("previous");

  const now = legacy();
  await deploy(7400, "origin/main", false, { ...now.opts, now: true });
  expect(now.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(now.calls).not.toContain("resume");
  expect(now.selected()).toBe("next");
  expect(now.logs.some((l) => l.includes("no drain endpoint"))).toBe(true);
});
