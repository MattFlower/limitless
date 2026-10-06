import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { FeedPage, Question, Run } from "../src/core/types.ts";
import { createMcpServer, type Fetch, factoryBackend, httpBackend } from "../src/integrations/mcp.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { connect, fixture, localServer, type Route, requestWithParams, resultValue } from "./mcp-support.ts";
import { privacyTexts } from "./privacy-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

test("proxy maps all six tools to REST and matches Factory results, including filtered event tail", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const routes = createHttpRoutes(f.factory);
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const match = path.match(/^\/api\/runs\/([^/]+)(\/events|\/cancel|\/answer|\/resolve)?$/);
    const key = match ? `/api/runs/:id${match[2] ?? ""}` : path;
    const entry = routes[key];
    const handler = (
      typeof entry === "function" ? entry : (entry as Record<string, Route>)[init?.method ?? "GET"]
    ) as Route;
    return handler(
      requestWithParams(url, init, match ? { id: decodeURIComponent(match[1] ?? "") } : {}),
      localServer,
    );
  };
  const proxy = await connect(httpBackend("http://127.0.0.1:7400/", fetcher));
  const direct = await connect(factoryBackend(f.factory));
  try {
    const call = (name: string, args: Record<string, unknown> = {}) =>
      proxy.client.callTool({ name: `limitless_${name}`, arguments: args });
    const run = resultValue<Run>(await call("create_run", { repo: f.repo, prompt: "Do work" }));
    expect(run).toMatchObject({ source: "mcp", status: "queued", profile: "auto" });
    expect(requests[0]?.url).toBe("http://127.0.0.1:7400/api/runs");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ source: "mcp", profile: "auto" });
    f.factory.store.db.transaction(() => {
      for (let i = 0; i < 5100; i++)
        f.factory.store.addEvent({
          runId: run.id,
          type: "log",
          level: i % 2 ? "debug" : "info",
          message: String(i),
        });
    })();
    for (const [name, args] of [
      ["get_run", { id: run.id }],
      ["list_runs", { status: "queued", limit: 1 }],
    ] as const) {
      expect(await call(name, args)).toEqual(
        await direct.client.callTool({ name: `limitless_${name}`, arguments: args }),
      );
    }
    expect(requests.some((r) => r.url.endsWith("/events?tail=true&excludeDebug=true&limit=20"))).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/api/runs?limit=1&status=queued"))).toBe(true);
    const legacy = await fetcher(`http://127.0.0.1:7400/api/runs/${run.id}/events?limit=6000`);
    const legacyEvents = await legacy.json();
    expect(legacyEvents).toHaveLength(5000);
    expect(legacyEvents[0].message).toBe("Run created from mcp");
    expect(resultValue(await call("providers"))).toMatchObject([
      { id: "fake", enabled: true, windows: {}, spendUsd: null, budgetUsd: null },
    ]);
    expect(requests.at(-1)?.url).toEndWith("/api/providers");
    const waiting = resultValue<Run>(
      await call("create_run", { repo: f.repo, prompt: "next", dependsOn: [` ${run.id} `, run.id] }),
    );
    expect(waiting).toMatchObject({ status: "waiting", dependsOn: [run.id] });
    expect(resultValue(await call("get_run", { id: waiting.id }))).toMatchObject({
      dependsOn: [run.id],
      status: "waiting",
    });
    expect(resultValue<Run[]>(await call("list_runs", { status: "waiting" })).map((r) => r.id)).toEqual([
      waiting.id,
    ]);
    expect((await call("create_run", { repo: f.repo, prompt: "bad", dependsOn: ["unknown"] })).isError).toBe(
      true,
    );
    for (const dependsOn of [null, [""], [false], ["unknown"]]) {
      const response = await fetcher("http://127.0.0.1:7400/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: f.repo, prompt: "bad", dependsOn }),
      });
      expect(response.status).toBe(400);
    }

    f.factory.store.askQuestion(run.id, "What?");
    const answer = resultValue<Question[]>(await call("answer_question", { id: run.id, answer: "All good" }));
    expect(answer[0]).toMatchObject({ answer: "All good", answeredBy: "mcp" });
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "All good", by: "mcp" }),
    });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: true,
    });
    expect(requests.at(-1)?.url).toEndWith(`/api/runs/${run.id}/cancel`);
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: false,
    });
    // Cancelled is not resolvable; the daemon's 409 surfaces once, and manual merged never leaves the client.
    const conflict = await call("resolve_run", { id: run.id, kind: "wont_do" });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.content)).toContain("409");
    const sent = requests.length;
    expect((await call("resolve_run", { id: run.id, kind: "merged" })).isError).toBe(true);
    expect(requests).toHaveLength(sent);
    f.factory.store.updateRun(waiting.id, { status: "needs_human" });
    const resolved = resultValue<Run>(
      await call("resolve_run", { id: waiting.id, kind: "superseded", ref: run.id, note: "redone" }),
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: { kind: "superseded", ref: run.id, note: "redone", by: "human" },
    });
    expect(requests.at(-1)?.url).toBe(`http://127.0.0.1:7400/api/runs/${waiting.id}/resolve`);
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ kind: "superseded", ref: run.id, note: "redone" }),
    });
    f.factory.store.updateRun(run.id, { status: "failed" });
    const viaDirect = await direct.client.callTool({
      name: "limitless_resolve_run",
      arguments: { id: run.id, kind: "done_elsewhere" },
    });
    expect(resultValue<Run>(viaDirect).resolution).toMatchObject({ kind: "done_elsewhere", by: "human" });
    const again = await direct.client.callTool({
      name: "limitless_resolve_run",
      arguments: { id: run.id, kind: "wont_do" },
    });
    expect(JSON.stringify(again.content)).toContain("run is resolved");
    for (const name of ["get_run", "cancel_run", "answer_question", "resolve_run"]) {
      const result = await call(name, {
        id: "missing",
        ...(name === "answer_question" ? { answer: "x" } : {}),
        ...(name === "resolve_run" ? { kind: "wont_do" } : {}),
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not found");
    }
    expect((await call("answer_question", { id: run.id, answer: "again" })).isError).toBe(true);
    const before = requests.length;
    expect((await call("create_run", { repo: "", prompt: "x" })).isError).toBe(true);
    expect(requests).toHaveLength(before);
  } finally {
    await proxy.close();
    await direct.close();
  }
});

