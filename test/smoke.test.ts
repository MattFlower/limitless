import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendChecks,
  type CheckResult,
  checkCodexModels,
  decisionsCheck,
  exitCode,
  formatReport,
  liveCheck,
  quotaCheck,
  reportChecks,
  runChecks,
  transientReason,
} from "../scripts/smoke.ts";
import { deploy } from "../src/cli/service.ts";
import { CodexStreamParser } from "../src/harness/codex.ts";
import type { AgentResult, ModelTarget } from "../src/harness/types.ts";
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
  expect(formatReport(failed)).toMatch(/broken\s+FAIL\s+\d+ms\s+second \(first attempt: first\)/);
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
    const rows = await runChecks(
      [
        {
          name: "late leak",
          timeoutMs: 30,
          run: (signal) =>
            liveCheck(
              async (spec) => {
                writeFileSync(spec.logPath, "");
                if (++calls > 1) return { ...result, finalText: "Cannot read files." };
                // The leak arrives only once the runner's timeout has already fired.
                await new Promise((resolve) => signal.addEventListener("abort", resolve));
                if (!stops) await Bun.sleep(80);
                const token = readFileSync(join(spec.cwd, "secret.txt"), "utf8");
                return { ...result, status: "cancelled", error: "cancelled", finalText: token };
              },
              target,
              "noTools",
              signal,
            ),
        },
      ],
      now,
      noDelay,
      { stopGraceMs: 40, retryDelayMs: 0 },
    );
    expect(calls).toBe(1);
    expect(rows[0]).toMatchObject({ status: "fail" });
    expect(rows[0]?.retried).toBeUndefined();
    expect(rows[0]?.reason).toBe(
      stops ? "local file token appeared in output" : "timeout 30ms (attempt did not stop, not retried)",
    );
  }
});

test("hung checks report per check as they finish and stay within the budget", async () => {
  // Time-scaled: 100 ms stands for a check's timeout, 400 ms for the smoke budget.
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
  const began = performance.now();
  const code = await reportChecks(
    [
      // ~0-120 ms: times out, then passes on the retry.
      counted("flaky", (signal, call) =>
        call === 1 ? stoppable(signal) : Promise.resolve({ status: "pass" }),
      ),
      counted("quick", async () => ({ status: "pass" })),
      // ~120-240 ms: ignores its abort, so it is never retried.
      counted("stubborn", () => new Promise<CheckResult>(() => {})),
      // ~240-340 ms: times out with too little budget left for a retry.
      counted("hung", stoppable),
      // ~340-380 ms: cut to the ~40 ms left in the budget.
      counted("late", stoppable),
      counted("never", async () => ({ status: "pass" })),
    ],
    (line) => lines.push(`${Math.round(performance.now() - began)} ${line}`),
    { budgetMs: 400, retryDelayMs: 20, stopGraceMs: 20 },
  );
  const elapsed = performance.now() - began;
  expect(code).toBe(1);
  expect(elapsed).toBeLessThan(420);
  expect(calls).toEqual({ flaky: 2, quick: 1, stubborn: 1, hung: 1, late: 1 });
  const text = lines.map((line) => line.replace(/^\d+ /, "")).join("\n");
  expect(text).toMatch(/flaky\s+PASS \(retried after: timeout 100ms\)/);
  expect(text).toMatch(/quick\s+PASS/);
  expect(text).toMatch(/stubborn\s+FAIL\s+\d+ms\s+timeout 100ms \(attempt did not stop, not retried\)/);
  expect(text).toMatch(/hung\s+FAIL\s+\d+ms\s+timeout 100ms \(no time left to retry\)/);
  expect(text).toMatch(/late\s+FAIL\s+\d+ms\s+timeout \d{1,2}ms \(no time left to retry\)/);
  expect(text).toMatch(/never\s+FAIL\s+\d+ms\s+not run: no time left in the smoke budget/);
  // Each result line appears when its check finishes, not after the whole run.
  const at = (pattern: RegExp) => Number(lines.find((line) => pattern.test(line))?.split(" ")[0]);
  expect(at(/flaky\s+PASS/)).toBeLessThan(at(/hung\s+FAIL/) - 150);
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
    expect(target.model).toBe("Swift-1.5-Qwen3.8-27b-oQ8e-mtp");
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
});
