import { expect, mock, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import type { Run } from "../src/core/types.ts";
import { cachePath } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import type { IssueText } from "../src/integrations/issue-trust.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { sh } from "../src/util/proc.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

async function acceptanceFixture() {
  const f = await fixture();
  f.factory.cfg.githubQueue = { repos: [], trusted: ["OWNER"], maxIssueRuns: 1, pollSeconds: 180 };
  const repo = f.factory.store.upsertRepo({
    slug: "example/repo",
    kind: "github",
    url: f.repo, // Only local Git transport; no network or real gh.
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const text = { author: { login: "owner" }, editor: null, lastEditedAt: null };
  const ticket: IssueText & { title: string; parent: IssueText | null } = {
    ...text,
    number: 2,
    title: "Check the feature",
    body: '## The original intent\n#1\'s "Goal" section',
    parent: { ...text, number: 1, body: "## Goal\n- The feature works." },
  };
  const reader = mock(() => ({}));
  f.factory.deps.harnesses = { fake: fakeHarness(reader) };
  const gh: GhRunner = mock(async (args, _signal, _stdin, scope) => {
    expect(scope).toBe("example/repo");
    expect(args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(args[3]).toContain('repository(owner:"example", name:"repo")');
    expect(args[3]).toContain("issue(number:2)");
    expect(args[3]).toContain("parent { number body author { login } editor { login } lastEditedAt }");
    return JSON.stringify({ data: { repository: { issue: ticket } } });
  });
  const route = (createHttpRoutes(f.factory, { gh })["/api/acceptance"] as { POST: Route }).POST;
  const post = (check?: boolean) =>
    route(
      requestWithParams("http://localhost/api/acceptance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repo.slug, number: 2, ...(check === undefined ? {} : { check }) }),
      }),
      localServer,
    );
  return { ...f, repo, ticket, reader, gh, post };
}

test("acceptance check resolves fresh trusted intent at the default branch head without running work", async () => {
  const f = await acceptanceFixture();
  try {
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.repo.url ?? "" })).stdout.trim();
    const response = await f.post(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      sha,
      units: [{ id: "U1", text: "The feature works.", class: "behaviour", sources: ['#1 "Goal"'] }],
    });
    expect(f.factory.store.listRuns()).toEqual([]);
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.gh).toHaveBeenCalledTimes(1);
    expect(readdirSync(f.factory.cfg.paths.work)).toEqual([]);
    expect(existsSync(cachePath(f.factory.cfg.paths, f.repo))).toBe(true);
  } finally {
    await f.close();
  }
});

test.each([
  ["malformed intent", "blockquote"],
  ["untrusted ticket", "ticket: untrusted author"],
  ["empty trusted list", "ticket: untrusted author"],
  ["missing parent", "acceptance ticket has no parent"],
] as const)("acceptance check returns a refusal for %s without a run or model", async (mode, reason) => {
  const f = await acceptanceFixture();
  try {
    if (mode === "malformed intent") f.ticket.body = "## The original intent\n> quoted intent";
    if (mode === "untrusted ticket") f.ticket.author = { login: "stranger" };
    if (mode === "empty trusted list" && f.factory.cfg.githubQueue) f.factory.cfg.githubQueue.trusted = [];
    if (mode === "missing parent") f.ticket.parent = null;
    const response = await f.post(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    expect(f.factory.store.listRuns()).toEqual([]);
    expect(f.reader).not.toHaveBeenCalled();
    expect(readdirSync(f.factory.cfg.paths.work)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("accept creates one CLI acceptance run and a second request conflicts with its issue claim", async () => {
  const f = await acceptanceFixture();
  try {
    const response = await f.post();
    expect(response.status).toBe(201);
    const run = (await response.json()) as Run;
    expect(run).toMatchObject({
      flow: "acceptance",
      source: "cli",
      sourceRef: { kind: "issue", repo: "example/repo", number: 2, via: "cli" },
    });
    const second = await f.post();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: expect.stringContaining(run.id) });
    expect(f.factory.store.listRuns()).toHaveLength(1);
    expect(f.reader).not.toHaveBeenCalled();
    expect(existsSync(cachePath(f.factory.cfg.paths, f.repo))).toBe(false);
  } finally {
    await f.close();
  }
});

test("accept refuses untrusted text with a 400 before creating a run", async () => {
  const f = await acceptanceFixture();
  try {
    f.ticket.author = { login: "stranger" };
    const response = await f.post();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ticket: untrusted author" });
    expect(f.factory.store.listRuns()).toEqual([]);
    expect(f.reader).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
