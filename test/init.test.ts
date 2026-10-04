import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupCommand, setupDeps } from "../src/cli/setup.ts";
import { loadConfig } from "../src/config.ts";
import { setupFixture } from "./setup-support.ts";

test("empty --yes --json setup detects providers, writes validated config, starts service and saves smoke", async () => {
  const f = setupFixture();
  try {
    f.state.daemon = false;
    const writes: string[] = [],
      write = f.d.write;
    f.d.write = (path, text) => {
      writes.push(path);
      write(path, text);
    };
    expect(await setupCommand("init", { yes: true, json: true, repo: ["acme/app", "acme/lib"] }, f.d)).toBe(
      0,
    );
    const result = JSON.parse(f.output[0] ?? "");
    expect(result.providers.added).toEqual(["claude", "codex", "local-1234"]);
    expect(result.repos.added).toEqual(["acme/app", "acme/lib"]);
    expect(result.merge).toBe("pr");
    expect(result.discreet).toContain("not available yet (#37)");
    expect(f.effects).toEqual(["service", "smoke", "mcp"]);
    expect(writes).toEqual([f.file, f.smokeFile]);
    const cfg = loadConfig({ configDir: f.configDir, home: f.home, readOnly: true });
    expect(cfg.raw.github).toEqual({ repos: ["acme/app", "acme/lib"], merge: "pr" });
    expect(cfg.raw.providers).toMatchObject([
      { preset: "claude" },
      { preset: "codex" },
      { id: "local-1234", kind: "openai-compatible" },
    ]);
    expect(JSON.parse(readFileSync(f.smokeFile, "utf8"))).toMatchObject([{ name: "live", status: "pass" }]);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.configDir)).toEqual(["config.toml"]);
  } finally {
    f.close();
  }
});
test("partial config keeps values; a second run leaves bytes and mtime unchanged and skips service/MCP", async () => {
  const f = setupFixture(
    '# custom port\n[server]\nport = 7499\n[[providers]]\npreset = "claude"\n[github]\nrepos = ["acme/app"]\nmerge = "none"\n',
  );
  try {
    f.state.daemon = false;
    const flags = { yes: true, json: true, repo: ["acme/lib"] };
    await setupCommand("init", flags, f.d);
    f.reload();
    expect(f.d.config.port).toBe(7499);
    expect(f.d.config.githubMerge).toBe("none");
    expect(f.d.config.raw.github).toMatchObject({ repos: ["acme/app", "acme/lib"] });
    const before = readFileSync(f.file, "utf8"),
      mtime = statSync(f.file).mtimeMs;
    f.output.length = 0;
    f.effects.length = 0;
    expect(await setupCommand("init", flags, f.d)).toBe(0);
    const result = JSON.parse(f.output[0] ?? "");
    expect(result.providers).toEqual({ added: [], existing: ["claude", "codex", "local-1234"] });
    expect(result.repos).toEqual({ added: [], existing: ["acme/app", "acme/lib"] });
    expect(f.effects).toEqual(["smoke"]);
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(statSync(f.file).mtimeMs).toBe(mtime);
  } finally {
    f.close();
  }
});
for (const text of [undefined, "[server]\nport = 7444\n"])
  test(`failed preflight leaves ${text === undefined ? "absent" : "existing"} config untouched`, async () => {
    const f = setupFixture(text);
    try {
      f.state.auth = false;
      const before = f.snapshot();
      expect(await setupCommand("init", { yes: true, json: true }, f.d)).toBe(1);
      expect(f.output.join("\n")).toContain("gh auth login");
      expect(f.snapshot()).toEqual(before);
      expect(f.effects).toEqual([]);
      expect(existsSync(f.file)).toBe(text !== undefined);
    } finally {
      f.close();
    }
  });
test("invalid repo or merge leaves config and temporary files untouched", async () => {
  const f = setupFixture();
  try {
    const before = f.snapshot();
    await expect(setupCommand("init", { yes: true, repo: ["invalid"] }, f.d)).rejects.toThrow("owner/name");
    expect(f.snapshot()).toEqual(before);
    f.d.tty = true;
    f.d.ask = async (q, fallback) => (q.startsWith("Merge") ? "bogus" : fallback);
    await expect(setupCommand("init", {}, f.d)).rejects.toThrow("github.merge");
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.close();
  }
});
for (const tty of [false, true])
  test(`MCP changes require consent (tty=${tty})`, async () => {
    const f = setupFixture();
    try {
      f.d.tty = tty;
      f.d.ask = async (_q, fallback) => fallback;
      const userHome = join(f.root, "user");
      const production = setupDeps({ configDir: f.configDir, home: f.home, userHome, appDir: f.d.appDir });
      production.run = async () => {
        throw new Error("registration must not run");
      };
      f.d.mcp = production.mcp;
      expect(await setupCommand("init", {}, f.d)).toBe(0);
      expect(f.output.join("\n")).toContain("mcp_servers.limitless");
      expect(existsSync(userHome)).toBe(false);
    } finally {
      f.close();
    }
  });
