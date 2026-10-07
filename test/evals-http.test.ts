import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { evalCommand, formatEvalReport } from "../src/cli/eval.ts";
import { loadRoleCases, VerifyCaseFileSchema } from "../src/evals/cases.ts";
import type { EvalReport } from "../src/evals/stats.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";
import { answer, deferred, evalFixture } from "./evals-support.ts";
import { type Route, requestWithParams, localServer as server } from "./mcp-support.ts";
import { customProvider, providerFixture } from "./provider-config-support.ts";

test("thrown eval credentials are redacted in stored trials, API responses and JSON reports", async () => {
  const key = "FAKE_EVAL_CREDENTIAL_318";
  const config = providerFixture(
    [{ ...customProvider, api_key_env: "LIMITLESS_TEST_EVAL_KEY" }],
    `LIMITLESS_TEST_EVAL_KEY=${key}\n`,
  );
  const f = await evalFixture();
  try {
    config.load();
    f.respond(() => ({ fault: "throw", error: `provider rejected token=${key}; token=${key};` }));
    const report = await f.run({ models: ["candidate-a"], caseIds: ["a"], k: 1 });
    const expected = "provider rejected token=[redacted]; token=[redacted];";
    const stored = f.factory.store.listEvalTrials(report.run.id);
    const route = createHttpRoutes(f.factory)["/api/evals/:id"] as Route;
    const response = await route(
      requestWithParams(`http://localhost/api/evals/${report.run.id}`, {}, { id: report.run.id }),
      server,
    );
    expect(response.status).toBe(200);
    const json = await response.text();
    const printed: string[] = [];
    await evalCommand(
      ["report", report.run.id],
      { json: true },
      {
        api: async <T>() => JSON.parse(json) as T,
        print: (text) => printed.push(text),
        wait: async () => {},
      },
    );
    expect(stored[0]).toMatchObject({ status: "error", details: { reason: expected } });
    for (const output of [JSON.stringify(stored), json, ...printed]) {
      expect(output).toContain(expected);
      expect(output).not.toContain(key);
    }
    expect(printed).toHaveLength(1);
  } finally {
    await f.close();
    config.close();
  }
});

