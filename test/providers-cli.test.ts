import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("providers CLI shows rounded utilization and independent reading ages", async () => {
  const now = 1_000_000;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json([
        {
          id: "claude",
          state: "ok",
          reason: null,
          maxConcurrent: 5,
          windows: {
            five_hour: { utilization: 0.721, resetsAt: now + 60_000, observedAt: now - 12 * 60_000 },
            seven_day: { utilization: 1, resetsAt: null, observedAt: null },
            future: { utilization: 0, resetsAt: null, observedAt: now + 60_000 },
          },
        },
      ]),
  });
  const dir = mkdtempSync(join(tmpdir(), "limitless-providers-cli-"));
  try {
    const preload = join(dir, "clock.ts");
    writeFileSync(preload, `Date.now = () => ${now};\n`);
    const child = Bun.spawn(["bun", "--preload", preload, "src/cli/main.ts", "providers"], {
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
    expect(stdout).toContain("five_hour 73% (as of 12 min ago)");
    expect(stdout).toContain("seven_day 100% (as of unknown)");
    expect(stdout).toContain("future 0% (as of just now)");
    expect(stdout).toContain("maxConcurrent 5");
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider CLI mutations use the daemon API and report its state", async () => {
  for (const action of ["enable", "disable"] as const) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "fixtures/providers-cli-preload.ts"),
        join(import.meta.dir, "../src/cli/main.ts"),
        "providers",
        action,
        "claude",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    expect(output).toContain(`REQUEST POST /api/providers/claude/${action} application/json`);
    expect(output).toContain(`claude: ${action === "disable" ? "disabled" : "ok"}`);
  }
});
