import solidPlugin from "./solid-plugin.ts";

const result = await Bun.build({
  entrypoints: [new URL("../ui/index.html", import.meta.url).pathname],
  outdir: new URL("../dist/ui", import.meta.url).pathname,
  target: "browser",
  plugins: [solidPlugin],
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