test("API persists immediately, runs in background, lists and reports trials and partial metrics", async () => {
  const f = await evalFixture();
  const release = deferred<void>();
  try {
    const entered = deferred<void>();
    f.respond(async () => {
      entered.resolve();
      await release.promise;
      return { structured: answer };
    });
    const routes = createHttpRoutes(f.factory);
    const collection = routes["/api/evals"] as { POST: Route; GET: Route };
    const get = routes["/api/evals/:id"] as Route;
    const res = await collection.POST(
      requestWithParams("http://localhost:7400/api/evals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "triage",
          models: ["candidate-a"],
          caseIds: ["a"],
          k: 2,
          maxUsd: 2,
          cache: false,
        }),
      }),
      server,
    );
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await entered.promise;
    const request = requestWithParams(`http://localhost:7400/api/evals/${id}`, {}, { id });
    const pending = (await (await get(request, server)).json()) as EvalReport;
    expect(pending.run).toMatchObject({ status: "running", k: 2, maxUsd: 2 });
    expect(pending.summaries[0]).toMatchObject({ pending: 2, passRate: null, evaluatedTrials: 0 });
    expect(
      await (await collection.GET(requestWithParams("http://localhost:7400/api/evals"), server)).json(),
    ).toHaveLength(1);
    release.resolve();
    await f.factory.evals.wait(id);
    const done = (await (await get(request, server)).json()) as EvalReport;
    expect(done.run.status).toBe("completed");
    expect(done.summaries[0]).toMatchObject({
      cases: 1,
      evaluatedTrials: 2,
      passRate: 1,
      comparison: { bestModel: "candidate-a", pairedCases: 1, resamples: 10000 },
    });
    expect(done.trials).toHaveLength(2);
    expect(
      (await get(requestWithParams("http://localhost:7400/api/evals/missing", {}, { id: "missing" }), server))
        .status,
    ).toBe(404);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("eval API shares JSON, Origin and Cloudflare guards and validates before persistence", async () => {
  const f = await evalFixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const post = (routes["/api/evals"] as { POST: Route }).POST;
    const request = (input: unknown, headers: Record<string, string> = {}) =>
      requestWithParams("http://localhost:7400/api/evals", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof input === "string" ? input : JSON.stringify(input),
      });
    const valid = { role: "triage", models: ["candidate-a"] };
    for (const invalid of [
      null,
      "{",
      {},
      { ...valid, role: "review" },
      { ...valid, models: ["unknown"] },
      { ...valid, maxUsd: -1 },
      { ...valid, caseIds: ["missing"] },
    ])
      expect((await post(request(invalid), server)).status).toBe(400);
    expect((await post(request(valid, { origin: "https://external.invalid" }), server)).status).toBe(403);
    expect((await post(request(valid, { "content-type": "" }), server)).status).toBe(415);
    expect((await post(request(valid, { "cf-connecting-ip": "1.2.3.4" }), server)).status).toBe(403);
    const get = routes["/api/evals/:id"] as Route;
    expect(
      (
        await get(
          requestWithParams(
            "http://localhost:7400/api/evals/missing",
            { headers: { "cf-connecting-ip": "1.2.3.4" } },
            { id: "missing" },
          ),
          server,
        )
      ).status,
    ).toBe(403);
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("review and verify API reports preserve role grades and text/JSON metrics", async () => {
  const f = await evalFixture();
  try {
    for (const role of ["review", "verify"] as const) {
      const item =
        role === "review"
          ? { ...reviewCase, base: f.sha, head: f.sha }
          : {
              ...VerifyCaseFileSchema.parse(
                loadRoleCases("verify", new URL("./data/evals-verify.json", import.meta.url).pathname),
              ).cases[0],
              base: f.sha,
              head: f.sha,
            };
      writeFileSync(f.casePath, JSON.stringify({ role, version: 1, cases: [item] }));
      f.respond(() => ({
        structured:
          role === "review"
            ? reviewOutput()
            : {
                overall: "fail",
                notes: "",
                criteria: [{ id: "AC-1", status: "met", evidence: "checked", publicSummary: "" }],
              },
      }));
      const report = await f.run({ role, models: ["candidate-a"], k: 2 });
      const route = createHttpRoutes(f.factory)["/api/evals/:id"] as Route;
      const response = await route(
        requestWithParams(`http://localhost:7400/api/evals/${report.run.id}`, {}, { id: report.run.id }),
        server,
      );
      const json = (await response.json()) as EvalReport;
      expect(json).toEqual(report);
      expect(json.trials.every((t) => t.details.grade?.[role])).toBe(true);
      const text = formatEvalReport(json);
      expect(text).toContain("prediction coverage 2/2");
      expect(text).not.toContain("risk under-call");
      if (role === "review") {
        expect(text).toContain("blocking recall 100.0% (2/2)");
        expect(text).toContain("clean false-block n/a (0/0)");
      } else {
        expect(text).toContain("false-accept n/a (0/0)");
        expect(text).toContain("false-reject 0.0% (0/2)");
        expect(text.indexOf("false-accept")).toBeLessThan(text.indexOf("false-reject"));
      }
    }
  } finally {
    await f.close();
  }
});

test("POST evals validates targets before scheduling and returns persisted efforts", async () => {
  const { enableEfforts, invalidTargets } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    enableEfforts(f);
    const routes = createHttpRoutes(f.factory);
    const post = (routes["/api/evals"] as { POST: Route }).POST;
    const submit = (models: string[]) =>
      post(
        requestWithParams("http://localhost/api/evals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "triage", models, maxUsd: 0 }),
        }),
        server,
      );
    for (const models of invalidTargets) expect((await submit(models)).status).toBe(400);
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
    const result = await submit(["candidate-a", "candidate-a@none", "candidate-a@high"]);
    expect(result.ok).toBe(true);
    const run = f.factory.store.listEvalRuns()[0];
    if (!run) throw new Error("missing");
    expect(run.models).toEqual(["candidate-a@low", "candidate-a@none", "candidate-a@high"]);
    await f.factory.evals.wait(run.id);
    expect(new Set(f.factory.evals.report(run.id)?.trials.map((t) => t.effort))).toEqual(
      new Set(["low", "none", "high"]),
    );
  } finally {
    await f.close();
  }
});

