import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../src/util/proc.ts";

test("hidden agent-test dispatch bypasses strict parsing and config initialization", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-test-cli-")));
  const home = join(root, "home"),
    caller = join(root, "caller"),
    directory = join(root, "wrappers");
  for (const path of [home, caller, directory]) mkdirSync(path);
  writeFileSync(join(home, "config.toml"), "invalid [toml");
  writeFileSync(join(root, "record"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\nexit 23\n', { mode: 0o755 });
  const config = join(directory, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ commands: [], directory, unix: join(root, "unused.sock"), token: "test" }),
  );
  const env = {
    ...process.env,
    HOME: home,
    LIMITLESS_HOME: home,
    LIMITLESS_CONFIG_DIR: home,
    PATH: `${root}:/usr/bin:/bin`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const cli = join(import.meta.dir, "../src/cli/main.ts");
  try {
    const result = await sh(
      [
        process.execPath,
        cli,
        "__agent-test",
        caller,
        config,
        "record",
        "--parallel=4",
        "-t",
        "a b",
        "it's unchanged",
        "",
      ],
      { cwd: directory, env, allowFail: true },
    );
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n")).toEqual([
      caller,
      "--parallel=4",
      "-t",
      "a b",
      "it's unchanged",
      "",
      "",
    ]);
    const help = await sh([process.execPath, cli, "--help"], { cwd: directory, env });
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).not.toContain("__agent-test");
    expect(readdirSync(home)).toEqual(["config.toml"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
