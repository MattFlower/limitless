import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { customModel } from "./provider-config-support.ts";

let dir: string;
let factory: Factory;
let calls: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-routing-http-"));
  const overlay = join(dir, "policy.json");
  writeFileSync(overlay, JSON.stringify({ triage: { default: ["claude/opus"] } }));
  const cfg = loadConfig({ home: dir, configDir: dir, port: 7400 });
  cfg.preferProviders = ["claude"];
  cfg.secrets.OMLX_API_KEY = "fake-key";
  calls = [];
  const harness = fakeHarness((spec) => {
    calls.push(spec.target.modelId);
    return { text: "ok" };
  });
  factory = new Factory(cfg, {
    store: new Store(":memory:"),
    policyPath: overlay,
    harnesses: { claude: harness, codex: harness, llm: harness },
    healthFetch: (async (_url: Parameters<typeof fetch>[0]) =>
      Response.json({ data: [{ id: "org/backend" }, { id: "uncataloged" }] })) as typeof fetch,
  });
});
afterEach(() => {
  factory.store.close();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const routes = createHttpRoutes(factory);
  return (
    path: string,
    method = "GET",
    input?: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
    server = localServer,
  ) => {
    const parts = path.split("/");
    const key = path.startsWith("/api/routing/cells/")
      ? "/api/routing/cells/:role/:cell"
      : path.startsWith("/api/catalog/models/")
        ? "/api/catalog/models/:id"
        : (path.split("?")[0] ?? "");
    const entry = routes[key];
    const route = typeof entry === "function" ? entry : (entry as Record<string, Route>)[method];
    return (route as Route)(
      requestWithParams(
        `http://localhost:7400${path}`,
        {
          method,
          headers,
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        },
        { role: parts[4] ?? "", cell: parts[5] ?? "", id: decodeURIComponent(parts[4] ?? "") },
      ),
      server,
    );
  };
}

test("catalog API adds, patches, validates live policy, blocks referenced deletion and streams changes", async () => {
  const call = client();
  const response = await call("/api/stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing stream");
  await reader.read();
  const input = { ...customModel, provider: "codex", id: "experiment", model: "new-build" };
  const path = "/api/catalog/models/codex%2Fexperiment";
  try {
    expect((await call("/api/catalog/models", "POST", input)).status).toBe(201);
    let event = "";
    for (let count = 0; count <= factory.tracker.all().length; count++) {
      event = new TextDecoder().decode((await reader.read()).value);
      if (event.includes('"kind":"catalog"')) break;
    }
    expect(event).toContain('"kind":"catalog"');
    expect((await (await call("/api/catalog")).json()).models).toContainEqual(
      expect.objectContaining({
        id: "codex/experiment",
        model: "new-build",
        source: "runtime",
      }),
    );
    expect(factory.router.resolveFor("triage", "codex/experiment@high").model.model).toBe("new-build");
    const repo = factory.store.upsertRepo({
      slug: "runtime/repo",
      kind: "local",
      localPath: dir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = factory.store.createRun(repo, {
      repo: repo.slug,
      prompt: "test",
      models: { triage: ["codex/experiment@high"] },
    });
    const invoke = async (run: ReturnType<Store["createRun"]>) => {
      const context = new RunContext(factory.deps, run, repo, new AbortController().signal);
      return context.invoke({
        role: "triage",
        stage: factory.store.startStage(run.id, "triage", 0),
        prompt: "test",
        mode: "readonly",
        complexity: "small",
      });
    };
    expect((await invoke(run)).target.modelId).toBe("codex/experiment");
    expect(
      factory.router.route("triage", "small", { chain: ["codex/experiment@high"] }).candidates[0]?.modelId,
    ).toBe("codex/experiment");
    factory.routing.setCell("triage", "default", ["codex/experiment@high|claude/opus"]);
    factory.routing.setCell("triage", "small", ["codex/experiment"]);
    expect(factory.router.route("triage", "small").candidates[0]?.modelId).toBe("codex/experiment");
    const live = factory.store.createRun(repo, { repo: repo.slug, prompt: "policy" });
    expect((await invoke(live)).target.modelId).toBe("codex/experiment");
    expect(calls).toEqual(["codex/experiment", "codex/experiment"]);
    const blocked = await call(path, "DELETE");
    expect(blocked.status).toBe(400);
    const error = (await blocked.json()).error;
    expect(error).toContain("triage.default");
    expect(error).toContain("triage.small");
    const before = factory.store.runtimeModels();
    expect((await call(path, "PATCH", { efforts: ["none"] })).status).toBe(400);
    expect(factory.store.runtimeModels()).toEqual(before);
    expect((await call(path, "PATCH", { model: "updated-build", price: { input: 1 } })).status).toBe(200);
    expect(factory.router.resolveFor("triage", "codex/experiment").model).toMatchObject({
      model: "updated-build",
      price: { input: 1, output: 0 },
    });
    factory.routing.setCell("triage", "default", null);
    factory.routing.setCell("triage", "small", null);
    expect((await call(path, "DELETE")).status).toBe(200);
    expect(factory.store.runtimeModels()).toEqual([]);
    const deleted = factory.router.route("triage", "small", { chain: ["codex/experiment"] });
    expect(deleted.candidates).toEqual([]);
    expect(deleted.skipped[0]?.reason).toContain('unknown model ID "codex/experiment"');
    await expect(invoke(run)).rejects.toThrow('unknown model ID "codex/experiment"');
    expect(factory.store.listInvocations(run.id)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  } finally {
    await reader.cancel();
  }
});

test("catalog discovery API differences and pinned stale targets make no invocation attempt", async () => {
  const call = client();
  expect(
    (await call("/api/catalog/models", "POST", { ...customModel, provider: "omlx", id: "experiment" }))
      .status,
  ).toBe(201);
  await factory.tracker.probe();
  const catalog = await (await call("/api/catalog")).json();
  const discovery = catalog.providers.find((p: { provider: string }) => p.provider === "omlx");
  expect(discovery.servedNotInCatalog).toEqual(["uncataloged"]);
  expect(discovery.catalogNotServed).toContain("omlx/qwen-flash");
  expect(discovery.catalogNotServed).not.toContain("omlx/experiment");
  const repo = factory.store.upsertRepo({
    slug: "discovery/repo",
    kind: "local",
    localPath: dir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, {
    repo: repo.slug,
    prompt: "test",
    models: { triage: ["omlx/qwen-flash", "omlx/experiment"] },
  });
  const context = new RunContext(factory.deps, run, repo, new AbortController().signal);
  const result = await context.invoke({
    role: "triage",
    stage: factory.store.startStage(run.id, "triage", 0),
    prompt: "test",
    mode: "readonly",
    complexity: "small",
  });
  expect(result.target.modelId).toBe("omlx/experiment");
  expect(calls).toEqual(["omlx/experiment"]);
  expect(factory.store.listInvocations(run.id)).toHaveLength(1);
  expect(JSON.stringify(factory.store.listEvents(run.id))).toContain("not served by omlx");
});

test("catalog invalid mutations and code/config edits leave memory and storage unchanged", async () => {
  const call = client();
  const base = { ...customModel, provider: "codex", id: "experiment" };
  const before = factory.models.slice();
  for (const input of [
    { ...base, origin: undefined },
    { ...base, base_origin: undefined },
    { ...base, price: undefined },
    { ...base, id: "bad/id" },
    { ...base, effort: "max" },
    { ...base, provider: "unknown" },
    { ...base, id: "sol" },
    { ...base, source: "code" },
  ]) {
    expect((await call("/api/catalog/models", "POST", input)).status).toBe(400);
    expect(factory.models).toEqual(before);
    expect(factory.store.runtimeModels()).toEqual([]);
  }
  factory.models.push({
    ...factory.models[0],
    id: "codex/configured",
    source: "config",
  } as (typeof factory.models)[number]);
  for (const id of ["codex/sol", "codex/configured"])
    for (const method of ["PATCH", "DELETE"])
      expect(
        (await call(`/api/catalog/models/${encodeURIComponent(id)}`, method, { notes: "changed" })).status,
      ).toBe(400);
  expect((await call("/api/catalog/models", "POST", base)).status).toBe(201);
  const stored = factory.store.runtimeModels();
  for (const patch of [
    { origin: null },
    { id: "bad@id" },
    { id: "sol" },
    { effort: "max" },
    { provider: "missing" },
  ]) {
    expect((await call("/api/catalog/models/codex%2Fexperiment", "PATCH", patch)).status).toBe(400);
    expect(factory.store.runtimeModels()).toEqual(stored);
  }
  expect((await call("/api/catalog/models", "POST", base)).status).toBe(400);
  factory.store.db.exec(
    "CREATE TRIGGER reject_model BEFORE INSERT ON runtime_models BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
  );
  const catalog = factory.models.slice();
  expect((await call("/api/catalog/models", "POST", { ...base, id: "failed" })).status).toBe(400);
  expect(factory.models).toEqual(catalog);
  expect(factory.store.runtimeModels()).toEqual(stored);
});

test("routing API reports provenance, applies cell/prefer edits and resets, and streams each change", async () => {
  const call = client();
  const events: unknown[] = [];
  factory.store.subscribe((message) => events.push(message));
  expect((await (await call("/api/routing")).json()).effective.triage.default.layer).toBe("evals");
  const response = await call("/api/routing/cells/triage/default", "PUT", {
    groups: ["codex/sol@high"],
    note: "depleted",
  });
  expect(response.status).toBe(200);
  expect((await response.json()).effective.triage.default).toEqual({
    groups: ["codex/sol@high"],
    layer: "operator",
    evals: ["claude/opus"],
  });
  const preview = await call("/api/routing/preview?role=triage&complexity=small");
  expect(await preview.json()).toEqual([{ modelId: "codex/sol@high", eligible: true, reason: null }]);
  expect((await call("/api/routing/cells/triage/default", "DELETE")).status).toBe(200);
  expect(factory.router.route("triage", "small").candidates[0]?.modelId).toBe("claude/opus");
  expect((await call("/api/routing/prefer", "PUT", { prefer: ["codex"] })).status).toBe(200);
  expect(factory.routing.prefer).toEqual(["codex"]);
  expect((await call("/api/routing/prefer", "DELETE")).status).toBe(200);
  expect(factory.routing.prefer).toEqual(["claude"]);
  const changes = events.filter((e) => (e as { kind: string }).kind === "routing");
  expect(changes).toHaveLength(4);
  expect(factory.store.routingHistory()).toHaveLength(4);
});

test("run-scoped routing previews and snapshots put chains above code, evals and live operator edits", async () => {
  const call = client();
  const repo = factory.store.upsertRepo({
    slug: "routing/repo",
    kind: "local",
    localPath: dir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const chain = ["codex/luna@low", "claude/opus@high"];
  const run = await factory.createRun({ repo: repo.slug, prompt: "Pinned", models: { triage: chain } });
  const unpinned = await factory.createRun({ repo: repo.slug, prompt: "Unpinned" });
  factory.routing.setCell("triage", "small", ["codex/sol@high"]);
  factory.routing.setPrefer(["claude"]);
  const before = factory.routing.snapshot();
  const preview = await call(`/api/routing/preview?role=triage&complexity=small&run=${run.id}`);
  expect(await preview.json()).toEqual(chain.map((modelId) => ({ modelId, eligible: true, reason: null })));
  const scoped = await (await call(`/api/routing?run=${run.id}`)).json();
  expect(scoped.runId).toBe(run.id);
  for (const cell of ["default", "trivial", "small", "medium", "large"])
    expect(scoped.effective.triage[cell]).toEqual({ groups: chain, layer: "run" });
  expect(scoped.effective.review).toEqual(before.effective.review);
  expect((await (await call(`/api/routing?run=${unpinned.id}`)).json()).effective.triage.small).toEqual({
    groups: ["codex/sol@high"],
    layer: "operator",
  });
  factory.tracker.setEnabled("codex", false);
  expect(await (await call(`/api/routing/preview?role=triage&run=${run.id}`)).json()).toEqual([
    { modelId: chain[0], eligible: false, reason: "disabled" },
    { modelId: chain[1], eligible: true, reason: null },
  ]);
  expect(factory.routing.snapshot()).toEqual(before);
  for (const path of ["/api/routing", "/api/routing/preview?role=triage"])
    expect((await call(`${path}${path.includes("?") ? "&" : "?"}run=missing`)).status).toBe(400);
});

test("routing mutations reject invalid payloads and honor the provider endpoint guards", async () => {
  const call = client();
  for (const path of ["/api/routing/cells/triage/default", "/api/routing/prefer"]) {
    for (const method of ["PUT", "DELETE"]) {
      const value = path.endsWith("prefer") ? { prefer: ["codex"] } : { groups: ["codex/sol"] };
      expect((await call(path, method, value, {})).status).toBe(415);
      expect((await call(path, method, value, { "content-type": "text/plain" })).status).toBe(415);
      expect(
        (
          await call(path, method, value, {
            "content-type": "application/json",
            origin: "https://evil.example",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(path, method, value, {
            "content-type": "application/json",
            "cf-connecting-ip": "1.2.3.4",
          })
        ).status,
      ).toBe(403);
    }
    for (const value of [null, {}, [], { groups: null }, { prefer: null }])
      expect((await call(path, "PUT", value)).status).toBe(400);
  }
  for (const [entry, groups, reason] of [
    ["unknown/default", ["codex/sol"], "unknown.default"],
    ["triage/unknown", ["codex/sol"], "triage.unknown"],
    ["triage/default", [], "triage.default"],
    ["triage/default", ["claude/fable"], "owner decision"],
  ] as const) {
    const response = await call(`/api/routing/cells/${entry}`, "PUT", { groups });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(reason);
  }
  for (const value of [{ prefer: ["codex/sol"] }, { prefer: ["claude/fable"] }, { prefer: ["unknown"] }])
    expect((await call("/api/routing/prefer", "PUT", value)).status).toBe(400);
  expect((await call("/api/routing/preview?role=triage&complexity=default")).status).toBe(400);
  expect((await call("/api/routing/preview?role=unknown&complexity=small")).status).toBe(400);
  expect(factory.routing.snapshot().effective.triage?.default?.layer).toBe("evals");
  expect(factory.store.routingHistory()).toEqual([]);
});

test("the global SSE endpoint sends routing change messages after edits and resets", async () => {
  const call = client();
  const response = await call("/api/stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing stream body");
  const decode = new TextDecoder();
  try {
    expect(decode.decode((await reader.read()).value)).toBe(": connected\n\n");
    for (const method of ["PUT", "DELETE"]) {
      expect(
        (await call("/api/routing/cells/triage/default", method, { groups: ["codex/sol"] })).status,
      ).toBe(200);
      const data = decode.decode((await reader.read()).value);
      expect(JSON.parse(data.slice("data: ".length))).toMatchObject({
        kind: "routing",
        change: { key: "triage.default", newValue: method === "PUT" ? ["codex/sol"] : null },
      });
    }
  } finally {
    await reader.cancel();
  }
});

test("routing API requires a session through an authenticated proxy", async () => {
  factory.cfg.auth = "required";
  factory.cfg.trustedProxies = ["10.0.0.20"];
  factory.cfg.publicOrigins = ["https://limitless.example.test"];
  const call = client();
  const server = {
    ...localServer,
    requestIP: () => ({ address: "10.0.0.20", family: "IPv4" as const, port: 40000 }),
  };
  const headers = {
    host: "limitless.example.test",
    origin: "https://limitless.example.test",
    "content-type": "application/json",
  };
  for (const [path, method] of [
    ["/api/routing", "GET"],
    ["/api/routing/preview?role=triage", "GET"],
    ["/api/routing/cells/triage/default", "PUT"],
    ["/api/routing/prefer", "DELETE"],
  ]) {
    expect((await call(path ?? "", method, undefined, headers, server)).status).toBe(401);
  }
  const auth = new Auth(factory.store, factory.cfg);
  const cookie = auth.signIn("password", "test").split(";")[0] ?? "";
  expect(
    (await call("/api/routing/prefer", "PUT", { prefer: ["codex"] }, { ...headers, cookie }, server)).status,
  ).toBe(200);
  expect(factory.routing.prefer).toEqual(["codex"]);
});
