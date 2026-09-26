import { transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
// @ts-expect-error — babel presets ship without type declarations
import solid from "babel-preset-solid";
import type { BunPlugin } from "bun";

/** Compiles SolidJS JSX for Bun's bundler (used by the dev server and `bun build`). */
const solidPlugin: BunPlugin = {
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.(tsx|jsx)$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = await transformAsync(source, {
        filename: args.path,
        presets: [
          [solid, { generate: "dom", hydratable: false }],
          [ts, { isTSX: true, allExtensions: true }],
        ],
        sourceMaps: "inline",
      });
      return { contents: result?.code ?? "", loader: "js" };
    });
  },
};

export default solidPlugin;
