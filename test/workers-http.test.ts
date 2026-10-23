import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import type { WorkerRun } from "../src/db/workers.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

const home = mkdtempSync(join(tmpdir(), "workers-http-"));
const previousConfig = process.env.LIMITLESS_CONFIG_DIR;
const token = "a".repeat(64);
const store = new Store(":memory:");
const cfg = loadConfig({ home, configDir: home, raw: {} });
const factory = new Factory(cfg, { store });
const routes = createHttpRoutes(factory, { apiToken: token });
const call = (path: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => {
  const handler = routes[path.split("?")[0] ?? ""];
  return (typeof handler === "function" ? (handler as Route) : (handler as { GET: Route }).GET)(
    requestWithParams(`http://localhost${path}`, { headers }),
    localServer,
  );
};
const repo = store.upsertRepo({
  slug: "owner/repo",
  kind: "github",
  url: "https://example.com/repo",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "none",
});
const run = (title: string) => store.createRun(repo, { repo: repo.slug, prompt: title, title }).id;
let nextJob = 0;
function job(
  table: "agent_jobs" | "gate_jobs",
  runId: string | null,
  state: string,
  worker: string | null,
  at = 1,
  fallback = 0,
) {
  const id = `job-${++nextJob}`;
  store.db
    .query(
      `INSERT INTO ${table} (id,run_id,request,state,worker,attempt,created_at,updated_at) VALUES (?,?,'{}',?,?,2,0,?)`,
    )
    .run(id, runId, state, worker, at);
  if (table === "gate_jobs")
    store.db.query("UPDATE gate_jobs SET setup_fallback=? WHERE id=?").run(fallback, id);
  return id;
}
beforeAll(() => {
  process.env.LIMITLESS_CONFIG_DIR = home;
  writeFileSync(join(home, "private-strings.txt"), "");
});
afterAll(async () => {
  await factory.stop();
  store.close();
  if (previousConfig === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
  else process.env.LIMITLESS_CONFIG_DIR = previousConfig;
  rmSync(home, { recursive: true, force: true });
});

test("worker rows expose exactly each worker's leased agent jobs", async () => {
  factory.workers.pair("first", "fingerprint", "coordinator");
  factory.workers.pair("second", "fingerprint-2", "coordinator");
  factory.workers.pair("third", "fingerprint-3", "coordinator");
  const runId = run("active");
  const first = job("agent_jobs", runId, "leased", "first");
  const second = job("agent_jobs", runId, "leased", "second");
  for (const state of ["queued", "done", "failed", "cancelled"]) job("agent_jobs", runId, state, "first");
  const rows = await (await call("/api/workers")).json();
  expect(rows.map((w: { agentJobs: unknown }) => w.agentJobs)).toEqual([
    [{ id: first, attempt: 2, runId }],
    [{ id: second, attempt: 2, runId }],
    [],
  ]);
});

test("worker run history aggregates completions, excludes local recovery and sanitizes text", async () => {
  const agent = run("agent"),
    gate = run("gate"),
    mixed = run("mixed");
  job("agent_jobs", agent, "done", "first", 10);
  job("gate_jobs", gate, "done", "second", 20);
  job("agent_jobs", mixed, "done", "first", 30);
  job("agent_jobs", mixed, "done", "second", 40);
  job("gate_jobs", mixed, "done", "first", 50);
  job("gate_jobs", mixed, "done", "ignored", 100, 1);
  job("gate_jobs", run("local fallback"), "done", "first", 200, 1);
  const failed = run("not completed");
  for (const state of ["failed", "cancelled", "queued", "leased"])
    job("agent_jobs", failed, state, "first", 300);
  job("agent_jobs", agent, "done", null, 400);
  job("gate_jobs", null, "done", "first", 500);
  job("agent_jobs", "missing-run", "done", "first", 600);
  const rows: WorkerRun[] = await (await call("/api/workers/runs")).json();
  expect(rows.slice(0, 3)).toEqual([
    { runId: mixed, title: "mixed", agentJobs: 2, gateJobs: 1, workers: ["first", "second"], lastAt: 50 },
    { runId: gate, title: "gate", agentJobs: 0, gateJobs: 1, workers: ["second"], lastAt: 20 },
    { runId: agent, title: "agent", agentJobs: 1, gateJobs: 0, workers: ["first"], lastAt: 10 },
  ]);
  expect(rows.some((r) => r.runId === failed || r.title === "local fallback")).toBe(false);
  const secret = "history-credential-fixture";
  registerCredential("WORKER_HISTORY_TEST", secret);
  job("agent_jobs", run(secret), "done", secret, 700);
  expect(JSON.stringify(await (await call("/api/workers/runs")).json())).not.toContain(secret);
});

test("worker history defaults and validates limits after aggregation, orders ties by run ID", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 205; i++) {
    const id = run(`history ${i}`);
    ids.push(id);
    job("agent_jobs", id, "done", "first", 1000);
  }
  for (const [query, count] of [
    ["", 50],
    ["?limit=3", 3],
    ["?limit=999", 200],
    ["?limit=200", 200],
    ["?limit=0", 50],
    ["?limit=-1", 50],
    ["?limit=1.5", 50],
    ["?limit=no", 50],
    ["?limit=Infinity", 50],
  ] as const) {
    const rows: WorkerRun[] = await (await call(`/api/workers/runs${query}`)).json();
    expect(rows).toHaveLength(count);
    expect(rows.map((r) => r.runId)).toEqual(ids.toSorted().slice(0, count));
  }
});

test("both worker outputs require a token or session even on unprotected loopback", async () => {
  const cookie = new Auth(store, cfg).signIn("password", "test").split(";")[0] ?? "";
  for (const enforcement of [false, true]) {
    cfg.requireApiToken = enforcement;
    for (const path of ["/api/workers", "/api/workers/runs"]) {
      expect((await call(path, { authorization: "" })).status).toBe(401);
      expect((await call(path)).status).toBe(200);
      expect((await call(path, { cookie })).status).toBe(200);
    }
  }
});
