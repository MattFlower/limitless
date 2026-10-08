import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { StageName } from "../src/core/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import {
  approve,
  type Handler,
  holdout,
  pass,
  pipelineSetup,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start } = pipelineSetup({
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

describe("pipeline (fake agents, real git + gates)", () => {
  test("asks the human when triage finds blocking ambiguity, then continues", async () => {
    let specPrompt = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage")
        return {
          structured: triage({ ambiguity: "high", blocking_questions: ["Formal or casual farewell?"] }),
        };
      if (role === "spec") {
        specPrompt = s.prompt;
        return { structured: spec };
      }
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["waiting_input"])).toBe("waiting_input");
    expect(f.store.listQuestions(run.id)[0]?.question).toBe("Formal or casual farewell?");
    f.answer(run.id, "Casual", "tester");
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(specPrompt).toContain("A: Casual");
  });
});

for (const phase of ["clarify", "spec"] as const) {
  test.each(["parked", "transition", "entering", "cancelled"] as const)(
    `drain parks ${phase} answer waits (%s)`,
    async (when) => {
      const question = "Formal or casual farewell?";
      const specPrompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage")
          return {
            structured: triage(
              phase === "clarify" ? { ambiguity: "high", blocking_questions: [question] } : {},
            ),
          };
        if (role === "spec") {
          specPrompts.push(s.prompt);
          return { structured: { ...spec, blocking_questions: phase === "spec" ? [question] : [] } };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") return { structured: pass };
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      let drained = () => {};
      const entered = new Promise<void>((resolve) => {
        drained = resolve;
      });
      const unsubscribe = f.store.subscribe((msg) => {
        if (when === "entering" && msg.kind === "run" && msg.run.status === "waiting_input") {
          f.scheduler.drain();
          drained();
        }
      });
      try {
        const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
        // The parking deadline starts at the drain, not at run startup (clone, fetch, triage).
        if (when === "entering") await entered;
        else {
          await waitFor(f, run.id, ["waiting_input"]);
          f.scheduler.drain();
        }
        if (when === "transition") f.answer(run.id, "Casual", "tester");
        if (when === "cancelled") f.cancelRun(run.id, "tester");
        expect(await waitFor(f, run.id, ["queued", "cancelled"], 500)).toBe(
          when === "cancelled" ? "cancelled" : "queued",
        );
        expect(f.scheduler.activeRunIds).toEqual([]);
        if (when === "cancelled") {
          expect(f.scheduler.parkedRunIds).toEqual([]);
          expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
          expect(f.store.getRun(run.id)?.error).toBe("cancelled by tester");
          return;
        }
        expect(f.store.getRun(run.id)?.stage).toBeNull();
        expect(f.store.getRunState<RunState>(run.id)).toMatchObject({ phase, parked: true });
        expect(f.scheduler.parkedRunIds).toEqual([run.id]);
        if (when === "parked") {
          f.scheduler.resume();
          await waitFor(f, run.id, ["waiting_input"]);
          expect(f.store.listQuestions(run.id)).toHaveLength(1);
          f.scheduler.drain();
          await waitFor(f, run.id, ["queued"], 500);
        }
        if (when !== "transition") f.answer(run.id, "Casual", "tester");
        expect(f.store.listQuestions(run.id)[0]?.answer).toBe("Casual");
        f.scheduler.tick();
        expect(f.scheduler.activeRunIds).toEqual([]);
        f.scheduler.resume();
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        expect(specPrompts.at(-1)).toContain("A: Casual");
        expect(f.store.listQuestions(run.id)).toHaveLength(1);
        expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("done");
      } finally {
        unsubscribe();
      }
    },
  );
}

test("drain blocks queued starts and parks the active run at its next boundary", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const atTriage = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let firstSignal: AbortSignal | undefined;
  let calls = 0;
  const f = start(async (s) => {
    if (roleOf(s) === "triage") {
      calls++;
      if (calls === 1) {
        firstSignal = s.signal;
        entered();
        await held;
      }
      return { structured: triage({ suggested_profile: "quick" }) };
    }
    if (roleOf(s) === "review") return { structured: approve };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  try {
    const first = await f.createRun({ repo: repoDir, prompt: "change" });
    await atTriage;
    expect(f.scheduler.draining).toBe(false);
    f.scheduler.drain();
    f.scheduler.drain();
    const queued = await f.createRun({ repo: repoDir, prompt: "second" });
    const retry = await f.retryRun(first.id);
    const extra = await Promise.all(
      Array.from({ length: 3 }, () => f.createRun({ repo: repoDir, prompt: "more" })),
    );
    await Promise.resolve(); // Queue notifications also pass through tick.
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([first.id]);
    expect(firstSignal?.aborted).toBe(false);
    expect(f.store.getRun(queued.id)?.status).toBe("queued");
    expect(f.store.getRun(retry.id)?.status).toBe("queued");
    release();
    expect(await waitFor(f, first.id, ["queued"])).toBe("queued");
    while (f.scheduler.activeRunIds.length) await Bun.sleep(10);
    expect(f.scheduler.activeRunIds).toEqual([]);
    expect(calls).toBe(1);
    expect(f.store.getRunState<RunState>(first.id)?.parked).toBe(true);
    expect(f.store.getRunDetail(first.id)?.stages.map((s) => s.name)).not.toContain("implement");
    for (const run of [queued, retry, ...extra]) expect(f.store.listStages(run.id)).toEqual([]);
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([]);
    f.scheduler.resume();
    f.scheduler.resume();
    expect(f.scheduler.activeRunIds.length).toBe(f.cfg.maxConcurrentRuns);
    expect(f.scheduler.activeRunIds.length).toBeLessThanOrEqual(f.cfg.maxConcurrentRuns);
    expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await waitFor(f, queued.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(await waitFor(f, retry.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    for (const run of extra) {
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    }
    await f.stop();
    f.scheduler.drain();
    const stopped = await f.createRun({ repo: repoDir, prompt: "after stop" });
    f.scheduler.resume();
    f.scheduler.tick();
    expect(f.scheduler.activeRunIds).toEqual([]);
    expect(f.store.getRun(stopped.id)?.status).toBe("queued");
  } finally {
    release();
  }
});

for (const profile of ["quick", "standard"] as const) {
  test(`drain after implement preserves the ${profile} checkpoint and resumes at gates after restart`, async () => {
    const holdoutDone = Promise.withResolvers<void>();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const implementing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let implementations = 0;
    const handler: Handler = async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: profile }) };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        await holdoutDone.promise;
        return { structured: holdout };
      }
      if (role === "verify") return { structured: pass };
      if (role === "review") return { structured: approve };
      if (role === "implement") {
        implementations++;
        entered();
        await held;
        return { files: { "farewell.txt": "goodbye\n" } };
      }
      throw new Error(`unexpected role ${role}`);
    };
    const f = start(handler);
    try {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile });
      await implementing;
      const worktree = f.store.getRunState<RunState>(run.id)?.worktreePath;
      expect(worktree).toBeDefined();
      f.scheduler.drain();
      release();
      const deadline = Date.now() + 5000;
      while (
        !f.store.listStages(run.id).some((s) => s.name === "implement" && s.status === "succeeded") &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.status).toBe("succeeded");
      expect(f.store.listStages(run.id).some((s) => s.name === "gates")).toBe(false);
      if (profile === "standard") expect(f.scheduler.activeRunIds).toEqual([run.id]);
      holdoutDone.resolve();
      expect(await waitFor(f, run.id, ["queued"])).toBe("queued");
      while (f.scheduler.activeRunIds.length) await Bun.sleep(10);
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint).toMatchObject({ phase: "loop", round: 0, implementedRound: 0, parked: true });
      expect(f.store.getRun(run.id)).toMatchObject({ status: "queued", stage: null, finishedAt: null });
      const completed: StageName[] = [
        "prepare",
        "triage",
        ...(profile === "standard" ? (["spec", "holdout"] as const) : []),
        "implement",
      ];
      expect(f.store.listStages(run.id).map((stage) => stage.name)).toEqual(completed);
      expect(worktree && existsSync(worktree)).toBe(true);
      await f.stop();
      f.store.close();

      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementations).toBe(1);
      expect(resumed.store.listStages(run.id).map((stage) => stage.name)).toEqual([
        ...completed,
        "gates",
        "audit",
        "review",
        ...(profile === "standard" ? (["verify"] as const) : []),
        "deliver",
      ]);
      expect(resumed.store.getRunState<RunState>(run.id)).toMatchObject({
        round: 0,
        worktreePath: worktree,
        parked: false,
      });
    } finally {
      release();
      holdoutDone.resolve();
    }
  });
}