test("resume and cancel routes return the new run ID or final status and refuse ineligible evals", async () => {
  const f = await evalFixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const post = (action: "resume" | "cancel", id: string) =>
      (routes[`/api/evals/:id/${action}`] as { POST: Route }).POST(
        requestWithParams(
          `http://localhost:7400/api/evals/${id}/${action}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          { id },
        ),
        server,
      );
    expect((await post("resume", "missing")).status).toBe(404);
    expect((await post("cancel", "missing")).status).toBe(404);
    const entered = deferred<void>();
    f.respond(async (s) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], caseIds: ["a"] });
    await entered.promise;
    expect((await post("resume", run.id)).status).toBe(400);
    const cancelled = await post("cancel", run.id);
    expect(await cancelled.json()).toEqual({ id: run.id, status: "interrupted" });
    expect((await post("cancel", run.id)).status).toBe(400);
    f.respond(() => ({ structured: answer }));
    const resumed = await post("resume", run.id);
    expect(resumed.status).toBe(202);
    const body = (await resumed.json()) as { id: string; resumedFrom: string };
    expect(body.resumedFrom).toBe(run.id);
    await f.factory.evals.wait(body.id);
    expect(f.factory.evals.report(run.id)?.run.resumedBy).toBe(body.id);
    expect((await post("resume", body.id)).status).toBe(400);
    expect(f.factory.store.listEvalRuns()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("excluded eval models and system targets are refused before eval persistence", async () => {
  const f = await evalFixture(
    [
      {
        id: "allowed",
        provider: "provider-b",
        model: "allowed",
        tier: 1,
        vendor: "other",
        origin: "US",
        baseOrigin: "US",
        supportedEfforts: [],
        price: { input: 1, output: 1 },
      },
    ],
    [],
    undefined,
    ["CN"],
  );
  try {
    const post = (createHttpRoutes(f.factory)["/api/evals"] as { POST: Route }).POST;
    const response = await post(
      requestWithParams("http://localhost/api/evals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "triage", models: ["allowed", "candidate-a"] }),
      }),
      server,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("origin excluded (unknown; baseOrigin=unknown)");
    expect(f.factory.store.listEvalRuns()).toEqual([]);
    expect(f.calls).toEqual([]);
    // Review systems resolve every finder and every listed verifier before persistence.
    writeFileSync(
      f.casePath,
      JSON.stringify({
        role: "review",
        version: 1,
        cases: [{ ...reviewCase, base: f.sha, head: f.sha }],
      }),
    );
    for (const system of [
      {
        name: "finder",
        mode: "single",
        finders: [{ target: "candidate-a", prompt: "standard" }],
        implementerReport: "include",
      },
      {
        name: "verifier",
        mode: "panel",
        finders: [{ target: "allowed", prompt: "standard" }],
        implementerReport: "include",
        verifier: { targets: ["candidate-b"] },
      },
    ]) {
      const rejected = await post(
        requestWithParams("http://localhost/api/evals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "review", systems: [system] }),
        }),
        server,
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("origin excluded (unknown; baseOrigin=unknown)");
      expect(f.factory.store.listEvalRuns()).toEqual([]);
      expect(f.calls).toEqual([]);
    }
    f.save();
    const accepted = await f.run({ models: ["allowed"], caseIds: ["a"], k: 1 });
    expect(accepted.run.status).toBe("completed");
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
