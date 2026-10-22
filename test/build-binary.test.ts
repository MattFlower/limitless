import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, buildSha } from "../scripts/build-binary.ts";
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
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-build-"));
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

test("binary config seals autoloading and embeds only explicit identity", () => {
  const identity = { version: "3.2.1", sha: "d".repeat(40) };
  const config = buildConfig(identity, dir);
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
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  });
  expect(config.env).toBe("disable");
  expect(config.metafile).toBe(true);
  expect(config.minify).toMatchObject({ keepNames: true });
  expect(config.sourcemap).toBeTruthy();
  expect(config.define).toEqual({
    [BUILD_DEFINES.version]: JSON.stringify(identity.version),
    [BUILD_DEFINES.sha]: JSON.stringify(identity.sha),
  });
});
