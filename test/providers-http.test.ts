import { expect, test } from "bun:test";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("provider mutations persist, publish, and use existing request guards", async () => {
  const f = await fixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const call = (
      action: "enable" | "disable",
      id = "fake",
      headers: Record<string, string> = { "content-type": "application/json" },
    ) => {
      const route = (routes[`/api/providers/:id/${action}`] as { POST: Route }).POST;
      return route(
        requestWithParams(
          `http://localhost:7400/api/providers/${id}/${action}`,
          { method: "POST", headers },
          { id },
        ),
        localServer,
      );
    };
    const id = f.factory.tracker.all()[0]?.id;
    if (!id) throw new Error("fixture has no provider");
    const messages: unknown[] = [];
    const unsubscribe = f.factory.store.subscribe((message) => messages.push(message));
    for (const action of ["disable", "disable", "enable", "enable"] as const) {
      expect((await call(action, id)).status).toBe(200);
      expect(f.factory.tracker.isEnabled(id)).toBe(action === "enable");
    }
    expect(messages.filter((message) => (message as { kind?: string }).kind === "provider")).toHaveLength(4);
    unsubscribe();
    const unknown = await call("disable", "unknown");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown provider unknown" });
    expect(f.factory.store.getProviderEnabledOverride("unknown")).toBeNull();
    for (const action of ["enable", "disable"] as const) {
      expect(
        (await call(action, id, { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" }))
          .status,
      ).toBe(403);
      expect(
        (await call(action, id, { "content-type": "application/json", origin: "https://evil.example" }))
          .status,
      ).toBe(403);
      expect((await call(action, id, { "content-type": "text/plain" })).status).toBe(415);
      expect((await call(action, id, {})).status).toBe(415);
    }
  } finally {
    await f.close();
  }
});
