import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBootSha } from "../src/cli/boot-sha.ts";
import {
  bounded,
  DaemonTimeoutError,
  DEFAULT_MAX_WAIT_MS,
  type DeployClient,
  type DeployClock,
  DrainUnsupportedError,
  parseMaxWait,
  requestAdmin,
  waitForDrain,
} from "../src/cli/deploy-wait.ts";
import { deploy } from "../src/cli/service.ts";
import type { HealthResponse } from "../src/core/types.ts";
import { registerCredential, type sh } from "../src/util/proc.ts";

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
  const commandTimeouts = new Map<string, number | undefined>();
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
  const command: typeof sh = async (args, opts) => {
    const line = args.join(" ");
    calls.push(line);
    commandTimeouts.set(line, opts?.timeoutMs);
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
      return {
        ok: true,
        uptimeMs: 1,
        sha: restarted ? "next" : "previous",
        draining,
        active: restarted || time >= 10_000 ? [] : ["run-a"],
      };
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
    commandTimeouts,
    logs,
    sleeps,
    timeouts,
    pending,
    client,
    clock,
    selected: () => selected,
    setSelected: (sha: string) => {
      selected = sha;
    },
    setDraining: (value: boolean) => {
      draining = value;
    },
    opts: {
      agentsDir: join(dir, "LaunchAgents"),
      releaseDir: dir,
      lockPath: join(dir, "deploy.lock"),
      command,
      client,
      leaseClient: async () => ({ id: "lease", acquired: true }),
      clock,
      restart,
      log: (s: string) => logs.push(s),
    },
  };
}

