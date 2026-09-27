import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("Dependabot routing defaults to free-first and accepts either configured mode", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-routing-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect(config().dependabotRouting).toBe("free_first");
    for (const value of ["free_first", "policy"] as const) {
      writeFileSync(join(configDir, "config.toml"), `[routing]\ndependabot = "${value}"\n`);
      expect(config().dependabotRouting).toBe(value);
    }
    writeFileSync(join(configDir, "config.toml"), '[routing]\ndependabot = "other"\n');
    expect(config).toThrow('routing.dependabot must be "free_first" or "policy"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
