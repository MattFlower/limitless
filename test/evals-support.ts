import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CaseFile } from "../src/evals/cases.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { Triage } from "../src/pipeline/schemas.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";
import { gitSeed } from "./git-seed.ts";

export const answer: Triage = {
  title: "Example",
  task_class: "bugfix",
  complexity: "small",
  risk: "low",
  ambiguity: "low",
  blocking_questions: [],
  summary: "Example",
  suggested_profile: "standard",
};
export const gold = {
  task_class: "bugfix",
  complexity: "small",
  risk: "low",
  ambiguity: "low",
  needs_questions: false,
} as const;
export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("uninitialized");
  };
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** A verifier from another vendor than the fixture's candidates, for panel review systems. */
export const verifierModel: ModelDef = {
  id: "verifier-c",
  provider: "provider-b",
  model: "c",
  tier: 1,
  vendor: "qwen",
  origin: "unknown",
  baseOrigin: "unknown",
  supportedEfforts: [],
  price: { input: 1, output: 1 },
};
/** The pinned commit, a later one, and a bare clone standing in for the factory's repo cache. */
const repoSeed = gitSeed(async (dir) => {
  const source = join(dir, "source");
  mkdirSync(source);
  const git = (args: string[]) => sh(["git", ...args], { cwd: source });
  await git(["init", "-q"]);
  await git(["config", "user.email", "eval@example.invalid"]);
  await git(["config", "user.name", "Eval"]);
  writeFileSync(join(source, "PINNED.txt"), "old");
  await git(["add", "."]);
  await git(["commit", "-qm", "pinned"]);
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  rmSync(join(source, "PINNED.txt"));
  writeFileSync(join(source, "CURRENT.txt"), "new");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "current"]);
  await git(["clone", "-q", "--bare", source, join(dir, "cache")]);
  return sha;
});
export async function evalFixture(
  extraModels: ModelDef[] = [],
  extraProviders: ProviderDef[] = [],
  policy?: Policy,
) {
  const home = mkdtempSync(join(tmpdir(), "limitless-eval-"));
  const cfg = loadConfig({ home, configDir: join(home, "config") });
  cfg.secrets = {};
  cfg.openrouterBudgetUsd = 100;
  const source = join(home, "source");
  const cache = join(cfg.paths.repos, "fixture__repo.git");
  const seed = await repoSeed();
  cpSync(join(seed.dir, "source"), source, { recursive: true });
  cpSync(join(seed.dir, "cache"), cache, { recursive: true });
  // The bare clone's origin is the seed; fetches of later pins must reach this fixture's source.
  const config = readFileSync(join(cache, "config"), "utf8");
  const origin = /^(\s*url = ).*$/m;
  if (!origin.test(config)) throw new Error("seeded cache has no origin url");
  writeFileSync(
    join(cache, "config"),
    config.replace(origin, (_, key: string) => key + source),
  );
  const sha = seed.value;
  const dataset: CaseFile = {
    role: "triage",
    version: 1,
    notes: "fixture",
    repos: { "fixture/repo": sha },
    cases: ["a", "b", "c"].map((id) => ({
      id,
      repo: "fixture/repo",
      prompt: `Fix ${id}`,
      gold: { ...gold },
      tags: ["SECRET_TAG"],
    })),
  };
  const casePath = join(home, "cases.json");
  const save = () => writeFileSync(casePath, JSON.stringify(dataset));
  save();
  const calls: AgentSpec[] = [];
  const harnessNames: string[] = [];
  let handler: (s: AgentSpec) => FakeReply | Promise<FakeReply> = () => ({ structured: answer });
  const harness = (name: string) =>
    fakeHarness((s) => {
      calls.push(s);
      harnessNames.push(name);
      return handler(s);
    });
  const factory = new Factory(cfg, {
    ...(policy ? { policy } : {}),
    evalCasePath: casePath,
    providers: [
      {
        id: "openrouter",
        label: "A",
        harness: "fake",
        billing: "metered",
        maxConcurrent: 1,
        openaiBaseUrl: "http://unused.invalid",
      },
      { id: "provider-b", label: "B", harness: "fake", billing: "subscription", maxConcurrent: 1 },
      ...extraProviders,
    ],
    models: [
      ...extraModels,
      {
        id: "candidate-a",
        provider: "openrouter",
        model: "a",
        tier: 1,
        vendor: "other",
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        price: { input: 1, output: 1 },
      },
      {
        id: "candidate-b",
        provider: "provider-b",
        model: "b",
        tier: 1,
        vendor: "other",
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        price: { input: 1, output: 1 },
      },
    ],
    harnesses: {
      fake: harness("fake"),
      codex: harness("codex"),
      llm: harness("llm"),
      decisions: harness("decisions"),
    },
  });
  return {
    home,
    cfg,
    factory,
    dataset,
    casePath,
    save,
    source,
    cache,
    sha,
    calls,
    harnessNames,
    respond(fn: typeof handler) {
      handler = fn;
    },
    async run(over: Record<string, unknown> = {}) {
      const run = factory.evals.submit({
        role: "triage",
        models: ["candidate-a", "candidate-b"],
        k: 2,
        ...over,
      });
      await factory.evals.wait(run.id);
      const report = factory.evals.report(run.id);
      if (!report) throw new Error("missing report");
      return report;
    },
    async close() {
      await factory.stop();
      factory.store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function enableEfforts(f: Awaited<ReturnType<typeof evalFixture>>) {
  const model = f.factory.router.model("candidate-a");
  if (!model) throw new Error("missing candidate");
  model.supportedEfforts = ["none", "low", "high"];
  model.effort = "low";
  return model;
}
export const invalidTargets = [
  [""],
  ["candidate-a@"],
  ["candidate-a@low@high"],
  [" candidate-a"],
  ["candidate-a@low "],
  ["candidate-a @low"],
  ["unknown@low"],
  ["candidate-a@max"],
  ["candidate-b@low"],
  ["candidate-a", "candidate-a@low"],
  ["candidate-a@none", "candidate-a@none"],
];
