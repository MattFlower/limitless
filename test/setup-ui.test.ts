import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ProviderStatus, Run, RunModels } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";
import type { RoutePreview } from "../src/router/router.ts";
import { registerCredential } from "../src/util/proc.ts";
import type { CatalogSnapshot, RoutingSnapshot } from "../ui/api.ts";
import { deferred } from "./evals-support.ts";
import { buildSetupUi, settle, setupLayout, type Ui } from "./setup-ui-support.ts";
import { waitClock } from "./wait-clock.ts";

const dir = mkdtempSync(join(tmpdir(), "limitless-setup-ui-"));
const catalog: CatalogSnapshot = {
  history: [],
  models: MODELS.slice(0, 4).map((m, i) => ({ ...m, source: i === 2 ? "config" : "code" })),
  providers: [
    {
      provider: "local",
      served: ["Exact Backend / v1"],
      observedAt: 1,
      servedNotInCatalog: ["Exact Backend / v1"],
      catalogNotServed: ["local/missing"],
      observations: [],
    },
  ],
};
const first = catalog.models[0];
const second = catalog.models[1];
if (!first || !second) throw new Error("missing fixture model");
const routing: RoutingSnapshot = {
  runId: null,
  layers: { code: DEFAULT_POLICY, evals: {}, operator: {} },
  prefer: ["claude", "codex"],
  operatorPrefer: ["claude", "codex"],
  effective: {
    implement: {
      default: { groups: [first.id], layer: "code" },
      small: { groups: [second.id], layer: "evals" },
      large: { groups: [`${first.id}@high|${second.id}`, first.id], layer: "operator", evals: [second.id] },
    },
  },
  history: [
    {
      id: 1,
      key: "implement.large",
      oldValue: [second.id],
      newValue: [first.id],
      note: "Quota reserve",
      at: 1000,
      by: "operator",
    },
  ],
};
const provider: ProviderStatus = {
  id: "claude",
  label: "Claude",
  billing: "subscription",
  enabled: true,
  state: "ok",
  reason: null,
  until: null,
  windows: {
    weekly: { utilization: 1, resetsAt: Date.now() + 3600_000, observedAt: 1 },
    session: { utilization: 0.2, resetsAt: null, observedAt: null },
  },
  spendUsd: null,
  budgetUsd: null,
  inFlight: 0,
  maxConcurrent: 1,
  updatedAt: 1,
};
let ui: Ui;
let form: Ui;
let retry: Ui;
beforeAll(async () => {
  ui = await buildSetupUi(join(dir, "setup"), "Setup");
  retry = await buildSetupUi(join(dir, "retry"), "RetryModels");
  form = await buildSetupUi(join(dir, "form"), "CatalogForm");
});
afterAll(() => {
  ui?.dispose();
  form?.dispose();
  retry?.dispose();
  rmSync(dir, { recursive: true, force: true });
});
type Sent = { path: string; method: string; value: Record<string, unknown> | undefined };
async function fixture(
  work: (
    sent: Sent[],
    state: {
      routing: RoutingSnapshot;
      catalog: CatalogSnapshot;
      fail: string;
      providers: ProviderStatus[];
      previews: RoutePreview[];
    },
  ) => Promise<void>,
) {
  const previous = globalThis.fetch;
  const sent: Sent[] = [];
  const state = {
    routing: structuredClone(routing),
    catalog: structuredClone(catalog),
    fail: "",
    providers: structuredClone([provider, { ...provider, id: "codex", windows: {} }]),
    previews: [
      ...["exhausted until tomorrow", "over reserve", "disabled", "unhealthy", "not served"].map(
        (reason, i) => ({ modelId: `skipped/${i}`, eligible: false, reason }),
      ),
      { modelId: "chosen/model", eligible: true, reason: null },
    ] as RoutePreview[],
  };
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const value = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      sent.push({ path, method, value });
      if (method !== "GET" && state.fail) return Response.json({ error: state.fail }, { status: 400 });
      if (path.startsWith("/api/routing/preview")) return Response.json(state.previews);
      if (path.startsWith("/api/runs/") && method === "POST") return Response.json({ id: "retried" });
      if (path.startsWith("/api/routing")) {
        if (method === "DELETE" && path.includes("/cells/"))
          state.routing.effective.implement = {
            ...state.routing.effective.implement,
            large: { groups: [second?.id ?? ""], layer: "evals" },
          };
        if (method === "PUT" && path.includes("/cells/"))
          state.routing.effective.implement = {
            ...state.routing.effective.implement,
            large: { groups: value?.groups as string[], layer: "operator", evals: [second?.id ?? ""] },
          };
        if (path.endsWith("/prefer") && method === "DELETE") state.routing.operatorPrefer = null;
        return Response.json(state.routing);
      }
      if (path === "/api/providers") return Response.json(state.providers);
      if (path === "/api/stats/providers") return Response.json([]);
      if (path.startsWith("/api/catalog")) {
        if (method === "POST" && value && first)
          state.catalog.history.unshift({
            id: state.catalog.history.length + 1,
            modelId: `${String(value.provider)}/${String(value.id)}`,
            oldValue: null,
            newValue: {
              ...first,
              id: `${String(value.provider)}/${String(value.id)}`,
              model: String(value.model),
              notes: String(value.notes),
              source: "runtime",
            },
            note: String(value.notes),
            at: Date.now(),
          });
        return Response.json(state.catalog);
      }
      throw new Error(`Unexpected API ${path}`);
    },
    { preconnect() {} },
  );
  try {
    ui.mount();
    await settle();
    await work(sent, state);
  } finally {
    ui.dispose();
    form.dispose();
    retry.dispose();
    globalThis.fetch = previous;
  }
}
const cell = (html: string) =>
  html.match(/<article[^>]*aria-label="implement large"[\s\S]*?<\/article>/)?.[0] ?? "";

