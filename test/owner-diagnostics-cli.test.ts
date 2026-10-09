import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerDiagnostics } from "../src/db/owner-diagnostics.ts";
import { Store } from "../src/db/store.ts";
import { registerCredential, runProcess } from "../src/util/proc.ts";

let home: string;
let store: Store;
let runId: string;
let invocationId: number;
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "owner-diagnostics-cli-"));
  store = new Store(join(home, "limitless.db"));
  const repo = store.upsertRepo({
    slug: "local/test",
    kind: "local",
    localPath: home,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  runId = store.createRun(repo, { repo: repo.slug, prompt: "diagnostics" }).id;
  invocationId = store.createInvocation({
    runId,
    stageId: null,
    role: "verify",
    harness: "fake",
    provider: "fake",
    model: "fake",
    modelId: "fake/m",
  }).id;
  store.updateInvocation(invocationId, { error: "public error [private detail]" });
  store.addEvent({ runId, invocationId, type: "text", message: "public result [private detail]" });
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname.endsWith("/stream"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json(
        new URL(req.url).pathname.endsWith("/events") ? store.listEvents(runId) : store.getRunDetail(runId),
      );
    },
  });
});
afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(home, { recursive: true, force: true });
  stream = undefined;
});

const cli = (args: string[], onStdoutLine?: (line: string) => void) =>
  runProcess({
    cmd: ["bun", "src/cli/main.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      LIMITLESS_HOME: home,
      LIMITLESS_CONFIG_DIR: home,
      LIMITLESS_URL: `http://127.0.0.1:${server.port}`,
    },
    timeoutMs: 10_000,
    onStdoutLine,
  });

test("show and logs print originals beside public records, without credentials", async () => {
  const credential = "cli-owner-credential-423";
  registerCredential("CLI_OWNER_TEST", credential);
  const eventId = store.listEvents(runId).at(-1)?.id;
  for (const [kind, text] of [
    ["error", "AUTHORED_OWNER_TEXT_423"],
    ["result", '/private/runtime --force 48231 "runtime-input"'],
    ["event", "OWNER_EVENT_423"],
  ] as const)
    store.recordOwnerDiagnostic(
      { runId, invocationId, kind, text: `${text} ${credential}`, ...(kind === "event" ? { eventId } : {}) },
      "public",
    );
  store.recordOwnerDiagnostic({ runId, kind: "run-error", text: "OWNER_RUN_ERROR_423" }, "public");
  for (const command of ["show", "logs"]) {
    const result = await cli([command, runId]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const text of [
      "[owner diagnostic:",
      "AUTHORED_OWNER_TEXT_423",
      "--force 48231",
      "OWNER_EVENT_423",
      "OWNER_RUN_ERROR_423",
      "[redacted]",
    ])
      expect(result.stdout).toContain(text);
    expect(result.stdout).not.toContain(credential);
    expect(result.stdout).toContain(
      command === "show" ? "public error [private detail]" : "public result [private detail]",
    );
  }
});

test("unchanged text creates no owner copy or CLI section", async () => {
  store.recordOwnerDiagnostic(
    { runId, invocationId, kind: "error", text: "ordinary diagnostic" },
    "ordinary diagnostic",
  );
  expect(ownerDiagnostics(store.db, runId)).toEqual([]);
  for (const command of ["show", "logs"]) {
    const result = await cli([command, runId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("owner diagnostic");
  }
});

test("show and logs display pre-migration runs without diagnostics", async () => {
  store.db.exec(
    "DROP TABLE owner_diagnostics; DELETE FROM applied_migrations WHERE name = '20261009T223115-owner-diagnostics.sql'",
  );
  for (const command of ["show", "logs"]) {
    const result = await cli([command, runId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("public");
    expect(result.stdout).not.toContain("owner diagnostic");
  }
});

test("logs retain owner event diagnostics beyond the public event page", async () => {
  store.db.transaction(() => {
    for (let i = 0; i < 1005; i++) store.addEvent({ runId, type: "log", message: "earlier public event" });
  })();
  const event = store.addEvent({ runId, invocationId, type: "text", message: "[private detail]" });
  store.recordOwnerDiagnostic(
    { runId, invocationId, eventId: event.id, kind: "event", text: "LATE_OWNER_EVENT_423" },
    event.message,
  );
  const result = await cli(["logs", runId]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`[owner diagnostic: event #${event.id} event]`);
  expect(result.stdout).toContain("LATE_OWNER_EVENT_423");
});

test("logs -f reads newly recorded diagnostics without a public publication", async () => {
  let resolvePrinted: () => void = () => {};
  const printed = new Promise<void>((resolve) => {
    resolvePrinted = resolve;
  });
  const child = cli(["logs", runId, "-f"], (line) => {
    if (line.includes("LIVE_OWNER_423")) resolvePrinted();
  });
  const deadline = Date.now() + 5_000;
  while (!stream && Date.now() < deadline) await Bun.sleep(10);
  if (!stream) throw new Error("CLI never connected");
  store.recordOwnerDiagnostic({ runId, invocationId, kind: "error", text: "LIVE_OWNER_423" }, "public");
  await Promise.race([
    printed,
    child.then(() => {
      throw new Error("CLI exited before printing diagnostic");
    }),
  ]);
  stream.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ kind: "run", run: { ...store.getRun(runId), status: "failed" } })}\n\n`,
    ),
  );
  stream.close();
  const result = await child;
  expect(result.exitCode).toBe(0);
  expect(result.stdout.match(/LIVE_OWNER_423/g)).toHaveLength(1);
});
