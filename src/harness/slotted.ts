import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { WrapperConfig } from "../cli/agent-test.ts";
import {
  AgentTestSession,
  agentTestLease,
  type FactoryGateHandler,
  type TestWait,
} from "../gates/agent-tests.ts";
import { type Release, release } from "../release.ts";
import { commandDir, createCommandRoot } from "./scratch.ts";
import type { SlottedCommands } from "./slotted-config.ts";

let bundle: Promise<string> | undefined;
const wrapperBundle = () =>
  (bundle ??= (async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "../cli/agent-test.ts")],
      target: "bun",
    });
    if (!result.success || !result.outputs[0]) throw new Error("Cannot build agent-test wrapper");
    return result.outputs[0].text();
  })());

/** Outside the invocation's writable roots and unreadable to other invocations. Unset config allocates nothing. */
export async function withSlottedCommands<T>(
  commands: SlottedCommands,
  cwd: string,
  scratch: string,
  port: number | undefined,
  event: (data: TestWait) => void,
  invoke: (path?: string, idleNow?: () => number) => Promise<T>,
  onWatchdog?: (active: boolean, elapsedMs: number) => void,
  policy: Pick<WrapperConfig, "role" | "agentFullSuite"> = {},
  runtime: { release: Release; executable: string } = { release, executable: process.execPath },
  factoryGate?: FactoryGateHandler,
): Promise<T> {
  if (!commands.length) return invoke();
  const source = runtime.release.kind === "source" ? await wrapperBundle() : undefined;
  createCommandRoot(cwd, scratch);
  // Every agent and gate profile denies reads under the shared root except to this directory's owner.
  const directory = commandDir(scratch, cwd);
  mkdirSync(directory, { mode: 0o700 });
  const session = new AgentTestSession(event, {
    onWatchdog,
    factoryGate: factoryGate && AsyncLocalStorage.bind(factoryGate),
  });
  const unix = join(scratch, `slot-${crypto.randomUUID().slice(0, 8)}.sock`);
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      unix,
      async fetch(req, server) {
        if (
          req.method !== "POST" ||
          new URL(req.url).pathname !== "/api/admin/gate-slot" ||
          req.headers.has("origin")
        )
          return new Response("forbidden", { status: 403 });
        try {
          const body: Record<string, unknown> = await req.json();
          // This socket can only serve its owning invocation, even with another valid token.
          if (body.token !== session.token) return new Response("forbidden", { status: 403 });
          // A factory gate may wait for a slot and run for much longer than Bun's idle timeout.
          if (body.gate !== undefined) server.timeout(req, 0);
          req.signal.throwIfAborted();
          const lease = await agentTestLease(body);
          if (req.signal.aborted && body.gate === undefined)
            await agentTestLease({ ...body, id: lease.id, release: true });
          req.signal.throwIfAborted();
          return Response.json(lease);
        } catch {
          return new Response("invalid agent-test lease", { status: 400 });
        }
      },
    });
    const config: WrapperConfig = {
      ...policy,
      directory,
      commands,
      port,
      unix,
      token: session.token,
    };
    const configPath = join(directory, "config.json"),
      entry = join(directory, "entry.js"),
      bunfig = join(directory, "bunfig.toml");
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o400 });
    if (source !== undefined) {
      writeFileSync(entry, source, { mode: 0o400 });
      writeFileSync(bunfig, "preload = []\n", { mode: 0o400 });
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Bun reads BUN_OPTIONS before our entry runs; carry it separately until dispatch.
    const startup = `#!/bin/sh
if [ "\${BUN_OPTIONS+x}" = x ]; then
  export LIMITLESS_WRAPPER_BUN_OPTIONS="$BUN_OPTIONS"
else
  unset LIMITLESS_WRAPPER_BUN_OPTIONS
fi
unset BUN_OPTIONS
`;
    for (const name of new Set(commands.map((c) => c[0]).filter((name): name is string => !!name)))
      writeFileSync(
        join(directory, name),
        // Start outside the checkout so its env files and Bun preloads cannot affect the wrapper.
        // Absolute interpreters also work when the shell or Bun itself is a wrapped executable.
        // Pin the running binary. After brew upgrade + brew cleanup removes the old executable,
        // its daemon's wrappers fail with "not found" until limitless service install restarts it.
        startup +
          (source === undefined
            ? `unset BUN_BE_BUN\nexec ${quote(runtime.executable)} __agent-test "$(pwd -P)" ${quote(configPath)} ${quote(name)} "$@"\n`
            : `exec ${quote(process.execPath)} --no-env-file --config=${quote(bunfig)} --cwd ${quote(directory)} ${quote(entry)} "$(pwd -P)" ${quote(configPath)} ${quote(name)} "$@"\n`),
        { mode: 0o500 },
      );
    return await invoke(`${directory}${delimiter}${process.env.PATH ?? ""}`, session.idleNow);
  } finally {
    session.close();
    server?.stop(true);
    await session.settled();
    rmSync(unix, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
