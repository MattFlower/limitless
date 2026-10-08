import { describe, expect, spyOn, test } from "bun:test";
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
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import { observerRoots } from "../src/harness/sandbox.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { invokeGuard, type RunState } from "../src/pipeline/context.ts";
import type { ModelDef, ProviderDef } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import {
  approve,
  type Handler,
  models,
  pipelineSetup,
  policy,
  providers,
  roleOf,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, makeRepo } = pipelineSetup({
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

describe("review shadow panel: single reviews decide, the panel only records", () => {
  type Calls = Record<"primary" | "shadow" | "verifier" | "implement", AgentSpec[]>;
  const newCalls = (): Calls => ({ primary: [], shadow: [], verifier: [], implement: [] });
  const finding = (title: string) => ({
    severity: "major" as const,
    security: false,
    ...findingEvidence,
    file: "farewell.txt",
    line: 1,
    title,
    detail: title,
    suggestion: "Fix",
  });
  const confirm = (s: AgentSpec): FakeReply => ({
    structured: {
      results: [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => ({
        id: m[1],
        verdict: "CONFIRMED",
        severity: "high",
        category: "correctness",
        evidence: "farewell.txt:1",
        trigger: "x",
      })),
    },
    costEquivUsd: 0.1,
  });
  /**
   * Round 0: the single review blocks on "Single only" while the panel approves. Round 1: the single
   * review approves while the panel blocks on "Panel only". `onShadow` sees each shadow member call.
   */
  const scenario =
    (calls: Calls, onShadow?: (s: AgentSpec) => FakeReply | undefined): Handler =>
    (s) => {
      const verifier = s.prompt.startsWith("You are a code-review verifier");
      if (verifier || s.prompt.startsWith("You are a code reviewer")) {
        (verifier ? calls.verifier : calls.shadow).push(s);
        const override = onShadow?.(s);
        if (override) return override;
        if (verifier) return confirm(s);
        const findings = calls.implement.length > 1 ? [finding("Panel only")] : [];
        return { structured: { ...approve, findings }, costEquivUsd: 0.25 };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }), costEquivUsd: 0 };
      if (role === "review") {
        calls.primary.push(s);
        const blocks = calls.implement.length === 1;
        const structured = blocks
          ? { verdict: "request_changes", summary: "Needs work", findings: [finding("Single only")] }
          : approve;
        return { structured, costEquivUsd: 1 };
      }
      calls.implement.push(s);
      return { files: { "farewell.txt": `goodbye ${calls.implement.length}\n` }, costEquivUsd: 2 };
    };
  /** Shadow on, with quota windows observed for both providers (unknown headroom skips the shadow). */
  const shadowOn = (f: Factory) => {
    f.deps.cfg.reviewShadow = "panel";
    for (const id of ["alpha", "beta"])
      f.tracker.observeWindows(id, { five_hour: { utilization: 0, resetsAt: null } });
  };
  const shadowOf = (f: Factory, runId: string, round: number) =>
    JSON.parse(f.store.getArtifact(runId, `review-${round}.shadow.json`) ?? "null");

  test("a pinned production reviewer leaves the shadow panel's targets unchanged", async () => {
    const calls = newCalls();
    const f = start(scenario(calls));
    shadowOn(f);
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      models: { implement: ["alpha/m"], review: ["alpha/m"] },
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(calls.primary.map((s) => s.target.modelId)).toEqual(["alpha/m", "alpha/m"]);
    expect(calls.shadow.map((s) => s.target.modelId)).toContain("beta/m");
    expect(
      f.store.listInvocations(run.id).some((i) => i.role === "review_shadow" && i.modelId === "beta/m"),
    ).toBe(true);
  });
  // Runs differ only in commit SHAs and run ids.
  const normalize = (specs: AgentSpec[], runId: string) =>
    specs.map((s) => s.prompt.replaceAll(runId, "RUN").replace(/\b[0-9a-f]{40}\b/g, "SHA"));
  const titles = (f: Factory, runId: string) =>
    f.store.getRunState<RunState>(runId)?.reviewHistory?.map((e) => e.blocking.map((b) => b.title));

  test("shadow off and on: the same primary reviews, targets, feedback and outcome; the panel disagrees both ways", async () => {
    const outcomes = [];
    for (const shadow of ["off", "panel"] as const) {
      if (factory) {
        await factory.stop();
        factory.store.close();
        factory = null;
        rmSync(home, { recursive: true, force: true });
        home = mkdtempSync(join(tmpdir(), "limitless-e2e-"));
        observerRoots.add(realpathSync(home));
        repoDir = await makeRepo();
      }
      const calls = newCalls();
      const f = start(scenario(calls));
      if (shadow === "panel") shadowOn(f);
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const after = f.store.getRun(run.id);
      outcomes.push({
        calls,
        primary: normalize(calls.primary, run.id),
        implement: normalize(calls.implement, run.id),
        targets: calls.primary.map((s) => s.target.modelId),
        blocking: titles(f, run.id),
        lastReview: f.store.getRunState<RunState>(run.id)?.lastReview?.verdict,
        artifacts: f.store.listArtifacts(run.id).map((a) => a.name),
        cost: after?.costEquivUsd ?? 0,
        shadows: [0, 1].map((round) => shadowOf(f, run.id, round)),
        sha: f.store.getRunState<RunState>(run.id)?.reviewHistory?.map((e) => e.sha),
        baseSha: after?.baseSha,
      });
    }
    const [off, on] = outcomes;
    if (!off || !on) throw new Error("missing outcomes");
    // Disabled: no shadow calls, artifacts or cost.
    expect([off.calls.shadow.length, off.calls.verifier.length]).toEqual([0, 0]);
    expect(off.shadows).toEqual([null, null]);
    expect(off.artifacts.some((name) => name.includes("shadow"))).toBe(false);
    // Enabled: the primary review sees and decides exactly what it did without the shadow.
    expect(on.primary).toEqual(off.primary);
    expect(on.implement).toEqual(off.implement);
    expect(on.implement[1]).toContain("Single only");
    expect(on.implement[1]).not.toContain("Panel only");
    expect(on.targets).toEqual(off.targets);
    expect(on.blocking).toEqual([["Single only"], []]);
    expect(on.blocking).toEqual(off.blocking);
    expect(on.lastReview).toBe("approve");
    expect(on.artifacts.filter((name) => !name.includes("shadow")).sort()).toEqual([...off.artifacts].sort());
    // Each shadow saw its single review's revisions: the panel approved where the single review blocked...
    const [r0, r1] = on.shadows;
    expect(r0).toMatchObject({
      round: 0,
      status: "completed",
      system: "panel-quick",
      baseSha: on.baseSha,
      reviewedSha: on.sha?.[0],
      range: `${on.baseSha}..${on.sha?.[0]}`,
      review: { mode: "panel", verdict: "approve" },
      blocking: [],
      panel: { finders: [{ prompt: "standard", vendor: "openai" }] },
      usage: { invocations: 1, costEquivUsd: 0.25 },
    });
    // ...and blocked where it approved, as a first review of the complete diff.
    expect(r1).toMatchObject({
      round: 1,
      status: "completed",
      reviewedSha: on.sha?.[1],
      review: { verdict: "request_changes" },
      blocking: [{ title: "Panel only" }],
      usage: { invocations: 2, costEquivUsd: 0.35 },
    });
    expect(on.calls.shadow.map((s) => s.prompt.includes("Previous review"))).toEqual([false, false]);
    expect(on.calls.shadow[1]?.prompt).toContain(on.baseSha ?? "missing");
    expect(on.cost).toBeCloseTo(off.cost + 0.6, 6);
  });

  test.each([
    [0.05, "skipped"],
    [0.1, "skipped"],
    [0.11, "completed"],
  ] as const)("headroom %d: shadow work is %s at the 0.1 floor", async (headroom, status) => {
    const calls = newCalls();
    const f = start(scenario(calls));
    shadowOn(f);
    spyOn(f.tracker, "headroom").mockImplementation(() => headroom);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(titles(f, run.id)).toEqual([["Single only"], []]);
    const shadows = [0, 1].map((round) => shadowOf(f, run.id, round));
    expect(shadows.map((s) => s.status)).toEqual([status, status]);
    if (status === "skipped") {
      expect(calls.shadow.length + calls.verifier.length).toBe(0);
      expect(shadows[0]).toMatchObject({
        reason: "beta quota headroom is at or below 0.1",
        usage: { invocations: 0, costUsd: 0, costEquivUsd: 0 },
      });
    } else expect([calls.shadow.length, calls.verifier.length]).toEqual([2, 1]);
  });

  test("quota lost after a finder stops the verifier call; partial spend is recorded", async () => {
    const calls = newCalls();
    let headroom = 1;
    const f = start(
      scenario(calls, (s) => {
        if (s.prompt.startsWith("You are a code reviewer") && calls.implement.length > 1) headroom = 0.05;
        return undefined;
      }),
    );
    shadowOn(f);
    spyOn(f.tracker, "headroom").mockImplementation(() => headroom);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect([calls.shadow.length, calls.verifier.length]).toEqual([2, 0]);
    expect(shadowOf(f, run.id, 0)).toMatchObject({ status: "completed" });
    expect(shadowOf(f, run.id, 1)).toMatchObject({
      status: "skipped",
      reason: "alpha quota headroom is at or below 0.1",
      usage: { invocations: 1, costEquivUsd: 0.25 },
    });
    expect(shadowOf(f, run.id, 1)).not.toHaveProperty("blocking");
  });

  test("a throwing shadow member leaves the single decision intact and records the error", async () => {
    const calls = newCalls();
    const f = start(scenario(calls));
    shadowOn(f);
    const acquire = f.tracker.tryAcquire.bind(f.tracker);
    // The verifier is the only call made after a panel finder reported something.
    spyOn(f.tracker, "tryAcquire").mockImplementation((provider, preempt) => {
      if (calls.shadow.length === 2 && calls.verifier.length === 0) throw new Error("member exploded");
      return acquire(provider, preempt);
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(titles(f, run.id)).toEqual([["Single only"], []]);
    expect(f.store.getRunState<RunState>(run.id)?.lastReview?.verdict).toBe("approve");
    expect(shadowOf(f, run.id, 1)).toMatchObject({
      status: "error",
      reason: "member exploded",
      usage: { invocations: 1, costEquivUsd: 0.25 },
    });
    expect(f.store.listEvents(run.id).some((e) => e.message === "Shadow panel error: member exploded")).toBe(
      true,
    );
  });

  test("a failed shadow artifact write cannot fail the production review", async () => {
    const calls = newCalls();
    const f = start(scenario(calls));
    shadowOn(f);
    const put = f.store.putArtifact.bind(f.store);
    const writes: string[] = [];
    spyOn(f.store, "putArtifact").mockImplementation((...args) => {
      if (args[1].endsWith(".shadow.json")) {
        writes.push(args[1]);
        throw new Error("shadow artifact unavailable");
      }
      return put(...args);
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(titles(f, run.id)).toEqual([["Single only"], []]);
    expect(writes).toEqual(["review-0.shadow.json", "review-1.shadow.json"]);
    expect(f.store.listEvents(run.id).some((e) => e.message.includes("shadow artifact unavailable"))).toBe(
      true,
    );
  });

  test("the shadow panel takes the profile's roster plus lenses from the base commit", async () => {
    const lens = (focus: string) =>
      `[review]\nlenses = [{ name = "ops", focus = "${focus}", profiles = ["quick"] }]\n`;
    const toml = readFileSync(join(repoDir, ".limitless.toml"), "utf8");
    writeFileSync(join(repoDir, ".limitless.toml"), `${toml}${lens("BASE_FOCUS")}`);
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "lens"], {
      cwd: repoDir,
    });
    const calls = newCalls();
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        (s.prompt.startsWith("You are a code reviewer") ? calls.shadow : calls.primary).push(s);
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n", ".limitless.toml": `${toml}${lens("HEAD_FOCUS")}` } };
    });
    shadowOn(f);
    // Both finders and the single review run at once, each with a free slot.
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 3 });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(calls.primary).toHaveLength(1);
    expect(calls.shadow.filter((s) => s.prompt.includes("BASE_FOCUS"))).toHaveLength(1);
    expect(calls.shadow.some((s) => s.prompt.includes("HEAD_FOCUS"))).toBe(false);
    expect(shadowOf(f, run.id, 0).panel.finders).toEqual([
      { prompt: "standard", vendor: "openai" },
      { prompt: "standard", lens: "ops", vendor: "openai" },
    ]);
  });

  test("a shadow finder without a free provider slot is skipped at once and never queues", async () => {
    const calls = newCalls();
    const base = scenario(calls, () => ({ structured: approve, costEquivUsd: 0.25 }));
    const attempts = [deferred<void>(), deferred<void>()];
    const unattempted: number[] = [];
    const f = start(async (s) => {
      // The artifact is written after production completes; wait for the slot attempt instead.
      if (roleOf(s) === "review" && !s.prompt.startsWith("You are a code")) {
        const round = calls.primary.length;
        const attempt = attempts[round];
        if (!attempt) throw new Error("unexpected production review round");
        // Bounded, so a shadow that skips or queues for its slot fails the test instead of hanging it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const missed = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            unattempted.push(round);
            resolve();
          }, 5_000);
        });
        await Promise.race([attempt.promise, missed]);
        clearTimeout(timer);
      }
      return base(s);
    });
    shadowOn(f);
    // One slot per provider: the single review holds beta's, which the shadow finder would route to.
    for (const id of ["alpha", "beta"]) Object.assign(f.tracker.def(id) ?? {}, { maxConcurrent: 1 });
    const tryAcquire = f.tracker.tryAcquire.bind(f.tracker);
    const shadowAcquire = spyOn(f.tracker, "tryAcquire").mockImplementation((id, preempt) => {
      const release = tryAcquire(id, preempt);
      if (id === "beta" && release === null) attempts[calls.primary.length]?.resolve();
      return release;
    });
    const acquire = spyOn(f.tracker, "acquire");
    try {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
      // Rounds in which the shadow finder never tried beta's slot.
      expect(unattempted).toEqual([]);
      expect(status).toBe("succeeded");
      expect(titles(f, run.id)).toEqual([["Single only"], []]);
      expect(calls.shadow).toHaveLength(0);
      for (const round of [0, 1])
        expect(shadowOf(f, run.id, round)).toMatchObject({
          status: "skipped",
          reason: expect.stringContaining("beta: no free slot"),
          usage: { invocations: 0 },
        });
      // Only production calls ever waited for a slot.
      expect(acquire.mock.calls.length).toBe(f.store.listInvocations(run.id).length);
      expect(f.store.listInvocations(run.id).some((i) => i.role === "review_shadow")).toBe(false);
    } finally {
      acquire.mockRestore();
      shadowAcquire.mockRestore();
    }
  });

  test("failed and retried shadow attempts count once in shadow usage and run totals", async () => {
    const run = async (failFirst: boolean) => {
      const calls = newCalls();
      let failed = false;
      const f = start(
        scenario(calls, (s) => {
          if (!failFirst || failed || !s.prompt.startsWith("You are a code reviewer")) return undefined;
          failed = true;
          return { status: "error", error: "overloaded", costUsd: 0.02, costEquivUsd: 0.1 };
        }),
      );
      shadowOn(f);
      const created = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, created.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const result = {
        calls,
        cost: f.store.getRun(created.id)?.costEquivUsd ?? 0,
        shadow: shadowOf(f, created.id, 0),
        blocking: titles(f, created.id),
      };
      await f.stop();
      f.store.close();
      factory = null;
      rmSync(home, { recursive: true, force: true });
      home = mkdtempSync(join(tmpdir(), "limitless-e2e-"));
      observerRoots.add(realpathSync(home));
      repoDir = await makeRepo();
      return result;
    };
    const clean = await run(false);
    const retried = await run(true);
    expect(retried.blocking).toEqual(clean.blocking);
    expect(retried.calls.shadow.length).toBe(clean.calls.shadow.length + 1);
    expect(retried.shadow).toMatchObject({
      status: "completed",
      usage: { invocations: 2, costUsd: 0.02, costEquivUsd: 0.35 },
    });
    expect(retried.cost).toBeCloseTo(clean.cost + 0.1, 6);
  });

  test.each(["same", "different"] as const)(
    "a restart reuses a completed shadow only for the %s reviewed revision",
    async (revision) => {
      const calls = newCalls();
      const handler = scenario(calls);
      const f = start(handler);
      shadowOn(f);
      const before: { range: string }[] = [];
      f.deps.faults = {
        "stage:review:after": {
          action: "kill",
          occurrence: 1,
          onHit: ({ runId }) => {
            const stored = shadowOf(f, runId, 0);
            if (revision === "different")
              f.store.putArtifact(
                runId,
                "review-0.shadow.json",
                "review-shadow",
                JSON.stringify({ ...stored, range: "elsewhere..head" }),
              );
            before.push(stored);
          },
        },
      };
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      const deadline = Date.now() + 10_000;
      while (f.store.listStages(run.id).at(-1)?.status !== "cancelled") {
        if (Date.now() > deadline) throw new Error("review interruption timed out");
        await Bun.sleep(10);
      }
      await f.stop();
      f.store.close();
      expect([calls.primary.length, calls.shadow.length]).toEqual([1, 1]);
      const resumed = start(handler);
      shadowOn(resumed);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      // The single review replays; the shadow of the same revision does not, so neither does its spend.
      const replays = revision === "same" ? 0 : 1;
      expect([calls.primary.length, calls.shadow.length]).toEqual([3, 2 + replays]);
      const r0 = shadowOf(resumed, run.id, 0);
      if (revision === "same") expect(r0).toEqual(before[0]);
      else expect(r0).toMatchObject({ status: "completed", range: before[0]?.range });
      const shadowSpend = [0, 1].reduce(
        (t, round) => t + shadowOf(resumed, run.id, round).usage.costEquivUsd,
        0,
      );
      expect(shadowSpend).toBeCloseTo(0.25 + 0.35, 6);
      expect(resumed.store.getRun(run.id)?.costEquivUsd).toBeCloseTo(2 * 2 + 3 * 1 + 0.6 + replays * 0.25, 6);
    },
  );

  const reset = async () => {
    if (!factory) return;
    await factory.stop();
    factory.store.close();
    factory = null;
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "limitless-e2e-"));
    observerRoots.add(realpathSync(home));
    repoDir = await makeRepo();
  };
  const isShadowCall = (s: AgentSpec) =>
    s.prompt.startsWith("You are a code reviewer") || s.prompt.startsWith("You are a code-review verifier");
  const health = (f: Factory) =>
    ["alpha", "beta"].map((id) => [f.tracker.status(id)?.state, f.tracker.modelUnavailableReason(`${id}/m`)]);
  const threeFinders = (f: Factory) => {
    const lens = { name: "ops", focus: "OPS" };
    const quick = [
      { prompt: "standard" as const },
      { prompt: "careful" as const },
      { prompt: "standard" as const, lens },
    ];
    f.deps.cfg.reviewRosters = { ...f.deps.cfg.reviewRosters, quick };
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 4 });
  };
  const failures: Record<string, FakeReply> = {
    timeout: { fault: "timeout" },
    unavailable: { status: "unavailable", error: "overloaded" },
    rejected: { status: "error", error: "model_not_found" },
    exhausted: {
      status: "quota",
      error: "limit",
      quota: { windows: {}, exhaustedUntil: Date.now() + 3_600_000 },
    },
    cooldown: { status: "quota", error: "slow down" },
  };

  // With the shadow off nothing fails, so every failure kind shares one control run.
  let shadowOff:
    | Promise<{ targets: string[]; health: ReturnType<typeof health>; failed: number }>
    | undefined;
  test.each(Object.keys(failures))(
    "shadow %s failures leave provider health and later production review targets as with the shadow off",
    async (kind) => {
      const fail = failures[kind] ?? {};
      const runOnce = async (who: "none" | "shadow" | "production") => {
        await reset();
        const calls = newCalls();
        const base = scenario(calls, () => (who === "shadow" ? fail : undefined));
        // Production control: every single review routed to beta fails, so it falls back to alpha.
        const productionFails = (s: AgentSpec) =>
          who === "production" && !isShadowCall(s) && roleOf(s) === "review" && s.target.provider === "beta";
        const f = start((s) => (productionFails(s) ? fail : base(s)));
        const fake = f.deps.harnesses.fake;
        if (kind === "cooldown" && fake)
          f.deps.harnesses.fake = async (s) => {
            const result = await fake(s);
            return result.status === "quota" ? { ...result, modelCooldownMs: 3_600_000 } : result;
          };
        // Three finders on one provider: three shadow failures there before the next production review.
        threeFinders(f);
        shadowOn(f);
        if (who !== "shadow") f.deps.cfg.reviewShadow = "off";
        const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const failed = f.store
          .listInvocations(run.id)
          .filter((i) => i.role === "review_shadow" && i.provider === "beta" && i.status !== "ok");
        return {
          targets: calls.primary.map((s) => s.target.modelId),
          health: health(f),
          failed: failed.length,
        };
      };
      shadowOff ??= runOnce("none");
      const off = await shadowOff;
      const on = await runOnce("shadow");
      expect(on.failed).toBeGreaterThanOrEqual(3);
      expect(on.targets).toEqual(off.targets);
      expect(on.targets).toEqual(["beta/m", "beta/m"]);
      expect(on.health).toEqual(off.health);
      expect(on.health).toEqual([
        ["ok", null],
        ["ok", null],
      ]);
      // Control: the same failure in a production review does reach provider health.
      const production = await runOnce("production");
      expect(production.health).not.toEqual(off.health);
    },
  );

  test("quota headroom is checked only for providers the shadow roster can reach, and unknown headroom skips it", async () => {
    const omega: ProviderDef = {
      id: "omega",
      label: "Omega",
      harness: "fake",
      billing: "subscription",
      maxConcurrent: 2,
    };
    const startWithOmega = (calls: Calls, unlimited: string[]) => {
      const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
      const alpha = models[0] as ModelDef;
      factory = new Factory(cfg, {
        confinement: fakeConfinement,
        harnesses: { fake: fakeHarness(scenario(calls)) },
        providers: [...providers, omega].map((p) =>
          unlimited.includes(p.id) ? { ...p, quota: "unlimited" } : p,
        ),
        models: [...models, { ...alpha, id: "omega/m", provider: "omega", vendor: "google" }],
        policy,
        bootSha: "test-build",
      });
      factory.start();
      factory.deps.cfg.reviewShadow = "panel";
      return factory;
    };
    const outcome = async (observed: string[], low?: string, unlimited: string[] = []) => {
      await reset();
      const calls = newCalls();
      const f = startWithOmega(calls, unlimited);
      for (const id of observed)
        f.tracker.observeWindows(id, { five_hour: { utilization: 0, resetsAt: null } });
      const headroom = f.tracker.headroom.bind(f.tracker);
      spyOn(f.tracker, "headroom").mockImplementation((id) => (id === low ? 0.05 : headroom(id)));
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      return { shadow: JSON.parse(f.store.getArtifact(run.id, "review-0.shadow.json") ?? "null"), calls };
    };
    // Omega is enabled but no review route reaches it: unknown or low there never skips the shadow.
    expect((await outcome(["alpha", "beta"])).shadow.status).toBe("completed");
    expect((await outcome(["alpha", "beta"], "omega")).shadow.status).toBe("completed");
    const noLimit = await outcome([], undefined, ["alpha", "beta"]);
    expect(noLimit.shadow.status).toBe("completed");
    expect(noLimit.calls.shadow.length).toBeGreaterThan(0);
    expect((await outcome([], undefined, ["alpha"])).shadow).toMatchObject({
      status: "skipped",
      reason: "beta quota headroom is unknown",
    });
    // Beta is the roster's route, alpha a fallback (and verifier) route: either unknown skips it.
    for (const [observed, reason] of [
      [["alpha"], "beta quota headroom is unknown"],
      [["beta"], "alpha quota headroom is unknown"],
    ] as const) {
      const { shadow, calls } = await outcome([...observed]);
      expect(shadow).toMatchObject({ status: "skipped", reason, usage: { invocations: 0 } });
      expect(calls.shadow.length + calls.verifier.length).toBe(0);
    }
  });

  /** Quick roster: a finder that answers at once and a lens finder that waits until released or aborted. */
  const slowShadow = (calls: Calls, gate: Promise<void>, ignoreAbort = false) => {
    const slow: AgentSpec[] = [];
    const release: (() => void)[] = [];
    let started: () => void = () => {};
    const shadowStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handler: Handler = async (s) => {
      if (s.prompt.startsWith("You are a code reviewer")) {
        calls.shadow.push(s);
        started();
        if (!s.prompt.includes("SLOW_FOCUS"))
          return { structured: { ...approve, findings: [finding("Fast")] } };
        slow.push(s);
        return new Promise<FakeReply>((resolve) => {
          const done = () => resolve({ structured: approve, costEquivUsd: 0.5 });
          release.push(done);
          if (!ignoreAbort) s.signal.addEventListener("abort", done);
        });
      }
      if (s.prompt.startsWith("You are a code-review verifier")) return confirm(s);
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        calls.primary.push(s);
        // Only a shadow started beside this review lets it finish.
        await shadowStarted;
        await gate;
        return { structured: approve, costEquivUsd: 1 };
      }
      calls.implement.push(s);
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    return { handler, slow, release };
  };
  const slowRoster = (f: Factory) => {
    const quick = [
      { prompt: "standard" as const },
      { prompt: "standard" as const, lens: { name: "slow", focus: "SLOW_FOCUS" } },
    ];
    f.deps.cfg.reviewRosters = { ...f.deps.cfg.reviewRosters, quick };
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 4 });
  };

  test("the shadow starts beside the single review and times out after the grace period with what finished", async () => {
    const calls = newCalls();
    const { handler, slow, release } = slowShadow(calls, Promise.resolve());
    const f = start(handler);
    shadowOn(f);
    slowRoster(f);
    f.deps.cfg.reviewShadowGraceSeconds = 0.3;
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const stage = f.store.listStages(run.id).find((st) => st.name === "review");
    expect(stage?.status).toBe("succeeded");
    expect((stage?.finishedAt ?? Infinity) - (stage?.startedAt ?? 0)).toBeLessThan(5_000);
    expect(JSON.parse(f.store.getArtifact(run.id, "review-0.json") ?? "{}")).toMatchObject({
      verdict: "approve",
    });
    const stored = f.store.getArtifact(run.id, "review-0.shadow.json");
    const shadow = JSON.parse(stored ?? "null");
    expect(shadow).toMatchObject({
      status: "timeout",
      reason: "running 0.3s after the single review",
      finished: [{ finder: 0, status: "ok", review: { findings: [{ title: "Fast" }] } }],
      usage: { invocations: 2 },
    });
    expect(shadow).not.toHaveProperty("blocking");
    // The pending finder was aborted and gave back its slot; a late answer changes nothing.
    expect(slow[0]?.signal.aborted).toBe(true);
    for (const done of release) done();
    await Bun.sleep(100);
    expect(f.store.getArtifact(run.id, "review-0.shadow.json")).toBe(stored);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
    expect(f.store.listInvocations(run.id).filter((i) => i.role === "review_shadow")).toHaveLength(2);
  });

  test("a timeout keeps completed verifier results beside the finder results", async () => {
    const calls = newCalls();
    const slow: AgentSpec[] = [];
    let verified: () => void = () => {};
    const firstVerified = new Promise<void>((resolve) => {
      verified = resolve;
    });
    // Two files make two verifier batches: the first answers at once, the second hangs until aborted.
    const handler: Handler = async (s) => {
      if (s.prompt.startsWith("You are a code reviewer")) {
        calls.shadow.push(s);
        const findings = [finding("Fast"), { ...finding("Other"), file: "other.txt" }];
        return { structured: { ...approve, findings }, costEquivUsd: 0.25 };
      }
      if (s.prompt.startsWith("You are a code-review verifier")) {
        calls.verifier.push(s);
        if (calls.verifier.length === 1) {
          verified();
          return confirm(s);
        }
        slow.push(s);
        return new Promise<FakeReply>((resolve) =>
          s.signal.addEventListener("abort", () => resolve({ structured: approve })),
        );
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        calls.primary.push(s);
        await firstVerified;
        return { structured: approve, costEquivUsd: 1 };
      }
      calls.implement.push(s);
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    shadowOn(f);
    // The verifier shares beta with the single review: a shadow call never takes a provider's last slot.
    for (const id of ["alpha", "beta"]) Object.assign(f.tracker.def(id) ?? {}, { maxConcurrent: 3 });
    f.deps.cfg.reviewShadowGraceSeconds = 0.3;
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(JSON.parse(f.store.getArtifact(run.id, "review-0.json") ?? "{}")).toMatchObject({
      verdict: "approve",
    });
    expect(slow[0]?.signal.aborted).toBe(true);
    const shadow = JSON.parse(f.store.getArtifact(run.id, "review-0.shadow.json") ?? "null");
    expect(shadow).toMatchObject({
      status: "timeout",
      finished: [
        { finder: 0, status: "ok", review: { findings: [{ title: "Fast" }, { title: "Other" }] } },
        { verifier: ["C1"], status: "ok", result: { results: [{ id: "C1", verdict: "CONFIRMED" }] } },
      ],
      usage: { invocations: 3 },
    });
    expect(shadow.finished).toHaveLength(2);
    expect(shadow).not.toHaveProperty("blocking");
  });

  test("a shadow call still running after its abort never holds the run past the grace period or touches its worktree", async () => {
    const calls = newCalls();
    const { handler, slow, release } = slowShadow(calls, Promise.resolve(), true);
    const f = start(handler);
    shadowOn(f);
    slowRoster(f);
    // Long enough for the fast finder to be recorded; at 0 that raced the single review's completion.
    f.deps.cfg.reviewShadowGraceSeconds = 0.5;
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const stage = f.store.listStages(run.id).find((st) => st.name === "review");
    // Past the grace, aborted calls get at most 5 s to record their spend; this one never does.
    expect((stage?.finishedAt ?? Infinity) - (stage?.startedAt ?? 0)).toBeLessThan(8_000);
    const stored = f.store.getArtifact(run.id, "review-0.shadow.json");
    expect(JSON.parse(stored ?? "null")).toMatchObject({
      status: "timeout",
      finished: [{ finder: 0, status: "ok" }],
      usage: { invocations: 2, partial: true },
    });
    // The pending call reads its own checkout of the reviewed commit, not the run's worktree.
    const worktree = f.store.getRunState<RunState>(run.id)?.worktreePath;
    expect(slow[0]?.signal.aborted).toBe(true);
    expect(slow[0]?.cwd).not.toBe(worktree);
    expect(slow[0]?.cwd).not.toContain(worktree ?? "?");
    for (const done of release) done();
    const deadline = Date.now() + 5_000;
    while ((f.tracker.status("beta")?.inFlight ?? 0) > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
    expect(f.store.getArtifact(run.id, "review-0.shadow.json")).toBe(stored);
    // Its checkout goes once its last call ends.
    while (existsSync(slow[0]?.cwd ?? "") && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(slow[0]?.cwd ?? "")).toBe(false);
  }, 20_000);

  test("an aborted shadow call that settles soon after has its final spend in the artifact", async () => {
    const calls = newCalls();
    const { handler, slow, release } = slowShadow(calls, Promise.resolve(), true);
    const f = start(handler);
    shadowOn(f);
    slowRoster(f);
    f.deps.cfg.reviewShadowGraceSeconds = 0;
    // The slow finder ignores the abort but answers 300 ms later, reporting its 0.5 cost then.
    const fake = f.deps.harnesses.fake;
    if (fake)
      f.deps.harnesses.fake = async (s) => {
        const result = await fake(s);
        return s.prompt.includes("SLOW_FOCUS") ? { ...result, costEquivUsd: 0.5 } : result;
      };
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (!slow[0]?.signal.aborted && Date.now() < deadline) await Bun.sleep(10);
    expect(f.store.getArtifact(run.id, "review-0.shadow.json")).toBeNull();
    await Bun.sleep(300);
    for (const done of release) done();
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const shadow = JSON.parse(f.store.getArtifact(run.id, "review-0.shadow.json") ?? "null");
    expect(shadow).toMatchObject({ status: "timeout", usage: { invocations: 2 } });
    // The fast finder's default 0.001 plus the slow one's 0.5, recorded after its abort.
    expect(shadow.usage.costEquivUsd).toBeCloseTo(0.501, 6);
    expect(shadow.usage).not.toHaveProperty("partial");
    const stage = f.store.listStages(run.id).find((st) => st.name === "review");
    expect((stage?.finishedAt ?? Infinity) - (stage?.startedAt ?? 0)).toBeLessThan(5_000);
  }, 20_000);

  /**
   * The single review fails over from beta to alpha; the shadow finder (beta) reports, so its verifier
   * wants alpha. `verifier` decides how that call behaves; `primary` gates the production review.
   */
  const fallbackScenario = (
    calls: Calls,
    times: Record<string, number>,
    verifier: (s: AgentSpec) => Promise<FakeReply>,
    primary: (s: AgentSpec) => Promise<void> = () => Bun.sleep(500),
  ): Handler => {
    return async (s) => {
      if (s.prompt.startsWith("You are a code reviewer")) {
        calls.shadow.push(s);
        return { structured: { ...approve, findings: [finding("Fast")] } };
      }
      if (s.prompt.startsWith("You are a code-review verifier")) {
        calls.verifier.push(s);
        return verifier(s);
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        calls.primary.push(s);
        if (s.target.provider === "alpha") {
          times.fallback = Date.now();
          return { structured: approve };
        }
        await primary(s);
        times.failed = Date.now();
        return { status: "unavailable", error: "overloaded" };
      }
      calls.implement.push(s);
      return { files: { "farewell.txt": "goodbye\n" } };
    };
  };

  test("a one-slot fallback provider never admits shadow work: the production fallback starts at once", async () => {
    const outcome = async (shadow: boolean) => {
      await reset();
      const calls = newCalls();
      const times: Record<string, number> = {};
      // Were the verifier admitted, it would hold alpha's only slot for 3 s.
      const verifier = async (s: AgentSpec) => {
        await Bun.sleep(3_000);
        return confirm(s);
      };
      const f = start(fallbackScenario(calls, times, verifier));
      shadowOn(f);
      if (!shadow) f.deps.cfg.reviewShadow = "off";
      Object.assign(f.tracker.def("alpha") ?? {}, { maxConcurrent: 1 });
      Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 3 });
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      return {
        gap: (times.fallback ?? Infinity) - (times.failed ?? 0),
        targets: calls.primary.map((c) => c.target.modelId),
        verifier: calls.verifier.length,
        shadow: shadowOf(f, run.id, 0),
      };
    };
    const off = await outcome(false);
    const on = await outcome(true);
    expect(on.targets).toEqual(off.targets);
    expect(on.targets).toEqual(["beta/m", "alpha/m"]);
    expect(off.gap).toBeLessThan(1_000);
    expect(on.gap).toBeLessThan(1_000);
    expect(on.verifier).toBe(0);
    expect(on.shadow).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("alpha: no free slot"),
    });
  });

  test("a saturated provider preempts the shadow verifier: the fallback starts before it would end, and the panel goes on", async () => {
    const calls = newCalls();
    const times: Record<string, number> = {};
    const held: (() => void)[] = [];
    let verifying: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    let natural = false;
    const ref: { f?: Factory } = {};
    const f = start(
      fallbackScenario(
        calls,
        times,
        (s) =>
          new Promise<FakeReply>((resolve) => {
            verifying();
            // Natural completion would take 10 s; only an abort ends it sooner.
            const timer = setTimeout(() => {
              natural = true;
              resolve(confirm(s));
            }, 10_000);
            s.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve({ structured: null });
            });
          }),
        async () => {
          // Another production call fills alpha's other slot once the shadow verifier holds one.
          await started;
          const tracker = ref.f?.tracker;
          if (tracker) held.push(await tracker.acquire("alpha", new AbortController().signal));
        },
      ),
    );
    ref.f = f;
    shadowOn(f);
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 3 });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(natural).toBe(false);
    expect((times.fallback ?? Infinity) - (times.failed ?? 0)).toBeLessThan(2_000);
    expect(calls.primary.map((c) => c.target.modelId)).toEqual(["beta/m", "alpha/m"]);
    expect(calls.verifier[0]?.signal.aborted).toBe(true);
    const shadow = shadowOf(f, run.id, 0);
    // The finder's report stays; the preempted verifier leaves its candidate unverified.
    expect(shadow).toMatchObject({
      status: "completed",
      panel: { finders: [{ prompt: "standard", vendor: "openai" }], omitted: ["C1"] },
      finished: [
        { finder: 0, status: "ok", review: { findings: [{ title: "Fast" }] } },
        { verifier: ["C1"], skipped: "preempted" },
      ],
    });
    expect(shadow.usage).toMatchObject({ invocations: 2 });
    for (const release of held) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  });

  test("a production call preempts a shadow finder; the panel goes on with the finder that finished", async () => {
    const calls = newCalls();
    const { handler, slow } = slowShadow(calls, Promise.resolve());
    let gate: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const f = start(async (s) => {
      if (roleOf(s) === "review" && !isShadowCall(s)) await opened;
      return handler(s);
    });
    shadowOn(f);
    slowRoster(f);
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 5 });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    // The single review and the slow finder hold beta; the fast finder has answered.
    while (!(slow.length && f.tracker.status("beta")?.inFlight === 2) && Date.now() < deadline)
      await Bun.sleep(10);
    const signal = new AbortController().signal;
    const held = [await f.tracker.acquire("beta", signal), await f.tracker.acquire("beta", signal)];
    held.push(await f.tracker.acquire("beta", signal));
    // Saturated: another production call aborts the slow finder and takes its slot.
    const waited = Date.now();
    held.push(await f.tracker.acquire("beta", signal));
    expect(Date.now() - waited).toBeLessThan(2_000);
    expect(slow[0]?.signal.aborted).toBe(true);
    for (const release of held) release();
    gate();
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(shadowOf(f, run.id, 0)).toMatchObject({
      status: "completed",
      panel: {
        finders: [
          { prompt: "standard", vendor: "openai" },
          { prompt: "standard", lens: "slow", vendor: null, skipped: "preempted" },
        ],
      },
      blocking: [{ title: "Fast" }],
    });
  });

  test("a preempted shadow finder stays recorded when the grace expires before its abort settles", async () => {
    const calls = newCalls();
    let gate: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      gate = resolve;
    });
    // The slow finder ignores its abort: it settles only when released, after the grace has run out.
    const { handler, slow, release } = slowShadow(calls, opened, true);
    let shadowSignal: AbortSignal | undefined;
    const f = start(async (s) => {
      if (s.prompt.includes("SLOW_FOCUS")) shadowSignal = invokeGuard.getStore()?.signal;
      return handler(s);
    });
    shadowOn(f);
    slowRoster(f);
    // Long enough for the fast finder to be recorded; at 0 that raced the single review's completion.
    f.deps.cfg.reviewShadowGraceSeconds = 0.5;
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (!(slow.length && f.tracker.status("beta")?.inFlight === 2) && Date.now() < deadline)
      await Bun.sleep(10);
    const signal = new AbortController().signal;
    const held = [await f.tracker.acquire("beta", signal), await f.tracker.acquire("beta", signal)];
    // Saturated: a production call preempts the slow finder, whose slot it gets once that call settles.
    const fifth = f.tracker.acquire("beta", signal);
    while (!slow[0]?.signal.aborted && Date.now() < deadline) await Bun.sleep(10);
    expect(slow[0]?.signal.aborted).toBe(true);
    // The single review ends and the grace expires while the preempted call is still settling.
    gate();
    while (!shadowSignal?.aborted && Date.now() < deadline) await Bun.sleep(10);
    expect(shadowSignal?.aborted).toBe(true);
    for (const done of release) done();
    held.push(await fifth);
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    for (const done of held) done();
    const shadow = shadowOf(f, run.id, 0);
    expect(shadow).toMatchObject({
      status: "timeout",
      finished: [
        { finder: 0, status: "ok", review: { findings: [{ title: "Fast" }] } },
        { finder: 1, skipped: "preempted" },
      ],
      usage: { invocations: 2 },
    });
    expect(shadow.usage).not.toHaveProperty("partial");
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test("one run's shadow never delays another run's production implement call", async () => {
    const calls = newCalls();
    let verifying: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    let release: () => void = () => {};
    const second = new Promise<void>((resolve) => {
      release = resolve;
    });
    const implemented: Record<string, number> = {};
    const f = start(async (s) => {
      if (s.prompt.startsWith("You are a code reviewer"))
        return { structured: { ...approve, findings: [finding("Fast")] } };
      if (s.prompt.startsWith("You are a code-review verifier"))
        return new Promise<FakeReply>((resolve) => {
          verifying();
          s.signal.addEventListener("abort", () => resolve({ structured: null }));
        });
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        // The first run's single review waits until the second run has implemented.
        if (calls.primary.push(s) === 1) await second;
        return { structured: approve };
      }
      calls.implement.push(s);
      implemented[s.prompt.includes("Second") ? "second" : "first"] = Date.now();
      if (s.prompt.includes("Second")) release();
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    shadowOn(f);
    f.deps.cfg.reviewShadowGraceSeconds = 0;
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 3 });
    const first = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    await started;
    // The first run's shadow verifier holds one of alpha's two slots; another production call holds the other.
    const held = await f.tracker.acquire("alpha", new AbortController().signal);
    const queued = Date.now();
    const other = await f.createRun({ repo: repoDir, prompt: "Second farewell", profile: "quick" });
    expect(await waitFor(f, other.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    held();
    expect(implemented.second).toBeGreaterThan(queued);
    expect(shadowOf(f, first.id, 0)).toMatchObject({
      finished: expect.arrayContaining([{ verifier: ["C1"], skipped: "preempted" }]),
    });
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  });

  test("one run's shadow never delays another run's production review call", async () => {
    const calls = newCalls();
    const { handler, slow } = slowShadow(calls, Promise.resolve());
    let release: () => void = () => {};
    const second = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reviews = 0;
    const f = start(async (s) => {
      if (roleOf(s) === "review" && !isShadowCall(s)) {
        // The first run's single review waits until the second run's single review has started.
        if (reviews++ === 0) await second;
        else release();
      }
      return handler(s);
    });
    shadowOn(f);
    slowRoster(f);
    Object.assign(f.tracker.def("beta") ?? {}, { maxConcurrent: 5 });
    const first = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    // The first run's single review and its slow finder hold beta; the fast finder has answered.
    while (!(slow.length && f.tracker.status("beta")?.inFlight === 2) && Date.now() < deadline)
      await Bun.sleep(10);
    const signal = new AbortController().signal;
    const held = await Promise.all([1, 2, 3].map(() => f.tracker.acquire("beta", signal)));
    // Saturated: the second run's single review must preempt the finder, or both runs wait forever.
    const other = await f.createRun({ repo: repoDir, prompt: "Second farewell", profile: "quick" });
    expect(await waitFor(f, other.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    for (const done of held) done();
    expect(slow[0]?.signal.aborted).toBe(true);
    expect(calls.primary.map((c) => c.target.modelId)).toEqual(["beta/m", "beta/m"]);
    expect(shadowOf(f, first.id, 0)).toMatchObject({
      status: "completed",
      panel: {
        finders: [
          { prompt: "standard", vendor: "openai" },
          { prompt: "standard", lens: "slow", vendor: null, skipped: "preempted" },
        ],
      },
      blocking: [{ title: "Fast" }],
    });
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test("a stale pinned shadow roster target leaves production running with no shadow calls", async () => {
    mkdirSync(join(home, "cfg"), { recursive: true });
    writeFileSync(
      join(home, "cfg", "config.toml"),
      '[review]\nshadow = "panel"\n[review.rosters]\nquick = [{ prompt = "standard", target = "gone/model" }]\n',
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const calls = newCalls();
      const f = start(scenario(calls));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone/model"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("shadow review disabled until fixed"));
      for (const id of ["alpha", "beta"])
        f.tracker.observeWindows(id, { five_hour: { utilization: 0, resetsAt: null } });
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(titles(f, run.id)).toEqual([["Single only"], []]);
      expect([calls.shadow.length, calls.verifier.length]).toEqual([0, 0]);
      expect(f.store.listInvocations(run.id).some((i) => i.role === "review_shadow")).toBe(false);
      expect(f.store.listArtifacts(run.id).some((a) => a.name.includes("shadow"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("cancelling the run aborts the shadow while the single review waits on its grace period", async () => {
    const calls = newCalls();
    const { handler, slow } = slowShadow(calls, Promise.resolve());
    const f = start(handler);
    shadowOn(f);
    slowRoster(f);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (!f.store.getArtifact(run.id, "review-0.json")) {
      if (Date.now() > deadline) throw new Error("single review never finished");
      await Bun.sleep(10);
    }
    // The default 300 s grace still runs: only the cancellation can end the shadow now.
    expect(slow[0]?.signal.aborted).toBe(false);
    expect(f.cancelRun(run.id, "tester")).toBe(true);
    expect(await waitFor(f, run.id, ["cancelled", "failed"])).toBe("cancelled");
    expect(slow[0]?.signal.aborted).toBe(true);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test.each(["duplicate lens names", "review system construction"] as const)(
    "a shadow %s failure skips the shadow and leaves the run as with the shadow off",
    async (problem) => {
      const outcomes = [];
      for (const shadow of [false, true]) {
        await reset();
        if (problem === "duplicate lens names") {
          const toml = readFileSync(join(repoDir, ".limitless.toml"), "utf8");
          const lens = `{ name = "ops", focus = "A", profiles = ["quick"] }`;
          writeFileSync(join(repoDir, ".limitless.toml"), `${toml}[review]\nlenses = [${lens}, ${lens}]\n`);
          await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "lens"], {
            cwd: repoDir,
          });
        }
        const calls = newCalls();
        const f = start(scenario(calls));
        if (shadow) shadowOn(f);
        if (problem === "review system construction")
          f.deps.cfg.reviewRosters = { ...f.deps.cfg.reviewRosters, quick: [] };
        const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const state = f.store.getRunState<RunState>(run.id);
        outcomes.push({
          primary: normalize(calls.primary, run.id),
          implement: normalize(calls.implement, run.id),
          blocking: titles(f, run.id),
          reviewLenses: state?.reviewLenses,
          shadows: [0, 1].map((round) => shadowOf(f, run.id, round)),
          calls: calls.shadow.length + calls.verifier.length,
        });
      }
      const [off, on] = outcomes;
      expect(on?.primary).toEqual(off?.primary);
      expect(on?.implement).toEqual(off?.implement);
      expect(on?.blocking).toEqual(off?.blocking);
      expect(on?.reviewLenses).toBeUndefined();
      expect(on?.calls).toBe(0);
      const reason = problem === "duplicate lens names" ? "lens names must be unique" : "finder";
      for (const shadow of on?.shadows ?? [])
        expect(shadow).toMatchObject({ status: "skipped", reason: expect.stringContaining(reason) });
    },
  );

  test("a saved single-mode shadow run stays single after the configuration switches to panel", async () => {
    const toml = readFileSync(join(repoDir, ".limitless.toml"), "utf8");
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `${toml}[review]\nlenses = [{ name = "ops", focus = "OPS", profiles = ["quick"] }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "lens"], {
      cwd: repoDir,
    });
    const calls = newCalls();
    const handler = scenario(calls);
    const f = start(handler);
    shadowOn(f);
    f.deps.faults = { "stage:review:after": { action: "kill", occurrence: 1 } };
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (f.store.listStages(run.id).at(-1)?.status !== "cancelled") {
      if (Date.now() > deadline) throw new Error("review interruption timed out");
      await Bun.sleep(10);
    }
    const saved = f.store.getRunState<RunState>(run.id);
    await f.stop();
    f.store.close();
    expect(saved?.reviewLenses).toBeUndefined();
    expect(saved?.shadowLenses).toEqual([{ name: "ops", focus: "OPS", profiles: ["quick"] }]);
    const resumed = start(handler);
    resumed.deps.cfg.reviewMode = "panel";
    const shadowCalls = calls.shadow.length;
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(resumed.store.getRunState<RunState>(run.id)?.reviewLenses).toBeUndefined();
    // Every later review is the production single review; no panel finder ran.
    expect(calls.shadow).toHaveLength(shadowCalls);
    expect(JSON.parse(resumed.store.getArtifact(run.id, "review-1.json") ?? "{}").mode).not.toBe("panel");
    expect(titles(resumed, run.id)).toEqual([["Single only"], []]);
  });

  test("shadow blockers in a non-final round never reach the implementer, review history or reports", async () => {
    const calls = newCalls();
    const f = start(
      scenario(calls, (s) =>
        s.prompt.startsWith("You are a code reviewer")
          ? { structured: { ...approve, findings: [finding("SHADOW_ONLY_BLOCKER")] }, costEquivUsd: 0.25 }
          : undefined,
      ),
    );
    shadowOn(f);
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    // The shadow blocked in round 0, which the single review also sent back for another round.
    expect(shadowOf(f, run.id, 0)).toMatchObject({
      status: "completed",
      blocking: [{ title: "SHADOW_ONLY_BLOCKER" }],
    });
    expect(calls.implement).toHaveLength(2);
    expect(calls.implement[1]?.prompt).toContain("Single only");
    expect(calls.implement[1]?.prompt).not.toContain("SHADOW_ONLY_BLOCKER");
    // Round 1's single review sees only its own prior blockers.
    expect(calls.primary[1]?.prompt).toContain("Single only");
    expect(calls.primary[1]?.prompt).not.toContain("SHADOW_ONLY_BLOCKER");
    const state = f.store.getRunState<RunState>(run.id);
    expect(
      JSON.stringify([state?.reviewHistory, state?.lastReview, state?.reviewFollowUps, state?.feedback]),
    ).not.toContain("SHADOW_ONLY_BLOCKER");
    const report = f.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain("## Work log");
    expect(report).not.toContain("SHADOW_ONLY_BLOCKER");
    expect(report).not.toContain("review_shadow");
    expect(report).toContain("**Shadow review (included in total):**");
    expect(f.store.listInvocations(run.id).filter((i) => i.role === "review_shadow").length).toBeGreaterThan(
      0,
    );
  });
});
