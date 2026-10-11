import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import type { TestLane } from "../gates/agent-tests.ts";
import type { SlottedCommands } from "../harness/slotted-config.ts";
import { redactCredentials, registerCredential } from "../util/proc.ts";
import { bounded, type DeployClock, deployClock } from "./deploy-wait.ts";
import {
  type LeaseClient,
  type LeaseOptions,
  LeaseRejected,
  localLeaseClient,
  runLeasedCommand,
} from "./gate-slot.ts";

export interface WrapperConfig {
  commands: SlottedCommands;
  directory: string;
  port: number;
  unix: string;
  token: string;
}

const valuedTestOptions = new Set([
  "--cwd",
  "--preload",
  "-r",
  "--timeout",
  "-t",
  "--test-name-pattern",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--retry",
  "--rerun-each",
  "--seed",
  "--shard",
  "--coverage-reporter",
  "--coverage-dir",
  "--path-ignore-patterns",
  "--config",
  "-c",
  "--env-file",
  "--tsconfig-override",
  "--define",
  "-d",
  "--parallel",
  "--parallel-delay",
  "--timings",
]);
const booleanTestOptions = new Set([
  "--only",
  "--todo",
  "--watch",
  "--update-snapshots",
  "-u",
  "--coverage",
  "--bail",
  "--concurrent",
  "--randomize",
  "--pass-with-no-tests",
  "--dots",
  "--only-failures",
  "--isolate",
  "--no-isolate",
  "--update-timings",
  "--no-orphans",
  "--no-env-file",
]);

export function testLane(argv: string[], prefix: string[], cwd = process.cwd()): TestLane {
  const bunTest = argv[0] === "bun" && argv[1] === "test";
  const extra = argv.slice(bunTest ? 2 : prefix.length);
  let positional = false,
    file = false;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i] ?? "";
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      const option = arg.split("=")[0] ?? arg;
      if (!bunTest || option === "--cwd") return "gate";
      if (valuedTestOptions.has(option)) {
        if (!arg.includes("=")) {
          if (!extra[i + 1] || extra[i + 1]?.startsWith("-")) return "gate";
          i++;
        }
      } else if (booleanTestOptions.has(arg) || /^--bail=\d+$/.test(arg)) {
        // Boolean options never consume a following file argument.
      } else return "gate";
    } else {
      try {
        if (!arg || !statSync(resolve(cwd, arg)).isFile()) return "gate";
        file = true;
      } catch {
        return "gate";
      }
    }
  }
  return file ? "small" : "gate";
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

export function wrapperLeaseClient(config: WrapperConfig, clock: DeployClock = deployClock): LeaseClient {
  const http = localLeaseClient(config.port),
    unix = localLeaseClient(config.port, config.unix);
  let socket = false;
  return async (body, signal) => {
    const first = socket ? unix : http,
      second = socket ? http : unix;
    try {
      return await bounded(clock, (attempt) => first(body, AbortSignal.any([signal, attempt])), 1000);
    } catch (error) {
      if (error instanceof LeaseRejected) throw error;
      signal.throwIfAborted();
      const reply = await second(body, signal);
      socket = !socket;
      return reply;
    }
  };
}

export async function agentTestCommand(
  config: WrapperConfig,
  argv: string[],
  client = wrapperLeaseClient(config),
  options: Pick<LeaseOptions, "clock" | "maxWaitMs"> = {},
): Promise<number> {
  registerCredential("LIMITLESS_AGENT_TEST_CAPABILITY", config.token);
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
  const env = { ...process.env };
  const waiter = crypto.randomUUID();
  return runLeasedCommand(
    [executable, ...argv.slice(1)],
    {
      ...options,
      name: redactCredentials(argv.join(" ")),
      agentTest: {
        lane,
        parentId: process.env.LIMITLESS_AGENT_TEST_LEASE,
        onLease: (id) => {
          env.LIMITLESS_AGENT_TEST_LEASE = id;
        },
      },
      client: (body, signal) =>
        client({ ...body, token: config.token, lane, ...(body.name ? { waiter } : {}) }, signal),
      warn: (message) => console.warn(redactCredentials(message)),
    },
    true,
    env,
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

/** Returns to the caller's directory; a cwd the shell could not resolve must not stop the real binary. */
export function enterCallerDirectory(directory: string | undefined): void {
  for (const candidate of [directory, process.env.PWD]) {
    if (!candidate) continue;
    try {
      process.chdir(candidate);
      return;
    } catch {}
  }
  console.warn("agent-test: could not enter the caller's directory; running from the wrapper directory");
}

if (import.meta.main) {
  enterCallerDirectory(process.argv[2]);
  process.exitCode = await wrapperMain(process.argv.slice(3));
}
