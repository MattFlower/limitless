import { describe, expect, spyOn } from "bun:test";
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
import { delimiter, dirname, join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import { buildClaudeArgs, ClaudeStreamParser, runClaude } from "../src/harness/claude.ts";
import {
  buildCodexArgs,
  CodexReaderProbe,
  CodexStreamParser,
  parseRateLimits,
  runCodex,
} from "../src/harness/codex.ts";
import { readPolicyScope } from "../src/harness/read-policy.ts";
import {
  type ConfinementBackend,
  confinementScope,
  seatbeltBackend,
  verifySeatbelt,
} from "../src/harness/sandbox.ts";
import { withScratch, writeRoots } from "../src/harness/scratch.ts";
import { signalCommand } from "../src/harness/signals.ts";
import { parseFakeStream } from "../src/harness/stream-fault.ts";
import {
  type AgentEvent,
  type AgentSpec,
  extractJson,
  LoopDetector,
  priceOf,
  redactJsonLine,
} from "../src/harness/types.ts";
import { redactHoldoutText } from "../src/pipeline/prompts.ts";
import { agentEnv, type ProcOptions, runProcess } from "../src/util/proc.ts";
import { fakeConfinement, seatbeltSkip } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import { providerFixture } from "./provider-config-support.ts";
import { test, testReadPolicy } from "./read-policy-support.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean);

describe("ClaudeStreamParser", () => {
  test("parses a real stream-json run with structured output and rate limits", () => {
    const events: AgentEvent[] = [];
    const p = new ClaudeStreamParser((e) => events.push(e));
    for (const line of fixture("claude-structured.jsonl")) p.feed(line);

    expect(p.gotResult).toBe(true);
    expect(p.isError).toBe(false);
    expect(p.sessionId).toBeTruthy();
    expect(p.structured).toEqual({
      lines: 1,
      pushed: "Permission denied - git push origin main was not allowed to execute",
    });
    expect(p.usage.output).toBeGreaterThan(0);
    expect(p.reportedCostUsd).toBeGreaterThan(0);

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((c) => (c as { name: string }).name)).toContain("Bash");
    const results = events.filter((e) => e.type === "tool_result") as { isError: boolean; output: string }[];
    expect(results.some((r) => r.isError && r.output.includes("denied"))).toBe(true);
    expect(events[0]?.type).toBe("init");
  });

  test("captures unified quota windows from rate_limit_event", () => {
    const p = new ClaudeStreamParser(() => {});
    for (const line of fixture("claude-basic.jsonl")) p.feed(line);
    expect(p.windows.five_hour?.utilization).toBeCloseTo(0.06);
    expect(p.windows.seven_day?.utilization).toBeCloseTo(0.01);
    expect(p.windows.five_hour?.resetsAt).toBeGreaterThan(1_700_000_000_000);
    expect(p.quotaRejectedUntil).toBeNull();
  });

  test("records cache writes with their duration, priced at the 1-hour rate", () => {
    const p = new ClaudeStreamParser(() => {});
    for (const line of fixture("claude-basic.jsonl")) p.feed(line);
    // The CLI wrote the whole 35,377-token prompt to the 1-hour cache.
    expect([p.usage.input, p.usage.output, p.usage.cacheRead, p.usage.cacheWrite]).toEqual([
      18, 224, 33_921, 35_377,
    ]);
    expect(p.usage.cacheWrite1h).toBe(35_377);
    // 18 uncached and 35,377 written at 2x input, 33,921 read at the discount, 224 output.
    expect(priceOf(p.usage, { input: 3, output: 15, cacheRead: 0.3 })).toBeCloseTo(0.2258523, 10);
  });

  test("detects a rejected rate limit as quota exhaustion", () => {
    const p = new ClaudeStreamParser(() => {});
    p.feed(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, rateLimitType: "five_hour" },
      }),
    );
    expect(p.quotaRejectedUntil).toBe(1_900_000_000_000);
  });

  test("tolerates non-JSON lines", () => {
    const events: AgentEvent[] = [];
    const p = new ClaudeStreamParser((e) => events.push(e));
    p.feed("not json at all");
    expect(events[0]).toEqual({ type: "status", text: "not json at all" });
  });

  // Only these checks see a missing result: in a run, requireStructured turns the null output of a
  // truncated stream back into an error and the invoke catch absorbs a throwing parser.
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" });
  const text = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "partial" }] },
  });
  const result = (isError: boolean) =>
    JSON.stringify({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      session_id: "s1",
      num_turns: 1,
      result: isError ? "run failed" : "done",
      structured_output: { ok: true },
    });
  test.each([
    ["no result event", [init, text], "claude exited with 0 and no result"],
    [
      "a result line cut off mid-object",
      [init, text, '{"type":"result"'],
      "claude exited with 0 and no result",
    ],
    ["an error result", [init, text, result(true)], "run failed"],
    ["a successful result", [init, text, result(false)], null],
  ])("a claude stream with %s completes only on a successful result", async (_, lines, cliError) => {
    const ok = cliError === null;
    const seam = parseFakeStream({ parser: "claude", lines }, () => {});
    expect(seam.status).toBe(ok ? "ok" : "error");
    expect(seam.error).toBe(
      ok ? null : "malformed or truncated harness stream: missing successful completion",
    );
    const dir = mkdtempSync(join(tmpdir(), "limitless-claude-stream-"));
    try {
      const outcome = await runClaude(
        {
          cwd: dir,
          prompt: "x",
          mode: "readonly",
          noTools: true,
          target: {
            modelId: "c/m",
            provider: "claude",
            harness: "claude",
            model: "m",
            vendor: "anthropic",
            tier: 4,
            billing: "subscription",
          },
          timeoutMs: 10_000,
          idleTimeoutMs: 10_000,
          maxToolCalls: 0,
          signal: new AbortController().signal,
          logPath: join(dir, "log"),
          onEvent: () => {},
        },
        async (opts) => {
          for (const line of lines) opts.onStdoutLine?.(line);
          return {
            exitCode: 0,
            signal: null,
            truncated: false,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            idleTimedOut: false,
            cancelled: false,
          };
        },
      );
      expect(outcome.status).toBe(ok ? "ok" : "error");
      expect(outcome.error).toBe(cliError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CodexStreamParser", () => {
  test("disables default tools for a blind structured call", async () => {
    const spec: AgentSpec = {
      cwd: "/tmp/isolated",
      prompt: "Write scenarios",
      target: {
        modelId: "codex/sol",
        provider: "codex",
        harness: "codex",
        model: "gpt-6-sol",
        vendor: "openai",
        tier: 4,
        billing: "subscription",
      },
      mode: "readonly",
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 0,
      noTools: true,
      privateSession: true,
      signal: new AbortController().signal,
      logPath: "/tmp/isolated/inv.log",
      onEvent: () => {},
    };
    const args = buildCodexArgs(spec);
    expect(args.join(" ")).toContain("--disable shell_tool --disable multi_agent");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("--strict-config");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("read-only");
    await withScratch(import.meta.dir, async (scratchDir) => {
      expect(buildCodexArgs({ ...spec, cwd: import.meta.dir, scratchDir, noTools: false })).not.toContain(
        "shell_tool",
      );
    });

    // Smoke calls are not private: they must still isolate tools without losing quota rollouts.
    const smokeArgs = buildCodexArgs({ ...spec, privateSession: false });
    expect(smokeArgs).toContain("--ignore-user-config");
    expect(smokeArgs).not.toContain("--ephemeral");
    expect(smokeArgs).toContain("orchestrator.mcp.enabled=false");
    for (const feature of ["apps", "plugins", "code_mode", "view_image"]) {
      expect(smokeArgs.join(" ")).toContain(`--disable ${feature}`);
    }
    const edit = { ...spec, privateSession: false, noTools: false, mode: "edit" as const };
    expect(() => buildCodexArgs(edit)).toThrow("requires a scratch directory");
    await withScratch(import.meta.dir, async (scratchDir) => {
      // Editors are confined too: no user config, rules, MCP servers or implicit workspace-write roots.
      const editArgs = buildCodexArgs({ ...edit, cwd: import.meta.dir, scratchDir });
      for (const flag of [
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "orchestrator.mcp.enabled=false",
      ])
        expect(editArgs).toContain(flag);
      expect(editArgs).not.toContain("workspace-write");
      expect(editArgs).not.toContain('web_search="disabled"');
    });
  });

  test("parses a real codex exec --json run", () => {
    const events: AgentEvent[] = [];
    const p = new CodexStreamParser((e) => events.push(e));
    for (const line of fixture("codex-basic.jsonl")) p.feed(line);
    expect(p.threadId).toBeTruthy();
    expect(p.lastMessage).toBe("hello");
    expect(p.completed).toBe(true);
    expect(p.usage.cacheRead).toBe(29056);
    expect(p.usage.input).toBe(43706 - 29056);
    // Codex never writes to a cache: only reads are split off the prompt.
    expect(p.usage.cacheWrite).toBe(0);
    expect(priceOf(p.usage, { input: 2, output: 10 })).toBeCloseTo((14650 * 2 + 29056 * 0.2 + 40 * 10) / 1e6);
    const call = events.find((e) => e.type === "tool_call") as { input: { command: string } };
    expect(call.input.command).toContain("cat a.txt");
    const result = events.find((e) => e.type === "tool_result") as { output: string; isError: boolean };
    expect(result.output.trim()).toBe("hello");
    expect(result.isError).toBe(false);
  });

  test("records turn failures", () => {
    const p = new CodexStreamParser(() => {});
    p.feed(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit" } }));
    expect(p.failed).toContain("usage limit");
  });

  test("reads rate limits from a rollout file", () => {
    const rollout = [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 19.0, window_minutes: 10080, resets_at: 1789867141 },
            secondary: { used_percent: 42.5, window_minutes: 300, resets_at: 1789800000 },
            plan_type: "prolite",
          },
        },
      }),
    ].join("\n");
    const w = parseRateLimits(rollout);
    expect(w?.seven_day?.utilization).toBeCloseTo(0.19);
    expect(w?.seven_day?.resetsAt).toBe(1789867141000);
    expect(w?.five_hour?.utilization).toBeCloseTo(0.425);
  });
});

