import { uiBuildOptions } from "../src/server/ui-build.ts";
import solidPlugin from "./solid-plugin.ts";

const result = await Bun.build({
  ...uiBuildOptions(solidPlugin),
  outdir: "./dist",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  console.log(`Built UI: ${result.outputs.length} files in dist/`);
}
