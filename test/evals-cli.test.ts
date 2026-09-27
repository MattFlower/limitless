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

test("policy CLI previews exactly the written overlay, preserves other cells, and never writes on validation failure", async () => {
  const { evidence, input, local, subscription, response } = await import("./evals-policy-support.ts");
  const { generatePolicy } = await import("../src/evals/policy.ts");
  const { overlayPolicy } = await import("../src/router/policy.ts");
  const { DEFAULT_POLICY } = await import("../src/router/catalog.ts");
  const records = [
    evidence("triage", [local, subscription]),
    evidence("verify", [local], { status: "running", id: "running" }),
  ];
  const existing = {
    chat: { default: [subscription] },
    review: { large: [local] },
    verify: { default: [subscription] },
  };
  const files = new Map<string, string>([["routing/policy.json", JSON.stringify(existing)]]);
  const writes: string[] = [];
  const printed: string[] = [];
  const queried: string[] = [];
  const io = {
    async api<T>(path: string): Promise<T> {
      queried.push(path);
      const ids = new URL(path, "http://fixture").searchParams.get("evals");
      const data = response(records);
      data.policy = overlayPolicy(DEFAULT_POLICY, existing);
      data.evaluation = generatePolicy(
        input(records, { evalIds: ids === null ? undefined : ids.split(",") }),
      );
      return data as T;
    },
    print: (text: string) => printed.push(text),
    wait: async () => {},
    files: {
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, text: string) => {
        writes.push(path);
        files.set(path, text);
      },
    },
  };
  await evalCommand(["policy"], {}, io);
  expect(writes).toEqual([]);
  expect(printed[0]).toContain("@@ triage.default @@");
  expect(printed[0]).toContain(`+ ["${local}","${subscription}"]`);
  expect(printed[0]).toContain("verify unchanged: no completed evidence");
  const preview = printed[0];
  printed.length = 0;
  await evalCommand(["policy"], { write: true, evals: "triage-run,triage-run" }, io);
  expect(printed[0]).toBe(preview);
  expect(queried.at(-1)).toContain("evals=triage-run%2Ctriage-run");
  expect(writes).toEqual(["routing/policy.json", "routing/EVIDENCE.md"]);
  expect(JSON.parse(files.get("routing/policy.json") ?? "{}")).toEqual({
    ...existing,
    triage: { default: [local, subscription] },
  });
  expect(files.get("routing/EVIDENCE.md")).toContain("run=triage-run");
  writes.length = 0;
  for (const evals of ["", ",triage-run", "triage-run,", "missing", "running"]) {
    await expect(evalCommand(["policy"], { evals, write: true }, io)).rejects.toThrow();
    expect(writes).toEqual([]);
  }
  files.set("routing/policy.json", '{"invalid":{}}');
  await expect(evalCommand(["policy"], { write: true }, io)).rejects.toThrow("routing/policy.json");
  expect(writes).toEqual([]);
  files.delete("routing/policy.json");
  printed.length = 0;
  await evalCommand(["policy"], {}, io);
  expect(printed.join("\n")).toContain("is absent");
  expect(writes).toEqual([]);
  await evalCommand(["policy"], { write: true }, io);
  expect(writes).toEqual(["routing/policy.json", "routing/EVIDENCE.md"]);
});

test("policy CLI reports no-op proposals and unchanged all-ineligible evidence", async () => {
  const { response } = await import("./evals-policy-support.ts");
  const data = response([]);
  const printed: string[] = [];
  let writes = 0;
  await evalCommand(
    ["policy"],
    {},
    {
      api: async <T>() => data as T,
      print: (s) => printed.push(s),
      wait: async () => {},
      files: {
        read: async () => "{}",
        write: async () => {
          writes++;
        },
      },
    },
  );
  expect(writes).toBe(0);
  expect(printed.join("\n")).toContain("No effective policy changes.");
  expect(printed.join("\n")).toContain("Overlay unchanged");
  expect(printed.join("\n")).toContain("triage unchanged");
});

test("policy CLI preview names the specific rejection when a role has no eligible model", async () => {
  const { evidence, response, local } = await import("./evals-policy-support.ts");
  const record = evidence("triage", [local]);
  for (const t of record.trials.slice(0, 5)) if (t.details.grade) t.details.grade.riskUnderCall = true;
  const data = response([record]);
  const printed: string[] = [];
  const writes: string[] = [];
  await evalCommand(
    ["policy"],
    {},
    {
      api: async <T>() => data as T,
      print: (s) => printed.push(s),
      wait: async () => {},
      files: { read: async () => null, write: async (path) => void writes.push(path) },
    },
  );
  expect(writes).toEqual([]);
  const output = printed.join("\n");
  expect(output).toContain("No effective policy changes.");
  expect(output).toContain(
    `triage unchanged: no eligible models (${local}: risk under-call upper bound 0.2611 exceeds ceiling 0.1)`,
  );
});

test("policy CLI turns a small fake-harness eval into a written overlay through the real routes", async () => {
  const f = await evalFixture();
  try {
    // Six observations cannot establish the default 0.10 ceiling; size it to the fixture.
    f.factory.evalSettings.floors.triage_risk_under_call_rate = 0.5;
    const routes = createHttpRoutes(f.factory);
    const files = new Map<string, string>();
    const printed: string[] = [];
    const io = {
      async api<T>(path: string, init?: RequestInit): Promise<T> {
        const pathname = new URL(path, "http://localhost:7400").pathname;
        const id = pathname.split("/").at(-1) ?? "";
        const route =
          pathname === "/api/evals"
            ? (routes[pathname] as { POST: Route }).POST
            : pathname === "/api/evals/policy"
              ? (routes[pathname] as Route)
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
      wait: async () => {},
      files: {
        read: async (path: string) => files.get(path) ?? null,
        write: async (path: string, text: string) => void files.set(path, text),
      },
    };
    await f.run();
    await evalCommand(["policy"], {}, io);
    expect(files.size).toBe(0);
    expect(printed[0]).toContain("@@ triage.default @@");
    expect(printed[0]).toContain('+ ["candidate-a","candidate-b"]');
    expect(printed[0]).not.toContain("No effective policy changes");
    await evalCommand(["policy"], { write: true }, io);
    expect(JSON.parse(files.get("routing/policy.json") ?? "")).toEqual({
      triage: { default: ["candidate-a", "candidate-b"] },
    });
    const evidence = files.get("routing/EVIDENCE.md") ?? "";
    expect(evidence).toContain("Update triage.default: candidate-a → candidate-b");
    expect(evidence).toContain("risk under-call: 0.0000 (0/6)");
    await evalCommand(["policy"], { write: true }, io);
    expect(files.get("routing/EVIDENCE.md")).toBe(evidence);
  } finally {
    await f.close();
  }
});
