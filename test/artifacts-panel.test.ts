import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";

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
    const { VerifyArtifact } = (await import(
      output.path
    )) as typeof import("../ui/components/ArtifactsPanel.tsx");
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
