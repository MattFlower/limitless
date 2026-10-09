import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Factory } from "../src/app.ts";
import { ownerDiagnostics } from "../src/db/owner-diagnostics.ts";
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
  test("holdout starts alongside implementation, reads only a base snapshot, and quick skips it", async () => {
    for (const profile of ["standard", "deep", "quick"] as const) {
      let implementStarted = false;
      let holdoutCalls = 0;
      let holdoutCwd = "";
      let snapshotChecked = false;
      let runId = "";
      const f = start(async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") {
          holdoutCalls++;
          holdoutCwd = s.cwd;
          expect(s.mode).toBe("readonly");
          expect(s.noTools).toBeFalsy();
          expect(s.maxToolCalls).toBeGreaterThan(0);
          expect(s.maxToolCalls).toBeLessThanOrEqual(50);
          expect(s.scratchDir).toBeTruthy();
          expect(s.privateSession).toBe(true);
          // The cwd alone doesn't confine tools: reads are limited to the snapshot and scratch, and
          // the implementer's worktree and factory state are denied wherever they live.
          expect(s.confineReads).toBe(true);
          expect(basename(dirname(s.cwd))).toStartWith(`limitless-holdout-${process.pid}-`);
          // The private CLI log in the shared temporary directory never holds scenario text.
          expect(s.redactOutput?.("H-1 private step")).toBe("[private]");
          expect(s.denyRead).toEqual(
            expect.arrayContaining([join(f.cfg.paths.work, runId), f.cfg.paths.home, f.cfg.paths.repos]),
          );
          expect(s.prompt).toContain("# Original request");
          expect(s.prompt).toContain("# Specification");
          expect(s.prompt).not.toContain("implementation marker");
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
          expect(existsSync(join(s.cwd, ".limitless.toml"))).toBe(true);
          expect(existsSync(join(s.cwd, ".git"))).toBe(false);
          while (!implementStarted && !s.signal.aborted) await Bun.sleep(10);
          // The implementer has now edited its worktree; the snapshot must not follow.
          await Bun.sleep(50);
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
          expect(existsSync(join(s.cwd, "implementation-marker.txt"))).toBe(false);
          expect(existsSync(join(s.cwd, "farewell.txt"))).toBe(false);
          return { structured: holdout };
        }
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          expect(existsSync(holdoutCwd)).toBe(false);
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("changed\n");
          snapshotChecked = true;
          return { structured: pass };
        }
        implementStarted = true;
        expect(
          s.prompt.includes(
            "A separate verifier will check private scenarios derived from the request, including edge and failure cases",
          ),
        ).toBe(profile !== "quick");
        return {
          files: {
            "farewell.txt": "goodbye\n",
            "greeting.txt": "changed\n",
            "implementation-marker.txt": "implementation marker",
          },
        };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file", profile });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(holdoutCalls).toBe(profile === "quick" ? 0 : 1);
      if (profile !== "quick") {
        expect(snapshotChecked).toBe(true);
        expect(existsSync(holdoutCwd)).toBe(false);
        expect(holdoutCwd).not.toBe(join(f.cfg.paths.work, run.id));
        const invs = f.store.listInvocations(run.id);
        expect(invs.find((i) => i.role === "holdout")?.provider).toBe("beta");
        expect(f.store.getRunState<RunState>(run.id)?.holdoutSameVendor).toBe(false);
      }
      await f.stop();
      f.store.close();
      factory = null;
    }
  });

  test("deep profile routes review as large while other stages keep the triaged complexity", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const route = spyOn(f.deps.router, "route");
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file", profile: "deep" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const complexity = (role: string) => route.mock.calls.filter(([r]) => r === role).map(([, c]) => c);
    expect(complexity("review")).toEqual(["large"]);
    expect(complexity("implement")).toEqual(["small"]);
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("completed holdout survives a stopped factory and is reused after restart", async () => {
    const secret = "OLD_FORMAT_PRIVATE_STEP_518";
    // Persisted under the former 3–8 scenario, two-edge-case schema.
    const oldHoldout = {
      scenarios: holdout.scenarios.map((s) => (s.id === "H-2" ? { ...s, steps: `run ${secret}` } : s)),
    };
    let holdoutCalls = 0;
    let implementations = 0;
    let blockImplement = true;
    let runId = "";
    let restarted: Factory | null = null;
    let privacyChecked = false;
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCalls++;
        return { structured: holdout };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        expect(s.prompt).toContain("H-3");
        expect(s.prompt).toContain(secret);
        return { structured: pass };
      }
      implementations++;
      if (restarted) {
        const store = restarted.store;
        expect(s.prompt).not.toContain(secret);
        expect(existsSync(join(s.cwd, "holdout-scenarios.json"))).toBe(false);
        expect(store.getArtifact(runId, "holdout-scenarios.json")).toBeNull();
        for (const artifact of store.listArtifacts(runId))
          expect(store.getArtifact(runId, artifact.name)).not.toContain(secret);
        expect(JSON.stringify(store.listEvents(runId))).not.toContain(secret);
        privacyChecked = true;
      }
      return blockImplement ? { delayMs: 30_000 } : { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.holdoutStatus !== "complete" ||
        f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("complete");
    f.scheduler.drain();
    expect(f.scheduler.activeRunIds).toEqual([run.id]);
    // Simulate a deploy deadline expiring while implement is still in flight.
    await f.stop();
    expect(f.store.getRun(run.id)?.status).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.implementedRound).toBeUndefined();
    expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.status).toBe("cancelled");
    const stopped = f.store.getRunState<RunState>(run.id);
    f.store.setRunState(run.id, { ...stopped, holdout: oldHoldout });
    // Resume a database from before owner diagnostics were introduced.
    f.store.db.exec(
      "DROP TABLE owner_diagnostics; DELETE FROM applied_migrations WHERE name = '20261009T223115-owner-diagnostics.sql'",
    );
    f.store.close();
    blockImplement = false;
    restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(1);
    expect(implementations).toBe(2);
    expect(privacyChecked).toBe(true);
    expect(restarted.store.getRunState<RunState>(run.id)?.holdout?.scenarios).toEqual(oldHoldout.scenarios);
    expect(restarted.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
    expect(ownerDiagnostics(restarted.store.db, run.id)).toEqual([]);
  });

  test("interrupted holdout is retried after restart and remains unpublished while stopped", async () => {
    let holdoutCalls = 0;
    let slow = true;
    let implementStarted = false;
    const holdoutCwds: string[] = [];
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCalls++;
        holdoutCwds.push(s.cwd);
        return slow ? { structured: holdout, delayMs: 30_000 } : { structured: holdout };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      implementStarted = true;
      // Stop inside the fake harness, never in a racing git add/commit that can leave a lock behind.
      return slow ? { fault: "block" } : { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.holdoutStatus !== "generating" ||
        !holdoutCwds.length ||
        !implementStarted) &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("generating");
    expect(implementStarted).toBe(true);
    await f.stop();
    expect(f.store.listInvocations(run.id).find((i) => i.role === "implement")?.status).toBe("cancelled");
    // Cancellation removes the snapshot but leaves the implementer's worktree for the restart.
    expect(holdoutCwds).toHaveLength(1);
    expect(existsSync(holdoutCwds[0] ?? "")).toBe(false);
    const worktree = f.store.getRunState<RunState>(run.id)?.worktreePath ?? "";
    expect(existsSync(join(worktree, "greeting.txt"))).toBe(true);
    expect(f.store.listArtifacts(run.id).map((a) => a.name)).not.toContain("holdout-scenarios.json");
    f.store.close();
    slow = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(holdoutCalls).toBe(2);
    expect(holdoutCwds[1]).not.toBe(holdoutCwds[0]);
    expect(existsSync(holdoutCwds[1] ?? "")).toBe(false);
    expect(restarted.store.getArtifact(run.id, "holdout-scenarios.json")).toContain("H-3");
  });

  test("failed holdout removes its base snapshot and keeps the run worktree", async () => {
    const holdoutCwds: string[] = [];
    let runId = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        holdoutCwds.push(s.cwd);
        return { fault: "throw", error: "holdout exploded" };
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    const deadline = Date.now() + 10_000;
    while (f.store.listStages(runId).find((s) => s.name === "holdout")?.status !== "failed") {
      if (Date.now() > deadline) throw new Error("holdout failure timed out");
      await Bun.sleep(10);
    }
    expect(holdoutCwds.length).toBeGreaterThan(0);
    for (const cwd of holdoutCwds) expect(existsSync(cwd)).toBe(false);
    const worktree = f.store.getRunState<RunState>(runId)?.worktreePath ?? "";
    expect(worktree).not.toBe("");
    expect(existsSync(join(worktree, "greeting.txt"))).toBe(true);
    expect(f.store.getRunState<RunState>(runId)?.holdout).toBeUndefined();
  });

  test("holdout uses same-vendor fallback and invalid output routes to another model", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout" && s.target.provider === "beta") return { structured: { scenarios: [] } };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "holdout")
        .map((i) => i.status),
    ).toEqual(["error", "ok"]);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutSameVendor).toBe(true);
    expect(f.store.getRunState<RunState>(run.id)?.holdoutModelId).toBe("alpha/m");
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("missing holdout verdict fails despite an overall pass claim", async () => {
    let verifyCalls = 0;
    let implementCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        verifyCalls++;
        return {
          structured:
            verifyCalls === 1 ? { ...pass, criteria: pass.criteria.filter((c) => c.id !== "H-3") } : pass,
        };
      }
      implementCalls++;
      if (implementCalls === 2) {
        expect(s.prompt).toContain("H-3");
        expect(f.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBeUndefined();
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(2);
    expect(verifyCalls).toBe(2);
  });
});
