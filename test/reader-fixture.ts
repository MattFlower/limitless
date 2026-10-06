import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SANDBOX_EXEC } from "../src/harness/sandbox.ts";
import { createScratch, removeScratch } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { type ProcOptions, type ProcResult, runProcess } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";

export const readerSkip =
  seatbeltSkip ??
  (Bun.spawnSync([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0
    ? null
    : "Seatbelt cannot start in this environment");

export async function callReaderTool(spec: AgentSpec, command: string) {
  if (!spec.readerCommandUrl) throw new Error("Missing reader command URL");
  const client = new Client({ name: "fake-verifier", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.readerCommandUrl)));
    const reply = await client.callTool({ name: "command", arguments: { command } });
    const content = reply.content;
    if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing command result");
    return { isError: reply.isError, result: JSON.parse(content[0].text) as ProcResult };
  } finally {
    await client.close();
  }
}

/** Exercise real subprocess output and MCP dispatch under factory gates, which cannot nest Seatbelt. */
export function recordingReaderLauncher() {
  const calls: { opts: ProcOptions; profile: string; path: string }[] = [];
  const run: typeof runProcess = async (opts) => {
    const path = opts.cmd[2];
    if (opts.cmd[0] !== SANDBOX_EXEC || opts.cmd[1] !== "-f" || !path)
      throw new Error("Missing Seatbelt launcher");
    calls.push({ opts, path, profile: readFileSync(path, "utf8") });
    // Keep runSandboxed's startup marker and real payload; OS enforcement has separate host tests.
    return runProcess({ ...opts, cmd: opts.cmd.slice(10) });
  };
  return { calls, run };
}

export function readerFixture() {
  const parent = mkdtempSync(join(tmpdir(), "reader-test-"));
  const cwd = join(parent, "work");
  mkdirSync(cwd);
  const scratchDir = createScratch(cwd);
  const privateFile = join(parent, "private.txt");
  writeFileSync(privateFile, "private");
  writeFileSync(join(cwd, "base.txt"), "base");
  let ipv6 = true;
  try {
    const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
    probe.stop(true);
  } catch (error) {
    if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    ipv6 = false;
  }
  writeFileSync(
    join(cwd, "sockets.py"),
    `
import errno, os, socket, sys

def exchange(family, host):
    with socket.socket(family, socket.SOCK_STREAM) as server:
        server.settimeout(2)
        server.bind((host, 0))
        assert 49152 <= server.getsockname()[1] <= 65535
        server.listen(1)
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(server.getsockname())
            with server.accept()[0] as accepted:
                client.sendall(b"hello")
                assert accepted.recv(5) == b"hello"
                accepted.sendall(b"ok")
                assert client.recv(2) == b"ok"

def denied(operation):
    try:
        operation()
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES, errno.EROFS), error
    else:
        raise AssertionError("sandbox allowed a forbidden operation")

def bind(host, port, family=socket.AF_INET):
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((host, port))
        sock.listen(1)

def connect(host, port, family=socket.AF_INET):
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(2)
        sock.connect((host, port))

exchange(socket.AF_INET, "127.0.0.1")
${ipv6 ? 'exchange(socket.AF_INET6, "::1")' : ""}
if "--exchange-only" in sys.argv:
    print("local-server tests passed")
    sys.exit(0)
denied(lambda: bind("0.0.0.0", 0))
denied(lambda: bind("127.0.0.1", 12345))
denied(lambda: connect("192.0.2.1", 49152))
denied(lambda: connect("127.0.0.1", 12345))
${ipv6 ? 'denied(lambda: bind("::", 0, socket.AF_INET6))\ndenied(lambda: connect("2001:db8::1", 49152, socket.AF_INET6))' : ""}
assert open("base.txt").read() == "base"
with open(os.path.join(os.environ["TMPDIR"], "note"), "w") as note:
    note.write("scratch")
denied(lambda: open("forbidden.txt", "w"))
denied(lambda: open(${JSON.stringify(privateFile)}).read())
denied(lambda: os.listdir(${JSON.stringify(homedir())}))
print("local-server tests passed")
`,
  );
  const spec: AgentSpec = {
    cwd,
    scratchDir,
    mode: "readonly",
    confineReads: true,
    loopbackTests: true,
    prompt: "Run the local-server acceptance test",
    timeoutMs: 180_000,
    idleTimeoutMs: 180_000,
    maxToolCalls: 1,
    logPath: join(scratchDir, "log"),
    signal: new AbortController().signal,
    onEvent: () => {},
    target: {
      modelId: "fake/verify",
      model: "verify",
      provider: "fake",
      harness: "fake",
      vendor: "fake",
      tier: 1,
      billing: "subscription",
    },
  };
  return {
    spec,
    command: "/usr/bin/python3 sockets.py",
    loopbackCommand: "/usr/bin/python3 sockets.py --exchange-only",
    cleanup: () => {
      removeScratch(scratchDir);
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
