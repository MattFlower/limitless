import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  backendChecks,
  type CheckResult,
  type Clock,
  checkCodexModels,
  decisionsCheck,
  exitCode,
  formatReport,
  liveCheck,
  quotaCheck,
  reportChecks,
  runChecks,
  SMOKE_BUDGET_MS,
  type SmokeCheck,
  transientReason,
  verifyLiveCheck,
} from "../scripts/smoke.ts";
import { deploy } from "../src/cli/service.ts";
import { CodexStreamParser } from "../src/harness/codex.ts";
import type { AgentResult, Harness, ModelTarget } from "../src/harness/types.ts";
import { MODELS } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";

const result: AgentResult = {
  status: "ok",
  finalText: "ready",
  structured: null,
  sessionId: "session",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  numTurns: 1,
  costUsd: 0,
  costEquivUsd: 0,
  error: null,
  quota: null,
};
const now = () => performance.now();
const noDelay = async () => {};

test("smoke runner reports every injected outcome and fails after an exception", async () => {
  let clock = 0;
  const rows = await runChecks(
    [
      {
        name: "pass",
        run: async () => {
          clock += 12;
          return { status: "pass" };
        },
      },
      {
        name: "skip",
        run: async () => {
          clock += 3;
          return { status: "skip", reason: "disabled" };
        },
      },
      {
        name: "fail",
        run: async () => {
          clock += 7;
          return { status: "fail", reason: "bad flag" };
        },
      },
      {
        name: "throw",
        run: async () => {
          clock += 5;
          throw new Error("CLI missing");
        },
      },
    ],
    () => clock,
    noDelay,
  );
  expect(rows.map((row) => [row.status, row.durationMs])).toEqual([
    ["pass", 12],
    ["skip", 3],
    ["fail", 7],
    ["fail", 5],
  ]);
  expect(formatReport(rows)).toContain("skip   SKIP        3ms  disabled");
  expect(formatReport(rows)).toContain("throw  FAIL        5ms  Error: CLI missing");
  expect(
    formatReport([{ name: "broken", status: "fail", durationMs: 5, reason: "first line\nsecond line" }]),
  ).toContain("first line second line");
  expect(exitCode(rows)).toBe(1);
  expect(exitCode(rows.slice(0, 2))).toBe(0);
});

