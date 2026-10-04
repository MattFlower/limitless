import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildClaudeArgs, ClaudeStreamParser, runClaude } from "../src/harness/claude.ts";
import { buildCodexArgs, CodexStreamParser, parseRateLimits, runCodex } from "../src/harness/codex.ts";
import { withScratch } from "../src/harness/scratch.ts";
import {
  type AgentEvent,
  type AgentSpec,
  extractJson,
  LoopDetector,
  priceOf,
  redactJsonLine,
} from "../src/harness/types.ts";
import { redactHoldoutText } from "../src/pipeline/prompts.ts";

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
});

test("priceOf charges cache reads at a discount", () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
  expect(priceOf(usage, { input: 2, output: 10 })).toBeCloseTo(2 + 10 + 0.2);
  expect(priceOf(usage, undefined)).toBe(0);
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
