import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import { fakeHarness } from "../src/harness/fake.ts";
import { VerifySchema } from "../src/pipeline/schemas.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { buildNeedsYouUi } from "./needs-you-ui-support.ts";
import { test } from "./read-policy-support.ts";
import { buildSetupUi, settle } from "./setup-ui-support.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
test("verification artifact renders blocked evidence and legacy statuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-ssr-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../ui/components/ArtifactsPanel.tsx")],
      outdir: dir,
      target: "bun",
      plugins: [
        {
          name: "solid-ssr-test",
          setup(builder) {
            builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
              const transformed = await transformAsync(await Bun.file(args.path).text(), {
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
    const output = build.outputs[0];
    if (!output) throw new Error("No artifact build output");
    const { VerifyArtifact, ArtifactsPanel } = (await import(
      output.path
    )) as typeof import("../ui/components/ArtifactsPanel.tsx");
    const panel = renderToString(() =>
      ArtifactsPanel({
        runId: "run-1",
        artifacts: [
          { name: "screenshot-42-0.png", kind: "screenshot", size: 100, createdAt: 0 },
          { name: "verify-0.json", kind: "verify", size: 50, createdAt: 0 },
        ],
      }),
    );
    expect(panel).toContain("<img");
    expect(panel).toContain('src="/api/runs/run-1/screenshots/screenshot-42-0.png"');
    expect(panel).toContain("verify-0.json");
    const textPanel = renderToString(() =>
      ArtifactsPanel({
        runId: "run-1",
        artifacts: [{ name: "verify-0.json", kind: "verify", size: 50, createdAt: 0 }],
      }),
    );
    expect(textPanel).not.toContain("<img");
    const criteria = (["met", "unmet", "unclear", "blocked", "blocked"] as const).map((status, i) => ({
      id: i === 4 ? "H-1" : `AC-${i + 1}`,
      status,
      evidence: `evidence ${i}`,
    }));
    const html = renderToString(() =>
      VerifyArtifact({
        data: {
          criteria,
          overall: "fail",
          notes: "verification blocked by the environment",
          modelId: "test/model",
        },
      }),
    );
    for (const text of [
      "🚧 blocked",
      "badge-blocked",
      "evidence 3",
      "evidence 4",
      "H-1",
      "verification blocked by the environment",
      "test/model",
      "badge-met",
      "badge-unmet",
      "badge-unclear",
    ])
      expect(html).toContain(text);
    const legacy = renderToString(() =>
      VerifyArtifact({
        data: { criteria: criteria.slice(0, 3), overall: "fail", notes: "legacy", model: "old/model" },
      }),
    );
    expect(legacy).toContain("old/model");
    expect(legacy).not.toContain("🚧");
    expect(legacy).not.toContain("not required");
    const reply = await fakeHarness(() => ({
      structured: {
        criteria: [
          {
            id: "H-1",
            status: "unmet",
            evidence: "dismissed",
            publicSummary: "",
            requirement: "not_required",
          },
          { id: "H-2", status: "unmet", evidence: "blocking", publicSummary: "", requirement: "spec" },
        ],
        overall: "pass",
        notes: "",
      },
    }))({
      cwd: dir,
      prompt: "Verify the holdouts",
      target: {
        modelId: "fake/model",
        provider: "fake",
        harness: "fake",
        model: "fake",
        vendor: "fake",
        tier: 1,
        billing: "subscription",
      },
      mode: "readonly",
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 0,
      signal: new AbortController().signal,
      logPath: join(dir, "fake.log"),
      onEvent: () => {},
    });
    const dismissed = renderToString(() => VerifyArtifact({ data: VerifySchema.parse(reply.structured) }));
    expect(dismissed).toContain("unmet (not required)");
    expect(dismissed.split("unmet (not required)").length - 1).toBe(1);
    // Only the blocking row is red; the dismissed row is neutral.
    expect(dismissed.split("badge-unmet").length - 1).toBe(1);
    expect(dismissed).toMatch(/badge-dismissed[^>]*>unmet \(not required\)/);
    expect(dismissed).toContain("pill-succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Run Detail lists local screenshots separately and the artifact panel renders their image URL", async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), "artifact-listing-"));
  const previous = globalThis.fetch,
    oldSource = globalThis.EventSource;
  globalThis.EventSource = class {
    close() {}
  } as unknown as typeof EventSource;
  const { store } = f.factory;
  const run = await f.factory.createRun({ repo: f.repo, prompt: "Local evidence" });
  store.putScreenshot(run.id, "screenshot-42-0.png", "local-only");
  store.putArtifact(run.id, "notes.txt", "notes", "plain evidence");
  const detail = store.getRunDetail(run.id);
  if (!detail) throw new Error("No run detail");
  const routes = createHttpRoutes(f.factory);
  const page = await buildNeedsYouUi(join(dir, "page"));
  const panel = await buildSetupUi(join(dir, "panel"), "ArtifactsPanel");
  const requested: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const path = String(input);
      requested.push(path);
      if (path.includes("/artifacts/"))
        return (routes["/api/runs/:id/artifacts/:name"] as Route)(
          requestWithParams(`http://127.0.0.1${path}`, {}, { id: run.id, name: "notes.txt" }),
          localServer,
        );
      const routeKey = path.endsWith("/screenshots") ? "/api/runs/:id/screenshots" : "/api/runs/:id";
      if (path !== `/api/runs/${run.id}` && path !== `/api/runs/${run.id}/screenshots`)
        throw new Error(`Unexpected request ${path}`);
      return (routes[routeKey] as Route)(
        requestWithParams(`http://127.0.0.1${path}`, {}, { id: run.id }),
        localServer,
      );
    },
    { preconnect() {} },
  );
  try {
    page.mount(detail, true);
    page.start();
    await settle();
    const html = renderToString(() => page.render());
    expect(requested).toContain(`/api/runs/${run.id}/screenshots`);
    expect(html).toContain("screenshot-42-0.png");
    expect(html).toContain("notes.txt");
    expect(store.listArtifacts(run.id)).toMatchObject([{ name: "notes.txt" }]);
    const screenshots = (await (await globalThis.fetch(`/api/runs/${run.id}/screenshots`)).json()) as {
      name: string;
    }[];
    panel.mount({
      runId: run.id,
      artifacts: [
        ...screenshots.map(({ name }) => ({ name, kind: "screenshot", size: 0, createdAt: 0 })),
        ...detail.artifacts,
      ],
    });
    await settle();
    expect(panel.render()).toContain(`<img src="/api/runs/${run.id}/screenshots/screenshot-42-0.png"`);
    await panel.invoke(panel.render(), "button", "notes.txt");
    await settle();
    expect(panel.render()).toContain("plain evidence");
    expect(requested).toContain(`/api/runs/${run.id}/artifacts/notes.txt`);
    expect(requested.some((path) => path.includes("/artifacts/screenshot-"))).toBe(false);
  } finally {
    page.dispose();
    panel.dispose();
    globalThis.fetch = previous;
    globalThis.EventSource = oldSource;
    rmSync(dir, { recursive: true, force: true });
    await f.close();
  }
});
