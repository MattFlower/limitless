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
          { id: "AC-1", status: "met", evidence: "ok", publicSummary: "" },
          { id: "AC-2", status: "met", evidence: "ok", publicSummary: "" },
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
  expect(md).toContain("Flow: build");
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

test("blocked acceptance and holdout checks have a distinct marker, label, evidence and terminal reason", () => {
  const report = renderReport({
    success: false,
    runId: "blocked",
    prompt: "test",
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
    state: {
      terminalReason: "verification blocked by the environment",
      spec: {
        summary: "test",
        assumptions: [],
        requirements: [],
        out_of_scope: [],
        blocking_questions: [],
        acceptance_criteria: ["AC-1", "AC-2", "AC-3", "AC-4"].map((id) => ({
          id,
          criterion: id,
          how_to_verify: "test",
        })),
      },
      holdout: {
        scenarios: [
          { id: "H-1", description: "check", steps: "bun test", expected: "pass", edge_case: true },
        ],
      },
      lastVerify: {
        modelId: "test/model",
        overall: "fail",
        notes: "",
        criteria: [
          { id: "AC-1", status: "blocked", evidence: "bun test failed: EPERM fixture", publicSummary: "" },
          { id: "AC-2", status: "met", evidence: "passed", publicSummary: "" },
          { id: "AC-3", status: "unmet", evidence: "assertion failure", publicSummary: "" },
          { id: "AC-4", status: "unclear", evidence: "not established", publicSummary: "" },
          { id: "H-1", status: "blocked", evidence: "build failed: EACCES output", publicSummary: "" },
        ],
      },
    },
  });
  for (const text of [
    "🚧 blocked AC-1",
    "🚧 blocked",
    "EPERM fixture",
    "EACCES output",
    "verification blocked by the environment",
    "✅ AC-2",
    "❌ AC-3",
    "❔ AC-4",
  ])
    expect(report).toContain(text);
});

test("verification report names the flow without an implementer", () => {
  const md = renderReport({
    success: true,
    runId: "verify",
    prompt: "bump",
    state: { flow: "verify-change" },
    invocations: [{ ...inv, role: "review" }],
    totals: { costUsd: 0, costEquivUsd: 1.5 },
    runUrl: "u",
  });
  expect(md).toContain("Verified by **Limitless**");
  expect(md).toContain("Flow: verify-change");
  expect(md).not.toContain("Implementer's summary");
});

test("holdout counts separate blocking results from not-required follow-up notes", () => {
  const scenario = (id: string, description: string) => ({
    id,
    description,
    steps: "s",
    expected: "e",
    edge_case: true,
  });
  const md = renderReport({
    success: false,
    runId: "r4",
    prompt: "x",
    state: {
      holdout: {
        scenarios: [
          scenario("H-1", "happy path"),
          scenario("H-2", "invented flag"),
          scenario("H-3", "unicode input"),
          scenario("H-4", "legacy result"),
          scenario("H-5", "flaky sandbox"),
        ],
      },
      lastVerify: {
        modelId: "claude/sonnet",
        overall: "fail",
        notes: "",
        criteria: [
          { id: "H-1", status: "met", evidence: "ok", publicSummary: "" },
          {
            id: "H-2",
            status: "unmet",
            evidence: "no such flag exists in this CLI",
            publicSummary: "",
            requirement: "not_required",
          },
          { id: "H-3", status: "unmet", evidence: "crashes", publicSummary: "", requirement: "request" },
          { id: "H-4", status: "unmet", evidence: "wrong output", publicSummary: "" },
          { id: "H-5", status: "unclear", evidence: "not established", publicSummary: "" },
        ],
      },
    },
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
  });
  expect(md).toContain("Holdouts not met: 3 blocking, 1 not required.");
  expect(md).toContain("| H-2 | invented flag | unmet (not required) | no such flag exists in this CLI |");
  expect(md).toContain("| H-3 | unicode input | unmet (request) | crashes |");
  expect(md).toContain("| H-4 | legacy result | unmet (unclassified) | wrong output |");
  expect(md).toContain("- H-2: invented flag — no such flag exists in this CLI");
  expect(md).not.toContain("- H-3: unicode input");
});
