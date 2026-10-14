import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../src/util/proc.ts";

test("CLI 401 explains an origin mismatch while unrelated 401 keeps the server reason", async () => {
  const home = mkdtempSync(join(tmpdir(), "limitless-cli-origin-"));
  const secret = "synthetic-origin-token";
  const bound = "http://127.0.0.1:7400";
  const target = "http://localhost:7400";
  const preload = join(home, "fetch.ts");
  // Exercise the real CLI and token files without requiring a listening socket in a confined worker.
  writeFileSync(
    preload,
    `globalThis.fetch = async (url, init) => {
      console.log(JSON.stringify({ origin: new URL(url).origin, authorized: new Headers(init?.headers).has("authorization") }));
      return Response.json({ error: "API token required: update the limitless CLI" }, { status: 401 });
    };`,
  );
  writeFileSync(join(home, "api-token"), secret);
  writeFileSync(
    join(home, "api-token.origin"),
    JSON.stringify({ origin: bound, tokenHash: createHash("sha256").update(secret).digest("hex") }),
  );
  try {
    const request = (url = target) =>
      sh([process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli/main.ts"), "ls"], {
        cwd: home,
        env: { ...process.env, LIMITLESS_HOME: home, LIMITLESS_URL: url },
        allowFail: true,
      });
    const mismatch = await request();
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr).toContain("401: API token withheld");
    expect(mismatch.stderr).toContain("requested origin differs");
    expect(mismatch.stderr).toContain(bound);
    expect(mismatch.stderr).not.toContain("update the limitless CLI");
    expect(mismatch.stdout + mismatch.stderr).not.toContain(secret);
    expect(JSON.parse(mismatch.stdout)).toEqual({ origin: target, authorized: false });
    const matching = await request(bound);
    expect(matching.exitCode).not.toBe(0);
    expect(matching.stderr).toContain("401: API token required: update the limitless CLI");
    expect(matching.stderr).not.toContain("origin differs");
    expect(JSON.parse(matching.stdout)).toEqual({ origin: bound, authorized: true });
    rmSync(join(home, "api-token"));
    const unrelated = await request();
    expect(unrelated.exitCode).not.toBe(0);
    expect(unrelated.stderr).toContain("401: API token required: update the limitless CLI");
    expect(unrelated.stderr).not.toContain("origin differs");
    expect(JSON.parse(unrelated.stdout)).toEqual({ origin: target, authorized: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
