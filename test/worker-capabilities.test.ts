import { expect, test } from "bun:test";
import { redactCredentials } from "../src/util/proc.ts";
import { type CapabilityRunner, checkLogin, loggedIn, probeAgents } from "../src/workers/capabilities.ts";
import { Heartbeat } from "../src/workers/protocol.ts";

const base = {
  releaseSha: "release",
  bunVersion: "bun",
  os: "darwin",
  osVersion: "test",
  cpuCount: 1,
  ramBytes: 1,
  freeSlots: 0,
  onAC: true,
  idleSeconds: 0,
  jobs: [],
};

for (const [claude, codex, accepted] of [
  ["2.1.3 (Claude Code)", "codex-cli 0.50.0", true],
  ["2.1.3-beta.1 (Claude Code)", "codex v0.50.0-beta.1", true],
  ["Claude Code", "codex foo", false],
  ["2.1.3 (Claude Code) account", "codex-cli 0.50.0 account", false],
  ["account=user@example.com", "account=user@example.com", false],
  ["codex-cli 0.50.0", "2.1.3 (Claude Code)", false],
] as const)
  test(`CLI version validation: ${claude}, ${codex}`, async () => {
    const calls: string[][] = [];
    const result = await probeAgents(async (args, options) => {
      calls.push(args);
      expect(options.timeoutMs).toBe(30_000);
      expect(options.allowFail).toBe(true);
      expect(options.env?.PATH).toBeString();
      return {
        exitCode: 0,
        stdout:
          args[1] === "--version"
            ? `  ${args[0] === "claude" ? claude : codex}\nuser@example.com`
            : "user@example.com",
      };
    });
    expect(result).toEqual({
      claude: { version: accepted ? claude : null, loggedIn: true },
      codex: { version: accepted ? codex : null, loggedIn: true },
    });
    expect(calls).toContainEqual(["claude", "auth", "status"]);
    expect(calls).toContainEqual(["codex", "login", "status"]);
    expect(JSON.stringify(result)).not.toContain("user@example.com");
    expect(Heartbeat.parse({ ...base, agents: result }).agents).toEqual(result);
  });

test.each([
  ["2.1.3 (Claude Code)", "codex-cli 0.50.0", true],
  ["2.1.3-beta.1 (Claude Code)", "codex v0.50.0-beta.1", true],
  ["2.1.3 (Claude Code)", "codex-cli v0.50.0", true],
  ["2.1.3 (Claude Code)", "codex 0.50.0", true],
  [null, null, true],
  ["account=user@example.com", "account=user@example.com", false],
  ["2.1.3 (Claude Code) account", "codex-cli 0.50.0 account", false],
  ["2.1.3 (Claude Code)\naccount", "codex-cli 0.50.0\naccount", false],
  ["codex-cli 0.50.0", "2.1.3 (Claude Code)", false],
] as const)("heartbeat sanitizes CLI versions (%s, %s)", (claude, codex, accepted) => {
  const parsed = Heartbeat.parse({
    ...base,
    agents: {
      claude: { version: claude, loggedIn: true },
      codex: { version: codex, loggedIn: false },
    },
  });
  expect(parsed.agents).toEqual({
    claude: { version: accepted ? claude : null, loggedIn: true },
    codex: { version: accepted ? codex : null, loggedIn: false },
  });
});

test.each([
  [0, "logged in", true],
  [0, '{"loggedIn" : false, "account":"user@example.com"}', false],
  [1, "logged in", false],
  [null, "", false],
] as const)("shared login rule exit=%s output=%s", async (exitCode, stdout, expected) => {
  expect(loggedIn({ exitCode, stdout })).toBe(expected);
  expect(await checkLogin("codex", async () => ({ exitCode, stdout }))).toBe(expected);
});

test("missing or failed CLIs never log in or expose command failures", async () => {
  let calls = 0;
  const result = await probeAgents(async (args) => {
    calls++;
    if (args[0] === "claude") throw new Error("user@example.com");
    return { exitCode: 1, stdout: "user@example.com" };
  });
  expect(result).toEqual({
    claude: { version: null, loggedIn: false },
    codex: { version: null, loggedIn: false },
  });
  expect(calls).toBe(2);
});