test("deploy gates, drains, refreshes stages and restarts once after completion", async () => {
  const f = setup();
  const intListeners = process.listenerCount("SIGINT");
  const termListeners = process.listenerCount("SIGTERM");
  await deploy(7400, "feature", true, f.opts);
  expect(process.listenerCount("SIGINT")).toBe(intListeners);
  expect(process.listenerCount("SIGTERM")).toBe(termListeners);
  expect(f.calls.slice(0, 10)).toEqual([
    "health",
    "git rev-parse HEAD",
    "git fetch origin --prune",
    "git rev-parse feature^{commit}",
    "git checkout -q --detach next",
    "bun install --frozen-lockfile",
    "bun run lint",
    "bun run typecheck",
    "bun test",
    "bun scripts/smoke.ts",
  ]);
  expect(f.calls[10]).toBe("drain");
  // The full suite outgrew 20 minutes on a busy machine; lint and typecheck keep the shorter bound.
  expect([...f.commandTimeouts].filter(([line]) => /^bun (run|test)/.test(line))).toEqual([
    ["bun run lint", 600_000],
    ["bun run typecheck", 600_000],
    ["bun test", 1_800_000],
  ]);
  expect(f.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(f.sleeps).toEqual([5000, 5000]);
  expect(f.logs.join("\n")).toContain("run-a (implement)");
  expect(f.logs.join("\n")).toContain("run-a (review)");
  expect(f.logs.join("\n")).toContain("Drain complete");
  expect(f.calls.slice(-3)).toEqual(["health", "restart", "health"]);
});

test("deploy enables runner redaction for every gate including smoke", async () => {
  const f = setup();
  const command = f.opts.command;
  const redacted: string[] = [];
  f.opts.command = async (args, opts) => {
    if (args[0] === "bun" && args[1] !== "install") {
      expect(opts.redactOutput).toBe(true);
      redacted.push(args.join(" "));
    } else expect(opts.redactOutput).toBeUndefined();
    return command(args, opts);
  };
  await deploy(7400, "feature", true, f.opts);
  expect(redacted).toEqual(["bun run lint", "bun run typecheck", "bun test", "bun scripts/smoke.ts"]);
});

test("deploy waits for three current stages, not the queued work after them", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => {
    const elapsed = f.clock.now();
    const stages = [
      { id: "a", endsAt: 5000 },
      { id: "b", endsAt: 10_000 },
      { id: "c", endsAt: 15_000 },
    ];
    return {
      ...(await health(signal)),
      active: stages.filter((stage) => elapsed < stage.endsAt).map((stage) => stage.id),
      parked: stages.filter((stage) => elapsed >= stage.endsAt).map((stage) => stage.id),
    };
  };
  f.client.run = async () => ({ stage: "implement" });
  await deploy(7400, "feature", false, { ...f.opts, maxWaitMs: 60_000 });
  expect(f.clock.now()).toBe(15_000);
  expect(f.logs).toContain("Drain complete: no active runs (15s elapsed)");
  expect(f.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(f.sleeps).toEqual([5000, 5000, 5000]);
});

test("max-wait still restarts with an unfinished current stage", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({
    ...(await health(signal)),
    active: ["slow-stage"],
    parked: ["completed-stage"],
  });
  f.client.run = async () => ({ stage: "implement" });
  await deploy(7400, "feature", false, { ...f.opts, maxWaitMs: 5000 });
  expect(f.sleeps).toEqual([5000]);
  expect(f.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(f.logs).toContain("Drain timeout after 5s; restarting with active runs: slow-stage (implement)");
});

test("drain progress includes every stage once per changed poll, regardless of health order", async () => {
  const f = setup();
  f.client.health = async () => {
    const time = f.clock.now();
    const active =
      time >= 25_000
        ? []
        : time >= 20_000
          ? ["run-b"]
          : time >= 5000 && time < 15_000
            ? ["run-b", "run-a"]
            : ["run-a", "run-b"];
    return { ok: true, uptimeMs: 1, sha: "previous", draining: true, active };
  };
  f.client.run = async (id) => {
    f.calls.push(`run ${id} at ${f.clock.now()}`);
    return { stage: id === "run-a" && f.clock.now() >= 15_000 ? "review" : "implement" };
  };

  await waitForDrain(f.client, f.clock, 60_000, false, (line) => f.logs.push(line));

  expect(f.logs).toEqual([
    "Draining (60s remaining); active runs: run-a (implement), run-b (implement)",
    "Draining (45s remaining); active runs: run-a (review), run-b (implement)",
    "Draining (40s remaining); active runs: run-b (implement)",
    "Drain complete: no active runs (25s elapsed)",
  ]);
  expect(f.calls).toEqual([
    "run run-a at 0",
    "run run-b at 0",
    "run run-a at 5000",
    "run run-b at 5000",
    "run run-a at 10000",
    "run run-b at 10000",
    "run run-a at 15000",
    "run run-b at 15000",
    "run run-b at 20000",
  ]);
  expect(f.sleeps).toEqual([5000, 5000, 5000, 5000, 5000]);
});

test("unchanged drain progress repeats only after 30 seconds", async () => {
  const f = setup();
  f.client.health = async () => ({
    ok: true,
    uptimeMs: 1,
    sha: "previous",
    draining: true,
    active: f.clock.now() >= 35_000 ? [] : ["held"],
  });
  f.client.run = async () => ({ stage: "verify" });
  const progressTimes: number[] = [];
  await waitForDrain(f.client, f.clock, 40_000, false, (line) => {
    f.logs.push(line);
    if (line.startsWith("Draining")) progressTimes.push(f.clock.now());
  });
  expect(progressTimes).toEqual([0, 30_000]);
  expect(f.logs).toEqual([
    "Draining (40s remaining); active runs: held (verify)",
    "Draining (10s remaining); active runs: held (verify)",
    "Drain complete: no active runs (35s elapsed)",
  ]);
  expect(f.sleeps).toEqual(Array(7).fill(5000));
});

test("unknown stages and terminal drain outcomes have no extra progress line", async () => {
  for (const missing of [false, true]) {
    const f = setup();
    f.client.health = async () => ({
      ok: true,
      uptimeMs: 1,
      sha: "previous",
      draining: true,
      active: f.clock.now() >= 5000 ? [] : ["gone", "missing"],
    });
    f.client.run = async (id) => {
      if (id === "gone") throw new Error("gone");
      if (missing) return {} as Awaited<ReturnType<DeployClient["run"]>>;
      return { stage: "review" };
    };
    await waitForDrain(f.client, f.clock, 10_000, false, (line) => f.logs.push(line));
    expect(f.logs).toEqual([
      `Draining (10s remaining); active runs: gone (unknown stage), missing (${missing ? "unknown stage" : "review"})`,
      "Drain complete: no active runs (5s elapsed)",
    ]);
  }

  for (const now of [false, true]) {
    const f = setup();
    f.client.health = async () => ({
      ok: true,
      uptimeMs: 1,
      sha: "previous",
      draining: true,
      active: ["held"],
    });
    await waitForDrain(f.client, f.clock, 5000, now, (line) => f.logs.push(line));
    expect(f.logs).toEqual(
      now
        ? ["--now: restarting immediately; active runs: held (unknown stage)"]
        : [
            "Draining (5s remaining); active runs: held (implement)",
            "Drain timeout after 5s; restarting with active runs: held (implement)",
          ],
    );
  }
});

test("initially empty and unchanged ref do not wait", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({ ...(await health(signal)), active: [] });
  await deploy(7400, "feature", false, f.opts);
  expect(f.sleeps).toEqual([]);
  f.calls.length = 0;
  await deploy(7400, "feature", false, f.opts);
  expect(f.calls).toEqual([
    "health",
    "git rev-parse HEAD",
    "git fetch origin --prune",
    "git rev-parse feature^{commit}",
  ]);
  f.calls.length = 0;
  await deploy(7400, "feature", true, f.opts);
  expect(f.calls.slice(-4)).toEqual([
    "bun run lint",
    "bun run typecheck",
    "bun test",
    "bun scripts/smoke.ts",
  ]);
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
  expect(f.calls).toContain("bun scripts/smoke.ts");
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
        if (args.join(" ") === "bun test") throw new Error("bad gate");
        return command(args, opts);
      };
    }
    if (failure === "health") {
      const health = f.client.health;
      let reads = 0;
      f.client.health = async (signal) => {
        if (++reads > 1) throw new Error("bad health");
        return health(signal);
      };
    }
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
  expect(f.calls).not.toContain("resume");
});

