import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizePreparePolicy, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { Store } from "../src/db/store.ts";
import { initialRunState, type RunState } from "../src/pipeline/context.ts";
import { implementPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import type { RunObjectIO } from "../src/pipeline/run-object-contract.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { policyCanonical } from "../src/pipeline/run-transfer-policy-schema.ts";
import {
  deliverImportedRun,
  implementerView,
  type RunDeliveryRole,
  runDeliveryFields,
} from "../src/pipeline/run-transfer-roles.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";
import { fixture, repo, sha } from "./run-transfer-support.ts";

const stores = new Set<Store>(),
  dirs: string[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store(path = ":memory:") {
  const s = new Store(path);
  stores.add(s);
  return s;
}
const allowed: Record<RunDeliveryRole, string[]> = {
  implementer: [
    "spec",
    "feedback",
    "lastAudit",
    "round",
    "reviewResolution",
    "verification",
    "flow",
    "gatesConfig",
    "baseline",
  ],
  "holdout-author": [
    "holdout",
    "holdoutStatus",
    "holdoutModelId",
    "holdoutSameVendor",
    "spec",
    "specAuthorVendor",
  ],
  verifier: ["holdout", "holdoutStatus", "holdoutModelId", "holdoutSameVendor", "spec", "gateEvidence"],
};
const roles: RunDeliveryRole[] = ["implementer", "holdout-author", "verifier"];
const canaries = Array.from({ length: 17 }, (_, i) => `PRIVATE_ROLE_CANARY_${i}_END`);
const model = (index: number) => ({
  overall: "fail" as const,
  notes: "Private result",
  criteria: [
    {
      id: "H-1",
      status: "unmet" as const,
      evidence: canaries[index] ?? "",
      publicSummary: "Redacted observation",
    },
  ],
});
const spec = {
  summary: "Public spec",
  assumptions: [],
  requirements: ["Required behavior"],
  acceptance_criteria: [{ id: "AC-1", criterion: "Works", how_to_verify: "Check it" }],
  out_of_scope: [],
  blocking_questions: [],
};
const holdout = {
  scenarios: [0, 1].map((i) => ({
    id: `H-${i + 1}`,
    description: ` ${canaries[i * 3]} `,
    steps: `\t${canaries[i * 3 + 1]}\n`,
    expected: ` ${canaries[i * 3 + 2]} `,
    edge_case: false,
  })),
};
async function imported(followUp = false, absent = false) {
  const source = store(),
    p = policyFixture("single"),
    r = source.upsertRepo(repo);
  const run = source.createRun(r, { repo: r.slug, prompt: "Ordinary request" });
  const initial = initialRunState(run);
  recordProvisionalPolicy(source, {
    runId: run.id,
    record: p.provisional,
    state: initial,
    expected: null,
    expectedState: null,
  });
  const stage = source.startStage(run.id, "holdout");
  source.finishStage(stage.id, "succeeded", canaries[7]);
  source.createInvocation({
    runId: run.id,
    stageId: stage.id,
    role: "holdout",
    harness: "fake",
    provider: "fake",
    model: canaries[8] ?? "",
    modelId: "fake/author",
  });
  const state: RunState = {
    ...initial,
    ...p.prepared.fields,
    phase: "loop",
    round: 3,
    spec,
    holdout: structuredClone(holdout),
    holdoutStatus: "complete",
    holdoutModelId: canaries[6],
    holdoutSameVendor: false,
    specAuthorVendor: "spec-vendor",
    gateEvidence: { stageId: stage.id, sha, baseSha: sha, checks: [] },
    feedback: "Redacted retry feedback",
    implementerReport: "Implementer report",
    lastVerify: { ...model(9), modelId: "fake/verifier" },
    pendingVerify: { round: 3, attempt: 0, sha, modelOutput: model(10), modelId: "fake/verifier" },
    verifyResults: [{ ...model(11), modelId: "fake/verifier", round: 3, modelOutput: model(11) }],
    lastVerifiedEvidence: { lastVerify: { ...model(12), modelId: "fake/verifier" } },
    worktreePath: "/source/worktree-canary",
    worktreeAliases: ["/source/alias-canary"],
    baseline: { setupOk: true, setup: [], checks: [] },
    verification: { baseSha: sha, headSha: "b".repeat(40) },
    lastAudit: [{ severity: "warn", rule: "root-hidden-addition", file: ".scratch", detail: "Use scratch" }],
    ...(followUp ? { reviewResolution: { sha, feedback: "Resolve conflicts" } } : {}),
  };
  if (absent)
    for (const key of [...allowed["holdout-author"], "gateEvidence", "lastAudit", "verification"])
      Reflect.deleteProperty(state, key);
  finalizePreparePolicy(source, {
    runId: run.id,
    record: p.prepared,
    state,
    expected: { version: 1, digest: p.provisional.recordId },
    expectedState: initial,
  });
  source.db.query("UPDATE runs SET base_sha = ?, head_sha = ? WHERE id = ?").run(sha, "b".repeat(40), run.id);
  if (followUp) {
    const owner = source.createRun(r, { repo: r.slug, prompt: "Owner resolution request" });
    const url = "https://github.com/example/project/pull/42";
    source.db.query("UPDATE runs SET branch = 'topic', pr_url = ? WHERE id = ?").run(url, owner.id);
    source.db
      .query(
        "UPDATE runs SET base_branch = 'topic', delivery_branch = 'topic', pr_url = ?, source_ref = ? WHERE id = ?",
      )
      .run(
        url,
        JSON.stringify({ kind: "review-round", runId: owner.id, round: 3, prUrl: url, reviewedSha: sha }),
        run.id,
      );
    source.db
      .query(
        "INSERT INTO review_rounds (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at) VALUES (?, ?, ?, 3, ?, '[]', 80)",
      )
      .run(run.id, owner.id, url, sha);
  }
  for (const [i, [name, kind]] of [
    ["holdout-scenarios.json", "holdout"],
    ["verify-1.json", "verify"],
    ["report.md", "report"],
    ["report-sources.json", "report"],
  ].entries())
    source.putArtifact(
      run.id,
      name ?? "",
      kind ?? "",
      JSON.stringify(
        kind === "verify"
          ? { ...model(13 + i), modelOutput: model(13 + i), modelId: "fake/verifier" }
          : { private: canaries[13 + i] },
      ),
    );
  const dir = mkdtempSync(join(tmpdir(), "role-delivery-"));
  dirs.push(dir);
  const path = join(dir, "offline.db"),
    offline = store(path);
  const objects: RunObjectIO = {
    export: async (input) => ({
      bytes: new Uint8Array([1]),
      requiredCommits: [...input.commits],
      refs: [],
      objectFormat: input.objectFormat,
    }),
    validate: async (_input, inspect) =>
      inspect({
        async *objects() {},
        async type() {
          return "blob";
        },
        async read() {
          return new Uint8Array();
        },
      }),
  };
  let key = 0;
  const api = createRunTransfer({
    source,
    offline: { store: offline, ownership: "exclusive-offline" },
    objects,
    key: () => (++key).toString(16).padStart(32, "0"),
    manifestContext: ({ run: current, state: s }) => ({
      manifest: {
        schema: 3,
        runId: current.id,
        key: followUp
          ? { kind: "pr", repo: current.repoSlug, number: 42 }
          : { kind: "run", runId: current.id, repo: current.repoSlug },
        generation: 1,
        sequence: 0,
        previous: null,
        baseSha: current.baseSha,
        headSha: current.headSha,
        phase: s.phase,
        round: s.round,
        createdBy: "test",
        effects: [],
        blobs: {
          state: { key: "0".repeat(32), digest: "0".repeat(64), size: 0 },
          artifacts: [],
          objects: [],
        },
      },
    }),
  });
  const signal = new AbortController().signal,
    exported = await api.exportRun(
      run.id,
      { path: "/unused/repo", lockPath: "/unused/lock", trust: "factory-owned" },
      signal,
    );
  await api.importRun(exported, signal);
  offline.close();
  stores.delete(offline);
  return { target: store(path), path, runId: run.id, state, exported };
}
function assertKeys(role: RunDeliveryRole, delivery: ReturnType<typeof deliverImportedRun>) {
  expect(Object.keys(delivery).sort()).toEqual(
    delivery.ownerPrompt ? ["ownerPrompt", "prompt", "state"] : ["prompt", "state"],
  );
  for (const key of Object.keys(delivery.state)) expect(allowed[role]).toContain(key);
  for (const path of ["/source/worktree-canary", "/source/alias-canary"])
    expect(JSON.stringify(delivery)).not.toContain(path);
}

test.each([false, true])(
  "implementer isolation after export/import/reopen (follow-up %s)",
  async (followUp) => {
    const f = await imported(followUp),
      d = deliverImportedRun(f.target.db, f.runId, "implementer");
    expect(d.prompt).toBe("Ordinary request");
    if (followUp) expect(d.ownerPrompt).toBe("Owner resolution request");
    else expect(d).not.toHaveProperty("ownerPrompt");
    if (!d.state.gatesConfig) throw new Error("Missing delivered gates");
    const prompt = implementPrompt({
      prompt: d.ownerPrompt ?? d.prompt,
      spec: d.state.spec ?? null,
      gates: d.state.gatesConfig,
      baseline: null,
      baseSha: sha,
      round: d.state.round,
      feedback: d.state.feedback,
      hasHoldout: true,
    });
    for (const canary of canaries) {
      expect(JSON.stringify(d)).not.toContain(canary);
      expect(prompt).not.toContain(canary);
    }
    expect(prompt).toContain(followUp ? "Owner resolution request" : "Ordinary request");
    expect(d.state).not.toHaveProperty("baseline");
    expect(d.state.feedback).toBe("Redacted retry feedback");
    expect(d.state.lastAudit).toEqual(f.state.lastAudit);
    assertKeys("implementer", d);
  },
);

test("private roles preserve original scenario bytes, identities and their additional fields", async () => {
  const f = await imported(true);
  for (const role of roles) {
    expect([...runDeliveryFields[role]].sort().join(",")).toBe([...allowed[role]].sort().join(","));
    const d = deliverImportedRun(f.target.db, f.runId, role);
    assertKeys(role, d);
    if (role === "implementer") continue;
    expect(Object.keys(d.state).sort()).toEqual([...allowed[role]].sort());
    expect(policyCanonical(d.state.holdout)).toBe(policyCanonical(holdout));
    expect(d.state.holdoutStatus).toBe("complete");
    expect(d.state.holdoutModelId).toBe(canaries[6]);
    expect(d.state.holdoutSameVendor).toBe(false);
    expect(d.state).not.toHaveProperty("feedback");
    expect(d.state).not.toHaveProperty("implementerReport");
    expect(d).not.toHaveProperty("ownerPrompt");
  }
  const author = deliverImportedRun(f.target.db, f.runId, "holdout-author"),
    verifier = deliverImportedRun(f.target.db, f.runId, "verifier");
  expect(author.state.specAuthorVendor).toBe("spec-vendor");
  expect(verifier.state.gateEvidence?.checks).toEqual([]);
  if (!verifier.state.holdout || !verifier.state.spec) throw new Error("Missing verifier inputs");
  const rendered = verifyPrompt({
    prompt: verifier.prompt,
    spec: verifier.state.spec,
    holdout: verifier.state.holdout,
    baseSha: sha,
  });
  for (const scenario of holdout.scenarios)
    for (const text of [scenario.steps, scenario.expected]) expect(rendered).toContain(text);
  const original = policyCanonical(verifier);
  if (verifier.state.holdout.scenarios[0]) verifier.state.holdout.scenarios[0].steps = "mutated";
  if (verifier.state.spec) verifier.state.spec.requirements.push("mutated");
  expect(policyCanonical(deliverImportedRun(f.target.db, f.runId, "verifier"))).toBe(original);
  expect(policyCanonical(author.state.holdout)).toBe(policyCanonical(holdout));
});

test.each([
  [
    "holdout projection",
    "UPDATE run_projections SET semantic_json = json_set(semantic_json, '$.state.holdout.scenarios[0].steps', 'tampered')",
  ],
  ["projected artifact", "UPDATE artifacts SET content = '{}' WHERE name = 'verify-1.json'"],
  ["missing receipt", "DELETE FROM run_transfer_blobs; DELETE FROM run_transfer_receipts"],
])("all roles reverify after successful delivery and %s damage", async (_kind, sql) => {
  const f = await imported();
  for (const role of roles)
    expect(deliverImportedRun(f.target.db, f.runId, role).prompt).toBe("Ordinary request");
  f.target.db.exec(sql ?? "");
  for (const role of roles)
    expect(() => deliverImportedRun(f.target.db, f.runId, role)).toThrow(
      expect.objectContaining({ name: "RunTransferError", code: "conflict" }),
    );
  f.target.close();
  stores.delete(f.target);
  const reopened = store(f.path);
  for (const role of roles)
    expect(() => deliverImportedRun(reopened.db, f.runId, role)).toThrow(
      expect.objectContaining({ name: "RunTransferError", code: "conflict" }),
    );
});

test("optional absences remain absent and local baseline is kept only by the local view", async () => {
  const f = await imported(false, true);
  expect(implementerView(f.state).baseline).toEqual(f.state.baseline);
  for (const role of roles) {
    const d = deliverImportedRun(f.target.db, f.runId, role);
    assertKeys(role, d);
    for (const key of ["baseline", "spec", "lastAudit", "verification", ...allowed["holdout-author"]])
      expect(d.state).not.toHaveProperty(key);
    if (role !== "implementer") expect(Object.keys(d.state)).toEqual([]);
  }
});

test.each([false, true])("local prompt bytes preserve baseline and resolution inputs (merge %s)", (merge) => {
  const gates = policyFixture("single").prepared.fields.gatesConfig;
  const baseline = {
    setupOk: true,
    setup: [],
    checks: [
      {
        name: "test",
        command: "bun test",
        ok: false,
        exitCode: 1,
        durationMs: 1,
        output: "Existing failure",
      },
    ],
  };
  const state: RunState = {
    ...initialRunState(fixture().run),
    spec,
    gatesConfig: gates,
    baseline,
    round: 99,
    feedback: "Repair feedback",
    flow: "build",
    reviewResolution: { sha },
    verification: { baseSha: sha, headSha: "b".repeat(40) },
    lastAudit: [{ severity: "warn", rule: "root-hidden-addition", file: ".scratch", detail: "Use scratch" }],
  };
  const expected = implementPrompt({
    prompt: merge ? "Owner request" : "Round request",
    spec: merge ? null : spec,
    gates,
    baseline,
    baseSha: sha,
    round: merge ? 5 : 3,
    feedback: "Repair feedback\n\nAdvisory [root-hidden-addition] .scratch: Use scratch",
    hasHoldout: true,
    externalChange: false,
    resolution: merge,
  });
  const view = implementerView(state),
    round = 5;
  const actual = implementPrompt({
    prompt: merge && view.reviewResolution ? "Owner request" : "Round request",
    spec: merge && view.reviewResolution ? null : (view.spec ?? null),
    gates,
    baseline: view.baseline ?? null,
    baseSha: view.verification?.baseSha ?? "fallback-base",
    round: !merge && view.reviewResolution?.sha ? round - 2 : round,
    feedback:
      [view.feedback, ...(view.lastAudit ?? []).map((f) => `Advisory [${f.rule}] ${f.file}: ${f.detail}`)]
        .filter(Boolean)
        .join("\n\n") || null,
    hasHoldout: view.flow !== "verify-change",
    externalChange: view.flow === "verify-change",
    resolution: merge,
  });
  expect(actual).toBe(expected);
  expect(actual).toContain("already FAILING on the base branch");
});
