import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import type { GateConfig } from "../src/gates/detect.ts";
import { projectGateDiagnostics, setupFailureMessage } from "../src/gates/output.ts";
import { type GateComparison, type GateResult, targetedRetrySkipReason } from "../src/gates/run.ts";
import { withheldText } from "../src/gates/text-privacy.ts";
import { ciSignature } from "../src/integrations/ci-classifier.ts";
import { landFlakyReason } from "../src/land/queue.ts";
import { snapshotRefusal } from "../src/pipeline/agent-gate.ts";
import { RunContext } from "../src/pipeline/context.ts";
import type { CoveringTestRun } from "../src/pipeline/covering-tests.ts";
import { applyGateEvidence, coveringCitation } from "../src/pipeline/gate-evidence.ts";
import { observeGateFailures } from "../src/pipeline/gate-execution.ts";
import {
  confirmPostMerge,
  POST_MERGE_REASONS,
  postMergeConfirmationText,
} from "../src/pipeline/post-merge-confirmation.ts";
import type { Spec, Verify } from "../src/pipeline/schemas.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { privacyTexts, provenResult } from "./privacy-support.ts";
import { providerFixture } from "./provider-config-support.ts";

const sentinel = privacyTexts[0] ?? "missing sentinel";
const sha = "a".repeat(40);
const gates: GateConfig = { setup: [], checks: [], source: "none", protectedPaths: [] };
const raw = (output = sentinel): GateResult => ({
  name: "test",
  command: `bun test ${sentinel}`,
  executedCommand: `bun test ${sentinel} -t passes`,
  output,
  failures: `excerpt-${sentinel}`,
  failedFiles: [sentinel],
  ok: false,
  exitCode: 127,
  durationMs: 1,
  executionProvenance: { sha, trackedClean: true, provenanceError: sentinel },
  coveringTest: { file: sentinel, name: "passes" },
});
const comparison = (result: GateResult): GateComparison => ({
  name: "test",
  result,
  verdict: "regressed",
  blocking: true,
});
async function variant(kind: string, r = raw()) {
  if (kind === "legacy") return r;
  const proven = await provenResult(r);
  if (kind === "proven") return proven;
  return {
    ...proven,
    textPrivacy: {
      output: { ...proven.textPrivacy?.output, withheld: false, mac: "0".repeat(64) },
      identities: { ...proven.textPrivacy?.identities, withheld: false, mac: "0".repeat(64) },
    },
  };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function context() {
  const config = providerFixture([]);
  const factory = new Factory(config.load());
  const store = factory.store;
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    url: null,
    localPath: config.work,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
  const ctx = new RunContext(factory.deps, run, repo, new AbortController().signal);
  cleanups.push(async () => {
    await factory.stop();
    store.close();
    config.close();
  });
  return { ctx, factory, store, run };
}

test("post-merge fixed reason vocabulary is exact and rejected retry never copies output", async () => {
  expect([...POST_MERGE_REASONS].sort()).toEqual(
    [
      "worker execution attribution unavailable",
      "targeted retry returned no check result",
      "confinement failure",
      "confirmation timed out",
      "pass (worker-specific flake)",
      "failed on coordinator",
      "coordinator confirmation deadline expired (slot wait or execution)",
      "setup failures are not retried",
      "check does not match base configuration",
      "retry provenance rejected",
    ].sort(),
  );
  const { ctx } = context();
  const c = comparison({ ...raw(), ok: true, firstAttempt: raw(), executionProvenance: undefined });
  c.coordinatorConfirmation = { originalVerdict: "regressed", reason: sentinel };
  let saved = 0;
  await confirmPostMerge(ctx, "", gates, [c], Date.now() + 10000, sha, async () => {
    saved++;
  });
  expect(saved).toBe(1);
  expect(c.retryProvenanceRejected).toBe(true);
  expect(c.coordinatorConfirmation.reason).toBe("retry provenance rejected");
});

test.each(["legacy", "forged", "proven"])(
  "remaining text routes release only proved fields: %s",
  async (kind) => {
    const r = await variant(kind);
    const released = kind === "proven";
    for (const prefix of [
      "Preview setup failed: $ ",
      "Acceptance setup failed: $ ",
      "Reader setup failed: $ ",
      "review gate setup failed: ",
    ]) {
      const message = setupFailureMessage(prefix, r);
      expect(message).toStartWith(prefix);
      expect(message.includes(sentinel)).toBe(released);
      expect(message).not.toContain(`excerpt-${sentinel}`);
      if (released) {
        expect(message).toContain(r.command);
        expect(message).toContain(r.output);
      } else expect(message).toContain(withheldText("unproven"));
    }
    expect(landFlakyReason([r])).toBe(`flaky: test (${released ? sentinel : "files withheld"})`);
    const skip = targetedRetrySkipReason(
      undefined,
      { ...r, failureAttributionComplete: false, failureAttributionReason: sentinel },
      gates,
      "",
    );
    expect(skip).toContain("unrecognized attribution reason");
    expect(skip).not.toContain(sentinel);
    const c = comparison(r);
    for (const reason of [sentinel, ...POST_MERGE_REASONS]) {
      // Serialize and restore to exercise the same untrusted legacy shape as resumed state.
      c.coordinatorConfirmation = JSON.parse(
        JSON.stringify({ originalVerdict: "regressed", reason, result: r }),
      );
      const log = postMergeConfirmationText(c);
      const error = postMergeConfirmationText(c, true);
      expect(log).toContain(reason === sentinel ? withheldText("unproven") : reason);
      expect(log).not.toContain(sentinel);
      expect(error.includes(sentinel)).toBe(released);
      expect(error).not.toContain(`excerpt-${sentinel}`);
    }
  },
);

test("setup fallbacks and snapshot refusals use fixed text without provenance diagnostics", () => {
  expect(setupFailureMessage("Preview setup failed: $ ", undefined, "No setup result")).toBe(
    "Preview setup failed: $ setup\nNo setup result",
  );
  const base = {
    setupOk: true,
    setup: [],
    checks: [],
    sha,
    treeHash: "tree",
    trackedClean: true,
    provenanceError: sentinel,
  };
  for (const [changes, expected] of [
    [{ sha: undefined }, "snapshot provenance could not be confirmed"],
    [{ treeHash: undefined }, "snapshot provenance could not be confirmed"],
    [{ sha: "other" }, "the snapshot changed during the gate"],
    [{ treeHash: "other" }, "the snapshot changed during the gate"],
    [{ trackedClean: false }, "snapshot provenance could not be confirmed"],
  ] as const)
    expect(snapshotRefusal({ ...base, ...changes }, sha, "tree")).toBe(expected);
  expect(snapshotRefusal(base, sha, "tree")).toBeUndefined();
});

function observe(store: Store, r: GateResult, id: string) {
  observeGateFailures(
    store,
    {
      run_id: id,
      repo: "test/repo",
      stage_id: 1,
      round: 0,
      sha,
      handle_kind: "local",
      handle_id: id,
      purpose: "initial",
    },
    { kind: "local", id, startedAt: Date.now() },
    { setupOk: false, setup: [r], checks: [] },
    undefined,
    () => 0,
  );
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test.each(["legacy", "forged", "proven"])(
  "observations project fields but hash the internal signature: %s",
  async (kind) => {
    const store = new Store(":memory:");
    try {
      const r = await variant(kind, raw(`${"x".repeat(6010)}${sentinel}`));
      observe(store, r, kind);
      const row = store.failureObservations()[0];
      expect(row?.output_tail).toBe(kind === "proven" ? r.output.slice(-6000) : withheldText("unproven"));
      expect(row?.failed_files).toBe(JSON.stringify(kind === "proven" ? [sentinel] : []));
      expect(row?.command).toBe(kind === "proven" ? r.command : withheldText("unproven"));
      expect(row?.command_digest).toBe(hash(r.command));
      if (kind !== "proven") expect(JSON.stringify(row)).not.toContain(sentinel);
      expect(row?.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(row?.signature).toBe(hash(ciSignature(r.name, r.output.slice(-6000), r.command).signature));
    } finally {
      store.close();
    }
  },
);

test.each([true, false])(
  "promotion uses internal failure identity, never the shared marker: identical=%s",
  (same) => {
    const store = new Store(":memory:");
    try {
      observe(store, raw(`error: missing alpha ${sentinel}`), "first");
      store.db.query("UPDATE failure_observations SET location='worker-a' WHERE run_id='first'").run();
      observe(store, raw(`error: missing ${same ? "alpha" : "beta"} ${sentinel}`), "second");
      for (const id of ["first", "second"])
        store.observations.finalize(id, { round: 0, sha, stageId: 1, comparisons: [] });
      const rows = store.failureObservations();
      expect(rows.map((r) => r.output_tail)).toEqual([withheldText("unproven"), withheldText("unproven")]);
      expect(rows.map((r) => r.class)).toEqual(Array(2).fill(same ? "undeclared_requirement" : "setup"));
    } finally {
      store.close();
    }
  },
);

test.each(["legacy", "forged", "proven"])(
  "covering citations can be re-applied using outward identities: %s",
  async (kind) => {
    const r = await variant(kind, { ...raw("1 pass\n0 fail"), ok: true, exitCode: 0 });
    const run: CoveringTestRun = {
      file: sentinel,
      name: "passes",
      stageId: 13,
      verifiedSha: sha,
      round: 0,
      result: r,
    };
    const spec: Spec = {
      summary: "test",
      requirements: [],
      acceptance_criteria: [{ id: "AC-1", criterion: "A restart preserves state", how_to_verify: "restart" }],
      assumptions: [],
      out_of_scope: [],
      blocking_questions: [],
    };
    const value: Verify = {
      overall: "fail",
      notes: "",
      criteria: [
        {
          id: "AC-1",
          status: "blocked",
          blockedReason: "sandbox",
          evidence: "Cannot run",
          publicSummary: "",
          covering_tests: [{ file: sentinel, name: "passes" }],
        },
      ],
    };
    const apply = (v: Verify) =>
      applyGateEvidence(v, spec, { scenarios: [] }, sha, undefined, undefined, {
        runs: [run],
        succeededStageIds: [13],
        relevantFiles: [sentinel],
      });
    const first = apply(value),
      second = apply(first);
    for (const v of [first, second]) {
      const row = v.criteria[0];
      expect(row?.status).toBe("met");
      expect(row?.gateEvidence?.check).toBe(kind === "proven" ? `${sentinel} › passes` : "[withheld]");
      expect(row?.gateEvidence?.command).toBe(kind === "proven" ? r.executedCommand : "[withheld]");
      expect(row?.evidence).toBe(coveringCitation(run, sha));
    }
    expect(coveringCitation({ ...run, result: undefined }, sha)).toContain("[withheld]");
  },
);

test.each(["legacy", "forged", "proven"])(
  "stored artifacts retain only durable proofs and HTTP releases them: %s",
  async (kind) => {
    const { ctx, factory, store, run } = context();
    const r = await variant(kind);
    ctx.artifact("gates.json", "gates", JSON.stringify([r]));
    const stored = store.getArtifact(run.id, "gates.json") ?? "";
    const parsed = JSON.parse(stored)[0];
    expect(parsed.output).toBe(kind === "proven" ? sentinel : withheldText("unproven"));
    expect(parsed.command).toBe(kind === "proven" ? r.command : withheldText("unproven"));
    expect(parsed.failures).toBeUndefined();
    expect(parsed.executionProvenance.provenanceError).toBeUndefined();
    expect(Boolean(parsed.textPrivacy.output.mac)).toBe(kind === "proven");
    const route = createHttpRoutes(factory)["/api/runs/:id/artifacts/:name"] as Route;
    const response = await route(
      requestWithParams(
        `http://localhost/api/runs/${run.id}/artifacts/gates.json`,
        {},
        { id: run.id, name: "gates.json" },
      ),
      localServer,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body.includes(sentinel)).toBe(kind === "proven");
    expect(body).not.toContain('"mac"');
    ctx.artifact("plain.txt", "text", "ordinary plaintext");
    expect(store.getArtifact(run.id, "plain.txt")).toBe("ordinary plaintext");
    expect(() => ctx.artifact("bad.json", "gates", "{")).toThrow();
    expect(projectGateDiagnostics(JSON.parse(stored), { mode: "outward" })[0].output).toBe(parsed.output);
  },
);

test.each(["firstAttempt", "result.firstAttempt", "earlier stage"])(
  "withheld commands finalize the original failed attempt: %s",
  (source) => {
    const store = new Store(":memory:");
    try {
      const failed = raw("original failure");
      observe(store, failed, "retry");
      const passed = { ...failed, command: "changed retry command", output: "passed", ok: true, exitCode: 0 };
      const c: GateComparison = {
        ...comparison(passed),
        verdict: "flaky",
        blocking: false,
        retryOriginal: { verdict: "regressed", blocking: true },
        ...(source === "result.firstAttempt"
          ? { result: { ...passed, firstAttempt: failed } }
          : { firstAttempt: failed }),
      };
      const wrong = { ...comparison(failed), result: { ...failed, command: "other withheld command" } };
      const completion = {
        round: 0,
        sha,
        stageId: source === "earlier stage" ? 2 : 1,
        comparisons: [wrong, c],
      };
      store.observations.finalize("retry", completion);
      expect(store.failureObservations()[0]).toMatchObject({ history: "retry_passed", interim: 0 });
      const rows = store.failureObservations();
      store.observations.finalize("retry", completion);
      expect(store.failureObservations()).toEqual(rows);
    } finally {
      store.close();
    }
  },
);

test("historical signatures promote together but never with new hashes", () => {
  const store = new Store(":memory:");
  try {
    const r = raw();
    observe(store, r, "old-a");
    observe(store, r, "old-b");
    const signature = ciSignature(r.name, r.output, r.command).signature;
    store.db
      .query("UPDATE failure_observations SET signature=?,command=?,command_digest=NULL,location=run_id")
      .run(signature, r.command);
    observe(store, r, "new");
    for (const id of ["old-a", "old-b", "new"])
      store.observations.finalize(id, { round: 0, sha, stageId: 1, comparisons: [] });
    expect(store.failureObservations().map((row) => row.class)).toEqual([
      "undeclared_requirement",
      "undeclared_requirement",
      "setup",
    ]);
  } finally {
    store.close();
  }
});

test.each(["legacy", "forged", "proven"])(
  "ordinary citations project commands and reapply: %s",
  async (kind) => {
    const r = await variant(kind, {
      ...raw("test/example.test.ts:\n(pass) passes\n1 pass\n0 fail"),
      ok: true,
      exitCode: 0,
    });
    const spec: Spec = {
      summary: "tests",
      requirements: [],
      assumptions: [],
      out_of_scope: [],
      blocking_questions: [],
      acceptance_criteria: [{ id: "AC-1", criterion: "tests pass", how_to_verify: "bun test" }],
    };
    const value: Verify = {
      overall: "fail",
      notes: "",
      criteria: [
        {
          id: "AC-1",
          status: "blocked",
          blockedReason: "sandbox",
          evidence: "Cannot run",
          publicSummary: "",
        },
      ],
    };
    const apply = (v: Verify) =>
      applyGateEvidence(v, spec, { scenarios: [] }, sha, {
        stageId: 17,
        sha,
        checks: [
          { name: "configured tests", result: r, verdict: "pass", blocking: false, testCommand: "bun test" },
        ],
      });
    const first = apply(value);
    const command = kind === "proven" ? r.command : withheldText("unproven");
    for (const result of [first, apply(first), projectGateDiagnostics(first, { mode: "outward" })]) {
      expect(result.criteria[0]).toMatchObject({
        status: "met",
        evidence: `Factory gate configured tests passed at ${sha} (stage 17); commands: ${command}`,
        gateEvidence: { stageId: 17, sha, check: "configured tests", command },
      });
      expect(JSON.stringify(result).includes(sentinel)).toBe(kind === "proven");
    }
  },
);
