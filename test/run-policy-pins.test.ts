import { expect, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { repoSettings } from "../src/config.ts";
import { exportPolicySelection, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { IssueClaimed, Store } from "../src/db/store.ts";
import { ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimScope } from "../src/integrations/claim-guard.ts";
import { initialRunState, localCheckpointer, RunContext, type RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import type { RunClaim } from "../src/pipeline/run-claim.ts";
import {
  admissionPolicy,
  ensureAdmissionPin,
  type PinStep,
  pinPolicy,
} from "../src/pipeline/run-policy-pins.ts";
import { captureRunTransferSnapshot } from "../src/pipeline/run-transfer-snapshot.ts";
import { registerCredential } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";
import { seal } from "./run-transfer-policy-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, registerGithub, githubFixture, advanceBase } = pipelineSetup({
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
const signal = () => new AbortController().signal;
async function fixture(
  shared = true,
  mode: "single" | "panel" = "single",
  shadow: "off" | "panel" = "off",
  merge = false,
  legacy = false,
  config?: string,
) {
  const bare = await githubFixture();
  if (merge) {
    await advanceBase(
      bare,
      ".limitless.toml",
      '[gates]\nchecks = [{ name = "smoke", run = "bun run smoke" }]\n',
    );
    await advanceBase(bare, "package.json", JSON.stringify({ scripts: { smoke: "echo original" } }));
  }
  let advance = merge;
  if (config !== undefined) {
    mkdirSync(join(home, "cfg"), { recursive: true });
    writeFileSync(join(home, "cfg", "config.toml"), config);
  }
  const f = start(async (s) => {
    if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (roleOf(s) === "review") {
      if (advance) {
        advance = false;
        await advanceBase(bare, "package.json", JSON.stringify({ scripts: { smoke: "echo refreshed" } }));
      }
      return { structured: approve };
    }
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  await f.stop();
  registerGithub(f, bare);
  f.cfg.repos = {
    "test/repo": { shared, discreet: false, branchPrefix: "change/", landRequiresApproval: false },
  };
  f.cfg.reviewMode = mode;
  f.cfg.reviewShadow = shadow;
  f.cfg.reviewRosters.quick = [{ prompt: "standard" }];
  const repo = f.store.getRepoBySlug("test/repo");
  if (!repo) throw new Error("missing repository");
  const req = { repo: repo.slug, prompt: "Add farewell", profile: "quick" as const };
  const run = legacy ? f.store.createRun(repo, req) : await f.createRun(req);
  const binding = bindClaim(
    { windowOpen: () => true },
    {
      repo: run.repoSlug,
      ref: `refs/limitless/claims/run-${run.id}`,
      run: run.id,
      member: "m",
      generation: 1,
    },
    () => false,
  );
  const claim = { binding, leases: { update: mock<RunClaim["leases"]["update"]>(async () => "applied") } };
  const deps = { ...f.deps, runClaim: shared ? claim : undefined };
  return { f, run, deps, repo, bare };
}
function capture(store: Store, runId: string) {
  return captureRunTransferSnapshot(store, runId, ({ run, state }) => ({
    manifest: {
      schema: 2,
      runId: run.id,
      key: { kind: "run", repo: run.repoSlug, runId: run.id },
      generation: 1,
      sequence: 1,
      previous: null,
      baseSha: run.baseSha,
      headSha: run.headSha,
      phase: state.phase,
      round: state.round,
      createdBy: "offline",
      effects: [],
      blobs: { state: { key: "a".repeat(32), digest: "c".repeat(64), size: 10 }, artifacts: [], objects: [] },
    },
  }));
}

test("policy transitions require an open claim before writing", async () => {
  const { f, run, deps } = await fixture();
  const state: RunState = {
    ...initialRunState(run),
    gatesConfig: { setup: [], checks: [], source: "none", protectedPaths: [] },
  };
  const step: PinStep = { kind: "prepared", trustedBase: "a".repeat(40) };
  let open = false;
  if (!deps.runClaim) throw new Error("missing claim");
  const binding = bindClaim({ windowOpen: () => open }, deps.runClaim.binding.handle, () => false);
  const before = f.store.getRunState<RunState>(run.id);
  claimScope.run([binding], () => {
    expect(() => pinPolicy(f.store, run.id, state, step)).toThrow(new ClaimWaitError("lease"));
    expect(f.store.getRunState<RunState>(run.id)).toEqual(before);
    expect(exportPolicySelection(f.store, run.id).history.map((v) => v.kind)).toEqual(["provisional"]);
    open = true;
    expect(pinPolicy(f.store, run.id, state, step).version).toBe(2);
  });
  expect(exportPolicySelection(f.store, run.id).history.map((v) => v.kind)).toEqual([
    "provisional",
    "prepared",
  ]);
});

test.each(["single", "panel"] as const)("every shared save exports in %s mode", async (mode) => {
  const { f, run, deps } = await fixture(true, mode, "off", true);
  const saves: (string | undefined)[] = [];
  deps.checkpointer = {
    ...localCheckpointer(f.store),
    checkpoint: (_id, label) => {
      capture(f.store, run.id);
      saves.push(label);
    },
  };
  const status = await executeRun(deps, run.id, signal());
  expect(f.store.getRun(run.id)?.error).toBeNull();
  expect(status).toBe("succeeded");
  expect(saves).toContain("delivery-complete");
  expect(f.store.getRunState<RunState>(run.id)?.reviewMode).toBe(mode);
  expect(exportPolicySelection(f.store, run.id).history.map((v) => v.kind)).toEqual([
    "provisional",
    "prepared",
    "review-finalized",
    "scripts-refreshed",
  ]);
});

test.each(["prepared", "review-finalized", "scripts-refreshed"] as const)(
  "%s survives a fault at its following save and reopening",
  async (kind) => {
    const { f, run, deps, bare } = await fixture(true, "single", "off", true);
    deps.faults = {
      "store:save": {
        action: "kill",
        when: () => exportPolicySelection(f.store, run.id).history.at(-1)?.kind === kind,
      },
    };
    expect(await executeRun(deps, run.id, signal())).toBe("running");
    const recorded = exportPolicySelection(f.store, run.id).history.at(-1);
    if (!recorded || recorded.kind === "provisional") throw new Error("missing transition");
    const reopened = new Store(f.cfg.paths.db);
    try {
      const state = reopened.getRunState<RunState>(run.id);
      if (!state) throw new Error("missing state");
      const step: PinStep =
        kind === "prepared"
          ? { kind, trustedBase: recorded.trustedBase }
          : kind === "review-finalized"
            ? { kind, mode: "single" }
            : { kind, scriptSource: recorded.scriptSource };
      expect(pinPolicy(reopened, run.id, state, step)).toEqual({
        version: recorded.version,
        digest: recorded.recordId,
      });
      if (kind === "scripts-refreshed")
        await advanceBase(bare, "package.json", JSON.stringify({ scripts: { smoke: "echo second" } }));
      expect(await executeRun({ ...deps, store: reopened, faults: undefined }, run.id, signal())).toBe(
        "succeeded",
      );
      const history = exportPolicySelection(reopened, run.id).history;
      expect(history.filter((v) => v.kind === "prepared").map((v) => v.version)).toEqual([2]);
      expect(history.filter((v) => v.kind === "review-finalized")).toHaveLength(1);
      expect(history.filter((v) => v.kind === "scripts-refreshed")).toHaveLength(
        kind === "scripts-refreshed" ? 2 : 1,
      );
      const refreshed = history.filter((v) => v.kind === "scripts-refreshed");
      expect(new Set(refreshed.map((v) => v.scriptSource)).size).toBe(refreshed.length);
      expect(pinPolicy(reopened, run.id, state, step)).toEqual({
        version: recorded.version,
        digest: recorded.recordId,
      });
      expect(exportPolicySelection(reopened, run.id).history).toEqual(history);
    } finally {
      reopened.close();
    }
  },
);

test.each(["maxRounds", "reviewRosters", "branchPrefix", "repository", "shared"] as const)(
  "live %s drift blocks the next stage without a stage row",
  async (field) => {
    const { f, run, deps, repo } = await fixture();
    deps.faults = {
      "stage:prepare:after": {
        action: "continue",
        onHit: () => {
          if (field === "maxRounds") deps.cfg = { ...deps.cfg, maxRounds: deps.cfg.maxRounds + 1 };
          else if (field === "reviewRosters")
            deps.cfg = {
              ...deps.cfg,
              reviewRosters: { ...deps.cfg.reviewRosters, quick: [{ prompt: "careful" }] },
            };
          else if (field === "repository") f.store.upsertRepo({ ...repo, mergePolicy: "none" });
          else
            deps.cfg = {
              ...deps.cfg,
              repos: {
                "test/repo": {
                  discreet: false,
                  shared: field !== "shared",
                  branchPrefix: field === "shared" ? "change/" : "other/",
                  landRequiresApproval: false,
                },
              },
            };
        },
      },
    };
    expect(await executeRun(deps, run.id, signal())).toBe("needs_human");
    expect(f.store.getRun(run.id)?.error).toBe("shared run policy changed");
    expect(f.store.listStages(run.id).map((v) => v.name)).toEqual(["prepare"]);
  },
);

test.each(["resume", "stage"] as const)(
  "shadow downgrade waits at %s and restoration resumes",
  async (boundary) => {
    const { f, run, deps } = await fixture(true, "single", "panel");
    const original = deps.cfg;
    if (boundary === "resume") deps.cfg = { ...original, reviewShadow: "off" };
    else
      deps.faults = {
        "stage:prepare:after": {
          action: "continue",
          onHit: () => {
            deps.cfg = { ...original, reviewShadow: "off" };
          },
        },
      };
    expect(await executeRun(deps, run.id, signal())).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:policy");
    expect(f.store.listStages(run.id)).toHaveLength(boundary === "resume" ? 0 : 1);
    if (boundary === "resume") expect(f.store.getRun(run.id)?.startedAt).toBeNull();
    deps.cfg = original;
    deps.faults = undefined;
    expect(await executeRun(deps, run.id, signal())).toBe("succeeded");
  },
);

test.each([false, true])(
  "pinned shared restart refuses shared disabled with authority=%s",
  async (authority) => {
    const { f, run, deps } = await fixture();
    expect(
      await executeRun({ ...deps, faults: { "stage:prepare:after": { action: "kill" } } }, run.id, signal()),
    ).toBe("running");
    expect(f.store.getRun(run.id)?.startedAt).not.toBeNull();
    const stages = f.store.listStages(run.id);
    const calls = f.store.listInvocations(run.id);
    const reopened = new Store(f.cfg.paths.db);
    try {
      const cfg = {
        ...deps.cfg,
        repos: { "test/repo": { ...repoSettings(deps.cfg, "test/repo"), shared: false } },
      };
      expect(
        await executeRun(
          { ...deps, cfg, store: reopened, runClaim: authority ? deps.runClaim : undefined },
          run.id,
          signal(),
        ),
      ).toBe("needs_human");
      expect(reopened.getRun(run.id)?.error).toBe("shared run policy changed");
      expect(reopened.listStages(run.id)).toEqual(stages);
      expect(reopened.listInvocations(run.id)).toEqual(calls);
    } finally {
      reopened.close();
    }
  },
);

const reloadText = (samples: 1 | 2, workers = "", limits = "", review = "") =>
  `[review]\nsamples = ${samples}\n${review}\n[review.rosters]\nquick = [{ prompt = "standard" }]\n[workers]\n${workers}\n[limits]\n${limits}\n`;

function reload(f: Factory, text: string) {
  writeFileSync(join(f.cfg.paths.configDir, "config.toml"), text);
  return f.reloadConfig();
}

for (const before of [1, 2] as const) {
  test.each(["stage", "resume"] as const)(`reviewSamples ${before} reload blocks at %s`, async (boundary) => {
    const { f, run, deps } = await fixture(true, "single", "off", false, false, reloadText(before));
    expect(exportPolicySelection(f.store, run.id).history[0]?.engine.reviewSamples).toBe(before);
    const change = () => {
      expect(reload(f, reloadText(before === 1 ? 2 : 1)).applied).toContain("review.samples");
      deps.cfg = f.deps.cfg;
    };
    deps.faults = {
      "stage:prepare:after": {
        action: boundary === "resume" ? "kill" : "continue",
        onHit: boundary === "stage" ? change : undefined,
      },
    };
    if (boundary === "resume") {
      expect(await executeRun(deps, run.id, signal())).toBe("running");
      change();
      deps.faults = undefined;
    }
    expect(await executeRun(deps, run.id, signal())).toBe("needs_human");
    expect(f.store.getRun(run.id)?.error).toBe("shared run policy changed");
    expect(f.store.listStages(run.id).map((stage) => stage.name)).toEqual(["prepare"]);
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
  });
}

test.each([
  { name: "worker roles", workers: 'agents = ["review"]', limits: "", drift: true },
  { name: "worker eligibility", workers: 'repos = ["test/repo"]', limits: "", drift: true },
  { name: "unrelated worker repos", workers: 'repos = ["other/repo"]', limits: "", drift: false },
  {
    name: "concurrency",
    workers: "",
    limits: "max_concurrent_runs = 3\nmax_concurrent_gates = 2",
    drift: false,
  },
])("reload $name has drift=$drift", async ({ workers, limits, drift }) => {
  const { f, run, deps } = await fixture(true, "single", "off", false, false, reloadText(1));
  expect(exportPolicySelection(f.store, run.id).history[0]?.engine.workers).toEqual({
    agents: [],
    repoEligible: false,
  });
  deps.faults = {
    "stage:prepare:after": {
      action: "continue",
      onHit: () => {
        expect(reload(f, reloadText(1, workers, limits)).applied.length).toBeGreaterThan(0);
        deps.cfg = f.deps.cfg;
      },
    },
  };
  expect(await executeRun(deps, run.id, signal())).toBe(drift ? "needs_human" : "succeeded");
  if (drift) {
    expect(f.store.getRun(run.id)?.error).toBe("shared run policy changed");
    expect(f.store.listStages(run.id).map((stage) => stage.name)).toEqual(["prepare"]);
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
  }
});

test("shadow downgrade with definite drift refuses instead of waiting", async () => {
  const { f, run, deps } = await fixture(true, "single", "panel");
  deps.cfg = { ...deps.cfg, reviewShadow: "off", reviewSamples: 2 };
  expect(await executeRun(deps, run.id, signal())).toBe("needs_human");
  expect(f.store.getRun(run.id)?.error).toBe("shared run policy changed");
  expect(f.store.listStages(run.id)).toHaveLength(0);
});

test.each(["reviewSamples", "workers"] as const)(
  "historical pin missing %s remains immutable but cannot execute",
  async (field) => {
    const { f, run, repo, deps } = await fixture(true, "single", "off", false, true);
    const historical = admissionPolicy(f.cfg, repo, {}, run.id);
    delete historical.engine[field];
    const record = seal(historical);
    recordProvisionalPolicy(f.store, {
      runId: run.id,
      record,
      expected: null,
      expectedState: null,
      state: initialRunState(run),
    });
    f.store.updateRun(run.id, { startedAt: 1 });
    const selection = exportPolicySelection(f.store, run.id);
    expect(selection.history).toEqual([record]);
    expect(await executeRun(deps, run.id, signal())).toBe("needs_human");
    expect(f.store.getRun(run.id)?.error).toBe("shared run policy changed");
    expect(f.store.listStages(run.id)).toHaveLength(0);
    expect(exportPolicySelection(f.store, run.id)).toEqual(selection);
  },
);

test("an admission pin still requires authority when shared remains enabled", async () => {
  const { f, run, deps } = await fixture();
  const selection = exportPolicySelection(f.store, run.id);
  expect(await executeRun({ ...deps, runClaim: undefined }, run.id, signal())).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:unavailable");
  expect(f.store.getRun(run.id)?.startedAt).toBeNull();
  expect(f.store.listStages(run.id)).toHaveLength(0);
  expect(exportPolicySelection(f.store, run.id)).toEqual(selection);
});

test("admission allowlists policy and rolls back a credential-bearing request", async () => {
  const { f, repo, run } = await fixture();
  f.cfg.raw.privateCanary = "raw-canary";
  f.cfg.raw.providers = [{ id: "provider-canary", endpoint: "endpoint-canary" }];
  f.cfg.secrets.privateCanary = "secrets-canary";
  f.cfg.workers = { ...f.cfg.workers, listen: "listener-canary", repos: ["unrelated/repo-canary"] };
  f.deps.cfg = { ...f.cfg, reviewShadow: "off" };
  f.cfg.reviewShadow = "panel";
  const next = await f.createRun({ repo: repo.slug, prompt: "Canaries", profile: "quick" });
  const record = exportPolicySelection(f.store, next.id).history[0];
  expect(record?.engine.reviewShadow).toBe("panel");
  expect(Object.keys(record?.engine ?? {}).sort()).toEqual([
    "dependabotRouting",
    "maxRounds",
    "reviewAvoidImplementerVendor",
    "reviewImplementerReport",
    "reviewMode",
    "reviewRosters",
    "reviewSamples",
    "reviewShadow",
    "reviewShadowGraceSeconds",
    "reviewTrustedReviewers",
    "triageDecisionConfidence",
    "waitBudgetS",
    "workers",
  ]);
  const json = f.store.db
    .query<{ record_json: string }, []>("SELECT record_json FROM run_policy_versions")
    .all();
  for (const canary of [
    "raw-canary",
    "provider-canary",
    "endpoint-canary",
    "secrets-canary",
    "listener-canary",
    "unrelated/repo-canary",
  ])
    expect(JSON.stringify(json)).not.toContain(canary);
  expect(admissionPolicy(f.cfg, repo, {}, run.id)).toEqual(admissionPolicy(f.cfg, repo, {}, run.id));
  const credential = "policy-test-credential-value";
  registerCredential("TEST_RUN_POLICY_PINS", credential);
  f.cfg.repos = {
    [repo.slug]: {
      shared: true,
      discreet: false,
      branchPrefix: `change/${credential}/`,
      landRequiresApproval: false,
    },
  };
  await expect(f.createRun({ repo: repo.slug, prompt: "Refused" })).rejects.toThrow();
  expect(f.store.listRuns()).toHaveLength(2);
  expect(
    f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_policy_selections").get()?.n,
  ).toBe(2);
});

test("shared admission keeps the refusal record of an existing issue claim", async () => {
  const { f, repo } = await fixture();
  const req = {
    repo: repo.slug,
    prompt: "Work",
    sourceRef: { kind: "issue" as const, repo: repo.slug, number: 12 },
  };
  const claimed = await f.createRun(req);
  const comment = { repo: repo.slug, id: 42 };
  await expect(f.createRun(req, false, undefined, true, undefined, comment)).rejects.toBeInstanceOf(
    IssueClaimed,
  );
  expect(f.store.githubCommentProcessed(comment)).toBe(true);
  expect(f.store.listRuns().filter((r) => r.repoSlug === repo.slug)).toHaveLength(2);
  expect(exportPolicySelection(f.store, claimed.id).version).toBe(1);
});

test("chat admission pins atomically with proposal consumption", async () => {
  const { f, repo } = await fixture();
  const fields = { repo: repo.slug, prompt: "Chat request", profile: "quick" as const, title: "Chat" };
  const proposal = f.store.proposeChat("conversation", fields, { source: "chat", requestedBy: "ui" });
  f.store.confirmChat("conversation", proposal.id);
  const chat = { conversationId: "conversation", proposalId: proposal.id };
  const original = f.cfg.repos;
  const credential = "chat-policy-credential-value";
  registerCredential("TEST_CHAT_POLICY_PINS", credential);
  f.cfg.repos = {
    [repo.slug]: { shared: true, discreet: false, branchPrefix: credential, landRequiresApproval: false },
  };
  await expect(f.createRun(fields, false, chat)).rejects.toThrow();
  expect(f.store.listRuns()).toHaveLength(1);
  expect(f.store.listChatProposals("conversation")[0]?.state).toBe("confirmed");
  f.cfg.repos = original;
  const run = await f.createRun(fields, false, chat);
  expect(exportPolicySelection(f.store, run.id).version).toBe(1);
  expect((await f.createRun(fields, false, chat)).id).toBe(run.id);
  expect(f.store.listChatProposals("conversation")[0]?.state).toBe("consumed");
});

test.each([false, true])("missing admission pin with started=%s", async (started) => {
  const { f, run, repo, deps } = await fixture(true, "single", "off", false, true);
  const current = started ? f.store.updateRun(run.id, { startedAt: 1 }) : run;
  if (started) {
    expect(await executeRun(deps, run.id, signal())).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:unavailable");
    expect(ensureAdmissionPin(f.store, f.cfg, current, repo)).toBeNull();
    expect(f.store.db.query("SELECT * FROM run_policy_versions WHERE run_id = ?").all(run.id)).toHaveLength(
      0,
    );
  } else {
    deps.faults = { "stage:prepare:before": { action: "kill" } };
    expect(await executeRun(deps, run.id, signal())).toBe("running");
    expect(exportPolicySelection(f.store, run.id).history.map((v) => v.kind)).toEqual(["provisional"]);
    expect(await executeRun({ ...deps, faults: undefined }, run.id, signal())).toBe("succeeded");
  }
});

test("local run writes no policy rows and retains synchronous saves", async () => {
  const { f, run, repo, deps } = await fixture(false);
  const policies = await import("../src/pipeline/run-policy-pins.ts");
  const drift = spyOn(policies, "requirePinnedPolicy");
  const pin = spyOn(policies, "pinPolicy");
  try {
    expect(await executeRun(deps, run.id, signal())).toBe("succeeded");
    expect(drift).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(f.store.db.query("SELECT * FROM run_policy_versions").all()).toHaveLength(0);
    expect(f.store.db.query("SELECT * FROM run_policy_selections").all()).toHaveLength(0);
    const ctx = new RunContext(deps, run, repo, signal());
    ctx.state = initialRunState(run);
    const saved = ctx.save();
    expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("prepare");
    await saved;
  } finally {
    drift.mockRestore();
    pin.mockRestore();
  }
});
