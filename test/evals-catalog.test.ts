import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Factory } from "../src/app.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { answer, evalFixture } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

const candidates = [
  ["gpt-6-luna", "openai/gpt-6-luna", 0.1, 0.5, "US"],
  ["gemini-3.1-flash-lite", "google/gemini-3.1-flash-lite", 0.25, 1.5, "US"],
  ["claude-haiku-4.5", "anthropic/claude-haiku-4.5", 1, 5, "US"],
  ["muse-glimmer-30b", "meta/muse-glimmer-30b", 0.3, 1.2, "US"],
  ["gemma-4-26b-a4b-it", "google/gemma-4-26b-a4b-it", 0.068, 0.225, "US"],
  ["gemma-4-31b-it", "google/gemma-4-31b-it", 0.09, 0.34, "US"],
  ["gpt-oss-20b", "openai/gpt-oss-20b", 0.018, 0.09, "US"],
  ["gpt-oss-120b", "openai/gpt-oss-120b", 0.15, 0.6, "US"],
  ["ministral-14b-2512", "mistralai/ministral-14b-2512", 0.2, 0.2, "FR"],
] as const;
test("catalog records checkpoint origins, exact candidate backend prices and leaves policy independent", () => {
  expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  for (const m of MODELS) {
    expect(m.origin).toMatch(/^[A-Z]{2}$|^unknown$/);
    expect(m.baseOrigin).toMatch(/^[A-Z]{2}$|^unknown$/);
    const origin = ["anthropic", "openai", "google", "meta", "ibm", "nvidia", "typesafe"].includes(m.vendor)
      ? "US"
      : m.vendor === "mistral"
        ? "FR"
        : "CN";
    expect(m.origin).toBe(origin);
    // TypeSafe does not disclose what, if anything, Jev was built on.
    expect(m.baseOrigin).toBe(m.vendor === "typesafe" ? "unknown" : origin);
  }
  for (const [id, model, input, output, origin] of candidates) {
    expect(MODELS.find((m) => m.id === `openrouter/${id}`)).toMatchObject({
      provider: "openrouter",
      model,
      origin,
      baseOrigin: origin,
      price: { input, output },
    });
    expect(JSON.stringify(DEFAULT_POLICY)).not.toContain(`openrouter/${id}`);
  }
});
test("catalog candidates absent from policy execute exactly and API exposes origins", async () => {
  const f = await evalFixture();
  const calls: string[] = [];
  const factory = new Factory(
    { ...f.cfg, paths: { ...f.cfg.paths, db: `${f.home}/catalog.db` } },
    {
      evalCasePath: f.casePath,
      models: MODELS,
      providers: [
        {
          id: "openrouter",
          label: "fake OpenRouter",
          harness: "fake",
          billing: "metered",
          maxConcurrent: 1,
          openaiBaseUrl: "http://unused.invalid",
        },
      ],
      harnesses: {
        llm: fakeHarness((s) => {
          calls.push(s.target.modelId);
          return { structured: answer };
        }),
      },
    },
  );
  try {
    const run = factory.evals.submit({ role: "triage", models: ["openrouter/gpt-6-luna"], caseIds: ["a"] });
    await factory.evals.wait(run.id);
    expect(calls).toEqual(["openrouter/gpt-6-luna"]);
    expect(factory.evals.report(run.id)?.trials[0]?.pass).toBe(true);
    const route = createHttpRoutes(factory)["/api/models"] as Route;
    const result = (await (
      await route(requestWithParams("http://localhost:7400/api/models"), localServer)
    ).json()) as { models: typeof MODELS };
    expect(result.models.find((m) => m.id === "openrouter/ministral-14b-2512")?.origin).toBe("FR");
    const ui = readFileSync(new URL("../ui/pages/Models.tsx", import.meta.url), "utf8");
    expect(ui).toContain("{m.origin}");
    expect(ui).toContain("{m.baseOrigin}");
    expect(ui).toContain("colspan={13}");
  } finally {
    await factory.stop();
    factory.store.close();
    await f.close();
  }
});
