import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Release, release, resourcePath, sourceUiPlugin } from "../release.ts";
import { UI_RESOURCE, uiBuildOptions } from "./ui-build.ts";

/** Build once; direct Bun HTML mounts bypass the socket-peer authorization wrapper. */
export async function buildUi(info: Release = release): Promise<Record<string, Blob>> {
  if (info.kind === "source") {
    const result = await Bun.build(uiBuildOptions(await sourceUiPlugin()));
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