test("ids are encoded in every proxy path", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "x" });
  const urls: string[] = [];
  const backend = httpBackend("http://localhost:7400", async (url) => {
    urls.push(url);
    return Response.json(f.factory.store.getRunDetail(run.id));
  });
  const id = "id/with ?#%";
  await backend.detail(id);
  await backend.events(id);
  await backend.cancel(id);
  await backend.answer(id, "answer");
  await backend.resolve(id, { kind: "wont_do" });
  await backend.review(id, { verdict: "approve", reviewedSha: "a".repeat(40), findings: [] });
  expect(
    urls.every((url) => url.startsWith(`http://localhost:7400/api/runs/${encodeURIComponent(id)}`)),
  ).toBe(true);
});

test("review and land forward validated payloads and return API results", async () => {
  const requests: { path: string; body: unknown; method: string | undefined }[] = [];
  const sha = "a".repeat(40);
  const finding = { severity: "major", title: "Bug", file: "app.ts", line: 2, detail: "Fix it" };
  let response: unknown = { approval: { sha, stale: false } };
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url, init) => {
      requests.push({
        path: new URL(url).pathname,
        body: JSON.parse(String(init?.body)),
        method: init?.method,
      });
      return Response.json(response);
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    proxy.client.callTool({ name: `limitless_${name}`, arguments: args });
  try {
    expect(
      resultValue<unknown>(
        await call("review", {
          run: "r/1",
          verdict: "approve",
          reviewedSha: sha.toUpperCase(),
          findings: [],
        }),
      ),
    ).toEqual({ approval: { sha, stale: false } });
    expect(
      resultValue<unknown>(await call("review", { run: "r/1", verdict: "approve", reviewedSha: sha })),
    ).toEqual({ approval: { sha, stale: false } });
    response = { round: { id: "round1", status: "queued" } };
    expect(
      resultValue<unknown>(
        await call("review", { run: "r/1", verdict: "changes", reviewedSha: sha, findings: [finding] }),
      ),
    ).toEqual({ round: { id: "round1", status: "queued" } });
    response = { id: 7, state: "queued" };
    expect(resultValue<unknown>(await call("land", { run: "r/1" }))).toEqual({ id: 7, state: "queued" });
    expect(resultValue<unknown>(await call("land", { run: "r/1", sha }))).toEqual({ id: 7, state: "queued" });
    expect(requests).toEqual([
      {
        path: "/api/runs/r%2F1/review",
        method: "POST",
        body: { verdict: "approve", reviewedSha: sha, findings: [] },
      },
      {
        path: "/api/runs/r%2F1/review",
        method: "POST",
        body: { verdict: "approve", reviewedSha: sha, findings: [] },
      },
      {
        path: "/api/runs/r%2F1/review",
        method: "POST",
        body: { verdict: "changes", reviewedSha: sha, findings: [finding] },
      },
      { path: "/api/land", method: "POST", body: { target: "r/1" } },
      { path: "/api/land", method: "POST", body: { target: "r/1", sha } },
    ]);
    for (const input of [
      { verdict: "approve", findings: [finding] },
      { verdict: "changes", findings: [] },
      { verdict: "other", findings: [] },
      { verdict: "approve", findings: [], reviewedSha: "short" },
      { verdict: "changes" },
      { verdict: "changes", findings: [{ ...finding, line: 0 }] },
      { verdict: "changes", findings: [{ ...finding, title: " " }] },
      { verdict: "changes", findings: [{ ...finding, severity: "critical" }] },
      { verdict: "approve", findings: [], extra: true },
    ])
      expect((await call("review", { run: "r/1", reviewedSha: sha, ...input })).isError).toBe(true);
    expect((await call("land", { run: " " })).isError).toBe(true);
    expect((await call("land", { run: "r/1", sha: 12 })).isError).toBe(true);
    expect(requests).toHaveLength(5);
  } finally {
    await proxy.close();
  }
});

