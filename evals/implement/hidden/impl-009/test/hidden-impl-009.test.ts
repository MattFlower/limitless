import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Repo } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { EngineDeps } from "../src/pipeline/context.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { buildReport, renderReport } from "../src/pipeline/report.ts";

const input = {
  success: true,
  runId: "r3",
  prompt: "x",
  state: {},
  invocations: [],
  totals: { costUsd: 0, costEquivUsd: 0 },
  runUrl: "u",
};

test("a report that closes an issue says so", () => {
  expect(renderReport({ ...input, closesIssue: 3 })).toContain("Closes #3");
  expect(renderReport({ ...input, success: false, closesIssue: 12 })).toContain("Closes #12");
});

test("a report without an issue has no closing keyword", () => {
  expect(renderReport(input)).not.toContain("Closes #");
});

let dir: string;
let store: Store;
let repo: Repo;
let deps: EngineDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-hidden-report-"));
  const cfg = loadConfig({ home: join(dir, "home"), configDir: join(dir, "config") });
  store = new Store(cfg.paths.db);
  repo = store.upsertRepo({
    slug: "acme/widgets",
    kind: "github",
    url: "https://github.com/acme/widgets",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  deps = { cfg, store } as unknown as EngineDeps;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function reportFor(sourceRef: Record<string, unknown> | undefined): string {
  const run = store.createRun(repo, {
    repo: repo.slug,
    prompt: "Work on this GitHub issue.",
    source: "github",
    ...(sourceRef ? { sourceRef } : {}),
  });
  return buildReport(new RunContext(deps, run, repo, new AbortController().signal), true);
}

test("runs started from an issue in the same repository close it", () => {
  expect(reportFor({ kind: "issue", repo: "acme/widgets", number: 7 })).toContain("Closes #7");
});

test("issues in other repositories and other sources are not closed", () => {
  expect(reportFor({ kind: "issue", repo: "acme/other", number: 7 })).not.toContain("Closes #");
  expect(reportFor({ kind: "pull_request", repo: "acme/widgets", number: 8, headSha: "abc" })).not.toContain(
    "Closes #",
  );
  expect(reportFor(undefined)).not.toContain("Closes #");
});
