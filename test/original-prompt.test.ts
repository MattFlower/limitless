import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;

test("original prompt renders plain multiline text and a copy control", async () => {
  const dir = mkdtempSync(join(tmpdir(), "original-prompt-ssr-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../ui/components/OriginalPrompt.tsx")],
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
    if (!output) throw new Error("No prompt build output");
    const { OriginalPrompt, copyPrompt } = (await import(
      output.path
    )) as typeof import("../ui/components/OriginalPrompt.tsx");

    const prompt = "First line\nSecond <script>alert('x')</script> line";
    const html = renderToString(() => OriginalPrompt({ prompt }));
    expect(html).toContain("Original prompt");
    expect(html).toContain("First line\nSecond &lt;script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Copy prompt");

    let copied = "";
    expect(
      await copyPrompt(prompt, {
        writeText: async (text) => {
          copied = text;
        },
      }),
    ).toBe("Prompt copied");
    expect(copied).toBe(prompt);
    expect(
      await copyPrompt(prompt, {
        writeText: async () => {
          throw new Error("Permission denied");
        },
      }),
    ).toBe("Could not copy prompt");
    expect(await copyPrompt(prompt, undefined)).toBe("Could not copy prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
