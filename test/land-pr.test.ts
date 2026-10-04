import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("landing check uses a named gate slot and stops before delivery on failure", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".land-test-"));
  try {
    const log = join(dir, "calls");
    for (const executable of ["limitless", "bun", "git", "gh"]) {
      const path = join(dir, executable);
      writeFileSync(
        path,
        `#!/bin/sh\nprintf '%s\\n' "${executable} $*" >> "$CALLS"\n${executable === "limitless" ? "exit 7" : "exit 0"}\n`,
      );
      chmodSync(path, 0o755);
    }
    const child = Bun.spawn(["bash", "scripts/land-pr.sh", "289", "subject", dir], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("bun run check failed");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "bun install --frozen-lockfile",
      "limitless gate-slot --name land-pr #289 -- bun run check",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
