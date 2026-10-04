import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Factory } from "../src/app.ts";
import type { RunStatus } from "../src/core/types.ts";
import { closedIssues } from "../src/db/store.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { allItems, feedStore } from "./feed-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

let f: ReturnType<typeof feedStore>;
let route: Route;
beforeEach(() => {
  f = feedStore();
  const cfg = { port: 7400, uiUrl: "http://127.0.0.1:7400", trustedProxies: [], publicOrigins: [] };
  const factory = { store: f.store, cfg } as unknown as Factory;
  route = (createHttpRoutes(factory)["/api/runs/:id/resolve"] as Record<string, Route>).POST as Route;
});
afterEach(() => f.close());

const resolve = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  route(
    requestWithParams(
      `http://127.0.0.1:7400/api/runs/${id}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      { id },
    ),
    localServer,
  );

function finished(status: RunStatus, prompt = "work", repo = f.repo()) {
  const run = f.store.createRun(repo, { repo: repo.slug, prompt, title: prompt });
  f.store.updateRun(run.id, { status, error: "review required", finishedAt: 1234 });
  return run.id;
}
const resolvedItems = () => allItems(f.store).filter((item) => item.kind === "run.resolved");
const counts = () =>
  f.store.db
    .query("SELECT (SELECT count(*) FROM runs) AS runs, (SELECT count(*) FROM invocations) AS invocations")
    .get();

test("resolving needs_human records the outcome, keeps its evidence and writes one feed item", async () => {
  const id = finished("needs_human");
  f.store.startStage(id, "implement");
  f.store.putArtifact(id, "report.md", "report", "Human review required");
  const before = counts();
  const res = await resolve(id, { kind: "done_elsewhere", ref: "run-2", note: "landed by hand" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    id,
    status: "resolved",
    finishedAt: 1234,
    error: "review required",
    merged: false,
    resolution: { kind: "done_elsewhere", ref: "run-2", note: "landed by hand", by: "human" },
  });
  expect(typeof body.resolution.at).toBe("number");
  expect(f.store.listStages(id)).toHaveLength(1);
  expect(f.store.getArtifact(id, "report.md")).toBe("Human review required");
  expect(counts()).toEqual(before);
  expect(resolvedItems()).toMatchObject([
    { runId: id, data: { kind: "done_elsewhere", ref: "run-2", note: "landed by hand" } },
  ]);

  const failed = finished("failed");
  const won = await resolve(failed, { kind: "wont_do" });
  expect(won.status).toBe(200);
  expect(f.store.getRun(failed)?.resolution).toMatchObject({ kind: "wont_do", ref: null, note: null });
  expect(resolvedItems()).toHaveLength(2);
  f.reopen();
  expect(f.store.getRun(id)?.resolution).toEqual(body.resolution);
  expect(resolvedItems()).toHaveLength(2);
});

test("other statuses are 409, unknown runs 404, bad input 400; none change state or the feed", async () => {
  for (const status of ["queued", "waiting", "running", "waiting_input", "succeeded", "cancelled"] as const) {
    const id = finished(status);
    const res = await resolve(id, { kind: "done_elsewhere" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(`run is ${status}`);
    expect(f.store.getRun(id)).toMatchObject({ status, resolution: null });
  }
  expect((await resolve("missing", { kind: "wont_do" })).status).toBe(404);
  const id = finished("needs_human");
  const feed = allItems(f.store).length;
  for (const body of [
    { kind: "merged" },
    { kind: "fixed" },
    {},
    { kind: "wont_do", note: "" },
    { kind: "wont_do", ref: 7 },
    { kind: "wont_do", extra: true },
    "not json",
  ])
    expect((await resolve(id, body)).status).toBe(400);
  expect((await resolve(id, { kind: "wont_do" }, { origin: "https://evil.example" })).status).toBe(403);
  expect((await resolve(id, { kind: "wont_do" }, { "content-type": "text/plain" })).status).toBe(415);
  expect(f.store.getRun(id)).toMatchObject({ status: "needs_human", resolution: null });
  expect(allItems(f.store)).toHaveLength(feed);

  const [first, second] = await Promise.all([
    resolve(id, { kind: "wont_do", note: "first" }),
    resolve(id, { kind: "done_elsewhere", note: "second" }),
  ]);
  expect([first?.status, second?.status]).toEqual([200, 409]);
  const again = await resolve(id, { kind: "superseded" });
  expect(again.status).toBe(409);
  expect((await again.json()).error).toContain("run is resolved");
  expect(f.store.getRun(id)?.resolution).toMatchObject({ kind: "wont_do", note: "first" });
  expect(resolvedItems()).toHaveLength(1);
});

test("Closes directives match standalone, case-insensitive issue numbers only", () => {
  expect([...closedIssues("Closes #12\nalso CLOSES\t#7, closes  #12.")]).toEqual([12, 7]);
  for (const text of [
    "Closes #123",
    "Encloses #12",
    "Closes#12",
    "Fixes #12",
    "Closes o/r#12",
    "Closes #12a",
  ])
    expect(closedIssues(text).has(12)).toBe(false);
});

test("a merge recorded by the pipeline supersedes matching needs_human runs in its repository only", () => {
  const other = f.store.upsertRepo({
    slug: "local/other",
    kind: "local",
    url: null,
    localPath: f.dir,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const matching = Array.from({ length: 105 }, (_, i) =>
    finished("needs_human", i % 2 ? "Do it.\n\ncloses   #12" : "Closes #3 and Closes #12"),
  );
  const byOtherIssue = finished("needs_human", "Closes #7");
  const untouched = [
    finished("needs_human", "Closes #123"),
    finished("failed", "Closes #12"),
    finished("succeeded", "Closes #12"),
    finished("needs_human", "Closes #12", other),
  ];
  const decided = finished("needs_human", "Closes #12");
  f.store.resolveRun(decided, { kind: "wont_do", by: "human" });
  const merged = f.store.createRun(f.repo(), { repo: "local/feed", prompt: "Fix\n\nCloses #12, Closes #7" });
  const prUrl = "https://github.com/o/r/pull/9";
  f.store.updateRun(merged.id, { prUrl, merged: true });

  for (const id of [...matching, byOtherIssue])
    expect(f.store.getRun(id)?.resolution).toMatchObject({ kind: "superseded", ref: prUrl, by: "system" });
  for (const id of untouched) expect(f.store.getRun(id)?.resolution).toBeNull();
  expect(f.store.getRun(untouched[1] ?? "")?.status).toBe("failed");
  expect(f.store.getRun(decided)?.resolution?.kind).toBe("wont_do");
  expect(resolvedItems()).toHaveLength(matching.length + 2);
});

test("the previous release's merge SQL still resolves a run and writes one merged-kind feed item", () => {
  const id = finished("needs_human");
  f.store.updateRun(id, { prUrl: "https://github.com/o/r/pull/7" });
  f.store.db
    .query(
      "UPDATE runs SET status = 'resolved', merged = 1, merged_by = ?, merged_at = ? WHERE id = ? AND status = 'needs_human' AND pr_url IS NOT NULL",
    )
    .run("octocat", 99, id);
  expect(f.store.getRun(id)).toMatchObject({ status: "resolved", merged: true, resolution: null });
  expect(resolvedItems().map((item) => [item.title, item.data?.kind])).toEqual([
    ["Resolved (merged): work", "merged"],
  ]);
});

test("an unmerged resolved prerequisite blocks new dependants, retries and waiting runs", () => {
  const ancestor = f.run("ancestor");
  f.store.updateRun(ancestor.id, { status: "failed", error: "gates failed", finishedAt: 123 });
  const pending = f.run("pending");
  f.store.updateRun(pending.id, { status: "needs_human", prUrl: "https://github.com/o/r/pull/8" });
  const waiting = f.run("waiting", [pending.id]);
  expect(waiting.status).toBe("waiting");
  f.store.resolveRun(ancestor.id, { kind: "wont_do", by: "human" });
  f.store.resolveRun(pending.id, { kind: "done_elsewhere", by: "human" });
  const created = f.run("after", [ancestor.id]);
  expect(created).toMatchObject({
    status: "needs_human",
    error: `Dependency ${ancestor.id}: run resolved as wont_do without merging`,
  });
  expect(f.run("retry", created.dependsOn).status).toBe("needs_human");
  f.store.reconcileWaitingRuns();
  expect(f.store.getRun(waiting.id)).toMatchObject({
    status: "needs_human",
    error: `Dependency ${pending.id}: run resolved as done_elsewhere without merging`,
  });
});