test("--now and zero-wait drains don't retry a stalled health poll", async () => {
  for (const [maxWaitMs, now] of [
    [60_000, true],
    [0, false],
  ] as const) {
    const f = setup();
    let reads = 0;
    f.client.health = async () => {
      reads++;
      throw new DaemonTimeoutError();
    };
    await expect(waitForDrain(f.client, f.clock, maxWaitMs, now, () => {})).rejects.toThrow(
      "daemon request timed out",
    );
    expect(reads).toBe(1);
  }
});

test("a drain tolerates two stalled health polls in a row but not three", async () => {
  for (const stalls of [2, 3]) {
    const f = setup();
    let reads = 0;
    f.client.health = async () => {
      reads++;
      if (reads >= 2 && reads < 2 + stalls) throw new DaemonTimeoutError();
      return { ok: true, uptimeMs: 1, sha: "previous", draining: true, active: reads === 1 ? ["run-a"] : [] };
    };
    const result = waitForDrain(f.client, f.clock, 60_000, false, (line) => f.logs.push(line));
    if (stalls === 3) {
      await expect(result).rejects.toThrow("daemon request timed out");
      continue;
    }
    await result;
    expect(f.logs.filter((line) => line.startsWith("Health poll timed out"))).toHaveLength(2);
    expect(f.logs.at(-1)).toStartWith("Drain complete");
  }
});

