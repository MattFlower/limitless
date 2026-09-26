import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCode, formatReport, quotaCheck, runChecks } from "../scripts/smoke.ts";
import { deploy } from "../src/cli/service.ts";
import type { AgentResult } from "../src/harness/types.ts";
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
