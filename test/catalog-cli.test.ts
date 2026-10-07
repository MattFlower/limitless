import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogCommand } from "../src/cli/catalog.ts";

test("catalog CLI forwards complete add metadata and lists and removes through the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-catalog-cli-"));
  const preload = join(dir, "api.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (url, init) => {
    console.log("REQUEST " + (init?.method ?? "GET") + " " + new URL(url).pathname);
    if (init?.body) console.log("BODY " + init.body);
    return Response.json({ models: [{ id: "omlx/new", model: "new-build", source: "runtime", tier: 2 }], providers: [{ provider: "omlx", served: ["new-build"] }] });
  };`,
  );
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(import.meta.dir, "../src/cli/main.ts"),
        "catalog",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    return { stdout, stderr, exit: await child.exited };
  };
  try {
    const add = await run([
      "add",
      "omlx/new",
      "--model",
      "new-build",
      "--origin",
      "CN",
      "--base-origin",
      "CN",
      "--vendor",
      "qwen",
      "--tier",
      "2",
      "--price-input",
      "0",
      "--price-output",
      "0",
      "--price-cache-read",
      "0",
      "--efforts",
      "none,high",
      "--effort",
      "high",
      "--notes",
      "trial",
    ]);
    expect(add.exit).toBe(0);
    expect(add.stderr).toBe("");
    expect(add.stdout).toContain("REQUEST POST /api/catalog/models");
    const body = add.stdout.split("\n").find((line) => line.startsWith("BODY "));
    expect(JSON.parse(body?.slice(5) ?? "null")).toEqual({
      provider: "omlx",
      id: "new",
      model: "new-build",
      origin: "CN",
      base_origin: "CN",
      vendor: "qwen",
      tier: 2,
      efforts: ["none", "high"],
      effort: "high",
      price: { input: 0, output: 0, cache_read: 0 },
      notes: "trial",
    });
    const list = await run(["list"]);
    expect(list.exit).toBe(0);
    expect(list.stdout).toContain("omlx/new [runtime] new-build tier 2");
    expect(list.stdout).toContain("omlx served: new-build");
    const remove = await run(["remove", "omlx/new"]);
    expect(remove.exit).toBe(0);
    expect(remove.stdout).toContain("REQUEST DELETE /api/catalog/models/omlx%2Fnew");
    const invalid = await run(["add", "omlx/new", "--model", "new-build"]);
    expect(invalid.exit).toBe(1);
    expect(invalid.stdout).not.toContain("REQUEST");
    expect(invalid.stderr).toContain("--origin is required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog list marks excluded models and prints the configured safety constraint", async () => {
  const printed: string[] = [];
  const log = spyOn(console, "log").mockImplementation((text: string) => {
    printed.push(text);
  });
  try {
    await catalogCommand(
      ["list"],
      {},
      async <T>() =>
        ({
          excludeOrigins: ["CN"],
          providers: [],
          models: [
            {
              id: "fake/cn",
              model: "backend",
              source: "runtime",
              tier: 4,
              excluded: "origin excluded (CN; baseOrigin=CN)",
            },
          ],
        }) as T,
    );
    expect(printed).toContain('exclude_origins: ["CN"]');
    expect(printed.join("\n")).toContain(
      "fake/cn [runtime] backend tier 4; origin excluded (CN; baseOrigin=CN)",
    );
  } finally {
    log.mockRestore();
  }
});
