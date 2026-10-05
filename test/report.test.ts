import { expect, test } from "bun:test";
import type { Invocation } from "../src/core/types.ts";
import { computeStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import { compareGates, type GateRun } from "../src/gates/run.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { renderReport, verifiedFailureState } from "../src/pipeline/report.ts";

const inv: Invocation = {
  waitMs: 0,
  fast: false,
  fastModeState: null,
  fastModeDisabledReason: null,
  id: 1,
  runId: "r1",
  stageId: 1,
  role: "implement",
  harness: "codex",
  provider: "codex",
  model: "gpt-6.1-sol",
  effort: null,
  modelId: "codex/sol-6.1",
  status: "ok",
  costUsd: 0,
  costEquivUsd: 1.5,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 3000,
  cacheWriteTokens: 500,
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
        modelId: "claude/sonnet-5.5",
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
    "| implement | `codex/sol-6.1` | unknown (legacy) | ok | 4,500 / 200 | 3,000 | 500 | $1.50 equiv. | 42s |",
  );
  expect(md).toContain("No automated checks were detected");
  expect(md.startsWith("Built by **Limitless**")).toBe(true);
  expect(md).toContain("Flow: build");
});

test("routing identifies a model experiment and lists full chains alongside actual invocations", () => {
  const md = renderReport({
    success: true,
    runId: "r1",
    prompt: "Try models",
    state: {},
    invocations: [inv],
    totals: { costUsd: 0, costEquivUsd: 1.5 },
    runUrl: "u",
    models: { implement: ["codex/sol-6.1@high", "claude/opus"], review: ["claude/opus|codex/sol"] },
  });
  expect(md).toContain("## Routing — model experiment");
  expect(md).toContain("- implement: `codex/sol-6.1@high, claude/opus`");
  expect(md).toContain("- review: `claude/opus|codex/sol`");
  expect(md).toContain("| implement | `codex/sol-6.1`");
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

test("the code review section lists every panel review and the diff it covered", () => {
  const render = (reviewHistory: NonNullable<Parameters<typeof renderReport>[0]["state"]["reviewHistory"]>) =>
    renderReport({
      success: false,
      runId: "r4",
      prompt: "x",
      state: {
        lastReview: { verdict: "approve", summary: "Checked", findings: [], modelId: "m", mode: "panel" },
        reviewHistory,
      },
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "u",
    });
  const entry = { sha: "s", blocking: [], followUps: [] };
  expect(
    render([
      { ...entry, round: 1, panelReview: 1, scope: { kind: "full", range: "base1..head1" } },
      { ...entry, round: 2, panelReview: 2, scope: { kind: "fix", range: "head1..head2" } },
      { ...entry, round: 4, panelReview: 3, scope: { kind: "fix", range: "head2..head3" } },
    ]),
  ).toContain(
    "## Code review (`m`)\n\n- Panel review R1 — full change `base1..head1`\n- Panel review R2 — fix diff `head1..head2`\n- Panel review R3 — fix diff `head2..head3`\n\n**approve** — Checked",
  );
  expect(render([{ ...entry, round: 1 }])).not.toContain("Panel review");
  // A conflict-resolution review is listed apart from R1-R3, never as a fourth review.
  const withResolution = render([
    { ...entry, round: 0, panelReview: 1, scope: { kind: "full", range: "base1..head1" } },
    { ...entry, round: 1, scope: { kind: "resolution", range: "base2..head2" } },
  ]);
  expect(withResolution).toContain(
    "- Panel review R1 — full change `base1..head1`\n- Conflict-resolution review — change against the new base `base2..head2`\n\n**approve**",
  );
  expect(withResolution).not.toContain("R2");
});

test("single-mode verified-failure reports keep live follow-ups, as on main", () => {
  const followUp = {
    severity: "minor" as const,
    security: false,
    file: "a.ts",
    line: 1,
    title: "Found in the resolution round",
    detail: "d",
    suggestion: "s",
  };
  const approved = { verdict: "approve" as const, summary: "Verified", findings: [], modelId: "m" };
  const state: RunState = {
    phase: "deliver",
    answers: [],
    round: 2,
    roundsOnImplementer: 2,
    triedImplementers: [],
    feedback: null,
    toolCommands: [],
    lastReview: { ...approved, verdict: "request_changes", summary: "Resolution blocked" },
    reviewHistory: [{ round: 1, sha: "h1", blocking: [], followUps: [followUp] }],
    reviewFollowUps: [followUp],
    lastVerifiedEvidence: { lastReview: approved },
  };
  const restored = verifiedFailureState(state);
  expect(restored.lastReview).toEqual(approved);
  expect(restored.reviewFollowUps).toEqual([followUp]);
  const md = renderReport({
    success: false,
    runId: "r6",
    prompt: "x",
    state: restored,
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
    verifiedFailure: { sha: "h0", stage: "conflict resolution", reason: "review", base: "main" },
  });
  expect(md).toContain("## Code review (`m`)\n\n**approve** — Verified");
  expect(md).toContain("Found in the resolution round");
});

test("a verified-failure report lists only the reviews up to the saved approval", () => {
  const entry = { blocking: [], followUps: [] };
  const approved = {
    verdict: "approve" as const,
    summary: "R1 approved",
    findings: [],
    modelId: "m",
    mode: "panel" as const,
  };
  const r1 = {
    ...entry,
    round: 1,
    sha: "head1",
    panelReview: 1,
    scope: { kind: "full" as const, range: "base..head1" },
  };
  const r2 = {
    ...entry,
    round: 2,
    sha: "head2",
    panelReview: 2,
    scope: { kind: "fix" as const, range: "head1..head2" },
  };
  const live: RunState = {
    phase: "deliver",
    answers: [],
    round: 2,
    roundsOnImplementer: 2,
    triedImplementers: [],
    feedback: null,
    toolCommands: [],
    lastReview: { ...approved, verdict: "request_changes" as const, summary: "R2 blocked" },
    reviewHistory: [r1, r2],
    reviewFollowUps: [],
    lastVerifiedEvidence: { lastReview: approved, reviewHistory: [r1] },
  };
  const restored = verifiedFailureState(live);
  expect(restored.lastReview).toEqual(approved);
  expect(restored.reviewHistory).toEqual([r1]);
  const md = renderReport({
    success: false,
    runId: "r5",
    prompt: "x",
    state: restored,
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
    verifiedFailure: { sha: "head1", stage: "conflict resolution", reason: "gates", base: "main" },
  });
  expect(md).toContain("- Panel review R1 — full change `base..head1`\n\n**approve** — R1 approved");
  expect(md).not.toContain("R2");
  // Evidence saved before the history was kept with it cannot vouch for any round: list none.
  expect(
    verifiedFailureState({ ...live, lastVerifiedEvidence: { lastReview: approved } }).reviewHistory,
  ).toBeUndefined();
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
    expect(md).toContain(`| \`codex/sol-6.1\` | ${effort} | ok |`);
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
        modelId: "claude/sonnet-5.5",
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

test("shadow review calls stay out of the work log and per-model review stats; their spend is its own line", () => {
  const review: Invocation = { ...inv, id: 2, role: "review", modelId: "claude/opus", costEquivUsd: 1 };
  const shadow: Invocation[] = [
    { ...review, id: 3, role: "review_shadow", modelId: "codex/shadow-a", costUsd: 0.02, costEquivUsd: 0.25 },
    {
      ...review,
      id: 4,
      role: "review_shadow",
      modelId: "codex/shadow-b",
      costEquivUsd: 0.1,
      status: "timeout",
    },
  ];
  const md = renderReport({
    success: true,
    runId: "r1",
    prompt: "x",
    state: {},
    invocations: [inv, review, ...shadow],
    // Run totals include the shadow spend.
    totals: { costUsd: 0.02, costEquivUsd: 2.85 },
    runUrl: "u",
  });
  expect(md).toContain("| implement | `codex/sol-6.1` |");
  expect(md).toContain("| review | `claude/opus` |");
  expect(md).not.toContain("review_shadow");
  expect(md).not.toContain("shadow-a");
  expect(md).toContain("**Total:** $0.02 spent, $2.85 API-equivalent on subscriptions.");
  expect(md).toContain(
    "**Shadow review (included in total):** $0.02 spent, $0.35 API-equivalent on subscriptions.",
  );
  // Without shadow calls there is no shadow line.
  const plain = renderReport({
    success: true,
    runId: "r1",
    prompt: "x",
    state: {},
    invocations: [inv, review],
    totals: { costUsd: 0, costEquivUsd: 2.5 },
    runUrl: "u",
  });
  expect(plain).not.toContain("Shadow review");

  const store = new Store(":memory:");
  try {
    store.db.exec("PRAGMA foreign_keys = OFF");
    const insert = store.db.query(`INSERT INTO invocations
      (run_id, role, harness, provider, model, model_id, status, started_at, finished_at, cost_equiv_usd)
      VALUES ('r', ?, 'fake', 'p', 'm', ?, ?, ?, ?, ?)`);
    const now = Date.now();
    insert.run("review", "claude/opus", "ok", now, now + 10, 1);
    insert.run("review_shadow", "claude/opus", "timeout", now, now + 10, 0.5);
    insert.run("review_shadow", "codex/shadow-a", "ok", now, now + 10, 0.25);
    expect(computeStats(store).models).toEqual([
      expect.objectContaining({
        modelId: "claude/opus",
        role: "review",
        invocations: 1,
        ok: 1,
        failed: 0,
        costEquivUsd: 1,
      }),
    ]);
  } finally {
    store.close();
  }
});

for (const flagged of [true, false])
  test(`confinement failures are reported as blocking infrastructure errors (flagged=${flagged})`, () => {
    const run: GateRun = {
      setupOk: true,
      setup: [],
      checks: [
        {
          name: "test",
          command: "test",
          ok: false,
          exitCode: 1,
          durationMs: 1,
          output: flagged ? "" : "sandbox_apply: Operation not permitted",
          ...(flagged ? { confinementError: true } : {}),
        },
      ],
    };
    const md = renderReport({
      success: false,
      runId: "confined",
      prompt: "check",
      state: {
        lastGates: compareGates(run, run),
      },
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "http://localhost/runs/confined",
    });
    expect(md).toContain("❌ confinement error");
    expect(md).not.toContain("still failing");
  });

test("legacy holdout collisions never supply evidence to the public acceptance report", () => {
  const privateEvidence = "PRIVATE_HOLDOUT_EVIDENCE";
  const report = renderReport({
    success: false,
    runId: "legacy",
    prompt: "test",
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
    state: {
      spec: {
        summary: "test",
        assumptions: [],
        requirements: [],
        out_of_scope: [],
        blocking_questions: [],
        acceptance_criteria: ["AC-1", "H-1"].map((id) => ({ id, criterion: "works", how_to_verify: "test" })),
      },
      holdout: {
        scenarios: [
          { id: "H-1", description: "private scenario", steps: "test", expected: "pass", edge_case: false },
        ],
      },
      lastVerify: {
        modelId: "test/model",
        overall: "fail",
        notes: "",
        criteria: [
          { id: "AC-1", status: "met", evidence: "public evidence", publicSummary: "" },
          { id: "H-1", status: "blocked", evidence: privateEvidence, publicSummary: privateEvidence },
        ],
      },
    },
  });
  const publicSection = report.split("## Holdout scenarios")[0] ?? "";
  expect(publicSection).toContain("public evidence");
  expect(publicSection).not.toContain(privateEvidence);
  expect(publicSection).toContain("not verified");
  // The separate holdout section is the established delivery-time publication.
  expect(report.split("## Holdout scenarios")[1]).toContain(privateEvidence);
});