test("review and land refusals or uncertain responses are MCP errors without retries", async () => {
  for (const response of [
    () => Response.json({ error: "reviewed SHA moved; land rejected" }, { status: 409 }),
    () => {
      throw new Error("connection lost");
    },
    () => new Response("invalid JSON"),
  ]) {
    let requests = 0;
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async () => {
        requests++;
        return response();
      }),
    );
    try {
      for (const name of ["review", "land"]) {
        const result = await proxy.client.callTool({
          name: `limitless_${name}`,
          arguments:
            name === "review"
              ? { run: "r1", verdict: "approve", reviewedSha: "a".repeat(40), findings: [] }
              : { run: "r1" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/HTTP 409|Cannot reach|Malformed JSON/);
      }
      expect(requests).toBe(2);
    } finally {
      await proxy.close();
    }
  }
});

test("status explains review, input, land and terminal states using saved observations", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
  const sha = "a".repeat(40),
    prUrl = "https://github.com/o/r/pull/1";
  const base = {
    ...f.factory.store.getRunDetail(run.id),
    run: { ...run, status: "succeeded", prUrl },
    prSnapshot: { state: "OPEN", headRefOid: sha },
    review: { approval: null, rounds: [] },
  };
  const entry = { id: 1, runId: run.id, prUrl, state: "queued", reason: null };
  let detail: unknown = base;
  let lands: unknown = [];
  const urls: string[] = [];
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url) => {
      urls.push(new URL(url).pathname);
      if (url.includes("missing")) return Response.json({ error: "not found" }, { status: 404 });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/land") expect(parsed.searchParams.get("run")).toBe(run.id);
      return Response.json(parsed.pathname === "/api/land" ? lands : detail);
    }),
  );
  const read = () => proxy.client.callTool({ name: "limitless_status", arguments: { run: run.id } });
  try {
    for (const [patch, land, state, action] of [
      [{}, [], "Review needed", "limitless_review"],
      [{ prSnapshot: null }, [], "PR state unknown", "Inspect the PR"],
      [
        { prSnapshot: { state: "OPEN" }, review: { approval: { sha, stale: false }, rounds: [] } },
        [],
        "PR head unknown",
        "current PR head",
      ],
      [
        { review: { approval: { sha, stale: false }, rounds: [] } },
        [],
        "Approved; landing not queued",
        "limitless_land",
      ],
      [{ review: { approval: { sha, stale: true }, rounds: [] } }, [], "Review needed", "limitless_review"],
      [
        {
          prSnapshot: { state: "OPEN", headRefOid: "b".repeat(40) },
          review: { approval: { sha, stale: false }, rounds: [] },
        },
        [],
        "Review needed",
        "limitless_review",
      ],
      [{}, [entry], "Landing in progress (queued)", "Wait"],
      [{}, [{ ...entry, state: "waiting_ci" }], "Landing in progress (waiting_ci)", "Wait"],
      [{}, [{ ...entry, state: "blocked", reason: "CI failed" }], "Landing blocked", "resolve the blocker"],
      [{}, [{ ...entry, state: "landed" }], "Landed", "No action needed"],
      [{ prSnapshot: { state: "MERGED" } }, [], "Landed", "No action needed"],
      [{ run: { ...run, status: "succeeded", prUrl: null } }, [], "Completed", "delivery results"],
      [{ run: { ...run, status: "failed" } }, [], "Failed", "error"],
      [{ run: { ...run, status: "cancelled" } }, [], "Cancelled", "new run"],
      [{ run: { ...run, status: "queued" } }, [], "Work pending", "Wait"],
      [{ questions: [{ answer: null }] }, [], "Input needed", "limitless_answer_question"],
      [
        { review: { approval: null, rounds: [{ runId: "round1", status: "running" }] } },
        [],
        "Review changes in progress",
        "round1",
      ],
      [
        { review: { approval: null, rounds: [{ runId: "round1", status: "waiting_input" }] } },
        [],
        "Input needed",
        "round1",
      ],
      [
        { review: { approval: null, rounds: [{ runId: "round1", status: "failed" }] } },
        [],
        "Review changes failed",
        "round1",
      ],
      [
        {
          review: {
            approval: { sha, stale: false },
            approvedAt: 20,
            rounds: [
              { runId: "newer", status: "waiting_input", createdAt: 30 },
              { runId: "older", status: "failed", createdAt: 10 },
            ],
          },
        },
        [],
        "Input needed",
        "newer",
      ],
      [
        {
          review: {
            approval: { sha, stale: false },
            approvedAt: 20,
            rounds: [{ runId: "delivered", status: "succeeded", createdAt: 30 }],
          },
        },
        [],
        "Review needed",
        "limitless_review",
      ],
    ] as const) {
      detail = { ...base, ...patch };
      lands = land;
      const result = resultValue<{ state: string; nextAction: string }>(await read());
      expect(result.state).toBe(state);
      expect(result.nextAction).toContain(action);
    }
    lands = [
      { ...entry, id: 2, state: "landed" },
      { ...entry, state: "blocked" },
    ];
    detail = base;
    expect(resultValue(await read())).toMatchObject({ state: "Landed" });
    const before = urls.length;
    const missing = await proxy.client.callTool({ name: "limitless_status", arguments: { run: "missing" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("not found");
    expect(urls.slice(before)).toEqual(["/api/runs/missing"]);
  } finally {
    await proxy.close();
  }
});

test.each(["failed", "cancelled"] as const)(
  "status lets a later approval supersede a %s round on both backends",
  async (status) => {
    const { store } = f.factory;
    const repo = store.upsertRepo({
      slug: "o/r",
      kind: "github",
      url: "https://github.com/o/r",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "work" });
    const prUrl = "https://github.com/o/r/pull/1",
      sha = "a".repeat(40);
    store.updateRun(run.id, { status: "succeeded", prUrl, branch: "limitless/feature" });
    store.saveGithubPr({
      url: prUrl,
      repo: "o/r",
      runId: run.id,
      delivered: 1,
      nodeId: "PR_1",
      data: JSON.stringify({ state: "OPEN", headRefOid: sha }),
    });
    const round = store.createReviewRound(
      repo,
      store.getRun(run.id) as Run,
      { prUrl, reviewedSha: sha, findings: [{ severity: "major", title: "Fix", detail: "Bug" }], cap: 3 },
      (round) => ({
        repo: repo.slug,
        prompt: "Fix findings",
        baseBranch: "limitless/feature",
        deliveryBranch: "limitless/feature",
        sourceRef: { kind: "review-round", runId: run.id, round, prUrl, reviewedSha: sha },
      }),
    );
    if (!("run" in round)) throw new Error("Expected a review round");
    store.updateRun(round.run.id, { status });
    store.db.query("UPDATE review_rounds SET created_at = ? WHERE run_id = ?").run(10, round.run.id);
    store.recordApproval(run.id, prUrl, sha, "reviewer");
    store.db.query("UPDATE review_approvals SET created_at = ? WHERE pr_url = ?").run(20, prUrl);
    const routes = createHttpRoutes(f.factory);
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async (url, init) => {
        const path = new URL(url).pathname;
        const route = routes[path === "/api/land" ? path : "/api/runs/:id"];
        const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
        return handler(requestWithParams(url, init, { id: run.id }), localServer);
      }),
    );
    const direct = await connect(factoryBackend(f.factory));
    try {
      for (const conn of [proxy, direct]) {
        const result = resultValue<{ state: string; nextAction: string }>(
          await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } }),
        );
        expect(result.state).toBe("Approved; landing not queued");
        expect(result.nextAction).toContain("limitless_land");
      }
    } finally {
      await proxy.close();
      await direct.close();
    }
  },
);

