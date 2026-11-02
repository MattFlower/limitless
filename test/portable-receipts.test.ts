import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOfflineProjection,
  readProjectionIds,
  readProjectionSemantics,
} from "../src/db/portable-projection.ts";
import {
  commitOfflineTransfer,
  retainedOfflineExport,
  verifyOfflineReceipt,
} from "../src/db/portable-receipts.ts";
import { Store } from "../src/db/store.ts";
import { formatManifest, type PortableManifest } from "../src/pipeline/portable.ts";
import { decodeRunPayload, type RunPayloadV1 } from "../src/pipeline/run-transfer-schema.ts";
import { portableProjectionFixture } from "./portable-projection-support.ts";
import { receiptFixture } from "./portable-receipts-support.ts";
import { rejects, repo } from "./run-transfer-support.ts";

let home: string, path: string, store: Store;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "portable-receipts-"));
  path = join(home, "data.db");
  store = new Store(path);
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
function reopen() {
  store.close();
  store = new Store(path);
}
function snapshot() {
  return store.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => [name, store.db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}

test.each(["receipt", "blob"])("a late %s failure rolls back the entire projection on disk", (part) => {
  const input = receiptFixture(),
    before = snapshot();
  const target = part === "receipt" ? "run_transfer_receipts" : "run_transfer_blobs";
  store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON ${target} BEGIN
    SELECT CASE WHEN (SELECT count(*) FROM run_projections) = 1
      AND (SELECT count(*) FROM run_policy_versions) = 4
      AND (SELECT count(*) FROM run_projection_ids) = 6
      THEN RAISE(ABORT, 'Projection inserted before failure') ELSE RAISE(ABORT, 'Too early') END; END`);
  expect(() => commitOfflineTransfer(store.db, input)).toThrow("Projection inserted before failure");
  reopen();
  expect(snapshot()).toEqual(before);
});

test.each([false, true])(
  "lost commit result repeats with valid booleans %s and unchanged material",
  (value) => {
    const payload = portableProjectionFixture();
    payload.run.merged = payload.run.githubWebhookVerified = payload.run.prClosedUnmerged = value;
    if (value) payload.run.noBaselineCache = true;
    else delete payload.run.noBaselineCache;
    const input = receiptFixture(payload);
    commitOfflineTransfer(store.db, input);
    const before = snapshot(),
      ids = readProjectionIds(store.db, input.payload.run.id);
    reopen();
    verifyOfflineReceipt(store.db, input.payload.run.id);
    expect(commitOfflineTransfer(store.db, input)).toEqual(ids);
    expect(retainedOfflineExport(store.db, input.payload.run.id)).toEqual(input);
    expect(snapshot()).toEqual(before);
    expect(store.getRun(input.payload.run.id)).toMatchObject({
      costUsd: 1.25,
      costEquivUsd: 8.5,
      tokensIn: 1234,
      tokensOut: 98,
    });
    const different = structuredClone(input);
    const manifest = JSON.parse(input.manifest) as PortableManifest;
    manifest.sequence++;
    different.manifest = formatManifest(manifest);
    rejects(() => commitOfflineTransfer(store.db, different), "conflict");
    expect(snapshot()).toEqual(before);
  },
);

test.each([
  ["runs", "merged", 2, "integer"],
  ["runs", "github_webhook_verified", 2, "integer"],
  ["runs", "pr_closed_unmerged", 2, "integer"],
  ["runs", "no_baseline_cache", 2, "integer"],
  ["invocations", "fast", 2, "integer"],
  ["runs", "merged", 0.5, "real"],
  ["runs", "pr_closed_unmerged", "false", "text"],
  ["invocations", "fast", new Uint8Array([48]), "blob"],
] as const)("%s.%s storage %s (%s) conflicts without repair after reopen", (table, column, value, type) => {
  const payload = portableProjectionFixture();
  Object.assign(payload.run, {
    merged: false,
    githubWebhookVerified: false,
    prClosedUnmerged: false,
    noBaselineCache: false,
  });
  for (const invocation of payload.invocations) invocation.fast = false;
  const input = receiptFixture(payload);
  commitOfflineTransfer(store.db, input);
  const key = table === "runs" ? "id" : "run_id";
  // Corrupt only the last invocation so verification must inspect every projected row.
  const where = `${key} = 'child01'${table === "invocations" ? " AND id = (SELECT max(id) FROM invocations)" : ""}`;
  store.db.query(`UPDATE ${table} SET ${column} = ? WHERE ${where}`).run(value);
  reopen();
  expect(
    store.db.query(`SELECT ${column} AS value, typeof(${column}) AS type FROM ${table} WHERE ${where}`).get(),
  ).toEqual({ value, type });
  const damaged = snapshot();
  for (const operation of [
    () => commitOfflineTransfer(store.db, input),
    () => verifyOfflineReceipt(store.db, "child01"),
    () => retainedOfflineExport(store.db, "child01"),
  ]) {
    rejects(operation, "conflict");
    expect(snapshot()).toEqual(damaged);
  }
});
test("a local run without a transfer receipt conflicts without writes", () => {
  const input = receiptFixture();
  const localRepo = store.upsertRepo(repo);
  const local = store.createRun(localRepo, { repo: repo.slug, prompt: "ordinary" });
  input.payload.run.id = local.id;
  input.payload.header.runId = local.id;
  if (input.payload.followUp) input.payload.followUp.runId = local.id;
  for (const kind of ["stages", "invocations", "questions"] as const)
    for (const row of input.payload[kind]) row.runId = local.id;
  for (const job of input.payload.jobs) job.run_id = local.id;
  const material = receiptFixture(input.payload),
    before = snapshot();
  expect(decodeRunPayload(material.payload, repo, JSON.parse(material.manifest))).toEqual(material.payload);
  rejects(() => commitOfflineTransfer(store.db, material), "conflict");
  expect(snapshot()).toEqual(before);
});

test.each([1, 2] as const)("schema %i retains original JSON bytes and repeated blob references", (schema) => {
  const input = receiptFixture();
  const manifest = JSON.parse(input.manifest) as PortableManifest;
  manifest.schema = schema;
  const bytes = new TextEncoder().encode(`\n${JSON.stringify(input.payload, null, 2)}\n`);
  input.blobs = new Map(input.blobs).set(manifest.blobs.state.key, bytes);
  manifest.blobs.state.size = bytes.length;
  manifest.blobs.state.digest = createHash("sha256").update(bytes).digest("hex");
  const artifact = manifest.blobs.artifacts[0];
  if (!artifact) throw new Error("Missing artifact fixture");
  manifest.blobs.artifacts.push(artifact);
  input.manifest = formatManifest(manifest);
  commitOfflineTransfer(store.db, input);
  reopen();
  expect(retainedOfflineExport(store.db, "child01")).toEqual(input);
  expect(() => commitOfflineTransfer(store.db, input)).not.toThrow();
});

test("unordered ordinal collections commit and repeat while retaining original bytes", () => {
  const payload = portableProjectionFixture();
  for (const kind of ["stages", "invocations", "questions"] as const) payload[kind].reverse();
  const input = receiptFixture(payload);
  expect(() => decodeRunPayload(payload, repo, JSON.parse(input.manifest))).not.toThrow();
  const ids = commitOfflineTransfer(store.db, input),
    before = snapshot();
  reopen();
  verifyOfflineReceipt(store.db, "child01");
  expect(commitOfflineTransfer(store.db, input)).toEqual(ids);
  expect(snapshot()).toEqual(before);
  const exported = retainedOfflineExport(store.db, "child01");
  expect(exported.manifest).toBe(input.manifest);
  expect([...exported.blobs]).toEqual([...input.blobs]);
  expect(exported.payload).toEqual(payload);
});

test.each([
  ["noBaselineCache", "no_baseline_cache = 1"],
  ["models", `models_json = '{"review":["fake/other"]}'`],
  ["allow", `audit_allow = '["binary"]'`],
  ["titleProvenance", "title_provenance = 'explicit'"],
] as const)("omitted %s storage damage conflicts through every receipt entry point", (field, update) => {
  const payload = portableProjectionFixture();
  delete payload.run[field];
  const input = receiptFixture(payload);
  expect(decodeRunPayload(payload, repo, JSON.parse(input.manifest))).toEqual(payload);
  commitOfflineTransfer(store.db, input);
  reopen();
  verifyOfflineReceipt(store.db, "child01");
  store.db.exec(`UPDATE runs SET ${update} WHERE id = 'child01'`);
  reopen();
  const damaged = snapshot();
  for (const operation of [
    () => commitOfflineTransfer(store.db, input),
    () => verifyOfflineReceipt(store.db, "child01"),
    () => retainedOfflineExport(store.db, "child01"),
  ]) {
    rejects(operation, "conflict");
    expect(snapshot()).toEqual(damaged);
  }
});

const corruptions = [
  ["accounting", "UPDATE runs SET cost_usd = 99 WHERE id = 'child01'"],
  ["question", "UPDATE questions SET answer = 'changed' WHERE run_id = 'child01'"],
  ["stage", "DELETE FROM stages WHERE id = (SELECT min(id) FROM stages)"],
  ["invocation", "UPDATE invocations SET input_tokens = 99"],
  [
    "dangling mapping",
    "UPDATE run_projection_ids SET local_id = 999 WHERE kind = 'questions' AND ordinal = 1",
  ],
  ["missing mapping", "DELETE FROM run_projection_ids WHERE kind = 'questions' AND ordinal = 1"],
  ["extraneous mapping", "INSERT INTO run_projection_ids VALUES ('child01', 'questions', 3, 999)"],
  [
    "policy metadata",
    "DROP TRIGGER run_policy_versions_immutable_update; UPDATE run_policy_versions SET kind = 'prepared' WHERE version = 1",
  ],
  [
    "policy bytes",
    "DROP TRIGGER run_policy_versions_immutable_update; UPDATE run_policy_versions SET record_json = '{}' WHERE version = 1",
  ],
  ["policy selection", "UPDATE run_policy_selections SET selected_digest = 'wrong'"],
  [
    "unselected policy",
    "INSERT INTO run_policy_versions SELECT run_id, policy_id, 5, kind, '" +
      "e".repeat(64) +
      "', record_json, created_at FROM run_policy_versions WHERE version = 1",
  ],
  [
    "semantic sidecar",
    "UPDATE run_projections SET semantic_json = json_set(semantic_json, '$.state.round', 99)",
  ],
  ["semantic absence", "DELETE FROM run_projections"],
  [
    "extra semantic field",
    "UPDATE run_projections SET semantic_json = json_set(semantic_json, '$.extra', true)",
  ],
  [
    "extraneous run field mapping",
    "UPDATE run_projections SET semantic_json = json_insert(semantic_json, '$.runFields[#]', 'extra')",
  ],
  ["manifest digest", "UPDATE run_transfer_receipts SET digest = 'wrong'"],
  ["manifest bytes", "UPDATE run_transfer_receipts SET manifest = manifest || ' '"],
  ["fingerprint", "UPDATE run_transfer_receipts SET fingerprint = 'wrong'"],
  ["receipt absence", "DELETE FROM run_transfer_blobs; DELETE FROM run_transfer_receipts"],
  ["blob association", "UPDATE run_transfer_blobs SET blob_key = 'wrong' WHERE slot = 1"],
  ["blob descriptor", "UPDATE run_transfer_blobs SET digest = 'wrong' WHERE slot = 1"],
  ["blob size", "UPDATE run_transfer_blobs SET size = size + 1 WHERE slot = 1"],
  ["blob absence", "DELETE FROM run_transfer_blobs WHERE slot = 1"],
  [
    "same length blob",
    "UPDATE run_transfer_blobs SET plaintext = zeroblob(length(plaintext)) WHERE slot = 1",
  ],
  [
    "extra blob",
    "INSERT INTO run_transfer_blobs SELECT run_id, 99, blob_key, digest, size, plaintext FROM run_transfer_blobs WHERE slot = 1",
  ],
] as const;
test.each(corruptions)(
  "%s damage conflicts on repetition, reopen and export without repair",
  (_name, sql) => {
    const input = receiptFixture();
    commitOfflineTransfer(store.db, input);
    store.db.exec(sql);
    reopen();
    const damaged = snapshot();
    for (const operation of [
      () => commitOfflineTransfer(store.db, input),
      () => verifyOfflineReceipt(store.db, "child01"),
      () => retainedOfflineExport(store.db, "child01"),
    ]) {
      rejects(operation, "conflict");
      expect(snapshot()).toEqual(damaged);
    }
  },
);

test.each(["build", "verify-change", "acceptance", "review", "conflict", "ci"] as const)(
  "%s semantics and exact retained bytes survive reopening without activation",
  (flow) => {
    const payload = portableProjectionFixture();
    if (["build", "verify-change", "acceptance"].includes(flow)) {
      delete payload.followUp;
      payload.run.baseBranch = "main";
      payload.run.deliveryBranch = null;
      payload.run.sourceRef =
        flow === "verify-change"
          ? {
              kind: "pull_request",
              repo: repo.slug,
              number: 42,
              baseSha: payload.run.baseSha,
              headSha: payload.run.headSha,
            }
          : { kind: "issue", repo: repo.slug, number: 42 };
      payload.header.claim = { kind: flow === "verify-change" ? "pr" : "issue", repo: repo.slug, number: 42 };
      payload.run.flow = flow as RunPayloadV1["run"]["flow"];
      payload.state.flow = payload.run.flow;
    } else if (payload.followUp) payload.followUp.kind = flow as "review" | "conflict" | "ci";
    const material = receiptFixture(payload);
    const decoded = decodeRunPayload(payload, repo, JSON.parse(material.manifest));
    expect(decoded).toEqual(payload);
    let publications = 0;
    store.subscribe(() => {
      publications++;
    });
    const ids = commitOfflineTransfer(store.db, material);
    expect(publications).toBe(0);
    reopen();
    verifyOfflineReceipt(store.db, "child01");
    expect(readOfflineProjection(store.db, "child01")).toEqual(payload);
    const exported = retainedOfflineExport(store.db, "child01");
    expect(exported.manifest).toBe(material.manifest);
    expect([...exported.blobs]).toEqual([...material.blobs]);
    expect(exported.payload).toEqual(payload);
    expect(readProjectionIds(store.db, "child01")).toEqual(ids);
    expect(readProjectionSemantics(store.db, "child01")?.jobs).toHaveLength(2);
    expect(store.getRunState("child01")).toBeNull();
    for (const table of ["agent_jobs", "agent_gate_executions", "gate_jobs", "feed", "review_rounds"])
      expect(store.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(store.db.query("SELECT session_id FROM invocations WHERE session_id IS NOT NULL").all()).toEqual(
      [],
    );
  },
);