// Tool-enabled editors run confined (#323): they need scratch, and a fake runner that swaps the
// command keeps the sandbox's startup wrapper (the identity backend adds no profile).
const confinedEdit = <T>(cwd: string, run: (scratchDir: string) => Promise<T>) =>
  confinementScope.run(fakeConfinement, () =>
    withScratch(cwd, (scratchDir) => {
      // Injected runners inspect a controlled policy without touching the owner's credential paths.
      const home = join(dirname(scratchDir), "home");
      mkdirSync(home);
      return readPolicyScope.run({ ...testReadPolicy, home, environment: {} }, () => run(scratchDir));
    }),
  );
const swapCommand = (cmd: string[], replacement: string[]) =>
  cmd[4]?.startsWith("limitless-started-") ? [...cmd.slice(0, 5), ...replacement] : replacement;
// A confined Codex editor runs only on a CLI whose sandbox was verified; this stub stands in for that probe.
const verifiedCodex: typeof runClaude = (spec, runner) =>
  runCodex(spec, runner, {
    resolve: () => "codex",
    verify: async () => ({ ok: true, path: "codex", version: "test", reason: null, exitCode: null }),
  } as unknown as CodexReaderProbe);

test.each(["accepted", "stream rejection", "stderr rejection"])(
  "factory Claude subscription authentication: %s",
  async (outcome) => {
    const rejected = outcome !== "accepted";
    const token = `subscription-${crypto.randomUUID()}`;
    const keys = [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
    ];
    const previous = keys.map((key) => process.env[key]);
    const config = providerFixture([], `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    const store = new Store(":memory:");
    let factory: Factory | undefined;
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const cfg = config.load();
      for (const key of keys.slice(0, 3)) process.env[key] = `inherited-${crypto.randomUUID()}`;
      const userConfig = join(config.root, "claude-config");
      mkdirSync(userConfig);
      process.env.CLAUDE_CONFIG_DIR = userConfig;
      for (const path of [userConfig, join(config.work, ".claude")]) {
        mkdirSync(path, { recursive: true });
        for (const name of ["settings.json", "settings.local.json"])
          writeFileSync(join(path, name), JSON.stringify({ apiKeyHelper: "exit 99" }));
      }
      let launches = 0;
      const launch = async (opts: ProcOptions) => {
        launches++;
        // Editors receive a startup wrapper from runSandboxed, followed by the actual Claude args.
        if (opts.cmd[4]?.startsWith("limitless-started-")) opts.onStdoutLine?.(opts.cmd[4]);
        const settingsIndex = opts.cmd.indexOf("--settings");
        const settings = JSON.parse(settingsIndex < 0 ? "{}" : (opts.cmd[settingsIndex + 1] ?? "{}"));
        const backend = opts.env?.ANTHROPIC_BASE_URL !== undefined;
        expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        if (backend) {
          expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
          expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
          expect(readFileSync(JSON.parse(settings.apiKeyHelper.slice(4)), "utf8")).toBe("backend-key");
        } else {
          expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
          expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
          expect(settings.apiKeyHelper).toBeUndefined();
          expect(opts.cmd[opts.cmd.indexOf("--setting-sources") + 1]).toBe("");
        }
        const diagnostic = `subscription authentication rejected ${token}`;
        if (rejected) opts.onStderrLine?.(diagnostic);
        if (outcome !== "stderr rejection")
          opts.onStdoutLine?.(
            JSON.stringify({ type: "result", is_error: rejected, result: rejected ? diagnostic : "done" }),
          );
        return {
          exitCode: rejected ? 1 : 0,
          signal: null,
          truncated: false,
          durationMs: 1,
          stdout: "",
          stderr: rejected ? diagnostic : "",
          timedOut: false,
          idleTimedOut: false,
          cancelled: false,
        };
      };
      factory = new Factory(cfg, { store, harnesses: { claude: (spec) => runClaude(spec, launch) } });
      const harness = factory.deps.harnesses.claude;
      if (!harness) throw new Error("missing Claude harness");
      expect(agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: token, OTHER: token }).OTHER).toBeUndefined();
      await confinedEdit(config.work, async (scratchDir) => {
        const cases = rejected
          ? [{ mode: "edit" as const, noTools: false, backend: false }]
          : [
              { mode: "edit" as const, noTools: false, backend: false },
              { mode: "readonly" as const, noTools: false, backend: false },
              { mode: "edit" as const, noTools: true, backend: false },
              { mode: "readonly" as const, noTools: true, backend: false },
              { mode: "edit" as const, noTools: true, backend: true },
            ];
        for (const [index, scenario] of cases.entries()) {
          const events: AgentEvent[] = [];
          const logPath = join(scratchDir, `auth-${index}.log`);
          const result = await harness({
            cwd: config.work,
            scratchDir,
            prompt: "test",
            mode: scenario.mode,
            noTools: scenario.noTools,
            target: {
              modelId: "claude/test",
              model: "test",
              provider: "claude",
              harness: "claude",
              vendor: "anthropic",
              billing: "subscription",
              tier: 4,
              ...(scenario.backend
                ? { backend: { baseUrl: "https://example.invalid", authToken: "backend-key" } }
                : {}),
            },
            timeoutMs: 10_000,
            idleTimeoutMs: 10_000,
            maxToolCalls: 10,
            signal: new AbortController().signal,
            logPath,
            onEvent: (event) => events.push(event),
          });
          expect(result.status).toBe(rejected ? "error" : "ok");
          if (rejected) {
            expect(result.error).toBe("subscription authentication rejected [redacted]");
            for (const output of [
              JSON.stringify(result),
              JSON.stringify(events),
              readFileSync(logPath, "utf8"),
            ]) {
              expect(output).not.toContain(token);
              expect(output).toContain("subscription authentication rejected [redacted]");
            }
          }
        }
        expect(launches).toBe(cases.length);
      });
    } finally {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await factory?.stop();
      store.close();
      config.close();
    }
  },
);

// Holds every launch before the trusted startup shell; the optional hook runs just before the spawn.
// A chatty hold emits diagnostics without reporting agent progress.
const heldLaunch = (beforeSpawn = () => {}, chatty = false): ConfinementBackend => ({
  verify: async () => {},
  wrap: (cmd) => {
    beforeSpawn();
    const hold = chatty ? "while :; do echo starting >&2; sleep 0.01; done" : "sleep 900";
    return ["/bin/sh", "-c", `${hold}; exec "$@"`, "sh", ...cmd];
  },
});
const heldEdit = (
  backend: ConfinementBackend,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void = () => {},
  // Exercise the harness watchdog without racing the byte-idle timer under scheduler load.
  processRunner: typeof runProcess = (opts) => runProcess({ ...opts, idleTimeoutMs: undefined }),
) =>
  confinementScope.run(backend, () =>
    withScratch(import.meta.dir, (scratchDir) => {
      const home = join(dirname(scratchDir), "home");
      mkdirSync(home);
      return readPolicyScope.run({ ...testReadPolicy, home, environment: {} }, () =>
        runClaude(
          {
            cwd: import.meta.dir,
            scratchDir,
            prompt: "test",
            mode: "edit",
            logPath: join(scratchDir, "inv.log"),
            target: {
              modelId: "claude/test",
              provider: "claude",
              harness: "claude",
              model: "claude-test",
              vendor: "anthropic",
              tier: 4,
              billing: "subscription",
            },
            timeoutMs: 30_000,
            idleTimeoutMs: 50,
            maxToolCalls: 1,
            signal,
            onEvent,
          },
          processRunner,
        ),
      );
    }),
  );
const watchdogFired = (event: AgentEvent) =>
  event.type === "status" && event.text.startsWith("stopping agent: no progress");

test("a claude editor whose sandbox hangs until the no-progress watchdog fires is a confinement error", async () => {
  const caller = new AbortController();
  await expect(heldEdit(heldLaunch(undefined, true), caller.signal)).rejects.toThrow(
    "Write confinement payload did not start: no progress",
  );
  expect(caller.signal.aborted).toBe(false);
});

test("the first abort decides: a watchdog stop followed by a caller cancel is still a confinement error", async () => {
  const caller = new AbortController();
  // The caller cancels right after the watchdog, before the hung launch has been cleaned up.
  const onEvent = (event: AgentEvent) => {
    if (watchdogFired(event)) caller.abort();
  };
  await expect(heldEdit(heldLaunch(undefined, true), caller.signal, onEvent)).rejects.toThrow(
    "Write confinement payload did not start: no progress",
  );
  expect(caller.signal.aborted).toBe(true);
});

test("the first abort decides: a caller cancel followed by the watchdog during cleanup ends cancelled", async () => {
  const caller = new AbortController();
  const fired = deferred<void>();
  const onEvent = (event: AgentEvent) => {
    if (watchdogFired(event)) fired.resolve();
  };
  // The launch ends at the caller's cancel; cleanup outlasts the watchdog's next check.
  const slowCleanup: typeof runProcess = async (opts) => {
    const result = await runProcess(opts);
    await fired.promise;
    return result;
  };
  const result = await heldEdit(
    heldLaunch(() => caller.abort()),
    caller.signal,
    onEvent,
    slowCleanup,
  );
  expect(result.status).toBe("cancelled");
});

test("a caller cancel while a claude editor's sandbox starts ends the run cancelled", async () => {
  const caller = new AbortController();
  const result = await heldEdit(
    heldLaunch(() => caller.abort()),
    caller.signal,
  );
  expect(result.status).toBe("cancelled");
});

// The confinement probe's first step holds until the editor's signal aborts, then ends as
// runProcess's cancel kill does; nothing may launch after it. Without the editor's roots the probe
// keeps its files in its own temporary directory, not in this checkout.
const heldProbe = (onProbe = () => {}): ConfinementBackend => ({
  verify: (_roots, opts) =>
    verifySeatbelt(
      async (probe) => {
        onProbe();
        if (!probe.signal?.aborted)
          await new Promise((resolve) => probe.signal?.addEventListener("abort", resolve, { once: true }));
        return {
          exitCode: null,
          signal: "SIGKILL",
          cancelled: true,
          cancelKilled: true,
          timedOut: false,
          idleTimedOut: false,
          stdout: "",
          stderr: "",
          truncated: false,
          durationMs: 1,
        };
      },
      "/bin/sh",
      "darwin",
      undefined,
      opts.signal,
    ),
  wrap: () => {
    throw new Error("launched before the confinement probe passed");
  },
});

test("a claude editor whose confinement probe hangs until the no-progress watchdog fires is a confinement error", async () => {
  const caller = new AbortController();
  await expect(heldEdit(heldProbe(), caller.signal)).rejects.toThrow(
    "Write confinement payload did not start: no progress",
  );
  expect(caller.signal.aborted).toBe(false);
});

test("a caller cancel during a claude editor's confinement probe surfaces as the caller's abort", async () => {
  const caller = new AbortController();
  const reason = new Error("cancelled by the caller");
  await expect(
    heldEdit(
      heldProbe(() => caller.abort(reason)),
      caller.signal,
    ),
  ).rejects.toBe(reason);
});

for (const harness of ["codex", "claude"] as const) {
  test(`${harness} passes private zsh startup and optional wrapper PATH to tool-enabled agents`, async () => {
    const startupDirs: string[] = [];
    await confinedEdit(import.meta.dir, async (scratchDir) => {
      // Environment wiring needs no lease transport; the installed-wrapper test exercises it.
      const directory = join(scratchDir, "wrappers");
      mkdirSync(directory);
      writeFileSync(join(directory, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      for (const path of [undefined, `${directory}${delimiter}${process.env.PATH ?? ""}`]) {
        const result = await (harness === "codex" ? verifiedCodex : runClaude)(
          {
            cwd: import.meta.dir,
            scratchDir,
            commandPath: path,
            prompt: "ready",
            mode: "edit",
            target: {
              modelId: `${harness}/test`,
              provider: harness,
              harness,
              model: "test",
              vendor: "other",
              tier: 4,
              billing: "subscription",
            },
            timeoutMs: 1000,
            idleTimeoutMs: 1000,
            maxToolCalls: 1,
            signal: new AbortController().signal,
            logPath: join(scratchDir, "log"),
            onEvent: () => {},
          },
          async (opts) => {
            expect(opts.env.PATH).toBe(path ?? process.env.PATH);
            const zdotdir = opts.env.ZDOTDIR ?? "";
            expect(zdotdir.startsWith(`${scratchDir}/`)).toBe(true);
            expect(startupDirs).not.toContain(zdotdir);
            startupDirs.push(zdotdir);
            for (const name of [".zshenv", ".zprofile", ".zlogin"])
              expect(existsSync(join(zdotdir, name))).toBe(true);
            if (opts.cmd[4]?.startsWith("limitless-started-")) opts.onStdoutLine?.(opts.cmd[4]);
            opts.onStdoutLine?.(
              JSON.stringify(
                harness === "codex"
                  ? { type: "turn.completed", usage: {} }
                  : { type: "result", result: "ready" },
              ),
            );
            return {
              exitCode: 0,
              signal: null,
              cancelled: false,
              timedOut: false,
              idleTimedOut: false,
              stdout: "",
              stderr: "",
              truncated: false,
              durationMs: 1,
            };
          },
        );
        expect(result.status).toBe("ok");
      }
    });
    expect(startupDirs).toHaveLength(2);
    for (const directory of startupDirs) expect(existsSync(directory)).toBe(false);
  });
}

test("CLI transcript redaction handles escaped multi-line scenario text", () => {
  const holdout = {
    scenarios: [
      {
        id: "H-1",
        description: "special case",
        steps: "printf 'private'\nrun SECRET_MARKER_719",
        expected: "done",
        edge_case: false,
      },
      { id: "H-2", description: "edge two", steps: "exit 1", expected: "failure", edge_case: true },
      { id: "H-3", description: "edge three", steps: "exit 2", expected: "failure", edge_case: true },
    ],
  };
  const line = JSON.stringify({
    type: "item.completed",
    item: { text: "routine check: printf 'private'\nrun SECRET_MARKER_719" },
  });
  const redacted = redactJsonLine(line, (value) => redactHoldoutText(value, holdout));
  expect(redacted).toContain("routine check");
  expect(redacted).not.toContain("SECRET_MARKER_719");
  expect(redacted).not.toContain("printf 'private'");
});

describe("LoopDetector", () => {
  test("flags repeated identical calls", () => {
    const d = new LoopDetector(100, 3, 5);
    expect(d.observe("Bash", { command: "ls" })).toBeNull();
    expect(d.observe("Bash", { command: "ls" })).toBeNull();
    expect(d.observe("Bash", { command: "ls" })).toContain("repeated");
  });

  test("allows varied calls and enforces the budget", () => {
    const d = new LoopDetector(3);
    expect(d.observe("Read", { p: 1 })).toBeNull();
    expect(d.observe("Read", { p: 2 })).toBeNull();
    expect(d.observe("Read", { p: 3 })).toBeNull();
    expect(d.observe("Read", { p: 4 })).toContain("budget");
  });

  test("changing results are progress while identical results still stop", () => {
    for (const changing of [true, false]) {
      const d = new LoopDetector(100);
      for (let i = 0; i < 6; i++) {
        expect(d.observe("shell", { command: "tail test.log" }, String(i))).toBeNull();
        expect(d.observeResult(String(i), changing ? `${i} tests passed` : "waiting")).toBe(
          !changing && i === 5 ? "repeated the same shell call 6 times" : null,
        );
      }
    }
  });

  test("a changed result restarts the count and ignores unmatched or duplicate results", () => {
    const d = new LoopDetector(100);
    for (let i = 0; i < 10; i++) {
      d.observeResult("unmatched", String(i));
      expect(d.observe("shell", "poll", String(i))).toBeNull();
      expect(d.observeResult(String(i), i < 3 ? "waiting" : "progress")).toBe(
        i === 9 ? "repeated the same shell call 6 times" : null,
      );
      expect(d.observeResult(String(i), "duplicate result must be ignored")).toBeNull();
    }
  });

  test("missing results still count and changing results still consume the budget", () => {
    const missing = new LoopDetector(100);
    for (let i = 0; i < 6; i++) {
      expect(missing.observe("shell", "poll", String(i))).toBeNull();
    }
    expect(missing.finish()).toBe("repeated the same shell call 6 times");
    const bounded = new LoopDetector(6);
    for (let i = 0; i < 6; i++) {
      expect(bounded.observe("shell", "poll", String(i))).toBeNull();
      bounded.observeResult(String(i), String(i));
    }
    expect(bounded.observe("shell", "poll", "6")).toBe("exceeded tool-call budget (6)");
  });

  test("a missing earlier result counts without denying the threshold result progress", () => {
    for (const changed of [false, true]) {
      const d = new LoopDetector(100);
      expect(d.observe("shell", "poll", "missing")).toBeNull();
      for (let i = 1; i < 6; i++) {
        expect(d.observe("shell", "poll", String(i))).toBeNull();
        expect(d.observeResult(String(i), changed && i === 5 ? "progress" : "waiting")).toBeNull();
      }
      if (!changed) expect(d.observe("shell", "poll", "next")).toBe("repeated the same shell call 6 times");
      if (changed) {
        // An older completion must not replace the sixth call's newer baseline.
        expect(d.observeResult("missing", "waiting")).toBeNull();
        for (let i = 6; i < 12; i++) {
          expect(d.observe("shell", "poll", String(i))).toBeNull();
          expect(d.observeResult(String(i), "progress")).toBe(
            i === 11 ? "repeated the same shell call 6 times" : null,
          );
        }
      }
    }
  });

  test("a pending threshold result can show progress only until the next call", () => {
    for (const nextTool of ["shell", "Read"]) {
      const d = new LoopDetector(100);
      for (let i = 0; i < 6; i++) {
        expect(d.observe("shell", "poll", String(i))).toBeNull();
        if (i < 5) expect(d.observeResult(String(i), "waiting")).toBeNull();
      }
      expect(d.observe(nextTool, "poll", "next")).toBe("repeated the same shell call 6 times");
    }
  });

  test("late results that expose a loop preserve the threshold in its reason", () => {
    const d = new LoopDetector(100);
    for (let i = 0; i < 9; i++) {
      expect(d.observe("shell", "poll", String(i))).toBeNull();
      if (i !== 1 && i !== 2) {
        expect(d.observeResult(String(i), i === 0 ? "waiting" : "progress")).toBeNull();
      }
    }
    expect(d.observeResult("1", "progress")).toBeNull();
    expect(d.observeResult("2", "progress")).toBe("repeated the same shell call 6 times");
  });

  test("results match IDs across interleaved calls and late completions in call order", () => {
    const d = new LoopDetector(100);
    expect(d.observe("shell", "poll", "first")).toBeNull();
    expect(d.observe("Read", "file", "read")).toBeNull();
    d.observeResult("first", "waiting");
    d.observeResult("read", "contents");
    expect(d.observe("shell", "poll", "late")).toBeNull();
    expect(d.observe("shell", "poll", "newer")).toBeNull();
    expect(d.observeResult("newer", "progress")).toBeNull();
    expect(d.observeResult("late", "waiting")).toBeNull();
    for (let i = 3; i <= 8; i++) {
      expect(d.observe("shell", "poll", String(i))).toBeNull();
      expect(d.observeResult(String(i), "progress")).toBe(
        i === 8 ? "repeated the same shell call 6 times" : null,
      );
    }
  });

  test("the threshold result can establish progress, even with parallel calls", () => {
    for (const parallel of [false, true]) {
      for (const outputs of [
        ["waiting", "waiting", "waiting", "waiting", "waiting", "progress"],
        Array.from({ length: 6 }, (_, i) => String(i)),
        Array.from({ length: 6 }, () => "waiting"),
      ]) {
        const d = new LoopDetector(100);
        if (parallel) for (let i = 0; i < 6; i++) expect(d.observe("shell", "poll", String(i))).toBeNull();
        for (const [i, output] of outputs.entries()) {
          if (!parallel) expect(d.observe("shell", "poll", String(i))).toBeNull();
          expect(d.observeResult(String(i), output)).toBe(
            i === 5 && output === "waiting" ? "repeated the same shell call 6 times" : null,
          );
        }
      }
    }
  });

  test("timestamp-only and counter-only changes are bounded by the unchanged budget", () => {
    for (const command of ["sleep 5; date +%s", "poll counter"]) {
      const d = new LoopDetector(20);
      for (let i = 0; i < 20; i++) {
        expect(d.observe("shell", command, String(i))).toBeNull();
        expect(d.observeResult(String(i), String(1_000_000 + i))).toBeNull();
      }
      expect(d.observe("shell", command, "20")).toBe("exceeded tool-call budget (20)");
    }
  });

  test("completed and unresolved state is bounded by the window and evicted IDs are ignored", () => {
    for (const completed of [false, true]) {
      const d = new LoopDetector(1000);
      // Inspect retained state to catch unbounded keys, including large serialized inputs.
      const state = d as unknown as {
        recent: { key: string }[];
        pending: Map<string, unknown>;
        results: Map<string, string>;
      };
      for (let i = 0; i < 400; i++) {
        expect(d.observe("apply_patch", `${i}:${"x".repeat(20_000)}`, String(i))).toBeNull();
        if (completed) expect(d.observeResult(String(i), "done")).toBeNull();
        expect(state.recent.length).toBeLessThanOrEqual(12);
        expect(state.pending.size).toBeLessThanOrEqual(12);
        expect(state.results.size).toBeLessThanOrEqual(12);
        const keys = new Set(state.recent.map((entry) => entry.key));
        expect([...state.results.keys()].every((key) => keys.has(key))).toBe(true);
      }
      expect(d.observeResult("0", "late evicted result")).toBeNull();
      expect(state.results.size).toBe(completed ? 12 : 0);
    }
  });

  test("eviction unblocks later completions and evicted results cannot reset a live key", () => {
    const d = new LoopDetector(100);
    expect(d.observe("shell", "poll", "old")).toBeNull();
    expect(d.observe("shell", "poll", "new")).toBeNull();
    expect(d.observeResult("new", "progress")).toBeNull();
    for (let i = 0; i < 11; i++) expect(d.observe("Read", i, `read-${i}`)).toBeNull();
    expect(d.observeResult("old", "stale")).toBeNull();
    // The baseline survives while its key is live, even after its originating call is evicted.
    for (let i = 0; i < 5; i++) {
      expect(d.observe("shell", "poll", String(i))).toBeNull();
      expect(d.observeResult(String(i), "progress")).toBeNull();
    }
    expect(d.observe("shell", "poll", "stop")).toBeNull();
    expect(d.observeResult("stop", "progress")).toBe("repeated the same shell call 6 times");
  });

  test("progress clears only its key and retains the twelve-call window", () => {
    const d = new LoopDetector(100);
    expect(d.observe("Read", "file")).toBeNull();
    for (let i = 0; i < 8; i++) {
      expect(d.observe("shell", "poll", String(i))).toBeNull();
      d.observeResult(String(i), i < 3 ? "waiting" : "progress");
    }
    for (let i = 0; i < 3; i++) expect(d.observe("other", i)).toBeNull();
    for (let i = 0; i < 5; i++) expect(d.observe("Read", "file")).toBeNull();
    expect(d.observe("Read", "file")).toBe("repeated the same Read call 6 times");
  });
});

for (const harness of ["codex", "claude"] as const) {
  const tools =
    harness === "codex"
      ? ["shell", "apply_patch", "test.poll", "web_search"]
      : ["Bash", "Edit", "mcp__test__poll"];
  test(`${harness} parser waits for a late predecessor to establish progress`, () => {
    const detector = new LoopDetector(100);
    const onEvent = (event: AgentEvent) => {
      if (event.type === "tool_call") expect(detector.observe(event.name, event.input, event.id)).toBeNull();
      if (event.type === "tool_result") expect(detector.observeResult(event.id, event.output)).toBeNull();
    };
    const parser = harness === "codex" ? new CodexStreamParser(onEvent) : new ClaudeStreamParser(onEvent);
    const call = (i: number) =>
      parser.feed(
        JSON.stringify(
          harness === "codex"
            ? { type: "item.started", item: { type: "command_execution", id: String(i), command: "poll" } }
            : {
                type: "assistant",
                message: {
                  content: [{ type: "tool_use", id: String(i), name: "Bash", input: { command: "poll" } }],
                },
              },
        ),
      );
    const complete = (i: number, output: string) =>
      parser.feed(
        JSON.stringify(
          harness === "codex"
            ? {
                type: "item.completed",
                item: {
                  type: "command_execution",
                  id: String(i),
                  command: "poll",
                  aggregated_output: output,
                  exit_code: 0,
                },
              }
            : {
                type: "user",
                message: { content: [{ type: "tool_result", tool_use_id: String(i), content: output }] },
              },
        ),
      );
    call(1);
    complete(1, "A");
    for (let i = 2; i <= 6; i++) call(i);
    for (let i = 6; i >= 3; i--) complete(i, "A");
    complete(2, "B");
    expect(detector.finish()).toBeNull();
  });
  for (const tool of tools) {
    test(`${harness} ${tool} parser events detect loops during the invocation`, async () => {
      const modes =
        tool === tools[0]
          ? [
              "changing",
              "threshold",
              "identical",
              "missing",
              "missing-stream",
              "missing-timeout",
              "missing-failure",
              "truncated",
              "parallel-changing",
              "parallel-threshold",
              "parallel-identical",
              "parallel-changing-reverse",
              "parallel-identical-reverse",
              "late",
              "budget",
            ]
          : tool === "web_search"
            ? ["identical"]
            : ["threshold", "identical"];
      for (const mode of modes) {
        await withScratch(import.meta.dir, async (scratchDir) => {
          const result = await (harness === "codex" ? verifiedCodex : runClaude)(
            {
              cwd: import.meta.dir,
              scratchDir,
              prompt: "poll tests",
              mode: "readonly",
              target: {
                modelId: `${harness}/test`,
                provider: harness,
                harness,
                model: "test",
                vendor: "other",
                tier: 4,
                billing: "subscription",
              },
              timeoutMs: 1000,
              idleTimeoutMs: 1000,
              maxToolCalls: mode === "budget" ? 6 : 100,
              signal: new AbortController().signal,
              logPath: join(scratchDir, "log"),
              onEvent: () => {},
            },
            async (opts) => {
              const emit = (record: unknown) => opts.onStdoutLine?.(JSON.stringify(record));
              const call = (i: number) => {
                const id = `poll-${i}`;
                if (harness === "claude") {
                  emit({
                    type: "assistant",
                    message: {
                      content: [{ type: "tool_use", id, name: tool, input: { command: "tail test.log" } }],
                    },
                  });
                } else if (tool !== "apply_patch") {
                  emit({
                    type: "item.started",
                    item:
                      tool === "shell"
                        ? { type: "command_execution", id, command: "tail test.log" }
                        : tool === "web_search"
                          ? { type: "web_search", id, query: "test progress" }
                          : {
                              type: "mcp_tool_call",
                              id,
                              server: "test",
                              tool: "poll",
                              arguments: { log: "test.log" },
                            },
                  });
                }
              };
              const complete = (i: number, output: string) => {
                const id = `poll-${i}`;
                if (harness === "claude") {
                  emit({
                    type: "user",
                    message: {
                      content: [
                        {
                          type: "tool_result",
                          tool_use_id: id,
                          content: [{ type: "text", text: output }],
                          is_error: Boolean(i % 2),
                        },
                      ],
                    },
                  });
                } else {
                  emit({
                    type: "item.completed",
                    item:
                      tool === "shell"
                        ? {
                            type: "command_execution",
                            id,
                            command: "tail test.log",
                            aggregated_output: output,
                            exit_code: i % 2,
                          }
                        : tool === "apply_patch"
                          ? {
                              type: "file_change",
                              id,
                              changes: [{ path: "test.txt", kind: "update" }],
                              status: output === "progress" ? "completed" : "failed",
                            }
                          : tool === "web_search"
                            ? { type: "web_search", id, query: "test progress" }
                            : { type: "mcp_tool_call", id, result: output },
                  });
                }
              };
              const parallel = mode.startsWith("parallel");
              const count = mode === "missing-stream" ? 20 : mode === "late" ? 9 : mode === "budget" ? 7 : 6;
              if (parallel) {
                if (harness === "claude") {
                  emit({
                    type: "assistant",
                    message: {
                      content: Array.from({ length: count }, (_, i) => ({
                        type: "tool_use",
                        id: `poll-${i}`,
                        name: tool,
                        input: { command: "tail test.log" },
                      })),
                    },
                  });
                  expect(opts.signal?.aborted).toBe(false);
                } else {
                  for (let i = 0; i < count; i++) {
                    call(i);
                    expect(opts.signal?.aborted).toBe(false);
                  }
                }
              }
              for (let i = 0; i < count; i++) {
                if (!parallel) call(i);
                if (mode === "missing-stream" && i === 6) {
                  // The runner intended to emit more than a window, but must stop in flight.
                  expect(opts.signal?.aborted).toBe(true);
                  break;
                }
                if (mode === "budget" && i === 6) {
                  expect(opts.signal?.aborted).toBe(true);
                  break;
                }
                // Searches have no result text; the sixth call must stop before completion.
                expect(opts.signal?.aborted).toBe(tool === "web_search" && i === 5);
                if (mode === "late" && i === 1) continue;
                const resultIndex = mode.endsWith("reverse") ? count - 1 - i : i;
                const output =
                  mode.includes("changing") || mode === "budget"
                    ? String(1_000_000 + resultIndex)
                    : (mode.includes("threshold") && i === 5) || (mode === "late" && i >= 2)
                      ? "progress"
                      : mode === "truncated"
                        ? `${"x".repeat(20_000)}${i}`
                        : "waiting";
                if (!mode.startsWith("missing")) complete(resultIndex, output);
                if (mode === "late" && i === 2) complete(1, "waiting");
                // A result without a corresponding call must not affect another call's baseline.
                emit(
                  harness === "codex"
                    ? { type: "item.completed", item: { type: "mcp_tool_call", id: "orphan", result: i } }
                    : {
                        type: "user",
                        message: {
                          content: [{ type: "tool_result", tool_use_id: "orphan", content: String(i) }],
                        },
                      },
                );
                const stopped =
                  ((mode.includes("identical") || mode === "truncated") && i === 5) ||
                  (mode === "late" && i === 8);
                expect(opts.signal?.aborted).toBe(stopped);
              }
              emit(
                harness === "codex"
                  ? { type: "turn.completed", usage: {} }
                  : { type: "result", result: "done" },
              );
              return {
                exitCode: mode === "missing-failure" ? 1 : 0,
                signal: null,
                truncated: false,
                durationMs: 1,
                stdout: "",
                stderr: "",
                timedOut: mode === "missing-timeout",
                idleTimedOut: false,
                cancelled: opts.signal?.aborted ?? false,
              };
            },
          );
          const progress = mode.includes("changing") || mode.includes("threshold");
          expect(result.status).toBe(progress ? "ok" : "stuck");
          expect(result.error).toBe(
            progress
              ? null
              : mode === "budget"
                ? "exceeded tool-call budget (6)"
                : `repeated the same ${tool} call 6 times`,
          );
        });
      }
    });
  }
}

test("priceOf charges cache reads at a discount", () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
  expect(priceOf(usage, { input: 2, output: 10 })).toBeCloseTo(2 + 10 + 0.2);
  expect(priceOf(usage, undefined)).toBe(0);
});

test("priceOf charges 1-hour cache writes at twice the input rate and the rest at 1.25x", () => {
  const price = { input: 2, output: 10 };
  const write = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };
  // Without a duration breakdown every write is a 5-minute one.
  expect(priceOf(write, price)).toBeCloseTo(2.5);
  expect(priceOf({ ...write, cacheWrite1h: 400_000 }, price)).toBeCloseTo(3.1);
  // A breakdown larger than the writes themselves cannot price more than the writes.
  expect(priceOf({ ...write, cacheWrite: 100, cacheWrite1h: 1_000_000 }, price)).toBeCloseTo(0.0004);
});

describe("extractJson", () => {
  test("prefers the last fenced json block", () => {
    expect(extractJson('first ```json\n{"a":1}\n``` then ```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  test("finds a trailing object in prose", () => {
    expect(extractJson('The file contains hello.\n\n{"content": "hello"}\n\nDone.')).toEqual({
      content: "hello",
    });
  });
  test("handles nested objects and ignores broken candidates", () => {
    expect(extractJson('noise {broken} and {"a": {"b": [1, {"c": 2}]}}')).toEqual({
      a: { b: [1, { c: 2 }] },
    });
  });
  test("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

test("a no-tools Claude call returning StructuredOutput is not stopped by a zero tool budget", async () => {
  const { runClaude } = await import("../src/harness/claude.ts");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "limitless-fakeclaude-"));
  // A stand-in `claude` that replays a stream ending in a StructuredOutput tool call.
  const lines = [
    { type: "system", subtype: "init", session_id: "s1", model: "m" },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { ok: true } }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      result: "",
      structured_output: { ok: true },
    },
  ];
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${lines.map((l) => `'${JSON.stringify(l)}'`).join(" ")}\n`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const res = await runClaude({
      cwd: dir,
      prompt: "x",
      mode: "readonly",
      noTools: true,
      jsonSchema: { type: "object" },
      target: {
        modelId: "c/m",
        provider: "claude",
        harness: "claude",
        model: "m",
        vendor: "anthropic",
        tier: 4,
        billing: "subscription",
      },
      timeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      maxToolCalls: 0,
      signal: new AbortController().signal,
      logPath: join(dir, "log"),
      onEvent: () => {},
    });
    expect(res.status).toBe("ok");
    expect(res.structured).toEqual({ ok: true });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("CLI arguments transmit the selected effort verbatim and reject backend Claude transport", async () => {
  const { buildClaudeArgs } = await import("../src/harness/claude.ts");
  await withScratch(import.meta.dir, async (scratchDir) => {
    const spec: AgentSpec = {
      cwd: import.meta.dir,
      scratchDir,
      prompt: "test",
      mode: "readonly",
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 0,
      signal: new AbortController().signal,
      logPath: "/tmp/unused",
      onEvent: () => {},
      target: {
        modelId: "claude/opus",
        model: "opus",
        provider: "claude",
        vendor: "anthropic",
        tier: 5,
        billing: "subscription",
        harness: "claude",
      },
    };
    // Whether a value is supported is decided by the catalog; the harness passes the selection through.
    for (const effort of ["none", "low", "high", "max", undefined] as const) {
      spec.target.effort = effort;
      const args = buildClaudeArgs(spec, "session");
      expect(args.filter((a) => a === "--effort")).toHaveLength(effort === undefined ? 0 : 1);
      if (effort) expect(args[args.indexOf("--effort") + 1]).toBe(effort);
    }
    for (const effort of ["none", "low", "high", undefined] as const) {
      spec.target.effort = effort;
      const args = buildCodexArgs(spec);
      expect(args.filter((a) => a.startsWith("model_reasoning_effort="))).toEqual(
        effort ? [`model_reasoning_effort="${effort}"`] : [],
      );
    }
    spec.target.backend = { baseUrl: "http://unused", authToken: "" };
    spec.target.effort = undefined;
    expect(buildClaudeArgs(spec, "session")).not.toContain("--effort");
    spec.target.effort = "high";
    expect(() => buildClaudeArgs(spec, "session")).toThrow("cannot set effort for the claude backend");
  });
});

test("native fast flags cover edit, structured and isolated readers without leaking to backends", async () => {
  await withScratch(import.meta.dir, async (scratchDir) => {
    const base: AgentSpec = {
      cwd: import.meta.dir,
      scratchDir,
      prompt: "ready",
      mode: "readonly",
      target: {
        modelId: "test",
        provider: "codex",
        harness: "codex",
        model: "test",
        vendor: "other",
        tier: 1,
        billing: "subscription",
      },
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 1,
      signal: new AbortController().signal,
      logPath: join(scratchDir, "log"),
      onEvent: () => {},
    };
    for (const mode of ["readonly", "edit"] as const) {
      for (const noTools of [false, true]) {
        for (const fast of [false, true]) {
          const spec = { ...base, mode, noTools, fast, jsonSchema: { type: "object" } };
          const args = buildCodexArgs(spec);
          expect(args.filter((a) => a === 'service_tier="fast"')).toHaveLength(fast ? 1 : 0);
          if (noTools || mode === "readonly") expect(args).toContain("--ignore-user-config");
          const claude = {
            ...spec,
            target: { ...base.target, provider: "claude", harness: "claude" as const },
          };
          const claudeArgs = buildClaudeArgs(claude, "session");
          const settingsIndex = claudeArgs.indexOf("--settings");
          const settings = settingsIndex < 0 ? {} : JSON.parse(claudeArgs[settingsIndex + 1] ?? "{}");
          expect(settings.fastMode).toBe(fast ? true : undefined);
          expect(claudeArgs.filter((a) => a === "--settings").length).toBeLessThanOrEqual(1);
          if (!noTools && mode === "readonly") {
            expect(settings.sandbox.enabled).toBe(true);
            expect(settings.sandbox.filesystem.allowWrite).toEqual([scratchDir]);
            expect(settings.disableAllHooks).toBe(true);
            const confinedArgs = buildClaudeArgs({ ...claude, confineReads: true }, "session");
            const confined = JSON.parse(confinedArgs[confinedArgs.indexOf("--settings") + 1] ?? "{}").sandbox
              .filesystem;
            expect(confined.allowRead).toEqual([
              ...new Set([base.cwd, realpathSync(base.cwd)]),
              ...new Set([scratchDir, realpathSync(scratchDir)]),
            ]);
            expect(confined.allowWrite).toEqual([scratchDir]);
            expect(confined.denyWrite).toContain(realpathSync(base.cwd));
            expect(confined.denyRead).toContain(join(testReadPolicy.home ?? "", ".aws"));
          }
          const backendArgs = buildClaudeArgs(
            { ...claude, target: { ...claude.target, provider: "openrouter" } },
            "session",
          );
          expect(backendArgs.join(" ")).not.toContain("fastMode");
        }
      }
    }
    const spec = {
      ...base,
      fast: true,
      noTools: true,
      target: { ...base.target, provider: "claude", harness: "claude" as const },
    };
    const outcome = await runClaude(spec, async (opts) => {
      for (const line of fixture("claude-fast-off.jsonl")) opts.onStdoutLine?.(line);
      return {
        exitCode: 0,
        signal: null,
        truncated: false,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        idleTimedOut: false,
        cancelled: false,
      };
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.fastModeState).toBe("off");
    expect(outcome.fastModeDisabledReason).toBe("extra_usage_disabled");
    let codexCalls = 0;
    const rejected = await runCodex({ ...base, fast: true, noTools: true }, async (opts) => {
      codexCalls++;
      expect(opts.cmd).toContain('service_tier="fast"');
      return {
        exitCode: 1,
        signal: null,
        truncated: false,
        durationMs: 1,
        stdout: "",
        stderr: "unsupported service_tier fast",
        timedOut: false,
        idleTimedOut: false,
        cancelled: false,
      };
    });
    expect(codexCalls).toBe(1);
    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("unsupported service_tier fast");
    const parser = new ClaudeStreamParser(() => {});
    parser.feed('{"type":"result","result":"ready"}');
    expect(parser.fastModeState).toBeNull();
    expect(parser.fastModeDisabledReason).toBeNull();
    parser.feed('{"type":"result","fast_mode_state":"on"}');
    expect(parser.fastModeState).toBe("on");
    expect(parser.fastModeDisabledReason).toBeNull();
  });
});

for (const [name, Parser] of [
  ["claude", ClaudeStreamParser],
  ["codex", CodexStreamParser],
] as const) {
  test(`${name} warns once for executable signals including denied attempts, not prose or literal data`, () => {
    const events: AgentEvent[] = [];
    const parser = new Parser((event) => events.push(event));
    for (const line of fixture(`${name}-signals.jsonl`)) parser.feed(line);
    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings.map((event) => event.id)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => `signal-${i}`),
      "captured-1",
    ]);
    expect(JSON.stringify(warnings)).not.toContain("marker");
    expect(events.filter((event) => event.type === "tool_result").length).toBeGreaterThan(10);
  });
}

test("sanitized captured CLI records each warn once across their real stream shapes", () => {
  for (const [name, Parser] of [
    ["claude", ClaudeStreamParser],
    ["codex", CodexStreamParser],
  ] as const) {
    const events: AgentEvent[] = [];
    const parser = new Parser((event) => events.push(event));
    for (const line of fixture(`${name}-signals.jsonl`).filter((line) => line.includes('"captured-1"')))
      parser.feed(line);
    expect(events.filter((event) => event.type === "warning")).toEqual([
      { type: "warning", id: "captured-1", text: "Process signal attempt detected." },
    ]);
  }
});

test("signal detection recognizes wrappers and ignores process polls and command lookup", () => {
  for (const command of [
    "timeout 5 pkill -f x",
    "timeout --signal TERM -k 2 5 pkill -f x",
    "nice pkill x",
    "nice -n 5 pkill x",
    "time pkill x",
    "time -o timing.log pkill x",
    "watch pkill x",
    "watch -n 2 pkill x",
    "watch -d pkill x",
    "stdbuf -o L pkill x",
    "stdbuf --input 0 --error L pkill x",
    "{ pkill x; }",
    "node --eval='process.kill(1)'",
    'bun --print="process.kill(1)"',
    "xargs -a pids kill",
    "xargs -d , -E stop -s 100 kill",
  ])
    expect(signalCommand(command)).toBe(true);
  for (const command of [
    "command -v pkill",
    "command -V pkill",
    "kill -0 123",
    "kill -s 0 123",
    "kill -0 $pid && echo running",
    "xargs -a pids kill -0",
    "node --eval='console.log(\"process.kill(1)\")'",
    `/bin/zsh -lc "cat > f.ts <<'EOF'
const re = /"'^(?:pkill|killall)$'"/;
EOF
bun run typecheck"`,
  ])
    expect(signalCommand(command)).toBe(false);
});

