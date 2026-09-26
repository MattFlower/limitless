import { expect, test } from "bun:test";
import type { Server } from "bun";
import { evalCommand, formatEvalReport } from "../src/cli/eval.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { evalFixture } from "./evals-support.ts";
import { type Route, requestWithParams } from "./mcp-support.ts";

test("CLI submits all options through HTTP, follows terminal results, and emits clean JSON", async () => {
  const f = await evalFixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const printed: string[] = [];
    const bodies: unknown[] = [];
    const io = {
      async api<T>(path: string, init?: RequestInit): Promise<T> {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        const id = path.split("/").at(-1) ?? "";
        const route =
          path === "/api/evals"
            ? (routes[path] as { POST: Route }).POST
            : (routes["/api/evals/:id"] as Route);
        const response = await route(
          requestWithParams(
            `http://localhost:7400${path}`,
            { ...init, headers: { "content-type": "application/json" } },
            { id },
          ),
          {} as Server<undefined>,
        );
        const result = await response.json();
        if (!response.ok) throw new Error((result as { error: string }).error);
        return result as T;
      },
      print: (text: string) => printed.push(text),
      wait: async () => {
        for (const run of f.factory.store.listEvalRuns()) await f.factory.evals.wait(run.id);
      },
    };
    await evalCommand(
      ["run", "triage"],
      {
        models: "candidate-b,candidate-a",
        k: "2",
        cases: "c,a",
        "max-usd": "0.5",
        "no-cache": true,
        follow: true,
      },
      io,
    );
    expect(bodies[0]).toEqual({
      role: "triage",
      models: ["candidate-b", "candidate-a"],
      k: 2,
      caseIds: ["c", "a"],
      maxUsd: 0.5,
      cache: false,
    });
    const id = printed[0];
    if (!id) throw new Error("missing id");
    expect(printed[1]).toContain("completed");
    expect(printed[1]).toContain("Wilson 95% CI");
    expect(printed[1]).toContain("API-equivalent");
    expect(printed[1]).toContain("paired cases=2");
    printed.length = 0;
    await evalCommand(["report", id], { json: true }, io);
    expect(JSON.parse(printed[0] ?? "{}")).toEqual(f.factory.evals.report(id));
    expect(printed[0]).not.toContain("\x1b");
    await expect(evalCommand(["report", "missing"], {}, io)).rejects.toThrow("eval not found");
    await expect(evalCommand(["run", "triage"], { models: "candidate-a", k: "bad" }, io)).rejects.toThrow(
      "finite number",
    );
    await expect(evalCommand(["run", "triage"], {}, io)).rejects.toThrow("--models");
    printed.length = 0;
    await evalCommand(["run", "triage"], { models: "candidate-a", "max-usd": "0", follow: true }, io);
    expect(printed[1]).toContain("budget_exhausted");
    expect(printed[1]).toContain("pass n/a");
    const report = f.factory.evals.report(id);
    if (!report) throw new Error("missing report");
    f.factory.store.updateEvalRun(id, "failed", "interrupted");
    const failed = f.factory.evals.report(id);
    if (!failed) throw new Error("missing report");
    expect(formatEvalReport(failed)).toContain("interrupted");
  } finally {
    await f.close();
  }
});
