import { expect, test } from "bun:test";
import type { Invocation } from "../src/core/types.ts";
import { renderReport } from "../src/pipeline/report.ts";

const inv: Invocation = {
  id: 1,
  runId: "r1",
  stageId: 1,
  role: "implement",
  harness: "codex",
  provider: "codex",
  model: "gpt-6-astra",
  effort: null,
  modelId: "codex/astra",
  status: "ok",
  costUsd: 0,
  costEquivUsd: 1.5,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 3000,
  numTurns: 4,
  sessionId: null,
  error: null,
  startedAt: 0,
  finishedAt: 42_000,
};

test("markdown tables are contiguous blocks", () => {
  const md = renderReport({
    success: true,
    runId: "r1",
    prompt: "Do the thing\nwith two lines",
    state: {
      spec: {
        summary: "s",
        assumptions: ["a1"],
        requirements: [],
        acceptance_criteria: [
          { id: "AC-1", criterion: "works | fully", how_to_verify: "run it" },
          { id: "AC-2", criterion: "edge", how_to_verify: "run it" },
        ],
        out_of_scope: [],
        blocking_questions: [],
      },
      lastVerify: {
        modelId: "claude/sonnet",
        overall: "pass",
        notes: "",
        criteria: [
          { id: "AC-1", status: "met", evidence: "ok" },
          { id: "AC-2", status: "met", evidence: "ok" },
        ],
      },
    },
    invocations: [inv],
    totals: { costUsd: 0, costEquivUsd: 1.5 },
    runUrl: "http://localhost:7400/runs/r1",
  });
  expect(md).toContain("> Do the thing\n> with two lines");
  // Header, separator and rows must be on consecutive lines.
  expect(md).toContain(
    "|  | Criterion | Evidence |\n|---|---|---|\n| ✅ AC-1 | works \\| fully | ok |\n| ✅ AC-2 | edge | ok |",
  );
  expect(md).toContain(
    "| implement | `codex/astra` | unknown (legacy) | ok | 4,000 / 200 | $1.50 equiv. | 42s |",
  );
  expect(md).toContain("No automated checks were detected");
  expect(md.startsWith("Built by **Limitless**")).toBe(true);
});

test("needs-human report says so", () => {
  const md = renderReport({
    success: false,
    runId: "r2",
    prompt: "x",
    state: {},
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
  });
  expect(md).toContain("needs a human");
});

test("reports for runs started from an issue close it", () => {
  const md = renderReport({
    success: true,
    runId: "r3",
    prompt: "x",
    state: {},
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
    closesIssue: 3,
  });
  expect(md).toContain("Closes #3");
});

test("report rows show low, high, none and unknown effort independently", () => {
  const md = renderReport({
    success: true,
    runId: "r1",
    prompt: "test",
    state: {},
    invocations: (["low", "high", "none", "default", null] as const).map((effort) => ({ ...inv, effort })),
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
  });
  for (const effort of ["low", "high", "none", "backend default", "unknown (legacy)"])
    expect(md).toContain(`| \`codex/astra\` | ${effort} | ok |`);
});
