import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
test("Models table renders checkpoint origins with aligned loaded and loading rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-models-"));
  try {
    for (const loaded of [false, true]) {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "../ui/pages/Models.tsx")],
        outdir: join(dir, String(loaded)),
        target: "bun",
        plugins: [
          {
            name: "models-ssr",
            setup(builder) {
              builder.onLoad({ filter: /\/ui\/store\.ts$/ }, () => ({
                contents: "export const live = {providers:{}}; export function ensureLiveStore() {}",
                loader: "js",
              }));
              builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
                let source = await Bun.file(args.path).text();
                // Seed the catalog state for SSR; onMount intentionally does not fetch during rendering.
                if (loaded && args.path.endsWith("/pages/Models.tsx"))
                  source = source.replace(
                    "createSignal<{ models: ModelDef[]; policy: Policy } | null>(null)",
                    `createSignal<{ models: ModelDef[]; policy: Policy } | null>(${JSON.stringify({ models: MODELS, policy: { ...DEFAULT_POLICY, triage: { default: ["codex/luna@low|claude/opus@high"] } } })})`,
                  );
                const result = await transformAsync(source, {
                  filename: args.path,
                  parserOpts: { plugins: ["jsx", "typescript"] },
                  presets: [
                    [solid, { generate: "ssr" }],
                    [ts, {}],
                  ],
                });
                return { contents: result?.code ?? "", loader: "js" };
              });
            },
          },
        ],
      });
      expect(build.success).toBe(true);
      const output = build.outputs[0];
      if (!output) throw new Error("no Models build output");
      const { Models } = (await import(output.path)) as typeof import("../ui/pages/Models.tsx");
      const html = renderToString(() => Models({}));
      const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? "";
      expect(table.match(/<th[ >]/g)).toHaveLength(13);
      if (loaded) {
        const rows = table.match(/<tr>[\s\S]*?<\/tr>/g)?.slice(1) ?? [];
        expect(rows).toHaveLength(MODELS.length);
        for (const row of rows) expect(row.match(/<td[ >]/g)).toHaveLength(13);
        expect(rows.find((row) => row.includes("ministral-14b-2512"))).toContain(">FR</td>");
        expect(rows.find((row) => row.includes("gpt-6-luna"))).toContain(">US</td>");
        expect(rows.find((row) => row.includes("qwen-27b"))).toContain(">CN</td>");
        const jev = rows.find((row) => row.includes("typesafe/jev"));
        expect(jev).toContain(">US</td>");
        expect(jev).toContain(">unknown</td>");
        expect(html).toContain("codex/luna@low|claude/opus@high");
        expect(table).toContain("Supported efforts");
        expect(table).toContain("default: medium");
        expect(table).toContain("backend default");
        expect(table).toContain("none, low, medium, high");
        expect(table).toContain("unsupported");
      } else expect(table).toContain('colspan="13"');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
