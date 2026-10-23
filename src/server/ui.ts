import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { PACKAGED_BUILD, type Release, release, resourcePath } from "../release.ts";
import { UI_RESOURCE, uiBuildOptions } from "./ui-build.ts";

/** Build once; direct Bun HTML mounts bypass the socket-peer authorization wrapper. */
export async function buildUi(info: Release = release): Promise<Record<string, Blob>> {
  if (!PACKAGED_BUILD && info.kind === "source") {
    const { default: solidPlugin } = await import("../../scripts/solid-plugin.ts");
    const result = await Bun.build(uiBuildOptions(solidPlugin));
    if (!result.success) throw new AggregateError(result.logs, "UI build failed");
    return Object.fromEntries(result.outputs.map((file) => [`/${basename(file.path)}`, file]));
  }
  const directory = resourcePath(UI_RESOURCE, info);
  if (!existsSync(join(directory, "index.html")))
    throw new Error(`Packaged Limitless is missing its embedded UI or index.html: ${directory}`);
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [`/${name}`, Bun.file(join(directory, name))]),
  );
}
