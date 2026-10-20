import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactCredentials, registeredCredentials, sh } from "../util/proc.ts";
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

const DEFAULT_LOGS = join(homedir(), ".limitless", "logs");
export const DEPLOY_DEADLINE_MS = 3 * 60 * 60 * 1000;
export type DeployJobStatus =
  | { kind: "running" }
  | { kind: "done"; exitCode: number; filterExitCode?: number; tail: string }
  | { kind: "missing" | "expired"; reason: string };
type WaitOptions = { deadlineMs?: number; pollMs?: number; now?: () => number; home?: string };

// This subtree is already denied by the shared gate/editor policy and reader private roots.
export const deployCredentialsDir = (home = homedir()) =>
  join(home, ".config", "limitless", "deploy-credentials");

function deployJob(job: string, logs: string, home?: string) {
  const label = `dev.limitless.deploy.${job}`;
  return {
    label,
    log: join(logs, `${label}.log`),
    status: join(logs, `${label}.status`),
    credentials: join(deployCredentialsDir(home), `${label}.credentials`),
  };
}

async function optionalRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function launchctlJob(
  command: typeof sh,
  launchctl: string,
  action: "list" | "remove",
  label: string,
  cwd: string,
) {
  try {
    return await command([launchctl, action, label], { cwd, allowFail: true, timeoutMs: 10_000 });
  } catch {
    return null;
  }
}

export async function deployJobStatus(
  job: string,
  time: number,
  command = sh,
  logs = DEFAULT_LOGS,
  launchctl = "/bin/launchctl",
  options: WaitOptions = {},
): Promise<DeployJobStatus> {
  const { label, log, status } = deployJob(job, logs);
  const completion = async (): Promise<DeployJobStatus | undefined> => {
    // Numeric status files from the previous release remain readable.
    const codes = /^(\d+)(?:[ \t]+(\d+))?\s*$/.exec(await optionalRead(status));
    if (!codes) return;
    return {
      kind: "done",
      exitCode: Number(codes[1]),
      ...(codes[2] === undefined ? {} : { filterExitCode: Number(codes[2]) }),
      tail: redactCredentials(await optionalRead(log)).slice(-4000),
    };
  };
  const done = await completion();
  if (done) return done;
  const listed = await launchctlJob(command, launchctl, "list", label, logs);
  // The wrapper can finish and remove itself between the first read and launchctl list.
  if (listed?.exitCode !== 0) {
    const finished = await completion();
    if (finished) return finished;
    if (listed?.exitCode === 113)
      return { kind: "missing", reason: `deploy job ${label} disappeared without reporting a status` };
    // An inconclusive inspection cannot end the durable attempt, even past its deadline.
    return { kind: "running" };
  }
  const deadline = options.deadlineMs ?? DEPLOY_DEADLINE_MS;
  if ((options.now ?? Date.now)() >= time + deadline)
    return { kind: "expired", reason: `deploy job ${label} did not finish within ${deadline}ms` };
  return { kind: "running" };
}

// A relaunch uses the started marker to avoid running deploy twice. Only the redaction filter
// writes the log; launchd's own output is discarded. Save the deploy's exit code, not the filter's.
const WRAPPER = [
  "status=$1; label=$2; launchctl=$3; credentials=$4; bun=$5; filter=$6; log=$7; shift 7",
  'if [ -e "$status.started" ]; then',
  '  [ -e "$status" ] || { printf "deploy job relaunched after an interrupted run; not deploying again\\n" > "$log"; printf "1\\n" > "$status"; }',
  "else",
  '  : > "$status.started"',
  '  "$@" 2>&1 | "$bun" "$filter" "$credentials" > "$log"',
  `  codes=("\${PIPESTATUS[@]}")`,
  `  printf "%s %s\\n" "\${codes[0]}" "\${codes[1]}" > "$status"`,
  "fi",
  'rm -f "$credentials"',
  'exec "$launchctl" remove "$label"',
].join("\n");