test("status finds the latest land by run or PR beyond 100 historical entries on both backends", async () => {
  const { store } = f.factory;
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
  const prUrl = "https://github.com/o/r/pull/101";
  const sha = "a".repeat(40);
  store.updateRun(run.id, { status: "succeeded", prUrl });
  store.saveGithubPr({
    url: prUrl,
    repo: "o/r",
    runId: run.id,
    delivered: 1,
    nodeId: "PR_101",
    data: JSON.stringify({ state: "OPEN", headRefOid: sha }),
  });
  store.recordApproval(run.id, prUrl, sha, "reviewer");
  const createEntry = (runId: string, pr: string) =>
    store.createLandEntry({
      runId,
      repo: "o/r",
      prUrl: pr,
      baseBranch: "main",
      headBranch: "pr-branch",
      approvedSha: sha,
    });
  store.db.transaction(() => {
    for (let i = 1; i <= 100; i++) {
      const entry = createEntry(`historical-${i}`, `https://github.com/o/r/pull/${i}`);
      store.updateLandEntry(entry.id, { state: "landed" });
    }
  })();
  const blocked = createEntry("review-round", prUrl);
  store.updateLandEntry(blocked.id, { state: "blocked", reason: "CI failed" });
  const routes = createHttpRoutes(f.factory);
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url, init) => {
      const path = new URL(url).pathname;
      const route = routes[path === "/api/land" ? path : "/api/runs/:id"];
      const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
      return handler(requestWithParams(url, init, { id: run.id }), localServer);
    }),
  );
  const direct = await connect(factoryBackend(f.factory));
  const check = async (state: string, id: number, reason: string | null) => {
    for (const conn of [proxy, direct]) {
      const result = await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } });
      expect(resultValue(result)).toMatchObject({ state, land: { id, reason } });
    }
  };
  try {
    expect(f.factory.land.list()).toHaveLength(100);
    await check("Landing blocked", blocked.id, "CI failed");
    const queued = createEntry(run.id, prUrl);
    await check("Landing in progress (queued)", queued.id, null);
    store.updateLandEntry(queued.id, { state: "landed" });
    await check("Landed", queued.id, null);
  } finally {
    await proxy.close();
    await direct.close();
  }
});

