import { expect, test } from "bun:test";
import type { Run } from "../src/core/types.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("creation and retry validate before inserting; retries inherit, replace or clear the map", async () => {
  const f = await fixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const post = (retry: string | undefined, value?: unknown) => {
      const path = retry ? `/api/runs/${retry}/retry` : "/api/runs";
      const route = (routes[retry ? "/api/runs/:id/retry" : "/api/runs"] as { POST: Route }).POST;
      return route(
        requestWithParams(
          `http://localhost:7400${path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...(value === undefined ? {} : { body: JSON.stringify(value) }),
          },
          retry ? { id: retry } : {},
        ),
        localServer,
      );
    };
    const models = { implement: ["fake/m"], review: ["fake/m"] };
    const created = await post(undefined, { repo: f.repo, prompt: "Try model", models });
    expect(created.status).toBe(201);
    const run = (await created.json()) as Run;
    expect(run.models).toEqual(models);
    expect(((await (await post(run.id)).json()) as Run).models).toEqual(models);
    const replacement = { triage: ["fake/m"] };
    expect(((await (await post(run.id, { models: replacement })).json()) as Run).models).toEqual(replacement);
    expect(((await (await post(run.id, { models: {} })).json()) as Run).models).toEqual({});
    for (const models of [
      { implement: ["missing"] },
      { implement: ["claude/fable"] },
      { implement: ["fake/m@high"] },
      { implement: ["fake/m|"] },
      { implement: [] },
      { summarize: ["fake/m"] },
      null,
    ]) {
      const count = f.factory.store.listRuns().length;
      for (const retry of [undefined, run.id]) {
        const response = await post(retry, { repo: f.repo, prompt: "Invalid", models });
        expect(response.status).toBe(400);
        const error = ((await response.json()) as { error: string }).error;
        expect(error).toContain("models");
        if (models?.implement?.[0] === "claude/fable") expect(error).toContain("owner decision");
        expect(f.factory.store.listRuns()).toHaveLength(count);
      }
    }
  } finally {
    await f.close();
  }
});
