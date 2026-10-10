import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import type { TestLane } from "../gates/agent-tests.ts";
import type { SlottedCommands } from "../harness/slotted-config.ts";
import { redactCredentials } from "../util/proc.ts";
import { type LeaseClient, LeaseRejected, localLeaseClient, runLeasedCommand } from "./gate-slot.ts";

export interface WrapperConfig {
  commands: SlottedCommands;
  directory: string;
  port: number;
  unix: string;
  token: string;
}

export function testLane(argv: string[], prefix: string[]): TestLane {
  const extra = argv.slice(prefix.length);
  // Only file/path arguments or an explicit name filter prove a targeted test run.
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i] ?? "";
    if (
      arg === "-t" ||
      arg === "--test-name-pattern" ||
      arg.startsWith("--test-name-pattern=") ||
      /^-t.+/.test(arg)
    )
      return "small";
    if (arg === "--") return extra.slice(i + 1).some(Boolean) ? "small" : "gate";
    if (
      [
        "--timeout",
        "--preload",
        "--reporter",
        "--reporter-outfile",
        "--max-concurrency",
        "--retry",
        "--rerun-each",
        "--seed",
        "--shard",
        "--parallel",
        "--parallel-delay",
        "--timings",
        "--path-ignore-patterns",
        "--coverage-reporter",
        "--coverage-dir",
        "--bail",
      ].includes(arg)
    ) {
      if (extra[i + 1] && !extra[i + 1]?.startsWith("-")) i++;
    } else if (!arg.startsWith("-") && arg) return "small";
  }
  return "gate";
}

export function realExecutable(name: string, path: string, wrapperDir: string): string | null {
  const own = realpathSync(wrapperDir);
  for (const dir of path.split(delimiter)) {
    try {
      if (realpathSync(dir || ".") === own) continue;
      const candidate = resolve(dir || ".", name);
      // A symlink to the wrapper is just another spelling of the same executable.
      if (dirname(realpathSync(candidate)) === own) continue;
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* missing directory or executable */
    }
  }
  return null;
}

export function wrapperLeaseClient(config: WrapperConfig): LeaseClient {
  const http = localLeaseClient(config.port),
    unix = localLeaseClient(config.port, config.unix);
  let socket = false;
  return async (body, signal) => {
    if (socket) return unix(body, signal);
    try {
      return await http(body, signal);
    } catch (error) {
      if (error instanceof LeaseRejected) throw error;
      socket = true;
      signal.throwIfAborted();
      return unix(body, signal);
    }
  };
}

export async function agentTestCommand(
  config: WrapperConfig,
  argv: string[],
  client = wrapperLeaseClient(config),
): Promise<number> {
  const name = argv[0];
  const executable = name && realExecutable(name, process.env.PATH ?? "", config.directory);
  if (!executable) {
    console.error(redactCredentials(`agent-test: real executable not found: ${name ?? ""}`));
    return 127;
  }
  const prefix = config.commands
    .filter((p) => p.every((token, i) => argv[i] === token))
    .sort((a, b) => b.length - a.length)[0];
  if (!prefix) return runLeasedCommand([executable, ...argv.slice(1)], undefined, true);
  const lane = testLane(argv, prefix);
  return runLeasedCommand(
    [executable, ...argv.slice(1)],
    {
      name: redactCredentials(argv.join(" ")),
      client: (body, signal) => client({ ...body, token: config.token, lane }, signal),
      warn: (message) => console.warn(redactCredentials(message)),
    },
    true,
  );
}

export async function wrapperMain(args: string[]): Promise<number> {
  try {
    const config: WrapperConfig = await Bun.file(args[0] ?? "").json();
    return await agentTestCommand(config, args.slice(1));
  } catch (error) {
    console.error(redactCredentials(`agent-test: ${String(error)}`));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await wrapperMain(process.argv.slice(2));
