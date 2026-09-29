import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalCommand, formatEvalReport } from "../src/cli/eval.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { evalFixture } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

const evalRoles = test.each(["triage", "implement"] as const);
evalRoles("CLI %s submits options, follows HTTP results and emits JSON", async (role) => {
  const f = await evalFixture();
  try {
    if (role === "implement") {
      for (const item of f.dataset.cases) {
        mkdirSync(join(f.home, "hidden", item.id), { recursive: true });
        writeFileSync(join(f.home, "hidden", item.id, "check"), "test -f answer");
      }
      writeFileSync(
        f.casePath,
        JSON.stringify({
          role,
          version: 1,
          cases: f.dataset.cases.map((c) => ({
            id: c.id,
            repo: c.repo,
            prompt: c.prompt,
            base: f.sha,
            head: "f".repeat(40),
            complexity: "small",
            spec: null,
            source: "fixture",
            tags: [],
            hidden: { files: ["check"], command: "sh check" },
          })),
        }),
      );
      f.respond(() => ({ files: { answer: "correct" } }));
    }
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
          localServer,
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
      ["run", role],
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
      role,
      models: ["candidate-b", "candidate-a"],
      k: 2,
      caseIds: ["c", "a"],
      maxUsd: 0.5,
      cache: false,
    });
    const id = printed[0];
    if (!id) throw new Error("missing id");
    expect(printed[1]).toContain("completed");
    expect(printed[1]).toContain("concurrency=2");
    expect(f.factory.store.getEvalRun(id)?.concurrency).toBe(2);
    expect(printed[1]).toContain("Wilson 95% CI");
    expect(printed[1]).toContain("API-equivalent");
    expect(printed[1]).toContain("paired cases=2");
    printed.length = 0;
    await evalCommand(["report", id], { json: true }, io);
    expect(JSON.parse(printed[0] ?? "{}")).toEqual(f.factory.evals.report(id));
    expect(printed[0]).not.toContain("\x1b");
    await expect(evalCommand(["report", "missing"], {}, io)).rejects.toThrow("eval not found");
    await expect(evalCommand(["run", role], { models: "candidate-a", k: "bad" }, io)).rejects.toThrow(
      "finite number",
    );
    await expect(evalCommand(["run", role], {}, io)).rejects.toThrow("--models");
    printed.length = 0;
    await evalCommand(["run", role], { models: "candidate-a", "max-usd": "0", follow: true }, io);
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
    evidence("implement", [subscription], { id: "implement-run" }),
    evidence("verify", [local], { status: "running", id: "running" }),
  ];
  records[1]?.trials.forEach((t) => {
    t.details.complexity = "small";
  });
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
  expect(printed[0]).toContain("@@ implement.small @@");
  expect(printed[0]).toContain("verify unchanged: no completed evidence");
  const preview = printed[0];
  printed.length = 0;
  await evalCommand(["policy"], { write: true, evals: "triage-run,implement-run,triage-run" }, io);
  expect(printed[0]).toBe(preview);
  expect(queried.at(-1)).toContain("evals=triage-run%2Cimplement-run%2Ctriage-run");
  expect(writes).toEqual(["routing/policy.json", "routing/EVIDENCE.md"]);
  expect(JSON.parse(files.get("routing/policy.json") ?? "{}")).toEqual({
    ...existing,
    triage: { default: [local, subscription] },
    implement: { small: [subscription] },
  });
  expect(files.get("routing/EVIDENCE.md")).toContain("run=triage-run");
  expect(files.get("routing/EVIDENCE.md")).toContain("run=implement-run");
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
          localServer,
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

