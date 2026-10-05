import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { CreateRunRequest } from "../src/core/types.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
type Handler = (event: { currentTarget: { value: string }; preventDefault: () => void }) => Promise<void>;

test("New Run renders six collapsed model fields, sends groups and displays API errors inline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-new-run-ui-"));
  const previousFetch = globalThis.fetch;
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../ui/pages/NewRun.tsx")],
      outdir: dir,
      target: "bun",
      plugins: [
        {
          name: "new-run-ssr-events",
          setup(builder) {
            builder.onLoad({ filter: /NewRun\.tsx$/ }, async (args) => {
              let source = await Bun.file(args.path).text();
              source = source.replace(
                'import { useNavigate } from "@solidjs/router";',
                "const useNavigate = () => (path: string) => navigated.push(path);",
              );
              source = source.replace(
                'import { createSignal, For, onMount, Show } from "solid-js";',
                `import { For, Show } from "solid-js"; import { createSignal } from ${JSON.stringify(join(import.meta.dir, "../node_modules/solid-js/dist/solid.js"))}; const onMount = (fn: () => void) => fn();`,
              );
              source = source.replace(
                '  return (\n    <div class="page">',
                '  const render = () => (\n    <div class="page">',
              );
              source = source.replace(
                /\n {2}\);\n};\s*$/,
                "\n  );\n  activeRender = render; return render();\n};",
              );
              source = source.replace("onSubmit={submit}", '{...capture("submit", submit)}');
              for (const [field, setter] of [
                ["repo", "setRepo"],
                ["prompt", "setPrompt"],
              ])
                source = source.replace(
                  `onInput={(e) => ${setter}(e.currentTarget.value)}`,
                  `{...capture("${field}", (e: { currentTarget: { value: string } }) => ${setter}(e.currentTarget.value))}`,
                );
              source = source.replace(
                "onInput={(e) => setModels({ ...models(), [role]: e.currentTarget.value })}",
                '{...capture("model-" + role, (e: { currentTarget: { value: string } }) => setModels({ ...models(), [role]: e.currentTarget.value }))}',
              );
              source += `
            export const navigated: string[] = [];
            export const handlers = new Map();
            const capture = (key: string, handler: unknown) => { handlers.set(key, handler); return {}; };
            let activeRender: () => ReturnType<typeof NewRun>;
            export const mount = () => NewRun({});
            export const render = () => { handlers.clear(); return activeRender(); };
          `;
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
    const sent: CreateRunRequest[] = [];
    let fail = true;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/repos")) return Response.json([{ slug: "owner/repo" }]);
        sent.push(JSON.parse(String(init?.body)) as CreateRunRequest);
        return fail
          ? Response.json(
              { error: 'models.implement entry "unknown": unknown model ID "unknown"' },
              { status: 400 },
            )
          : Response.json({ id: "created" });
      },
      { preconnect() {} },
    );
    const ui = (await import(join(dir, "NewRun.js"))) as {
      mount: () => void;
      render: () => ReturnType<typeof renderToString>;
      handlers: Map<string, Handler>;
      navigated: string[];
    };
    ui.mount();
    const render = () => renderToString(() => ui.render());
    const initial = render();
    expect(initial).toContain("Models (optional)");
    expect(initial).not.toContain("<details open");
    for (const role of ["triage", "spec", "holdout", "implement", "review", "verify"])
      expect(initial).toContain(`id="model-${role}"`);
    const invoke = async (key: string, value = "") => {
      const handler = ui.handlers.get(key);
      if (!handler) throw new Error(`missing rendered ${key} handler`);
      await handler({ currentTarget: { value }, preventDefault() {} });
    };
    await invoke("repo", "owner/repo");
    await invoke("prompt", "Try a model");
    await invoke("model-implement", "unknown");
    await invoke("model-review", "claude/opus@high|codex/sol, codex/luna");
    await invoke("submit");
    expect(sent[0]?.models).toEqual({
      implement: ["unknown"],
      review: ["claude/opus@high|codex/sol", "codex/luna"],
    });
    const invalid = render();
    expect(invalid).toContain('role="alert"');
    expect(invalid.match(/role="alert"/g)).toHaveLength(1);
    expect(invalid).toContain("unknown model ID");
    expect(invalid).toContain("<details open");
    await invoke("model-implement", "codex/sol");
    fail = false;
    await invoke("submit");
    expect(sent[1]?.models?.implement).toEqual(["codex/sol"]);
    expect(ui.navigated).toEqual(["/runs/created"]);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
