import { basename, join } from "node:path";
import solidPlugin from "../../scripts/solid-plugin.ts";

/** Build once; direct Bun HTML mounts bypass the socket-peer authorization wrapper. */
export async function buildUi(): Promise<Record<string, Blob>> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../ui/index.html")],
    target: "browser",
    publicPath: "/",
    minify: true,
    plugins: [solidPlugin],
  });
  if (!result.success) throw new AggregateError(result.logs, "UI build failed");
  return Object.fromEntries(result.outputs.map((file) => [`/${basename(file.path)}`, file]));
}
