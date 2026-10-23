import { join } from "node:path";
import type { BuildConfig, BunPlugin } from "bun";

export const UI_RESOURCE = "limitless-ui";

export function uiBuildOptions(plugin: BunPlugin): BuildConfig {
  return {
    entrypoints: [join(import.meta.dir, "../../ui/index.html")],
    target: "browser",
    publicPath: "/",
    minify: true,
    plugins: [plugin],
  };
}
