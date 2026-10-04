import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { assertExistingBranchDelivery, type FactoryBranchGrant } from "../src/core/delivery.ts";
import type { CreateRunRequest, Repo, Run } from "../src/core/types.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

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

test("branch-name validation rejects HEAD like git check-ref-format --branch", async () => {
  const { isBranchName } = await import("../src/core/delivery.ts");
  expect(isBranchName("HEAD")).toBe(false);
  expect(isBranchName("main")).toBe(true);
  expect(isBranchName("dependabot/github_actions/actions/checkout-7.0.1")).toBe(true);
});

const BRANCH = "limitless/owner-feature";
const PR = "https://github.com/MattFlower/limitless/pull/7";
const HEAD = "c".repeat(40);
/** A finished factory run that opened PR from BRANCH. */
function owner(): Run {
  const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "Add the feature" });
  return factory.store.updateRun(run.id, {
    status: "succeeded",
    branch: BRANCH,
    prUrl: PR,
    baseSha: "d".repeat(40),
  });
}
const roundRequest = (o: Run): CreateRunRequest => ({
  repo: repo.slug,
  prompt: "Apply findings",
  baseBranch: BRANCH,
  deliveryBranch: BRANCH,
  sourceRef: { kind: "review-round", runId: o.id, round: 1, prUrl: PR, reviewedSha: HEAD },
});

test("public requests cannot create review rounds or push onto a factory run's branch", async () => {
  const o = owner();
  const post = (createHttpRoutes(factory)["/api/runs"] as Record<string, Route>).POST as Route;
  const { deliveryBranch: _, ...withoutDelivery } = roundRequest(o);
  for (const forged of [
    roundRequest(o),
    withoutDelivery,
    { ...request, ...roundRequest(o), sourceRef: undefined },
  ]) {
    const res = await post(
      requestWithParams("http://127.0.0.1:7400/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(forged),
      }),
      localServer,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /created only by a review verdict|verified GitHub Dependabot webhook/,
    );
    await expect(factory.createRun(forged)).rejects.toThrow();
    expect(() => factory.store.createRun(repo, forged, true)).toThrow();
  }
  expect(factory.store.listRuns()).toEqual([o]);
  // Only the verdict handler's record grants the push; a retry would have to come from a new verdict.
  const created = factory.store.createReviewRound(
    repo,
    o,
    { prUrl: PR, reviewedSha: HEAD, findings: [], cap: 3 },
    () => roundRequest(o),
  );
  if (!("run" in created)) throw new Error("round not created");
  await expect(factory.retryRun(created.run.id)).rejects.toThrow("created only by a review verdict");
});

test("a persisted round without the verdict handler's record fails before preparation", async () => {
  const o = owner();
  const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "Forged round" });
  // Every field a public request could carry, written directly: still no authority to push.
  factory.store.db
    .query("UPDATE runs SET source_ref = ?, base_branch = ?, delivery_branch = ? WHERE id = ?")
    .run(JSON.stringify(roundRequest(o).sourceRef), BRANCH, BRANCH, run.id);
  expect(await executeRun(factory.deps, run.id, new AbortController().signal)).toBe("failed");
  expect(factory.store.getRun(run.id)?.error).toContain("verified GitHub Dependabot webhook");
  expect(factory.store.listStages(run.id)).toHaveLength(0);
});

test("a factory-branch grant covers only the owner's own branch, an open PR and the reviewed head", () => {
  const o = owner();
  const run = { baseBranch: BRANCH, deliveryBranch: BRANCH };
  const grant: FactoryBranchGrant = { owner: o, head: HEAD };
  const check =
    (patch: Partial<typeof run> = {}, g: Partial<FactoryBranchGrant> = {}, r: Repo = repo) =>
    () =>
      assertExistingBranchDelivery(r, { ...run, ...patch }, { ...grant, ...g });
  expect(check()).not.toThrow();
  expect(check({}, { prOpen: true, remoteHead: HEAD })).not.toThrow();
  expect(check({ deliveryBranch: "main", baseBranch: "main" })).toThrow(
    "main is not the factory run's own branch",
  );
  expect(check({ baseBranch: "main" })).toThrow("is not the factory run's own branch");
  expect(check({}, { owner: { ...o, branch: null } })).toThrow("is not the factory run's own branch");
  expect(check({}, { owner: { ...o, deliveryBranch: "dependabot/x" } })).toThrow(
    "is not the factory run's own branch",
  );
  expect(check({}, { owner: { ...o, repoId: "other" } })).toThrow(
    "not a factory run of this GitHub repository",
  );
  expect(check({}, {}, { ...repo, kind: "local" })).toThrow("not a factory run of this GitHub repository");
  expect(check({}, { owner: { ...o, prUrl: "https://github.com/other/repo/pull/7" } })).toThrow("has no PR");
  expect(check({}, { owner: { ...o, prUrl: null } })).toThrow("has no PR");
  expect(check({}, { prOpen: false })).toThrow("the PR is no longer open");
  expect(check({}, { remoteHead: "e".repeat(40) })).toThrow(
    `head moved: the PR branch is at ${"e".repeat(40)}`,
  );
  expect(check({}, { remoteHead: null })).toThrow("head moved");
});