test("drain during verification parks before delivery", async () => {
  const f = start((s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify") {
      f.scheduler.drain();
      return { structured: pass };
    }
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(f, run.id, ["queued"])).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)).toMatchObject({ phase: "deliver", parked: true, round: 0 });
  expect(f.store.listStages(run.id).at(-1)).toMatchObject({ name: "verify", status: "succeeded" });
  f.scheduler.resume();
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(f.store.listStages(run.id).filter((s) => s.name === "verify")).toHaveLength(1);
});

test("drain during review finishes the round (review and verify once) before parking", async () => {
  let reviews = 0;
  const f = start((s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") {
      reviews++;
      f.scheduler.drain();
      return { structured: approve };
    }
    if (role === "verify") return { structured: pass };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
  expect(await waitFor(f, run.id, ["queued"])).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)).toMatchObject({ phase: "deliver", parked: true, round: 0 });
  f.scheduler.resume();
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(reviews).toBe(1);
  for (const name of ["gates", "review", "verify"] as const)
    expect(f.store.listStages(run.id).filter((s) => s.name === name)).toHaveLength(1);
});

test("cancellation wins over parking when both are requested during a stage", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const implementing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = start(async (s) => {
    if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (roleOf(s) === "implement") {
      entered();
      await held;
      return { files: { "farewell.txt": "goodbye\n" } };
    }
    return { structured: approve };
  });
  try {
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    await implementing;
    f.scheduler.drain();
    expect(f.cancelRun(run.id, "tester")).toBe(true);
    release();
    expect(await waitFor(f, run.id, ["cancelled"])).toBe("cancelled");
    expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
    expect(f.scheduler.parkedRunIds).toEqual([]);
  } finally {
    release();
  }
});

