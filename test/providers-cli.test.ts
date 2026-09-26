import { expect, test } from "bun:test";
import { join } from "node:path";

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
