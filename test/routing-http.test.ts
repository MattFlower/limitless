import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { RunContext } from "../src/pipeline/context.ts";
import type { Policy } from "../src/router/catalog.ts";
import { runtimeModel } from "../src/router/config-catalog.ts";
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
  calls = [];
  factory = makeFactory(new Store(":memory:"));
});
afterEach(() => {
  factory.store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeFactory(store: Store, policy?: Policy, excludeOrigins?: string[]) {
  const cfg = loadConfig({ home: dir, configDir: dir, port: 7400 });
  cfg.preferProviders = ["claude"];
  if (excludeOrigins !== undefined) cfg.raw.routing = { exclude_origins: excludeOrigins };
  cfg.secrets.OMLX_API_KEY = "fake-key";
  const harness = fakeHarness((spec) => {
    calls.push(spec.target.modelId);
    return { text: "ok" };
  });
  return new Factory(cfg, {
    store,
    policy,
    clock: () => 1_000,
    policyPath: join(dir, "policy.json"),
    harnesses: { claude: harness, codex: harness, llm: harness },
    healthFetch: (async (_url: Parameters<typeof fetch>[0]) =>
      Response.json({ data: [{ id: "org/backend" }, { id: "uncataloged" }] })) as typeof fetch,
  });
}

function catalogState() {
  return structuredClone({
    stored: factory.store.runtimeModels(),
    models: factory.models,
    catalog: factory.catalog.snapshot(),
    providers: factory.tracker.all(),
    routing: factory.routing.snapshot(),
  });
}

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
    const pinned = await call(path, "DELETE");
    expect(pinned.status).toBe(400);
    expect((await pinned.json()).error).toContain(`run ${run.id}`);
    expect(factory.router.resolveFor("triage", "codex/experiment@high").model.model).toBe("updated-build");
    expect((await call("/api/catalog/models", "POST", { ...input, id: "unused" })).status).toBe(201);
    expect((await call("/api/catalog/models/codex%2Funused", "DELETE")).status).toBe(200);
    expect(factory.store.runtimeModels()).toHaveLength(1);
    const deleted = factory.router.route("triage", "small", { chain: ["codex/unused"] });
    expect(deleted.candidates).toEqual([]);
    expect(deleted.skipped[0]?.reason).toContain('unknown model ID "codex/unused"');
    await expect(invoke({ ...run, models: { triage: ["codex/unused"] } })).rejects.toThrow(
      'unknown model ID "codex/unused"',
    );
    expect(factory.store.listInvocations(run.id)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  } finally {
    await reader.cancel();
  }
});

test("catalog rejects shadowed evals references and a compatible patch survives Factory reconstruction", async () => {
  factory.store.close();
  const db = join(dir, "routing.db");
  factory = makeFactory(new Store(db));
  expect(
    (await client()("/api/catalog/models", "POST", { ...customModel, provider: "codex", id: "experiment" }))
      .status,
  ).toBe(201);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ triage: { default: ["codex/experiment@high"] } }));
  factory = makeFactory(factory.store);
  factory.routing.setCell("triage", "default", ["codex/sol@high"]);
  const repo = factory.store.upsertRepo({
    slug: "catalog/restart",
    kind: "local",
    localPath: dir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, {
    repo: repo.slug,
    prompt: "pinned",
    models: { review: ["codex/experiment@high|claude/opus"] },
  });
  const before = catalogState();
  const events: unknown[] = [];
  factory.store.subscribe((event) => events.push(event));
  const path = "/api/catalog/models/codex%2Fexperiment";
  for (const method of ["PATCH", "DELETE"]) {
    const rejected = await client()(path, method, { efforts: ["none"] });
    expect(rejected.status).toBe(400);
    const error = (await rejected.json()).error;
    expect(error).toContain("evals");
    expect(error).toContain("triage.default");
    expect(error).toContain(method === "PATCH" ? 'Unsupported effort "high"' : "unknown model ID");
    expect(catalogState()).toEqual(before);
    expect(factory.router.resolveFor("triage", "codex/experiment@high").effort).toBe("high");
    expect(events).toEqual([]);
  }
  expect(
    (await client()(path, "PATCH", { model: "compatible-build", efforts: ["none", "high", "medium"] }))
      .status,
  ).toBe(200);
  expect(events.filter((event) => (event as { kind: string }).kind === "catalog")).toHaveLength(1);
  factory.store.close();
  factory = makeFactory(new Store(db));
  expect(factory.store.runtimeModels()[0]?.supportedEfforts).toEqual(["none", "high", "medium"]);
  expect(factory.router.resolveFor("triage", "codex/experiment@high").model.model).toBe("compatible-build");
  expect(factory.routing.preview("review", "small", run.id)).toContainEqual(
    expect.objectContaining({ modelId: "codex/experiment@high", eligible: true }),
  );
  expect(factory.router.route("triage", "small").candidates[0]).toMatchObject({
    modelId: "codex/sol",
    effort: "high",
  });
  factory.routing.setCell("triage", "default", null);
  expect(factory.router.route("triage", "small").candidates[0]).toMatchObject({
    modelId: "codex/experiment",
    effort: "high",
  });
});