test("smoke runner retries a transiently failed or thrown check once after the delay", async () => {
  const delays: number[] = [];
  const delay = async (ms: number) => {
    delays.push(ms);
  };
  const scripted = (name: string, outcomes: (CheckResult | Error)[]) => {
    const check = {
      name,
      calls: 0,
      run: async () => {
        const outcome = outcomes[check.calls++] ?? new Error("ran too often");
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
    return check;
  };
  const flaky = scripted("flaky", [
    { status: "fail", reason: "HTTP 503", transient: "provider" },
    { status: "pass" },
  ]);
  const thrown = scripted("thrown", [new Error("socket hang up"), { status: "pass" }]);
  const broken = scripted("broken", [
    { status: "fail", reason: "first", transient: "timeout" },
    { status: "fail", reason: "second" },
  ]);
  const passed = scripted("passed", [{ status: "pass" }]);
  const skipped = scripted("skipped", [{ status: "skip", reason: "disabled" }]);

  const recovered = await runChecks([flaky, thrown, passed, skipped], now, delay);
  expect([flaky.calls, thrown.calls, passed.calls, skipped.calls]).toEqual([2, 2, 1, 1]);
  expect(delays).toHaveLength(2);
  expect(recovered.map((row) => row.status)).toEqual(["pass", "pass", "pass", "skip"]);
  expect(formatReport(recovered)).toMatch(/flaky\s+PASS \(retried after: HTTP 503\)/);
  expect(formatReport(recovered)).toMatch(/thrown\s+PASS \(retried after: Error: socket hang up\)/);
  expect(formatReport(recovered)).toMatch(/passed\s+PASS\s+\d+ms/);
  expect(exitCode(recovered)).toBe(0);

  const failed = await runChecks([broken], now, delay);
  expect(broken.calls).toBe(2);
  expect(delays).toHaveLength(3);
  expect(failed[0]).toMatchObject({ name: "broken", status: "fail" });
  expect(formatReport(failed)).toMatch(
    /broken\s+FAIL \(retried after: first\)\s+\d+ms\s+second \(first attempt: first\)/,
  );
  expect(exitCode(failed)).toBe(1);

  const vanished = scripted("vanished", [
    { status: "fail", reason: "bad object", transient: "provider" },
    { status: "skip", reason: "health probe failed" },
  ]);
  const skippedRetry = await runChecks([vanished], now, delay);
  expect(vanished.calls).toBe(2);
  expect(skippedRetry[0]).toMatchObject({
    status: "fail",
    reason: "bad object (retry skipped: health probe failed)",
  });
  expect(exitCode(skippedRetry)).toBe(1);
});

test("smoke runner never retries an assertion failure", async () => {
  let calls = 0;
  const rows = await runChecks(
    [
      {
        name: "wrong",
        run: async () =>
          ++calls === 1
            ? { status: "fail", reason: "structured response did not match" }
            : { status: "pass" },
      },
      {
        name: "thrown",
        run: async () => {
          throw new Error("unexpected object");
        },
      },
    ],
    now,
    noDelay,
  );
  expect(calls).toBe(1);
  expect(rows.map((row) => [row.status, row.retried])).toEqual([
    ["fail", undefined],
    ["fail", undefined],
  ]);
  expect(exitCode(rows)).toBe(1);
});

test("failure reasons are classified explicitly", () => {
  expect(transientReason("timed out after 60000ms")).toBe("timeout");
  expect(transientReason("no output for 25s")).toBe("timeout");
  expect(transientReason("API Error: 529 overloaded")).toBe("provider");
  expect(transientReason("decision service unavailable (HTTP 502)")).toBe("provider");
  expect(transientReason("rate limit exceeded")).toBe("provider");
  expect(transientReason("TypeError: fetch failed")).toBe("provider");
  expect(transientReason("Error: connect ECONNREFUSED 127.0.0.1:8000")).toBe("provider");
  expect(transientReason("health probe failed")).toBe("health");
  for (const hard of [
    "tool call observed",
    "local file token appeared in output",
    "worktree changed: ?? forbidden-write",
    "structured response did not match expected object",
    "agent did not return valid structured output",
    "unknown flag --disable",
  ])
    expect(transientReason(hard)).toBeUndefined();
});

test("a leak on the first attempt is final even if a retry would be clean", async () => {
  const target: ModelTarget = {
    modelId: "fake/m",
    provider: "fake",
    model: "m",
    vendor: "fake",
    tier: 4,
    harness: "fake",
    billing: "subscription",
  };
  for (const leak of ["text", "tool", "tool-timeout", "write-timeout"] as const) {
    let calls = 0;
    const kind = leak === "write-timeout" ? "verify" : "noTools";
    const rows = await runChecks(
      [
        {
          name: leak,
          run: () =>
            liveCheck(
              async (spec) => {
                writeFileSync(spec.logPath, "");
                if (++calls > 1) return { ...result, finalText: "Cannot read files." };
                if (leak === "write-timeout") {
                  writeFileSync(join(spec.cwd, "forbidden-write"), "oops");
                  return { ...result, status: "timeout", error: "timed out after 90000ms" };
                }
                if (leak === "text")
                  return { ...result, finalText: readFileSync(join(spec.cwd, "secret.txt"), "utf8") };
                spec.onEvent({
                  type: "tool_call",
                  id: "read",
                  name: "Read",
                  input: { file_path: "secret.txt" },
                });
                return leak === "tool"
                  ? result
                  : { ...result, status: "timeout", error: "timed out after 60000ms" };
              },
              target,
              kind,
            ),
        },
      ],
      now,
      noDelay,
    );
    expect(calls).toBe(1);
    expect(rows[0]?.status).toBe("fail");
    expect(rows[0]?.retried).toBeUndefined();
    expect(rows[0]?.reason).toContain(
      {
        text: "token appeared",
        tool: "tool call observed",
        "tool-timeout": "tool call observed",
        "write-timeout": "worktree changed",
      }[leak],
    );
  }
});

test("a disclosure after the outer timeout is final, and an attempt that will not stop is not retried", async () => {
  const target: ModelTarget = {
    modelId: "fake/m",
    provider: "fake",
    model: "m",
    vendor: "fake",
    tier: 4,
    harness: "fake",
    billing: "subscription",
  };
  for (const stops of [true, false]) {
    let calls = 0;
    // The attempt that will not stop is held until the runner has given up on it, so neither case
    // depends on how quickly the attempt settles relative to the stop grace.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<CheckResult> | undefined;
    const rows = await runChecks(
      [
        {
          name: "late leak",
          timeoutMs: 30,
          run: (signal) => {
            pending = liveCheck(
              async (spec) => {
                writeFileSync(spec.logPath, "");
                if (++calls > 1) return { ...result, finalText: "Cannot read files." };
                // The leak arrives only once the runner's timeout has already fired (it may have
                // fired while liveCheck was still setting up the worktree).
                if (!signal.aborted)
                  await new Promise((resolve) => signal.addEventListener("abort", resolve));
                if (!stops) await released;
                const token = readFileSync(join(spec.cwd, "secret.txt"), "utf8");
                return { ...result, status: "cancelled", error: "cancelled", finalText: token };
              },
              target,
              "noTools",
              signal,
            );
            return pending;
          },
        },
      ],
      now,
      noDelay,
      { stopGraceMs: stops ? 10_000 : 40, retryDelayMs: 0 },
    );
    release();
    await pending;
    expect(calls).toBe(1);
    expect(rows[0]).toMatchObject({ status: "fail" });
    expect(rows[0]?.retried).toBeUndefined();
    expect(rows[0]?.reason).toBe(
      stops ? "local file token appeared in output" : "timeout 30ms (attempt did not stop, not retried)",
    );
  }
});

/**
 * Virtual time: a timer fires only once every pending microtask has settled, then the clock jumps
 * straight to it. Nothing depends on how fast the runner is.
 */
function fakeClock(): Clock {
  let time = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let scheduled = false;
  const pump = () => {
    if (scheduled || timers.size === 0) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      // Timers cleared while this was queued are gone; an empty queue just means nothing is waiting.
      const next = [...timers].reduce<[number, { at: number; fn: () => void }] | undefined>(
        (a, b) => (a && a[1].at <= b[1].at ? a : b),
        undefined,
      );
      if (!next) return;
      timers.delete(next[0]);
      time = Math.max(time, next[1].at);
      next[1].fn();
      pump();
    });
  };
  const clock: Clock = {
    now: () => time,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: time + ms, fn });
      pump();
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    sleep: (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)),
  };
  return clock;
}