test("responsive Setup wraps cells and open editors at a 375px viewport without horizontal overflow", async () => {
  await fixture(async (_sent, state) => {
    const longId = `local/${"long-model-name-".repeat(12)}`;
    state.catalog.models.push({ ...first, id: longId, model: longId, source: "runtime" });
    state.routing.effective.implement = {
      ...state.routing.effective.implement,
      large: { groups: [`${longId}@high|${second.id}`, first.id], layer: "operator", evals: [longId] },
    };
    ui.emit({ kind: "routing", change: state.routing.history[0] as RoutingSnapshot["history"][number] });
    await settle();
    for (const editing of [false, true]) {
      if (editing) {
        await ui.invoke(cell(ui.render()), "button", "Edit chain");
        await ui.invoke(ui.render(), "button", "Edit preference");
        await ui.invoke(ui.render(), "button", ">Add<");
        await ui.invoke(ui.render(), "button", "Edit model");
      }
      const layout = await setupLayout(ui.render(), { width: 375, height: 812 });
      expect(layout.viewport).toBe(375);
      expect(layout.scrollWidth).toBeLessThanOrEqual(375);
      expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.pageWidth);
      expect(layout.cells).toHaveLength(3);
      // At phone width each cell occupies the same column.
      expect(new Set(layout.cells.map((c) => c.left)).size).toBe(1);
      expect(layout.controls.length).toBeGreaterThan(editing ? 30 : 0);
      for (const control of [...layout.cells, ...layout.controls]) {
        expect(control.left, control.label ?? "").toBeGreaterThanOrEqual(0);
        expect(control.right, control.label ?? "").toBeLessThanOrEqual(375);
        expect(control.width, control.label ?? "").toBeGreaterThan(0);
      }
      expect(layout.overflowingCards).toEqual([]);
    }
  });
});

