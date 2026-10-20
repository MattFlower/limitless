import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

for (const [toml, expected] of [
  ["", "off"],
  ["[deploy]\n", "off"],
  ['[deploy]\nafter_land = "off"', "off"],
  ['[deploy]\nafter_land = "when_idle"', "when_idle"],
] as const) {
  test(`deploy config defaults and opt-in: ${toml}`, () => {
    const root = mkdtempSync(join(tmpdir(), "limitless-deploy-config-"));
    try {
      writeFileSync(join(root, "config.toml"), toml);
      expect(loadConfig({ home: join(root, "data"), configDir: root }).deploy.afterLand).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
for (const [toml, key] of [
  ['deploy = "when_idle"', "deploy.after_land"],
  ['[deploy]\nafter_land = "always"', "deploy.after_land"],
  ['[deploy]\nafter_lnad = "when_idle"', "deploy.after_lnad"],
  ["deploy = []", "deploy.after_land"],
  ["deploy = true", "deploy.after_land"],
  ["deploy = 2020-01-01T00:00:00Z", "deploy.after_land"],
  ["[deploy]\nafter_land = false", "deploy.after_land"],
] as const) {
  test(`invalid deploy config names offending key: ${toml}`, () => {
    const root = mkdtempSync(join(tmpdir(), "limitless-deploy-config-"));
    try {
      writeFileSync(join(root, "config.toml"), toml);
      expect(() => loadConfig({ home: join(root, "data"), configDir: root })).toThrow(key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