test.each([
  { configured: true, accepted: true },
  { configured: true, accepted: false },
  { configured: false, accepted: true },
  { configured: false, accepted: false },
])("Claude capability authentication: %j", async ({ configured, accepted }) => {
  const token = `probe-${crypto.randomUUID()}`;
  const secrets: Record<string, string> = configured ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
  const calls: string[][] = [];
  const run: CapabilityRunner = async (args, options) => {
    calls.push(args);
    const supplied = options.env?.CLAUDE_CODE_OAUTH_TOKEN;
    expect(supplied).toBe(args[0] === "claude" && configured ? token : undefined);
    if (args[1] === "--version")
      return { exitCode: 0, stdout: args[0] === "claude" ? "2.1.3 (Claude Code)" : "codex-cli 0.50.0" };
    if (args[0] === "codex") return { exitCode: 0, stdout: "logged in" };
    if (args[1] === "auth") {
      expect(args).toEqual(["claude", "auth", "status"]);
      // The real CLI accepts any nonempty token here, including a revoked one.
      return supplied
        ? { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"oauth_token"}' }
        : {
            exitCode: configured || accepted ? 0 : 1,
            stdout: JSON.stringify({ loggedIn: configured || accepted }),
          };
    }
    expect(args).toEqual([
      "claude",
      "--print",
      "Reply OK.",
      "--model",
      "haiku",
      "--tools",
      "",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
    ]);
    return {
      exitCode: supplied === token && accepted ? 0 : 1,
      stdout: accepted ? "OK." : `Rejected ${token}`,
    };
  };
  const result = await probeAgents(run, undefined, secrets);
  expect(result.claude).toEqual({ version: "2.1.3 (Claude Code)", loggedIn: accepted });
  expect(result.codex.loggedIn).toBe(true);
  expect(calls).toHaveLength(4);
  expect(calls.filter((args) => args[0] === "claude" && args[1] !== "--version")).toEqual([
    expect.arrayContaining(configured ? ["--print", "--tools", ""] : ["auth", "status"]),
  ]);
  expect(JSON.stringify(result)).not.toContain(token);
  if (configured) expect(redactCredentials(`Rejected ${token}`)).toBe("Rejected [redacted]");
});

test.each(["stdout", "stderr", "throw"] as const)(
  "Claude token rejection preserves redacted %s diagnostics before truncation",
  async (source) => {
    const token = `rejected-${crypto.randomUUID()}`;
    const diagnostic = `Token rejected: ${"x".repeat(3960)} ${token}`;
    let calls = 0;
    await expect(
      checkLogin(
        "claude",
        async (args, options) => {
          calls++;
          if (args[1] === "auth")
            return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"oauth_token"}' };
          expect(args).toContain("--print");
          expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
          if (source === "throw") throw new Error(diagnostic);
          return { exitCode: 1, stdout: "", [source]: diagnostic };
        },
        undefined,
        { CLAUDE_CODE_OAUTH_TOKEN: token },
      ),
    ).rejects.toThrow(`${source === "throw" ? "Error: " : ""}Token rejected: ${"x".repeat(3960)} [redacted]`);
    expect(calls).toBe(1);
  },
);

test("heartbeat additions are optional, strict, and validate digest shape", () => {
  expect(Heartbeat.safeParse(base).success).toBe(true);
  for (const fields of [
    { agents: { claude: { version: null, loggedIn: true, account: "user@example.com" } } },
    { agents: { fake: { version: null, loggedIn: true } } },
    { privateStringsDigest: "A".repeat(64) },
    { privateStringsDigest: "a".repeat(63) },
  ])
    expect(Heartbeat.safeParse({ ...base, ...fields }).success).toBe(false);
  for (const name of ["claude", "codex"]) {
    for (const version of [undefined, 1, true, {}, []])
      expect(Heartbeat.safeParse({ ...base, agents: { [name]: { version, loggedIn: true } } }).success).toBe(
        false,
      );
    expect(
      Heartbeat.safeParse({
        ...base,
        agents: { [name]: { version: null, loggedIn: "true" } },
      }).success,
    ).toBe(false);
  }
});