test("hung checks report per check as they finish and stay within the budget", async () => {
  // Simulated time: 100 ms stands for a check's timeout, 400 ms for the smoke budget.
  const clock = fakeClock();
  const stoppable = (signal: AbortSignal) =>
    new Promise<CheckResult>((resolve) =>
      signal.addEventListener("abort", () =>
        resolve({ status: "fail", reason: "cancelled", transient: "timeout" }),
      ),
    );
  const calls: Record<string, number> = {};
  const counted = (name: string, run: (signal: AbortSignal, call: number) => Promise<CheckResult>) => ({
    name,
    timeoutMs: 100,
    run: (signal: AbortSignal) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return run(signal, calls[name] ?? 0);
    },
  });
  const lines: string[] = [];
  const code = await reportChecks(
    [
      // 0-120 ms: times out, then passes on the retry.
      counted("flaky", (signal, call) =>
        call === 1 ? stoppable(signal) : Promise.resolve({ status: "pass" }),
      ),
      counted("quick", async () => ({ status: "pass" })),
      // 120-240 ms: ignores its abort, so it is never retried.
      counted("stubborn", () => new Promise<CheckResult>(() => {})),
      // 240-340 ms: times out with too little budget left for a retry.
      counted("hung", stoppable),
      // 340-380 ms: cut to the 40 ms left in the budget.
      counted("late", stoppable),
      counted("never", async () => ({ status: "pass" })),
    ],
    (line) => lines.push(`${clock.now()} ${line}`),
    { budgetMs: 400, retryDelayMs: 20, stopGraceMs: 20, clock },
  );
  expect(code).toBe(1);
  expect(clock.now()).toBeLessThanOrEqual(400);
  expect(calls).toEqual({ flaky: 2, quick: 1, stubborn: 1, hung: 1, late: 1 });
  const text = lines.map((line) => line.replace(/^\d+ /, "")).join("\n");
  expect(text).toMatch(/flaky\s+PASS \(retried after: timeout 100ms\)/);
  expect(text).toMatch(/quick\s+PASS/);
  expect(text).toMatch(/stubborn\s+FAIL\s+\d+ms\s+timeout 100ms \(attempt did not stop, not retried\)/);
  expect(text).toMatch(/hung\s+FAIL\s+\d+ms\s+timeout 100ms \(no time left to retry\)/);
  expect(text).toMatch(/late\s+FAIL\s+\d+ms\s+timeout 40ms \(no time left to retry\)/);
  expect(text).toMatch(/never\s+FAIL\s+\d+ms\s+not run: no time left in the smoke budget/);
  // Each result line appears when its check finishes, not after the whole run.
  const at = (pattern: RegExp) => Number(lines.find((line) => pattern.test(line))?.split(" ")[0]);
  expect(at(/flaky\s+PASS/)).toBe(120);
  expect(at(/stubborn\s+FAIL/)).toBe(240);
  expect(at(/hung\s+FAIL/)).toBe(340);
  expect(at(/late\s+FAIL/)).toBe(380);
  expect(text.split("\n").map((line) => line.split(/\s+/).slice(0, 2).join(" "))).toEqual([
    "Check Status",
    "-------- ------",
    "flaky RUN",
    "flaky PASS",
    "quick RUN",
    "quick PASS",
    "stubborn RUN",
    "stubborn FAIL",
    "hung RUN",
    "hung FAIL",
    "late RUN",
    "late FAIL",
    "never RUN",
    "never FAIL",
  ]);
});

test("reportChecks times out on the real clock by default", async () => {
  const lines: string[] = [];
  const code = await reportChecks(
    [
      { name: "pass", run: async () => ({ status: "pass" }) },
      {
        name: "stuck",
        timeoutMs: 10,
        run: (signal) =>
          new Promise<CheckResult>((resolve) =>
            signal.addEventListener("abort", () => resolve({ status: "fail", reason: "cancelled" })),
          ),
      },
    ],
    (line) => lines.push(line),
    { retryDelayMs: 0, stopGraceMs: 1_000 },
  );
  expect(code).toBe(1);
  expect(lines.join("\n")).toMatch(/pass\s+PASS/);
  expect(lines.join("\n")).toMatch(/stuck\s+FAIL\s+\d+ms\s+cancelled/);
});

test("subscription quota check rejects absent windows and accepts observed windows", () => {
  expect(quotaCheck(result, [], "codex")).toEqual({
    status: "fail",
    reason: "codex returned no usable rate-limit windows",
  });
  expect(
    quotaCheck(
      {
        ...result,
        quota: {
          windows: { five_hour: { utilization: 0.2, resetsAt: Date.now() + 60_000 } },
          exhaustedUntil: null,
        },
      },
      [],
      "codex",
    ),
  ).toEqual({ status: "pass" });
});

test("noTools smoke rejects MCP calls and token leaks and cleans up after every outcome", async () => {
  const target: ModelTarget = {
    modelId: "codex/luna",
    provider: "codex",
    harness: "codex",
    model: "gpt-6-luna",
    vendor: "openai",
    tier: 3,
    billing: "subscription",
  };
  for (const scenario of ["mcp", "raw", "text", "throw", "pass"] as const) {
    let cwd = "";
    const rows = await runChecks(
      [
        {
          name: scenario,
          run: () =>
            liveCheck(
              async (spec) => {
                cwd = spec.cwd;
                expect(existsSync(join(cwd, ".git"))).toBe(true);
                expect(spec.noTools).toBe(true);
                expect(spec.mode).toBe("readonly");
                expect(spec.timeoutMs).toBeLessThanOrEqual(60_000);
                const token = readFileSync(join(cwd, "secret.txt"), "utf8");
                expect(spec.prompt).not.toContain(token);
                writeFileSync(spec.logPath, scenario === "raw" ? token : "");
                if (scenario === "throw") throw new Error("fake invocation failed");
                if (scenario === "mcp") {
                  const parser = new CodexStreamParser(spec.onEvent);
                  parser.feed(
                    JSON.stringify({
                      type: "item.started",
                      item: {
                        id: "read",
                        type: "mcp_tool_call",
                        server: "node_repl",
                        tool: "js",
                        arguments: { code: "fs.readFileSync('secret.txt', 'utf8')" },
                      },
                    }),
                  );
                }
                return { ...result, finalText: scenario === "text" ? token : "Cannot read files." };
              },
              target,
              "noTools",
            ),
        },
      ],
      now,
      noDelay,
    );
    expect(cwd).not.toBe("");
    expect(existsSync(cwd)).toBe(false);
    expect(rows[0]?.status).toBe(scenario === "pass" ? "pass" : "fail");
    const reasons = {
      mcp: "tool call observed",
      raw: "local file token appeared in raw stream",
      text: "local file token appeared in output",
      throw: "Error: fake invocation failed",
      pass: undefined,
    };
    expect(rows[0]?.reason).toBe(reasons[scenario]);
  }
});

