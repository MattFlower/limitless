import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { tomlValue } from "../src/router/config-catalog.ts";

export const customModel = {
  id: "flash",
  model: "org/backend",
  vendor: "qwen",
  origin: "CN",
  base_origin: "CN",
  tier: 2,
  price: { input: 0, output: 0, cache_read: 0 },
  efforts: ["none", "high"],
  effort: "none",
  checkpoint: "shared-flash",
  notes: 'A "quoted" note\nwith a new line',
};
export const customProvider = {
  id: "mac-mlx",
  kind: "openai-compatible",
  base_url: "http://127.0.0.1:8989/custom/v1",
  label: "My MLX",
  billing: "free",
  max_concurrent: 4,
  api_key_env: "LIMITLESS_TEST_MLX_KEY",
  models: [customModel],
};
export function providerFixture(providers: unknown = [customProvider], secrets = "") {
  const root = mkdtempSync(join(tmpdir(), "limitless-provider-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const file = join(configDir, "config.toml");
  writeFileSync(file, `providers = ${tomlValue(providers)}\n`);
  writeFileSync(join(configDir, "secrets.env"), secrets);
  return {
    root,
    configDir,
    file,
    load: () => loadConfig({ home: join(root, "data"), configDir }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
