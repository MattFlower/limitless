import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { BUILD_DEFINES } from "../src/release.ts";
import { UI_RESOURCE, uiBuildOptions } from "../src/server/ui-build.ts";
import { sh } from "../src/util/proc.ts";
import solidPlugin from "./solid-plugin.ts";

const root = resolve(import.meta.dir, "..");

// Embedded unchanged (no loader); each lands at its basename under the binary's `import.meta.dir`.
export const EMBEDDED_RESOURCES = [
  "src/db/migrations",
  "routing/policy.json",
  "integrations/codex/.agents/skills/limitless/SKILL.md",
];

export function checkAssets(assets: string[]): string[] {
  const seen = new Set<string>();
  for (const asset of assets) {
    if (!existsSync(asset)) throw new Error(`Cannot build Limitless: missing embedded resource ${asset}`);
    if (seen.has(basename(asset)))
      throw new Error(`Cannot build Limitless: embedded resources share the basename ${basename(asset)}`);
    seen.add(basename(asset));
  }
  return assets;
}

export async function buildSha(cwd = root): Promise<string> {
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    if (name in process.env) throw new Error(`Cannot build Limitless with ${name} override`);
  }
  const worktree = await sh(["git", "config", "--get-all", "core.worktree"], { cwd, allowFail: true });
  if (worktree.exitCode === 0) throw new Error("Cannot build Limitless with core.worktree configured");
  if (worktree.exitCode !== 1) throw new Error("Cannot inspect build core.worktree configuration");
  const top = (await sh(["git", "rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  if (realpathSync(top) !== realpathSync(cwd))
    throw new Error("Cannot build Limitless: Git checkout root does not match build root");
  const index = await sh(["git", "ls-files", "-v", "-z"], { cwd });
  if (index.stdout.split("\0").some((entry) => /^[a-zS] /.test(entry)))
    throw new Error("Cannot build Limitless with assume-unchanged or skip-worktree index entries");
  const status = await sh(
    ["git", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
    { cwd },
  );
  if (status.stdout.trim()) throw new Error("Cannot build Limitless from a dirty tree");
  const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Cannot resolve build HEAD SHA");
  return sha;
}

export async function stageUi(stagingRoot: string) {
  const directory = join(stagingRoot, UI_RESOURCE);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const result = await Bun.build({ ...uiBuildOptions(solidPlugin), outdir: directory });
  if (!result.success) throw new AggregateError(result.logs, "UI build failed");
  return { directory, outputs: result.outputs };
}

export function validateMetafile(metafile: { inputs: Record<string, unknown> }): void {
  if (
    Object.keys(metafile.inputs).some((path) =>
      /(?:^|\/)node_modules\/(?:@babel\/|babel-preset-solid\/)/.test(path),
    )
  )
    throw new Error("Cannot build Limitless: Babel dependency in binary metafile");
}

export function buildConfig(
  identity: { version: string; sha: string },
  outdir: string,
  uiDirectory: string,
): Bun.BuildConfig {
  return {
    entrypoints: [resolve(root, "src/cli/main.ts")],
    outdir,
    target: "bun",
    format: "esm",
    compile: {
      outfile: resolve(outdir, "limitless"),
      assets: checkAssets([...EMBEDDED_RESOURCES.map((path) => resolve(root, path)), uiDirectory]),
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
      [BUILD_DEFINES.packaged]: "true",
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { outdir: { type: "string" } } });
  if (!values.outdir) throw new Error("Usage: bun scripts/build-binary.ts --outdir <dir>");
  const identity = { version, sha: await buildSha() };
  const stagingRoot = mkdtempSync(join(tmpdir(), "limitless-build-ui-"));
  try {
    const { directory } = await stageUi(stagingRoot);
    const result = await Bun.build(buildConfig(identity, values.outdir, directory));
    if (!result.success) throw new AggregateError(result.logs, "Binary build failed");
    try {
      if (!result.metafile) throw new Error("Binary build returned no metafile");
      validateMetafile(result.metafile);
    } catch (error) {
      rmSync(resolve(values.outdir, "limitless"), { force: true });
      throw error;
    }
    await Bun.write(resolve(values.outdir, "metafile.json"), JSON.stringify(result.metafile));
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (import.meta.main)
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
