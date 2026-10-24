import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import type { Role } from "../core/types.ts";
import type { TestLane } from "../gates/agent-tests.ts";
import type { AgentFullSuite, SlottedCommands } from "../harness/slotted-config.ts";
import { redactCredentials, registerCredential } from "../util/proc.ts";
import { bounded, DaemonTimeoutError, type DeployClock, deployClock } from "./deploy-wait.ts";
import {
  type LeaseClient,
  type LeaseOptions,
  LeaseRejected,
  LeaseTransportFailures,
  localLeaseClient,
  runLeasedCommand,
} from "./gate-slot.ts";

export interface WrapperConfig {
  role?: Role;
  agentFullSuite?: AgentFullSuite;
  commands: SlottedCommands;
  directory: string;
  port?: number;
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

// EPERM: a sandbox refused connect() itself, as Claude's reader sandbox does for loopback and sockets.
const PRECONNECTION_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "EPERM",
]);
const UNIX_PATH_MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

function preconnectionFailure(error: unknown, socket: boolean): boolean {
  if (!error || typeof error !== "object") return false;
  // Node fetch wraps its socket error in cause; Bun exposes the code directly.
  const failure = "code" in error ? error : "cause" in error ? error.cause : undefined;
  if (!failure || typeof failure !== "object" || !("code" in failure)) return false;
  return (
    typeof failure.code === "string" &&
    (PRECONNECTION_SOCKET_CODES.has(failure.code) || (socket && UNIX_PATH_MISSING_CODES.has(failure.code)))
  );
}

export function wrapperLeaseClient(
  config: WrapperConfig,
  clock: DeployClock = deployClock,
  http = localLeaseClient(config.port),
  unix = localLeaseClient(config.port, config.unix),
): LeaseClient {
  if (config.port === undefined) return unix;
  let socket = false;
  return async (body, signal, onLateReply, onFailure) => {
    const usingSocket = body.gate !== undefined || socket,
      first = usingSocket ? unix : http,
      second = usingSocket ? http : unix;
    let pending: ReturnType<LeaseClient> | undefined;
    try {
      if (body.gate !== undefined) return await first(body, signal);
      return await bounded(
        clock,
        (attempt) => {
          pending = first(body, AbortSignal.any([signal, attempt]));
          return pending;
        },
        1000,
      );
    } catch (error) {
      if (error instanceof LeaseRejected) throw error;
      if (error instanceof DaemonTimeoutError) void pending?.then(onLateReply, () => {});
      signal.throwIfAborted();
      const failures = (fallbackError: unknown) =>
        new LeaseTransportFailures(
          usingSocket ? fallbackError : error,
          usingSocket ? error : fallbackError,
          preconnectionFailure(error, usingSocket) && preconnectionFailure(fallbackError, !usingSocket),
        );
      const aborted = () => onFailure?.(failures(new DaemonTimeoutError()));
      signal.addEventListener("abort", aborted, { once: true });
      try {
        const reply = await second(body, signal);
        socket = !usingSocket;
        return reply;
      } catch (fallbackError) {
        if (fallbackError instanceof LeaseRejected) throw fallbackError;
        throw failures(fallbackError);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
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
  const prefix = config.commands
    .filter((p) => p.every((token, i) => argv[i] === token))
    .sort((a, b) => b.length - a.length)[0];
  const lane = prefix ? testLane(argv, prefix) : undefined;
  if (lane === "gate" && config.role === "implement" && config.agentFullSuite === "gate") {
    try {
      const reply = await client(
        { token: config.token, name: redactCredentials(argv.join(" ")), lane, gate: crypto.randomUUID() },
        new AbortController().signal,
      );
      const result = reply.factoryGate;
      if (
        !result ||
        !Number.isInteger(result.status) ||
        result.status < 0 ||
        result.status > 255 ||
        typeof result.text !== "string"
      )
        throw new LeaseRejected("invalid factory gate response");
      console.log(redactCredentials(result.text));
      return result.status;
    } catch (error) {
      console.error(redactCredentials(`agent-test: factory gate failed: ${String(error)}`));
      return 1;
    }
  }
  if (lane === "gate" && config.role === "implement" && config.agentFullSuite === "refuse") {
    console.error(
      "agent-test: full suite refused; the factory's gates run the full suite after this round. Run the affected test files instead, for example: bun test test/<file>.test.ts",
    );
    await client(
      { token: config.token, name: redactCredentials(argv.join(" ")), lane, refused: crypto.randomUUID() },
      AbortSignal.timeout(1000),
    );
    return 1;
  }
  const executable = name && realExecutable(name, process.env.PATH ?? "", config.directory);
  if (!executable) {
    console.error(redactCredentials(`agent-test: real executable not found: ${name ?? ""}`));
    return 127;
  }
  if (!lane) return runLeasedCommand([executable, ...argv.slice(1)], undefined, true);
  const env = { ...process.env };
  const waiter = crypto.randomUUID();
  return runLeasedCommand(
    [executable, ...argv.slice(1)],
    {
      ...options,
      name: redactCredentials(argv.join(" ")),
      agentTest: {
        lane,
        assertActive: () => {
          try {
            accessSync(config.directory);
          } catch {
            throw new LeaseRejected("agent-test invocation ended");
          }
        },
        parentId: process.env.LIMITLESS_AGENT_TEST_LEASE,
        onLease: (id) => {
          env.LIMITLESS_AGENT_TEST_LEASE = id;
        },
      },
      client: (body, signal, onLateReply, onFailure) =>
        client(
          { ...body, token: config.token, lane, ...(body.name ? { waiter } : {}) },
          signal,
          onLateReply,
          onFailure,
        ),
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

export async function agentTestEntry(args: string[]): Promise<number> {
  const options = process.env.LIMITLESS_WRAPPER_BUN_OPTIONS;
  if (options === undefined) delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = options;
  delete process.env.LIMITLESS_WRAPPER_BUN_OPTIONS;
  enterCallerDirectory(args[0]);
  return wrapperMain(args.slice(1));
}

if (import.meta.main) process.exitCode = await agentTestEntry(process.argv.slice(2));