test("restart dispatches parked runs by priority then creation time", async () => {
  const started: string[] = [];
  const handler: Handler = (s) => {
    const role = roleOf(s);
    if (role === "triage") {
      started.push(
        s.prompt.includes("high old") ? "high old" : s.prompt.includes("high new") ? "high new" : "low",
      );
      return { structured: triage({ suggested_profile: "quick" }) };
    }
    if (role === "review") return { structured: approve };
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const f = start(handler);
  f.scheduler.drain();
  const low = await f.createRun({ repo: repoDir, prompt: "low", priority: 1, profile: "quick" });
  await Bun.sleep(2);
  const highOld = await f.createRun({ repo: repoDir, prompt: "high old", priority: 9, profile: "quick" });
  await Bun.sleep(2);
  const highNew = await f.createRun({ repo: repoDir, prompt: "high new", priority: 9, profile: "quick" });
  for (const [run, round] of [
    [low, 1],
    [highOld, 2],
    [highNew, 3],
  ] as const) {
    f.store.updateRun(run.id, { status: "queued" }, {
      phase: "prepare",
      round,
      parked: true,
      answers: [],
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    } satisfies RunState);
  }
  expect(f.scheduler.parkedRunIds).toEqual([highOld.id, highNew.id, low.id]);
  expect(started).toEqual([]);
  await f.stop();
  f.store.close();

  // One slot so dispatch order is also triage order; with more, equal-priority runs race.
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(join(home, "cfg", "config.toml"), "[limits]\nmax_concurrent_runs = 1\n");
  const resumed = start(handler);
  expect(resumed.cfg.maxConcurrentRuns).toBe(1);
  for (const run of [low, highOld, highNew]) {
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  }
  expect(started).toEqual(["high old", "high new", "low"]);
  for (const [run, round] of [
    [low, 1],
    [highOld, 2],
    [highNew, 3],
  ] as const) {
    expect(resumed.store.getRunState<RunState>(run.id)).toMatchObject({ round, parked: false });
  }
});
