import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationUnits } from "../src/cli/service.ts";

test("installation selects only explicitly requested rollback and tunnel agents", () => {
  for (const mtplx of [undefined, false, true])
    for (const tunnel of [null, "/tunnel.yml"]) {
      const units = installationUnits({ mtplx }, tunnel);
      expect(units.map(([label]) => label)).toEqual([
        "cc.mattflower.limitless",
        ...(mtplx ? ["cc.mattflower.limitless-mtplx"] : []),
        ...(tunnel ? ["cc.mattflower.limitless-tunnel"] : []),
      ]);
      expect(units[0]?.[1]).toContain("serve");
      if (mtplx) expect(units[1]?.[1]).toContain("mtplx-local");
    }
});

test("service CLI dispatches opt-in mtplx and advertises the new flag", async () => {
  // A temporary config, never the user's: --tunnel reads [server] public_url from it.
  const configDir = mkdtempSync(join(tmpdir(), "limitless-service-cli-"));
  writeFileSync(join(configDir, "config.toml"), '[server]\npublic_url = "https://hooks.example.test"\n');
  const env = { ...process.env, LIMITLESS_CONFIG_DIR: configDir, LIMITLESS_HOME: join(configDir, "home") };
  for (const flags of [[], ["--mtplx", "--tunnel"], ["--help"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        "./test/fixtures/service-cli-preload.ts",
        "src/cli/main.ts",
        "service",
        "install",
        ...flags,
      ],
      { stdout: "pipe", stderr: "pipe", env },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    if (flags.includes("--help")) {
      expect(output).toContain("[--mtplx]");
      expect(output).not.toContain("--no-mtplx");
    } else {
      const on = flags.length > 0;
      const publicUrl = on ? "https://hooks.example.test" : null;
      expect(output).toContain(JSON.stringify({ tunnel: on, mtplx: on, publicUrl }));
    }
  }
  rmSync(configDir, { recursive: true, force: true });
});