test("Claude edit denies named process signals and broadcast kill as backstops", async () => {
  await withScratch(process.cwd(), async (scratchDir) => {
    const args = buildClaudeArgs(
      {
        cwd: process.cwd(),
        scratchDir,
        prompt: "edit",
        mode: "edit",
        target: {
          modelId: "claude/test",
          model: "test",
          provider: "claude",
          harness: "claude",
          vendor: "anthropic",
          tier: 4,
          billing: "subscription",
        },
        signal: new AbortController().signal,
        timeoutMs: 1000,
        idleTimeoutMs: 1000,
        maxToolCalls: 5,
        logPath: join(scratchDir, "log"),
        onEvent: () => {},
      },
      "session",
    );
    for (const pattern of ["Bash(pkill:*)", "Bash(killall:*)", "Bash(kill -9 -1:*)"])
      expect(args.slice(args.indexOf("--disallowedTools") + 1)).toContain(pattern);
  });
});

test("Codex completion-only denied command warns once without treating tool output as commands", () => {
  const events: AgentEvent[] = [];
  const parser = new CodexStreamParser((event) => events.push(event));
  const call = JSON.stringify({
    type: "item.completed",
    item: {
      id: "denied",
      type: "command_execution",
      command: "kill -TERM 123",
      status: "failed",
      exit_code: 1,
      aggregated_output: "Denied: killall marker",
    },
  });
  parser.feed(call);
  parser.feed(call);
  expect(events.filter((event) => event.type === "warning")).toHaveLength(1);
  expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
});

