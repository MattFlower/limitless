import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupCommand } from "../src/cli/setup.ts";
import { BUILD_DEFINES } from "../src/release.ts";
import { packagedRelease, setupFixture } from "./setup-support.ts";

test("packaged init prints and persists the smoke skip using its production smoke adapter", async () => {
  const f = setupFixture(undefined, { release: packagedRelease });
  try {
    expect(await setupCommand("init", { yes: true }, f.d)).toBe(0);
    expect(f.output).toContain(
      'smoke: [{"name":"live","status":"skip","reason":"Live smoke requires a source installation","durationMs":0}]',
    );
    expect(JSON.parse(readFileSync(f.smokeFile, "utf8"))).toEqual([
      { name: "live", status: "skip", reason: "Live smoke requires a source installation", durationMs: 0 },
    ]);
    expect(f.effects).toEqual(["mcp"]);
  } finally {
    f.close();
  }
});

for (const history of ["missing", "failed"])
  test(`packaged doctor describes smoke as skipped with ${history} history, without effects`, async () => {
    const f = setupFixture('[owners]\ngithub = "acme"\n', { release: packagedRelease });
    try {
      if (history === "failed") {
        mkdirSync(f.home);
        writeFileSync(f.smokeFile, JSON.stringify([{ name: "old live check", status: "fail" }]));
      }
      f.d.readJson = async () => {
        throw new Error("Packaged doctor must not read smoke history");
      };
      const before = f.snapshot();
      for (const json of [false, true]) {
        f.output.length = 0;
        expect(await setupCommand("doctor", { json }, f.d)).toBe(0);
        if (json) {
          const checks = JSON.parse(f.output[0] ?? "").checks as {
            id: string;
            status: string;
            message: string;
            fix?: string;
          }[];
          expect(checks.find((c) => c.id === "smoke")).toEqual({
            id: "smoke",
            status: "ok",
            message: "Live smoke skipped: requires a source installation",
          });
        } else {
          expect(f.output).toContain("ok smoke: Live smoke skipped: requires a source installation");
          expect(f.output.join("\n")).not.toContain("run limitless init");
        }
        expect(f.snapshot()).toEqual(before);
      }
      expect(f.effects).toEqual([]);
    } finally {
      f.close();
    }
  });

test("packaged setup bundle excludes the live smoke module and its adapter returns a skip", async () => {
  const f = setupFixture(undefined, { release: packagedRelease });
  try {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/cli/setup.ts")],
      target: "bun",
      metafile: true,
      define: {
        [BUILD_DEFINES.packaged]: "true",
        [BUILD_DEFINES.version]: JSON.stringify(packagedRelease.version),
        [BUILD_DEFINES.sha]: JSON.stringify(packagedRelease.sha),
      },
      plugins: [
        {
          name: "forbid-live-smoke",
          setup(build) {
            build.onResolve({ filter: /(?:^|\/)smoke\.ts$/ }, () => {
              throw new Error("Live smoke import forbidden in packaged setup");
            });
          },
        },
      ],
    });
    if (!result.success || !result.metafile)
      throw new AggregateError(result.logs, "Packaged setup bundle failed");
    expect(Object.keys(result.metafile.inputs).filter((p) => p.endsWith("/scripts/smoke.ts"))).toEqual([]);
    const path = join(f.root, "setup-bundle.mjs");
    const bundle = result.outputs[0];
    if (!bundle) throw new Error("Missing setup bundle");
    await Bun.write(path, bundle);
    const probe = `const { setupDeps } = await import(${JSON.stringify(path)}); console.log(JSON.stringify(await setupDeps(${JSON.stringify({ configDir: f.configDir, home: f.home, appDir: f.d.appDir, release: packagedRelease })}).smoke()));`;
    const child = Bun.spawn([process.execPath, "--eval", probe], {
      cwd: f.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([
      { name: "live", status: "skip", reason: "Live smoke requires a source installation", durationMs: 0 },
    ]);
  } finally {
    f.close();
  }
});
