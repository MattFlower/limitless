import * as fs from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { exportProviders, resolveCatalog, tomlValue } from "../router/config-catalog.ts";

export function providersExport(write: boolean, yes = false): void {
  const cfg = loadConfig();
  const catalog = cfg.catalog ?? resolveCatalog(cfg.raw.providers);
  const output = exportProviders(catalog);
  for (const note of catalog.notes) console.error(`[providers] ${note}`);
  if (!write) {
    process.stdout.write(output);
    return;
  }
  const file = join(cfg.paths.configDir, "config.toml");
  const original = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  const settings = Object.entries(cfg.raw)
    .filter(([k]) => k !== "providers")
    .map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}\n`)
    .join("");
  const replacement = `${settings}\n${output}`;
  resolveCatalog((Bun.TOML.parse(replacement) as Record<string, unknown>).providers);
  fs.mkdirSync(cfg.paths.configDir, { recursive: true });
  const backup = `${file}.${crypto.randomUUID()}.bak`;
  const warning = `One-way migration: the previous release cannot load [[providers]]. Rollback requires ${original ? `restoring the original backup: ${backup}` : "removing the new config; no previous config backup exists"}.`;
  console.error(warning);
  if (
    original &&
    !yes &&
    (!process.stdin.isTTY || !/^y(es)?$/i.test(prompt(`${warning} Replace config? [y/N]`)?.trim() ?? ""))
  )
    throw new Error("Config replacement refused; confirm interactively or use --yes");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, replacement, { flag: "wx", mode: 0o600 });
    if (original) fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  console.error(`Wrote ${file}${original ? ` (backup: ${backup})` : ""}`);
}
