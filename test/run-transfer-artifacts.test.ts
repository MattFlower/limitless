import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { finalizePreparePolicy, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { readProjectionSemantics } from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { sanitizeArtifact } from "../src/gates/output.ts";
import { initialRunState, RunContext, type RunState } from "../src/pipeline/context.ts";
import { applyGateEvidence } from "../src/pipeline/gate-evidence.ts";
import { formatManifest, type ManifestV3 } from "../src/pipeline/portable.ts";
import { savedReviewSample } from "../src/pipeline/review-samples.ts";
import type { RunObjectIO } from "../src/pipeline/run-object-contract.ts";
import { createRunTransfer, type RunTransferInput } from "../src/pipeline/run-transfer.ts";
import { readTransferArtifacts } from "../src/pipeline/run-transfer-artifacts.ts";
import { transferHash } from "../src/pipeline/run-transfer-integrity.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import type { Verify } from "../src/pipeline/schemas.ts";
import { registerCredential } from "../src/util/proc.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";
import { fixture, sha } from "./run-transfer-support.ts";

const stores: Store[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const store = (path = ":memory:") => {
  const s = new Store(path);
  stores.push(s);
  return s;
};
const signal = new AbortController().signal;
const repository = { path: "/unused/repo", lockPath: "/unused/lock", trust: "factory-owned" as const };
const prompt = "Review request",
  promptKey = new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
const sample = {
  prompt: promptKey,
  sha,
  targetId: "fake/model",
  invocationId: 721,
  result: { status: "ok", finalText: "{}", structured: {} },
};
const catalogue = [
  ["triage.json", "triage", "artifact"],
  ["spec.md", "spec", "artifact"],
  ["baseline-gates.json", "gates", "excluded"],
  ["gates-0.json", "gates", "artifact"],
  ["gates-timeout-1.json", "gates", "artifact"],
  ["gates-rebase-timeout-12.json", "gates", "artifact"],
  ["gates-rebase-1.json", "gates", "artifact"],
  ["implement-1.md", "report", "artifact"],
  ["report-sources.json", "report", "holdout"],
  ["report.md", "report", "holdout"],
  ["diff.patch", "diff", "artifact"],
  ["review-1.json", "review", "artifact"],
  ["review-resolution.json", "review", "artifact"],
  ["review-1.sample-0.json", "review-sample", "artifact"],
  ["review-1.shadow.json", "review-shadow", "artifact"],
  ["verify-1.json", "verify", "holdout"],
  ["verify-1-retry.json", "verify", "holdout"],
  ["holdout-scenarios.json", "holdout", "holdout"],
  ["acceptance.json", "acceptance", "artifact"],
] as const;
function setup() {
  const s = store(),
    p = policyFixture("single");
  const repo = s.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = s.createRun(repo, { repo: repo.slug, prompt: "Request" }),
    initial = initialRunState(run);
  recordProvisionalPolicy(s, {
    runId: run.id,
    record: p.provisional,
    state: initial,
    expected: null,
    expectedState: null,
  });
  finalizePreparePolicy(s, {
    runId: run.id,
    record: p.prepared,
    state: { ...initial, ...p.prepared.fields, phase: "loop", baseline: null, baselineCached: true },
    expected: { version: 1, digest: p.provisional.recordId },
    expectedState: initial,
  });
  s.db.query("UPDATE runs SET base_sha = ?, head_sha = ? WHERE id = ?").run(sha, "b".repeat(40), run.id);
  const rows = fixture();
  rows.invocations = rows.invocations.map((v) => (v.id === 19 ? { ...v, role: "implement" } : v));
  rows.stages = rows.stages.map((v) => (v.id === 31 ? { ...v, name: "gates", status: "succeeded" } : v));
  for (const [table, values] of [
    ["stages", rows.stages],
    ["invocations", rows.invocations],
  ] as const) {
    for (const row of values) {
      const entries = Object.entries({ ...row, runId: run.id });
      s.db
        .query(
          `INSERT INTO ${table} (${entries.map(([k]) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
        )
        .run(...entries.map(([, v]) => (typeof v === "boolean" ? Number(v) : v)));
    }
  }
  s.putBaselineCache(
    { repoId: repo.id, baseSha: sha, gatesHash: "gates", envHash: "environment" },
    {},
    run.id,
  );
  for (const [i, [name, kind]] of catalogue.entries()) {
    s.putArtifact(
      run.id,
      name,
      kind,
      sanitizeArtifact(
        name,
        kind === "review-sample"
          ? JSON.stringify(sample)
          : name.endsWith(".json")
            ? '{"notes":"redacted"}'
            : "text\n",
      ),
    );
    s.db.query("UPDATE artifacts SET created_at = ? WHERE run_id = ? AND name = ?").run(i + 20, run.id, name);
  }
  return { s, runId: run.id };
}
function facade(s: Store, target = store()) {
  let key = 0;
  const objects = {
    export: mock<RunObjectIO["export"]>(async (input) => ({
      bytes: new Uint8Array([1, 2, 3]),
      requiredCommits: [...input.commits],
      refs: [],
      objectFormat: input.objectFormat,
    })),
    validate: mock<RunObjectIO["validate"]>(async (_input, inspect) =>
      inspect({
        async *objects() {},
        async type() {
          return "blob";
        },
        async read() {
          return new Uint8Array();
        },
      }),
    ),
  };
  const api = createRunTransfer({
    source: s,
    offline: { store: target, ownership: "exclusive-offline" },
    objects,
    key: () => (++key).toString(16).padStart(32, "0"),
    manifestContext: ({ run, state }) => ({
      manifest: {
        schema: 3,
        runId: run.id,
        key: { kind: "run", runId: run.id, repo: run.repoSlug },
        generation: 1,
        sequence: 0,
        previous: null,
        baseSha: run.baseSha,
        headSha: run.headSha,
        phase: state.phase,
        round: state.round,
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
  return { ...api, target, objects };
}
const counts = (s: Store) =>
  [
    "runs",
    "artifacts",
    "run_transfer_receipts",
    "run_transfer_blobs",
    "run_projections",
    "run_projection_ids",
    "invocations",
    "stages",
  ].map((t) => s.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get());
function tamper(
  input: RunTransferInput,
  change: (m: ManifestV3, rows: Record<string, unknown>[]) => void,
  raw?: (bytes: Uint8Array) => Uint8Array,
) {
  const m = JSON.parse(input.manifest) as ManifestV3,
    blobs = new Map(input.blobs);
  const rows = m.blobs.artifacts.map(
    (ref) => JSON.parse(new TextDecoder().decode(blobs.get(ref.key))) as Record<string, unknown>,
  );
  change(m, rows);
  for (const [i, ref] of m.blobs.artifacts.entries()) {
    let bytes = encodeTransferJson(rows[i]);
    if (raw) bytes = raw(bytes);
    blobs.set(ref.key, bytes);
    ref.digest = transferHash(bytes);
    ref.size = bytes.length;
  }
  return { manifest: formatManifest(m), blobs };
}
async function invalid(api: ReturnType<typeof facade>, input: RunTransferInput) {
  const before = counts(api.target),
    calls = api.objects.validate.mock.calls.length;
  await expect(api.importRun(input, signal)).rejects.toMatchObject({ code: "invalid" });
  expect(api.objects.validate).toHaveBeenCalledTimes(calls);
  expect(counts(api.target)).toEqual(before);
}

test("catalogue roles, timestamps, baseline exclusion and retained bytes survive reopening", async () => {
  const f = setup(),
    dir = mkdtempSync(join(tmpdir(), "artifact-transfer-"));
  dirs.push(dir);
  const path = join(dir, "offline.db"),
    api = facade(f.s, store(path));
  const c = await api.exportRun(f.runId, repository, signal),
    m = JSON.parse(c.manifest) as ManifestV3;
  expect(m.schema).toBe(3);
  const names = m.blobs.artifacts.map((ref) => [
    JSON.parse(new TextDecoder().decode(c.blobs.get(ref.key))).name,
    ref.role,
  ]);
  expect(names).toEqual(
    catalogue
      .filter(([, , r]) => r !== "excluded")
      .map(([name, , r]) => [name, r])
      .sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
  );
  const ids = await api.importRun(c, signal);
  const expected = readTransferArtifacts(f.s.db, f.runId)
    .filter((r) => r.name !== "baseline-gates.json")
    .map((r) =>
      r.kind === "review-sample"
        ? { ...r, content: JSON.stringify({ ...sample, invocationId: ids.invocations.get(2) }) }
        : r,
    );
  expect(readTransferArtifacts(api.target.db, f.runId)).toEqual(expected);
  expect(c.payload.state).not.toHaveProperty("baseline");
  expect(c.payload.state).not.toHaveProperty("baselineCached");
  expect(api.target.db.query("SELECT * FROM passing_baselines").all()).toEqual([]);
  api.target.close();
  stores.splice(stores.indexOf(api.target), 1);
  const reopened = facade(store(path));
  expect(await reopened.exportRun(f.runId, repository, signal)).toEqual(c);
});

test.each(["holdout-scenarios.json", "report.md", "report-sources.json", "verify-1.json", "spec.md"])(
  "role tampering is rejected before object IO: %s",
  async (name) => {
    const f = setup(),
      api = facade(f.s),
      c = await api.exportRun(f.runId, repository, signal);
    await invalid(
      api,
      tamper(c, (m, rows) => {
        const ref = m.blobs.artifacts[rows.findIndex((r) => r.name === name)];
        if (!ref) throw new Error("Missing ref");
        ref.role = name === "spec.md" ? "holdout" : "artifact";
      }),
    );
  },
);
const badPairs = [
  ["spec.md", "unknown"],
  ["spec.md", "report"],
  ["gates-01.json", "gates"],
  ["report.md.bak", "report"],
  ["xverify-1.json", "verify"],
  ["spec.md\r", "spec"],
  ["spec.md\n", "spec"],
  ["spec.md\u2028", "spec"],
];
test.each(badPairs)("grammar refuses %s/%s on both boundaries", async (name, kind) => {
  const f = setup(),
    api = facade(f.s),
    c = await api.exportRun(f.runId, repository, signal);
  await invalid(
    api,
    tamper(c, (_m, rows) => {
      rows[0] = { ...rows[0], name, kind };
    }),
  );
  f.s.putArtifact(f.runId, name ?? "", kind ?? "", "{}");
  const before = api.objects.export.mock.calls.length;
  await expect(api.exportRun(f.runId, repository, signal)).rejects.toMatchObject({ code: "unsupported" });
  expect(api.objects.export).toHaveBeenCalledTimes(before);
});

test("envelopes reject foreign, duplicate, baseline, malformed and unresolved artifact data", async () => {
  const f = setup(),
    api = facade(f.s),
    c = await api.exportRun(f.runId, repository, signal);
  for (const fields of [
    { runId: "other01" },
    { name: "baseline-gates.json", kind: "gates" },
    { version: 2 },
    { extra: true },
    { createdAt: -1 },
    { format: "wrong" },
    { content: "invalid JSON" },
  ])
    await invalid(
      api,
      tamper(c, (_m, rows) => {
        rows[0] = { ...rows[0], ...fields };
      }),
    );
  await invalid(
    api,
    tamper(c, (_m, rows) => {
      rows[1] = { ...rows[0] };
    }),
  );
  await invalid(
    api,
    tamper(
      c,
      () => {},
      (bytes) => new Uint8Array([...bytes, 10]),
    ),
  );
  await invalid(
    api,
    tamper(
      c,
      () => {},
      (bytes) => new Uint8Array([...bytes, 255]),
    ),
  );
  await invalid(
    api,
    tamper(c, (_m, rows) => {
      const row = rows.find((r) => r.kind === "review-sample");
      if (row) row.content = JSON.stringify({ ...sample, invocationId: 721 });
    }),
  );
  f.s.putArtifact(
    f.runId,
    "review-1.sample-0.json",
    "review-sample",
    JSON.stringify({ ...sample, invocationId: 999 }),
  );
  await expect(api.exportRun(f.runId, repository, signal)).rejects.toMatchObject({ code: "invalid" });
  expect(api.objects.export).toHaveBeenCalledTimes(1);
});

test("sanitizer preserves local formatting and refuses concealed destination credentials", async () => {
  const secret = ["artifact", "credential", crypto.randomUUID()].join("-");
  const f = setup(),
    api = facade(f.s);
  f.s.putArtifact(f.runId, "spec.md", "spec", secret);
  registerCredential("TRANSFER_ARTIFACT_SOURCE", secret);
  const c = await api.exportRun(f.runId, repository, signal);
  expect([...c.blobs.values()].map((b) => new TextDecoder().decode(b)).join("")).not.toContain(secret);
  const destination = ["destination", crypto.randomUUID()].join("-");
  registerCredential("TRANSFER_ARTIFACT_DESTINATION", destination);
  await invalid(
    api,
    tamper(c, (_m, rows) => {
      const row = rows.find((r) => r.name === "triage.json");
      if (row)
        row.content =
          '{"value":"' +
          [...destination].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("") +
          '"}';
    }),
  );
  await invalid(
    api,
    tamper(c, (_m, rows) => {
      const row = rows.find((r) => r.name === "spec.md");
      if (row) row.content = `${destination.slice(0, 6)}\u001b[0m${destination.slice(6)}`;
    }),
  );
  expect(sanitizeArtifact("triage.json", '{"a":"x"}')).toBe('{"a":"x"}');
  expect(sanitizeArtifact("triage.json", '{\n"a":"x"\n}')).toBe('{\n  "a": "x"\n}');
  expect(sanitizeArtifact("spec.md", "x\n")).toBe("x\n");
  const ctx = { store: f.s, run: { id: f.runId } } as RunContext;
  RunContext.prototype.artifact.call(ctx, "triage.json", "triage", '{\n"a":"x"\n}');
  expect(f.s.getArtifact(f.runId, "triage.json")).toBe('{\n  "a": "x"\n}');
});

test("later artifact insertion failure rolls back every projection and receipt row", async () => {
  const f = setup(),
    api = facade(f.s),
    c = await api.exportRun(f.runId, repository, signal),
    before = counts(api.target);
  api.target.db.exec(
    "CREATE TRIGGER fail_artifact BEFORE INSERT ON artifacts WHEN (SELECT count(*) FROM artifacts) = 2 BEGIN SELECT RAISE(ABORT, 'artifact failure'); END",
  );
  await expect(api.importRun(c, signal)).rejects.toMatchObject({ code: "invalid" });
  expect(counts(api.target)).toEqual(before);
});

test.each(["content", "kind", "created_at", "invocation", "delete", "extra"])(
  "retained export detects artifact row tampering: %s",
  async (change) => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-integrity-"));
    dirs.push(dir);
    const path = join(dir, "offline.db"),
      f = setup(),
      api = facade(f.s, store(path)),
      c = await api.exportRun(f.runId, repository, signal);
    await api.importRun(c, signal);
    api.target.close();
    stores.splice(stores.indexOf(api.target), 1);
    const offline = store(path);
    if (change === "delete") offline.db.query("DELETE FROM artifacts WHERE name = 'spec.md'").run();
    else if (change === "extra") offline.putArtifact(f.runId, "extra.md", "spec", "extra");
    else if (change === "invocation")
      offline.db
        .query("UPDATE artifacts SET content = ? WHERE kind = 'review-sample'")
        .run(JSON.stringify({ ...sample, invocationId: 1 }));
    else
      offline.db
        .query(`UPDATE artifacts SET ${change} = ? WHERE name = 'spec.md'`)
        .run(change === "created_at" ? 999 : "tampered");
    await expect(facade(offline).exportRun(f.runId, repository, signal)).rejects.toMatchObject({
      code: "conflict",
    });
  },
);

test("review samples and gate citations preserve exact SHA bindings despite local ID collisions", async () => {
  const sha = "A".repeat(40),
    boundSample = { ...sample, sha };
  const f = setup(),
    state = f.s.getRunState<RunState>(f.runId);
  f.s.putArtifact(f.runId, "review-1.sample-0.json", "review-sample", JSON.stringify(boundSample));
  if (!state) throw new Error("Missing state");
  const spec = {
    summary: "Tests",
    requirements: [],
    assumptions: [],
    out_of_scope: [],
    blocking_questions: [],
    acceptance_criteria: [{ id: "AC-1", criterion: "tests pass", how_to_verify: "bun test" }],
  };
  const gateEvidence = {
    stageId: 31,
    sha,
    baseSha: sha,
    checks: [
      {
        name: "tests",
        verdict: "pass" as const,
        blocking: false,
        testCommand: "bun test",
        result: {
          name: "tests",
          command: "bun test",
          ok: true,
          exitCode: 0,
          durationMs: 1,
          output: "test/example.test.ts:\n(pass) example [1ms]\n1 pass\n0 fail",
        },
      },
    ],
  };
  const verify = {
    overall: "pass" as const,
    notes: "Original",
    criteria: [
      {
        id: "AC-1",
        status: "met" as const,
        evidence: "Recorded",
        publicSummary: "Tests passed",
        gateEvidence: { stageId: 31, sha, check: "tests", command: "bun test" },
      },
    ],
  };
  f.s.setRunState(f.runId, {
    ...state,
    spec,
    gateEvidence,
    lastVerify: { ...verify, modelId: "fake/model" },
  });
  const dir = mkdtempSync(join(tmpdir(), "artifact-bindings-"));
  dirs.push(dir);
  const path = join(dir, "offline.db"),
    target = store(path),
    api = facade(f.s, target);
  const repo = target.upsertRepo({
    slug: "example/other",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const unrelated = target.createRun(repo, { repo: repo.slug, prompt: "Unrelated" });
  target.db
    .query(
      "INSERT INTO stages (id, run_id, name, status, started_at) VALUES (31, ?, 'gates', 'succeeded', 1)",
    )
    .run(unrelated.id);
  target.db
    .query(
      "INSERT INTO invocations (id, run_id, role, harness, provider, model, model_id, status, started_at) VALUES (720, ?, 'implement', 'fake', 'fake', 'model', 'fake/model', 'ok', 1)",
    )
    .run(unrelated.id);
  const c = await api.exportRun(f.runId, repository, signal),
    ids = await api.importRun(c, signal);
  expect(ids.invocations.get(1)).toBe(721);
  expect(ids.invocations.get(2)).toBe(722);
  target.close();
  stores.splice(stores.indexOf(target), 1);
  const offline = store(path),
    retained = facade(offline);
  expect(await retained.exportRun(f.runId, repository, signal)).toEqual(c);
  const content = JSON.parse(offline.getArtifact(f.runId, "review-1.sample-0.json") ?? "null");
  expect(content).toEqual({ ...boundSample, invocationId: 722 });
  const ctx = {
    store: offline,
    run: { id: f.runId },
    deps: {
      router: {
        resolve: (targetId: string) => {
          expect(targetId).toBe("fake/model");
          return { model: {} };
        },
        toTarget: () => ({ modelId: "fake/model" }),
      },
    },
  } as unknown as RunContext;
  const request = { prompt, schema: z.object({}) } as Parameters<typeof savedReviewSample>[3];
  expect(savedReviewSample(ctx, 1, 0, request, sha)?.invocation.id).toBe(722);
  expect(savedReviewSample(ctx, 1, 0, request, "b".repeat(40))).toBeUndefined();
  expect(savedReviewSample(ctx, 1, 0, { ...request, prompt: "Another prompt" }, sha)).toBeUndefined();
  const stageId = ids.stages.get(1);
  if (stageId === undefined) throw new Error("Missing mapped stage");
  const projected = readProjectionSemantics(offline.db, f.runId)?.state;
  const historical = projected?.lastVerify;
  if (!historical || !projected.gateEvidence) throw new Error("Missing evidence");
  // The offline projection retains portable field names with destination IDs as their values.
  const { stageOrdinal, ...gates } = projected.gateEvidence;
  const localGates = { ...gates, stageId: stageOrdinal };
  const saved: Verify = {
    overall: historical.overall,
    notes: historical.notes,
    criteria: historical.criteria.map(({ id, status, evidence, publicSummary, gateEvidence }) => ({
      id,
      status,
      evidence,
      publicSummary: publicSummary ?? "",
      gateEvidence: gateEvidence
        ? {
            stageId: gateEvidence.stageOrdinal,
            sha: gateEvidence.sha,
            check: gateEvidence.check,
            command: gateEvidence.command,
          }
        : undefined,
    })),
  };

  expect(projected.gateEvidence.sha).toBe(sha);
  expect(localGates.stageId).toBe(stageId);
  expect(saved.criteria[0]?.gateEvidence?.sha).toBe(sha);
  expect(
    applyGateEvidence(saved, spec, { scenarios: [] }, sha, localGates).criteria[0]?.gateEvidence,
  ).toEqual({ stageId, sha, check: "tests", command: "bun test" });
  expect(
    applyGateEvidence(saved, spec, { scenarios: [] }, "b".repeat(40), localGates).criteria[0]?.gateEvidence,
  ).toBeUndefined();
  const colliding = {
    ...saved,
    criteria: saved.criteria.map((row) => ({
      ...row,
      gateEvidence: { stageId: 31, sha, check: "tests", command: "bun test" },
    })),
  };
  expect(
    applyGateEvidence(colliding, spec, { scenarios: [] }, sha, localGates).criteria[0]?.gateEvidence,
  ).toBeUndefined();
});

test.each([1, 2] as const)(
  "legacy version %i artifact references stay unsupported by the facade",
  async (schema) => {
    const f = setup(),
      api = facade(f.s),
      c = await api.exportRun(f.runId, repository, signal);
    const m = JSON.parse(c.manifest) as ManifestV3;
    const legacy = {
      ...m,
      schema,
      phase: "loop" as const,
      blobs: { ...m.blobs, artifacts: m.blobs.artifacts.map(({ role: _role, ...ref }) => ref) },
    };
    await expect(
      api.importRun({ manifest: formatManifest(legacy), blobs: c.blobs }, signal),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(api.objects.validate).toHaveBeenCalledTimes(1);
    expect(counts(api.target).every((row) => JSON.stringify(row) === '{"n":0}')).toBe(true);
  },
);