test("catalog effort clears and successful mutation history survive store reopening", async () => {
  factory.store.close();
  const db = join(dir, "catalog.db");
  factory = makeFactory(new Store(db));
  const input = { ...customModel, provider: "codex", id: "history" };
  const path = "/api/catalog/models/codex%2Fhistory";
  expect((await client()("/api/catalog/models", "POST", input)).status).toBe(201);
  const old = factory.store.runtimeModels()[0];
  expect(old?.effort).toBe("none");
  // Omitting effort still preserves it; an explicit null removes it.
  expect((await client()(path, "PATCH", { model: "updated-backend" })).status).toBe(200);
  expect(factory.store.runtimeModels()[0]?.effort).toBe("none");
  expect((await client()(path, "PATCH", { effort: null, notes: "Clear default" })).status).toBe(200);
  expect(factory.store.runtimeModels()[0]).not.toHaveProperty("effort");
  const cleared = factory.store.runtimeModels()[0];
  const history = factory.store.catalogHistory();
  expect(history).toHaveLength(3);
  expect(history[0]).toMatchObject({
    modelId: "codex/history",
    oldValue: { effort: "none" },
    newValue: cleared,
    note: "Clear default",
  });
  expect(history[2]).toMatchObject({ oldValue: null, newValue: old, note: customModel.notes });
  for (const entry of history) expect(entry.at).toBeGreaterThan(0);
  const invalid = await client()(path, "PATCH", { effort: "max" });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).error).toContain("effort");
  expect(factory.store.catalogHistory()).toEqual(history);

  factory.store.close();
  factory = makeFactory(new Store(db));
  expect(factory.store.runtimeModels()[0]).not.toHaveProperty("effort");
  expect((await (await client()("/api/catalog")).json()).history).toEqual(history);
  expect((await client()(path, "DELETE")).status).toBe(200);
  const deleted = factory.store.catalogHistory();
  expect(deleted).toHaveLength(4);
  expect(deleted[0]).toMatchObject({ modelId: "codex/history", oldValue: cleared, newValue: null });
  expect((await client()(path, "DELETE")).status).toBe(400);
  expect(factory.store.catalogHistory()).toEqual(deleted);
  factory.store.close();
  factory = makeFactory(new Store(db));
  expect(factory.store.runtimeModels()).toEqual([]);
  expect((await (await client()("/api/catalog")).json()).history).toEqual(deleted);
});

test("catalog history and model mutations commit together", async () => {
  factory.store.db.exec(
    "CREATE TRIGGER reject_history BEFORE INSERT ON catalog_history BEGIN SELECT RAISE(ABORT, 'history disk failure'); END",
  );
  const before = catalogState();
  expect(
    (await client()("/api/catalog/models", "POST", { ...customModel, provider: "codex", id: "failed" }))
      .status,
  ).toBe(400);
  expect(catalogState()).toEqual(before);
});

