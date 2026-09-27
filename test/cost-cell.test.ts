import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;

test("cost cells lead with equivalent work and bold meaningful paid spend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-cost-cell-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../ui/components/CostCell.tsx")],
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
    if (!output) throw new Error("No cost cell output");
    const { CostCell } = (await import(output.path)) as typeof import("../ui/components/CostCell.tsx");
    const tiny = renderToString(() => CostCell({ costUsd: 0.0002, costEquivUsd: 4.34 }));
    expect(tiny).toContain('title="API-equivalent $4.34 · paid $0.0002"');
    expect(tiny).toContain("≈$4.34");
    expect(tiny).not.toContain('class="bold"');
    const paid = renderToString(() => CostCell({ costUsd: 0.19, costEquivUsd: 6.75 }));
    expect(paid).toContain('title="API-equivalent $6.75 · paid $0.19"');
    expect(paid).toContain('class="bold"> $0.19</span>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
