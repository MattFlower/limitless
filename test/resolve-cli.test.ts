import { expect, test } from "bun:test";
import { join } from "node:path";

type Seen = { method: string; path: string; type: string | null; body: unknown };

async function cli(args: string[], respond: () => Response) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, type: req.headers.get("content-type"), body: JSON.parse(text) });
      return respond();
    },
  });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "resolve", ...args],
      {
        env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { seen, stdout, stderr, exit };
  } finally {
    server.stop();
  }
}

test("resolve posts the kind, ref and note once and reports the outcome or the daemon's error", async () => {
  const ok = await cli(
    ["run 1", "--as", "done_elsewhere", "--ref", "https://github.com/o/r/pull/9", "--note", "landed by hand"],
    () => Response.json({ id: "run 1", resolution: { kind: "done_elsewhere" } }),
  );
  expect(ok.exit).toBe(0);
  expect(ok.stdout).toContain("Resolved run 1 as done_elsewhere");
  expect(ok.seen).toEqual([
    {
      method: "POST",
      path: "/api/runs/run%201/resolve",
      type: "application/json",
      body: { kind: "done_elsewhere", ref: "https://github.com/o/r/pull/9", note: "landed by hand" },
    },
  ]);

  const conflict = await cli(["r1", "--as", "wont_do"], () =>
    Response.json(
      { error: "run is running; only needs_human and failed runs can be resolved" },
      { status: 409 },
    ),
  );
  expect(conflict.exit).not.toBe(0);
  expect(conflict.stderr).toContain("409: run is running");
  expect(conflict.seen).toEqual([
    { method: "POST", path: "/api/runs/r1/resolve", type: "application/json", body: { kind: "wont_do" } },
  ]);

  const usage = await cli(["r1"], () => Response.json({}));
  expect(usage.exit).not.toBe(0);
  expect(usage.stderr).toContain("usage: limitless resolve");
  expect(usage.seen).toEqual([]);
});