test("resume retries a stalled daemon with a longer limit, up to three attempts", async () => {
  const f = setup();
  let calls = 0;
  f.client.admin = async (action) => {
    if (++calls < 3) throw new DaemonTimeoutError();
    return { draining: action === "drain", active: [] };
  };
  await requestAdmin(f.client, f.clock, "resume");
  expect(calls).toBe(3);
  expect(f.timeouts).toEqual([15_000, 15_000, 15_000]);
  calls = -10;
  await expect(requestAdmin(f.client, f.clock, "resume")).rejects.toThrow("daemon request timed out");
  expect(calls).toBe(-7);
  f.client.admin = async () => {
    throw new DaemonTimeoutError();
  };
  await expect(requestAdmin(f.client, f.clock, "drain")).rejects.toThrow("daemon request timed out");
  expect(f.timeouts.at(-1)).toBe(5000);
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
  expect(f.timeouts.slice(0, 4)).toEqual([5000, 5000, 700, 700]);
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
    if (++reads === 3) throw new Error("poll connection lost");
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
  const health = f.client.health;
  let reads = 0;
  f.client.health = async (s) => {
    if (++reads === 1) return health(s);
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
    if (++reads === 3) return { ...state, active: ["run-b"] };
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
  const health = f.client.health;
  let reads = 0;
  f.client.health = async (signal) => {
    if (++reads > 1) throw new Error("original health failure");
    return health(signal);
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

test("checkout already at target reruns gates before drain", async () => {
  const f = setup();
  f.setSelected("next");
  await deploy(7400, "feature", false, f.opts);
  expect(f.calls.indexOf("bun install --frozen-lockfile")).toBeLessThan(f.calls.indexOf("bun run lint"));
  expect(f.calls.indexOf("bun test")).toBeLessThan(f.calls.indexOf("drain"));
  expect(f.calls).not.toContain("git checkout -q --detach next");
  expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf("restart"));
  expect(f.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(f.logs).toContain("daemon before: previous");
  expect(f.logs).toContain("daemon after: next");
});

test("a target checkout still aborts on failed gates before draining", async () => {
  const f = setup();
  f.setSelected("next");
  const command = f.opts.command;
  f.opts.command = async (args, options) => {
    if (args.join(" ") === "bun test") throw new Error("failed check");
    return command(args, options);
  };
  await expect(deploy(7400, "feature", true, f.opts)).rejects.toThrow("failed check");
  expect(f.calls).toContain("bun install --frozen-lockfile");
  expect(f.calls).not.toContain("drain");
  expect(f.calls).not.toContain("restart");
  expect(f.calls).not.toContain("bun scripts/smoke.ts");
});

test("a failed smoke gate reports the tail of both output streams and restores the checkout", async () => {
  const f = setup();
  const command = f.opts.command;
  const stdout = [
    "FIRST-STDOUT-LINE",
    ...Array.from({ length: 80 }, (_, i) => `row ${i}`),
    "codex structured  FAIL  12ms  model rejected",
  ];
  f.opts.command = async (args, options) => {
    if (args.join(" ") !== "bun scripts/smoke.ts") return command(args, options);
    f.calls.push("smoke");
    return {
      stdout: `${stdout.join("\n")}\n`,
      stderr: "FIRST-STDERR-LINE\nwarning: last stderr\n",
      exitCode: 1,
    };
  };
  const error = await deploy(7400, "feature", true, f.opts).catch((e: unknown) => e);
  const message = String(error);
  expect(message).toContain("deploy gate failed; staying on previous");
  expect(message).toContain("Command failed (1): bun scripts/smoke.ts");
  expect(message).toContain("codex structured  FAIL  12ms  model rejected");
  expect(message).toContain("FIRST-STDERR-LINE\nwarning: last stderr");
  expect(message).not.toContain("FIRST-STDOUT-LINE");
  expect(message.split("\n").filter((line) => line.startsWith("row "))).toHaveLength(57);
  expect(f.calls).toContain("smoke");
  expect(f.calls).not.toContain("drain");
  expect(f.calls).not.toContain("restart");
  expect(f.calls.at(-2)).toBe("git checkout -q --detach previous");
  expect(f.selected()).toBe("previous");
});

test("a failed deploy gate keeps early test diagnostics before the summary tail", async () => {
  const credential = "synthetic-deploy-excerpt-credential-409";
  registerCredential("DEPLOY_EXCERPT_TEST_TOKEN", credential);
  const f = setup();
  const command = f.opts.command;
  f.opts.command = async (args, options) => {
    if (args.join(" ") !== "bun test") return command(args, options);
    return {
      stdout: "",
      stderr:
        `sample.test.ts:\n\u001b[31merror: values differ\u001b[0m\nExpected: 1\nReceived: 2\ncredential: ${credential}\n\u001b[31m(fail) assertion\u001b[0m\n` +
        "skipped summary\n".repeat(700),
      exitCode: 1,
    };
  };
  const message = String(await deploy(7400, "feature", false, f.opts).catch((e: unknown) => e));
  expect(message).toContain("deploy gate failed; staying on previous");
  expect(message).toContain("error: values differ\nExpected: 1\nReceived: 2");
  expect(message.indexOf("error:")).toBeLessThan(message.indexOf("skipped summary"));
  expect(message).not.toContain("\u001b");
  expect(message).toContain("credential: [redacted]");
  expect(message).not.toContain(credential);
  expect(f.calls).not.toContain("drain");
  expect(f.calls).not.toContain("restart");
  expect(f.selected()).toBe("previous");
});

test.each(["stdout", "stderr"])(
  "a failed deploy gate redacts %s before cutting a long tail row",
  async (stream) => {
    const credential = "synthetic-deploy-tail-credential-409";
    registerCredential("DEPLOY_TAIL_TEST_TOKEN", credential);
    const f = setup();
    const command = f.opts.command;
    f.opts.command = async (args, options) => {
      if (args.join(" ") !== "bun test") return command(args, options);
      return {
        stdout: "",
        stderr: "",
        [stream]: `${"x".repeat(800)}${credential}${"z".repeat(480)}\n`,
        exitCode: 1,
      };
    };
    const message = String(await deploy(7400, "feature", false, f.opts).catch((e: unknown) => e));
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(credential);
    expect(message).not.toContain(credential.slice(-20));
    expect(f.selected()).toBe("previous");
  },
);

test("a failed gate tail keeps stderr first and stays within 4000 bytes", async () => {
  const f = setup();
  const command = f.opts.command;
  f.opts.command = async (args, options) => {
    if (args.join(" ") !== "bun test") return command(args, options);
    return {
      stdout: `${Array.from({ length: 200 }, (_, i) => `stdout ${i} ${"x".repeat(200)}`).join("\n")}\n`,
      stderr: `${Array.from({ length: 40 }, (_, i) => `stderr ${i}`).join("\n")}\n 3 fail\n Ran 900 tests\n${"é".repeat(3000)}\n`,
      exitCode: 1,
    };
  };
  const message = String(await deploy(7400, "feature", false, f.opts).catch((e: unknown) => e));
  const tail = message.slice(message.indexOf("Command failed (1): bun test"));
  expect(Buffer.byteLength(tail)).toBeLessThan(4_200);
  expect(tail).toContain(" 3 fail\n Ran 900 tests");
  expect(tail).toContain("stderr 39");
  expect(tail).toContain(`…${"é".repeat(500)}`);
  expect(tail).not.toContain("stdout 0 ");
  expect(f.selected()).toBe("previous");
});

test("a smoke failure keeps its FAIL row when stderr fills the tail", async () => {
  const f = setup();
  const command = f.opts.command;
  f.opts.command = async (args, options) => {
    if (args.join(" ") !== "bun scripts/smoke.ts") return command(args, options);
    return {
      stdout: `${[
        "claude noTools    FAIL     812ms  local file token appeared in output",
        ...Array.from({ length: 30 }, (_, i) => `row ${i}  PASS  1ms`),
      ].join("\n")}\n`,
      stderr: `${Array.from({ length: 80 }, (_, i) => `warn ${i}`).join("\n")}\n`,
      exitCode: 1,
    };
  };
  const message = String(await deploy(7400, "feature", true, f.opts).catch((e: unknown) => e));
  expect(message).toContain("claude noTools    FAIL     812ms  local file token appeared in output");
  expect(message).toContain("warn 79");
  expect(message).not.toContain("row 29");
  expect(f.selected()).toBe("previous");
});

test("a target checkout runs requested smoke before draining", async () => {
  const f = setup();
  f.setSelected("next");
  await deploy(7400, "feature", true, f.opts);
  expect(f.calls.indexOf("bun scripts/smoke.ts")).toBeLessThan(f.calls.indexOf("drain"));
});

test("a pre-upgrade daemon without a boot SHA deploys using the checkout commit", async () => {
  for (const oldSha of [undefined, "", "unknown"]) {
    const f = setup();
    const health = f.client.health;
    f.client.health = async (signal) => {
      const state = await health(signal);
      return f.calls.includes("restart") ? state : ({ ...state, sha: oldSha } as HealthResponse);
    };
    await deploy(7400, "feature", false, f.opts);
    expect(f.calls).toContain("git checkout -q --detach next");
    expect(f.calls).toContain("bun test");
    expect(f.calls.filter((call) => call === "restart")).toHaveLength(1);
    expect(f.logs).toContain("daemon before: unknown");
    expect(f.logs).toContain("daemon after: next");
  }
});

test("an unknown daemon SHA cannot use the target checkout as proof of deployment", async () => {
  for (const sha of [undefined, null, "", " \n", "unknown", " unknown ", 123]) {
    for (const draining of [false, true]) {
      const f = setup();
      f.setSelected("next");
      f.setDraining(draining);
      const health = f.client.health;
      f.client.health = async (signal) => ({ ...(await health(signal)), sha }) as unknown as HealthResponse;
      mkdirSync(join(f.opts.releaseDir, "src", "cli"), { recursive: true });
      writeFileSync(join(f.opts.releaseDir, "src", "cli", "main.ts"), "");
      mkdirSync(f.opts.agentsDir);
      const installed = {
        Label: "arbitrary.installed.daemon",
        ProgramArguments: ["bun", join(f.opts.releaseDir, "src", "cli", "main.ts"), "serve"],
      };
      writeFileSync(join(f.opts.agentsDir, "installed.plist"), JSON.stringify(installed));
      const command = f.opts.command;
      f.opts.command = async (args, opts) =>
        args[0] === "plutil"
          ? { stdout: readFileSync(args.at(-1) ?? "", "utf8"), stderr: "", exitCode: 0 }
          : command(args, opts);
      const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow(
        /daemon boot SHA is unknown.*launchctl kickstart -k gui\/\d+\/arbitrary\.installed\.daemon or limitless service install/,
      );
      expect(f.calls).toEqual([
        "health",
        "git rev-parse HEAD",
        "git fetch origin --prune",
        "git rev-parse feature^{commit}",
      ]);
      expect(f.selected()).toBe("next");
      expect(f.logs.some((line) => line.includes("already deployed"))).toBe(false);
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    }
  }
});

test("boot SHA resolution degrades when Git fails or returns an empty result", async () => {
  const f = setup();
  expect(await resolveBootSha("/release", f.opts.command)).toBe("previous");
  expect(
    await resolveBootSha("/release", async () => {
      throw new Error("missing git");
    }),
  ).toBeUndefined();
  expect(
    await resolveBootSha("/release", async () => ({
      stdout: " \n",
      stderr: "",
      exitCode: 0,
    })),
  ).toBeUndefined();
});

test("running target is already deployed and a stranded drain is resumed", async () => {
  for (const draining of [false, true]) {
    const f = setup();
    f.setSelected("next");
    f.setDraining(draining);
    const health = f.client.health;
    f.client.health = async (signal) => ({ ...(await health(signal)), sha: "next" });
    await deploy(7400, "feature", false, f.opts);
    expect(f.calls).not.toContain("restart");
    expect(f.calls.filter((c) => c === "resume")).toHaveLength(draining ? 1 : 0);
    expect(f.logs.at(-1)).toContain("already deployed next");
  }
});

test("a running target repairs a different checkout before returning", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({ ...(await health(signal)), sha: "next" });
  await deploy(7400, "feature", false, f.opts);
  expect(f.calls).toContain("git checkout -q --detach next");
  expect(f.calls).toContain("bun install --frozen-lockfile");
  expect(f.selected()).toBe("next");
  expect(f.calls).not.toContain("drain");
  expect(f.calls).not.toContain("restart");
});

test("a replacement without boot SHA is accepted with a warning", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({
    ...(await health(signal)),
    sha: f.calls.includes("restart") ? "" : "previous",
  });
  await deploy(7400, "feature", false, f.opts);
  expect(f.logs.join("\n")).toContain("warning: replacement daemon does not report a boot SHA");
});

test("deploy lock refuses a live holder and removes a stale lock", async () => {
  const f = setup();
  const lock = f.opts.lockPath;
  writeFileSync(lock, `${process.pid}\n`);
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("deploy already running");
  expect(f.calls).toEqual([]);
  writeFileSync(lock, "99999999\n");
  await deploy(7400, "feature", false, f.opts);
  expect(existsSync(lock)).toBe(false);
});

test("an already draining old daemon completes a pending deploy", async () => {
  const f = setup();
  f.setSelected("next");
  f.setDraining(true);
  await deploy(7400, "feature", false, f.opts);
  expect(f.calls).not.toContain("drain");
  expect(f.calls.filter((c) => c === "restart")).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("already draining");
});

test("a gate failure resumes a daemon that was draining on entry", async () => {
  const f = setup();
  f.setDraining(true);
  const command = f.opts.command;
  f.opts.command = async (args, opts) => {
    if (args.join(" ") === "bun test") throw new Error("bad gate");
    return command(args, opts);
  };
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("bad gate");
  expect(f.calls.at(-1)).toBe("resume");
  expect(f.calls).not.toContain("restart");
});

test("signals during drain wait restore the daemon checkout and resume", async () => {
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const f = setup();
    f.setSelected("next");
    const before = process.listenerCount(name);
    f.clock.sleep = async () => {
      process.emit(name);
      return new Promise<void>(() => {});
    };
    await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow(name);
    expect(f.logs).toContain("interrupted, rolling back...");
    expect(f.calls).toContain("git checkout -q --detach previous");
    expect(f.calls).toContain("bun install --frozen-lockfile");
    expect(f.calls.at(-1)).toBe("resume");
    expect(f.calls).not.toContain("restart");
    expect(process.listenerCount(name)).toBe(before);
  }
});

test("a second signal exits immediately during rollback", async () => {
  const f = setup();
  const exits: number[] = [];
  const command = f.opts.command;
  f.opts.command = async (args, options) => {
    if (args.join(" ") === "bun test") process.emit("SIGINT");
    if (args[1] === "checkout" && args[4] === "previous") {
      process.emit("SIGTERM");
      expect(exits).toEqual([143]);
    }
    return command(args, options);
  };
  await expect(
    deploy(7400, "feature", false, {
      ...f.opts,
      exit: (code) => {
        exits.push(code);
      },
    }),
  ).rejects.toThrow("SIGINT");
  expect(f.logs).toContain("interrupted, rolling back...");
});

test("a signal during gates cancels the command before restoring the checkout", async () => {
  const f = setup();
  const command = f.opts.command;
  f.opts.command = async (args, options) => {
    if (args.join(" ") !== "bun test") return command(args, options);
    f.calls.push("gate started");
    process.emit("SIGINT");
    expect(options.signal?.aborted).toBe(true);
    f.calls.push("gate stopped");
    throw new Error("gate cancelled");
  };
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("gate cancelled");
  expect(f.calls.indexOf("gate stopped")).toBeLessThan(f.calls.indexOf("git checkout -q --detach previous"));
  expect(f.calls).not.toContain("restart");
});

test("a signal after restart starts exits without rollback or resume", async () => {
  const f = setup();
  const before = process.listenerCount("SIGTERM");
  f.opts.restart = async () => {
    f.calls.push("restart");
    process.emit("SIGTERM");
    return new Promise<void>(() => {});
  };
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("SIGTERM");
  expect(f.calls).not.toContain("git checkout -q --detach previous");
  expect(f.calls).not.toContain("resume");
  expect(process.listenerCount("SIGTERM")).toBe(before);
});

test("replacement with the wrong commit fails and restores the old release", async () => {
  const f = setup();
  const health = f.client.health;
  f.client.health = async (signal) => ({
    ...(await health(signal)),
    sha: f.calls.includes("restart") ? "other" : "previous",
  });
  await expect(deploy(7400, "feature", false, f.opts)).rejects.toThrow("expected next");
  expect(f.selected()).toBe("previous");
  expect(f.calls.at(-1)).toBe("resume");
  expect(f.logs).not.toContain("daemon after: next");
});

test("the tunnel config names the configured public host and exposes only webhooks", async () => {
  const { tunnelYaml } = await import("../src/cli/service.ts");
  const yaml = tunnelYaml("0000-tunnel", "/creds.json", "hooks.example.com", 7400);
  expect(yaml).toContain(
    "  - hostname: hooks.example.com\n    path: ^/webhooks/\n    service: http://127.0.0.1:7400\n",
  );
  expect(yaml).toContain("  - service: http_status:404\n");
  expect(yaml).not.toMatch(/mattflower/i);
});

for (const spelling of ["canonical", "symlink", "reverse"]) {
  test(`deploy restarts the discovered ${spelling} daemon label and ignores unrelated marked agents`, async () => {
    const f = setup();
    const agentsDir = join(f.opts.releaseDir, "LaunchAgents");
    mkdirSync(agentsDir);
    mkdirSync(join(f.opts.releaseDir, "src", "cli"), { recursive: true });
    writeFileSync(join(f.opts.releaseDir, "src", "cli", "main.ts"), "");
    const alias = join(f.opts.releaseDir, "alias");
    symlinkSync(f.opts.releaseDir, alias);
    const installed = {
      Label: "arbitrary.pre.migration.daemon",
      ProgramArguments: [
        "/custom/bin/bun",
        join(spelling === "reverse" ? alias : f.opts.releaseDir, "src", "cli", "main.ts"),
        "serve",
      ],
    };
    if (spelling === "symlink") f.opts.releaseDir = alias;
    const unrelated = {
      Label: "unrelated.daemon",
      LimitlessService: "daemon",
      ProgramArguments: ["bun", "/different/install/src/cli/main.ts", "serve"],
    };
    writeFileSync(join(agentsDir, "installed.plist"), JSON.stringify(installed));
    const unrelatedPath = join(agentsDir, "unrelated.plist");
    writeFileSync(unrelatedPath, JSON.stringify(unrelated));
    const command: typeof sh = async (args, opts) => {
      if (args[0] === "plutil")
        return {
          stdout: readFileSync(args.at(-1) ?? "", "utf8"),
          stderr: "",
          exitCode: 0,
        };
      if (args[0] === "launchctl") {
        f.calls.push(args.join(" "));
        await f.opts.restart();
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return f.opts.command(args, opts);
    };
    await deploy(7400, "feature", false, { ...f.opts, agentsDir, command, restart: undefined });
    const launches = f.calls.filter((call) => call.startsWith("launchctl"));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatch(/^launchctl kickstart -k gui\/\d+\/arbitrary\.pre\.migration\.daemon$/);
    expect(readFileSync(unrelatedPath, "utf8")).toBe(JSON.stringify(unrelated));
    expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf(launches[0] ?? ""));
  });
}

test("deploy leases the entire suite, including already-deployed smoke, and releases before later steps", async () => {
  for (const already of [false, true]) {
    for (const fail of [false, true]) {
      const f = setup();
      let held = false;
      const order: string[] = [];
      if (already) {
        f.opts.client.health = async () => ({
          ok: true,
          uptimeMs: 1,
          sha: "next",
          draining: false,
          active: [],
        });
        f.setSelected("next");
      }
      const work = deploy(7400, "feature", true, {
        ...f.opts,
        leaseClient: async (body) => {
          if (body.name) {
            expect(body.name).toBe("deploy");
            held = true;
            order.push("acquire");
          }
          if (body.release) {
            held = false;
            order.push("release");
          }
          return { id: "test-lease", acquired: true };
        },
        command: async (args, opts) => {
          const line = args.join(" ");
          if (["bun run lint", "bun run typecheck", "bun test", "bun scripts/smoke.ts"].includes(line)) {
            order.push(line);
            expect(held).toBe(line !== "bun scripts/smoke.ts");
          }
          if (fail && line === "bun run typecheck")
            return { exitCode: 7, stdout: "", stderr: "failed typecheck" };
          return f.opts.command(args, opts);
        },
      });
      if (fail) {
        await expect(work).rejects.toThrow("failed typecheck");
        expect(order).toEqual(["acquire", "bun run lint", "bun run typecheck", "release"]);
        expect(f.calls).not.toContain("drain");
        expect(f.calls).not.toContain("restart");
      } else {
        await work;
        expect(order).toEqual([
          "acquire",
          "bun run lint",
          "bun run typecheck",
          "bun test",
          "release",
          "bun scripts/smoke.ts",
        ]);
      }
      expect(held).toBe(false);
    }
  }
});