test("grid renders layers, recommendations, concrete previews, history and distinct quota telemetry", async () => {
  await fixture(async (sent) => {
    const html = ui.render();
    for (const text of [
      ">code<",
      ">evals<",
      ">yours<",
      ">config<",
      "Evals recommendation",
      first.id,
      "high",
      "subscription",
      "chosen/model",
      "exhausted until tomorrow",
      "over reserve",
      "disabled",
      "unhealthy",
      "not served",
      "0% headroom",
      "unobserved",
      "Telemetry unavailable",
      "Quota reserve",
      "implement.large",
      "Routing history",
      "Catalog history",
      "Catalog but not served",
    ])
      expect(html).toContain(text);
    const previews = sent.filter((s) => s.path.includes("/preview"));
    expect(previews).toHaveLength(3);
    expect(previews.some((s) => s.path.endsWith("complexity=trivial"))).toBe(true);
    expect(previews.some((s) => s.path.includes("complexity=default"))).toBe(false);
    expect(html).not.toContain("Delete model");
  });
});

test("ordered edits send groups and note, retain failed drafts during SSE, reset with DELETE and edit preference", async () => {
  await fixture(async (sent, state) => {
    await ui.invoke(cell(ui.render()), "button", "Edit chain");
    await ui.invoke(cell(ui.render()), "button", "Move group 2 up");
    await ui.invoke(cell(ui.render()), "label", "Note (optional)", "input", "Keep reserve");
    state.fail = "implement.large: invalid effort";
    await ui.invoke(cell(ui.render()), "button", ">Save<");
    expect(sent.find((s) => s.method === "PUT")?.value).toEqual({
      groups: [first.id, `${first.id}@high|${second.id}`],
      note: "Keep reserve",
    });
    expect(cell(ui.render())).toContain("invalid effort");
    state.routing.effective.implement = {
      ...state.routing.effective.implement,
      large: { groups: [second.id], layer: "operator", evals: [first.id] },
    };
    state.routing.history.unshift({
      ...routing.history[0],
      id: 2,
      key: "Live update",
      oldValue: null,
      newValue: [second.id],
      at: 2000,
      by: "operator",
      note: "SSE note",
    });
    ui.emit({ kind: "routing", change: state.routing.history[0] as RoutingSnapshot["history"][number] });
    await settle();
    expect(ui.render()).toContain("Live update");
    expect(cell(ui.render())).toContain('value="Keep reserve"');
    state.fail = "";
    await ui.invoke(cell(ui.render()), "button", ">Save<");
    expect(sent.filter((s) => s.method === "PUT").at(-1)?.value).toEqual({
      groups: [first.id, `${first.id}@high|${second.id}`],
      note: "Keep reserve",
    });
    await ui.invoke(cell(ui.render()), "button", "Reset to recommended");
    expect(sent.find((s) => s.method === "DELETE")?.path).toBe("/api/routing/cells/implement/large");
    expect(cell(ui.render())).toContain(">evals<");
    await ui.invoke(ui.render(), "button", "Edit preference");
    await ui.invoke(ui.render(), "select", "Preferred provider 1", "change", "codex");
    await ui.invoke(ui.render(), "select", "Preferred provider 2", "change", "claude");
    await ui.invoke(ui.render(), "button", "Save preference");
    expect(sent.find((s) => s.path.endsWith("/prefer") && s.method === "PUT")?.value).toEqual({
      prefer: ["codex", "claude"],
      note: "",
    });
    await ui.invoke(ui.render(), "button", "Reset preference");
    expect(sent.some((s) => s.path === "/api/routing/prefer" && s.method === "DELETE")).toBe(true);
  });
});

test("catalog history loads API changes on fresh mounts and from other clients over SSE", async () => {
  await fixture(async (_sent, state) => {
    const value = { ...first, id: "local/api-model", source: "runtime" as const };
    state.catalog.history = [
      { id: 3, modelId: value.id, oldValue: value, newValue: null, note: null, at: 3000 },
      {
        id: 2,
        modelId: value.id,
        oldValue: { ...value, model: "Old backend" },
        newValue: value,
        note: "Edit via API",
        at: 2000,
      },
      { id: 1, modelId: value.id, oldValue: null, newValue: value, note: "Add via API", at: 1000 },
    ];
    for (const mount of [true, false]) {
      if (mount) ui.mount();
      else {
        state.catalog.history.unshift({
          id: 4,
          modelId: "local/another-client",
          oldValue: null,
          newValue: value,
          note: "Another client",
          at: 4000,
        });
        ui.emit({ kind: "catalog" });
      }
      await settle();
      const history = ui.render().split("Catalog history")[1] ?? "";
      expect(history).toContain("local/api-model");
      expect(history).toContain("Old backend");
      expect(history).toContain("Add via API");
      expect(history).toContain("Edit via API");
      expect(history).toContain("null →");
      expect(history).toContain("→ null");
      expect(history).toContain(`<time>${new Date(3000).toLocaleString()}</time>`);
      if (!mount) expect(history).toContain("local/another-client");
    }
  });
});