test("eval CLI preserves target syntax and rejects invalid inputs through shared submission", async () => {
  const { enableEfforts, invalidTargets } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    enableEfforts(f);
    const io = {
      api: async <T>(_path: string, init?: RequestInit) =>
        f.factory.evals.submit(JSON.parse(String(init?.body))) as T,
      print: () => {},
      wait: async () => {},
    };
    for (const models of invalidTargets)
      await expect(evalCommand(["run", "triage"], { models: models.join(",") }, io)).rejects.toThrow();
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
    await evalCommand(
      ["run", "triage"],
      { models: "candidate-a,candidate-a@none,candidate-a@high", "max-usd": "0" },
      io,
    );
    expect(f.factory.store.listEvalRuns()[0]?.models).toEqual([
      "candidate-a@low",
      "candidate-a@none",
      "candidate-a@high",
    ]);
  } finally {
    await f.close();
  }
});

test("CLI validates implement round options before submitting", async () => {
  const bodies: unknown[] = [];
  const io = {
    api: async <T>(_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { id: "eval" } as T;
    },
    print: () => {},
    wait: async () => {},
  };
  for (const rounds of ["0", "-1", "1.5", "Infinity", "NaN", "9007199254740992"])
    await expect(evalCommand(["run", "implement"], { models: "a", rounds }, io)).rejects.toThrow();
  await expect(evalCommand(["run", "implement"], { models: "a", strategy: "bad" }, io)).rejects.toThrow();
  for (const role of ["triage", "review", "verify"])
    for (const option of [{ rounds: "1" }, { strategy: "retry" }])
      await expect(evalCommand(["run", role], { models: "a", ...option }, io)).rejects.toThrow(
        "implement-only",
      );
  expect(bodies).toEqual([]);
  await evalCommand(["run", "implement"], { models: "a", rounds: "3", strategy: "effort", k: "2" }, io);
  expect(bodies[0]).toMatchObject({ rounds: 3, strategy: "effort", k: 2 });
});

test("CLI validates --concurrency, records it on the run and shows it in reports", async () => {
  const bodies: unknown[] = [];
  const mock = {
    api: async <T>(_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { id: "eval" } as T;
    },
    print: () => {},
    wait: async () => {},
  };
  for (const concurrency of ["0", "-1", "1.5", "Infinity", "NaN", "", "9007199254740992"])
    await expect(evalCommand(["run", "triage"], { models: "a", concurrency }, mock)).rejects.toThrow();
  expect(bodies).toEqual([]);
  const f = await evalFixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const printed: string[] = [];
    const io = {
      async api<T>(path: string, init?: RequestInit): Promise<T> {
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
          localServer,
        );
        return (await response.json()) as T;
      },
      print: (text: string) => printed.push(text),
      wait: async () => {
        for (const run of f.factory.store.listEvalRuns()) await f.factory.evals.wait(run.id);
      },
    };
    await evalCommand(
      ["run", "triage"],
      { models: "candidate-a", k: "1", concurrency: "3", follow: true },
      io,
    );
    const id = printed[0] ?? "";
    expect(printed[1]).toContain("concurrency=3");
    expect(f.factory.store.getEvalRun(id)?.concurrency).toBe(3);
    printed.length = 0;
    await evalCommand(["report", id], { json: true }, io);
    expect(JSON.parse(printed[0] ?? "{}").run.concurrency).toBe(3);
  } finally {
    await f.close();
  }
});

test("CLI entrypoint recognizes round flags", () => {
  const child = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "../src/cli/main.ts"),
    "eval",
    "run",
    "implement",
    "--models",
    "a",
    "--rounds",
    "3",
    "--strategy",
    "effort",
    "--concurrency",
    "3",
    "--help",
  ]);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain("--strategy retry|effort|switch");
  expect(child.stdout.toString()).toContain("[--concurrency N]");
});

