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
    const { OriginalPrompt, copyPrompt, promptNeedsExpansion } = (await import(
      output.path
    )) as typeof import("../ui/components/OriginalPrompt.tsx");

    const prompt = [
      "First line",
      "Second <script>alert('x')</script> line",
      "  Indented third line  ",
      "",
      "Fifth line, hidden while collapsed",
      "unbroken".repeat(100),
      "Final line\r\n",
    ].join("\n");
    const html = renderToString(() => OriginalPrompt({ prompt }));
    expect(html).toContain("Original prompt");
    expect(html).toContain("First line\nSecond &lt;script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Copy prompt");
    expect(html).toContain("collapsed");
    expect(html).toContain("  Indented third line  \n\nFifth line");
    expect(html).toContain("Final line\r\n");

    // Use rendered heights: the same text can need a toggle only at narrow widths.
    const lineHeight = 19.5;
    const wrappedPrompt = "unbroken".repeat(100);
    expect(promptNeedsExpansion(wrappedPrompt, lineHeight * 4, lineHeight)).toBe(false);
    expect(promptNeedsExpansion(wrappedPrompt, lineHeight * 5, lineHeight)).toBe(true);
    expect(promptNeedsExpansion("One\nTwo\nThree\nFour", lineHeight * 4, lineHeight)).toBe(false);
    expect(promptNeedsExpansion("One\nTwo\nThree\nFour\nFive", lineHeight * 5, lineHeight)).toBe(true);
    for (const blankPrompt of ["", " ", "\n\n\n\n\n\n", " \t\r\n \n\t\n\n\n\n"]) {
      expect(promptNeedsExpansion(blankPrompt, lineHeight * 7, lineHeight)).toBe(false);
      let blankCopied: string | undefined;
      expect(
        await copyPrompt(blankPrompt, {
          writeText: async (text) => {
            blankCopied = text;
          },
        }),
      ).toBe("Prompt copied");
      expect(blankCopied).toBe(blankPrompt);
    }

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

    const write = Promise.withResolvers<void>();
    let feedback: string | undefined;
    const copying = copyPrompt(prompt, { writeText: () => write.promise }).then((result) => {
      feedback = result;
    });
    await Promise.resolve();
    expect(feedback).toBeUndefined();
    write.reject(new Error("Permission denied after awaiting clipboard access"));
    await copying;
    expect(feedback).toBe("Could not copy prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
