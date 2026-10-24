import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

export function reloadFixture(initial = "") {
  const home = mkdtempSync(join(tmpdir(), "config-reload-"));
  const configDir = join(home, "config");
  mkdirSync(configDir);
  const write = (text: string) => writeFileSync(join(configDir, "config.toml"), text);
  write(initial);
  const factory = new Factory(loadConfig({ home, configDir }), { store: new Store(":memory:") });
  cleanup.push(async () => {
    await factory.stop();
    factory.store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { factory, home, configDir, write };
}
