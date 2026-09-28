import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { PROVIDERS } from "../src/router/catalog.ts";

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

test("provider concurrency overrides reach the tracker without changing catalog defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-provider-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  try {
    writeFileSync(join(configDir, "secrets.env"), "OMLX_API_KEY=file-key\n");
    expect(loadConfig({ home: join(root, "data"), configDir }).secrets.OMLX_API_KEY).toBe(
      process.env.OMLX_API_KEY || "file-key",
    );
    const defaults = new Factory(loadConfig({ home: join(root, "defaults"), configDir }));
    expect(defaults.tracker.status("omlx")?.maxConcurrent).toBe(4);
    defaults.store.close();
    writeFileSync(
      join(configDir, "config.toml"),
      "[providers.claude]\nmax_concurrent = 5\n[providers.omlx]\nmax_concurrent = 8\n",
    );
    const cfg = loadConfig({ home: join(root, "data"), configDir });
    const factory = new Factory(cfg);
    try {
      expect(factory.tracker.status("claude")?.maxConcurrent).toBe(5);
      expect(factory.tracker.status("omlx")?.maxConcurrent).toBe(8);
      expect(PROVIDERS.find((provider) => provider.id === "omlx")?.maxConcurrent).toBe(4);
      expect(factory.tracker.status("codex")?.maxConcurrent).toBe(3);
      expect(PROVIDERS.find((provider) => provider.id === "claude")?.maxConcurrent).toBe(3);
    } finally {
      factory.store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid provider concurrency and unknown providers fail config loading", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-provider-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    for (const id of ["claude", "omlx"])
      for (const value of ["0", "-1", "1.5", '"2"', "1e20"]) {
        writeFileSync(join(configDir, "config.toml"), `[providers.${id}]\nmax_concurrent = ${value}\n`);
        expect(config).toThrow(`providers.${id}.max_concurrent must be a positive safe integer`);
      }
    writeFileSync(join(configDir, "config.toml"), "[providers.unknown]\nmax_concurrent = 2\n");
    expect(config).toThrow("providers.unknown: unknown provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