test("executed JavaScript tools warn for process.kill while comments and printed strings stay literal", () => {
  for (const kind of ["claude", "codex"]) {
    const events: AgentEvent[] = [];
    const parser =
      kind === "claude"
        ? new ClaudeStreamParser((e) => events.push(e))
        : new CodexStreamParser((e) => events.push(e));
    for (const [id, code] of [
      ["signal-js", "process.kill(123, 'SIGTERM')"],
      ["text-js", "console.log('process.kill(123)'); // process.kill(456)"],
    ]) {
      parser.feed(
        JSON.stringify(
          kind === "claude"
            ? {
                type: "assistant",
                message: { content: [{ type: "tool_use", id, name: "node_repl", input: { code } }] },
              }
            : {
                type: "item.started",
                item: { type: "mcp_tool_call", id, server: "node_repl", tool: "js", arguments: { code } },
              },
        ),
      );
    }
    expect(events.filter((event) => event.type === "warning").map((event) => event.id)).toEqual([
      "signal-js",
    ]);
  }
});

test("configured backend auth reaches the CLI only through a key helper, never the agent environment", async () => {
  const { existsSync, statSync } = await import("node:fs");
  const { customModel, customProvider, providerFixture } = await import("./provider-config-support.ts");
  const { agentEnv, runProcess } = await import("../src/util/proc.ts");
  const { Factory } = await import("../src/app.ts");
  const { Store } = await import("../src/db/store.ts");
  const key = "ANTHROPIC_AUTH_TOKEN";
  const saved = process.env[key];
  const token = "FAKE_EXPLICIT_BACKEND_TOKEN_734";
  const savedAuth = process.env.AUTH;
  const fixture = providerFixture(
    [
      {
        ...customProvider,
        kind: "anthropic-compatible",
        base_url: "https://example.invalid",
        api_key_env: key,
        models: [{ ...customModel, efforts: [], effort: undefined }],
      },
    ],
    `${key}=${token}\n`,
  );
  const store = new Store(":memory:");
  try {
    process.env[key] = "FAKE_INHERITED_BACKEND_TOKEN_735";
    process.env.AUTH = `Bearer ${token}`;
    const factory = new Factory(fixture.load(), { store });
    expect(factory.tracker.authToken("mac-mlx")).toBe(token);
    // Explicit overrides cannot reintroduce a configured credential under any name.
    expect(agentEnv({ [key]: token, OTHER_NAME: token, KEPT: "ordinary" })).toMatchObject({
      KEPT: "ordinary",
    });
    expect(Object.values(agentEnv({ [key]: token, OTHER_NAME: token }))).not.toContain(token);
    const childEnvs: unknown[] = [];
    const extras: Record<string, string>[] = [{}, { AUTH: `Bearer ${token}` }];
    for (const extra of extras) {
      const child = await runProcess({
        cmd: [
          process.execPath,
          "-e",
          'console.log(JSON.stringify({auth: process.env.AUTH ?? "absent", kept: process.env.KEPT}))',
        ],
        cwd: fixture.work,
        env: agentEnv({ KEPT: "ordinary", ...extra }),
      });
      childEnvs.push(JSON.parse(child.stdout));
    }
    expect(childEnvs).toEqual(Array(2).fill({ auth: "absent", kept: "ordinary" }));
    const resolved = factory.router.resolveFor("triage", "mac-mlx/flash");
    const events: AgentEvent[] = [];
    const logPath = join(fixture.root, "backend.log");
    let keyFile = "";
    const result = await confinedEdit(fixture.work, (scratchDir) =>
      runClaude(
        {
          cwd: fixture.work,
          scratchDir,
          prompt: "test",
          mode: "edit",
          logPath,
          target: factory.router.toTarget(resolved.model),
          timeoutMs: 5000,
          idleTimeoutMs: 5000,
          maxToolCalls: 1,
          signal: new AbortController().signal,
          onEvent: (event) => events.push(event),
        },
        async (options) => {
          const settings: { apiKeyHelper: string } = JSON.parse(
            options.cmd[options.cmd.indexOf("--settings") + 1] ?? "{}",
          );
          keyFile = JSON.parse(settings.apiKeyHelper.replace(/^cat /, ""));
          expect(readFileSync(keyFile, "utf8")).toBe(token);
          expect(statSync(keyFile).mode & 0o077).toBe(0);
          expect(options.env?.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
          const helper = await runProcess({
            cmd: ["sh", "-c", settings.apiKeyHelper],
            cwd: fixture.work,
            env: {},
          });
          expect(helper.stdout).toBe(token);
          return runProcess({
            ...options,
            cmd: swapCommand(options.cmd, [
              process.execPath,
              "-e",
              `const leaked = Object.values(process.env).includes(${JSON.stringify(token)}); console.log(JSON.stringify({type:"result",result:"auth " + (process.env.ANTHROPIC_AUTH_TOKEN ?? "absent") + " leaked=" + leaked}));`,
            ]),
          });
        },
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.finalText).toBe("auth absent leaked=false");
    expect(existsSync(keyFile)).toBe(false);
    for (const recorded of [JSON.stringify(events), JSON.stringify(result), readFileSync(logPath, "utf8")]) {
      expect(recorded).not.toContain(token);
      expect(recorded).not.toContain(process.env[key] ?? "missing");
    }
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
    if (savedAuth === undefined) delete process.env.AUTH;
    else process.env.AUTH = savedAuth;
    store.close();
    fixture.close();
  }
});

test("configured credentials never reach native children or their events, logs and errors", async () => {
  const { writeFileSync } = await import("node:fs");
  const { customProvider, providerFixture } = await import("./provider-config-support.ts");
  const { runProcess } = await import("../src/util/proc.ts");
  const { Factory } = await import("../src/app.ts");
  const { Store } = await import("../src/db/store.ts");
  const key = "MAC_MLX_KEY";
  const saved = process.env[key];
  const fileSecret = 'FAKE_FILE_CREDENTIAL_"731';
  const envSecret = "FAKE_ENV_CREDENTIAL_732";
  const fixture = providerFixture([{ ...customProvider, api_key_env: key }], `${key}='${fileSecret}'\n`);
  const store = new Store(":memory:");
  try {
    process.env[key] = envSecret;
    const cfg = fixture.load();
    const factory = new Factory(cfg, { store });
    expect(factory.tracker.authToken("mac-mlx")).toBe(fileSecret);
    for (const harness of ["claude", "codex"] as const) {
      const events: AgentEvent[] = [];
      const logPath = join(fixture.root, `${harness}.log`);
      const child = join(fixture.root, `${harness}.ts`);
      const nested = { secret: fileSecret, other: [envSecret], readable: "ordinary diagnostic" };
      const event =
        harness === "claude"
          ? {
              type: "assistant",
              message: { content: [{ type: "tool_use", id: "call", name: "inspect", input: nested }] },
            }
          : {
              type: "item.started",
              item: { type: "mcp_tool_call", id: "call", server: "test", tool: "inspect", arguments: nested },
            };
      const textEvent =
        harness === "claude"
          ? {
              type: "assistant",
              message: {
                content: [{ type: "text", text: `ordinary diagnostic ${fileSecret} ${envSecret}` }],
              },
            }
          : {
              type: "item.completed",
              item: { type: "agent_message", text: `ordinary diagnostic ${fileSecret} ${envSecret}` },
            };
      writeFileSync(
        child,
        `console.log("child credential=" + (process.env.MAC_MLX_KEY ?? "absent")); console.log(${JSON.stringify(JSON.stringify(event))}); console.log(${JSON.stringify(JSON.stringify(textEvent))}); console.error(${JSON.stringify(`ordinary diagnostic ${fileSecret} ${envSecret}`)}); console.error(${JSON.stringify(`token=${fileSecret}; token=${fileSecret};`)}); process.exit(1);`,
      );
      const result = await confinedEdit(fixture.work, (scratchDir) =>
        (harness === "claude" ? runClaude : verifiedCodex)(
          {
            cwd: fixture.work,
            scratchDir,
            prompt: "test",
            mode: "edit",
            logPath,
            target: {
              modelId: `${harness}/test`,
              provider: harness,
              harness,
              model: "test",
              vendor: "other",
              tier: 4,
              billing: "subscription",
            },
            timeoutMs: 5000,
            idleTimeoutMs: 5000,
            maxToolCalls: 10,
            signal: new AbortController().signal,
            onEvent: (ev) => events.push(ev),
          },
          (options) => runProcess({ ...options, cmd: swapCommand(options.cmd, [process.execPath, child]) }),
        ),
      );
      expect(result.status).toBe("error");
      expect(readFileSync(logPath, "utf8")).toContain("token=[redacted]; token=[redacted];");
      expect(events).toContainEqual({ type: "status", text: "child credential=absent" });
      expect(
        events.some((e) => e.type === "tool_call" && JSON.stringify(e.input).includes("ordinary diagnostic")),
      ).toBe(true);
      for (const recorded of [
        JSON.stringify(events),
        readFileSync(logPath, "utf8"),
        JSON.stringify(result),
      ]) {
        expect(recorded).not.toContain(envSecret);
        expect(recorded).not.toContain("FAKE_FILE_CREDENTIAL_");
        expect(recorded).toContain("ordinary diagnostic");
      }
    }
    process.env[key] = "";
    writeFileSync(join(fixture.configDir, "secrets.env"), `${key}=\n`);
    fixture.load();
    expect(redactJsonLine("ordinary empty credential")).toBe("ordinary empty credential");
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
    store.close();
    fixture.close();
  }
});

test.each(['synthetic-json-"quoted"-\\slash', "synthetic-control-\n\r\t\b\f\u0001", '"\\\n'])(
  "credential redaction covers literal and JSON-escaped values: %j",
  async (secret) => {
    const { registerCredential, redactCredentials } = await import("../src/util/proc.ts");
    registerCredential("JSON_ESCAPED_TEST_TOKEN", secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(redactCredentials(secret)).toBe("[redacted]");
    expect(redactCredentials(escaped)).toBe("[redacted]");
    const logged = JSON.stringify({ credential: secret });
    expect(redactCredentials(logged)).toBe(secret.length >= 8 ? '{"credential":"[redacted]"}' : logged);
  },
);

test("short credentials only match whole values while eight-character keys match substrings", async () => {
  const { customProvider, providerFixture } = await import("./provider-config-support.ts");
  const { agentEnv, redactCredentials } = await import("../src/util/proc.ts");
  const fixture = providerFixture(
    [
      { ...customProvider, api_key_env: "LIMITLESS_TEST_SHORT_KEY" },
      { ...customProvider, id: "boundary", api_key_env: "LIMITLESS_TEST_EIGHT_KEY" },
    ],
    "LIMITLESS_TEST_SHORT_KEY=shrt735\nLIMITLESS_TEST_EIGHT_KEY=eight735\n",
  );
  try {
    fixture.load();
    expect(redactCredentials("token=shrt735; token=shrt735;")).toBe("token=shrt735; token=shrt735;");
    expect(redactCredentials("token=eight735; token=eight735;")).toBe("token=[redacted]; token=[redacted];");
    const env = agentEnv({
      EXACT_SHORT: "shrt735",
      SHORT_ALIAS: "Bearer shrt735",
      EIGHT_ALIAS: "Bearer eight735",
      KEPT: "ordinary",
    });
    expect(env.EXACT_SHORT).toBeUndefined();
    expect(env.EIGHT_ALIAS).toBeUndefined();
    expect(env.SHORT_ALIAS).toBe("Bearer shrt735");
    expect(env.KEPT).toBe("ordinary");
  } finally {
    fixture.close();
  }
});

test("a credential inside the model name never reaches the log header", async () => {
  const { writeFileSync } = await import("node:fs");
  const { customProvider, providerFixture } = await import("./provider-config-support.ts");
  const { runProcess } = await import("../src/util/proc.ts");
  const key = "org/backend-secret";
  const fixture = providerFixture(
    [{ ...customProvider, api_key_env: "HEADER_TEST_KEY" }],
    `HEADER_TEST_KEY=${key}\n`,
  );
  try {
    fixture.load();
    const child = join(fixture.root, "child.ts");
    writeFileSync(child, "process.exit(1);");
    for (const harness of ["claude", "codex"] as const) {
      const logPath = join(fixture.root, `${harness}.log`);
      await confinedEdit(fixture.work, (scratchDir) =>
        (harness === "claude" ? runClaude : verifiedCodex)(
          {
            cwd: fixture.work,
            scratchDir,
            prompt: "test",
            mode: "edit",
            logPath,
            target: {
              modelId: `${harness}/test`,
              provider: harness,
              harness,
              model: key,
              vendor: "other",
              tier: 4,
              billing: "subscription",
            },
            timeoutMs: 5000,
            idleTimeoutMs: 5000,
            maxToolCalls: 10,
            signal: new AbortController().signal,
            onEvent: () => {},
          },
          (options) => runProcess({ ...options, cmd: swapCommand(options.cmd, [process.execPath, child]) }),
        ),
      );
      const header = readFileSync(logPath, "utf8").split("\n")[0] ?? "";
      expect(header).toStartWith(`# ${harness} [redacted] `);
      expect(header).not.toContain(key);
    }
  } finally {
    fixture.close();
  }
});

const installationLayouts = ["Homebrew", "standalone", "codex-home", "aws", "home"] as const;
function codexInstallation(layout: (typeof installationLayouts)[number]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-install-")));
  const home = join(root, "home");
  const bin = {
    Homebrew: join(root, "opt/homebrew/Cellar/codex/test/bin"),
    standalone: join(home, ".codex/packages/standalone/releases/test-target/bin"),
    "codex-home": join(home, ".codex"),
    aws: join(home, ".aws"),
    home,
  }[layout];
  const link = join(home, ".local/bin/codex");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const executable = join(bin, "codex");
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  if (layout === "standalone") {
    const current = join(home, ".codex/packages/standalone/current");
    symlinkSync(dirname(bin), current);
    symlinkSync(join(current, "bin/codex"), link);
  } else symlinkSync(executable, link);
  const cwd = join(root, "checkout");
  mkdirSync(cwd);
  return { root, home, bin, executable, link, cwd };
}

function installationSpec(cwd: string, scratchDir: string): AgentSpec {
  return {
    cwd,
    scratchDir,
    prompt: "fixture",
    mode: "edit",
    target: {
      modelId: "codex/test",
      provider: "codex",
      harness: "codex",
      model: "test",
      vendor: "openai",
      tier: 4,
      billing: "subscription",
    },
    signal: new AbortController().signal,
    onEvent() {},
    logPath: join(scratchDir, "log"),
    timeoutMs: 1000,
    idleTimeoutMs: 1000,
    maxToolCalls: 1,
  };
}

function filesystemEntries(args: string[]): [string, string][] {
  const config = args.find((arg) => arg.startsWith("permissions=")) ?? "";
  return [...config.matchAll(/("(?:[^"\\]|\\.)*")="(read|write|none)"/g)].map((match) => [
    JSON.parse(match[1] ?? '""') as string,
    match[2] ?? "",
  ]);
}

function filesystemAccess(entries: [string, string][], file: string) {
  return entries
    .filter(([path]) => file === path || file.startsWith(path === "/" ? path : `${path}/`))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1];
}

function installationProfile(args: string[]) {
  return args
    .filter((arg) => arg.startsWith("default_permissions=") || arg.startsWith("permissions="))
    .flatMap((arg) => ["-c", arg]);
}

test.each([...installationLayouts])("Codex canonical installation profiles (%s)", async (layout) => {
  const install = codexInstallation(layout);
  const lookup = spyOn(Bun, "which").mockReturnValue(install.link);
  try {
    const executable = new CodexReaderProbe().resolve();
    expect(executable).toBe(install.executable);
    const deniedChild = join(install.bin, "private/token");
    mkdirSync(dirname(deniedChild));
    writeFileSync(deniedChild, "private-canary");
    const deniedAlias = join(install.root, "private-alias");
    symlinkSync(dirname(deniedChild), deniedAlias);
    await withScratch(install.cwd, async (scratchDir) => {
      await readPolicyScope.run({ home: install.home, environment: {} }, async () => {
        const codexHome = join(install.home, ".codex");
        for (const [mode, confineReads] of [
          ["edit", false],
          ["readonly", false],
          ["readonly", true],
        ] as const) {
          const spec = {
            ...installationSpec(install.cwd, scratchDir),
            mode,
            confineReads,
            denyRead: [codexHome, join(install.home, ".aws")],
          };
          const entries = filesystemEntries(buildCodexArgs(spec, executable));
          expect(entries).toContainEqual([executable, "read"]);
          expect(entries).toContainEqual([codexHome, "none"]);
          expect(filesystemAccess(entries, join(codexHome, "auth.json"))).toBe("none");
          expect(new Set(entries.map(([path]) => path)).size).toBe(entries.length);
          if (layout === "Homebrew" || layout === "standalone")
            expect(entries).toContainEqual([install.bin, "read"]);
          else expect(entries).not.toContainEqual([install.bin, "read"]);
          expect(entries).not.toContainEqual([install.home, "read"]);
          // Root-level installations must add only the file; confined readers must keep / absent.
          const rootEntries = filesystemEntries(buildCodexArgs(spec, "/codex"));
          expect(rootEntries).toContainEqual(["/codex", "read"]);
          expect(rootEntries.filter(([path]) => path === "/")).toHaveLength(confineReads ? 0 : 1);
          expect(new Set(rootEntries.map(([path]) => path)).size).toBe(rootEntries.length);
          // Even a denied executable gets one exact-file exception, without duplicate TOML keys.
          const deniedExecutable = filesystemEntries(
            buildCodexArgs(
              {
                ...spec,
                denyRead: [...spec.denyRead, executable],
              },
              executable,
            ),
          );
          expect(new Set(deniedExecutable.map(([path]) => path)).size).toBe(deniedExecutable.length);
          expect(filesystemAccess(deniedExecutable, executable)).toBe("read");
          // An ancestor of a caller-denied file must not become a directory allowance.
          const restricted = filesystemEntries(
            buildCodexArgs(
              {
                ...spec,
                denyRead: [...spec.denyRead, join(deniedAlias, "token")],
              },
              executable,
            ),
          );
          expect(restricted).not.toContainEqual([install.bin, "read"]);
          expect(filesystemAccess(restricted, deniedChild)).toBe("none");
        }
      });
    });
  } finally {
    lookup.mockRestore();
    rmSync(install.root, { recursive: true, force: true });
  }
});

test("Codex ordinary readers run the verified executable", async () => {
  const install = codexInstallation("standalone");
  try {
    await withScratch(install.cwd, async (scratchDir) => {
      const probe = new CodexReaderProbe(() => install.executable);
      const verify = spyOn(probe, "verify").mockResolvedValue({
        ok: true,
        path: install.executable,
        version: "codex-cli 0.157.1",
        reason: null,
        exitCode: 0,
      });
      let command: string[] = [];
      await runCodex(
        {
          ...installationSpec(install.cwd, scratchDir),
          mode: "readonly",
          confineReads: false,
        },
        async ({ cmd }) => {
          command = cmd;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "fixture",
            timedOut: false,
            idleTimedOut: false,
            cancelled: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          };
        },
        probe,
      );
      expect(verify).toHaveBeenCalledTimes(1);
      expect(command[0]).toBe(install.executable);
      expect(filesystemEntries(command)).toContainEqual([install.executable, "read"]);
    });
  } finally {
    rmSync(install.root, { recursive: true, force: true });
  }
});