test.each([
  ["direct", "readable"],
  ["proxy", "readable"],
  ["direct", "unreadable"],
  ["proxy", "unreadable"],
  ["direct", "invalid UTF-8"],
  ["proxy", "invalid UTF-8"],
] as const)("status protects every output field on %s with a %s denylist", async (backend, policy) => {
  const previousConfigDir = process.env.LIMITLESS_CONFIG_DIR;
  const configDir = join(f.home, "status-config");
  mkdirSync(configDir);
  process.env.LIMITLESS_CONFIG_DIR = configDir;
  const file = join(configDir, "private-strings.txt");
  const credential = "status-test-long-credential";
  const sensitive = `Private Prospect ${credential}`;
  registerCredential("STATUS_TEST_CREDENTIAL", credential);
  const { store } = f.factory;
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work", title: sensitive });
  const prUrl = `https://github.com/o/r/pull/1?${sensitive}`;
  store.updateRun(run.id, { status: "succeeded", prUrl });
  store.askQuestion(run.id, `Question about ${sensitive}`);
  const land = store.createLandEntry({
    runId: sensitive,
    repo: "o/r",
    prUrl,
    baseBranch: "main",
    headBranch: "feature",
    approvedSha: "a".repeat(40),
  });
  store.updateLandEntry(land.id, { state: "blocked", reason: `CI failed for ${sensitive}` });
  if (policy === "readable") writeFileSync(file, "Private Prospect\nLanding blocked\nInspect\n");
  else if (policy === "unreadable") mkdirSync(file);
  else writeFileSync(file, Buffer.from([0xff]));
  const routes = createHttpRoutes(f.factory);
  const conn = await connect(
    backend === "direct"
      ? factoryBackend(f.factory)
      : httpBackend("http://daemon.invalid", async (url, init) => {
          const path = new URL(url).pathname;
          const route = routes[path === "/api/land" ? path : "/api/runs/:id"];
          const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
          return handler(requestWithParams(url, init, { id: run.id }), localServer);
        }),
  );
  try {
    const result = await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } });
    const text = JSON.stringify(result);
    expect(text).not.toContain("Private Prospect");
    expect(text).not.toContain(credential);
    if (policy === "readable") {
      expect(resultValue(result)).toMatchObject({
        run: run.id,
        state: "[withheld: private text]",
        nextAction: "[withheld: private text]",
        land: { id: land.id, runId: "[withheld: private text]", reason: "[withheld: private text]" },
      });
    } else {
      expect(resultValue<unknown>(result)).toEqual({
        land: { id: land.id, state: "blocked" },
        openQuestions: 1,
      });
      expect(text).not.toContain(run.id);
      expect(text).not.toContain("CI failed");
    }
  } finally {
    await conn.close();
    if (previousConfigDir === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
    else process.env.LIMITLESS_CONFIG_DIR = previousConfigDir;
  }
});

