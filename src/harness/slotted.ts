import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { WrapperConfig } from "../cli/agent-test.ts";
import { AgentTestSession, agentTestLease, type TestWait } from "../gates/agent-tests.ts";
import { scratchParent } from "./scratch.ts";
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

/** Sibling of scratch, outside the invocation's writable roots. Unset config allocates nothing. */
export async function withSlottedCommands<T>(
  commands: SlottedCommands,
  scratch: string,
  port: number,
  event: (data: TestWait) => void,
  invoke: (path?: string) => Promise<T>,
): Promise<T> {
  if (!commands.length) return invoke();
  const source = await wrapperBundle();
  const directory = join(scratchParent(scratch), `commands-${crypto.randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const session = new AgentTestSession(event);
  const unix = join(scratch, `slot-${crypto.randomUUID().slice(0, 8)}.sock`);
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      unix,
      async fetch(req) {
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
          req.signal.throwIfAborted();
          const lease = await agentTestLease(body);
          if (req.signal.aborted) await agentTestLease({ ...body, id: lease.id, release: true });
          req.signal.throwIfAborted();
          return Response.json(lease);
        } catch {
          return new Response("invalid agent-test lease", { status: 400 });
        }
      },
    });
    const config: WrapperConfig = { directory, commands, port, unix, token: session.token };
    const configPath = join(directory, "config.json"),
      entry = join(directory, "entry.js");
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o400 });
    writeFileSync(entry, source, { mode: 0o400 });
    for (const name of new Set(commands.map((c) => c[0]).filter((name): name is string => !!name)))
      writeFileSync(
        join(directory, name),
        // An absolute interpreter also works when "bash" itself is one of the wrapped names.
        `#!${process.execPath}\nimport { wrapperMain } from ${JSON.stringify(entry)};\nprocess.exitCode = await wrapperMain([${JSON.stringify(configPath)}, ${JSON.stringify(name)}, ...process.argv.slice(2)]);\n`,
        { mode: 0o500 },
      );
    return await invoke(`${directory}${delimiter}${process.env.PATH ?? ""}`);
  } finally {
    session.close();
    server?.stop(true);
    rmSync(unix, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
