import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { localExecutor } from "../src/gates/executor.ts";
import { resolveRepo } from "../src/git/repos.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import { type AcceptanceState, acceptanceEngine, acceptanceRunRequest } from "../src/pipeline/acceptance.ts";
import { localCheckpointer, type RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { type Fault, SimulatedTermination } from "../src/pipeline/faults.ts";
import { AcceptanceSchema } from "../src/pipeline/schemas.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { models, pipelineSetup, policy, providers } from "./pipeline-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { githubFixture, registerGithub, advanceBase, assertUnpublished } = pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

const parent = `## Goal
- Unit one.
- Unit two.

## Docs
- Unit three.`;
const ticket = `## The original intent\n#1's "Goal" section\n\n#1's "Docs" section (docs)`;
type Item = {
  unit: string;
  verdict: string;
  files?: { path: string; lines?: object }[];
  tests?: string[];
  note?: string;
};
const output = (items: Item[]) => ({
  items: items.map((i) => ({
    files: [],
    note: "",
    ...i,
    tests: (i.tests ?? []).map((name) => ({ file: "x.test.ts", name })),
  })),
});

async function setup(
  options: { setup?: string; parent?: string; ticket?: string; junit?: "stale" | "missing" } = {},
) {
  writeFileSync(join(repoDir, ".gitignore"), "local.env\n");
  writeFileSync(
    join(repoDir, ".limitless.toml"),
    `[gates]\nsetup = [${JSON.stringify(options.setup ?? "echo local > local.env")}]\nretry_files = "bun test {files}"\nchecks = [{ name = "test", run = "bun test" }]\ndocs = ["README.md", "docs/**"]\n`,
  );
  writeFileSync(
    join(repoDir, "x.test.ts"),
    `import { expect, test } from "bun:test";
test("passes", () => expect(1).toBe(1));
test("also passes", () => expect(1).toBe(1));
test("fails", () => expect(1).toBe(2));
test${".skip"}("skipped", () => {});
`,
  );
  if (options.junit)
    writeFileSync(
      join(repoDir, "junit-evidence.sh"),
      `bun test -t '(?:^| )passes$' ./x.test.ts "$@"
status=$?
${options.junit === "stale" ? 'touch -t 200001010000 "$LIMITLESS_GATE_REPORT"' : 'rm -f "$LIMITLESS_GATE_REPORT"'}
exit "$status"
`,
    );
  writeFileSync(join(repoDir, "notes.txt"), "a\nb\n");
  await sh(["git", "add", "."], { cwd: repoDir });
  await sh(["git", "commit", "-qm", "acceptance fixture"], { cwd: repoDir });
  const bare = await githubFixture();
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
  const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
  let calls = 0;
  let reply: (calls: number) => FakeReply | Promise<FakeReply> = () => ({ structured: output([]) });
  const targeted: string[] = [];
  const executor = localExecutor();
  const start = executor.start.bind(executor);
  executor.start = (request, signal) => {
    for (const check of request.gates.checks)
      if (check.run.includes(" -t ")) {
        targeted.push(check.run);
        if (options.junit) check.run = "bash ./junit-evidence.sh";
      }
    return start(request, signal);
  };
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
  const f = new Factory(cfg, {
    loadSource: () => 0,
    confinement: fakeConfinement,
    harnesses: { fake: fakeHarness(() => reply(++calls)) },
    providers,
    models,
    policy,
    bootSha: "test-build",
    gateExecutor: executor,
  });
  factory = f;
  registerGithub(f, bare);
  const repo = await resolveRepo(f.store, "test/repo", cfg.githubMerge);
  const snapshot = acceptanceRunRequest({
    ticket: {
      number: 9,
      body: options.ticket ?? ticket,
      author: { login: "owner" },
      userContentEdits: { nodes: [], pageInfo: { hasNextPage: false } },
    },
    parent: {
      number: 1,
      body: options.parent ?? parent,
      author: { login: "owner" },
      userContentEdits: { nodes: [], pageInfo: { hasNextPage: false } },
    },
    trusted: ["owner"],
  });
  const run = f.store.createAcceptanceRun(
    repo,
    {
      repo: "test/repo",
      source: "github",
      sourceRef: { kind: "issue", repo: "test/repo", number: 9 },
      prompt: "Accept #9",
    },
    snapshot,
  );
  const state = () => f.store.getRunState<RunState>(run.id);
  return {
    f,
    bare,
    sha,
    run,
    targeted,
    calls: () => calls,
    reply: (next: typeof reply) => {
      reply = next;
    },
    execute: (signal = new AbortController().signal): Promise<RunStatus> =>
      executeRun(f.deps, run.id, signal),
    state,
    outcome: () => state()?.acceptance?.outcome as NonNullable<AcceptanceState["outcome"]>,
    published: async () => {
      await assertUnpublished(bare);
      expect(f.store.getRun(run.id)).toMatchObject({ prUrl: null, branch: null });
    },
  };
}

test("all units verified met succeed without publishing, at the pinned SHA", async () => {
  const t = await setup();
  t.reply(async () => {
    // The default branch advances after prepare pinned the checked SHA.
    await advanceBase(t.bare, "later.txt", "later\n");
    return {
      structured: output([
        {
          unit: "U1",
          verdict: "met",
          tests: ["passes"],
          files: [{ path: "x.test.ts", lines: { start: 1, end: 2 } }],
        },
        { unit: "U2", verdict: "met", tests: ["also passes"], note: "looked fine" },
        { unit: "U3", verdict: "met", files: [{ path: "README.md" }] },
      ]),
    };
  });
  expect(await t.execute()).toBe("succeeded");
  const outcome = t.outcome();
  expect(outcome).toMatchObject({ sha: t.sha, passed: true, summary: "3 met" });
  const records = t.state()?.coveringTestRuns ?? [];
  expect(records.map((r) => [r.name, r.verifiedSha])).toEqual([
    ["passes", t.sha],
    ["also passes", t.sha],
  ]);
  const report = t.f.store.getArtifact(t.run.id, "report.md") ?? "";
  expect(report).toContain("## Acceptance");
  for (const r of records)
    expect(report).toContain(
      `Factory covering test x.test.ts › ${r.name} passed at ${t.sha} (stage ${r.stageId})`,
    );
  expect(report).toContain(`x.test.ts@${t.sha}:1-2`);
  expect(report).toContain(`README.md@${t.sha}`);
  expect(report).toContain("model note (unverified): looked fine");
  expect(JSON.parse(t.f.store.getArtifact(t.run.id, "acceptance.json") ?? "null")).toEqual(outcome);
  expect(t.calls()).toBe(1);
  await t.published();
});

test("adjacent section references retain an unassessed requirement and prevent success", async () => {
  const t = await setup({
    parent: "## Goal\n- Required goal.\n\n## Demo\n- Required demo.",
    ticket: `## The original intent\n#1's "Goal" section\n#1's "Demo" section`,
  });
  t.reply(() => ({
    structured: output([{ unit: "U1", verdict: "met", tests: ["passes"] }]),
  }));
  expect(await t.execute()).toBe("needs_human");
  expect(t.outcome().units.map((u) => [u.unit, u.verdict])).toEqual([
    ["U1", "met"],
    ["U2", "not_assessed"],
  ]);
  await t.published();
});

test.each(["stale", "missing"] as const)(
  "%s JUnit evidence cannot satisfy acceptance despite successful execution",
  async (junit) => {
    const t = await setup({
      junit,
      parent: "## Goal\n- Required behaviour.",
      ticket: `## The original intent\n#1's "Goal" section`,
    });
    t.reply(() => ({ structured: output([{ unit: "U1", verdict: "met", tests: ["passes"] }]) }));
    expect(await t.execute()).toBe("needs_human");
    expect(t.state()?.coveringTestRuns?.[0]?.result).toMatchObject({
      ok: true,
      exitCode: 0,
      coveringTest: { file: "x.test.ts", name: "passes", reason: "JUnit report missing, stale or unsafe" },
    });
    expect(t.outcome().units).toEqual([
      {
        unit: "U1",
        verdict: "unmet",
        citations: [],
        refusals: ["x.test.ts › passes: JUnit report missing, stale or unsafe"],
        note: "",
      },
    ]);
    expect(t.targeted).toHaveLength(1);
    await t.published();
  },
);

const adversarialParent = `## Goal
${Array.from({ length: 8 }, (_, i) => `- Behaviour ${i + 1}.`).join("\n")}

## Docs
- Docs one.
- Docs two.
- Docs three.

## More
- Behaviour 12.
- Behaviour 13.
- Behaviour 14.
- Behaviour 15.`;

test("claimed met verdicts are downgraded unless the engine verifies them", async () => {
  const t = await setup({
    parent: adversarialParent,
    ticket: `## The original intent\n#1's "Goal" section\n\n#1's "Docs" section (docs)\n\n#1's "More" section`,
  });
  t.reply(() => ({
    structured: output([
      { unit: "U1", verdict: "met", tests: ["fails"] },
      { unit: "U2", verdict: "met", tests: ["skipped"] },
      { unit: "U3", verdict: "met", tests: ["no such test"] },
      { unit: "U4", verdict: "met", files: [{ path: "local.env" }] },
      { unit: "U5", verdict: "met", files: [{ path: "../outside.txt" }] },
      { unit: "U6", verdict: "met", tests: [], files: [{ path: "README.md", lines: { start: 2, end: 9 } }] },
      { unit: "U7", verdict: "met" },
      { unit: "U8", verdict: "met", files: [{ path: "README.md" }] },
      { unit: "U9", verdict: "met" },
      { unit: "U10", verdict: "met", files: [{ path: "notes.txt" }] },
      { unit: "U11", verdict: "met", files: [{ path: "README.md" }] },
      { unit: "U12", verdict: "met", files: [{ path: "README.md" }] },
      { unit: "U12", verdict: "met", files: [{ path: "README.md" }] },
      { unit: "U14", verdict: "met", note: "verified by gate run 12" },
      { unit: "U15", verdict: "manual", note: "needs a live demo" },
      { unit: "U99", verdict: "met", tests: ["passes"] },
    ]),
  }));
  expect(await t.execute()).toBe("needs_human");
  const outcome = t.outcome();
  const verdict = (unit: string) => outcome.units.find((u) => u.unit === unit);
  const behaviour = "behaviour requirement needs a passing covering test";
  const docs = "docs requirement needs a verified file matching [gates] docs";
  expect(outcome.units.map((u) => [u.unit, u.verdict])).toEqual([
    ...Array.from({ length: 12 }, (_, i) => [`U${i + 1}`, i === 10 ? "met" : "unmet"]),
    ["U13", "not_assessed"],
    ["U14", "unmet"],
    ["U15", "manual"],
  ]);
  expect(verdict("U1")?.refusals).toEqual(["x.test.ts › fails: test failed"]);
  expect(verdict("U2")?.refusals).toEqual(["x.test.ts › skipped: named test skipped"]);
  expect(verdict("U2")?.citations).toEqual([]);
  expect(verdict("U3")?.refusals[0]).toContain("x.test.ts › no such test: ");
  expect(verdict("U4")?.refusals).toEqual(["local.env: file not tracked at verified SHA"]);
  expect(verdict("U5")?.refusals).toEqual(["../outside.txt: file outside repository or invalid retry file"]);
  expect(verdict("U6")?.refusals).toEqual(["README.md: line range out of bounds"]);
  expect(verdict("U7")?.refusals).toEqual([behaviour]);
  expect(verdict("U8")).toMatchObject({ refusals: [behaviour], citations: [`README.md@${t.sha}`] });
  expect(verdict("U9")?.refusals).toEqual([docs]);
  expect(verdict("U10")?.refusals).toEqual([docs]);
  expect(verdict("U11")?.citations).toEqual([`README.md@${t.sha}`]);
  expect(verdict("U12")?.refusals).toEqual(["duplicate assessments"]);
  expect(verdict("U14")?.refusals).toEqual([behaviour]);
  expect(outcome.summary).toBe("1 met, 12 unmet, 1 not assessed, 1 manual");
  expect(t.f.store.getRun(t.run.id)?.error).toBe("Acceptance: 1 met, 12 unmet, 1 not assessed, 1 manual");
  // Only the three tests cited by single met items ran; the unknown unit's test did not.
  expect(t.targeted).toHaveLength(3);
  await t.published();
});

test.each(["unmet", "manual", "not-assessed"] as const)("a %s outcome needs a human", async (mode) => {
  const t = await setup();
  t.reply(() => ({
    structured: output([
      { unit: "U1", verdict: "met", tests: ["passes"] },
      ...(mode === "not-assessed" ? [] : [{ unit: "U2", verdict: mode }]),
      { unit: "U3", verdict: "met", files: [{ path: "README.md" }] },
    ]),
  }));
  expect(await t.execute()).toBe("needs_human");
  expect(t.f.store.getRun(t.run.id)?.error).toBe(
    `Acceptance: 2 met, 1 ${mode === "not-assessed" ? "not assessed" : mode}`,
  );
  await t.published();
});

test.each(["reader", "setup", "intent"] as const)(
  "a %s failure ends failed before any outcome",
  async (mode) => {
    const secret = "acceptance-setup-secret-7731";
    registerCredential("acceptance-setup-test", secret);
    const t = await setup({
      ...(mode === "setup" ? { setup: `echo ${secret}; exit 3` } : {}),
      ...(mode === "intent" ? { ticket: "## The original intent\nFrom docs/PLAN.md:\n\n> - Unit" } : {}),
    });
    t.reply(() => ({ fault: "throw", error: "model unavailable" }));
    expect(await t.execute()).toBe("failed");
    const error = t.f.store.getRun(t.run.id)?.error ?? "";
    expect(error).toContain(
      mode === "reader"
        ? "Acceptance reader failed"
        : mode === "setup"
          ? "Acceptance setup failed"
          : "unsupported Markdown in the intent: line 2 of the ticket: quote lead-in; normalize the ticket",
    );
    expect(error).not.toContain(secret);
    expect(t.calls()).toBe(mode === "reader" ? 2 : 0);
    expect(t.state()?.acceptance?.outcome).toBeUndefined();
    expect(!!t.state()?.acceptance?.setupDone).toBe(mode !== "setup");
    await t.published();
  },
);

const metAll = output([
  { unit: "U1", verdict: "met", tests: ["passes"] },
  { unit: "U2", verdict: "met", tests: ["also passes"] },
  { unit: "U3", verdict: "met", files: [{ path: "README.md" }] },
]);
const parsedMetAll = AcceptanceSchema.parse(metAll);

test.each([
  [
    "nested fence",
    "## Goal\n- Before.\n\n````md\n```\n## Hidden\n- Hidden.\n````\n\n- After.\n\n## End\n- Outside.",
    "line 4 of #1: fence",
  ],
  [
    "list-contained heading",
    "## Goal\n- Before.\n\n  ## In list\n  Never omit.\n\n- After.",
    "line 4 of #1: indented line",
  ],
  [
    "escaped pipe row",
    "## Goal\n- Before.\n| The service accepts red \\| blue tokens. |",
    "line 3 of #1: table row",
  ],
])("%s fails before invocation, covering tests or publication", async (_name, parent, reason) => {
  const t = await setup({ parent, ticket: `## The original intent\n#1's "Goal" section` });
  t.reply(() => ({ structured: output([{ unit: "U1", verdict: "met", tests: ["passes"] }]) }));
  expect(await t.execute()).toBe("failed");
  expect(t.f.store.getRun(t.run.id)?.error).toContain(
    `unsupported Markdown in the intent: ${reason}; normalize the ticket`,
  );
  expect(t.calls()).toBe(0);
  expect(t.targeted).toEqual([]);
  expect(t.state()?.coveringTestRuns ?? []).toEqual([]);
  expect(t.state()?.acceptance?.outcome).toBeUndefined();
  expect(t.f.store.getArtifact(t.run.id, "acceptance.json")).toBeNull();
  await t.published();
});

test.each(["manifest", "output", "covering-test", "outcome"] as const)(
  "a restart after the %s checkpoint resumes without repeating it",
  async (boundary) => {
    const t = await setup();
    const shutdown = new AbortController();
    t.reply(() => ({ structured: metAll }));
    const faults: Record<Exclude<typeof boundary, "output">, [string, Fault]> = {
      manifest: ["harness:invoke", { action: "hang", onHit: () => shutdown.abort(new Error("shutdown")) }],
      "covering-test": [
        "store:save",
        { action: "kill", when: (c) => c.checkpoint === "covering-test-recorded" },
      ],
      outcome: ["store:save", { action: "kill", when: () => !!t.state()?.acceptance?.outcome }],
    };
    if (boundary === "output") {
      t.f.deps.checkpointer = {
        ...localCheckpointer(t.f.store),
        checkpoint(_runId, label) {
          if (label === "acceptance-output") throw new SimulatedTermination("saved acceptance output");
        },
      };
    } else {
      const [point, fault] = faults[boundary];
      t.f.deps.faults = { [point]: fault };
    }
    expect(["queued", "running"]).toContain(await t.execute(shutdown.signal));
    const before = t.state();
    expect(before?.acceptance?.manifest).toHaveLength(3);
    if (boundary !== "manifest") expect(before?.acceptance?.output).toEqual(parsedMetAll);
    if (boundary === "output") {
      expect(t.calls()).toBe(1);
      expect(t.targeted).toHaveLength(0);
      expect(before?.coveringTestRuns).toBeUndefined();
    }
    if (boundary === "covering-test") expect(before?.coveringTestRuns?.[0]?.result).toBeDefined();
    const ran = t.targeted.length;
    t.f.deps.faults = undefined;
    t.f.deps.checkpointer = undefined;
    expect(await t.execute()).toBe("succeeded");
    const after = t.state();
    expect(t.calls()).toBe(1);
    expect(after?.coveringTestRuns?.map((r) => r.name)).toEqual(["passes", "also passes"]);
    expect(after?.acceptance?.manifest).toEqual(before?.acceptance?.manifest);
    if (boundary === "outcome") {
      expect(after?.acceptance?.outcome).toEqual(before?.acceptance?.outcome);
      expect(t.targeted).toHaveLength(ran);
    } else expect(t.targeted).toHaveLength(boundary === "covering-test" ? 2 : 2 + ran);
    await t.published();
  },
);

test("cancellation during a covering test ends cancelled with no outcome", async () => {
  const t = await setup();
  t.reply(() => ({ structured: metAll }));
  const controller = new AbortController();
  const start = t.f.deps.gateExecutor?.start;
  if (!t.f.deps.gateExecutor || !start) throw new Error("missing gate executor");
  t.f.deps.gateExecutor.start = (request, signal) => {
    const started = start(request, signal);
    if (request.gates.checks.some((c) => c.run.includes(" -t "))) controller.abort();
    return started;
  };
  expect(await t.execute(controller.signal)).toBe("cancelled");
  expect(t.state()?.acceptance?.output).toEqual(parsedMetAll);
  expect(t.state()?.acceptance?.outcome).toBeUndefined();
  expect(t.f.store.getArtifact(t.run.id, "acceptance.json")).toBeNull();
  await t.published();
});

test.each(["created", "prepared", "output"] as const)(
  "an engine without acceptance handling ends a %s run needs_human without publishing",
  async (checkpoint) => {
    const t = await setup();
    if (checkpoint !== "created") {
      t.f.deps.faults = {
        "store:save": {
          action: "kill",
          when: (c) =>
            c.checkpoint === (checkpoint === "prepared" ? "acceptance-manifest" : "covering-test-recorded"),
        },
      };
      t.reply(() => ({ structured: metAll }));
      await t.execute();
      t.f.deps.faults = undefined;
      expect(t.state()?.worktreePath).toBeDefined();
      if (checkpoint === "output") expect(t.state()?.acceptance?.output).toEqual(parsedMetAll);
    }
    acceptanceEngine.enabled = false;
    try {
      expect(await t.execute()).toBe("needs_human");
    } finally {
      acceptanceEngine.enabled = true;
    }
    expect(t.state()).toMatchObject({
      deliveryComplete: true,
      needsHumanReason: "Acceptance runs require a compatible engine",
    });
    await t.published();
  },
);