test.each(["direct", "proxy"] as const)(
  "%s MCP withholds encoded private fields and errors",
  async (backend) => {
    const previous = process.env.LIMITLESS_CONFIG_DIR;
    const configDir = join(f.home, "privacy-config");
    mkdirSync(configDir);
    process.env.LIMITLESS_CONFIG_DIR = configDir;
    const file = join(configDir, "private-strings.txt");
    writeFileSync(file, "secret-host.example\n");
    registerCredential("PRIVACY_TEST_CREDENTIAL", "privacy-test-credential");
    const routes = createHttpRoutes(f.factory);
    const conn = await connect(
      backend === "direct"
        ? factoryBackend(f.factory)
        : httpBackend("http://daemon.invalid", async (url, init) => {
            const path = new URL(url).pathname;
            const match = path.match(/^\/api\/runs\/([^/]+)(\/events)?$/);
            const route = routes[match ? `/api/runs/:id${match[2] ?? ""}` : path];
            const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
            return handler(
              requestWithParams(url, init, { id: decodeURIComponent(match?.[1] ?? "") }),
              localServer,
            );
          }),
    );
    try {
      for (const text of privacyTexts) {
        const run = await f.factory.createRun({ repo: f.repo, prompt: "work", title: `Title ${text}` });
        f.factory.store.updateRun(run.id, { status: "failed", error: `Failure ${text}` });
        f.factory.store.askQuestion(run.id, `Question ${text}`);
        const land = f.factory.store.createLandEntry({
          runId: run.id,
          repo: "o/r",
          prUrl: "https://github.com/o/r/pull/1",
          baseBranch: "main",
          headBranch: "feature",
          approvedSha: "a".repeat(40),
        });
        f.factory.store.updateLandEntry(land.id, { state: "blocked", reason: `Reason ${text}` });
        const detail = resultValue<{ title: string; error: string; questions: { question: string }[] }>(
          await conn.client.callTool({ name: "limitless_get_run", arguments: { id: run.id } }),
        );
        expect(detail).toMatchObject({
          title: "[withheld: private text]",
          error: "[withheld: private text]",
          questions: [{ question: "[withheld: private text]" }],
        });
        const status = resultValue<{ land: { reason: string }; state: string }>(
          await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } }),
        );
        expect(status).toMatchObject({
          state: "Landing blocked",
          land: { reason: "[withheld: private text]" },
        });
        f.factory.store.db
          .query(`INSERT INTO feed (ts, kind, run_id, title, summary, data, dedupe_key)
          VALUES (1, 'review.round_delivered', ?, 'Safe round title', ?, ?, ?)`)
          .run(run.id, `Round ${text}`, JSON.stringify({ nested: [{ [text]: text }] }), run.id);
        const feed = resultValue<FeedPage>(
          await conn.client.callTool({ name: "limitless_feed", arguments: { after: 0 } }),
        );
        expect(feed.items.filter((item) => item.runId === run.id).map((item) => item.summary)).toEqual([
          "[withheld: private text]",
          "[withheld: private text]",
          "[withheld: private text]",
        ]);
        expect(
          feed.items.find((item) => item.runId === run.id && item.kind === "review.round_delivered")?.data,
        ).toEqual({ nested: [{ "[withheld: private text]": "[withheld: private text]" }] });
        const error = await conn.client.callTool({ name: "limitless_status", arguments: { run: text } });
        expect(error.isError).toBe(true);
        expect(error.content).toEqual([
          {
            type: "text",
            text:
              backend === "direct" ? "[withheld: private text]" : 'Daemon HTTP 404: {"error":"not found"}',
          },
        ]);
      }
      mkdirSync(join(configDir, "bad"));
      process.env.LIMITLESS_CONFIG_DIR = join(configDir, "bad");
      mkdirSync(join(configDir, "bad", "private-strings.txt"));
      const error = await conn.client.callTool({
        name: "limitless_status",
        arguments: { run: privacyTexts[0] },
      });
      expect(error.isError).toBe(true);
      expect(error.content).toEqual([{ type: "text", text: "MCP tool failed; privacy policy unavailable." }]);
    } finally {
      await conn.close();
      if (previous === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
      else process.env.LIMITLESS_CONFIG_DIR = previous;
    }
  },
);