test("successful catalog additions render server history with old/new metadata and note", async () => {
  await fixture(async (sent) => {
    await ui.invoke(ui.render(), "button", ">Add<");
    const add = () =>
      ui.render().match(/<form[^>]*aria-label="Add Exact Backend \/ v1"[\s\S]*?<\/form>/)?.[0] ?? "";
    for (const [label, value, event] of [
      ["Unique short id", "session-model", "input"],
      [">origin", "CN", "input"],
      [">vendor", "qwen", "change"],
      [">tier", "2", "change"],
      ["Note (optional)", "Try the newly served model", "input"],
    ])
      await ui.invoke(add(), "label", label ?? "", event, value);
    await ui.invoke(add(), "form", "Add Exact Backend", "submit");
    expect(sent.find((s) => s.method === "POST")?.value?.model).toBe("Exact Backend / v1");
    const history = ui.render().split("Catalog history")[1] ?? "";
    expect(history).toContain("null →");
    expect(history).toContain("session-model");
    expect(history).toContain("Try the newly served model");
    expect(history).toContain("<time>");
  });
});

test("a save response preserves a newer draft entered while the request was pending", async () => {
  await fixture(async (_sent, state) => {
    const pending = deferred<Response>();
    const fetchSaved = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (path: string | URL | Request, init?: RequestInit) =>
        init?.method === "PUT" ? pending.promise : fetchSaved(path, init),
      { preconnect() {} },
    );
    await ui.invoke(cell(ui.render()), "button", "Edit chain");
    await ui.invoke(cell(ui.render()), "label", "Note (optional)", "input", "Submitted note");
    await ui.invoke(cell(ui.render()), "button", ">Save<");
    await ui.invoke(cell(ui.render()), "label", "Note (optional)", "input", "New unsaved note");
    ui.emit({ kind: "reconnected" });
    await settle();
    pending.resolve(Response.json(state.routing));
    await settle();
    expect(cell(ui.render())).toContain('value="New unsaved note"');
    expect(cell(ui.render())).toContain("Add group");
  });
});

test("unavailable discovery does not render catalog-not-served warnings", async () => {
  await fixture(async (_sent, state) => {
    const discovery = state.catalog.providers[0];
    if (!discovery) throw new Error("missing discovery");
    discovery.served = null;
    ui.emit({ kind: "catalog" });
    await settle();
    expect(ui.render()).toContain("Served list unavailable");
    expect(ui.render()).not.toContain("Catalog but not served:");
  });
});

test("catalog and provider SSE and reconnection refresh snapshots; default can be shadowed", async () => {
  await fixture(async (sent, state) => {
    state.catalog.models[0] = { ...first, source: "runtime" };
    ui.emit({ kind: "catalog" });
    await settle();
    expect(ui.render()).toContain("Edit model");
    expect(ui.render()).toContain("Delete model");
    state.fail = `${first.id} referenced by operator policy implement.large and run saved`;
    await ui.invoke(ui.render(), "button", "Delete model");
    expect(ui.render()).toContain(state.fail);
    expect(ui.render()).toContain(first.id);
    expect(sent.find((s) => s.method === "DELETE")?.path).toBe(
      `/api/catalog/models/${encodeURIComponent(first.id)}`,
    );
    const reads = sent.length;
    ui.emit({ kind: "provider", provider });
    await settle();
    expect(sent.length).toBeGreaterThan(reads);
    state.routing.effective.implement = Object.fromEntries(
      ["default", "trivial", "small", "medium", "large"].map((c) => [
        c,
        { groups: [first.id], layer: "code" },
      ]),
    );
    ui.emit({ kind: "reconnected" });
    await settle();
    expect(ui.render()).toContain("default currently shadowed");
  });
});

