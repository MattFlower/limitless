import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const totals = {
  invocations: 2,
  successfulShare: 0.5,
  countingUnits: { invocation: 2, round: 0, trial: 0 },
  tokensIn: 30,
  inputTokens: 20,
  tokensOut: 8,
  cacheReadTokens: 6,
  cacheWriteTokens: 4,
  costUsd: 0.25,
  costEquivUsd: 0.5,
  wallTimeMs: 400,
  p50WallTimeMs: 200,
};
const identity = { provider: "retired", modelId: "old-model" };
const legacy = { provider: "retired", today: {}, sevenDays: {} };
const interrupted = {
  ...totals,
  invocations: 1,
  successfulShare: 0,
  countingUnits: { invocation: 0, round: 0, trial: 1 },
  tokensIn: null,
  inputTokens: null,
  tokensOut: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
  costEquivUsd: null,
  wallTimeMs: 0,
  p50WallTimeMs: null,
};
const compound = {
  provider: null,
  modelId: null,
  compound: true,
  participants: ["alpha/finder", "beta/verifier"],
  ...interrupted,
};
const rows = [
  {
    ...legacy,
    extraField: "preserved",
    production: {
      totals,
      models: [{ ...identity, ...totals }],
      roles: [{ ...identity, role: "review_shadow", ...totals }],
      days: [{ ...identity, day: "2026-09-01", ...totals }],
    },
    eval: {
      totals: { ...totals, countingUnits: { invocation: 0, round: 0, trial: 2 } },
      models: [],
      roles: [],
      days: [],
    },
  },
  {
    provider: "(compound/unattributed)",
    today: {},
    sevenDays: {},
    eval: {
      totals: interrupted,
      models: [compound],
      roles: [{ ...compound, role: "review" }],
      days: [{ ...compound, day: "2026-09-01" }],
    },
  },
];
let dir: string;
let preload: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-provider-stats-cli-"));
  preload = join(dir, "fetch.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    console.error("REQUEST " + url.pathname + url.search);
    return Response.json(process.env.STATS_LEGACY ? ${JSON.stringify([legacy])} : ${JSON.stringify(rows)});
  };`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
async function cli(args: string[], oldDaemon = false) {
  const child = Bun.spawn(
    [process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli/main.ts"), "stats", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, STATS_LEGACY: oldDaemon ? "1" : "" },
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("stats providers emits only endpoint JSON and forwards the ISO cutoff", async () => {
  const since = "2026-09-01T02:00:00+02:00";
  const result = await cli(["providers", "--since", since, "--json"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe(`REQUEST /api/stats/providers?since=${encodeURIComponent(since)}\n`);
  expect(JSON.parse(result.stdout)).toEqual(rows);
});
test("stats providers prints section, provider/model, role/day and unit labels", async () => {
  const result = await cli(["providers"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("REQUEST /api/stats/providers\n");
  for (const text of [
    "Production",
    "Eval",
    "retired",
    "models: retired old-model",
    "roles: retired old-model review_shadow",
    "days: retired old-model 2026-09-01",
    "success 0.5",
    "cache-read 6",
    "tokens",
    "metered $0.25",
    "API-equivalent $0.5",
    "total 400 ms",
    "p50 200 ms",
    '"trial":2',
    "(compound/unattributed)",
    "compound [alpha/finder, beta/verifier]",
    "compound [alpha/finder, beta/verifier] review",
    "compound [alpha/finder, beta/verifier] 2026-09-01",
    "input unknown, output unknown, cache-read unknown, cache-write unknown",
    "metered $unknown, API-equivalent $unknown",
    "total 0 ms, p50 unknown ms",
  ])
    expect(result.stdout).toContain(text);
});
test("both output modes tolerate an older daemon without historical sections", async () => {
  const human = await cli(["providers"], true);
  expect(human.exit).toBe(0);
  expect(human.stdout).toContain("historical statistics unavailable");
  const json = await cli(["providers", "--json"], true);
  expect(json.exit).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual([legacy]);
});
test.each([
  [[], "usage: limitless stats providers"],
  [["other"], "usage: limitless stats providers"],
  [["providers", "--since"], "--since"],
  [["providers", "--since", "--json"], "--since"],
  [["providers", "--since", ""], "invalid ISO-8601"],
  [["providers", "--since", "2026-02-30"], "invalid ISO-8601"],
  [["providers", "--since", "tomorrow"], "invalid ISO-8601"],
])("invalid stats options %j fail before fetching", async (args, message) => {
  const result = await cli(args);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("REQUEST");
  expect(result.stdout).toBe("");
});
