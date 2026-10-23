import { expect, test } from "bun:test";
import { checkLogin, loggedIn, probeAgents } from "../src/workers/capabilities.ts";
import { Heartbeat } from "../src/workers/protocol.ts";

for (const [claude, codex, accepted] of [
  ["2.1.3 (Claude Code)", "codex-cli 0.50.0", true],
  ["2.1.3-beta.1 (Claude Code)", "codex v0.50.0-beta.1", true],
  ["Claude Code", "codex foo", false],
  ["2.1.3 (Claude Code) account", "codex-cli 0.50.0 account", false],
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

test("heartbeat additions are optional, strict, and validate digest shape", () => {
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
  expect(Heartbeat.safeParse(base).success).toBe(true);
  for (const fields of [
    { agents: { claude: { version: null, loggedIn: true, account: "user@example.com" } } },
    { agents: { fake: { version: null, loggedIn: true } } },
    { privateStringsDigest: "A".repeat(64) },
    { privateStringsDigest: "a".repeat(63) },
  ])
    expect(Heartbeat.safeParse({ ...base, ...fields }).success).toBe(false);
});