const sandboxCodex = Bun.which("codex");
const codexSandboxSkip = sandboxCodex ? null : "no codex on PATH";

function slottedInstallation(layout: "local" | "Homebrew") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slotted-install-")));
  const home = join(root, "home"),
    cwd = join(root, "checkout");
  const prefix = join(home, "homebrew"),
    cellar = join(prefix, "Cellar/limitless/test");
  const executable = layout === "local" ? join(home, ".local/bin/limitless") : join(cellar, "bin/limitless");
  for (const dir of [dirname(executable), cwd, join(home, ".aws")]) mkdirSync(dir, { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  let link = executable;
  if (layout === "Homebrew") {
    for (const dir of ["bin", "opt"]) mkdirSync(join(prefix, dir));
    symlinkSync("../Cellar/limitless/test", join(prefix, "opt/limitless"));
    link = join(prefix, "bin/limitless");
    symlinkSync("../opt/limitless/bin/limitless", link);
  }
  const secret = join(home, ".aws/token"),
    unrelated = join(dirname(executable), "unrelated");
  writeFileSync(secret, "credential-canary");
  writeFileSync(unrelated, "#!/bin/sh\necho denied\n", { mode: 0o755 });
  return { root, home, cwd, executable, link, secret, unrelated };
}

test.each(["local", "Homebrew"] as const)(
  "slotted binary installation needs no new directory grants (%s)",
  async (layout) => {
    const install = slottedInstallation(layout);
    try {
      await withScratch(install.cwd, (scratchDir) =>
        readPolicyScope.run({ home: install.home, environment: {} }, async () => {
          const spec = {
            ...installationSpec(install.cwd, scratchDir),
            denyRead: [install.secret, install.unrelated],
          };
          for (const mode of ["edit", "readonly"] as const) {
            const entries = filesystemEntries(buildCodexArgs({ ...spec, mode }));
            for (const file of [install.link, realpathSync(install.link)])
              expect(filesystemAccess(entries, file)).toBe("read");
            for (const file of [install.secret, install.unrelated])
              expect(filesystemAccess(entries, file)).toBe("none");
            expect(entries).not.toContainEqual([dirname(install.executable), "read"]);
          }
          const roots = writeRoots(spec.cwd, scratchDir, false, spec.denyRead);
          expect(roots.allowRead).toBeUndefined();
          expect(roots.denyRead).toContain(install.unrelated);
          for (const mode of ["edit", "readonly"] as const) {
            const args = buildClaudeArgs({ ...spec, mode }, "probe");
            const filesystem = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}").sandbox.filesystem;
            expect(filesystem.allowRead).toBeUndefined();
            expect(filesystem.denyRead).toContain(install.unrelated);
            for (const file of [install.link, realpathSync(install.link)])
              expect(filesystem.denyRead.some((p: string) => file === p || file.startsWith(`${p}/`))).toBe(
                false,
              );
          }
        }),
      );
    } finally {
      rmSync(install.root, { recursive: true, force: true });
    }
  },
);

