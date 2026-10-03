import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installIntegrations, repositoryRoot } from "../src/integrations/install.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-install-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snapshot(path: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const file = join(e.parentPath, e.name);
        return [file.slice(path.length), readFileSync(file, "utf8")];
      }),
  );
}

function setupConfigs() {
  for (const file of [".codex/config.toml", ".claude/settings.json", ".claude.json"]) {
    const path = join(dir, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, file.endsWith("toml") ? 'model = "keep-me"\n' : '{"custom":true}\n');
  }
}

test("default prints usable setup without writing; --write installs only the skill, identical repeat is a no-op", () => {
  setupConfigs();
  const before = snapshot(dir);
  const output: string[] = [];
  installIntegrations({ home: dir, print: (s) => output.push(s) });
  expect(snapshot(dir)).toEqual(before);
  const text = output.join("\n");
  expect(text).toContain(join(dir, ".agents/skills/limitless/SKILL.md"));
  const toml = text.match(/(\[mcp_servers.limitless\][\s\S]*?)\n\nBefore launching/)?.[1];
  if (!toml) throw new Error("Missing TOML instructions");
  expect(Bun.TOML.parse(toml)).toEqual({
    mcp_servers: {
      limitless: {
        command: "bun",
        args: [join(repositoryRoot, "src/cli/main.ts"), "mcp"],
        env: { LIMITLESS_URL: "http://127.0.0.1:7400" },
      },
    },
  });
  expect(text).toContain(`/plugin marketplace add ${JSON.stringify(join(repositoryRoot, "integrations"))}`);
  expect(text).toContain("/plugin install limitless@limitless-local");
  const destination = join(dir, ".agents/skills/limitless/SKILL.md");
  installIntegrations({ home: dir, write: true, print: (s) => output.push(s) });
  expect(readFileSync(destination, "utf8")).toBe(
    readFileSync(join(repositoryRoot, "integrations/codex/.agents/skills/limitless/SKILL.md"), "utf8"),
  );
  const after = snapshot(dir);
  expect(Object.keys(after)).toHaveLength(Object.keys(before).length + 1);
  for (const [path, content] of Object.entries(before)) expect(after[path]).toBe(content);
  installIntegrations({ home: dir, write: true, print: (s) => output.push(s) });
  expect(snapshot(dir)).toEqual(after);
  expect(output.some((s) => s.startsWith("Skill already installed"))).toBe(true);
});

test("differing user-authored skill is preserved along with all configuration", () => {
  setupConfigs();
  const path = join(dir, ".agents/skills/limitless/SKILL.md");
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "My custom instructions\n");
  const before = snapshot(dir);
  installIntegrations({ home: dir, print: () => {} });
  expect(() => installIntegrations({ home: dir, write: true, print: () => {} })).toThrow(
    "Refusing to overwrite",
  );
  expect(snapshot(dir)).toEqual(before);
});

test("CLI resolves assets from another working directory and never writes without --write", async () => {
  setupConfigs();
  const before = snapshot(dir);
  const proc = Bun.spawn(
    [process.execPath, join(repositoryRoot, "src/cli/main.ts"), "integrations", "install"],
    {
      cwd: dir,
      env: { ...process.env, HOME: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain(join(repositoryRoot, "src/cli/main.ts"));
  expect(snapshot(dir)).toEqual(before);
});

test("paths with spaces and quotes stay in one launch argument; cached plugin uses stable repo", () => {
  const root = join(dir, "stable checkout 'quoted'");
  cpSync(join(repositoryRoot, "integrations"), join(root, "integrations"), { recursive: true });
  const output: string[] = [];
  installIntegrations({ home: join(dir, "agent home"), root, write: true, print: (s) => output.push(s) });
  const text = output.join("\n");
  const toml = text.match(/(\[mcp_servers.limitless\][\s\S]*?)\n\nBefore launching/)?.[1];
  if (!toml) throw new Error("Missing TOML");
  const parsed = Bun.TOML.parse(toml) as { mcp_servers: { limitless: { args: string[] } } };
  expect(parsed.mcp_servers.limitless.args).toEqual([join(root, "src/cli/main.ts"), "mcp"]);
  const cached = join(dir, "plugin cache");
  cpSync(join(root, "integrations/claude-plugin"), cached, { recursive: true });
  const config = JSON.parse(readFileSync(join(cached, ".mcp.json"), "utf8"));
  expect(config.mcpServers.limitless.args.map((a: string) => a.replace(`\${LIMITLESS_REPO}`, root))).toEqual([
    join(root, "src/cli/main.ts"),
    "mcp",
  ]);
  expect(existsSync(join(dir, "agent home/.agents/skills/limitless/SKILL.md"))).toBe(true);
});

test("bundled marketplace resolves plugin, skills match, and documented TOML parses", () => {
  const integrations = join(repositoryRoot, "integrations");
  const marketplace = JSON.parse(readFileSync(join(integrations, ".claude-plugin/marketplace.json"), "utf8"));
  expect(marketplace.name).toBe("limitless-local");
  const pluginRoot = resolve(integrations, marketplace.plugins[0].source);
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
  expect(manifest.name).toBe(marketplace.plugins[0].name);
  const config = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
  expect(config.mcpServers.limitless).toEqual({
    type: "stdio",
    command: "bun",
    args: [`\${LIMITLESS_REPO}/src/cli/main.ts`, "mcp"],
  });
  const skill = readFileSync(join(pluginRoot, "skills/limitless/SKILL.md"), "utf8");
  expect(skill).toBe(readFileSync(join(integrations, "codex/.agents/skills/limitless/SKILL.md"), "utf8"));
  expect(skill).toStartWith("---\nname: limitless\ndescription:");
  const metadata = Bun.YAML.parse(skill.split("---")[1] ?? "") as { name: string; description: string };
  expect(metadata.name).toBe("limitless");
  expect(metadata.description.trim().length).toBeGreaterThan(0);
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  for (const name of ["create_run", "get_run", "list_runs", "cancel_run", "answer_question", "providers"]) {
    expect(skill).toContain(`limitless_${name}`);
    expect(readme).toContain(`limitless_${name}`);
  }
  for (const file of [join(repositoryRoot, "README.md"), join(integrations, "codex/README.md")]) {
    const doc = readFileSync(file, "utf8");
    const examples = [...doc.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => Bun.TOML.parse(m[1] ?? ""));
    expect(examples.some((example) => JSON.stringify(example).includes("mcp_servers"))).toBe(true);
    expect(doc).toContain("--write");
    expect(doc).toContain("stable");
    expect(doc).toContain("LIMITLESS_URL");
  }
});