async function pinFixture(extra: [string, string][] = []) {
  const { evidence, local, subscription, response } = await import("./evals-policy-support.ts");
  const { readFileSync } = await import("node:fs");
  const cells = ["trivial", "small", "medium"] as const;
  const implement = evidence("implement", [subscription], { id: "implement-run" });
  implement.trials.forEach((t, i) => {
    t.details.complexity = cells[i % 3];
  });
  const { overlayPolicy } = await import("../src/router/policy.ts");
  const { DEFAULT_POLICY } = await import("../src/router/catalog.ts");
  const root = join(import.meta.dir, "..");
  const policy = readFileSync(join(root, "routing/policy.json"), "utf8");
  const data = response([evidence("triage", [local]), implement]);
  data.policy = overlayPolicy(DEFAULT_POLICY, JSON.parse(policy));
  const files = new Map<string, string>([
    ["routing/policy.json", policy],
    ["routing/overrides.json", readFileSync(join(root, "routing/overrides.json"), "utf8")],
    ...extra,
  ]);
  const writes: string[] = [];
  const printed: string[] = [];
  const io = {
    api: async <T>() => structuredClone(data) as T,
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
  return { io, files, writes, printed, local, subscription };
}

test("policy CLI keeps committed owner pins for implement while unpinned cells update", async () => {
  const { io, files, writes, printed, local, subscription } = await pinFixture();
  const committed = JSON.parse(files.get("routing/policy.json") ?? "{}");
  const pin = JSON.parse(files.get("routing/overrides.json") ?? "{}")["implement.medium"];
  const message = `pinned by owner decision (${pin.decided}): ${pin.reason}`;
  await evalCommand(["policy"], {}, io);
  const preview = printed.join("\n");
  expect(writes).toEqual([]);
  expect(preview).toContain("@@ triage.default @@");
  expect(preview).not.toContain("@@ implement.");
  expect(preview).not.toContain(subscription);
  expect(preview).toContain(`implement.medium: ${message}`);
  expect(preview).toContain(`implement.large: ${message}`);
  printed.length = 0;
  await evalCommand(["policy"], { write: true }, io);
  expect(printed.slice(0, -1).join("\n")).toBe(preview);
  expect(writes).toEqual(["routing/policy.json", "routing/EVIDENCE.md"]);
  const written = JSON.parse(files.get("routing/policy.json") ?? "{}");
  expect(written).toEqual({ ...committed, triage: { ...committed.triage, default: [local] } });
  for (const cell of ["trivial", "small", "medium", "large"])
    expect(written.implement[cell]).toEqual(["claude/opus", "codex/sol@medium"]);
  const report = files.get("routing/EVIDENCE.md") ?? "";
  const medium = report.slice(report.indexOf("## implement.medium"));
  expect(medium).toStartWith(`## implement.medium\n\n${message}\n\n`);
  expect(medium).toContain("| Model / source");
  expect(medium).toContain(`| ${subscription}; run=implement-run;`);
  expect(medium).toContain("pass rate: 1.0000");
  expect(report).not.toContain("Update implement.");
  expect(report).toContain("Update triage.default:");
  expect(report).toContain(`## implement.large\n\n${message}\n`);
  expect(report.slice(report.indexOf("## implement.large"))).not.toContain("| Model / source");
});

test("policy CLI without overrides regenerates every evidenced cell", async () => {
  const { io, files, subscription } = await pinFixture();
  files.delete("routing/overrides.json");
  await evalCommand(["policy"], { write: true }, io);
  const written = JSON.parse(files.get("routing/policy.json") ?? "{}");
  expect(written.implement.medium[0]).toBe(subscription);
  expect(written.implement.large).toEqual(["claude/opus", "codex/sol@medium"]);
  expect(files.get("routing/EVIDENCE.md")).toContain("Update implement.medium:");
  expect(files.get("routing/EVIDENCE.md")).not.toContain("pinned by owner decision");
});

test("policy CLI pins a cell with no completed evidence without inventing candidates", async () => {
  const { io, files, printed } = await pinFixture([
    [
      "routing/overrides.json",
      JSON.stringify({ "review.default": { reason: "keep", decided: "2026-01-02" } }),
    ],
  ]);
  files.set(
    "routing/policy.json",
    JSON.stringify({
      ...JSON.parse(files.get("routing/policy.json") ?? "{}"),
      review: { default: ["claude/opus"] },
    }),
  );
  await evalCommand(["policy"], { write: true }, io);
  expect(printed.join("\n")).toContain("review.default: pinned by owner decision (2026-01-02): keep");
  expect(printed.join("\n")).not.toContain("review unchanged");
  expect(JSON.parse(files.get("routing/policy.json") ?? "{}").review).toEqual({ default: ["claude/opus"] });
  const report = files.get("routing/EVIDENCE.md") ?? "";
  expect(report).toContain("## review\n\npinned by owner decision (2026-01-02): keep\n\n## ");
});

const valid = { reason: "owner call", decided: "2026-09-28" };
test.each([
  ["malformed JSON", "{"],
  ["non-object", "[]"],
  ["unknown role", JSON.stringify({ "deploy.default": valid })],
  ["unknown cell", JSON.stringify({ "implement.huge": valid })],
  ["missing cell", JSON.stringify({ implement: valid })],
  ["extra segment", JSON.stringify({ "implement.medium.x": valid })],
  ["prototype key", JSON.stringify({ "__proto__.default": valid })],
  ["empty reason", JSON.stringify({ "implement.medium": { ...valid, reason: "  " } })],
  ["missing decided", JSON.stringify({ "implement.medium": { reason: "x" } })],
  ["bad date format", JSON.stringify({ "implement.medium": { ...valid, decided: "2026-9-28" } })],
  ["impossible date", JSON.stringify({ "implement.medium": { ...valid, decided: "2026-02-30" } })],
  ["extra field", JSON.stringify({ "implement.medium": { ...valid, by: "me" } })],
  ["no explicit chain", JSON.stringify({ "review.default": valid })],
])("policy CLI rejects overrides with %s before writing", async (_name, text) => {
  const { io, writes } = await pinFixture([["routing/overrides.json", text]]);
  await expect(evalCommand(["policy"], { write: true }, io)).rejects.toThrow("routing/overrides.json");
  await expect(evalCommand(["policy"], {}, io)).rejects.toThrow("routing/overrides.json");
  expect(writes).toEqual([]);
});

test("eval regrade CLI posts to the regrade route, lists kept grades and prints the regraded report", async () => {
  const calls: [string, string | undefined][] = [];
  const printed: string[] = [];
  const run = {
    id: "eval-x",
    role: "review" as const,
    models: ["candidate-a"],
    k: 1,
    maxUsd: 1,
    status: "completed" as const,
    createdAt: 0,
    finishedAt: 1,
    error: null,
  };
  const io = {
    async api<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push([path, init?.method]);
      return (
        path.endsWith("/regrade")
          ? { regraded: 3, changed: 2, skipped: [{ caseId: "gone", modelId: "m", trial: 0, reason: "why" }] }
          : { run, summaries: [], trials: [] }
      ) as T;
    },
    print: (text: string) => printed.push(text),
    wait: async () => {},
  };
  await evalCommand(["regrade", "eval-x"], {}, io);
  expect(calls).toEqual([
    ["/api/evals/eval-x/regrade", "POST"],
    ["/api/evals/eval-x", undefined],
  ]);
  expect(printed[0]).toBe("Regraded 3 stored review trials from their outputs (2 changed); no model calls.");
  expect(printed[1]).toBe("  kept stored grade: gone m #0: why");
  expect(printed[2]).toContain("eval-x: completed (role=review");
  await expect(evalCommand(["regrade"], {}, io)).rejects.toThrow("eval regrade <eval-id>");
  // Through the real route, only review evals regrade.
  const f = await evalFixture();
  try {
    const { id } = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], maxUsd: 0 });
    await f.factory.evals.wait(id);
    const routes = createHttpRoutes(f.factory);
    const response = await (routes["/api/evals/:id/regrade"] as { POST: Route }).POST(
      requestWithParams(
        `http://localhost:7400/api/evals/${id}/regrade`,
        { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
        { id },
      ),
      localServer,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `only review evals can be regraded; ${id} is triage` });
  } finally {
    await f.close();
  }
});
