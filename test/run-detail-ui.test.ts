import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "solid-js/web";
import type { RunModels } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { MODELS } from "../src/router/catalog.ts";
import { buildNeedsYouUi } from "./needs-you-ui-support.ts";
import { buildSetupUi, settle } from "./setup-ui-support.ts";

test("Run Detail opens saved chains and retry submits a replacement map, retaining API errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-retry-ui-"));
  const previous = globalThis.fetch;
  const store = new Store(":memory:");
  const repo = store.upsertRepo({
    slug: "owner/repo",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const created = store.createRun(repo, {
    repo: repo.slug,
    prompt: "Retry me",
    models: { implement: ["claude/opus@high|codex/sol", "codex/luna"] },
  });
  const run = { ...created, status: "failed" as const };
  const detail = store.getRunDetail(run.id);
  if (!detail) throw new Error("missing detail");
  const page = await buildNeedsYouUi(join(dir, "page"));
  const picker = await buildSetupUi(join(dir, "picker"), "RetryModels");
  let fail = true;
  let catalog = MODELS;
  const bodies: { models: RunModels }[] = [];
  globalThis.fetch = Object.assign(
    async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/api/catalog") return Response.json({ models: catalog, providers: [] });
      if (String(path) === "/api/routing")
        return Response.json({
          effective: { implement: { default: { groups: ["codex/sol@high"], layer: "operator" } } },
        });
      if (String(path) !== `/api/runs/${run.id}/retry`) throw new Error(`Unexpected request ${path}`);
      bodies.push(JSON.parse(String(init?.body)) as { models: RunModels });
      return fail
        ? Response.json({ error: "models.implement: invalid choice" }, { status: 400 })
        : Response.json({ id: "replacement" });
    },
    { preconnect() {} },
  );
  try {
    page.mount({ ...detail, run });
    const html = () => renderToString(() => page.render());
    expect(html()).toContain("Retry with different models…");
    await page.handlers.get("retry-models")?.();
    expect(html()).toContain("Retry with selected models");
    page.mount({ ...detail, run: { ...run, status: "running" } });
    expect(html()).not.toContain("Retry with different models…");
    page.mount({ ...detail, run: { ...run, status: "resolved" } });
    expect(html()).not.toContain("Retry with different models…");
    picker.mount({
      run,
      onRetried: (id: string) => picker.navigated.push(`/runs/${id}`),
      onCancel: () => {},
    });
    await settle();
    expect(picker.render()).toContain('value="high"');
    expect(picker.render()).toContain('value="codex/luna"');
    catalog = MODELS.map((m) =>
      m.id === "claude/opus" ? { ...m, supportedEfforts: m.supportedEfforts.filter((e) => e !== "high") } : m,
    );
    picker.emit({ kind: "catalog" });
    await settle();
    const unsupported = picker.render().match(/<option[^>]*>high \(unsupported\)<\/option>/)?.[0] ?? "";
    expect(unsupported).toContain("disabled");
    expect(unsupported).toContain("selected");
    await picker.invoke(picker.render(), "select", "Group 1 alternative 1 effort", "change", "low");
    await picker.invoke(picker.render(), "button", "Retry with selected models");
    expect(bodies[0]).toEqual({ models: { implement: ["claude/opus@low|codex/sol", "codex/luna"] } });
    expect(picker.render()).toContain("invalid choice");
    expect(picker.render()).toContain('value="low"');
    fail = false;
    await picker.invoke(picker.render(), "button", "Retry with selected models");
    expect(picker.navigated).toEqual(["/runs/replacement"]);
    picker.mount({ run: { ...run, models: undefined }, onRetried: () => {}, onCancel: () => {} });
    await settle();
    expect(picker.render()).toContain('value="codex/sol"');
    await picker.invoke(picker.render(), "button", "Retry with selected models");
    expect(bodies.at(-1)).toEqual({ models: { implement: ["codex/sol@high"] } });
  } finally {
    page.dispose();
    picker.dispose();
    store.close();
    globalThis.fetch = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