test("discovery Add requires origin, preserves exact backend and complete metadata; PATCH retains refusal", async () => {
  await fixture(async (sent, state) => {
    const props = { provider: "local", backend: "Exact Backend / v1", onSaved: () => {}, onCancel: () => {} };
    form.mount(props);
    await form.invoke(form.render(), "form", "Add Exact Backend", "submit");
    expect(form.render()).toContain("origin, base origin, vendor and tier are required");
    expect(sent.some((s) => s.method === "POST")).toBe(false);
    for (const [label, value, event] of [
      ["Unique short id", "new", "input"],
      [">origin", "CN", "input"],
      [">vendor", "qwen", "change"],
      [">tier", "2", "change"],
    ])
      await form.invoke(form.render(), "label", label ?? "", event, value);
    state.fail = "catalog collision: local/new";
    await form.invoke(form.render(), "form", "Add Exact Backend", "submit");
    expect(form.render()).toContain(state.fail);
    expect(sent.find((s) => s.method === "POST")?.value).toEqual({
      provider: "local",
      id: "new",
      model: "Exact Backend / v1",
      origin: "CN",
      baseOrigin: "unknown",
      vendor: "qwen",
      tier: 2,
      price: { input: 0, output: 0 },
      supportedEfforts: [],
      notes: "",
    });
    state.fail = "policy implement.large references an unsupported effort";
    form.mount({
      ...props,
      provider: first.provider,
      backend: first.model,
      existing: { ...first, source: "runtime" },
    });
    await form.invoke(form.render(), "label", "Backend name", "input", "Changed backend");
    await form.invoke(form.render(), "form", `Edit ${first.id}`, "submit");
    expect(sent.find((s) => s.method === "PATCH")?.value?.model).toBe("Changed backend");
    expect(form.render()).toContain(state.fail);
    expect(form.render()).toContain('value="Changed backend"');
  });
});

test("clearing a runtime model's default effort sends an explicit PATCH clear", async () => {
  await fixture(async (sent) => {
    form.mount({
      provider: first.provider,
      backend: first.model,
      existing: { ...first, source: "runtime", effort: "high" },
      onSaved: () => {},
      onCancel: () => {},
    });
    await form.invoke(form.render(), "label", "Default effort", "input", "");
    await form.invoke(form.render(), "form", `Edit ${first.id}`, "submit");
    expect(sent.find((s) => s.method === "PATCH")?.value?.effort).toBeNull();
  });
});

