import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, Repo } from "../src/core/types.ts";
import { executeRun } from "../src/pipeline/engine.ts";

let dir: string;
let factory: Factory;
let repo: Repo;
const request: CreateRunRequest = {
  repo: "MattFlower/limitless",
  prompt: "Verify dependency update",
  source: "github",
  requestedBy: "dependabot[bot]",
  baseBranch: "main",
  deliveryBranch: "main",
  sourceRef: { kind: "pull_request", repo: "MattFlower/limitless", number: 18, headSha: "a".repeat(40) },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "github-authorization-"));
  factory = new Factory(loadConfig({ home: dir, configDir: dir }), { harnesses: {} });
  repo = factory.store.upsertRepo({
    slug: request.repo,
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
});
afterEach(() => {
  factory.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("public requests cannot forge existing-branch authority with source or provenance fields", async () => {
  for (const source of ["ui", "cli", "github"] as const) {
    const forged = { ...request, source, githubWebhookVerified: true, verifiedGitHubWebhook: true };
    await expect(factory.createRun(forged)).rejects.toThrow("verified GitHub Dependabot webhook");
    expect(() => factory.store.createRun(repo, forged)).toThrow("verified GitHub Dependabot webhook");
  }
  expect(factory.store.listRuns()).toHaveLength(0);
  const ordinary = await factory.createRun({
    repo: request.repo,
    prompt: "Ordinary run",
    githubWebhookVerified: true,
  } as CreateRunRequest);
  expect(ordinary.githubWebhookVerified).toBe(false);
  expect(ordinary.deliveryBranch).toBeNull();
});

test("verified origin still requires matching GitHub Dependabot PR metadata", () => {
  const invalid: Partial<CreateRunRequest>[] = [
    { source: "ui" },
    { requestedBy: "MattFlower" },
    { baseBranch: "other" },
    { sourceRef: { ...request.sourceRef, kind: "issue" } },
    { sourceRef: { ...request.sourceRef, repo: "other/fork" } },
    { sourceRef: { ...request.sourceRef, number: 0 } },
    { sourceRef: { ...request.sourceRef, headSha: "bad" } },
  ];
  for (const patch of invalid)
    expect(() => factory.store.createRun(repo, { ...request, ...patch }, true)).toThrow(
      "verified GitHub Dependabot webhook",
    );
  expect(() => factory.store.createRun({ ...repo, kind: "local" }, request, true)).toThrow(
    "verified GitHub Dependabot webhook",
  );
  expect(factory.store.listRuns()).toHaveLength(0);
});

test("persisted unverified runs fail before preparation or resumed delivery", async () => {
  for (const phase of ["prepare", "deliver"]) {
    const run = factory.store.createRun(repo, { repo: request.repo, prompt: "Legacy forged run" });
    // Model a run saved by the previous implementation, which accepted public delivery fields.
    factory.store.db
      .query(
        "UPDATE runs SET source = 'github', requested_by = 'dependabot[bot]', source_ref = ?, base_branch = 'main', delivery_branch = 'main' WHERE id = ?",
      )
      .run(JSON.stringify(request.sourceRef), run.id);
    factory.store.setRunState(run.id, { phase });
    expect(await executeRun(factory.deps, run.id, new AbortController().signal)).toBe("failed");
    expect(factory.store.getRun(run.id)?.error).toContain("verified GitHub Dependabot webhook");
    expect(factory.store.listStages(run.id)).toHaveLength(0);
    await expect(factory.retryRun(run.id)).rejects.toThrow("verified GitHub Dependabot webhook");
  }
});

test("retry preserves persisted trusted origin without accepting request-supplied provenance", async () => {
  const run = factory.store.createRun(repo, request, true);
  const retry = await factory.retryRun(run.id);
  expect(retry.githubWebhookVerified).toBe(true);
  expect(retry.deliveryBranch).toBe(request.deliveryBranch ?? null);
  expect(retry.sourceRef).toEqual(request.sourceRef ?? null);
});
