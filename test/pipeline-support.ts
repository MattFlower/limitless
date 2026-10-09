import { afterEach, beforeEach, expect, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { mergeGit } from "../src/git/merge.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import { observerRoots } from "../src/harness/sandbox.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { redactCredentials, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { seeded } from "./seeded.ts";

const originalPath = process.env.PATH;

const seedTarget = seeded(async (root) => {
  const dir = join(root, "target");
  mkdirSync(dir);
  writeFileSync(join(dir, "greeting.txt"), "hello\n");
  writeFileSync(
    join(dir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "no-bad", run = "! grep -rq BAD --include=*.txt ." }]\n`,
  );
  await sh(["git", "init", "-q", "-b", "main"], { cwd: dir });
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: dir });
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
});

export const providers: ProviderDef[] = [
  { id: "alpha", label: "Alpha", harness: "fake", billing: "subscription", maxConcurrent: 2 },
  { id: "beta", label: "Beta", harness: "fake", billing: "subscription", maxConcurrent: 2 },
];

export const models: ModelDef[] = [
  {
    id: "alpha/m",
    provider: "alpha",
    model: "alpha-1",
    vendor: "anthropic",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 1, output: 1 },
  },
  {
    id: "beta/m",
    provider: "beta",
    model: "beta-1",
    vendor: "openai",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 1, output: 1 },
  },
];

export const everyone = { default: ["alpha/m", "beta/m"] };

export const policy = {
  triage: everyone,
  spec: everyone,
  holdout: everyone,
  implement: everyone,
  review: { default: ["beta/m", "alpha/m"] },
  verify: { default: ["beta/m", "alpha/m"] },
} as unknown as Policy;

export type Handler = (spec: AgentSpec) => FakeReply | Promise<FakeReply>;

export function roleOf(spec: AgentSpec): string {
  const p = spec.prompt;
  if (p.startsWith("Classify this software task")) return "triage";
  if (p.startsWith("Write the specification")) return "spec";
  if (p.startsWith("Write holdout checks")) return "holdout";
  if (/^You are (an adversarial|a) code reviewer/.test(p)) return "review";
  if (p.startsWith("You are the acceptance verifier")) return "verify";
  return "implement";
}

export const triage = (over: Record<string, unknown> = {}) => ({
  title: "Add farewell",
  task_class: "feature",
  complexity: "small",
  risk: "low",
  ambiguity: "low",
  blocking_questions: [],
  summary: "Add a farewell file",
  suggested_profile: "standard",
  ...over,
});

export const spec = {
  summary: "Add farewell.txt",
  assumptions: [],
  requirements: ["farewell.txt exists"],
  acceptance_criteria: [
    { id: "AC-1", criterion: "farewell.txt says goodbye", how_to_verify: "cat farewell.txt" },
  ],
  out_of_scope: [],
  blocking_questions: [],
};

export const approve = {
  verdict: "approve",
  summary: "LGTM: checked the diff against every requirement",
  findings: [],
};

export const holdout = {
  scenarios: [
    {
      id: "H-1",
      description: "file appears",
      steps: "cat farewell.txt",
      expected: "goodbye",
      edge_case: false,
    },
    {
      id: "H-2",
      description: "missing input",
      steps: "test ! -e missing.txt",
      expected: "exit zero",
      edge_case: true,
    },
    {
      id: "H-3",
      description: "empty input",
      steps: "test -s farewell.txt",
      expected: "exit zero",
      edge_case: true,
    },
  ],
};

export const pass = {
  criteria: [
    { id: "AC-1", status: "met", evidence: "cat shows goodbye", publicSummary: "" },
    ...holdout.scenarios.map((s) => ({
      id: s.id,
      status: "met",
      evidence: "observed expected result",
      publicSummary: "",
    })),
  ],
  overall: "pass",
  notes: "",
};

export async function waitFor(
  f: Factory,
  runId: string,
  statuses: RunStatus[],
  timeoutMs = 20_000,
): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  // A run update wakes the check a turn later, once the scheduler has settled; the poll covers the rest.
  let wake = () => {};
  const unsubscribe = f.store.subscribe((msg) => {
    if (msg.kind === "run") wake();
  });
  try {
    while (Date.now() < deadline) {
      const run = f.store.getRun(runId);
      if (run && statuses.includes(run.status)) return run.status;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        wake = () => {
          clearTimeout(timer);
          setImmediate(resolve);
        };
      });
    }
  } finally {
    unsubscribe();
  }
  throw new Error(`timed out waiting for ${statuses.join("|")}; status=${f.store.getRun(runId)?.status}`);
}

interface PipelineFixture {
  home: string;
  repoDir: string;
  factory: Factory | null;
}

// Register hooks in the importing file; each parallel worker owns its fixture and seeded repo.
export function pipelineSetup(state: PipelineFixture) {
  // Real git and subprocesses outlast Bun's 5 s default under CPU load (#140).
  setDefaultTimeout(30_000);

  async function makeRepo(): Promise<string> {
    await seedTarget(state.home);
    return join(state.home, "target");
  }

  function start(handler: Handler, effortRouting = false, freeProviders = false): Factory {
    const alpha = models[0];
    const beta = models[1];
    if (!alpha || !beta) throw new Error("missing fixture models");
    const cfg = loadConfig({ home: join(state.home, "data"), configDir: join(state.home, "cfg") });
    state.factory = new Factory(cfg, {
      confinement: fakeConfinement,
      harnesses: { fake: fakeHarness(handler) },
      providers: freeProviders
        ? [
            ...providers,
            { id: "gamma", label: "Gamma", harness: "fake", billing: "free", maxConcurrent: 2 },
            { id: "delta", label: "Delta", harness: "fake", billing: "free", maxConcurrent: 2 },
          ]
        : providers,
      models: effortRouting
        ? models.map((m): ModelDef => ({ ...m, supportedEfforts: ["low", "high"], effort: "low" }))
        : freeProviders
          ? [
              ...models,
              { ...alpha, id: "gamma/m", provider: "gamma", vendor: "anthropic", tier: 3 },
              { ...beta, id: "delta/m", provider: "delta", vendor: "openai", tier: 5 },
            ]
          : models,
      policy: effortRouting ? { ...policy, implement: { default: ["alpha/m@high", "alpha/m@low"] } } : policy,
      bootSha: "test-build",
    });
    state.factory.start();
    return state.factory;
  }

  beforeEach(async () => {
    state.home = mkdtempSync(join(tmpdir(), "limitless-e2e-"));
    // Gate commands here count their runs in files under home; confinement itself is tested elsewhere.
    observerRoots.add(realpathSync(state.home));
    state.repoDir = await makeRepo();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (process.env.PIPELINE_DIAGNOSTICS && state.factory) {
      for (const run of state.factory.store.listRuns()) {
        if (run.status === "succeeded") continue;
        console.error(`Pipeline run diagnostics: ${run.id}`);
        writeFileSync(
          join(process.env.PIPELINE_DIAGNOSTICS, `${run.id}.json.log`),
          JSON.stringify(
            {
              run,
              stages: state.factory.store.listStages(run.id),
              events: state.factory.store.listEvents(run.id, { limit: 100000 }),
              state: state.factory.store.getRunState(run.id),
            },
            (_key: string, value: unknown) => (typeof value === "string" ? redactCredentials(value) : value),
            2,
          ),
        );
      }
    }
    await state.factory?.stop();
    state.factory?.store.close();
    state.factory = null;
    rmSync(state.home, { recursive: true, force: true });
    observerRoots.clear();
  });

  // Same text git generates, so a fixture line can never stand in for a real marker.
  const fixture = "<<<<<<< HEAD\nexample\n=======\n>>>>>>> theirs\n";

  async function githubFixture(): Promise<string> {
    // Ordinary headings and intentional marker fixtures must not block any base merge.
    writeFileSync(join(state.repoDir, "README.md"), "Project\n=======\n");
    writeFileSync(join(state.repoDir, "markers.fixture"), fixture);
    writeFileSync(join(state.repoDir, "binary.fixture"), Buffer.from([0, 255, 10]));
    await mergeGit(state.repoDir, ["add", "-A"]);
    await mergeGit(state.repoDir, ["commit", "-qm", "merge scan fixtures"]);
    const bare = join(state.home, "github.git");
    await sh(["git", "clone", "-q", "--bare", state.repoDir, bare], { cwd: state.home });
    const bin = join(state.home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> '${join(state.home, "gh-calls")}'\ncase "$2" in\n  list) exit 0 ;;\n  create) cat > '${join(state.home, "gh-body")}'; echo https://github.com/test/repo/pull/1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    return bare;
  }

  function registerGithub(f: Factory, bare: string): void {
    f.store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
  }

  async function advanceBase(bare: string, file: string, content: string): Promise<string> {
    writeFileSync(join(state.repoDir, file), content);
    await sh(["git", "add", "."], { cwd: state.repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "advance base"], {
      cwd: state.repoDir,
    });
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: state.repoDir })).stdout.trim();
    await sh(["git", "push", bare, "HEAD:refs/heads/main"], { cwd: state.repoDir });
    return sha;
  }

  async function assertPublished(bare: string): Promise<void> {
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).not.toBe("");
  }

  async function assertUnpublished(bare: string): Promise<void> {
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");
    expect(existsSync(join(state.home, "gh-calls"))).toBe(false);
  }

  async function resolveBaseConflict(cwd: string, bare: string): Promise<FakeReply> {
    expect(readFileSync(join(cwd, "greeting.txt"), "utf8")).toContain("<<<<<<<");
    expect((await sh(["git", "rev-parse", "MERGE_HEAD"], { cwd })).stdout.trim()).toHaveLength(40);
    await assertUnpublished(bare);
    return { files: { "greeting.txt": "hello from both intents\nnew base\n" } };
  }

  async function previewFixture(): Promise<void> {
    writeFileSync(
      join(state.repoDir, ".limitless.toml"),
      `[gates]
checks = [{ name = "no-bad", run = "! grep -rq BAD --include=*.txt ." }]
[preview]
paths = ["ui/"]
build = "echo build >> '${join(state.home, "preview-steps")}'"
seed = 'echo seed >> "${join(state.home, "preview-steps")}"; mkdir -p "$LIMITLESS_HOME" && echo seeded > "$LIMITLESS_HOME/seed.txt"'
serve = "echo serve >> '${join(state.home, "preview-steps")}'; bun serve.ts"
ready = "/health"
env = { LIMITLESS_HOME = "{scratch}/home", LIMITLESS_CONFIG_DIR = "{scratch}/config", LIMITLESS_PORT = "{port}" }
`,
    );
    writeFileSync(
      join(state.repoDir, "serve.ts"),
      'Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.LIMITLESS_PORT), fetch: async () => new Response(await Bun.file(process.env.LIMITLESS_HOME + "/seed.txt").text(), {headers: {"x-scratch": process.env.HOME ?? ""}}) });',
    );
    await sh(["git", "add", "."], { cwd: state.repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "preview fixture"], {
      cwd: state.repoDir,
    });
  }

  return {
    start,
    makeRepo,
    fixture,
    githubFixture,
    registerGithub,
    advanceBase,
    assertPublished,
    assertUnpublished,
    resolveBaseConflict,
    previewFixture,
  };
}
