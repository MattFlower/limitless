import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { BUILD_DEFINES } from "../src/release.ts";
import { sh } from "../src/util/proc.ts";

const root = resolve(import.meta.dir, "..");

export async function buildSha(cwd = root): Promise<string> {
  const status = await sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd });
  if (status.stdout.trim()) throw new Error("Cannot build Limitless from a dirty tree");
  const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Cannot resolve build HEAD SHA");
  return sha;
}

export function buildConfig(identity: { version: string; sha: string }, outdir: string): Bun.BuildConfig {
  return {
    entrypoints: [resolve(root, "src/cli/main.ts")],
    outdir,
    target: "bun",
    format: "esm",
    compile: {
      outfile: resolve(outdir, "limitless"),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    minify: { keepNames: true },
    sourcemap: "linked",
    env: "disable",
    metafile: true,
    define: {
      [BUILD_DEFINES.version]: JSON.stringify(identity.version),
      [BUILD_DEFINES.sha]: JSON.stringify(identity.sha),
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { outdir: { type: "string" } } });
  if (!values.outdir) throw new Error("Usage: bun scripts/build-binary.ts --outdir <dir>");
  const result = await Bun.build(buildConfig({ version, sha: await buildSha() }, values.outdir));
  if (!result.success) throw new AggregateError(result.logs, "Binary build failed");
  await Bun.write(resolve(values.outdir, "metafile.json"), JSON.stringify(result.metafile));
}

if (import.meta.main)
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