test.each(["code", "operator"] as const)(
  "catalog PATCH and DELETE preserve references in the %s layer",
  async (layer) => {
    expect(
      (await client()("/api/catalog/models", "POST", { ...customModel, provider: "codex", id: "experiment" }))
        .status,
    ).toBe(201);
    if (layer === "code") {
      const code = structuredClone(factory.routing.code);
      code.triage.small = ["codex/experiment@high"];
      factory = makeFactory(factory.store, code);
      factory.routing.setCell("triage", "small", ["codex/sol"]);
    } else {
      factory.routing.setCell("triage", "small", ["codex/experiment@high"]);
    }
    const before = catalogState();
    const events: unknown[] = [];
    factory.store.subscribe((event) => events.push(event));
    for (const method of ["PATCH", "DELETE"]) {
      const response = await client()("/api/catalog/models/codex%2Fexperiment", method, {
        efforts: ["none"],
      });
      expect(response.status).toBe(400);
      const error = (await response.json()).error;
      expect(error).toContain(layer);
      expect(error).toContain("triage.small");
      expect(error).toContain("codex/experiment");
      expect(catalogState()).toEqual(before);
      expect(factory.router.resolveFor("triage", "codex/experiment@high").effort).toBe("high");
      expect(events).toEqual([]);
    }
  },
);