test("status filters proxy response and connection exception text, including unreadable policy", async () => {
  const previous = process.env.LIMITLESS_CONFIG_DIR;
  const configDir = join(f.home, "proxy-error-config");
  mkdirSync(configDir);
  process.env.LIMITLESS_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, "private-strings.txt"), "secret-host.example\n");
  registerCredential("PRIVACY_TEST_CREDENTIAL", "privacy-test-credential");
  try {
    for (const mode of ["http", "json", "connection", "unreadable"] as const) {
      if (mode === "unreadable") process.env.LIMITLESS_CONFIG_DIR = join(configDir, "private-strings.txt");
      for (const text of privacyTexts) {
        const conn = await connect(
          httpBackend(`http://daemon.invalid/${text}`, async () => {
            if (mode === "connection") throw new Error(`Connection ${text}`);
            if (mode === "json") return Response.json({ error: `Upstream ${text}` }, { status: 503 });
            return new Response(`Upstream ${text}`, { status: 503 });
          }),
        );
        try {
          const result = await conn.client.callTool({
            name: "limitless_status",
            arguments: { run: "missing" },
          });
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([
            {
              type: "text",
              text:
                mode === "unreadable"
                  ? "MCP tool failed; privacy policy unavailable."
                  : "[withheld: private text]",
            },
          ]);
        } finally {
          await conn.close();
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
    else process.env.LIMITLESS_CONFIG_DIR = previous;
  }
});

test("connection, HTTP and malformed responses are MCP errors and mutations are never retried", async () => {
  for (const [response, expected] of [
    [
      () => {
        throw new Error("offline");
      },
      "Cannot reach",
    ],
    [() => new Response("upstream failed", { status: 503 }), "HTTP 503"],
    [() => new Response("not JSON"), "Malformed JSON"],
    [() => Response.json({ unexpected: true }), "Invalid"],
  ] as const) {
    let calls = 0;
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async () => {
        calls++;
        return response();
      }),
    );
    try {
      const result = await proxy.client.callTool({
        name: "limitless_create_run",
        arguments: { repo: f.repo, prompt: "x" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(expected);
      expect(calls).toBe(1);
      calls = 0;
      const resolved = await proxy.client.callTool({
        name: "limitless_resolve_run",
        arguments: { id: "run", kind: "wont_do" },
      });
      expect(resolved.isError).toBe(true);
      expect(calls).toBe(1);
      expect((await proxy.client.listTools()).tools).toHaveLength(12);
    } finally {
      await proxy.close();
    }
  }
});

test("stdio streams emit only protocol JSON and survive daemon errors", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const server = createMcpServer(
    httpBackend("http://daemon.invalid", async () => {
      throw new Error("offline");
    }),
  );
  await server.connect(new StdioServerTransport(stdin, stdout));
  try {
    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "limitless_providers", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    ])
      stdin.write(`${JSON.stringify(message)}\n`);
    for (let i = 0; i < 100 && output.trim().split("\n").length < 3; i++) await Bun.sleep(5);
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
    expect(messages.find((m) => m.id === 2).result.isError).toBe(true);
    expect(messages.find((m) => m.id === 3).result.tools).toHaveLength(12);
  } finally {
    await server.close();
    stdin.destroy();
    stdout.destroy();
  }
});

