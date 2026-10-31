import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RunStatus } from "../src/core/types.ts";
import { WorkerStore } from "../src/db/workers.ts";
import type { GateCommand } from "../src/gates/detect.ts";
import { type GateRequest, localExecutor } from "../src/gates/executor.ts";
import { lanExecutor } from "../src/gates/lan.ts";
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
  options: {
    setup?: string;
    parent?: string;
    ticket?: string;
    junit?:
      | "stale"
      | "missing"
      | "empty"
      | "whitespace"
      | "no-match"
      | "unsafe"
      | "malformed"
      | "exit126"
      | "bun-missing"
      | "spawn";
    checks?: GateCommand[];
    files?: Record<string, string>;
  } = {},
) {
  writeFileSync(join(repoDir, ".gitignore"), "local.env\n");
  writeFileSync(
    join(repoDir, ".limitless.toml"),
    `[gates]\nsetup = [${JSON.stringify(options.setup ?? "echo local > local.env")}]\nretry_files = "bun test {files}"\nchecks = [${(
      options.checks ?? [
        { name: "lint", run: "echo lint" },
        { name: "typecheck", run: "echo types" },
        { name: "test", run: "bun test", timeoutSec: 37 },
      ]
    )
      .map(
        (c) =>
          `{ name = ${JSON.stringify(c.name)}, run = ${JSON.stringify(c.run)}${c.timeoutSec ? `, timeoutSec = ${c.timeoutSec}` : ""} }`,
      )
      .join(", ")}]\ndocs = ["README.md", "docs/**"]\n`,
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
  const reportEdits: Record<string, string> = {
    stale: 'touch -t 200001010000 "$LIMITLESS_GATE_REPORT"',
    missing: 'rm -f "$LIMITLESS_GATE_REPORT"',
    empty: ': > "$LIMITLESS_GATE_REPORT"',
    whitespace: 'printf " \n\t" > "$LIMITLESS_GATE_REPORT"',
    "no-match": `printf '%s' '<testsuites><testsuite file="x.test.ts"><testcase name="unrelated"/></testsuite></testsuites>' > "$LIMITLESS_GATE_REPORT"`,
    unsafe:
      'mv "$LIMITLESS_GATE_REPORT" "$LIMITLESS_GATE_REPORT.target"; ln -s "$LIMITLESS_GATE_REPORT.target" "$LIMITLESS_GATE_REPORT"',
    malformed: `printf '%s' '<testsuites><oops>' > "$LIMITLESS_GATE_REPORT"`,
  };
  if (options.junit && reportEdits[options.junit])
    writeFileSync(
      join(repoDir, "junit-evidence.sh"),
      `bun test -t '(?:^| )passes$' ./x.test.ts "$@"
status=$?
${reportEdits[options.junit]}
exit "$status"
`,
    );
  for (const [file, contents] of Object.entries(options.files ?? {}))
    writeFileSync(join(repoDir, file), contents);
  writeFileSync(join(repoDir, "notes.txt"), "a\nb\n");
  await sh(["git", "add", "."], { cwd: repoDir });
  await sh(["git", "commit", "-qm", "acceptance fixture"], { cwd: repoDir });
  const bare = await githubFixture();
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
  const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
  let calls = 0;
  let reply: (calls: number) => FakeReply | Promise<FakeReply> = () => ({ structured: output([]) });
  const targeted: string[] = [];
  const requests: GateRequest[] = [];
  const executor = localExecutor();
  const start = executor.start.bind(executor);
  executor.start = (request, signal) => {
    for (const check of request.gates.checks)
      if (check.run.includes(" -t ")) {
        targeted.push(check.run);
        requests.push(structuredClone(request));
        if (check.coveringTest?.file === "x.test.ts") {
          if (options.junit === "bun-missing") check.run = `PATH=./absent-bin ${check.run}`;
          else if (options.junit === "exit126") check.run = "exit 126; :";
          else if (options.junit && reportEdits[options.junit]) check.run = "bash ./junit-evidence.sh";
        }
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
  if (options.junit === "spawn")
    f.deps.confinement = {
      ...fakeConfinement,
      wrap: (cmd) =>
        cmd.some((arg) => arg.includes(" -t ") && arg.includes("x.test.ts"))
          ? [join(repoDir, "absent-runner")]
          : cmd,
    };
  factory = f;
  registerGithub(f, bare);
  const repo = await resolveRepo(f.store, "test/repo", cfg.githubMerge);
  const snapshot = acceptanceRunRequest({
    ticket: { number: 9, body: options.ticket ?? ticket, author: { login: "owner" } },
    parent: { number: 1, body: options.parent ?? parent, author: { login: "owner" } },
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
    requests,
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
  expect(t.requests).toHaveLength(1);
  expect(t.requests[0]).toMatchObject({
    headSha: t.sha,
    gates: { checks: [{ name: "test", timeoutSec: 37 }] },
  });
  expect(t.requests[0]?.gates.checks).toHaveLength(1);
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

test.each([
  ["stale", "JUnit report missing, stale or unsafe"],
  ["unsafe", "JUnit report missing, stale or unsafe"],
  ["malformed", "unparseable JUnit report"],
  ["no-match", "name matched no tests"],
] as const)(
  "%s JUnit evidence cannot satisfy acceptance despite successful execution",
  async (junit, reason) => {
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
      coveringTest: { file: "x.test.ts", name: "passes", reason },
    });
    expect(t.outcome().units).toEqual([
      {
        unit: "U1",
        verdict: "unmet",
        citations: [],
        refusals: [`x.test.ts › passes: ${reason}`],
        note: "",
      },
    ]);
    expect(t.targeted).toHaveLength(1);
    await t.published();
  },
);

test.each(["bun-missing", "exit126", "spawn", "missing", "empty", "whitespace"] as const)(
  "a %s runner refusal is persisted for grouped identities before restart",
  async (junit) => {
    const t = await setup({
      junit,
      files: { "y.test.ts": 'import { test } from "bun:test"; test("independent", () => {});' },
    });
    const value = AcceptanceSchema.parse(metAll);
    const [first, second] = value.items;
    if (!first || !second) throw new Error("missing units");
    first.tests.push({ file: "x.test.ts", name: "also passes" });
    second.tests = [{ file: "y.test.ts", name: "independent" }];
    t.reply(() => ({ structured: value }));
    t.f.deps.checkpointer = {
      ...localCheckpointer(t.f.store),
      checkpoint(_runId, label) {
        if (label === (junit === "spawn" ? "covering-test-recorded" : "gate-result"))
          throw new SimulatedTermination("saved unavailable covering execution");
      },
    };
    expect(await t.execute()).toBe("running");
    const saved = t.state()?.coveringTestRuns?.filter((r) => r.file === "x.test.ts") ?? [];
    expect(saved).toHaveLength(2);
    const reason =
      junit === "spawn"
        ? saved[0]?.reason
        : junit === "empty" || junit === "whitespace"
          ? "JUnit report empty"
          : "JUnit report missing";
    expect(reason).toBeTruthy();
    for (const record of saved) {
      expect(record).toMatchObject({ unavailable: true, reason });
      if (junit !== "spawn")
        expect(record.result?.exitCode).toBe(junit === "bun-missing" ? 127 : junit === "exit126" ? 126 : 0);
    }
    expect(t.state()?.gateExecution).toBeUndefined();
    t.f.deps.checkpointer = undefined;
    expect(await t.execute()).toBe("needs_human");
    expect(t.targeted).toHaveLength(2);
    expect(t.calls()).toBe(1);
    expect(t.outcome()).toMatchObject({
      passed: false,
      summary: "2 met, 1 not assessed",
      units: [
        {
          verdict: "not_assessed",
          citations: [],
          refusals: [`x.test.ts › passes: ${reason}`, `x.test.ts › also passes: ${reason}`],
        },
        { verdict: "met" },
        { verdict: "met" },
      ],
    });
    expect(JSON.parse(t.f.store.getArtifact(t.run.id, "acceptance.json") ?? "null")).toEqual(t.outcome());
    expect(t.f.store.getArtifact(t.run.id, "report.md")).toContain(`x.test.ts › passes: ${reason}`);
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
  expect(t.targeted).toHaveLength(1);
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
    const t = await setup({
      files: { "y.test.ts": 'import { test } from "bun:test"; test("pending", () => {});' },
    });
    const restartOutput = AcceptanceSchema.parse(metAll);
    const third = restartOutput.items[2];
    if (!third) throw new Error("missing unit");
    third.tests = [{ file: "y.test.ts", name: "pending" }];
    const shutdown = new AbortController();
    t.reply(() => ({ structured: restartOutput }));
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
    if (boundary !== "manifest") expect(before?.acceptance?.output).toEqual(restartOutput);
    if (boundary === "output") {
      expect(t.calls()).toBe(1);
      expect(t.targeted).toHaveLength(0);
      expect(before?.coveringTestRuns).toBeUndefined();
    }
    if (boundary === "covering-test") {
      expect(before?.coveringTestRuns?.slice(0, 2).every((r) => !!r.result)).toBe(true);
      expect(before?.coveringTestRuns?.[2]?.result).toBeUndefined();
    }
    const ran = t.targeted.length;
    t.f.deps.faults = undefined;
    t.f.deps.checkpointer = undefined;
    expect(await t.execute()).toBe("succeeded");
    const after = t.state();
    expect(t.calls()).toBe(1);
    expect(after?.coveringTestRuns?.map((r) => r.name)).toEqual(["passes", "also passes", "pending"]);
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

test("two Bun checks refuse assessment without counting an unmet unit", async () => {
  const t = await setup({
    checks: [
      { name: "test", run: "bun test" },
      { name: "other", run: "bun test ./other.test.ts" },
    ],
  });
  t.reply(() => ({ structured: metAll }));
  expect(await t.execute()).toBe("needs_human");
  expect(t.targeted).toEqual([]);
  expect(t.outcome()).toMatchObject({
    passed: false,
    summary: "1 met, 2 not assessed",
    units: [
      { verdict: "not_assessed", refusals: ["x.test.ts › passes: targeted retries not configured"] },
      { verdict: "not_assessed" },
      { verdict: "met" },
    ],
  });
  expect(JSON.parse(t.f.store.getArtifact(t.run.id, "acceptance.json") ?? "null")).toEqual(t.outcome());
  expect(t.f.store.getArtifact(t.run.id, "report.md")).toContain(
    "not_assessed (x.test.ts › passes: targeted retries not configured)",
  );
});

test("acceptance runs all 36 identities once per shared file and reuses duplicate citations", async () => {
  const files = Object.fromEntries(
    ["x", "y", "z"].map((f) => [
      `${f}.test.ts`,
      'import { test } from "bun:test";\n' +
        Array.from({ length: 12 }, (_, i) => `test("case ${i}", () => {});`).join("\n"),
    ]),
  );
  const t = await setup({
    files,
    parent: `## Goal\n${Array.from({ length: 13 }, (_, i) => `- Unit ${i}.`).join("\n")}`,
    ticket: `## The original intent\n#1's "Goal" section`,
  });
  const items = Array.from({ length: 13 }, (_, i) => ({
    unit: `U${i + 1}`,
    verdict: "met",
    files: [],
    note: "",
    tests: ["x", "y", "z"].map((f) => ({ file: `${f}.test.ts`, name: `case ${i % 12}` })),
  }));
  t.reply(() => ({ structured: { items } }));
  expect(await t.execute()).toBe("succeeded");
  expect(t.outcome().summary).toBe("13 met");
  expect(t.targeted).toHaveLength(3);
  const records = t.state()?.coveringTestRuns ?? [];
  expect(records).toHaveLength(36);
  expect(
    records.every(
      (r) => r.result?.coveringTest?.reason === undefined && r.result?.coveringTest?.name === r.name,
    ),
  ).toBe(true);
  expect(
    t
      .outcome()
      .units.every(
        (u) => u.citations.length === 3 && u.citations.every((c) => c.startsWith("Factory covering test")),
      ),
  ).toBe(true);
  expect(t.outcome().units[12]?.citations).toEqual(t.outcome().units[0]?.citations);
});

test.each(["runner", "slot", "inplace attachment", "inplace before enqueue", "LAN slot"] as const)(
  "a pre-start %s refusal leaves independent files assessable",
  async (mode) => {
    const t = await setup({
      files: { "y.test.ts": 'import { test } from "bun:test"; test("independent", () => {});' },
    });
    const value = AcceptanceSchema.parse(metAll);
    const second = value.items[1];
    if (!second) throw new Error("missing unit");
    second.tests = [{ file: "y.test.ts", name: "independent" }];
    t.reply(() => ({ structured: value }));
    const executor = t.f.deps.gateExecutor;
    if (!executor) throw new Error("missing executor");
    const reason = `${mode} unavailable before start`;
    if (mode === "runner") {
      const start = executor.start.bind(executor);
      executor.start = async (request, signal) => {
        if (request.gates.checks[0]?.coveringTest?.file === "x.test.ts") throw new Error(reason);
        return start(request, signal);
      };
    } else if (mode === "slot") {
      const attach = executor.attach.bind(executor);
      executor.attach = (handle, signal, request, hooks, persist) => {
        if (request?.gates.checks[0]?.coveringTest?.file === "x.test.ts")
          return {
            result: Promise.reject(new Error(reason)),
            events: { async *[Symbol.asyncIterator]() {} },
            cancel: async () => {},
          };
        return attach(handle, signal, request, hooks, persist);
      };
    } else {
      const workers = new WorkerStore(t.f.store, t.f.deps.buildSha);
      const inplace = mode !== "LAN slot";
      workers.executor = () => ({ id: "executor", pid: process.pid, birth: "1", release_sha: "test-build" });
      const remote = lanExecutor(workers, ["test/repo"], inplace);
      t.f.deps.gateExecutor = {
        ...remote,
        async start(request, signal) {
          if (request.gates.checks[0]?.coveringTest?.file !== "x.test.ts")
            return executor.start(request, signal);
          if (mode === "inplace before enqueue") return remote.start(request, signal);
          return {
            kind: remote.kind,
            id: workers.enqueue(request, undefined, inplace),
            startedAt: Date.now(),
          };
        },
        attach(handle, signal, request, hooks, persist) {
          if (handle.kind === "local") return executor.attach(handle, signal, request, hooks, persist);
          if (inplace) throw new Error(reason);
          return {
            result: Promise.reject(new Error(reason)),
            events: { async *[Symbol.asyncIterator]() {} },
            cancel: async () => {},
          };
        },
      };
    }
    expect(await t.execute()).toBe("needs_human");
    expect(t.outcome()).toMatchObject({
      passed: false,
      summary: "2 met, 1 not assessed",
      units: [
        { verdict: "not_assessed", refusals: [`x.test.ts › passes: ${reason}`] },
        { verdict: "met" },
        { verdict: "met" },
      ],
    });
    expect(JSON.parse(t.f.store.getArtifact(t.run.id, "acceptance.json") ?? "null")).toEqual(t.outcome());
    expect(t.f.store.getArtifact(t.run.id, "report.md")).toContain(
      `not_assessed (x.test.ts › passes: ${reason})`,
    );
    if (mode === "inplace attachment" || mode === "LAN slot")
      expect(new WorkerStore(t.f.store, t.f.deps.buildSha).jobs("1=1")).toMatchObject([
        { state: "cancelled", attempt: 1, worker: null },
      ]);
    if (mode === "inplace before enqueue")
      expect(new WorkerStore(t.f.store, t.f.deps.buildSha).jobs("1=1")).toEqual([]);
  },
);

test.each(["leased", "retried", "missing", "resumed"] as const)(
  "a remote failure with %s execution state is not a confirmed pre-start refusal",
  async (state) => {
    const t = await setup();
    t.reply(() => ({ structured: metAll }));
    const workers = new WorkerStore(t.f.store, t.f.deps.buildSha);
    const remote = lanExecutor(workers, ["test/repo"]);
    t.f.deps.gateExecutor = {
      ...remote,
      async start(request) {
        const id = workers.enqueue(request);
        if (state === "leased" || state === "resumed")
          t.f.store.db.query("UPDATE gate_jobs SET state='leased',worker='runner' WHERE id=?").run(id);
        else if (state === "retried") workers.fail(id, "previous attempt unknown");
        else t.f.store.db.query("DELETE FROM gate_jobs WHERE id=?").run(id);
        return { kind: "lan", id, startedAt: Date.now() };
      },
      attach() {
        return {
          result: Promise.reject(new Error("execution state unknown")),
          events: { async *[Symbol.asyncIterator]() {} },
          cancel: async () => {},
        };
      },
    };
    if (state === "resumed") {
      t.f.deps.checkpointer = {
        ...localCheckpointer(t.f.store),
        checkpoint(_runId, label) {
          if (label === "gate-started") throw new SimulatedTermination("saved unknown remote job");
        },
      };
      expect(await t.execute()).toBe("running");
      t.f.deps.checkpointer = undefined;
      t.f.deps.gateExecutor = localExecutor();
    }
    expect(await t.execute()).toBe("failed");
    expect(t.state()?.acceptance?.outcome).toBeUndefined();
    expect(t.state()?.coveringTestRuns?.some((r) => r.unavailable)).toBe(false);
    expect(t.f.store.getRun(t.run.id)?.error).toContain(
      state === "resumed" ? "Unavailable gate executor: lan" : "execution state unknown",
    );
  },
);

test.each(["sha", "dirty"] as const)("grouped evidence refuses %s provenance", async (mode) => {
  const t = await setup();
  t.reply(() => ({ structured: metAll }));
  const checkpoint = localCheckpointer(t.f.store);
  t.f.deps.checkpointer = {
    ...checkpoint,
    checkpoint(runId, label) {
      if (label === "covering-test-recorded") {
        const state = t.f.store.getRunState<RunState>(runId);
        for (const r of state?.coveringTestRuns ?? []) {
          if (r.result?.executionProvenance)
            Object.assign(
              r.result.executionProvenance,
              mode === "sha" ? { sha: "b".repeat(40) } : { trackedClean: false },
            );
        }
        if (state) t.f.store.setRunState(runId, state);
        throw new SimulatedTermination("saved rejected provenance");
      }
    },
  };
  expect(await t.execute()).toBe("running");
  t.f.deps.checkpointer = undefined;
  expect(await t.execute()).toBe("needs_human");
  expect(t.outcome().summary).toBe("1 met, 2 unmet");
  expect(t.outcome().units[0]?.refusals[0]).toContain(
    mode === "sha" ? "different SHA" : "changed tracked files",
  );
  expect(t.targeted).toHaveLength(1);
});

test("a per-unit cap is unavailable, but rejected evidence takes precedence", async () => {
  const t = await setup();
  t.reply(() => ({
    structured: output([
      { unit: "U1", verdict: "met", tests: ["passes", "also passes", "passes", "also passes"] },
      { unit: "U2", verdict: "met", tests: ["passes", "fails", "passes", "also passes"] },
      { unit: "U3", verdict: "met", files: [{ path: "README.md" }] },
    ]),
  }));
  expect(await t.execute()).toBe("needs_human");
  expect(t.outcome().summary).toBe("1 met, 1 unmet, 1 not assessed");
  expect(t.outcome().units[0]).toMatchObject({
    verdict: "not_assessed",
    refusals: ["x.test.ts › also passes: per-criterion limit reached"],
  });
  expect(t.outcome().units[1]?.refusals).toContain("x.test.ts › fails: test failed");
});

test.each([
  ["targeted retries not configured", undefined, "not_assessed"],
  ["per-criterion limit reached", undefined, "not_assessed"],
  ["per-round limit reached", undefined, "not_assessed"],
  ["covering tests do not support an option terminator (--) in retry_files", undefined, "not_assessed"],
  ["expanded command is not a single bun test invocation", undefined, "not_assessed"],
  ["targeted retries not configured", false, "unmet"],
  ["unknown refusal: targeted retries not configured", undefined, "unmet"],
  ["custom infrastructure refusal", true, "not_assessed"],
] as const)("saved refusal %s with unavailable=%s resumes as %s", async (reason, unavailable, verdict) => {
  const t = await setup();
  t.reply(() => ({ structured: metAll }));
  t.f.deps.checkpointer = {
    ...localCheckpointer(t.f.store),
    checkpoint(runId, label) {
      if (label !== "acceptance-output") return;
      const state = t.state();
      if (!state) throw new Error("missing state");
      state.coveringTestRuns = ["passes", "also passes"].map((name) => ({
        file: "x.test.ts",
        name,
        verifiedSha: t.sha,
        stageId: 0,
        round: state.round,
        reason,
        ...(unavailable === undefined ? {} : { unavailable }),
      }));
      t.f.store.setRunState(runId, state);
      throw new SimulatedTermination("saved legacy covering refusals");
    },
  };
  expect(await t.execute()).toBe("running");
  t.f.deps.checkpointer = undefined;
  expect(await t.execute()).toBe("needs_human");
  expect(t.targeted).toHaveLength(0);
  expect(t.calls()).toBe(1);
  expect(t.outcome()).toMatchObject({
    passed: false,
    units: [
      { verdict, citations: [], refusals: [`x.test.ts › passes: ${reason}`] },
      { verdict, citations: [], refusals: [`x.test.ts › also passes: ${reason}`] },
      { verdict: "met" },
    ],
  });
  expect(t.f.store.getArtifact(t.run.id, "report.md")).toContain(
    `${verdict} (x.test.ts › passes: ${reason})`,
  );
});

test("failed evidence wins over a missing report in another file", async () => {
  const t = await setup({
    junit: "missing",
    files: {
      "y.test.ts": 'import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));',
    },
  });
  const value = AcceptanceSchema.parse(metAll);
  const first = value.items[0];
  if (!first) throw new Error("missing unit");
  first.tests.push({ file: "y.test.ts", name: "fails" });
  t.reply(() => ({ structured: value }));
  expect(await t.execute()).toBe("needs_human");
  expect(t.outcome()).toMatchObject({
    passed: false,
    units: [
      {
        verdict: "unmet",
        citations: [],
        refusals: ["x.test.ts › passes: JUnit report missing", "y.test.ts › fails: test failed"],
      },
      { verdict: "not_assessed" },
      { verdict: "met" },
    ],
  });
});
