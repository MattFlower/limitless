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
          agentJobs: [{ id: "one" }, { id: "two" }],
        },
        { name: "legacy", state: "available" },
        {
          name: "unknown-version",
          state: "available",
          agents: { claude: { version: null, loggedIn: true }, codex: { version: null, loggedIn: false } },
          privateStrings: "unknown",
          agentJobs: [],
        },
        {
          name: "unknown-codex-version",
          state: "available",
          agents: { codex: { version: null, loggedIn: true } },
          privateStrings: "match",
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
      "ready\tavailable\tclaude:2.1.3 (Claude Code)\tcodex:logged out\tprivate-strings:match\tagent-jobs:2",
      "legacy\tavailable\tclaude:missing\tcodex:missing\tprivate-strings:unknown\tagent-jobs:0",
      "unknown-version\tavailable\tclaude:unknown\tcodex:missing\tprivate-strings:unknown\tagent-jobs:0",
      "unknown-codex-version\tavailable\tclaude:missing\tcodex:unknown\tprivate-strings:match\tagent-jobs:0",
    ]);
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