test("catalog validates stored chains beyond the default run limit and regardless of status", async () => {
  expect(
    (await client()("/api/catalog/models", "POST", { ...customModel, provider: "codex", id: "experiment" }))
      .status,
  ).toBe(201);
  const repo = factory.store.upsertRepo({
    slug: "catalog/chains",
    kind: "local",
    localPath: dir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, {
    repo: repo.slug,
    prompt: "finished pinned run",
    models: { review: ["retired-lan/legacy|claude/opus|codex/experiment@high"] },
  });
  factory.store.updateRun(run.id, { status: "succeeded" });
  factory.store.db.query("UPDATE runs SET created_at = 0 WHERE id = ?").run(run.id);
  for (let i = 0; i < 100; i++) factory.store.createRun(repo, { repo: repo.slug, prompt: "unpinned" });
  const before = catalogState();
  const events: unknown[] = [];
  factory.store.subscribe((event) => events.push(event));
  for (const method of ["PATCH", "DELETE"]) {
    const response = await client()("/api/catalog/models/codex%2Fexperiment", method, { efforts: ["none"] });
    expect(response.status).toBe(400);
    const error = (await response.json()).error;
    expect(error).toContain(`run ${run.id}`);
    expect(error).toContain("review");
    expect(error).toContain(method === "PATCH" ? 'Unsupported effort "high"' : "unknown model ID");
    expect(catalogState()).toEqual(before);
    expect(
      factory.routing.preview("review", "small", run.id).find((p) => p.modelId === "codex/experiment@high")
        ?.eligible,
    ).toBe(true);
    expect(events).toEqual([]);
  }
});

test.each(["code", "evals", "operator", "run"] as const)(
  "catalog POST tolerates an already retired %s reference",
  async (layer) => {
    factory = makeFactory(factory.store, structuredClone(factory.routing.code));
    if (layer === "run") {
      const repo = factory.store.upsertRepo({
        slug: "catalog/retired",
        kind: "local",
        localPath: dir,
        url: null,
        defaultBranch: "main",
        mergePolicy: "none",
      });
      factory.store.createRun(repo, {
        repo: repo.slug,
        prompt: "legacy chain",
        models: { implement: ["retired-lan/legacy"] },
      });
    } else {
      factory.routing.snapshot().layers[layer].triage = { small: ["retired-lan/legacy"] };
    }
    const response = await client()("/api/catalog/models", "POST", {
      ...customModel,
      provider: "codex",
      id: "experiment",
    });
    expect(response.status).toBe(201);
    expect(factory.models.some((m) => m.id === "codex/experiment")).toBe(true);
  },
);

test("catalog discovery skips stale targets in live and run previews without an invocation attempt", async () => {
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
  const chain = ["omlx/qwen-flash", "omlx/experiment"];
  const expectedPreview = [
    { modelId: "omlx/qwen-flash", eligible: false, reason: "not served by omlx" },
    { modelId: "omlx/experiment@none", eligible: true, reason: null },
  ];
  factory.routing.setCell("triage", "small", chain);
  expect(await (await call("/api/routing/preview?role=triage&complexity=small")).json()).toEqual(
    expectedPreview,
  );
  expect(calls).toEqual([]);
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
    models: { triage: chain },
  });
  factory.routing.setCell("triage", "small", ["codex/sol"]);
  expect(
    await (await call(`/api/routing/preview?role=triage&complexity=small&run=${run.id}`)).json(),
  ).toEqual(expectedPreview);
  expect(calls).toEqual([]);
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

test("origin safety is read-only, refuses setup writes, and marks accepted runtime catalog additions", async () => {
  factory.store.close();
  factory = makeFactory(new Store(":memory:"), undefined, ["CN"]);
  const call = client();
  const reason = "origin excluded (CN; baseOrigin=CN)";
  expect((await (await call("/api/routing")).json()).excludeOrigins).toEqual(["CN"]);
  const response = await call("/api/routing/cells/review/default", "PUT", {
    groups: ["claude/opus|openrouter/deepseek-v4-pro"],
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(reason);
  expect(factory.store.routingCells()).toEqual([]);
  const cn = factory.models.find((m) => m.origin === "CN");
  if (!cn) throw new Error("missing CN model");
  factory.router.setPolicy({ ...factory.policy, review: { default: [cn.id] } });
  expect(await (await call("/api/routing/preview?role=review")).json()).toContainEqual({
    modelId: factory.router.resolve(cn.id).targetId,
    eligible: false,
    reason: `origin excluded (${cn.origin}; baseOrigin=${cn.baseOrigin})`,
  });
  expect(
    (
      await call("/api/catalog/models", "POST", {
        ...customModel,
        provider: "codex",
        id: "excluded",
      })
    ).status,
  ).toBe(201);
  const catalog = await (await call("/api/catalog")).json();
  expect(catalog.excludeOrigins).toEqual(["CN"]);
  expect(catalog.models).toContainEqual(
    expect.objectContaining({
      id: "codex/excluded",
      excluded: reason,
    }),
  );
  factory.router.setPolicy({ ...factory.policy, review: { default: ["codex/excluded"] } });
  for (const constraints of [{ only: "codex/excluded" }, { prefer: "codex/excluded" }]) {
    const result = factory.router.route("review", "small", constraints);
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toContainEqual({ modelId: "codex/excluded@none", reason });
  }
});

test("exhausted review and verify invocations never dispatch to excluded fallback models", async () => {
  factory.store.close();
  factory = makeFactory(new Store(":memory:"), undefined, ["CN"]);
  const chain = ["claude/opus", "codex/sol", "openrouter/deepseek-v4-pro"];
  factory.router.setPolicy({
    ...factory.policy,
    review: { default: chain },
    verify: { default: chain },
  });
  factory.tracker.record("claude", "quota", { exhaustedUntil: 100_000 });
  factory.tracker.record("codex", "quota", { exhaustedUntil: 100_000 });
  const repo = factory.store.upsertRepo({
    slug: "origin/repo",
    kind: "local",
    localPath: dir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "Review safely" });
  const context = new RunContext(factory.deps, run, repo, new AbortController().signal);
  for (const role of ["review", "verify"] as const) {
    await expect(
      context.invoke({
        role,
        stage: factory.store.startStage(run.id, role, 0),
        prompt: "Review",
        mode: "readonly",
        complexity: "small",
      }),
    ).rejects.toThrow("origin excluded (CN; baseOrigin=CN)");
  }
  expect(calls).toEqual([]);
  expect(factory.store.listInvocations(run.id)).toEqual([]);
  expect(JSON.stringify(factory.store.listEvents(run.id))).toContain("origin excluded (CN; baseOrigin=CN)");
});

test.each([
  "mixed routing",
  "retired preference",
  "retired cell",
  "retired provider",
  "historical run",
] as const)(
  "reopened database with %s starts, reports unavailable references and permits unrelated catalog edits",
  async (scenario) => {
    factory.store.close();
    const db = join(dir, "persisted.sqlite");
    let store = new Store(db);
    const retired = "retired-lan/legacy";
    let runId: string | undefined;
    if (scenario === "mixed routing") {
      store.writeRouting(
        "triage.default",
        [`${retired}|codex/luna@medium`, retired],
        null,
        "previous release",
      );
      store.writeRouting("prefer", ["retired-lan", "codex"], null, "previous release");
    } else if (scenario === "retired preference") {
      store.writeRouting("prefer", ["retired-lan", "codex"], null, "previous release");
    } else if (scenario === "retired cell") {
      store.writeRouting("chat.default", [retired], null, "previous release");
    } else if (scenario === "retired provider") {
      const model = runtimeModel({ ...customModel, provider: "codex", id: "legacy" }, [
        {
          id: "codex",
          label: "Codex",
          harness: "codex",
          billing: "subscription",
          maxConcurrent: 1,
        },
      ]);
      store.writeRuntimeModel(retired, { ...model, id: retired, provider: "retired-lan" });
      store.writeRouting("triage.default", [retired, "codex/luna"], null, "previous release");
    } else {
      const repo = store.upsertRepo({
        slug: "catalog/history",
        kind: "local",
        localPath: dir,
        url: null,
        defaultBranch: "main",
        mergePolicy: "none",
      });
      const run = store.createRun(repo, {
        repo: repo.slug,
        prompt: "finished legacy run",
        models: { triage: [retired, "codex/luna"] },
      });
      store.updateRun(run.id, { status: "succeeded" });
      runId = run.id;
    }
    const cells = store.routingCells();
    const prefer = store.routingPrefer();
    const models = store.runtimeModels();
    store.close();
    store = new Store(db);
    factory = makeFactory(store);
    const call = client();
    const routing = await (await call("/api/routing")).json();
    const catalog = await (await call("/api/catalog")).json();
    if (scenario === "retired cell") {
      expect(factory.policy.chat).toEqual(factory.routing.code.chat);
      expect(factory.router.route("chat", "small").candidates.length).toBeGreaterThan(0);
      expect(routing.effective.chat.default.layer).toBe("code");
    } else if (scenario !== "retired preference") {
      const route = factory.router.route("triage", "small", {
        chain: runId ? store.getRun(runId)?.models?.triage : undefined,
      });
      expect(route.candidates[0]?.modelId).toBe("codex/luna");
    }
    if (runId) {
      const preview = await (
        await call(`/api/routing/preview?role=triage&complexity=small&run=${runId}`)
      ).json();
      expect(preview).toContainEqual({
        modelId: retired,
        eligible: false,
        reason: expect.stringContaining("unknown model ID"),
      });
    } else if (scenario !== "retired preference") {
      expect(routing.unavailable).toContainEqual(
        expect.objectContaining({ id: retired, reason: expect.stringContaining("retired reference") }),
      );
    }
    if (scenario === "mixed routing" || scenario === "retired preference") {
      expect(routing.prefer).toEqual(["codex"]);
      expect(routing.unavailable).toContainEqual(expect.objectContaining({ id: "retired-lan" }));
    }
    if (scenario === "retired provider") {
      expect(catalog.models).toContainEqual(
        expect.objectContaining({ id: retired, unavailable: expect.stringContaining("retired-lan") }),
      );
      expect(factory.router.preview("triage", "small", { chain: [retired] })[0]).toMatchObject({
        eligible: false,
        reason: expect.stringContaining("unknown provider"),
      });
    }
    expect(
      (await call("/api/catalog/models", "POST", { ...customModel, provider: "codex", id: "unrelated" }))
        .status,
    ).toBe(201);
    expect((await call("/api/routing/cells/triage/default", "PUT", { groups: [retired] })).status).toBe(400);
    expect((await call("/api/routing/prefer", "PUT", { prefer: ["retired-lan"] })).status).toBe(400);
    expect(store.routingCells()).toEqual(cells);
    expect(store.routingPrefer()).toEqual(prefer);
    expect(store.runtimeModels().filter((m) => m.id === retired)).toEqual(models);
    if (runId) expect(store.getRun(runId)?.models?.triage).toEqual([retired, "codex/luna"]);
  },
);
