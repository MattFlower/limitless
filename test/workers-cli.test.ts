import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/util/proc.ts";

test("workers ls appends CLI versions, login state and private-strings parity", async () => {
  const home = mkdtempSync(join(tmpdir(), "workers-cli-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json([
        {
          name: "ready",
          state: "available",
          agents: {
            claude: { version: "2.1.3 (Claude Code)", loggedIn: true },
            codex: { version: "codex-cli 0.50.0", loggedIn: false },
          },
          privateStrings: "match",
        },
        { name: "legacy", state: "available" },
        {
          name: "unknown-version",
          state: "available",
          agents: { claude: { version: null, loggedIn: true }, codex: { version: null, loggedIn: false } },
          privateStrings: "unknown",
        },
      ]),
  });
  try {
    const result = await runProcess({
      cmd: [process.execPath, "src/cli/main.ts", "workers", "ls"],
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        LIMITLESS_HOME: home,
        LIMITLESS_CONFIG_DIR: home,
        LIMITLESS_URL: server.url.origin,
      },
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "ready\tavailable\tclaude:2.1.3 (Claude Code)\tcodex:logged out\tprivate-strings:match",
      "legacy\tavailable\tclaude:missing\tcodex:missing\tprivate-strings:unknown",
      "unknown-version\tavailable\tclaude:unknown\tcodex:missing\tprivate-strings:unknown",
    ]);
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