test("proxy feed tools match the direct backend and allow a 45-second long poll", async () => {
  const routes = createHttpRoutes(f.factory);
  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname as "/api/feed" | "/api/feed/ack";
    const handler = (routes[path] as Record<string, Route>)[init?.method ?? "GET"] as Route;
    return handler(requestWithParams(url, init), localServer);
  };
  const proxy = await connect(httpBackend("http://127.0.0.1:7400", fetcher));
  const direct = await connect(factoryBackend(f.factory));
  const timeouts = spyOn(AbortSignal, "timeout");
  try {
    const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
    f.factory.store.updateRun(run.id, { status: "needs_human", error: "pick a name" });
    f.factory.store.askQuestion(run.id, "Which name?");
    const read = (conn: typeof proxy, args: Record<string, unknown>) =>
      conn.client.callTool({ name: "limitless_feed", arguments: args });
    for (const args of [{ consumer: "proxy" }, { after: 1 }, {}])
      expect(resultValue(await read(proxy, args))).toEqual(resultValue(await read(direct, args)));
    timeouts.mockClear();
    expect(resultValue(await read(proxy, { consumer: "proxy", wait: 45 }))).toEqual(
      resultValue(await read(direct, { consumer: "proxy", wait: 45 })),
    );
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([75_000]);
    timeouts.mockClear();
    const ack = await proxy.client.callTool({
      name: "limitless_feed_ack",
      arguments: { consumer: "proxy", id: 1 },
    });
    expect(resultValue<unknown>(ack)).toEqual({ consumer: "proxy", id: 1 });
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
    const page = resultValue<{ items: { id: number }[] }>(await read(proxy, { consumer: "proxy" }));
    expect(page.items.map((i) => i.id)).toEqual([2]);
    expect(resultValue(await read(proxy, { consumer: "proxy" }))).toEqual(
      resultValue(await read(direct, { consumer: "proxy" })),
    );
    expect((await read(proxy, { wait: 46 })).isError).toBe(true);
  } finally {
    timeouts.mockRestore();
    await proxy.close();
    await direct.close();
  }
});

test("cancelling a proxied feed long poll aborts the daemon request", async () => {
  let seen: AbortSignal | undefined;
  const fetcher: Fetch = (_url, init) =>
    new Promise((_, reject) => {
      seen = init?.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
    });
  const proxy = await connect(httpBackend("http://127.0.0.1:7400", fetcher));
  try {
    const controller = new AbortController();
    const pending = proxy.client
      .callTool({ name: "limitless_feed", arguments: { wait: 45 } }, undefined, { signal: controller.signal })
      .catch(() => "cancelled");
    await Bun.sleep(20);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(await pending).toBe("cancelled");
    await Bun.sleep(20);
    expect(seen?.aborted).toBe(true);
  } finally {
    await proxy.close();
  }
});
