import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dir, "../..");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function sessionStartInstructions(root = repositoryRoot): string {
  const command = `bun ${shellQuote(join(root, "src/cli/main.ts"))} digest --consumer claude`;
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } };
  return `Optional: manually merge this Claude Code SessionStart hook into ~/.claude/settings.json (never installed automatically). Ensure bun is on PATH and the daemon is running. Digest reads without acknowledging:\n${JSON.stringify(settings, null, 2)}`;
}

export function installIntegrations(
  options: { write?: boolean; home?: string; root?: string; print?: (message: string) => void } = {},
): void {
  const root = options.root ?? repositoryRoot;
  const home = options.home ?? homedir();
  const print = options.print ?? console.log;
  const destination = join(home, ".agents/skills/limitless/SKILL.md");
  const skill = readFileSync(join(root, "integrations/codex/.agents/skills/limitless/SKILL.md"), "utf8");
  if (options.write) {
    if (existsSync(destination)) {
      if (readFileSync(destination, "utf8") !== skill) {
        throw new Error(`Refusing to overwrite differing skill: ${destination}`);
      }
      print(`Skill already installed: ${destination}`);
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, skill, { flag: "wx" });
      print(`Installed skill: ${destination}`);
    }
  } else {
    print(`No files written. Use --write to install the Codex skill: ${destination}`);
  }
  print(
    `Keep this stable Limitless checkout (with bun install completed): ${root}\nStart its daemon with limitless serve. Ensure bun is on the agent's PATH.\n\nManually add to ${join(home, ".codex/config.toml")} (configuration is never edited):\n[mcp_servers.limitless]\ncommand = "bun"\nargs = [${JSON.stringify(join(root, "src/cli/main.ts"))}, "mcp"]\n\n[mcp_servers.limitless.env]\nLIMITLESS_URL = "http://127.0.0.1:7400"\n\nBefore launching Claude Code, export the stable checkout path in its environment:\nexport LIMITLESS_REPO=${shellQuote(root)}\nThen run in Claude Code:\n/plugin marketplace add ${JSON.stringify(join(root, "integrations"))}\n/plugin install limitless@limitless-local\n\nLIMITLESS_REPO stays absolute even when Claude Code caches the plugin.\nLIMITLESS_URL overrides the daemon URL; otherwise LIMITLESS_PORT defaults to 7400.`,
  );
  print(sessionStartInstructions(root));
}
