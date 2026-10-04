import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { Run, RunDetail } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { normalizePr } from "../src/integrations/github-poller.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { prNode } from "./github-poller-support.ts";
import { fixture as httpFixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
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
const detail = store.getRunDetail(run.id);
if (!detail) throw new Error("missing fixture");
detail.worktreePath = "/work/stopped";

type Handler = (event?: { currentTarget: { value: string } }) => void | Promise<void>;
let ui: {
  mount: (detail: RunDetail) => void;
  render: () => ReturnType<typeof renderToString>;
  handlers: Map<string, Handler>;
  navigated: string[];
};
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../ui/pages/RunDetail.tsx")],
    outdir: dir,
    target: "bun",
    plugins: [
      {
        name: "needs-you-ssr-events",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
            let source = await Bun.file(args.path).text();
            if (args.path.endsWith("/RunDetail.tsx")) {
              source = source.replace(
                'import { useNavigate, useParams } from "@solidjs/router";',
                "const useNavigate = () => (path: string) => navigated.push(path); const useParams = <T,>(): T => ({ id: fixture.run.id }) as T;",
              );
              source = source.replace(
                "createSignal<Run | null>(null)",
                "createSignal<Run | null>(fixture.run)",
              );
              source = source.replace(
                "createSignal<Detail | null>(null)",
                "createSignal<Detail | null>(fixture)",
              );
              // Keep a render closure so interaction handlers and the next render share the same signals.
              source = source.replace(
                '  return (\n    <div class="page stack">',
                '  const render = () => (\n    <div class="page stack">',
              );
              source = source.replace(
                /\n {2}\);\n};\s*$/,
                "\n  );\n  activeRender = render; return render();\n};",
              );
              for (const action of ["retry", "resolve", "copy"]) {
                source = source.replace(
                  `onClick={() => doAction("${action}")}`,
                  `{...capture("${action}", () => doAction("${action}"))}`,
                );
              }
              source = source.replace(
                "onChange={(e) => setKind(e.currentTarget.value as Kind)}",
                '{...capture("kind", (e: { currentTarget: { value: Kind } }) => setKind(e.currentTarget.value))}',
              );
              for (const field of ["ref", "note"]) {
                const setter = field === "ref" ? "setRef" : "setNote";
                source = source.replace(
                  `onInput={(e) => ${setter}(e.currentTarget.value)}`,
                  `{...capture("${field}", (e: { currentTarget: { value: string } }) => ${setter}(e.currentTarget.value))}`,
                );
              }
              source += `
              let fixture: Detail;
              let activeRender: () => ReturnType<typeof RunDetail>;
              export const handlers = new Map();
              export const navigated: string[] = [];
              const capture = (key: string, handler: unknown) => { handlers.set(key, handler); return {}; };
              export const mount = (detail: Detail) => { fixture = detail; navigated.length = 0; RunDetail({}); };
              export const render = () => { handlers.clear(); return activeRender(); };
            `;
            }
            const transformed = await transformAsync(source, {
              filename: args.path,
              parserOpts: { plugins: ["jsx", "typescript"] },
              presets: [
                [solid, { generate: "ssr" }],
                [ts, {}],
              ],
            });
            return { contents: transformed?.code ?? "", loader: "js" };
          });
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  ui = await import(join(dir, "RunDetail.js"));
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const render = () => renderToString(() => ui.render());
const invoke = async (key: string, value?: string) => {
  const handler = ui.handlers.get(key);
  if (!handler) throw new Error(`missing rendered ${key} handler`);
  await handler(value === undefined ? undefined : { currentTarget: { value } });
};

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
