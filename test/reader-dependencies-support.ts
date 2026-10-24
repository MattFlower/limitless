import { expect } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildClaudeArgs } from "../src/harness/claude.ts";
import { buildCodexArgs } from "../src/harness/codex.ts";
import { withScratch } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { agentEnv, sh } from "../src/util/proc.ts";

// An offline zod-shaped package distinguishes the v4 API from an incompatible ancestor.
export function dependencyPackage(path: string, version: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name: "zod", version, type: "module", main: "index.js" }),
  );
  writeFileSync(
    join(path, "index.js"),
    `export const version = ${JSON.stringify(version)}; export const floors = ${version.startsWith("4.") ? '{ prefault() { return "expected"; } }' : "{}"};\n`,
  );
}

export async function readerDependencyFixture(cwd: string, version = "4.0.0") {
  dependencyPackage(join(cwd, `vendor/zod-${version}`), version);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ private: true, dependencies: { zod: `file:./vendor/zod-${version}` } }),
  );
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\nsetup-env.json\n");
  writeFileSync(
    join(cwd, "dependency-probe.ts"),
    'import { version, floors } from "zod"; console.log(JSON.stringify({ path: import.meta.resolve("zod"), version, prefault: typeof floors.prefault }));\n',
  );
  await withScratch(cwd, (scratch) =>
    sh(
      [
        process.execPath,
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--cache-dir",
        join(scratch, "bun"),
      ],
      { cwd, env: agentEnv({ HOME: scratch }), timeoutMs: 10_000 },
    ),
  );
  return `${JSON.stringify(process.execPath)} install --frozen-lockfile --ignore-scripts`;
}

export async function importReaderDependency(cwd: string) {
  const result = await sh([process.execPath, "dependency-probe.ts"], { cwd });
  return JSON.parse(result.stdout) as { path: string; version: string; prefault: string };
}

export async function expectReaderDependency(cwd: string, version = "4.0.0") {
  const result = await importReaderDependency(cwd);
  expect(result).toEqual({
    path: `file://${realpathSync(join(cwd, "node_modules/zod/index.js"))}`,
    version,
    prefault: "function",
  });
  return result;
}

export function expectPrivateSetup(cwd: string) {
  const env = JSON.parse(readFileSync(join(cwd, "setup-env.json"), "utf8")) as Record<string, string>;
  expect(env.HOME).toBe(env.TMPDIR);
  for (const key of ["BUN_INSTALL_CACHE_DIR", "npm_config_cache", "XDG_CACHE_HOME"])
    expect(env[key]?.startsWith(`${env.TMPDIR}/`)).toBe(true);
}

export const captureSetupEnv = `${JSON.stringify(process.execPath)} -e 'await Bun.write("setup-env.json", JSON.stringify(Object.fromEntries(["HOME", "TMPDIR", "BUN_INSTALL_CACHE_DIR", "npm_config_cache", "XDG_CACHE_HOME"].map(k => [k, process.env[k]]))))'`;

export function expectReaderPermissions(spec: AgentSpec) {
  if (!spec.scratchDir) throw new Error("Reader requires scratch");
  if (spec.target.harness === "claude") {
    const args = buildClaudeArgs(spec, "reader-test");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");
    expect(settings.sandbox.filesystem.allowWrite).toEqual([spec.scratchDir]);
    expect(settings.sandbox.filesystem.denyWrite).toContain(realpathSync(spec.cwd));
  } else {
    const permission = buildCodexArgs(spec).find((arg) => arg.startsWith("permissions=")) ?? "";
    const parsed = Bun.TOML.parse(permission) as {
      permissions: { "limitless-reader": { filesystem: Record<string, string> } };
    };
    const filesystem = parsed.permissions["limitless-reader"].filesystem;
    expect(Object.entries(filesystem).filter(([, access]) => access === "write")).toEqual([
      [spec.scratchDir, "write"],
    ]);
  }
}
