import { expect, test } from "bun:test";
import { join } from "node:path";
import { sh } from "../src/util/proc.ts";

test("accept CLI sends the reference and check option, prints results and refuses invalid references", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  let result: object = { id: "acceptance-run" };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push({ path: new URL(req.url).pathname, method: req.method, body: await req.json() });
      return Response.json(result);
    },
  });
  const cli = (...args: string[]) =>
    sh(["bun", "src/cli/main.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
      timeoutMs: 30_000,
      allowFail: true,
    });
  try {
    const create = await cli("accept", "example/repo#12");
    expect(create.exitCode).toBe(0);
    expect(create.stdout.trim()).toBe("acceptance-run");
    result = { ok: true, sha: "a".repeat(40), units: [{ id: "U1", text: "Check the feature" }] };
    const check = await cli("accept", "example/repo#12", "--check");
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout)).toEqual(result);
    expect(requests).toEqual([
      { path: "/api/acceptance", method: "POST", body: { repo: "example/repo", number: 12, check: false } },
      { path: "/api/acceptance", method: "POST", body: { repo: "example/repo", number: 12, check: true } },
    ]);
    for (const ref of [
      "example/repo",
      "example/repo#no",
      "example/repo#0",
      "repo#1",
      "example/repo#9007199254740992",
    ]) {
      const invalid = await cli("accept", ref);
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("usage: limitless accept");
    }
    expect(requests).toHaveLength(2);
    result = { ok: false, reason: "ticket: untrusted author" };
    const refusal = await cli("accept", "example/repo#12", "--check");
    expect(refusal.exitCode).not.toBe(0);
    expect(refusal.stderr).toContain("ticket: untrusted author");
    const help = await cli("--help");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("limitless accept <owner/name>#<n> [--check]");
  } finally {
    server.stop(true);
  }
});
