import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("routing CLI uses guarded API requests and preserves groups, alternatives and efforts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-routing-cli-"));
  const preload = join(dir, "fetch.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    console.log("REQUEST " + (init.method ?? "GET") + " " + url.pathname + url.search + " " + init.headers["content-type"]);
    if (init.body) console.log("BODY " + init.body);
    if (url.pathname === "/api/routing/preview") return Response.json([
      { modelId: "codex/sol@high", eligible: true, reason: null },
      { modelId: "claude/opus", eligible: false, reason: "disabled" }
    ]);
    return Response.json({
      runId: url.searchParams.get("run"),
      layers: { operator: { implement: { small: ["codex/sol@high"] } } },
      effective: {
        implement: { small: { groups: url.searchParams.has("run") ? ["claude/opus", "codex/luna@low"] : ["codex/sol@high"], layer: url.searchParams.has("run") ? "run" : "operator" } },
        triage: { default: { groups: ["claude/opus"], layer: "evals" } }
      }, prefer: ["codex"], operatorPrefer: ["codex"]
    });
  };`,
  );
  async function run(...args: string[]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(import.meta.dir, "../src/cli/main.ts"),
        "routing",
        ...args,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output, error, exit };
  }
  try {
    const shown = await run("show", "--role", "implement");
    expect(shown.exit).toBe(0);
    expect(shown.error).toBe("");
    expect(shown.output).toContain("implement.small [operator] codex/sol@high");
    expect(shown.output).not.toContain("triage.default");
    expect((await run("show")).output).toContain("triage.default [evals] claude/opus");
    expect(shown.output).toContain("Global routing policy: per-run model chains take precedence");
    const pinned = await run("show", "--role", "implement", "--run", "pinned");
    expect(pinned.exit).toBe(0);
    expect(pinned.output).toContain("REQUEST GET /api/routing?run=pinned");
    expect(pinned.output).toContain("Routing for run pinned");
    expect(pinned.output).toContain("implement.small [run] claude/opus,codex/luna@low");
    expect(pinned.output).not.toContain("implement.small [operator]");
    const set = await run(
      "set",
      "implement.small",
      "codex/sol@high|claude/opus,codex/luna@low",
      "--note",
      "quota low",
    );
    expect(set.exit).toBe(0);
    expect(set.output).toContain("REQUEST PUT /api/routing/cells/implement/small application/json");
    expect(set.output).toContain(
      'BODY {"groups":["codex/sol@high|claude/opus","codex/luna@low"],"note":"quota low"}',
    );
    const reset = await run("reset", "implement.small");
    expect(reset.exit).toBe(0);
    expect(reset.output).toContain("REQUEST DELETE /api/routing/cells/implement/small application/json");
    const all = await run("reset", "--all");
    expect(all.exit).toBe(0);
    expect(all.output).toContain("REQUEST DELETE /api/routing/cells/implement/small application/json");
    expect(all.output).toContain("REQUEST DELETE /api/routing/prefer application/json");
    const preview = await run("preview", "implement", "small");
    expect(preview.exit).toBe(0);
    expect(preview.output).toContain("REQUEST GET /api/routing/preview?role=implement&complexity=small");
    expect(preview.output).toContain("codex/sol@high: eligible");
    expect(preview.output).toContain("claude/opus: skipped (disabled)");
    expect((await run("preview", "triage")).output).toContain("complexity=medium");
    expect((await run("preview", "triage", "small", "--run", "pinned")).output).toContain(
      "REQUEST GET /api/routing/preview?role=triage&complexity=small&run=pinned",
    );
    for (const args of [
      ["reset"],
      ["reset", "implement.small", "--all"],
      ["set", "bad", "codex/sol"],
      ["set", "implement.small", "codex/sol", "--run", "pinned"],
      ["reset", "--all", "--run", "pinned"],
      ["preview"],
    ]) {
      const invalid = await run(...args);
      expect(invalid.exit).toBe(1);
      expect(invalid.output).not.toContain("REQUEST");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
