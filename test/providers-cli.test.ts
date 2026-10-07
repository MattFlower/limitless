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
          discovery: { servedNotInCatalog: ["new-backend"], catalogNotServed: ["claude/old"] },
          windows: {
            five_hour: { utilization: 0.721, resetsAt: now + 60_000, observedAt: now - 12 * 60_000 },
            seven_day: { utilization: 1, resetsAt: null, observedAt: null },
            future: { utilization: 0, resetsAt: null, observedAt: now + 60_000 },
          },
        },
        {
          id: "work",
          state: "ok",
          reason: null,
          maxConcurrent: 1,
          quota: "unlimited",
          windows: {},
        },
        {
          id: "work-observed",
          state: "ok",
          reason: null,
          maxConcurrent: 1,
          quota: "unlimited",
          windows: { five_hour: { utilization: 0.99, observedAt: now } },
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
    expect(stdout).toContain("served-not-in-catalog: new-backend");
    expect(stdout).toContain("catalog-not-served: claude/old");
    expect(stdout.split("\n").find((line) => line.startsWith("claude"))).not.toContain("No limit");
    expect(stdout.split("\n").find((line) => line.startsWith("work "))).toContain("No limit (configured)");
    expect(stdout.split("\n").find((line) => line.startsWith("work-observed"))).toContain(
      "No limit (configured) five_hour 99%",
    );
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

test("fast CLI sends boolean on/off and reports invalid arguments and provider errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-fast-cli-"));
  const preload = join(dir, "fetch.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      console.log("REQUEST " + init.method + " " + path + " " + init.headers["content-type"]);
      console.log("BODY " + init.body);
      const id = path.split("/")[3];
      if (id === "unknown") return Response.json({ error: "unknown provider unknown" }, { status: 400 });
      if (id === "openrouter") return Response.json({ error: "fast mode unsupported for provider openrouter" }, { status: 400 });
      return Response.json({ id, fast: JSON.parse(init.body).on });
    };`,
  );
  try {
    for (const id of ["claude", "codex", "unknown", "openrouter"]) {
      for (const value of ["on", "off", "yes"]) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--preload",
            preload,
            join(import.meta.dir, "../src/cli/main.ts"),
            "providers",
            "fast",
            value,
            id,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const output = await new Response(child.stdout).text();
        const error = await new Response(child.stderr).text();
        const supported = id === "claude" || id === "codex";
        expect(await child.exited).toBe(value === "yes" || !supported ? 1 : 0);
        if (value === "yes") {
          expect(output).not.toContain("REQUEST");
          expect(error).toContain("usage: limitless providers fast on|off <id>");
        } else if (!supported) {
          expect(output).toContain(`REQUEST POST /api/providers/${id}/fast application/json`);
          expect(output).not.toContain(`${id}: fast`);
          expect(error).toContain(
            id === "unknown" ? "unknown provider unknown" : "fast mode unsupported for provider openrouter",
          );
        } else {
          expect(error).toBe("");
          expect(output).toContain(`REQUEST POST /api/providers/${id}/fast application/json`);
          expect(output).toContain(`BODY {"on":${value === "on"}}`);
          expect(output).toContain(`${id}: fast ${value}`);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("providers CLI reports missing named credentials when listing and enabling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-missing-cli-"));
  try {
    const preload = join(dir, "missing.ts");
    writeFileSync(
      preload,
      `globalThis.fetch = async (input, init) => {
      const provider = { id: "custom", state: "disabled", reason: "missing key EXAMPLE_KEY", maxConcurrent: 4, windows: {} };
      return Response.json(init?.method === "POST" ? provider : [provider]);
    };`,
    );
    for (const args of [[], ["enable", "custom"]]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          join(import.meta.dir, "../src/cli/main.ts"),
          "providers",
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain("missing key EXAMPLE_KEY");
      expect(output).toContain("disabled");
      expect(output).not.toContain("never-publish-sentinel");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
