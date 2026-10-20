import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("land logs are redacted and confined to canonical runs and land paths", async () => {
  const f = await fixture();
  try {
    const store = f.factory.store;
    const secret = `log-secret-${crypto.randomUUID()}`;
    registerCredential("LAND_LOG_HTTP", secret);
    const paths = f.factory.cfg.paths;
    mkdirSync(join(paths.home, "land"), { recursive: true });
    const outside = join(f.home, "outside.log");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(paths.runs, "escape.log"));
    const route = createHttpRoutes(f.factory)["/api/land/:id/log"] as Route;
    const get = (id: number) =>
      route(
        requestWithParams(`http://localhost/api/land/${id}/log`, undefined, { id: String(id) }),
        localServer,
      );
    let pr = 0;
    const entry = (logPath: string | null) => {
      const row = store.createLandEntry({
        runId: null,
        repo: "test/repo",
        baseBranch: "main",
        headBranch: "feature",
        approvedSha: "a".repeat(40),
        prUrl: `https://github.com/test/repo/pull/${++pr}`,
      });
      store.updateLandEntry(row.id, { logPath });
      return row.id;
    };
    for (const root of [paths.runs, join(paths.home, "land")]) {
      const log = join(root, "checks.log");
      writeFileSync(log, `checks: ${secret}`);
      const response = await get(entry(log));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("text/plain");
      const body = await response.text();
      expect(body).toContain("checks:");
      expect(body).not.toContain(secret);
      expect(body).toContain("[redacted]");
    }
    const sibling = `${paths.runs}-outside`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "log"), "outside prefix");
    for (const path of [
      null,
      outside,
      join(paths.runs, "escape.log"),
      join(paths.runs, "missing.log"),
      join(sibling, "log"),
    ]) {
      expect((await get(entry(path))).status).toBe(404);
    }
    expect((await get(9999)).status).toBe(404);
  } finally {
    await f.close();
  }
});
