import solidPlugin from "./solid-plugin.ts";

const result = await Bun.build({
  entrypoints: ["./ui/index.html"],
  outdir: "./dist",
  target: "browser",
  minify: true,
  plugins: [solidPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  console.log(`Built UI: ${result.outputs.length} files in dist/`);
}
