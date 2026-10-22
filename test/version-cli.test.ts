import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";
import { BUILD_DEFINES } from "../src/release.ts";
import { sh } from "../src/util/proc.ts";

test("version commands ignore environment identity and need no configuration", async () => {
  const home = mkdtempSync(join(tmpdir(), "limitless-version-"));
  try {
    const sha = (
      await sh(["git", "rev-parse", "HEAD"], { cwd: resolve(import.meta.dir, "..") })
    ).stdout.trim();
    const env = {
      ...process.env,
      // Keep Bun's transpiler cache out of the empty home being checked.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HOME: home,
      LIMITLESS_HOME: home,
      LIMITLESS_CONFIG_DIR: home,
      [BUILD_DEFINES.version]: "bogus",
      [BUILD_DEFINES.sha]: "b".repeat(40),
      LIMITLESS_VERSION: "bogus",
      LIMITLESS_SHA: "c".repeat(40),
    };
    for (const args of [["version", "--json"], ["--version"], ["version"]]) {
      const result = await sh([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], {
        cwd: home,
        env,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      if (args.includes("--json"))
        expect(JSON.parse(result.stdout)).toEqual({ version, sha, kind: "source", bun: Bun.version });
      else {
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        expect(result.stdout).toContain(version);
        expect(result.stdout).not.toContain("Usage:");
      }
      expect(readdirSync(home)).toEqual([]);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
