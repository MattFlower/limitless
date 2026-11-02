import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exportPolicySelection, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { commitOfflineTransfer, verifyOfflineReceipt } from "../src/db/portable-receipts.ts";
import { Store } from "../src/db/store.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import { portableProjectionFixture } from "./portable-projection-support.ts";
import { receiptFixture } from "./portable-receipts-support.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";

const baseline = "a723999c8c6298bf71b555d0abb84fea2329a8de";
const available = spawnSync("git", ["cat-file", "-e", `${baseline}^{commit}`]).status === 0;
test.skipIf(!available)(
  `rollback runs the real pre-C09 source (${available ? "baseline available" : "baseline absent in shallow checkout"})`,
  () => {
    execFileSync("git", ["cat-file", "-e", `${baseline}^{commit}`]);
    const home = mkdtempSync(join(tmpdir(), "policy-baseline-"));
    const root = join(home, "source");
    const driver = resolve(import.meta.dir, "portable-policies-baseline-driver.ts");
    type Result = {
      origin: string;
      runId: string;
      newRunId: string;
      state: { phase: string };
      stages: import("../src/core/types.ts").Stage[];
      calls: number;
    };
    const run = (mode: string, id?: string): Result => {
      const args = [driver, root, home, mode, ...(id ? [id] : [])];
      return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", timeout: 60_000 }));
    };
    try {
      // Archive extraction never writes shared git metadata and never installs dependencies.
      mkdirSync(root);
      execFileSync("tar", ["-x", "-C", root], {
        input: execFileSync("git", ["archive", baseline], { maxBuffer: 64 * 1024 * 1024 }),
      });
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
      const before = run("create");
      expect(before.origin).toBe(pathToFileURL(join(realpathSync(root), "src", "db")).href);
      expect(before.state.phase).toBe("triage");
      expect(before.stages).toMatchObject([{ name: "prepare", status: "succeeded" }]);
      const path = join(home, "data", "limitless.db");
      let store = new Store(path);
      const f = policyFixture();
      let policyRun: string;
      let rows: unknown[];
      const importedTables = [
        "run_projection_ids",
        "run_projections",
        "run_policy_selections",
        "run_transfer_receipts",
        "run_transfer_blobs",
      ];
      const imported = () =>
        importedTables.map((table) => store.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
      let sidecars: ReturnType<typeof imported>;
      try {
        expect(store.db.query("SELECT run_id FROM run_policy_versions").all()).toEqual([]);
        expect(store.db.query("SELECT run_id FROM run_policy_selections").all()).toEqual([]);
        expect(store.getRunState<unknown>(before.runId)).toEqual(before.state);
        expect(store.listStages(before.runId)).toEqual(before.stages);
        const repo = store.getRepoBySlug("example/baseline");
        if (!repo) throw new Error("Missing baseline repo");
        policyRun = store.createRun(repo, { repo: repo.slug, prompt: "Current policy run" }).id;
        recordProvisionalPolicy(store, {
          runId: policyRun,
          record: f.provisional,
          state: { phase: "prepare" },
          expected: null,
          expectedState: null,
        });
        commitOfflineTransfer(store.db, receiptFixture(portableProjectionFixture(policyFixture("single"))));
        sidecars = imported();
        rows = store.db.query("SELECT run_id, record_json, digest FROM run_policy_versions").all();
      } finally {
        store.close();
      }
      const after = run("resume", before.runId);
      expect(after.origin).toBe(before.origin);
      expect(after.calls).toBe(1);
      expect(after.state.phase).toBe("clarify");
      expect(after.newRunId).not.toBe(before.runId);
      expect(after.stages).toMatchObject([
        { name: "prepare", status: "succeeded" },
        { name: "triage", status: "succeeded" },
      ]);
      store = new Store(path);
      try {
        expect(store.getRun(after.newRunId)).not.toBeNull();
        expect(store.getRunState<unknown>(before.runId)).toEqual(after.state);
        expect(store.listStages(before.runId)).toEqual(after.stages);
        expect(after.stages[0]).toEqual(before.stages[0]);
        expect(store.db.query("SELECT run_id, record_json, digest FROM run_policy_versions").all()).toEqual(
          rows,
        );
        expect(imported()).toEqual(sidecars);
        verifyOfflineReceipt(store.db, "child01");
        expect(
          store.db.query("SELECT * FROM run_policy_selections WHERE run_id = ?").get(before.runId),
        ).toBeNull();
        expect(
          store.db.query("SELECT * FROM run_transfer_receipts WHERE run_id = ?").get(before.runId),
        ).toBeNull();
        expect(exportPolicySelection(store, policyRun).digest).toBe(f.provisional.recordId);
        try {
          exportPolicySelection(store, before.runId);
          throw new Error("Missing historical policy should fail");
        } catch (error) {
          expect(error).toBeInstanceOf(RunTransferError);
          expect((error as RunTransferError).code).toBe("incomplete");
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  120_000,
);
