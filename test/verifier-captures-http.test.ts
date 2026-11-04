import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { Server } from "bun";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { test } from "./read-policy-support.ts";

const images = JSON.parse(
  readFileSync(new URL("./fixtures/media/files.json", import.meta.url), "utf8"),
) as Record<string, string>;
const png = Buffer.from(images["0.png"] ?? "", "base64");

test("screenshots serve exact validated bytes only to authenticated loopback; text stays compatible", async () => {
  const f = await fixture();
  try {
    const { store, cfg } = f.factory;
    cfg.requireApiToken = true;
    cfg.trustedProxies = ["192.0.2.20"];
    cfg.publicOrigins = ["https://limitless.example.test"];
    const run = await f.factory.createRun({ repo: f.repo, prompt: "UI evidence" });
    const name = "screenshot-1-0.png";
    store.putArtifact(run.id, name, "screenshot", png.toString("base64"));
    store.putArtifact(run.id, "report.md", "report", "# Redacted report\n");
    store.putArtifact(run.id, "verify-0.json", "verify", '{"overall":"pass"}');
    store.putArtifact(run.id, "broken.png", "screenshot", png.subarray(0, 8).toString("base64"));
    const routes = createHttpRoutes(f.factory, { apiToken: "testtoken" });
    const get = (
      kind: "screenshots" | "artifacts",
      artifact = name,
      headers: Record<string, string> = { authorization: "Bearer testtoken" },
      server = localServer,
    ) => {
      const route = routes[`/api/runs/:id/${kind}/:name`] as Route;
      return route(
        requestWithParams(
          `http://127.0.0.1/api/runs/${run.id}/${kind}/${artifact}`,
          { headers },
          { id: run.id, name: artifact },
        ),
        server,
      );
    };
    const image = await get("screenshots");
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(image.headers.get("Cache-Control")).toBe("no-store");
    expect((await get("screenshots", name, {})).status).toBe(401);
    expect((await get("screenshots", name, { authorization: "Bearer wrong" })).status).toBe(401);
    const proxy = { requestIP: () => ({ address: "192.0.2.20" }) } as unknown as Server<undefined>;
    expect(
      (
        await get(
          "screenshots",
          name,
          { authorization: "Bearer testtoken", host: "limitless.example.test" },
          proxy,
        )
      ).status,
    ).toBe(403);
    for (const headers of [{ "x-forwarded-for": "192.0.2.1" }, { "cf-connecting-ip": "192.0.2.1" }] as Record<
      string,
      string
    >[])
      expect((await get("screenshots", name, { ...headers, authorization: "Bearer testtoken" })).status).toBe(
        403,
      );
    for (const artifact of ["report.md", "verify-0.json", "broken.png", "missing.png"])
      expect((await get("screenshots", artifact)).status).toBe(404);
    const blocked = await get("artifacts");
    expect(blocked.status).toBe(404);
    expect(await blocked.text()).not.toContain("iVBORw0KGgo");
    for (const artifact of ["report.md", "verify-0.json"]) {
      const response = await get("artifacts", artifact);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe(store.getArtifact(run.id, artifact) ?? "");
    }
  } finally {
    await f.close();
  }
});
