import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { computeStats } from "../src/db/stats.ts";
import type { DecisionAnswer } from "../src/harness/decisions.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { Harness } from "../src/harness/types.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let home: string;
let repoDir: string;
let factory: Factory | null = null;
let jev: Record<string, DecisionAnswer>;
let llmTriage: FakeReply;
let tasks: number;

const answers = (confidence: number, questions: number, ambiguity = 0): Record<string, DecisionAnswer> => ({
  task_class: { type: "choice", choice: "feature", confidence: 0.99 },
  complexity: { type: "score", score: 1, level: 1, confidence },
  risk: { type: "score", score: 0, level: 0, confidence: 0.95 },
  ambiguity: { type: "score", score: ambiguity, level: ambiguity, confidence: 0.95 },
  needs_questions: { type: "noul", noul: questions },
});
const llmAnswer = {
  title: "Make it better",
  task_class: "feature",
  complexity: "medium",
  risk: "low",
  ambiguity: "high",
  blocking_questions: ["Which outcome do you want?"],
  summary: "Unclear request",
  suggested_profile: "standard",
};

// Mirrors the real harness: interpret and decline come from the task the engine passes.
const decisions: Harness = async (spec) => {
  const task = spec.decisionTask;
  if (!task) throw new Error("the engine passed no decision task");
  tasks++;
  const decline = task.decline?.(jev) ?? null;
  return {
    status: decline ? "declined" : "ok",
    finalText: "",
    structured: task.interpret(jev),
    sessionId: null,
    usage: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0 },
    numTurns: 1,
    costUsd: 0.00004,
    costEquivUsd: 0.00004,
    error: decline?.reason ?? null,
    quota: null,
    ...(decline ? { decline } : {}),
  };
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "limitless-cascade-"));
  repoDir = join(home, "target");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
  writeFileSync(join(repoDir, ".limitless.toml"), `[gates]\nchecks = [{ name = "ok", run = "true" }]\n`);
  await sh(["git", "init", "-q", "-b", "main"], { cwd: repoDir });
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repoDir });
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoDir });
  jev = answers(0.95, 0.1);
  llmTriage = { structured: llmAnswer };
  tasks = 0;
});
afterEach(async () => {
  await factory?.stop();
  factory?.store.close();
  factory = null;
  rmSync(home, { recursive: true, force: true });
});

function start(): Factory {
  const providers: ProviderDef[] = [
    { id: "typesafe", label: "decisions", harness: "decisions", billing: "metered", maxConcurrent: 2 },
    { id: "alpha", label: "LLM", harness: "fake", billing: "subscription", maxConcurrent: 2 },
  ];
  const model = (id: string, provider: string): ModelDef => ({
    id,
    provider,
    model: id,
    vendor: provider === "typesafe" ? "typesafe" : "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: provider === "typesafe" ? 1 : 4,
    price: { input: 1, output: 1 },
  });
  const llm = { default: ["alpha/m"] };
  const policy = {
    triage: { default: ["typesafe/jev", "alpha/m"] },
    spec: llm,
    holdout: llm,
    implement: llm,
    review: llm,
    verify: llm,
  } as unknown as Policy;
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  factory = new Factory(cfg, {
    providers,
    models: [model("typesafe/jev", "typesafe"), model("alpha/m", "alpha")],
    policy,
    harnesses: {
      decisions,
      // Later stages block until the run is cancelled: these tests stop after triage.
      fake: fakeHarness((s) =>
        s.prompt.startsWith("Classify this software task") ? llmTriage : { fault: "block" },
      ),
    },
  });
  factory.start();
  return factory;
}

async function until(f: Factory, runId: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out; run ${f.store.getRun(runId)?.status}`);
    await Bun.sleep(25);
  }
}

async function triage(prompt: string, statuses: RunStatus[] = []) {
  const f = start();
  const run = await f.createRun({ repo: repoDir, prompt, profile: "standard" });
  const stage = () => f.store.listStages(run.id).find((s) => s.name === "triage");
  await until(f, run.id, () => {
    const status = f.store.getRun(run.id)?.status;
    return (!!stage() && stage()?.status !== "running") || statuses.includes(status as RunStatus);
  });
  await until(
    f,
    run.id,
    () => statuses.length === 0 || statuses.includes(f.store.getRun(run.id)?.status as RunStatus),
  );
  const invocations = f.store.listInvocations(run.id).filter((i) => i.role === "triage");
  const logs = f.store.listEvents(run.id).map((e) => e.message);
  const artifact = f.store.listArtifacts(run.id).find((a) => a.name === "triage.json");
  f.cancelRun(run.id);
  return { f, run, stage: stage(), invocations, logs, artifact };
}

test("a confident decision triages the run from the task the engine passes", async () => {
  const { stage, invocations, artifact } = await triage("Add a farewell file");
  expect(tasks).toBe(1);
  expect(stage).toMatchObject({ status: "succeeded" });
  expect(stage?.summary).toContain("(typesafe/jev)");
  expect(invocations.map((i) => [i.modelId, i.status])).toEqual([["typesafe/jev", "ok"]]);
  expect(artifact).toBeDefined();
});

test("an unsure decision falls back to the LLM triage", async () => {
  jev = answers(0.3, 0.1);
  llmTriage = { structured: { ...llmAnswer, ambiguity: "low", blocking_questions: [] } };
  const { f, stage, invocations, logs } = await triage("Add a farewell file");
  expect(stage?.summary).toContain("(alpha/m)");
  expect(invocations.map((i) => [i.modelId, i.status, i.error])).toEqual([
    ["typesafe/jev", "declined", "confidence below 0.6 (complexity 0.30)"],
    ["alpha/m", "ok", null],
  ]);
  expect(logs).toContain(
    "typesafe/jev declined: confidence below 0.6 (complexity 0.30); trying the next model",
  );
  // A decline is an answered call: neither ok nor a failure in model stats.
  const jevStats = computeStats(f.store).models.find((m) => m.modelId === "typesafe/jev");
  expect(jevStats).toMatchObject({ invocations: 1, ok: 0, failed: 0 });
});

test("a question-needing decision goes to the LLM, which asks the requester", async () => {
  jev = answers(0.95, 0.9, 2);
  const { f, run, invocations } = await triage("Make it better.", ["waiting_input"]);
  expect(invocations.map((i) => i.status)).toEqual(["declined", "ok"]);
  expect(invocations[0]?.error).toBe("blocking questions likely (P=0.90); ambiguity high");
  expect(f.store.listQuestions(run.id).map((q) => q.question)).toEqual(["Which outcome do you want?"]);
});

test("without an LLM, a question-needing decision ends needs_human but an unsure one is used", async () => {
  jev = answers(0.95, 0.9, 2);
  llmTriage = { status: "quota", error: "out of quota" };
  const unclear = await triage("Make it better.", ["needs_human"]);
  expect(unclear.stage).toMatchObject({ status: "failed" });
  expect(unclear.stage?.summary).toContain("No model available for triage");
  expect(unclear.artifact).toBeUndefined();
  await unclear.f.stop();
  unclear.f.store.close();

  jev = answers(0.3, 0.1);
  const unsure = await triage("Add a farewell file");
  expect(unsure.stage).toMatchObject({ status: "succeeded" });
  expect(unsure.stage?.summary).toContain("(typesafe/jev)");
  expect(unsure.logs).toContain("No other model for triage; using the declined answer from typesafe/jev");
});