test("retry inherits deep review routing and only replaces overrides the operator edits", async () => {
  const store = new Store(":memory:");
  const repo = store.upsertRepo({
    slug: "retry/local",
    kind: "local",
    localPath: dir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run: Run = {
    ...store.createRun(repo, { repo: repo.slug, prompt: "Deep retry", profile: "deep" }),
    complexity: "small",
  };
  try {
    await fixture(async (sent, state) => {
      state.routing.effective.review = {
        default: { groups: [first.id], layer: "code" },
        small: { groups: [first.id], layer: "code" },
        large: { groups: [second.id], layer: "evals" },
      };
      const mount = async (models: RunModels) => {
        retry.mount({ run: { ...run, models }, onRetried: () => {}, onCancel: () => {} });
        await settle();
      };
      const role = (name: string) =>
        retry
          .render()
          .match(new RegExp(`<section[^>]*aria-label="${name} models"[\\s\\S]*?<\\/section>`))?.[0] ?? "";
      const submit = async () => {
        await retry.invoke(retry.render(), "button", "Retry with selected models");
        return sent.filter((s) => s.method === "POST").at(-1)?.value;
      };
      await mount({});
      expect(role("review")).toContain(`value="${second.id}"`);
      expect(role("review")).toContain("Inherited from policy");
      expect(await submit()).toBeUndefined();
      await retry.invoke(role("review"), "select", "Group 1 alternative 1 effort", "change", "high");
      expect(await submit()).toEqual({ models: { review: [`${second.id}@high`] } });

      await mount({ implement: [first.id] });
      expect(await submit()).toBeUndefined();
      await retry.invoke(role("review"), "select", "Group 1 alternative 1 effort", "change", "high");
      expect(await submit()).toEqual({ models: { implement: [first.id], review: [`${second.id}@high`] } });
      await retry.invoke(role("implement"), "input", 'type="checkbox"', "change", "", false);
      expect(role("implement")).toContain("Inherited from policy");
      expect(await submit()).toEqual({ models: { review: [`${second.id}@high`] } });

      await mount({ implement: [first.id] });
      await retry.invoke(role("implement"), "input", 'type="checkbox"', "change", "", false);
      expect(await submit()).toEqual({ models: {} });
      retry.mount({
        run: { ...run, profile: "auto", resolvedProfile: "deep" },
        onRetried: () => {},
        onCancel: () => {},
      });
      await settle();
      expect(role("review")).toContain(`value="${second.id}"`);
      expect(await submit()).toBeUndefined();
      const fetchSaved = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (path: string | URL | Request, init?: RequestInit) =>
          String(path) === "/api/routing"
            ? Response.json({ error: "routing unavailable" }, { status: 503 })
            : fetchSaved(path, init),
        { preconnect() {} },
      );
      await mount({ implement: [first.id] });
      expect(retry.render()).toContain("routing unavailable");
      expect(role("implement")).toContain(`value="${first.id}"`);
      const button = retry.render().match(/<button[^>]*>Retry with selected models<\/button>/)?.[0];
      expect(button).toBeDefined();
      expect(button).not.toContain("disabled");
      expect(await submit()).toBeUndefined();
    });
  } finally {
    store.close();
  }
});

test("Setup refreshes at cooldown and quota expiry, polls while visible, and stops on cleanup", async () => {
  const clock = waitClock();
  const timeout = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const previousDocument = globalThis.document;
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  globalThis.document = page as unknown as Document;
  const date = spyOn(Date, "now").mockImplementation(clock.now);
  // Solid's SSR disposal uses a zero-delay timer; only control the page's timed refreshes.
  globalThis.setTimeout = ((callback: () => void, ms?: number) =>
    ms === undefined ? timeout(callback) : clock.timer.set(callback, ms)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (typeof id === "number") clock.timer.clear(id);
    else clear(id);
  }) as typeof clearTimeout;
  try {
    await fixture(async (sent, state) => {
      const start = clock.now();
      state.providers = [
        {
          ...provider,
          windows: {
            weekly: { utilization: 1, resetsAt: start + 2000, observedAt: start },
          },
        },
      ];
      state.previews = [
        {
          modelId: "cooldown/model",
          eligible: false,
          reason: `exhausted until ${new Date(start + 1000).toISOString()}`,
        },
        { modelId: "fallback/model", eligible: true, reason: null },
      ];
      ui.mount();
      await settle();
      expect(ui.render()).toContain("0% headroom");
      const reads = () => sent.filter((s) => s.path.includes("/preview")).length;
      let before = reads();
      state.previews = [{ modelId: "cooldown/model", eligible: true, reason: null }];
      await clock.advance(1001);
      await settle();
      expect(reads()).toBeGreaterThan(before);
      expect(ui.render()).toContain("<span>cooldown/model</span>");
      expect(ui.render()).not.toContain("<span>fallback/model</span>");
      before = reads();
      state.previews = [{ modelId: "reset/model", eligible: true, reason: null }];
      await clock.advance(1000);
      await settle();
      expect(reads()).toBeGreaterThan(before);
      expect(ui.render()).toContain("<span>reset/model</span>");
      expect(ui.render()).toContain("window expired; awaiting telemetry");
      expect(ui.render()).not.toContain("0% headroom");
      state.providers = [
        {
          ...provider,
          windows: {
            weekly: { utilization: 0.1, resetsAt: start + 100_000, observedAt: clock.now() },
          },
        },
      ];
      before = reads();
      await clock.advance(60_000);
      await settle();
      expect(reads()).toBeGreaterThan(before);
      expect(ui.render()).toContain("90% headroom");
      expect(clock.pending).toBe(1);
      page.visibilityState = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
      expect(clock.pending).toBe(0);
      before = reads();
      await clock.advance(60_000);
      await settle();
      expect(reads()).toBe(before);
      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(reads()).toBeGreaterThan(before);
      expect(clock.pending).toBe(1);
      ui.dispose();
      expect(clock.pending).toBe(0);
      before = reads();
      await clock.advance(60_000);
      page.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(reads()).toBe(before);
    });
  } finally {
    date.mockRestore();
    globalThis.setTimeout = timeout;
    globalThis.clearTimeout = clear;
    if (previousDocument) globalThis.document = previousDocument;
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a delayed older preview cannot replace a newer refresh", async () => {
  await fixture(async (_sent, state) => {
    const pending = deferred<Response>();
    const previous = globalThis.fetch;
    let defer = true;
    globalThis.fetch = Object.assign(
      async (path: string | URL | Request, init?: RequestInit) => {
        if (defer && String(path).includes("/preview")) return pending.promise;
        return previous(path, init);
      },
      { preconnect() {} },
    );
    ui.emit({ kind: "reconnected" });
    await settle();
    defer = false;
    state.previews = [{ modelId: "new/model", eligible: true, reason: null }];
    ui.emit({ kind: "reconnected" });
    await settle();
    pending.resolve(Response.json([{ modelId: "old/model", eligible: true, reason: null }]));
    await settle();
    expect(ui.render()).toContain("<span>new/model</span>");
    expect(ui.render()).not.toContain("<span>old/model</span>");
  });
});

test("Setup displays configured origin exclusions without an edit control", async () => {
  await fixture(async (_sent, state) => {
    state.routing.excludeOrigins = ["CN"];
    ui.emit({ kind: "reconnected" });
    await settle();
    const html = ui.render();
    const paragraph = html.match(/<p[^>]*>Origin exclusions:[\s\S]*?<\/p>/)?.[0];
    expect(paragraph).toContain("CN");
    expect(paragraph).toContain("config.toml");
    expect(paragraph).toContain("restart");
    expect(paragraph).not.toMatch(/<(input|select|button|textarea)\b/);
  });
});

test("Setup renders redacted unavailable diagnostics from the runtime snapshots", async () => {
  const credential = "synthetic-setup-credential-419";
  registerCredential("LIMITLESS_TEST_SETUP_DIAGNOSTIC_KEY", credential);
  const provider = `retired-${credential}`;
  const store = new Store(":memory:");
  store.writeRouting("triage.default", [`${provider}/legacy`], null, "previous release");
  store.writeRouting("prefer", [provider], null, "previous release");
  store.writeRuntimeModel("retired-lan/runtime", {
    ...first,
    id: "retired-lan/runtime",
    provider,
    source: "runtime",
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const factory = new Factory(loadConfig({ home: dir, configDir: dir }), { store });
    await fixture(async (_sent, state) => {
      state.routing.unavailable = factory.routing.snapshot().unavailable;
      const retired = factory.catalog.snapshot().models.find((m) => m.id === "retired-lan/runtime");
      if (!retired) throw new Error("missing retired runtime model");
      state.catalog.models.push(retired);
      ui.emit({ kind: "reconnected" });
      await settle();
      const html = ui.render();
      expect(html).not.toContain(credential);
      expect(html).toContain("retired-[redacted]/legacy: unavailable");
      expect(html).toContain("retired-[redacted]: unavailable");
      expect(html).toContain("no override; falling back to code/evals policy");
      expect(html).toContain("Unavailable: retired reference: retired-[redacted] is not in the catalog");
    });
  } finally {
    warn.mockRestore();
    store.close();
  }
});
