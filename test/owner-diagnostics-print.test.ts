import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOwnerDiagnostics } from "../src/cli/owner-diagnostics.ts";
import { ownerDiagnostics } from "../src/db/owner-diagnostics.ts";
import { Store } from "../src/db/store.ts";
import { registerCredential } from "../src/util/proc.ts";

// No daemon: these cover the sanitizing seams that `show` and `logs` print through.
let home: string;
let store: Store;
let runId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "owner-diagnostics-print-"));
  store = new Store(join(home, "limitless.db"));
  const repo = store.upsertRepo({
    slug: "local/test",
    kind: "local",
    localPath: home,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  runId = store.createRun(repo, { repo: repo.slug, prompt: "diagnostics" }).id;
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const printed = (): string[] => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    printOwnerDiagnostics(ownerDiagnostics(store.db, runId));
    return output.mock.calls.map((call) => String(call[0]));
  } finally {
    output.mockRestore();
  }
};

test("recorded owner diagnostics drop credentials and terminal controls from gate names", () => {
  const credential = "recorded-owner-credential-549";
  registerCredential("RECORDED_OWNER_TEST", credential);
  store.recordOwnerDiagnostic(
    { runId, kind: "run-error", text: `Owner-only detail: gate \x1b[31m${credential} failed` },
    "public",
  );
  expect(ownerDiagnostics(store.db, runId).map((row) => row.text)).toEqual([
    "Owner-only detail: gate [redacted] failed",
  ]);
  expect(printed()).toEqual([
    "  [owner diagnostic: run run-error]\nOwner-only detail: gate [redacted] failed",
  ]);
});

test("printing historical owner diagnostics removes newly registered credentials and controls", () => {
  const credential = "historical-owner-credential-549";
  registerCredential("HISTORICAL_OWNER_TEST", credential);
  store.db
    .query("INSERT INTO owner_diagnostics (run_id, kind, text) VALUES (?, ?, ?)")
    .run(runId, "run-error", `Owner-only detail: gate \x1b[31m${credential}\x1b[0m`);
  const lines = printed();
  expect(lines).toEqual(["  [owner diagnostic: run run-error]\nOwner-only detail: gate [redacted]"]);
  expect(lines.join("\n")).not.toContain("\x1b");
});
