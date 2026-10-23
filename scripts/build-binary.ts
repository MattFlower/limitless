import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { BUILD_DEFINES } from "../src/release.ts";
import { sh } from "../src/util/proc.ts";

const root = resolve(import.meta.dir, "..");

export async function buildSha(cwd = root): Promise<string> {
  if ("GIT_DIR" in process.env || "GIT_WORK_TREE" in process.env)
    throw new Error("Cannot build Limitless with GIT_DIR or GIT_WORK_TREE overrides");
  const worktree = await sh(["git", "config", "--get-all", "core.worktree"], { cwd, allowFail: true });
  if (worktree.exitCode === 0) throw new Error("Cannot build Limitless with core.worktree configured");
  if (worktree.exitCode !== 1) throw new Error("Cannot inspect build core.worktree configuration");
  const top = (await sh(["git", "rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  if (realpathSync(top) !== realpathSync(cwd))
    throw new Error("Cannot build Limitless: Git checkout root does not match build root");
  const status = await sh(
    ["git", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
    { cwd },
  );
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
    minify: { whitespace: true, syntax: true, identifiers: true, keepNames: true },
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
