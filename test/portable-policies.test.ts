import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import {
  appendPolicySupplement,
  exportPolicySelection,
  finalizePreparePolicy,
  type PolicyTransition,
  recordProvisionalPolicy,
  requireReviewPolicy,
} from "../src/db/portable-policies.ts";
import { Store } from "../src/db/store.ts";
import { RunTransferError, type RunTransferErrorCode } from "../src/pipeline/run-transfer-errors.ts";
import { policyCanonical } from "../src/pipeline/run-transfer-policy-schema.ts";
import { policyFixture, seal, source } from "./run-transfer-policy-support.ts";

let home: string, path: string, store: Store, runId: string;
const f = policyFixture();
const pin = (record: { version: number; recordId: string }) => ({
  version: record.version,
  digest: record.recordId,
});
const initial = { phase: "prepare", round: 0 };
const preparedState = { ...initial, phase: "triage", ...f.prepared.fields };
const reviewState = { ...preparedState, reviewMode: "single" };
function create(store: Store) {
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: "https://github.com/example/project",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  return store.createRun(repo, { repo: repo.slug, prompt: "Offline policy lifecycle" }).id;
}
function input(record: unknown = f.prepared, state: unknown = preparedState): PolicyTransition {
  return { runId, record, state, expected: pin(f.provisional), expectedState: initial };
}
function provisional() {
  const i = { runId, record: f.provisional, state: initial, expected: null, expectedState: null };
  expect(recordProvisionalPolicy(store, i)).toEqual(pin(f.provisional));
  expect(recordProvisionalPolicy(store, i)).toEqual(pin(f.provisional));
}
function reopen() {
  store.close();
  store = new Store(path);
}
function snapshot() {
  return {
    versions: store.db
      .query(
        "SELECT run_id, policy_id, version, kind, digest, record_json, created_at FROM run_policy_versions ORDER BY version",
      )
      .all(),
    selections: store.db
      .query("SELECT run_id, policy_id, selected_version, selected_digest FROM run_policy_selections")
      .all(),
    state: store.db.query("SELECT state_json FROM runs WHERE id = ?").get(runId),
  };
}
function errorCode(fn: () => unknown, code: RunTransferErrorCode) {
  try {
    fn();
    throw new Error("Expected transition failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RunTransferError);
    expect((error as RunTransferError).code).toBe(code);
  }
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "portable-policies-"));
  path = join(home, "store.db");
  store = new Store(path);
  runId = create(store);
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test("provisional export, immutable finalization and reopening select the complete prepared prefix", () => {
  provisional();
  expect(exportPolicySelection(store, runId)).toEqual({ ...pin(f.provisional), history: [f.provisional] });
  const original = snapshot().versions[0];
  finalizePreparePolicy(store, input());
  reopen();
  expect(exportPolicySelection(store, runId)).toEqual({
    ...pin(f.prepared),
    history: [f.provisional, f.prepared],
  });
  expect(snapshot().versions[0]).toEqual(original);
  expect(store.getRunState<unknown>(runId)).toEqual(preparedState);
  expect(() =>
    store.db.query("UPDATE run_policy_versions SET created_at = 0 WHERE run_id = ?").run(runId),
  ).toThrow();
  expect(() => store.db.query("DELETE FROM run_policy_versions WHERE run_id = ?").run(runId)).toThrow();
});
test.each(Object.keys(f.prepared.fields))(
  "a provisional selection cannot export after %s is present",
  (key) => {
    provisional();
    store.setRunState(runId, { ...initial, [key]: Reflect.get(f.prepared.fields, key) });
    errorCode(() => exportPolicySelection(store, runId), "incomplete");
  },
);
test.each(["before", "state", "selection"])(
  "interruption at %s rolls back every finalization write",
  (point) => {
    provisional();
    const old = snapshot();
    reopen();
    expect(snapshot()).toEqual(old);
    if (point !== "before") {
      const table = point === "state" ? "runs" : "run_policy_selections";
      store.db.exec(
        `CREATE TRIGGER interrupt_policy BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'Interrupted'); END`,
      );
      expect(() => finalizePreparePolicy(store, input())).toThrow();
      reopen();
      expect(snapshot()).toEqual(old);
      store.db.exec("DROP TRIGGER interrupt_policy");
    }
    finalizePreparePolicy(store, input());
    reopen();
    expect(store.getRunState<unknown>(runId)).toEqual(preparedState);
    expect(exportPolicySelection(store, runId).version).toBe(2);
    expect(snapshot().versions).toHaveLength(2);
  },
);
test("two connections serialize competing versions; replay writes nothing and stale state conflicts", async () => {
  provisional();
  const other = new Store(path);
  const alternate = seal({
    ...f.prepared,
    fields: { ...f.prepared.fields, baselineScripts: { test: "alternative" } },
  });
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => finalizePreparePolicy(store, input())),
      Promise.resolve().then(() =>
        finalizePreparePolicy(other, input(alternate, { ...initial, ...alternate.fields })),
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const loser = results[1];
    if (loser?.status !== "rejected") throw new Error("Expected conflict");
    expect(loser.reason).toBeInstanceOf(RunTransferError);
    expect(loser.reason.code).toBe("conflict");
    const before = snapshot();
    expect(finalizePreparePolicy(other, input())).toEqual(pin(f.prepared));
    expect(snapshot()).toEqual(before);
    errorCode(
      () =>
        appendPolicySupplement(store, {
          ...input(f.reviewed, reviewState),
          expected: pin(f.prepared),
          expectedState: initial,
        }),
      "conflict",
    );
    expect(snapshot()).toEqual(before);
  } finally {
    other.close();
  }
  reopen();
  expect(exportPolicySelection(store, runId).digest).toBe(f.prepared.recordId);
});
test.each(["weaker gates", "missing slotted", "second prepare", "changed review fields", "late provisional"])(
  "C09g rejects %s without writes",
  (scenario) => {
    if (scenario !== "late provisional") provisional();
    if (["second prepare", "changed review fields"].includes(scenario)) finalizePreparePolicy(store, input());
    const old = snapshot();
    const attempt = () => {
      if (scenario === "late provisional")
        return recordProvisionalPolicy(store, {
          ...input(seal({ ...f.provisional, version: 2 }), initial),
          expected: null,
          expectedState: null,
        });
      if (scenario === "weaker gates")
        return finalizePreparePolicy(
          store,
          input(f.prepared, {
            ...preparedState,
            gatesConfig: { ...f.prepared.fields.gatesConfig, checks: [] },
          }),
        );
      if (scenario === "missing slotted") {
        const { slottedCommands: _, ...missing } = preparedState;
        return finalizePreparePolicy(store, input(f.prepared, missing));
      }
      const record =
        scenario === "second prepare"
          ? f.prepared
          : seal({ ...f.reviewed, fields: { ...f.reviewed.fields, slottedCommands: [] } });
      return appendPolicySupplement(store, {
        ...input(record, reviewState),
        expected: pin(f.prepared),
        expectedState: preparedState,
      });
    };
    errorCode(attempt, ["second prepare", "late provisional"].includes(scenario) ? "invalid" : "conflict");
    expect(snapshot()).toEqual(old);
  },
);
test("review completion and scripts refresh require and preserve the effective review mode", () => {
  provisional();
  finalizePreparePolicy(store, input());
  errorCode(() => requireReviewPolicy(store, runId), "incomplete");
  const scripts = seal({
    ...f.prepared,
    kind: "scripts-refreshed" as const,
    version: 3,
    parent: { recordId: f.prepared.recordId, version: 2 },
    scriptSource: source,
  });
  appendPolicySupplement(store, {
    ...input(scripts),
    expected: pin(f.prepared),
    expectedState: preparedState,
  });
  errorCode(() => requireReviewPolicy(store, runId), "incomplete");
  const reviewed = seal({
    ...scripts,
    kind: "review-finalized" as const,
    version: 4,
    parent: { recordId: scripts.recordId, version: 3 },
    effectiveReviewMode: "single" as const,
  });
  const i = { ...input(reviewed, reviewState), expected: pin(scripts), expectedState: preparedState };
  appendPolicySupplement(store, i);
  const old = snapshot();
  appendPolicySupplement(store, i);
  expect(snapshot()).toEqual(old);
  expect(requireReviewPolicy(store, runId)).toEqual(reviewed);
  const refreshed = seal({ ...f.refreshed, version: 5, parent: { recordId: reviewed.recordId, version: 4 } });
  appendPolicySupplement(store, {
    ...input(refreshed, { ...reviewState, ...refreshed.fields }),
    expected: pin(reviewed),
    expectedState: reviewState,
  });
  expect(requireReviewPolicy(store, runId)).toEqual(refreshed);
});
test("migration does not backfill historical policy or consult current configuration", () => {
  store.close();
  const before = join(home, "before");
  cpSync(MIGRATION_DIR, before, {
    recursive: true,
    filter: (file) => !file.endsWith("-portable-policies.sql"),
  });
  rmSync(path);
  store = new Store(path, before);
  runId = create(store);
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  cfg.reviewMode = "panel";
  store.setSetting("policy", JSON.stringify(cfg.reviewMode));
  store.setRunState(runId, preparedState);
  reopen();
  errorCode(() => exportPolicySelection(store, runId), "incomplete");
  expect(snapshot().versions).toEqual([]);
  expect(snapshot().selections).toEqual([]);
});
test("export detects content or selection digest corruption", () => {
  provisional();
  store.db.exec("DROP TRIGGER run_policy_versions_immutable_update");
  store.db
    .query("UPDATE run_policy_versions SET record_json = ? WHERE run_id = ?")
    .run(JSON.stringify({ ...f.provisional, policyId: "tampered" }), runId);
  errorCode(() => exportPolicySelection(store, runId), "corrupt");
  store.db
    .query("UPDATE run_policy_versions SET record_json = ? WHERE run_id = ?")
    .run(policyCanonical(f.provisional), runId);
  store.db
    .query("UPDATE run_policy_selections SET selected_digest = ? WHERE run_id = ?")
    .run("0".repeat(64), runId);
  errorCode(() => exportPolicySelection(store, runId), "corrupt");
});
