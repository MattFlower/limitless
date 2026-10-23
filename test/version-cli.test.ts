import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

for (const origin of ["runtime globals", "caller bunfig"]) {
  test.each(["complete", "version only", "SHA only"])(`source ignores ${origin}: %s`, async (override) => {
    const scratch = mkdtempSync(join(tmpdir(), "limitless-identity-"));
    const home = join(scratch, "home");
    const cwd = join(scratch, "caller");
    mkdirSync(home);
    mkdirSync(cwd);
    const root = resolve(import.meta.dir, "..");
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const identity = {
      ...(override !== "SHA only" ? { [BUILD_DEFINES.version]: "foreign-version" } : {}),
      ...(override !== "version only" ? { [BUILD_DEFINES.sha]: "e".repeat(40) } : {}),
    };
    const env = {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HOME: home,
      LIMITLESS_HOME: home,
      LIMITLESS_CONFIG_DIR: home,
    };
    try {
      const cli = join(root, "src/cli/main.ts");
      if (origin === "runtime globals") {
        const preload = join(cwd, "globals.ts");
        writeFileSync(preload, `Object.assign(globalThis, ${JSON.stringify(identity)});`);
        const probe = `
        await import(${JSON.stringify(preload)});
        const { release, resolveReleaseBootSha } = await import(${JSON.stringify(join(root, "src/release.ts"))});
        const { resolveBootSha } = await import(${JSON.stringify(join(root, "src/cli/boot-sha.ts"))});
        console.log(JSON.stringify({ version: release.version, kind: release.kind, bun: release.bun,
          sha: await resolveReleaseBootSha(resolveBootSha) }));
      `;
        const globalResult = await sh([process.execPath, "-e", probe], { cwd, env });
        expect(globalResult.exitCode).toBe(0);
        expect(JSON.parse(globalResult.stdout)).toEqual({ version, sha, kind: "source", bun: Bun.version });
        writeFileSync(
          preload,
          `${JSON.stringify(Object.keys(identity))}.forEach(name => Object.defineProperty(globalThis, name, {
          get() { throw new Error("Runtime identity accessed"); }
        }));`,
        );
        const unread = await sh([process.execPath, "-e", probe], { cwd, env });
        expect(JSON.parse(unread.stdout)).toEqual({ version, sha, kind: "source", bun: Bun.version });
        const help = await sh([process.execPath, "--preload", preload, cli, "--help"], { cwd, env });
        expect(help.exitCode).toBe(0);
        expect(help.stdout).toContain("Usage:");
      } else {
        writeFileSync(
          join(cwd, "bunfig.toml"),
          `[define]\n${Object.entries(identity)
            .map(([name, value]) => `${name} = '${JSON.stringify(value)}'`)
            .join("\n")}\n`,
        );
        const result = await sh([process.execPath, cli, "version", "--json"], { cwd, env });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({ version, sha, kind: "source", bun: Bun.version });
        const definedHelp = await sh([process.execPath, cli, "--help"], { cwd, env });
        expect(definedHelp.exitCode).toBe(0);
        expect(definedHelp.stdout).toContain("Usage:");
      }
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
