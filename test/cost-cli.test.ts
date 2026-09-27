import { expect, test } from "bun:test";
import { join } from "node:path";

test("ls leads with API-equivalent cost when paid spend is sub-cent", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json([
        {
          id: "run-1",
          status: "succeeded",
          stage: null,
          costUsd: 0.0002,
          costEquivUsd: 4.34,
          repoSlug: "local/repo",
          title: "Example",
        },
      ]),
  });
  try {
    const child = Bun.spawn(["bun", "src/cli/main.ts", "ls"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("≈$4.34");
    expect(stdout).not.toContain("$0.0002");
  } finally {
    server.stop();
  }
});
