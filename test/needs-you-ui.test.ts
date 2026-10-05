import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "solid-js/web";
import type { Question, Run, RunDetail, StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { normalizePr } from "../src/integrations/github-poller.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { deferred } from "./evals-support.ts";
import { prNode } from "./github-poller-support.ts";
import { fixture as httpFixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { buildNeedsYouUi, type NeedsYouUi } from "./needs-you-ui-support.ts";
import { waitClock } from "./wait-clock.ts";

const dir = mkdtempSync(join(tmpdir(), "limitless-needs-you-ui-"));
const store = new Store(":memory:");
const repo = store.upsertRepo({
  slug: "owner/repo",
  kind: "github",
  url: "unused",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
});
const run = store.createRun(repo, { repo: repo.slug, prompt: "Stopped work" });
store.updateRun(run.id, {
  status: "needs_human",
  stage: "review",
  error: "Still blocking after review\nLong feedback hidden from the reason",
  branch: "limitless/stopped",
  prUrl: "https://github.com/owner/repo/pull/1",
});
store.finishStage(store.startStage(run.id, "review").id, "failed", "Still blocking after review");
store.putArtifact(
  run.id,
  "review-1.json",
  "review",
  JSON.stringify({ blocking: [{ title: "Old blocker" }] }),
);
store.putArtifact(
  run.id,
  "review-2.json",
  "review",
  JSON.stringify({
    blocking: [{ title: "Missing cancellation" }, { title: "Wrong result" }],
    findings: [{ title: "Nonblocking nit" }],
  }),
);
// Deterministic saved ordering, including a later shadow artifact which is not the primary review.
store.db.query("UPDATE artifacts SET created_at = ? WHERE name = ?").run(1, "review-1.json");
store.db.query("UPDATE artifacts SET created_at = ? WHERE name = ?").run(2, "review-2.json");
store.putArtifact(
  run.id,
  "review-shadow-3.json",
  "review-shadow",
  JSON.stringify({ blocking: [{ title: "Shadow blocker" }] }),
);
store.saveGithubPr({
  url: "https://github.com/owner/repo/pull/1",
  repo: repo.slug,
  runId: run.id,
  nodeId: "PR_1",
  delivered: 1,
  data: JSON.stringify({
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    isDraft: true,
    mergeable: "CONFLICTING",
    ci: "FAILURE",
  }),
});
const detail =
  store.getRunDetail(run.id) ??
  (() => {
    throw new Error("missing fixture");
  })();
detail.worktreePath = "/work/stopped";

let ui: NeedsYouUi;
beforeAll(async () => {
  ui = await buildNeedsYouUi(dir);
});
afterAll(() => {
  ui.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const render = () => renderToString(() => ui.render());
const invoke = async (key: string, value?: string) => {
  const handler = ui.handlers.get(key);
  if (!handler) throw new Error(`missing rendered ${key} handler`);
  await handler(value === undefined ? undefined : { currentTarget: { value } });
};

test("run detail displays the persisted experiment chains", () => {
  ui.mount({
    ...detail,
    run: {
      ...detail.run,
      models: { implement: ["codex/sol@high", "claude/opus"], review: ["claude/opus|codex/sol"] },
    },
  });
  const html = render();
  expect(html).toContain("Model experiment");
  expect(html).toContain("codex/sol@high, claude/opus");
  expect(html).toContain("claude/opus|codex/sol");
});

test("needs-you and failed panels render the latest recorded blockers and observed PR", () => {
  for (const status of ["needs_human", "failed"] as const) {
    ui.mount({ ...detail, run: { ...detail.run, status } });
    const html = render();
    expect(html).toContain('aria-label="Needs you"');
    expect(html).toContain("review · Still blocking after review");
    expect(html).not.toContain("Long feedback hidden");
    expect(html).toContain("Missing cancellation");
    expect(html).toContain("Wrong result");
    for (const omitted of ["Old blocker", "Shadow blocker", "Nonblocking nit"])
      expect(html).not.toContain(omitted);
    expect(html).toContain('href="https://github.com/owner/repo/pull/1"');
    expect(html).toContain("OPEN · draft · CONFLICTING");
    expect(html).toContain("CI: FAILURE");
    expect(html).toContain("Retry — start a new run");
    expect(html).toContain("/work/stopped\nlimitless/stopped");
  }
});

test("sparse and malformed stored details omit unavailable information", () => {
  ui.mount({
    run: { ...detail.run, error: null, stage: null, prUrl: null, branch: null },
    stages: [],
    invocations: [],
    questions: [],
    artifacts: [],
  });
  const html = render();
  expect(html).toContain('aria-label="Needs you"');
  expect(html).toContain("Resolve");
  for (const absent of ["Copy path", "Take over", "Observed:", "undefined", "null"])
    expect(html).not.toContain(absent);
  store.putArtifact(run.id, "review-3.json", "review", "not json");
  expect(store.getRunDetail(run.id)?.blockingFindings).toEqual([]);
});

test("resolve posts selected fields, shows API errors and the returned resolution; retry and takeover work", async () => {
  const oldFetch = globalThis.fetch;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copied: string[] = [];
  const requests: { path: string; method?: string; body: unknown }[] = [];
  let fail = true;
  const resolved: Run = {
    ...detail.run,
    status: "resolved",
    resolution: { kind: "superseded", ref: "replacement", note: "Handled elsewhere", by: "human", at: 42 },
  };
  globalThis.fetch = (async (path, init) => {
    requests.push({
      path: String(path),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (fail) return Response.json({ error: "Run is still active" }, { status: 409 });
    return Response.json(String(path).endsWith("/retry") ? { ...detail.run, id: "new-run" } : resolved);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    },
  });
  try {
    ui.mount(detail);
    render();
    await invoke("kind", "superseded");
    await invoke("ref", "replacement");
    await invoke("note", "Handled elsewhere");
    await invoke("resolve");
    expect(requests[0]).toEqual({
      path: `/api/runs/${run.id}/resolve`,
      method: "POST",
      body: { kind: "superseded", ref: "replacement", note: "Handled elsewhere" },
    });
    expect(render()).toContain("Run is still active");
    expect(render()).toContain('aria-label="Needs you"');
    fail = false;
    await invoke("copy");
    expect(copied).toEqual(["/work/stopped\nlimitless/stopped"]);
    await invoke("retry");
    expect(ui.navigated).toEqual(["/runs/new-run"]);
    await invoke("resolve");
    const html = render();
    for (const value of ["superseded", "replacement", "Handled elsewhere"]) expect(html).toContain(value);
    for (const action of ["Resolve</button>", "Retry", "Take over", "Run is still active"])
      expect(html).not.toContain(action);
    expect(ui.handlers.size).toBe(0);
    ui.mount(detail);
    render();
    await invoke("kind", "wont_do");
    await invoke("resolve");
    expect(requests.at(-1)?.body).toEqual({ kind: "wont_do" });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("run-detail HTTP returns only existing configured worktrees and retains saved draft observations", async () => {
  const f = await httpFixture();
  try {
    const repo = f.factory.store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const stopped = f.factory.store.createRun(repo, { repo: repo.slug, prompt: "Stopped" });
    const read = createHttpRoutes(f.factory)["/api/runs/:id"] as Route;
    const request = (id = stopped.id) =>
      requestWithParams(`http://localhost:7400/api/runs/${id}`, undefined, { id });
    const missing = await read(request("missing"), localServer);
    expect(missing.status).toBe(404);
    f.factory.store.updateRun(stopped.id, {
      branch: "limitless/stopped",
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect((await (await read(request(), localServer)).json()).worktreePath).toBeNull();
    const path = join(f.factory.cfg.paths.work, stopped.id);
    mkdirSync(path, { recursive: true });
    const snapshot = normalizePr({ ...prNode(repo.slug, 1), isDraft: true });
    if (!snapshot) throw new Error("missing PR snapshot");
    f.factory.store.saveGithubPr({
      url: snapshot.url,
      repo: repo.slug,
      runId: stopped.id,
      nodeId: snapshot.id,
      delivered: 1,
      data: JSON.stringify(snapshot),
    });
    const saved = (await (await read(request(), localServer)).json()) as RunDetail;
    expect(saved.worktreePath).toBe(path);
    expect(saved.prSnapshot?.isDraft).toBe(true);
    f.factory.store.db.query("UPDATE runs SET branch = NULL WHERE id = ?").run(stopped.id);
    expect((await (await read(request(), localServer)).json()).worktreePath).toBeNull();
  } finally {
    await f.close();
  }
});

class TestEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  emit(message: StreamMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
async function withStream(
  read: (request: number) => Promise<Response>,
  check: (context: {
    stream: TestEventSource;
    clock: ReturnType<typeof waitClock>;
    requests: () => number;
  }) => Promise<void>,
  initiallyEmpty = false,
  resolved?: Run,
) {
  const oldFetch = globalThis.fetch;
  const oldSource = globalThis.EventSource;
  const clock = waitClock();
  let stream = new TestEventSource();
  let requests = 0;
  globalThis.fetch = (async (path, init) => {
    if (resolved && String(path).endsWith("/resolve")) {
      expect(init?.method).toBe("POST");
      return Response.json(resolved);
    }
    expect(String(path)).toBe(`/api/runs/${run.id}`);
    return read(++requests);
  }) as typeof fetch;
  globalThis.EventSource = class extends TestEventSource {
    constructor(url: string) {
      super();
      expect(url).toBe(`/api/runs/${run.id}/stream?after=0`);
      stream = this;
    }
  } as unknown as typeof EventSource;
  ui.setTimers({ set: clock.timer.set as typeof setTimeout, clear: clock.timer.clear });
  try {
    ui.mount(detail, initiallyEmpty);
    ui.start();
    await clock.flush();
    await check({ stream, clock, requests: () => requests });
  } finally {
    ui.dispose();
    expect(stream.closed).toBe(true);
    expect(clock.pending).toBe(0);
    ui.setTimers({ set: globalThis.setTimeout, clear: globalThis.clearTimeout });
    globalThis.fetch = oldFetch;
    globalThis.EventSource = oldSource;
  }
}
const observation = (runId = run.id): StreamMessage => ({
  kind: "feed",
  item: {
    id: 1,
    ts: 1,
    kind: "pr.ci_passed",
    runId,
    evalId: null,
    repo: repo.slug,
    title: "CI passed",
    summary: "Checks are green",
    data: {},
  },
});
const newerDetail: RunDetail = {
  ...detail,
  blockingFindings: ["Current finding"],
  prSnapshot: { ...detail.prSnapshot, ci: "SUCCESS" },
  artifacts: [{ name: "current.json", kind: "review", size: 1, createdAt: 1 }],
};

test.each(["resolution", "SSE", "resolution and SSE"])(
  "%s invalidates a pending detail read before the debounced refresh starts",
  async (update) => {
    const obsolete = deferred<Response>();
    const resolved: Run = {
      ...detail.run,
      status: "resolved",
      resolution: { kind: "done_elsewhere", by: "human", at: 42, ref: null, note: "Handled" },
    };
    await withStream(
      async (request) =>
        request === 1
          ? Response.json(detail)
          : request === 2
            ? obsolete.promise
            : Response.json({ ...newerDetail, run: { ...resolved, title: "Current resolved run" } }),
      async ({ stream, clock, requests }) => {
        stream.emit(observation());
        await clock.advance(100);
        expect(requests()).toBe(2);
        render();
        if (update.includes("resolution")) await invoke("resolve");
        if (update.includes("SSE")) stream.emit({ kind: "run", run: resolved });
        expect(render()).toContain("Handled");
        obsolete.resolve(Response.json(detail));
        await clock.flush();
        expect(requests()).toBe(2);
        const html = render();
        expect(html).toContain("Handled");
        for (const action of ['aria-label="Needs you"', "Resolve</button>", "Retry"])
          expect(html).not.toContain(action);
        expect(ui.handlers.has("resolve")).toBe(false);
        expect(ui.handlers.has("retry")).toBe(false);
        expect(html).not.toContain("current.json");
        if (update.includes("SSE")) {
          await clock.advance(99);
          expect(requests()).toBe(2);
          await clock.advance(1);
          expect(requests()).toBe(3);
          expect(render()).toContain("Current resolved run");
          expect(render()).toContain("current.json");
          expect(render()).toContain("Handled");
          expect(render()).not.toContain('aria-label="Needs you"');
        }
      },
      false,
      resolved,
    );
  },
);

test("newest-first detail responses guard initial hydration, observations and artifacts", async () => {
  const initial = deferred<Response>();
  const refresh = deferred<Response>();
  await withStream(
    (request) => (request === 1 ? initial.promise : refresh.promise),
    async ({ stream, clock, requests }) => {
      expect(requests()).toBe(1);
      stream.emit({ kind: "run", run: detail.run });
      await clock.advance(100);
      expect(requests()).toBe(2);
      refresh.resolve(Response.json(newerDetail));
      await clock.flush();
      expect(render()).toContain("Current finding");
      initial.resolve(Response.json(detail));
      await clock.flush();
      const html = render();
      for (const current of ["Current finding", "CI: SUCCESS", "current.json"])
        expect(html).toContain(current);
      for (const obsolete of ["Missing cancellation", "Wrong result", "CI: FAILURE", "review-1.json"])
        expect(html).not.toContain(obsolete);
    },
    true,
  );
});

test("overlapping later refreshes cannot replace newer findings or CI", async () => {
  const obsolete = deferred<Response>();
  const latest = deferred<Response>();
  await withStream(
    (request) =>
      request === 1
        ? Promise.resolve(Response.json(detail))
        : request === 2
          ? obsolete.promise
          : latest.promise,
    async ({ stream, clock, requests }) => {
      stream.emit(observation());
      await clock.advance(100);
      stream.emit(observation());
      await clock.advance(100);
      expect(requests()).toBe(3);
      latest.resolve(Response.json(newerDetail));
      await clock.flush();
      obsolete.resolve(Response.json(detail));
      await clock.flush();
      expect(render()).toContain("Current finding");
      expect(render()).toContain("CI: SUCCESS");
      expect(render()).not.toContain("CI: FAILURE");
    },
  );
});

test("newer requests suppress stale errors and recover from an initial detail failure", async () => {
  const stale = deferred<Response>();
  await withStream(
    (request) => (request === 1 ? stale.promise : Promise.resolve(Response.json(newerDetail))),
    async ({ stream, clock }) => {
      stream.emit(observation());
      await clock.advance(100);
      stale.resolve(Response.json({ error: "Obsolete failure" }, { status: 500 }));
      await clock.flush();
      expect(render()).toContain("Current finding");
      expect(render()).not.toContain("Obsolete failure");
    },
  );
  await withStream(
    async (request) =>
      request === 1 ? Response.json({ error: "Disconnected" }, { status: 500 }) : Response.json(newerDetail),
    async ({ stream, clock }) => {
      expect(render()).toContain("Disconnected");
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      expect(render()).toContain("CI: SUCCESS");
      expect(render()).not.toContain("Disconnected");
    },
    true,
  );
});

test("run and run-linked feed bursts refresh once; unrelated runs do not refresh", async () => {
  await withStream(
    async (request) => Response.json(request === 1 ? detail : newerDetail),
    async ({ stream, clock, requests }) => {
      stream.onopen?.();
      await clock.advance(100);
      expect(requests()).toBe(1);
      stream.emit({ kind: "run", run: { ...detail.run, id: "another-run" } });
      stream.emit(observation("another-run"));
      stream.emit(observation(""));
      await clock.advance(100);
      expect(requests()).toBe(1);
      stream.emit({ kind: "run", run: detail.run });
      await clock.advance(99);
      expect(requests()).toBe(1);
      await clock.advance(1);
      expect(requests()).toBe(2);
      expect(render()).toContain("Current finding");
      stream.emit(observation());
      await clock.advance(50);
      stream.emit({ kind: "run", run: detail.run });
      stream.emit(observation());
      await clock.advance(99);
      expect(requests()).toBe(2);
      await clock.advance(1);
      expect(requests()).toBe(3);
      await clock.advance(100);
      expect(requests()).toBe(3);
    },
  );
});

test("reconnect refreshes saved observations once and coalesces simultaneous updates", async () => {
  let saved = detail;
  await withStream(
    async () => Response.json(saved),
    async ({ stream, clock, requests }) => {
      stream.onopen?.();
      stream.onerror?.();
      saved = newerDetail;
      await clock.advance(100);
      expect(requests()).toBe(1);
      expect(render()).toContain("CI: FAILURE");
      stream.onopen?.();
      await clock.advance(99);
      expect(requests()).toBe(1);
      await clock.advance(1);
      expect(requests()).toBe(2);
      expect(render()).toContain("CI: SUCCESS");
      expect(render()).toContain("Current finding");
      stream.onerror?.();
      stream.onopen?.();
      stream.emit(observation());
      stream.emit({ kind: "run", run: detail.run });
      await clock.advance(100);
      expect(requests()).toBe(3);
      stream.emit(observation());
      ui.dispose();
      await clock.advance(100);
      expect(requests()).toBe(3);
    },
  );
});

test("stopping evidence prefers the latest failed stage, falls back to retained blockers and omits unknown", () => {
  const stopped = store.createRun(repo, { repo: repo.slug, prompt: "Evidence" });
  store.updateRun(stopped.id, { status: "needs_human", stage: "deliver", error: "Needs work" });
  const read = () => {
    const saved = store.getRunDetail(stopped.id);
    if (!saved) throw new Error("missing stopped run");
    ui.mount(saved);
    return render();
  };
  expect(read()).not.toContain("deliver · Needs work");
  for (const [state, expected] of [
    [{ lastGates: [{ blocking: true }] }, "gates"],
    [{ lastAudit: [{ severity: "block" }] }, "audit"],
    [{ lastReview: { verdict: "request_changes" } }, "review"],
    [{ lastVerify: { overall: "fail" } }, "verify"],
  ] as const) {
    store.setRunState(stopped.id, state);
    expect(read()).toContain(`${expected} · Needs work`);
  }
  store.setRunState(stopped.id, {
    lastVerify: { overall: "fail" },
    lastReview: { verdict: "request_changes" },
  });
  store.finishStage(store.startStage(stopped.id, "verify").id, "succeeded");
  store.finishStage(store.startStage(stopped.id, "review", 1).id, "succeeded");
  store.finishStage(store.startStage(stopped.id, "deliver").id, "succeeded");
  expect(read()).toContain("review · Needs work");
  store.finishStage(store.startStage(stopped.id, "gates", 2).id, "succeeded");
  store.setRunState(stopped.id, {
    lastReview: { verdict: "request_changes" },
    lastGates: [{ blocking: true }],
  });
  expect(read()).toContain("gates · Needs work");
  store.finishStage(store.startStage(stopped.id, "implement").id, "failed");
  store.finishStage(store.startStage(stopped.id, "review").id, "failed");
  store.finishStage(store.startStage(stopped.id, "deliver").id, "succeeded");
  expect(read()).toContain("review · Needs work");
  store.finishStage(store.startStage(stopped.id, "deliver").id, "failed", "Draft PR rejected");
  expect(read()).toContain("review · Needs work");
  expect(read()).not.toContain("deliver · Needs work");
});

test("failed draft delivery falls back to retained blockers; original delivery failures remain evidence", () => {
  const stopped = store.createRun(repo, { repo: repo.slug, prompt: "Draft failed" });
  store.updateRun(stopped.id, { status: "needs_human", stage: "deliver", error: "Needs work" });
  store.finishStage(store.startStage(stopped.id, "review").id, "succeeded");
  store.finishStage(store.startStage(stopped.id, "deliver").id, "failed", "Draft PR rejected");
  store.setRunState(stopped.id, { lastReview: { verdict: "request_changes" } });
  const read = () => {
    const saved = store.getRunDetail(stopped.id);
    if (!saved) throw new Error("missing stopped run");
    ui.mount(saved);
    return render();
  };
  expect(read()).toContain("review · Needs work");
  store.setRunState(stopped.id, {});
  expect(read()).not.toContain("deliver · Needs work");
  // Delivery can itself be the original failure, even with old review blockers retained.
  const error = `Delivery rejected: ${"x".repeat(600)}`;
  store.updateRun(stopped.id, { error });
  store.setRunState(stopped.id, { lastReview: { verdict: "request_changes" } });
  store.finishStage(store.startStage(stopped.id, "deliver", 1).id, "failed", error.slice(0, 500));
  expect(read()).toContain("deliver · Delivery rejected:");
  store.finishStage(store.startStage(stopped.id, "deliver", 2).id, "failed", "Draft PR rejected");
  expect(read()).toContain("deliver · Delivery rejected:");
  store.finishStage(store.startStage(stopped.id, "deliver", 3).id, "succeeded");
  expect(read()).toContain("review · Delivery rejected:");
});

test.each([
  { reviewFirst: false, recovered: false, expected: "review" },
  { reviewFirst: true, recovered: false, expected: "implement" },
  { reviewFirst: true, recovered: true, expected: "review" },
  { reviewFirst: false, recovered: true, expected: null },
])("stopping evidence uses applicable attempt order: %j", ({ reviewFirst, recovered, expected }) => {
  const stopped = store.createRun(repo, { repo: repo.slug, prompt: "Recovered failure" });
  store.updateRun(stopped.id, { status: "needs_human", stage: "deliver", error: "Needs work" });
  const blockReview = () => {
    store.finishStage(store.startStage(stopped.id, "review").id, "succeeded");
    store.setRunState(stopped.id, { lastReview: { verdict: "request_changes" } });
  };
  if (reviewFirst) blockReview();
  store.finishStage(store.startStage(stopped.id, "implement").id, "failed", "Implement interrupted");
  if (recovered) store.finishStage(store.startStage(stopped.id, "implement", 1).id, "succeeded");
  else if (!reviewFirst) blockReview();
  store.finishStage(store.startStage(stopped.id, "deliver").id, "failed", "Draft PR rejected");
  const saved = store.getRunDetail(stopped.id);
  if (!saved) throw new Error("missing stopping evidence");
  expect(saved.stoppingStage).toBe(expected);
  ui.mount(saved);
  const html = render();
  if (expected) expect(html).toContain(`${expected} · Needs work`);
  else expect(html).not.toContain("implement · Needs work");
  expect(html).not.toContain("deliver · Needs work");
});

test("per-run SSE forwards committed GitHub observations only for the displayed run", async () => {
  const f = await httpFixture();
  const controller = new AbortController();
  try {
    const store = f.factory.store;
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const target = store.createRun(repo, { repo: repo.slug, prompt: "target" });
    const other = store.createRun(repo, { repo: repo.slug, prompt: "other" });
    const route = createHttpRoutes(f.factory)["/api/runs/:id/stream"] as Route;
    const response = await route(
      requestWithParams(
        `http://localhost:7400/api/runs/${target.id}/stream`,
        { signal: controller.signal },
        { id: target.id },
      ),
      localServer,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    store.saveGithubPr(null, false, [
      {
        kind: "pr.comment",
        runId: other.id,
        repo: repo.slug,
        summary: "Other run",
        data: {},
        key: "other",
      },
      {
        kind: "pr.ci_passed",
        runId: target.id,
        repo: repo.slug,
        summary: "CI recovered",
        data: {},
        key: "target",
      },
    ]);
    const frame = decoder.decode((await reader.read()).value);
    expect(JSON.parse(frame.slice(6))).toMatchObject({
      kind: "feed",
      item: { runId: target.id, kind: "pr.ci_passed", summary: "CI recovered" },
    });
  } finally {
    controller.abort();
    await f.close();
  }
});

test("a resolution that arrives after its SSE update still refreshes the run's details", async () => {
  const refresh = deferred<Response>();
  const post = deferred<Response>();
  const resolved: Run = {
    ...detail.run,
    status: "resolved",
    resolution: { kind: "done_elsewhere", by: "human", at: 42, ref: null, note: "Handled" },
  };
  await withStream(
    async (request) =>
      request === 1
        ? Response.json(detail)
        : request === 2
          ? refresh.promise
          : Response.json({ ...newerDetail, run: resolved }),
    async ({ stream, clock, requests }) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (path, init) =>
        String(path).endsWith("/resolve") ? post.promise : originalFetch(path, init)) as typeof fetch;
      try {
        render();
        const resolving = invoke("resolve");
        stream.emit({ kind: "run", run: resolved });
        await clock.advance(100);
        expect(requests()).toBe(2);
        // The POST settles after the SSE-triggered read started; that read is now stale.
        post.resolve(Response.json(resolved));
        await resolving;
        refresh.resolve(Response.json({ ...newerDetail, run: resolved }));
        await clock.flush();
        await clock.advance(1000);
        const html = render();
        expect(html).toContain("Handled");
        expect(html).not.toContain('aria-label="Needs you"');
        expect(html).toContain("current.json");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test("a pushed update beats an older read in flight, and the next read after a gap replaces it", async () => {
  const asked: Question = {
    id: 1,
    runId: run.id,
    question: "Which database should it use?",
    answer: null,
    askedAt: 1,
    answeredAt: null,
    answeredBy: null,
  };
  const stage = detail.stages[0];
  if (!stage) throw new Error("missing fixture stage");
  const other = store.createRun(repo, { repo: repo.slug, prompt: "Invocation source" });
  const running = {
    ...store.createInvocation({
      runId: other.id,
      stageId: null,
      role: "implement",
      harness: "fake",
      provider: "fake",
      model: "test",
      modelId: "fake/test",
    }),
    runId: run.id,
  };
  const stale = deferred<Response>();
  await withStream(
    (request) =>
      request === 2
        ? stale.promise
        : Promise.resolve(
            Response.json(request === 1 ? { ...detail, questions: [asked], invocations: [running] } : detail),
          ),
    async ({ stream, clock, requests }) => {
      expect(render()).toContain(asked.question);
      expect(render()).toContain(">running</span>");
      stream.onopen?.();
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      expect(requests()).toBe(2);
      stream.emit({ kind: "question", question: { ...asked, answer: "Postgres", answeredAt: 2 } });
      stream.emit({ kind: "invocation", invocation: { ...running, status: "ok" } });
      stream.emit({ kind: "stage", stage: { ...stage, status: "succeeded" } });
      expect(render()).not.toContain(asked.question);
      expect(render()).toContain(">ok</span>");
      stale.resolve(Response.json({ ...detail, questions: [asked], invocations: [running] }));
      await clock.flush();
      expect(render()).not.toContain(asked.question);
      expect(render()).not.toContain(">running</span>");
      expect(render()).toContain("timeline-bar succeeded");

      stream.emit({ kind: "stage", stage: { ...stage, status: "running" } });
      expect(render()).toContain("timeline-bar running");
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      expect(requests()).toBe(3);
      expect(render()).toContain(`timeline-bar ${stage.status}`);
      expect(render()).not.toContain("timeline-bar running");
    },
  );
});

test("an older reconnect read cannot erase a newer artifact refresh", async () => {
  const reconnectRead = deferred<Response>();
  const finished = detail.stages[0];
  if (!finished) throw new Error("missing fixture stage");
  await withStream(
    async (request) =>
      request === 1
        ? Response.json(detail)
        : request === 2
          ? reconnectRead.promise
          : Response.json(newerDetail),
    async ({ stream, clock, requests }) => {
      stream.onopen?.();
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      stream.emit({ kind: "stage", stage: finished });
      await clock.advance(100);
      expect(requests()).toBe(3);
      expect(render()).toContain("current.json");
      reconnectRead.resolve(Response.json(detail));
      await clock.flush();
      expect(render()).toContain("current.json");
      expect(render()).not.toContain("review-1.json");
    },
  );
});

test("reconnect reads are single-flight: flapping adds one read and one follow-up; an early error adds none", async () => {
  const inFlight = deferred<Response>();
  await withStream(
    (request) => (request === 2 ? inFlight.promise : Promise.resolve(Response.json(detail))),
    async ({ stream, clock, requests }) => {
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(1000);
      expect(requests()).toBe(1);
      for (let flap = 0; flap < 100; flap++) {
        stream.onerror?.();
        stream.onopen?.();
        await clock.advance(100);
      }
      expect(requests()).toBe(2);
      inFlight.resolve(Response.json(detail));
      await clock.flush();
      await clock.advance(100);
      expect(requests()).toBe(3);
      await clock.advance(1000);
      expect(requests()).toBe(3);
    },
  );
});

test("a stalled, superseded read does not hold back the reconnect refresh", async () => {
  const stalled = deferred<Response>();
  await withStream(
    (request) => (request === 1 ? stalled.promise : Promise.resolve(Response.json(newerDetail))),
    async ({ stream, clock, requests }) => {
      stream.onopen?.();
      stream.emit(observation());
      await clock.advance(100);
      expect(requests()).toBe(2);
      expect(render()).toContain("Current finding");
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      expect(requests()).toBe(3);
      await clock.advance(1000);
      expect(requests()).toBe(3);
      stalled.resolve(Response.json(detail));
      await clock.flush();
      await clock.advance(1000);
      expect(requests()).toBe(3);
      expect(render()).toContain("Current finding");
    },
    true,
  );
});

test("only the current read holds back a reconnect refresh: older reads settling or a newer generation release nothing extra", async () => {
  const stalled = deferred<Response>();
  const current = deferred<Response>();
  await withStream(
    (request) =>
      request === 1
        ? stalled.promise
        : request === 2
          ? current.promise
          : Promise.resolve(Response.json(newerDetail)),
    async ({ stream, clock, requests }) => {
      stream.onopen?.();
      stream.emit(observation());
      await clock.advance(100);
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      expect(requests()).toBe(2);
      // The superseded read settling first must not start the follow-up early.
      stalled.resolve(Response.json(detail));
      await clock.flush();
      await clock.advance(100);
      expect(requests()).toBe(2);
      current.resolve(Response.json(newerDetail));
      await clock.flush();
      await clock.advance(100);
      expect(requests()).toBe(3);
    },
    true,
  );
  const superseded = deferred<Response>();
  await withStream(
    (request) => (request === 1 ? superseded.promise : Promise.resolve(Response.json(newerDetail))),
    async ({ stream, clock, requests }) => {
      stream.onopen?.();
      // A run update supersedes the stalled read; a reconnect right after needs only the one read.
      stream.emit({ kind: "run", run: detail.run });
      stream.onerror?.();
      stream.onopen?.();
      await clock.advance(100);
      expect(requests()).toBe(2);
      await clock.advance(1000);
      expect(requests()).toBe(2);
      superseded.resolve(Response.json(detail));
      await clock.flush();
      await clock.advance(1000);
      expect(requests()).toBe(2);
    },
    true,
  );
});