/** A separate launchd job survives kickstart of the daemon's job (ordinary child processes don't). */
export async function deployProcess(
  cwd: string,
  sha: string,
  job: string = randomUUID(),
  command = sh,
  logs = DEFAULT_LOGS,
  launchctl = "/bin/launchctl",
  port = 7400,
  options: WaitOptions = {},
): Promise<DeployResult> {
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  chmodSync(logs, 0o700);
  const { label, log, status, credentials } = deployJob(job, logs, options.home);
  mkdirSync(deployCredentialsDir(options.home), { recursive: true, mode: 0o700 });
  const time = (options.now ?? Date.now)();
  writeFileSync(credentials, JSON.stringify(registeredCredentials()), { mode: 0o600, flag: "wx" });
  try {
    await command(
      [
        launchctl,
        "submit",
        "-l",
        label,
        "-o",
        "/dev/null",
        "-e",
        "/dev/null",
        "--",
        "/bin/bash",
        "-c",
        WRAPPER,
        "auto-deploy",
        status,
        label,
        launchctl,
        credentials,
        process.execPath,
        join(import.meta.dir, "redact-deploy.ts"),
        log,
        "/usr/bin/env",
        ...["HOME", "PATH", "LANG", "LIMITLESS_HOME", "LIMITLESS_CONFIG_DIR"].flatMap((key) =>
          process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`],
        ),
        `LIMITLESS_PORT=${port}`,
        `LIMITLESS_APP_DIR=${cwd}`,
        process.execPath,
        join(cwd, "src/cli/main.ts"),
        "deploy",
        sha,
        "--smoke",
      ],
      { cwd, timeoutMs: 10_000 },
    );
  } catch (error) {
    await rm(credentials, { force: true });
    throw error;
  }
  for (;;) {
    const state = await deployJobStatus(job, time, command, logs, launchctl, options);
    if (state.kind !== "running") {
      // Do not delete the status/marker here: the daemon must first persist the outcome.
      await launchctlJob(command, launchctl, "remove", label, cwd);
      return state.kind === "done" ? completedDeployResult(state) : { ok: false, reason: state.reason };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  }
}

/** Called only after the outcome is durable. Failed removals stay pending for the next tick. */
export async function removeDeployJob(
  job: string,
  command = sh,
  logs = DEFAULT_LOGS,
  launchctl = "/bin/launchctl",
  options: WaitOptions & { time?: number; recorded?: boolean } = {},
): Promise<boolean> {
  if (!options.recorded) {
    const state = await deployJobStatus(job, options.time ?? Date.now(), command, logs, launchctl, options);
    if (state.kind === "running") return false;
  }
  const { label, status, credentials } = deployJob(job, logs, options.home);
  const removed = await launchctlJob(command, launchctl, "remove", label, logs);
  if (removed?.exitCode !== 0) {
    const listed = await launchctlJob(command, launchctl, "list", label, logs);
    // launchctl list reports an unknown service with 113. Other errors prove nothing.
    if (listed?.exitCode !== 113) return false;
  }
  await rm(credentials, { force: true });
  await Promise.all([status, `${status}.started`].map((path) => rm(path, { force: true })));
  return true;
}

/** Keep log availability independent of the deploy outcome, including boot reconciliation. */
export function completedDeployResult(state: Extract<DeployJobStatus, { kind: "done" }>): DeployResult {
  const unavailable = state.filterExitCode !== undefined && state.filterExitCode !== 0;
  const codes = {
    exitCode: state.exitCode,
    ...(state.filterExitCode === undefined ? {} : { filterExitCode: state.filterExitCode }),
  };
  if (state.exitCode === 0)
    return { ok: true, ...codes, ...(unavailable ? { reason: "log unavailable" } : {}) };
  return {
    ok: false,
    ...codes,
    reason: `Deploy exited ${state.exitCode}: ${unavailable ? "log unavailable" : state.tail}`,
  };
}
