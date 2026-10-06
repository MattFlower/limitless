import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupCommand, setupDeps } from "../src/cli/setup.ts";
import { loadConfig } from "../src/config.ts";
import { tomlValue } from "../src/router/config-catalog.ts";
import { customProvider } from "./provider-config-support.ts";
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
    expect(result.sessionStart).toContain("Optional: manually merge");
    const hook = JSON.parse(result.sessionStart.split("acknowledging:\n")[1]);
    expect(hook.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: "command" });
    expect(hook.hooks.SessionStart[0].hooks[0].command).toEndWith("digest --consumer claude");
    expect(result.discreet).toContain("not available yet (#37)");
    expect(result.discreet).toContain("off (deferred to #37");
    expect(result.warnings[0]).toContain("One-way migration");
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

for (const source of ["implicit", "lan", "unexpected"])
  test(`CLI init --yes --json isolates ${source} provider health and loopback discovery`, async () => {
    const provider = {
      ...customProvider,
      api_key_env: undefined,
      id: "lan",
      health_url:
        source === "unexpected"
          ? "https://unexpected-provider.invalid/health"
          : "http://192.0.2.10:8080/v1/models",
    };
    const f = setupFixture(source === "implicit" ? undefined : `providers = ${tomlValue([provider])}\n`);
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        paths.push(path);
        return Response.json(path === "/api/health" ? { ok: true, sha: "installed" } : []);
      },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          "./test/setup-cli-preload.ts",
          "src/cli/main.ts",
          "init",
          "--yes",
          "--json",
          "--repo",
          "acme/app",
        ],
        {
          env: {
            ...process.env,
            LIMITLESS_HOME: f.home,
            LIMITLESS_CONFIG_DIR: f.configDir,
            LIMITLESS_URL: `http://127.0.0.1:${server.port}`,
            LIMITLESS_TEST_SETUP_TRACE: "1",
            LIMITLESS_TEST_SETUP_MUTATION: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit).toBe(source === "unexpected" ? 1 : 0);
      const trace = JSON.parse(source === "unexpected" ? (stderr.split("\n")[0] ?? "") : stderr);
      expect(trace.violations).toEqual(
        source === "unexpected" ? [`Unexpected fetch: GET ${provider.health_url}`] : [],
      );
      if (source === "implicit") {
        for (const url of [
          "https://openrouter.ai/api/v1/key",
          "http://127.0.0.1:8989/v1/models",
          "http://127.0.0.1:8000/v1/models",
          "http://twilight:8080/v1/models",
        ])
          expect(trace.requests).toContain(`GET ${url}`);
      } else expect(trace.requests).toContain(`GET ${provider.health_url}`);
      for (const port of [1234, 8000, 8080, 11434, 10240])
        expect(trace.requests).toContain(`GET http://127.0.0.1:${port}/v1/models`);
      expect(paths).toEqual(["/api/health", "/api/github/access"]);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        providers: { added: ["claude", "codex", "local-1234"] },
      });
      expect(Bun.TOML.parse(readFileSync(f.file, "utf8"))).toMatchObject({
        github: { repos: ["acme/app"], merge: "pr" },
      });
    } finally {
      server.stop(true);
      f.close();
    }
  });

