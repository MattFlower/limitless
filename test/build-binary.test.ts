import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, buildSha, checkAssets, validateMetafile } from "../scripts/build-binary.ts";
import { BUILD_DEFINES } from "../src/release.ts";
import { sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

const seed = seeded(async (cwd) => {
  await sh(["git", "init"], { cwd });
  writeFileSync(join(cwd, "tracked"), "original\n");
  writeFileSync(join(cwd, ".gitignore"), "ignored\n");
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-m", "seed"], { cwd });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
});
const submoduleSeed = seeded(async (cwd) => {
  await seed(cwd);
  const source = mkdtempSync(join(tmpdir(), "limitless-submodule-"));
  try {
    await seed(source);
    await sh(["git", "-c", "protocol.file.allow=always", "submodule", "add", source, "sub"], { cwd });
    await sh(["git", "commit", "-am", "submodule"], { cwd });
    await sh(["git", "config", "diff.ignoreSubmodules", "all"], { cwd });
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-build-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("clean and ignored files build from the given checkout", async () => {
  const { value: sha } = await seed(dir);
  expect(await buildSha(dir)).toBe(sha);
  writeFileSync(join(dir, "ignored"), "ignored\n");
  expect(await buildSha(dir)).toBe(sha);
});

test("modified tracked files refuse", async () => {
  await seed(dir);
  writeFileSync(join(dir, "tracked"), "changed\n");
  await expect(buildSha(dir)).rejects.toThrow("dirty tree");
});

test.each(["assume-unchanged", "skip-worktree"])("%s cannot hide tracked changes", async (flag) => {
  await seed(dir);
  await sh(["git", "update-index", `--${flag}`, "tracked"], { cwd: dir });
  writeFileSync(join(dir, "tracked"), "changed\n");
  await expect(buildSha(dir)).rejects.toThrow("assume-unchanged or skip-worktree");
});

test.each([false, true])("untracked files refuse even with hidden status=%s", async (hidden) => {
  await seed(dir);
  if (hidden) await sh(["git", "config", "status.showUntrackedFiles", "no"], { cwd: dir });
  writeFileSync(join(dir, "untracked"), "new\n");
  await expect(buildSha(dir)).rejects.toThrow("dirty tree");
});

test("a checkout without HEAD refuses", async () => {
  const empty = join(dir, "empty");
  mkdirSync(empty);
  await sh(["git", "init"], { cwd: empty });
  await expect(buildSha(empty)).rejects.toThrow();
});

test("modified committed submodules refuse despite hidden submodule diffs", async () => {
  await submoduleSeed(dir);
  await buildSha(dir);
  writeFileSync(join(dir, "sub", "tracked"), "changed\n");
  await expect(buildSha(dir)).rejects.toThrow("dirty tree");
});

test("core.worktree cannot redirect a dirty checkout to a clean copy", async () => {
  const dirty = join(dir, "dirty");
  const clean = join(dir, "clean");
  await seed(dirty);
  await seed(clean);
  writeFileSync(join(dirty, "tracked"), "changed\n");
  await sh(["git", "config", "core.worktree", clean], { cwd: dirty });
  await expect(buildSha(dirty)).rejects.toThrow("core.worktree");
});

test.each([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
])("%s overrides refuse even when empty", async (name) => {
  await seed(dir);
  const original = process.env[name];
  try {
    for (const value of [dir, ""]) {
      process.env[name] = value;
      await expect(buildSha(dir)).rejects.toThrow(name);
    }
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("build root must be the Git top-level directory", async () => {
  await seed(dir);
  const nested = join(dir, "ignored");
  mkdirSync(nested);
  await expect(buildSha(nested)).rejects.toThrow("checkout root");
});

test("binary config seals autoloading and embeds only explicit identity", () => {
  const identity = { version: "3.2.1", sha: "d".repeat(40) };
  const config = buildConfig(identity, dir, dir);
  expect(config.outdir).toBe(dir);
  expect(config.entrypoints).toHaveLength(1);
  const entry = config.entrypoints?.[0];
  expect(typeof entry).toBe("string");
  if (typeof entry !== "string") throw new Error("Missing entrypoint");
  expect(entry.endsWith("/src/cli/main.ts")).toBe(true);
  expect(existsSync(entry)).toBe(true);
  expect(config.target).toBe("bun");
  expect(config.format).toBe("esm");
  expect(config.bytecode).toBeFalsy();
  expect(config.compile).toEqual({
    outfile: join(dir, "limitless"),
    assets: [
      "src/db/migrations",
      "routing/policy.json",
      "integrations/codex/.agents/skills/limitless/SKILL.md",
    ]
      .map((path) => join(import.meta.dir, "..", path))
      .concat(dir),
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  });
  expect(config.env).toBe("disable");
  expect(config.metafile).toBe(true);
  expect(config.minify).toEqual({ whitespace: true, syntax: true, identifiers: true, keepNames: true });
  expect(config.sourcemap).toBeTruthy();
  expect(config.define).toEqual({
    [BUILD_DEFINES.version]: JSON.stringify(identity.version),
    [BUILD_DEFINES.sha]: JSON.stringify(identity.sha),
    [BUILD_DEFINES.packaged]: "true",
  });
});

test("the binary embeds the three runtime resources from the checkout, unchanged", () => {
  const checkout = join(import.meta.dir, "..");
  const expected = [
    join(checkout, "src/db/migrations"),
    join(checkout, "routing/policy.json"),
    join(checkout, "integrations/codex/.agents/skills/limitless/SKILL.md"),
  ];
  const config = buildConfig({ version: "1.0.0", sha: "a".repeat(40) }, dir, dir);
  expect(typeof config.compile === "object" && config.compile.assets).toEqual([...expected, dir]);
  for (const asset of expected) expect(existsSync(asset)).toBe(true);
  expect(config.loader).toBeUndefined();
  expect(config.plugins).toBeUndefined();
});

test("asset validation refuses missing resources and shared basenames", () => {
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "a", "policy.json"), "{}");
  writeFileSync(join(dir, "b", "policy.json"), "{}");
  expect(() => checkAssets([join(dir, "a", "policy.json"), join(dir, "missing")])).toThrow(
    `missing embedded resource ${join(dir, "missing")}`,
  );
  expect(() => checkAssets([join(dir, "a", "policy.json"), join(dir, "b", "policy.json")])).toThrow(
    "share the basename policy.json",
  );
  expect(checkAssets([join(dir, "a", "policy.json")])).toEqual([join(dir, "a", "policy.json")]);
});

test.each(["node_modules/@babel/core/lib/index.js", "/build/node_modules/babel-preset-solid/index.js"])(
  "binary metafile rejects %s",
  (input) => {
    expect(() => validateMetafile({ inputs: { [input]: {} } })).toThrow("Babel dependency");
  },
);

test("binary metafile accepts dependencies outside Babel", () => {
  expect(() =>
    validateMetafile({ inputs: { "node_modules/solid-js/index.js": {}, "src/cli/main.ts": {} } }),
  ).not.toThrow();
});
