import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentEnv, type ProcResult, runProcess } from "../util/proc.ts";
import { ConfinementError, runSandboxed, SANDBOX_EXEC, seatbeltProfile } from "./sandbox.ts";
import {
  createScratch,
  privateReadRoots,
  readConfinement,
  removeScratch,
  spellings,
  validateDenyRead,
  validateScratch,
} from "./scratch.ts";
import type { AgentSpec } from "./types.ts";

const paths = (list: string[]) =>
  list.map((path) => {
    if (/["\\]/.test(path) || [...path].some((c) => c < " "))
      throw new ConfinementError("Cannot confine reads to an unusual path");
    return `(subpath "${path}")`;
  });

/** Factor the address out: repeating localhost for every port exceeds Seatbelt's compiled limit. */
function portRules(operation: string, side: "local" | "remote", first: number, last: number): string[] {
  const rules: string[] = [];
  for (let start = first; start <= last; start += 256) {
    const ports = Array.from(
      { length: Math.min(256, last - start + 1) },
      (_, offset) => `"*:${start + offset}"`,
    );
    rules.push(`(${operation} (require-all (${side} tcp "localhost:*") (${side} tcp ${ports.join(" ")})))`);
  }
  return rules;
}

/** Read-only files, private scratch, and TCP loopback in the IANA ephemeral range only. */
export function readerSeatbeltProfile(spec: AgentSpec): string {
  const scratch = validateScratch(spec);
  const confined = spec.confineReads ? readConfinement(spec, scratch) : null;
  const readable = confined ? [...confined.cwd, ...confined.scratch] : [];
  const exclusions = paths(readable).map((path) => `(require-not ${path})`);
  const denied = paths(confined ? privateReadRoots() : []);
  return [
    seatbeltProfile({ write: spellings([scratch]), protect: [] }),
    ...denied.map((path) => `(deny file-read* (require-all ${path} ${exclusions.join(" ")}))`),
    ...paths(validateDenyRead(spec, scratch)).map((path) => `(deny file-read* ${path})`),
    "(deny network*)",
    // Seatbelt cannot express port zero. Permit loopback binding, then check the allocated
    // port at listen/accept and connect: no fixed service-port listener can receive traffic.
    '(allow network-bind (local tcp "localhost:*"))',
    ...portRules("allow network-inbound", "local", 49152, 65535),
    ...portRules("allow network-outbound", "remote", 49152, 65535),
  ].join("\n");
}

interface ReaderProfile {
  scratch: string;
  profile: string;
  outside: string;
}

/** The profile and its read canary stay outside agent-writable scratch for the whole invocation. */
async function withReaderProfile<T>(spec: AgentSpec, invoke: (profile: ReaderProfile) => Promise<T>) {
  if (spec.mode !== "readonly" || spec.noTools)
    throw new ConfinementError("Reader commands require a tool-enabled read-only invocation");
  const scratch = validateScratch(spec);
  const owned = createScratch(scratch);
  try {
    const outside = join(owned, "canary");
    const profile = join(owned, "profile.sb");
    writeFileSync(outside, "private", { mode: 0o600 });
    writeFileSync(profile, readerSeatbeltProfile({ ...spec, denyRead: [...(spec.denyRead ?? []), owned] }), {
      mode: 0o600,
    });
    return await invoke({ scratch, profile, outside });
  } finally {
    removeScratch(owned);
  }
}

/** Probe and payload share one profile/process, so an unenforced reader never executes a command. */
export async function runReaderCommand(
  spec: AgentSpec,
  command: string,
  signal = spec.signal,
  run = runProcess,
): Promise<ProcResult> {
  return withReaderProfile(spec, (profile) => executeReaderCommand(spec, profile, command, signal, run));
}

async function executeReaderCommand(
  spec: AgentSpec,
  { scratch, profile, outside }: ReaderProfile,
  command: string,
  signal: AbortSignal,
  run: typeof runProcess,
): Promise<ProcResult> {
  if (process.platform !== "darwin") throw new ConfinementError("Reader commands require macOS Seatbelt");
  const inside = join(scratch, `reader-${crypto.randomUUID()}`);
  const blocked = join(spec.cwd, `reader-${crypto.randomUUID()}`);
  try {
    return await runSandboxed(
      {
        cmd: ["/bin/sh", "-c", command],
        cwd: spec.cwd,
        env: agentEnv({
          HOME: scratch,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          LIMITLESS_CONFINED: "1",
        }),
        signal,
        timeoutMs: spec.timeoutMs,
        idleTimeoutMs: spec.idleTimeoutMs,
      },
      { write: [scratch], protect: [] },
      run,
      async () => {},
      {
        verify: async () => {},
        wrap: (cmd) => [
          SANDBOX_EXEC,
          "-f",
          profile,
          "/bin/sh",
          "-c",
          'printf ok > "$1" && test "$(/bin/cat "$1")" = ok && ! /bin/cat "$2" >/dev/null 2>&1 && ! (printf no > "$3") 2>/dev/null || exit 125; shift 3; exec "$@"',
          "sh",
          inside,
          outside,
          blocked,
          ...cmd,
        ],
      },
    );
  } finally {
    rmSync(inside, { force: true });
    rmSync(blocked, { force: true });
  }
}

/** The CLI stays outside Seatbelt for model transport; only its command tool runs this profile. */
export async function withReaderCommands<T>(
  spec: AgentSpec,
  invoke: (spec: AgentSpec) => Promise<T>,
  run = runProcess,
) {
  if (!spec.loopbackTests || spec.readerCommandUrl) return invoke(spec);
  return withReaderProfile(spec, (profile) => serveReaderCommands(spec, profile, invoke, run));
}

async function serveReaderCommands<T>(
  spec: AgentSpec,
  profile: ReaderProfile,
  invoke: (spec: AgentSpec) => Promise<T>,
  run: typeof runProcess,
) {
  const path = `/${crypto.randomUUID()}`;
  const stopped = new AbortController();
  const commands = new Set<Promise<ProcResult>>();
  const active = new Set<Server>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== path || req.method !== "POST" || req.headers.has("origin"))
        return new Response("forbidden", { status: 403 });
      const mcp = new Server({ name: "reader", version: "1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "command",
            description:
              "Run a verification command in the read-only checkout. Scratch writes and ephemeral loopback TCP tests are permitted; other networking is denied.",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            },
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (request.params.name !== "command") throw new Error("Unknown reader tool");
        const { command } = z
          .object({ command: z.string().min(1) })
          .strict()
          .parse(request.params.arguments);
        const pending = executeReaderCommand(
          spec,
          profile,
          command,
          AbortSignal.any([spec.signal, req.signal, extra.signal, stopped.signal]),
          run,
        );
        commands.add(pending);
        let result: ProcResult;
        try {
          result = await pending;
        } finally {
          commands.delete(pending);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: result.exitCode !== 0 || result.cancelled || result.timedOut || result.idleTimedOut,
        };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      active.add(mcp);
      try {
        await mcp.connect(transport);
        return await transport.handleRequest(req);
      } finally {
        active.delete(mcp);
        await mcp.close();
      }
    },
  });
  try {
    return await invoke({ ...spec, readerCommandUrl: `http://127.0.0.1:${server.port}${path}` });
  } finally {
    stopped.abort();
    server.stop(true);
    await Promise.allSettled([...commands]);
    await Promise.all([...active].map((mcp) => mcp.close()));
  }
}