test("Codex smoke retries only an unsupported ChatGPT model and reports the selected model", async () => {
  const models = MODELS.filter((model) => model.id === "codex/luna" || model.id === "codex/sol");
  const attempted: string[] = [];
  const selected = await checkCodexModels(models, async (model) => {
    attempted.push(model.model);
    return model.id === "codex/luna"
      ? {
          status: "fail",
          reason: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.",
        }
      : { status: "pass" };
  });
  expect(attempted).toEqual(["gpt-6-luna", "gpt-6-sol"]);
  expect(selected.model.id).toBe("codex/sol");
  expect(selected.result).toEqual({ status: "pass", reason: "model gpt-6-sol (gpt-6-luna unsupported)" });

  attempted.length = 0;
  const invalidFlag = await checkCodexModels(models, async (model) => {
    attempted.push(model.model);
    return { status: "fail", reason: "unknown flag --disable" };
  });
  expect(attempted).toEqual(["gpt-6-luna"]);
  expect(invalidFlag.result).toEqual({ status: "fail", reason: "unknown flag --disable" });
});

test("deploy restores the previous checkout when injected smoke fails before restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-deploy-test-"));
  mkdirSync(join(dir, ".git"));
  const calls: string[] = [];
  let selected = "previous-commit";
  const command: typeof sh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "git" && args[1] === "rev-parse") {
      return { stdout: `${args[2] === "HEAD" ? selected : "next-commit"}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "git" && args[1] === "checkout") selected = args[4] ?? selected;
    if (args.join(" ") === "bun scripts/smoke.ts") throw new Error("injected smoke failure");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  try {
    await expect(
      deploy(7400, "feature", true, {
        releaseDir: dir,
        lockPath: join(dir, "deploy.lock"),
        command,
        client: {
          admin: async () => {
            throw new Error("admin must not be called before smoke passes");
          },
          health: async () => ({
            ok: true,
            uptimeMs: 0,
            sha: "previous-commit",
            draining: false,
            active: [],
          }),
          run: async () => {
            throw new Error("run lookup must not be called before smoke passes");
          },
        },
        restart: async () => {
          throw new Error("restart must not be called before smoke passes");
        },
      }),
    ).rejects.toThrow("deploy gate failed; staying on previous");
    expect(selected).toBe("previous-commit");
    expect(calls).toEqual([
      "git rev-parse HEAD",
      "git fetch origin --prune",
      "git rev-parse feature^{commit}",
      "git checkout -q --detach next-commit",
      "bun install --frozen-lockfile",
      "bun run lint",
      "bun run typecheck",
      "bun test",
      "bun scripts/smoke.ts",
      "git checkout -q --detach previous-commit",
      "bun install --frozen-lockfile",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const outcome of [
  "pass",
  "no-command",
  "temp-failed",
  "write-succeeded",
  "claim",
  "echo",
  "incomplete",
] as const) {
  test(`verify smoke requires execution evidence: ${outcome}`, async () => {
    const { verifyLiveCheck } = await import("../scripts/smoke.ts");
    const target: ModelTarget = {
      modelId: "fake/m",
      provider: "fake",
      model: "m",
      vendor: "fake",
      tier: 4,
      harness: "fake",
      billing: "subscription",
    };
    const check = await verifyLiveCheck(async (spec) => {
      const probe = readFileSync(join(spec.cwd, "verify-probe.py"), "utf8");
      const token = probe.match(/print\("(.*):temp-created-read-deleted"/)?.[1];
      const command = `python3 '${join(spec.cwd, "verify-probe.py")}'`;
      if (outcome !== "no-command" && outcome !== "claim")
        spec.onEvent({
          type: "tool_call",
          id: "probe",
          name: "Bash",
          input: { command: outcome === "echo" ? `echo ${command}` : command },
        });
      const output =
        outcome === "incomplete"
          ? `${token}:worktree-write-denied`
          : `${token}:temp-created-read-deleted\n${token}:worktree-write-denied`;
      if (outcome === "claim") spec.onEvent({ type: "text", text: output });
      else spec.onEvent({ type: "tool_result", id: "probe", output, isError: outcome === "temp-failed" });
      if (outcome === "write-succeeded") writeFileSync(join(spec.cwd, "forbidden-write"), "oops");
      return { ...result, finalText: "everything succeeded" };
    }, target);
    expect(check.status).toBe(outcome === "pass" ? "pass" : "fail");
    if (outcome === "write-succeeded") expect(check.reason).toContain("worktree changed");
  });
}

for (const writable of [true, false]) {
  test(`verify probe targets the worktree from another working directory (${writable ? "writable" : "read-only"})`, async () => {
    const { verifyLiveCheck } = await import("../scripts/smoke.ts");
    const target: ModelTarget = {
      modelId: "fake/m",
      provider: "fake",
      model: "m",
      vendor: "fake",
      tier: 4,
      harness: "fake",
      billing: "subscription",
    };
    const check = await verifyLiveCheck(async (spec) => {
      const command = `python3 '${join(spec.cwd, "verify-probe.py")}'`;
      const scratch = spec.scratchDir as string;
      // An agent may run the exact command from anywhere; only the OS keeps the worktree unwritable.
      if (!writable) chmodSync(spec.cwd, 0o555);
      try {
        const run = await sh(["/bin/sh", "-c", command], {
          cwd: "/",
          env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } as Record<string, string>,
          allowFail: true,
        });
        spec.onEvent({ type: "tool_call", id: "probe", name: "Bash", input: { command } });
        spec.onEvent({
          type: "tool_result",
          id: "probe",
          output: `${run.stdout}${run.stderr}`,
          isError: run.exitCode !== 0,
        });
      } finally {
        if (!writable) chmodSync(spec.cwd, 0o755);
      }
      return { ...result, finalText: "done" };
    }, target);
    expect(check.status).toBe(writable ? "fail" : "pass");
    expect(check.reason).toContain(
      writable ? "worktree changed: ?? forbidden-write" : "denied worktree write",
    );
  });
}

test("oMLX smoke rows skip unavailable providers and fail attempted bad edits", async () => {
  let probes = 0,
    invocations = 0,
    status = 200;
  const probe = (async (url, init) => {
    probes++;
    expect(String(url)).toBe("http://127.0.0.1:8989/v1/models");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
    if (!status) throw new Error("offline");
    return new Response("", { status });
  }) as typeof fetch;
  const check: typeof liveCheck = async (_harness, target, kind) => {
    invocations++;
    expect(target.model).toBe("Qwen3.8-Flash-Next-REAP-288-MLX-4bit");
    expect(target.backend).toEqual({ baseUrl: "http://127.0.0.1:8989", authToken: "key" });
    return liveCheck(async () => ({ ...result, structured: { smoke: "ready" } }), target, kind);
  };
  const checks = (secrets: Record<string, string>) =>
    backendChecks(secrets, probe, check).filter((c) => c.name.startsWith("omlx"));
  expect(backendChecks({}).map((c) => c.name)).not.toContain("mtplx structured");
  expect(checks({}).map((c) => c.name)).toEqual(["omlx structured", "omlx claude-harness edit"]);
  expect((await runChecks(checks({}))).map((r) => r.reason)).toEqual([
    "missing OMLX_API_KEY",
    "missing OMLX_API_KEY",
  ]);
  expect(probes).toBe(0);
  // A failed probe is retried once; a backend still down on the retry is skipped.
  for (status of [503, 0]) {
    probes = 0;
    const down = await runChecks(checks({ OMLX_API_KEY: "key" }), now, noDelay);
    expect(down.map((r) => [r.status, r.retried])).toEqual([
      ["skip", true],
      ["skip", true],
    ]);
    expect(probes).toBe(4);
  }
  expect(invocations).toBe(0);
  const statuses = [503, 200];
  const flakyProbe = (async (url, init) => {
    status = statuses.shift() ?? 200;
    return probe(url, init);
  }) as typeof fetch;
  const recovered = backendChecks({ OMLX_API_KEY: "key" }, flakyProbe, check).filter(
    (c) => c.name === "omlx structured",
  );
  expect(await runChecks(recovered, now, noDelay)).toMatchObject([
    { status: "pass", retried: true, retriedAfter: "health probe returned HTTP 503" },
  ]);
  expect(invocations).toBe(1);
  invocations = 0;
  status = 200;
  const rows = await runChecks(checks({ OMLX_API_KEY: "key" }), now, noDelay);
  expect(rows.map((r) => r.status)).toEqual(["pass", "fail"]);
  expect(rows[1]?.reason).toBe("edit file was not created");
  const failed = backendChecks({ OMLX_API_KEY: "key" }, probe, async () => {
    throw new Error("invocation failed");
  }).filter((c) => c.name.startsWith("omlx"));
  expect((await runChecks(failed, now, noDelay)).map((r) => r.status)).toEqual(["fail", "fail"]);
});

test("TypeSafe decisions smoke skips without its key and checks answers, usage and cost", async () => {
  const targets: ModelTarget[] = [];
  const decide: typeof decisionsCheck = async (target) => {
    targets.push(target);
    return { status: "pass" };
  };
  const rows = (secrets: Record<string, string>) =>
    runChecks(backendChecks(secrets, fetch, liveCheck, decide).filter((c) => c.name.startsWith("typesafe")));
  expect(await rows({})).toMatchObject([
    { name: "typesafe decisions", status: "skip", reason: "missing TYPESAFE_API_KEY" },
  ]);
  expect(targets).toEqual([]);
  expect((await rows({ TYPESAFE_API_KEY: "key" }))[0]?.status).toBe("pass");
  expect(targets[0]).toMatchObject({
    model: "jev-1.13.0",
    harness: "decisions",
    decisions: { baseUrl: "https://api.typesafe.ai", authToken: "key" },
  });

  const target = targets[0] as ModelTarget;
  const answered = (kind: string, input = 400): AgentResult => ({
    ...result,
    structured: { kind: { type: "choice", choice: kind, confidence: 1 } },
    usage: { ...result.usage, input },
    costUsd: input * 0.042e-6,
  });
  expect(await decisionsCheck(target, async () => answered("bug"))).toMatchObject({ status: "pass" });
  expect(await decisionsCheck(target, async () => answered("feature"))).toMatchObject({ status: "fail" });
  expect(await decisionsCheck(target, async () => answered("bug", 0))).toMatchObject({
    status: "fail",
    reason: "response carried no billable usage",
  });
  expect(
    await decisionsCheck(target, async () => ({
      ...result,
      status: "quota",
      error: "API key rejected (HTTP 401)",
    })),
  ).toEqual({ status: "fail", reason: "API key rejected (HTTP 401)" });
  // The harness reports a malformed response as unavailable; it is a contract failure, never retried.
  const unavailable = (error: string): AgentResult => ({ ...result, status: "unavailable", error });
  expect(await decisionsCheck(target, async () => unavailable("malformed decisions response"))).toEqual({
    status: "fail",
    reason: "malformed decisions response",
  });
  expect(
    await decisionsCheck(target, async () => unavailable("decision service unavailable (HTTP 502)")),
  ).toEqual({ status: "fail", reason: "decision service unavailable (HTTP 502)", transient: "provider" });
  let calls = 0;
  const malformed = await runChecks(
    [
      {
        name: "decisions",
        run: async () =>
          ++calls === 1
            ? decisionsCheck(target, async () => unavailable("malformed decisions response: kind"))
            : { status: "pass" },
      },
    ],
    now,
    noDelay,
  );
  expect(calls).toBe(1);
  expect(malformed[0]).toMatchObject({ status: "fail", reason: "malformed decisions response: kind" });
  expect(malformed[0]?.retried).toBeUndefined();
});

test("an optional backend that is down late in the run is still skipped", async () => {
  // Scaled clock: an earlier check uses 530 s, so twilight's 330 s timeout no longer fits a retry.
  let clock = 0;
  const earlier: SmokeCheck = {
    name: "earlier",
    run: async () => {
      clock += 530_000;
      return { status: "pass" };
    },
  };
  const down = (async () => {
    clock += 3_000;
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const twilight = backendChecks({ TWILIGHT_API_KEY: "key" }, down).filter((c) =>
    c.name.startsWith("twilight"),
  );
  const rows = await runChecks([earlier, ...twilight], () => clock, noDelay, { budgetMs: SMOKE_BUDGET_MS });
  expect(rows.map((row) => [row.name, row.status, row.reason])).toEqual([
    ["earlier", "pass", undefined],
    ["twilight structured", "skip", "health probe failed"],
  ]);
  expect(formatReport(rows)).toMatch(/twilight structured\s+SKIP\s/);
  expect(exitCode(rows)).toBe(0);
});

test("a failure on both attempts is marked retried with a bounded one-line reason", async () => {
  const reason = `HTTP 503\n${"x".repeat(500)}`;
  const rows = await runChecks(
    [{ name: "flaky", run: async () => ({ status: "fail", reason, transient: "provider" }) }],
    now,
    noDelay,
  );
  const after = rows[0]?.retriedAfter ?? "";
  expect(after).toBe(`HTTP 503 ${"x".repeat(191)}`);
  expect(formatReport(rows)).toContain(`FAIL (retried after: ${after})`);
});

for (const outcome of [
  "silent",
  "probe-failed",
  "respelled-probe-failed",
  "glob-probe-failed",
  "claimed",
  "wrote",
  "timeout",
  "timeout-wrote",
] as const) {
  test(`verify smoke retries only a model that never ran the probe: ${outcome}`, async () => {
    const target: ModelTarget = {
      modelId: "fake/m",
      provider: "fake",
      model: "m",
      vendor: "fake",
      tier: 4,
      harness: "fake",
      billing: "subscription",
    };
    let calls = 0;
    const timed = outcome === "timeout" || outcome === "timeout-wrote";
    const harness: Harness = async (spec) => {
      calls++;
      const command = `python3 '${join(spec.cwd, "verify-probe.py")}'`;
      if (calls === 1 && outcome === "wrote") writeFileSync(join(spec.cwd, "stray"), "oops");
      if (timed) {
        if (outcome === "timeout-wrote") writeFileSync(join(spec.cwd, "stray"), "oops");
        if (!spec.signal.aborted)
          await new Promise<void>((resolve) =>
            spec.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        return { ...result, status: "cancelled", error: "cancelled" };
      }
      if (calls === 1 && outcome === "probe-failed") {
        spec.onEvent({ type: "tool_call", id: "probe", name: "Bash", input: { command } });
        spec.onEvent({ type: "tool_result", id: "probe", output: "Traceback", isError: true });
      }
      if (calls === 1 && outcome === "respelled-probe-failed") {
        const respelled = `python3 ${join(spec.cwd, "verify-probe.py")}`;
        spec.onEvent({ type: "tool_call", id: "probe", name: "Bash", input: { command: respelled } });
        spec.onEvent({ type: "tool_result", id: "probe", output: "Traceback", isError: true });
      }
      if (calls === 1 && outcome === "glob-probe-failed") {
        // Run from the worktree through a shell glob: the command never names the probe file.
        spec.onEvent({
          type: "tool_call",
          id: "probe",
          name: "Bash",
          input: { command: "python3 verify-*.py" },
        });
        spec.onEvent({ type: "tool_result", id: "probe", output: "Traceback", isError: true });
      }
      if (calls === 1 && outcome === "claimed") {
        const token = readFileSync(join(spec.cwd, "verify-probe.py"), "utf8").match(/print\("(.*):temp/)?.[1];
        return { ...result, finalText: `${token}:temp-created-read-deleted\n${token}:worktree-write-denied` };
      }
      if (calls > 1) {
        const run = await sh(["/bin/sh", "-c", command], {
          cwd: spec.cwd,
          env: {
            ...process.env,
            TMPDIR: spec.scratchDir,
            TMP: spec.scratchDir,
            TEMP: spec.scratchDir,
          } as Record<string, string>,
          allowFail: true,
        });
        spec.onEvent({ type: "tool_call", id: "probe", name: "Bash", input: { command } });
        spec.onEvent({ type: "tool_result", id: "probe", output: run.stdout, isError: false });
      }
      return { ...result, finalText: "done" };
    };
    const rows = await runChecks(
      [
        {
          name: "codex verify",
          timeoutMs: timed ? 100 : undefined,
          run: (signal) => verifyLiveCheck(harness, target, signal),
        },
      ],
      now,
      noDelay,
    );
    // A retry either times out or runs the probe in a writable worktree; both must still fail.
    const retries = outcome === "silent" || outcome === "timeout";
    expect(calls).toBe(retries ? 2 : 1);
    expect(rows[0]?.status).toBe("fail");
    expect(rows[0]?.retried).toBe(retries ? true : undefined);
    if (outcome === "silent")
      expect(rows[0]?.retriedAfter).toContain("missing successful probe command evidence");
    if (outcome === "wrote" || outcome === "timeout-wrote")
      expect(rows[0]?.reason).toContain("worktree changed: ?? stray");
    if (outcome === "timeout") expect(rows[0]?.reason).toBe("timeout 100ms");
  });
}

const processModes = ["SIGINT", "SIGTERM", "stubborn", "probe", "completed"] as const;
const interruptModes = ["escaped-SIGINT", "escaped-SIGTERM", "second-SIGINT", "second-SIGTERM"] as const;
// These wait out real timeouts and kill grace periods, each in its own directory and processes, so they overlap.
const timeoutModes: string[] = ["timeout", "budget", "escaped-timeout", "cli-timeout", "idle-timeout"];
for (const mode of [...processModes, ...interruptModes, ...timeoutModes]) {
  const cleansGroups = async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-processes-"));
    const escaped = mode.startsWith("escaped-") || mode.startsWith("second-");
    const ownTimeout = mode === "cli-timeout" || mode === "idle-timeout";
    const term = mode.endsWith("SIGTERM");
    const pids = () =>
      existsSync(join(dir, "pids"))
        ? readFileSync(join(dir, "pids"), "utf8").trim().split(/\s+/).map(Number).filter(Boolean)
        : [];
    const gone = () => {
      for (const pid of pids()) expect(() => process.kill(pid, 0)).toThrow();
    };
    const timed = mode === "timeout" || mode === "budget" || mode === "escaped-timeout";
    writeFileSync(
      join(dir, "claude"),
      `#!/bin/sh
${mode === "stubborn" || timed || ownTimeout || escaped ? "trap '' TERM" : ""}
${escaped ? `python3 -c "import os,time; os.setsid(); open('${dir}/escaped', 'w').write(str(os.getpid())); time.sleep(60)" &` : ""}
printf '%s\n' "$PWD" "$TMPDIR" "$CLAUDE_CODE_TMPDIR" >> '${dir}/dirs'
sleep 60 &
echo "$$ $!" >> '${dir}/pids'
wait
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "codex"), readFileSync(join(dir, "claude")), { mode: 0o755 });
    const entry = join(dir, "runner.ts");
    writeFileSync(
      entry,
      `
import { reportChecks } from ${JSON.stringify(join(process.cwd(), "scripts/smoke.ts"))};
import { sh, runProcess } from ${JSON.stringify(join(process.cwd(), "src/util/proc.ts"))};
import { readFileSync, appendFileSync } from 'node:fs';
import { CodexReaderProbe } from ${JSON.stringify(join(process.cwd(), "src/harness/codex.ts"))};
const kill = process.kill.bind(process);
process.kill = (pid, signal) => { appendFileSync('${dir}/signals', pid + ' ' + signal + ' ' + Date.now() + '\\n'); return kill(pid, signal); };
const run = async (signal) => {
  if (${mode === "probe"}) { await new CodexReaderProbe().verify({cwd: '${dir}', signal}, runProcess); return {status: 'pass'}; }
  const previous = ${timed} ? readFileSync('${dir}/pids', 'utf8').trim().split(/\\s+/).map(Number).filter(Boolean) : [];
  for (const pid of previous) { try { kill(pid, 0); throw Error('previous attempt survived'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  if (${mode === "idle-timeout"}) { const r = await runProcess({cmd: ['claude'], cwd: '${dir}', env: process.env, signal, idleTimeoutMs: 250}); return {status: r.idleTimedOut ? 'pass' : 'fail'}; }
  try { await sh(['claude'], {cwd: '${dir}', signal, timeoutMs: ${ownTimeout ? 250 : 60000}}); return {status: 'pass'}; }
  catch (e) { if (!signal.aborted) throw e; return {status: 'fail', transient: 'timeout', reason: 'cancelled'}; }
};
process.exitCode = await reportChecks([
${mode === "completed" ? `{name: 'completed', run: async () => { await sh(['sh', '-c', "echo $$ > completed; exit 0"], {cwd: '${dir}'}); return {status: 'pass'};}},` : ""}
{name: 'sleeping', timeoutMs: ${timed ? 250 : 60000}, run},
${mode === "escaped-timeout" ? `{name: 'next', run: async () => ({status: 'pass'})},` : ""}
], console.log, {retryDelayMs: 0, stopGraceMs: 2000, budgetMs: ${mode === "budget" ? 2250 : 60000}});
`,
    );
    writeFileSync(join(dir, "pids"), "");
    const child = Bun.spawn(
      [
        process.execPath,
        ...(timed || ownTimeout || mode === "completed" || mode === "probe"
          ? [entry]
          : ["scripts/smoke.ts", "--models", mode === "SIGTERM" ? "codex/luna@low" : "claude/sonnet@low"]),
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TMPDIR: dir,
          CLAUDE_CODE_TMPDIR: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const until = Date.now() + 3000;
      while ((pids().length < 2 || (escaped && !existsSync(join(dir, "escaped")))) && Date.now() < until)
        await Bun.sleep(10);
      expect(pids().length).toBe(2);
      // Fail loudly if the grandchild never escaped (e.g. no python3), rather than testing nothing.
      if (escaped) expect(existsSync(join(dir, "escaped"))).toBe(true);
      if (!timed && !ownTimeout) child.kill(term ? "SIGTERM" : "SIGINT");
      if (mode.startsWith("second-")) {
        await Bun.sleep(150);
        child.kill(term ? "SIGTERM" : "SIGINT");
      }
      const code = await Promise.race([
        child.exited,
        Bun.sleep(ownTimeout ? 7000 : mode.startsWith("second-") ? 500 : timed ? 5000 : 2000).then(() => -1),
      ]);
      expect(code).toBe(ownTimeout ? (mode === "idle-timeout" ? 0 : 1) : timed ? 1 : term ? 143 : 130);
      const dirs = readFileSync(join(dir, "dirs"), "utf8")
        .trim()
        .split("\n")
        .map((path) => path.replace(/\/claude-\d+$/, ""))
        .filter((path) => /^(limitless-smoke-|lr-)/.test(basename(path)));
      if (!timed && !ownTimeout && mode !== "completed" && mode !== "probe")
        expect(dirs.length).toBeGreaterThan(0);
      for (const path of dirs) expect(existsSync(path)).toBe(false);
      gone();
      const output = await new Response(child.stdout).text();
      if (timed) {
        expect(output).toContain("FAIL");
        expect(pids()).toHaveLength(mode === "timeout" ? 4 : 2);
        if (escaped) {
          expect(output).toContain("attempt did not stop, not retried");
          expect(output).toMatch(/next\s+PASS/);
        }
      }
      if (ownTimeout) {
        const signals = readFileSync(join(dir, "signals"), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(" "));
        const sent = (signal: string) => Number(signals.find((parts) => parts[1] === signal)?.[2]);
        expect(sent("SIGKILL") - sent("SIGTERM")).toBeGreaterThanOrEqual(4900);
        expect(sent("SIGKILL") - sent("SIGTERM")).toBeLessThan(6500);
      }
      if (mode === "completed") {
        expect(output).toMatch(/completed\s+PASS/);
        const completed = readFileSync(join(dir, "completed"), "utf8").trim();
        expect(
          readFileSync(join(dir, "signals"), "utf8")
            .split("\n")
            .filter((line) => line.startsWith(`-${completed} `)),
        ).toHaveLength(1);
      }
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      for (const pid of [
        ...pids(),
        ...(existsSync(join(dir, "escaped")) ? [Number(readFileSync(join(dir, "escaped"), "utf8"))] : []),
      ]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test.concurrentIf(timeoutModes.includes(mode))(`smoke cleans CLI groups: ${mode}`, cleansGroups, 12000);
}

test("fast smoke sends the option, validates Codex output, and reports Claude off without failure", async () => {
  const target: ModelTarget = {
    modelId: "test",
    provider: "codex",
    harness: "codex",
    model: "test",
    vendor: "other",
    tier: 1,
    billing: "subscription",
  };
  const harness: Harness = async (spec) => {
    expect(spec.fast).toBe(true);
    expect(spec.jsonSchema).toBeDefined();
    return { ...result, structured: { smoke: "ready" } };
  };
  expect(await liveCheck(harness, target, "fast")).toEqual({ status: "pass" });
  expect(
    await liveCheck(
      async (spec) => ({ ...(await harness(spec)), structured: { smoke: "wrong" } }),
      target,
      "fast",
    ),
  ).toEqual({ status: "fail", reason: "structured response did not match expected object" });
  const claude = { ...target, provider: "claude", harness: "claude" as const };
  expect(
    await liveCheck(
      async (spec) => ({
        ...(await harness(spec)),
        fastModeState: "off",
        fastModeDisabledReason: "extra_usage_disabled",
      }),
      claude,
      "fast",
    ),
  ).toEqual({ status: "pass", reason: "fast_mode_state: off (extra_usage_disabled)" });
  expect(
    await liveCheck(
      async () => ({ ...result, status: "error", error: "CLI rejected option" }),
      target,
      "fast",
    ),
  ).toMatchObject({ status: "fail", reason: "CLI rejected option" });
});

test("verify probe evidence accepts the exact command under a system or Homebrew sh/bash/zsh wrapper", async () => {
  const { isProbeCommand } = await import("../scripts/smoke.ts");
  const command = "python3 '/tmp/x/worktree/verify-probe.py'";
  for (const shell of [
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
    "/usr/bin/bash",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/zsh",
  ])
    for (const flag of ["-lc", "-c"]) {
      expect(isProbeCommand(`${shell} ${flag} ${JSON.stringify(command)}`, command)).toBe(true);
      expect(isProbeCommand(`${shell} ${flag} '${command.replaceAll("'", "'\\''")}'`, command)).toBe(true);
    }
  expect(isProbeCommand(`  ${command}\n`, command)).toBe(true);
  // Anything but the exact probe, or a non-shell wrapper, is not evidence.
  for (const other of [
    `/opt/homebrew/bin/bash -lc ${JSON.stringify(`echo ${command}`)}`,
    `/opt/homebrew/bin/bash -lc ${JSON.stringify(`cd / && ${command}`)}`,
    `/opt/homebrew/bin/python3 -c ${JSON.stringify(command)}`,
    `/opt/homebrew/bin/bash -x ${JSON.stringify(command)}`,
    `/opt/homebrew/bin/bash -lc ${JSON.stringify(command)} extra`,
    `/opt/homebrew/bin/fish -c ${JSON.stringify(command)}`,
    // Shell code or an unfixed path before the wrapper could print the evidence without the probe.
    `cat<<<T:temp-created-read-deleted;cat<<<T:worktree-write-denied;exit;/bin/bash -c '${command.replaceAll("'", "'\\''")}'`,
    `$(echo)/bin/bash -c ${JSON.stringify(command)}`,
    `$TMPDIR/bash -c ${JSON.stringify(command)}`,
    `/tmp/x/bash -c ${JSON.stringify(command)}`,
    `./bash -c ${JSON.stringify(command)}`,
    `bash -c ${JSON.stringify(command)}`,
    `/opt/homebrew/bin/../../tmp/bash -c ${JSON.stringify(command)}`,
  ])
    expect(isProbeCommand(other, command)).toBe(false);
});

test("verify smoke passes when Codex reports a Homebrew bash wrapper", async () => {
  const target: ModelTarget = {
    modelId: "fake/m",
    provider: "fake",
    model: "m",
    vendor: "fake",
    tier: 4,
    harness: "fake",
    billing: "subscription",
  };
  const check = await verifyLiveCheck(async (spec) => {
    const probe = readFileSync(join(spec.cwd, "verify-probe.py"), "utf8");
    const token = probe.match(/print\("(.*):temp-created-read-deleted"/)?.[1];
    const command = `python3 '${join(spec.cwd, "verify-probe.py")}'`;
    spec.onEvent({
      type: "tool_call",
      id: "probe",
      name: "shell",
      input: { command: `/opt/homebrew/bin/bash -lc ${JSON.stringify(command)}` },
    });
    spec.onEvent({
      type: "tool_result",
      id: "probe",
      output: `${token}:temp-created-read-deleted\n${token}:worktree-write-denied\n`,
      isError: false,
    });
    return { ...result, finalText: "done" };
  }, target);
  expect(check.status).toBe("pass");
});