for (const sandbox of ["codex-editor", "codex-reader", "claude-editor", "claude-reader"] as const) {
  const skip = seatbeltSkip ?? (sandbox.startsWith("codex") ? codexSandboxSkip : null);
  test.skipIf(skip !== null)(
    `slotted installation execution via ${sandbox} (${skip ?? "available"})`,
    async () => {
      for (const layout of ["local", "Homebrew"] as const) {
        const install = slottedInstallation(layout);
        try {
          await withScratch(install.cwd, (scratchDir) =>
            readPolicyScope.run({ home: install.home, environment: {} }, async () => {
              const spec = {
                ...installationSpec(install.cwd, scratchDir),
                mode: sandbox.endsWith("reader") ? ("readonly" as const) : ("edit" as const),
                denyRead: [install.secret, install.unrelated],
              };
              const execute = async (command: string[]) => {
                let cmd = command;
                let extra: NodeJS.ProcessEnv = {};
                if (sandbox.startsWith("codex")) {
                  if (!sandboxCodex) throw new Error("no codex on PATH");
                  cmd = [
                    sandboxCodex,
                    "sandbox",
                    ...installationProfile(buildCodexArgs(spec)),
                    "--",
                    ...command,
                  ];
                  extra = { CODEX_HOME: scratchDir };
                } else if (sandbox === "claude-editor")
                  cmd = seatbeltBackend.wrap(
                    command,
                    writeRoots(install.cwd, scratchDir, false, spec.denyRead),
                  );
                else {
                  const args = buildClaudeArgs(spec, "probe");
                  const filesystem = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}").sandbox
                    .filesystem;
                  await SandboxManager.initialize(
                    { filesystem, network: { allowedDomains: [], deniedDomains: [] } },
                    undefined,
                    false,
                  );
                  const wrapped = await SandboxManager.wrapWithSandboxArgv(
                    command.map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(" "),
                    "/bin/bash",
                    undefined,
                    spec.signal,
                    install.cwd,
                  );
                  cmd = wrapped.argv;
                  extra = wrapped.env;
                }
                return runProcess({
                  cmd,
                  cwd: install.cwd,
                  env: agentEnv({ ...extra, TMPDIR: scratchDir }),
                  timeoutMs: 5000,
                });
              };
              try {
                for (const file of [install.link, realpathSync(install.link)]) {
                  const observed = await execute([file, "installation-ok"]);
                  expect(observed.exitCode).toBe(0);
                  expect(observed.stdout.trim()).toBe("installation-ok");
                }
                expect((await execute(["/bin/cat", install.secret])).exitCode).not.toBe(0);
                expect((await execute([install.unrelated])).exitCode).not.toBe(0);
              } finally {
                if (sandbox === "claude-reader") await SandboxManager.reset();
              }
            }),
          );
        } finally {
          rmSync(install.root, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
}

test.skipIf(seatbeltSkip !== null || codexSandboxSkip !== null)(
  `Codex installation helper executes while credentials and unrelated home executables stay denied${seatbeltSkip || codexSandboxSkip ? ` (skipped: ${seatbeltSkip ?? codexSandboxSkip})` : ""}`,
  async () => {
    if (!sandboxCodex) throw new Error("no codex on PATH");
    for (const layout of ["standalone", "codex-home"] as const) {
      const install = codexInstallation(layout);
      const auth = join(install.home, ".codex/auth.json");
      const unrelated = join(install.home, "unrelated");
      writeFileSync(auth, "credential-canary");
      writeFileSync(unrelated, "#!/bin/sh\necho unrelated-ok\n", { mode: 0o755 });
      try {
        await withScratch(install.cwd, async (scratchDir) => {
          await readPolicyScope.run({ home: install.home, environment: {} }, async () => {
            const spec = {
              ...installationSpec(install.cwd, scratchDir),
              mode: "readonly" as const,
              confineReads: true,
              denyRead: [install.home, join(install.home, ".codex")],
            };
            const profile = installationProfile(buildCodexArgs(spec, realpathSync(install.link)));
            const execute = (command: string[], sandbox = true) =>
              runProcess({
                cmd: sandbox ? [sandboxCodex, "sandbox", ...profile, "--", ...command] : command,
                cwd: install.cwd,
                env: agentEnv({ CODEX_HOME: scratchDir }),
                timeoutMs: 5000,
              });
            for (const path of [install.link, install.executable]) {
              const outside = await execute([path, "helper-ok"], false);
              expect(outside.exitCode).toBe(0);
              expect(outside.stdout.trim()).toBe("helper-ok");
              const positive = await execute([path, "helper-ok"]);
              expect(positive.exitCode).toBe(0);
              expect(positive.stdout.trim()).toBe("helper-ok");
            }
            expect((await execute(["/bin/cat", auth])).exitCode).not.toBe(0);
            const outside = await execute([unrelated], false);
            expect(outside.exitCode).toBe(0);
            expect(outside.stdout.trim()).toBe("unrelated-ok");
            expect((await execute([unrelated])).exitCode).not.toBe(0);
          });
        });
      } finally {
        rmSync(install.root, { recursive: true, force: true });
      }
    }
  },
  30_000,
);
