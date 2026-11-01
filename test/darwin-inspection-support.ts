import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function loadNativeInspection(directory: string) {
  const fixturePath = join(import.meta.dir, "darwin-inspection-fixture.ts");
  const sourcePath = join(import.meta.dir, "../src/util/processes-darwin.ts");
  const entry = join(directory, "native.ts");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(sourcePath)}; export * from ${JSON.stringify(fixturePath)};`,
  );
  const build = await Bun.build({
    entrypoints: [entry],
    outdir: join(directory, "build"),
    target: "bun",
    plugins: [
      {
        name: "synthetic-libproc",
        setup(builder) {
          // Bun keeps built-in modules external; redirect the native import before bundling.
          builder.onLoad({ filter: /processes-darwin\.ts$/ }, async (args) => ({
            contents: (await Bun.file(args.path).text())
              .replace('from "bun:ffi";', `from ${JSON.stringify(fixturePath)};`)
              .replace('from "node:os";', `from ${JSON.stringify(fixturePath)};`)
              .replace('from "node:fs";', `from ${JSON.stringify(fixturePath)};`),
            loader: "ts",
          }));
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("No synthetic native inspection build output");
  return (await import(output.path)) as typeof import("../src/util/processes-darwin.ts") &
    typeof import("./darwin-inspection-fixture.ts");
}
