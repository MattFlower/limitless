import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactCredentials, sh } from "../util/proc.ts";
import type { DeployResult } from "./auto-deploy.ts";

export async function selfRepository(cwd: string, command = sh): Promise<string> {
  const remote = (
    await command(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 10_000 })
  ).stdout.trim();
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (!match?.[1]) throw new Error("Release origin is not a GitHub repository");
  return match[1];
}

export async function mainSha(cwd: string, command = sh): Promise<string> {
  const output = await command(["git", "ls-remote", "origin", "refs/heads/main"], { cwd, timeoutMs: 30_000 });
  const match = /^([a-f0-9]{40})\s+refs\/heads\/main\s*$/i.exec(output.stdout.trim());
  if (!match?.[1]) throw new Error("Cannot resolve release origin main SHA");
  return match[1];
}

/** A separate launchd job survives kickstart of the daemon's job (ordinary child processes don't). */
export async function deployProcess(
  cwd: string,
  sha: string,
  command = sh,
  logs = join(homedir(), ".limitless", "logs"),
): Promise<DeployResult> {
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const label = `dev.limitless.deploy.${randomUUID()}`;
  const log = join(logs, `${label}.log`);
  const status = join(logs, `${label}.status`);
  await command(
    [
      "launchctl",
      "submit",
      "-l",
      label,
      "-o",
      log,
      "-e",
      log,
      "--",
      "/bin/bash",
      "-c",
      'status=$1; shift; "$@"; result=$?; printf "%s\\n" "$result" > "$status"; exit "$result"',
      "auto-deploy",
      status,
      "/usr/bin/env",
      ...["PATH", "LANG", "LIMITLESS_HOME", "LIMITLESS_CONFIG_DIR"].flatMap((key) =>
        process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`],
      ),
      `LIMITLESS_APP_DIR=${cwd}`,
      process.execPath,
      join(cwd, "src/cli/main.ts"),
      "deploy",
      sha,
      "--smoke",
    ],
    { cwd, timeoutMs: 10_000 },
  );
  for (;;) {
    let result: string;
    try {
      result = await readFile(status, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (!/^\d+\s*$/.test(result)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    await command(["launchctl", "remove", label], { cwd, allowFail: true, timeoutMs: 10_000 });
    return Number(result) === 0
      ? { ok: true }
      : {
          ok: false,
          reason: `Deploy exited ${result.trim()}: ${redactCredentials(await readFile(log, "utf8")).slice(-4000)}`,
        };
  }
}
