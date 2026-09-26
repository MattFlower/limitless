import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCodexModels,
  exitCode,
  formatReport,
  liveCheck,
  quotaCheck,
  runChecks,
} from "../scripts/smoke.ts";
import { deploy } from "../src/cli/service.ts";
import { CodexStreamParser } from "../src/harness/codex.ts";
import type { AgentResult, ModelTarget } from "../src/harness/types.ts";
import { MODELS } from "../src/router/catalog.ts";
import type { sh } from "../src/util/proc.ts";

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
    const rows = await runChecks([
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
    ]);
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
    if (args.join(" ") === "bun run smoke") throw new Error("injected smoke failure");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  try {
    await expect(deploy(7400, "feature", true, { releaseDir: dir, command })).rejects.toThrow(
      "deploy gate failed; staying on previous",
    );
    expect(selected).toBe("previous-commit");
    expect(calls).toEqual([
      "git rev-parse HEAD",
      "git fetch origin --prune",
      "git rev-parse feature",
      "git checkout -q --detach next-commit",
      "bun install --frozen-lockfile",
      "bun run check",
      "bun run smoke",
      "git checkout -q --detach previous-commit",
      "bun install --frozen-lockfile",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