test("production MCP adapter invokes registration once per vendor and preserves existing config", async () => {
  const f = setupFixture();
  try {
    const userHome = join(f.root, "user");
    const d = setupDeps({ configDir: f.configDir, home: f.home, userHome, appDir: f.d.appDir });
    const calls: string[][] = [];
    d.run = async (args) => {
      if (args[1] === "--version") return { exitCode: 0, stdout: "installed", stderr: "" };
      if (args[2] === "get") {
        const installed = existsSync(
          join(userHome, args[0] === "claude" ? ".claude.json" : ".codex/config.toml"),
        );
        return { exitCode: installed ? 0 : 1, stdout: "", stderr: "" };
      }
      calls.push(args);
      mkdirSync(join(userHome, ".codex"), { recursive: true });
      if (args[0] === "claude")
        writeFileSync(
          join(userHome, ".claude.json"),
          '{"mcpServers":{"limitless":{"command":"bun"}},"other":true}',
        );
      else
        writeFileSync(
          join(userHome, ".codex/config.toml"),
          'model = "custom"\n[mcp_servers.limitless]\ncommand = "bun"\n',
        );
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await d.mcp(true);
    await d.mcp(true);
    expect(calls.map((c) => c[0])).toEqual(["claude", "codex"]);
    expect(calls[0]).toContain("--scope");
    expect(calls[0]).toContain(`LIMITLESS_URL=${d.url}`);
    expect(readFileSync(join(userHome, ".codex/config.toml"), "utf8")).toContain('model = "custom"');
  } finally {
    f.close();
  }
});
test("CLI help advertises setup and run --repo remains a scalar request", async () => {
  const f = setupFixture();
  try {
    const help = Bun.spawn(["bun", "src/cli/main.ts", "--help"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(help.stdout).text();
    expect(await help.exited).toBe(0);
    expect(text).toContain("init [--yes] [--repo owner/name]... [--json]");
    expect(text).toContain("doctor [--json]");
    const child = Bun.spawn(
      [
        "bun",
        "--preload",
        "./test/fixtures/setup-cli-preload.ts",
        "src/cli/main.ts",
        "run",
        "task",
        "--repo",
        "acme/app",
      ],
      {
        env: { ...process.env, LIMITLESS_HOME: f.home, LIMITLESS_CONFIG_DIR: f.configDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(stdout).toContain("scalar repo accepted");
  } finally {
    f.close();
  }
});

test("GitHub config validates repository lists and merge policy strictly", () => {
  const f = setupFixture();
  try {
    for (const github of [
      { repos: "acme/app" },
      { repos: ["bad"] },
      { repos: [42] },
      { merge: "invalid" },
      { merge: ["pr"] },
    ])
      expect(() =>
        loadConfig({ configDir: f.configDir, home: f.home, readOnly: true, raw: { github } }),
      ).toThrow(/github\.(repos|merge)/);
    for (const merge of ["auto", "pr", "none"] as const)
      expect(
        loadConfig({
          configDir: f.configDir,
          home: f.home,
          readOnly: true,
          raw: { github: { merge, repos: ["acme/app"] } },
        }).githubMerge,
      ).toBe(merge);
  } finally {
    f.close();
  }
});

test("new GitHub repo uses configured merge; existing rows and absent-setting default are kept", async () => {
  const f = setupFixture('[github]\nmerge = "pr"\n');
  try {
    const child = Bun.spawn(["bun", "test/fixtures/setup-repo.ts", f.configDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toEqual(["pr", "pr", "auto"]);
  } finally {
    f.close();
  }
});

test("legacy provider limits and unrelated nested values survive filling setup gaps", async () => {
  const f = setupFixture(
    "[server]\nport = 7456\n[providers.claude]\nmax_concurrent = 2\n[github]\npoll = false\n",
  );
  try {
    f.state.local = false;
    await setupCommand("init", { yes: true }, f.d);
    f.reload();
    expect(f.d.config.port).toBe(7456);
    expect(f.d.config.githubPoll).toBe(false);
    expect(f.d.config.catalog?.providers.find((p) => p.id === "claude")?.maxConcurrent).toBe(2);
    expect(f.d.config.raw.providers).toMatchObject([
      { id: "claude", max_concurrent: 2 },
      { preset: "codex" },
    ]);
    const before = readFileSync(f.file, "utf8"),
      mtime = statSync(f.file).mtimeMs;
    await setupCommand("init", { yes: true }, f.d);
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(statSync(f.file).mtimeMs).toBe(mtime);
  } finally {
    f.close();
  }
});