for (const merge of ["", ', merge  =  "none"'])
  test(`init preserves inline GitHub bytes while extending repos and filling missing merge (${merge || "missing"})`, async () => {
    const assignment = `github  =  { token_env = "X", poll = false, interval = 60, repos  =  [ "acme/app" ]${merge} } # note\n`;
    const providers = '[[providers]]\npreset = "claude"\n[[providers]]\npreset = "codex"\n';
    const f = setupFixture(assignment + providers);
    try {
      f.state.local = false;
      const flags = { yes: true, json: true, repo: ["acme/lib"] };
      expect(await setupCommand("init", flags, f.d)).toBe(0);
      const updated = readFileSync(f.file, "utf8");
      expect(updated).toBe(
        assignment.replace('[ "acme/app" ]', `["acme/app", "acme/lib"]${merge ? "" : ', merge = "pr"'}`) +
          providers,
      );
      expect(Bun.TOML.parse(updated)).toMatchObject({
        github: {
          token_env: "X",
          poll: false,
          interval: 60,
          repos: ["acme/app", "acme/lib"],
          merge: merge ? "none" : "pr",
        },
      });
      const mtime = statSync(f.file).mtimeMs;
      f.reload();
      expect(await setupCommand("init", flags, f.d)).toBe(0);
      expect(readFileSync(f.file, "utf8")).toBe(updated);
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
    const f = setupFixture('[[providers]]\npreset = "claude"\n[[providers]]\npreset = "codex"\n');
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
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    const claudeFile = join(userHome, ".claude.json"),
      codexFile = join(userHome, ".codex/config.toml");
    const claudeSettings = {
      theme: "dark",
      projects: { "/work/app": { allowedTools: ["Read"] } },
      mcpServers: { other: { command: "other-server" } },
    };
    const codexSettings =
      '# personal preferences\nmodel = "custom"\napproval_policy = "on-request"\n[projects."/work/app"]\ntrust_level = "trusted"\n[mcp_servers.other]\ncommand = "other-server"\n';
    writeFileSync(claudeFile, JSON.stringify(claudeSettings));
    writeFileSync(codexFile, codexSettings);
    const untouched = join(userHome, "unrelated.txt");
    writeFileSync(untouched, "unrelated content");
    const mtime = statSync(untouched).mtimeMs;
    const calls: string[][] = [];
    const add = (cli: string) => [
      cli,
      "mcp",
      "add",
      "limitless",
      "--env",
      `LIMITLESS_URL=${d.url}`,
      ...(cli === "claude" ? ["--scope", "user"] : []),
      "--",
      "bun",
      join(f.d.appDir, "src/cli/main.ts"),
      "mcp",
    ];
    d.run = async (args) => {
      calls.push(args);
      const cli = args[0] ?? "";
      expect(["claude", "codex"]).toContain(cli);
      if (args[1] === "--version") {
        expect(args).toEqual([cli, "--version"]);
        return { exitCode: 0, stdout: "installed", stderr: "" };
      }
      if (args[2] === "get") {
        expect(args).toEqual([cli, "mcp", "get", "limitless"]);
        const installed =
          cli === "claude"
            ? !!JSON.parse(readFileSync(claudeFile, "utf8")).mcpServers.limitless
            : !!(
                (Bun.TOML.parse(readFileSync(codexFile, "utf8")) as Record<string, unknown>)
                  .mcp_servers as Record<string, unknown>
              ).limitless;
        return { exitCode: installed ? 0 : 1, stdout: "", stderr: "" };
      }
      expect(args).toEqual(add(cli));
      if (cli === "claude") {
        const config = JSON.parse(readFileSync(claudeFile, "utf8"));
        config.mcpServers.limitless = {
          command: "bun",
          args: [join(f.d.appDir, "src/cli/main.ts"), "mcp"],
          env: { LIMITLESS_URL: d.url },
        };
        writeFileSync(claudeFile, JSON.stringify(config));
      } else
        writeFileSync(
          codexFile,
          `${readFileSync(codexFile, "utf8")}\n[mcp_servers.limitless]\ncommand = "bun"\nargs = ${JSON.stringify([join(f.d.appDir, "src/cli/main.ts"), "mcp"])}\n[mcp_servers.limitless.env]\nLIMITLESS_URL = ${JSON.stringify(d.url)}\n`,
        );
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await d.mcp(true);
    const before = f.snapshot();
    await d.mcp(true);
    expect(calls).toEqual([
      ["claude", "mcp", "get", "limitless"],
      ["claude", "--version"],
      add("claude"),
      ["codex", "mcp", "get", "limitless"],
      ["codex", "--version"],
      add("codex"),
      ["claude", "mcp", "get", "limitless"],
      ["codex", "mcp", "get", "limitless"],
    ]);
    expect(JSON.parse(readFileSync(claudeFile, "utf8"))).toMatchObject(claudeSettings);
    expect(readFileSync(codexFile, "utf8")).toStartWith(codexSettings);
    expect(readFileSync(untouched, "utf8")).toBe("unrelated content");
    expect(statSync(untouched).mtimeMs).toBe(mtime);
    expect(readdirSync(userHome).sort()).toEqual([".claude.json", ".codex", "unrelated.txt"]);
    expect(readdirSync(join(userHome, ".codex"))).toEqual(["config.toml"]);
    expect(f.snapshot()).toEqual(before);
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
        "./test/setup-cli-preload.ts",
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

for (const text of [undefined, "# original config\n[server]\nport = 7444\n"])
  for (const step of ["service", "readiness", "smoke", "mcp"])
    test(`init restores ${text === undefined ? "absent" : "existing"} config after ${step} failure`, async () => {
      const f = setupFixture(text);
      try {
        f.state.daemon = false;
        const assertReplaced = () => {
          expect(existsSync(f.file)).toBe(true);
          expect(readFileSync(f.file, "utf8")).not.toBe(text);
        };
        if (step === "service")
          f.d.install = async () => {
            assertReplaced();
            throw new Error("service failed");
          };
        if (step === "readiness")
          f.d.install = async () => {
            assertReplaced();
          };
        if (step === "smoke")
          f.d.smoke = async () => {
            assertReplaced();
            return [{ name: "live", status: "fail", durationMs: 0 }];
          };
        if (step === "mcp")
          f.d.mcp = async () => {
            assertReplaced();
            throw new Error("registration failed");
          };
        expect(await setupCommand("init", { yes: true, json: true }, f.d)).toBe(1);
        expect(f.output).toHaveLength(1);
        expect(JSON.parse(f.output[0] ?? "")).toMatchObject({ ok: false, failedStep: step });
        expect(existsSync(f.file)).toBe(text !== undefined);
        if (text !== undefined) expect(readFileSync(f.file, "utf8")).toBe(text);
        expect(f.d.config.raw).toEqual(text === undefined ? {} : { server: { port: 7444 } });
      } finally {
        f.close();
      }
    });

test("patching setup preserves comments, multiline values and unrelated tables, and backs up original bytes", async () => {
  const unrelated =
    '# custom settings\n[server]\nport  =  7499 # retain spacing\n[custom]\nnotes = """\n[github]\nthis is text\n"""\n';
  const github =
    '# repository settings\n[github]\nrepos = [\n  "acme/app",\n] # retain repo comment\npoll  = false # retain polling\nmerge = "none" # retain merge\n';
  const provider = '\n[[providers]] # existing provider\npreset = "claude" # retain provider comment\n';
  const original = unrelated + github + provider;
  const f = setupFixture(original);
  try {
    expect(await setupCommand("init", { yes: true, json: true, repo: ["acme/lib"] }, f.d)).toBe(0);
    const updated = readFileSync(f.file, "utf8");
    expect(updated).toStartWith(unrelated);
    expect(updated).toContain('poll  = false # retain polling\nmerge = "none" # retain merge\n');
    expect(updated).toContain(provider);
    expect(updated).toContain("# retain repo comment");
    const backups = readdirSync(f.configDir).filter((p) => p.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^config\.toml\.\d{4}-\d\d-\d\dT.*\.bak$/);
    expect(readFileSync(join(f.configDir, backups[0] ?? ""), "utf8")).toBe(original);
    const mtime = statSync(f.file).mtimeMs;
    f.reload();
    expect(await setupCommand("init", { yes: true, json: true, repo: ["acme/lib"] }, f.d)).toBe(0);
    expect(readFileSync(f.file, "utf8")).toBe(updated);
    expect(statSync(f.file).mtimeMs).toBe(mtime);
    expect(readdirSync(f.configDir).filter((p) => p.endsWith(".bak"))).toEqual(backups);
  } finally {
    f.close();
  }
});

for (const comma of ["", ","])
  test(`inline provider arrays preserve existing entries and comments (trailing comma=${comma})`, async () => {
    const entry = `  { preset = "claude" }${comma} # personal provider\n`;
    const f = setupFixture(
      `providers = [\n${entry}] # keep array comment\ngithub.repos = ["acme/app"]\ngithub.merge = "none"`,
    );
    try {
      expect(await setupCommand("init", { yes: true, json: true, repo: ["acme/lib"] }, f.d)).toBe(0);
      const text = readFileSync(f.file, "utf8");
      expect(text).toContain(entry);
      expect(text).toContain("# keep array comment");
      expect(text).toContain('github.merge = "none"');
      f.reload();
      expect(f.d.config.raw.github).toMatchObject({ repos: ["acme/app", "acme/lib"], merge: "none" });
      expect(f.d.config.raw.providers).toMatchObject([
        { preset: "claude" },
        { preset: "codex" },
        { id: "local-1234" },
      ]);
    } finally {
      f.close();
    }
  });

test("init preserves literal dotted tables and updates quoted dotted keys through conversion and rerun", async () => {
  const unrelated = '["providers.notes"] # unrelated table\ncustom = "keep me"\n';
  const original = `'github'."repos" = [] # keep repo comment\n"github".'merge' = "none"\n${unrelated}`;
  const f = setupFixture(original);
  try {
    const flags = { yes: true, json: true, repo: ["acme/app"] };
    expect(await setupCommand("init", flags, f.d)).toBe(0);
    const updated = readFileSync(f.file, "utf8");
    expect(updated).toContain(unrelated);
    expect(updated).toContain('\'github\'."repos" = ["acme/app"] # keep repo comment\n');
    expect(updated).toContain('"github".\'merge\' = "none"\n');
    f.reload();
    expect(f.d.config.raw.github).toEqual({ repos: ["acme/app"], merge: "none" });
    expect(f.d.config.raw["providers.notes"]).toEqual({ custom: "keep me" });
    const backup = readdirSync(f.configDir).find((p) => p.endsWith(".bak"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(f.configDir, backup ?? ""), "utf8")).toBe(original);
    const mtime = statSync(f.file).mtimeMs;
    expect(await setupCommand("init", flags, f.d)).toBe(0);
    expect(readFileSync(f.file, "utf8")).toBe(updated);
    expect(statSync(f.file).mtimeMs).toBe(mtime);
  } finally {
    f.close();
  }
});

for (const consent of ["no", "yes", "noninteractive"])
  test(`implicit provider conversion requires consent: ${consent}`, async () => {
    const original = "# preserve me\n[providers.claude]\nmax_concurrent = 2\n[server]\nport = 7400\n";
    const f = setupFixture(original);
    try {
      f.d.tty = consent !== "noninteractive";
      f.d.ask = async (q, fallback) => (q.startsWith("Convert") ? consent : fallback);
      if (consent === "yes") {
        expect(await setupCommand("init", {}, f.d)).toBe(0);
        expect(readFileSync(f.file, "utf8")).toContain("[[providers]]");
        const backup = readdirSync(f.configDir).find((p) => p.endsWith(".bak"));
        expect(backup).toBeDefined();
        expect(readFileSync(join(f.configDir, backup ?? ""), "utf8")).toBe(original);
      } else {
        await expect(setupCommand("init", {}, f.d)).rejects.toThrow("Config replacement refused");
        expect(readFileSync(f.file, "utf8")).toBe(original);
        expect(readdirSync(f.configDir)).toEqual(["config.toml"]);
        expect(f.effects).toEqual([]);
      }
      expect(f.output.join("\n")).toContain(
        "One-way migration: the previous release cannot load [[providers]]",
      );
    } finally {
      f.close();
    }
  });

for (const json of [false, true])
  test(`interactive init asks about discreet mode with off default and reports deferral (json=${json})`, async () => {
    const f = setupFixture();
    try {
      const questions: [string, string][] = [];
      f.d.tty = true;
      f.d.ask = async (q, fallback) => {
        questions.push([q, fallback]);
        if (q.startsWith("Convert")) return "yes";
        if (q.startsWith("Discreet")) return "on";
        return fallback;
      };
      expect(await setupCommand("init", { json }, f.d)).toBe(0);
      expect(questions).toContainEqual(["Discreet mode (on/off)", "off"]);
      const output = json ? JSON.parse(f.output[0] ?? "").discreet : f.output.join("\n");
      expect(output).toContain("discreet mode: on (deferred to #37");
    } finally {
      f.close();
    }
  });
