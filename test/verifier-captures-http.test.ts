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
    const historical = await f.factory.createRun({ repo: f.repo, prompt: "Historical text" });
    store.putArtifact(historical.id, "notes.txt", "notes", "unchanged text");
    store.putScreenshot(run.id, name, png.toString("base64"));
    store.putArtifact(run.id, "report.md", "report", "# Redacted report\n");
    store.putArtifact(run.id, "verify-0.json", "verify", '{"overall":"pass"}');
    store.putScreenshot(run.id, "broken.png", png.subarray(0, 8).toString("base64"));
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
    const listRoute = routes["/api/runs/:id/screenshots"] as Route;
    const listing = await listRoute(
      requestWithParams(
        `http://127.0.0.1/api/runs/${run.id}/screenshots`,
        { headers: { authorization: "Bearer testtoken" } },
        { id: run.id },
      ),
      localServer,
    );
    expect(await listing.json()).toEqual([{ name: "broken.png" }, { name }]);
    expect(
      (
        await listRoute(
          requestWithParams(`http://127.0.0.1/api/runs/${run.id}/screenshots`, {}, { id: run.id }),
          localServer,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await listRoute(
          requestWithParams(
            `http://127.0.0.1/api/runs/${run.id}/screenshots`,
            { headers: { authorization: "Bearer testtoken", "x-forwarded-for": "192.0.2.1" } },
            { id: run.id },
          ),
          localServer,
        )
      ).status,
    ).toBe(403);
    const detailRoute = routes["/api/runs/:id"] as Route;
    for (const id of [run.id, historical.id]) {
      const response = await detailRoute(
        requestWithParams(
          `http://127.0.0.1/api/runs/${id}`,
          { headers: { authorization: "Bearer testtoken" } },
          { id },
        ),
        localServer,
      );
      expect(response.status).toBe(200);
      const detail = await response.text();
      expect(detail).not.toContain(name);
      expect(detail).not.toContain("iVBORw0KGgo");
    }
    const oldText = await (routes["/api/runs/:id/artifacts/:name"] as Route)(
      requestWithParams(
        `http://127.0.0.1/api/runs/${historical.id}/artifacts/notes.txt`,
        { headers: { authorization: "Bearer testtoken" } },
        { id: historical.id, name: "notes.txt" },
      ),
      localServer,
    );
    expect(await oldText.text()).toBe("unchanged text");
    const noScreenshot = await (routes["/api/runs/:id/screenshots/:name"] as Route)(
      requestWithParams(
        `http://127.0.0.1/api/runs/${historical.id}/screenshots/${name}`,
        { headers: { authorization: "Bearer testtoken" } },
        { id: historical.id, name },
      ),
      localServer,
    );
    expect(noScreenshot.status).toBe(404);
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
