import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import * as baselineCache from "../src/gates/cache.ts";
import { gateSlots } from "../src/gates/slots.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { testWaits } from "./wait-support.ts";

const prepareWaits = testWaits();
const preparing = new Set<Promise<unknown>>();
const barriers = new Set<() => void>();
afterEach(async () => {
  for (const release of barriers) release();
  barriers.clear();
  await Promise.allSettled([...preparing]);
});

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub, advanceBase, wait } = pipelineSetup({
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
  describe("baseline cache", () => {
    const lines = (path: string) =>
      existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
    const cacheRows = (f: Factory) =>
      f.store.db.query("SELECT base_sha, gate_run, run_id, created_at FROM passing_baselines").all() as {
        base_sha: string;
        gate_run: string;
        run_id: string;
        created_at: number;
      }[];
    const quick = (s: AgentSpec): FakeReply => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    async function commitGates(toml: string): Promise<void> {
      writeFileSync(join(repoDir, ".limitless.toml"), toml);
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "gates"], {
        cwd: repoDir,
      });
    }
    async function finish(f: Factory, over: Partial<Parameters<Factory["createRun"]>[0]> = {}) {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick", ...over });
      await waitFor(f, run.id, ["succeeded", "failed", "needs_human", "cancelled"]);
      return { run, state: f.store.getRunState<RunState>(run.id) };
    }

    // Cache identity and single-flight cases need prepare, not an implementation and delivery per lookup.
    // Keep full pipelines below wherever assertions depend on post-implement gates or delivery.
    function prepared(f: Factory) {
      const signal = prepareWaits.signal;
      const task = (async () => {
        signal.throwIfAborted();
        await f.scheduler.stop();
        signal.throwIfAborted();
        const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
        signal.throwIfAborted();
        await executeRun(
          { ...f.deps, faults: { "stage:triage:before": { action: "kill" } } },
          run.id,
          signal,
        );
        signal.throwIfAborted();
        return { run, state: f.store.getRunState<RunState>(run.id) };
      })();
      preparing.add(task);
      return task.finally(() => preparing.delete(task));
    }

    test("a second run on the same base reuses a passing baseline", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      const first = await finish(f);
      // Baseline and the post-implement gates.
      expect(lines(count)).toBe(2);
      expect(first.state?.baselineCached).toBe(false);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([first.run.id]);
      const second = await finish(f);
      // Only the post-implement gates executed.
      expect(lines(count)).toBe(3);
      expect(second.state?.baselineCached).toBe(true);
      expect(second.state?.baseline).toEqual(first.state?.baseline ?? null);
      expect(f.store.getRun(second.run.id)?.status).toBe("succeeded");
      const prepare = f.store.listStages(second.run.id).find((s) => s.name === "prepare");
      expect(prepare?.summary).toContain("baseline reused from cache");
      expect(f.store.listStages(first.run.id).find((s) => s.name === "prepare")?.summary).not.toContain(
        "cache",
      );
      expect(JSON.parse(f.store.getArtifact(second.run.id, "baseline-gates.json") ?? "{}")).toEqual(
        second.state?.baseline,
      );
    });

    // #556 measurement (2026-10-16): alone 9.82 s, paired load 17.06 s; multiple real-Git pipelines.
    test("a flaky base that failed twice is not cached, so the next run blocks the regression", async () => {
      const count = join(home, "gate-runs");
      // Fails the first baseline and its retry; later it fails only once the change exists.
      const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -gt 2 || exit 1; test ! -f farewell.txt`;
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`);
      const f = start(quick);
      const first = await finish(f);
      expect(first.state?.baseline?.checks[0]?.firstAttempt?.ok).toBe(false);
      expect(first.state?.baseline?.checks[0]?.ok).toBe(false);
      expect(cacheRows(f)).toEqual([]);
      const second = await finish(f);
      expect(second.state?.baselineCached).toBe(false);
      expect(second.state?.baseline?.checks[0]?.ok).toBe(true);
      expect(second.state?.lastGates?.map((g) => [g.name, g.verdict, g.blocking])).toEqual([
        ["check", "regressed", true],
      ]);
      expect(f.store.getRun(second.run.id)?.status).not.toBe("succeeded");
    }, 45_000);

    test("concurrent runs on one base execute the baseline once", async () => {
      const count = join(home, "gate-runs");
      const check = `test -f farewell.txt && exit 0; echo base >> '${count}'`;
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`);
      const f = start(quick);
      // Both callers enter the flight before the leader can finish, without a timed gate sleep.
      const ready = Promise.withResolvers<void>();
      barriers.add(ready.resolve);
      const signal = prepareWaits.signal;
      let callers = 0;
      const singleFlight = baselineCache.singleFlight;
      const flight = spyOn(baselineCache, "singleFlight").mockImplementation(async (...args) => {
        if (++callers === 2) ready.resolve();
        await ready.promise;
        signal.throwIfAborted();
        return singleFlight(...args);
      });
      const [a, b] = await Promise.all([prepared(f), prepared(f)]).finally(() => {
        ready.resolve();
        flight.mockRestore();
      });
      expect(lines(count)).toBe(1);
      expect([a.state?.baselineCached, b.state?.baselineCached].sort()).toEqual([false, true]);
      expect(cacheRows(f)).toHaveLength(1);
    });

    describe("uncacheable baselines on one base", () => {
      let slots = 1;
      beforeEach(() => {
        slots = gateSlots.limit;
      });
      afterEach(() => gateSlots.setLimit(slots));
      // Each attempt waits for its peers (bounded to 10 s); adjacent starts mean overlap.
      const overlapping = (log: string) => readFileSync(log, "utf8").includes("start\nstart\n");
      const timed = (log: string, exit: number) => {
        // The failing leader's two sequential attempts skip waiting; only its waiters overlap.
        const starts = exit === 0 ? "3" : `$(( $(grep -c '^start$' '${log}') <= 2 ? 0 : 4 ))`;
        return `test -f farewell.txt && exit 0; echo start >> '${log}'; starts=${starts}; deadline=$(($(date +%s) + 10)); while [ $(grep -c '^start$' '${log}') -lt $starts ] && [ $(date +%s) -lt $deadline ]; do sleep 0.05; done; echo end >> '${log}'; exit ${exit}`;
      };

      test("with the kill switch, same-base runs execute their baselines concurrently", async () => {
        const log = join(home, "gate-log");
        await commitGates(`[gates]\nchecks = [{ name = "check", run = "${timed(log, 0)}" }]\n`);
        const f = start(quick);
        f.cfg.baselineCache = false;
        gateSlots.setLimit(3);
        const runs = await Promise.all([prepared(f), prepared(f), prepared(f)]);
        expect(runs.map((r) => r.state?.baselineCached)).toEqual([false, false, false]);
        expect(readFileSync(log, "utf8").split("\n").slice(0, 3)).toEqual(["start", "start", "start"]);
      });

      test("a failing flight releases its waiters to run concurrently", async () => {
        const log = join(home, "gate-log");
        await commitGates(`[gates]\nchecks = [{ name = "check", run = "${timed(log, 1)}" }]\n`);
        const f = start(quick);
        gateSlots.setLimit(3);
        // All callers must reach the flight before the leader's immediate failure can finish.
        const ready = Promise.withResolvers<void>();
        barriers.add(ready.resolve);
        const signal = prepareWaits.signal;
        let callers = 0;
        const singleFlight = baselineCache.singleFlight;
        const synchronized: typeof singleFlight = async (...args) => {
          if (++callers === 3) ready.resolve();
          await ready.promise;
          signal.throwIfAborted();
          return singleFlight(...args);
        };
        const flight = spyOn(baselineCache, "singleFlight").mockImplementation(synchronized);
        const runs = await Promise.all([prepared(f), prepared(f), prepared(f)]).finally(() => {
          ready.resolve();
          flight.mockRestore();
        });
        expect(runs.map((r) => r.state?.baseline?.checks[0]?.ok)).toEqual([false, false, false]);
        expect(cacheRows(f)).toEqual([]);
        expect(overlapping(log)).toBe(true);
      });
    });

    test("an unknown build SHA neither reads nor writes the cache", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      f.deps.buildSha = undefined;
      await finish(f);
      const second = await finish(f);
      expect([lines(count), second.state?.baselineCached]).toEqual([4, false]);
      expect(cacheRows(f)).toEqual([]);
    });

    test("a changed gate config or base commit misses", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      await finish(f);
      expect(lines(count)).toBe(2);
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'; true" }]\n`);
      const changedConfig = await finish(f);
      expect([lines(count), changedConfig.state?.baselineCached]).toEqual([4, false]);
      writeFileSync(join(repoDir, "greeting.txt"), "hello again\n");
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "base"], {
        cwd: repoDir,
      });
      const changedBase = await finish(f);
      expect([lines(count), changedBase.state?.baselineCached]).toEqual([6, false]);
      expect(cacheRows(f)).toHaveLength(3);
    });

    test("a changed gate environment misses", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const saved = { npm: process.env.npm_config_ignore_scripts, flag: process.env.MY_GATE_FLAG };
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      try {
        process.env.npm_config_ignore_scripts = "false";
        process.env.MY_GATE_FLAG = "a";
        const f = start(quick);
        await prepared(f);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
        process.env.npm_config_ignore_scripts = "true";
        expect((await prepared(f)).state?.baselineCached).toBe(false);
        // Undeclared variables don't key the cache; declared ones do.
        process.env.MY_GATE_FLAG = "b";
        expect((await prepared(f)).state?.baselineCached).toBe(true);
        f.cfg.baselineEnv = ["MY_GATE_FLAG"];
        expect((await prepared(f)).state?.baselineCached).toBe(false);
        process.env.MY_GATE_FLAG = "c";
        expect((await prepared(f)).state?.baselineCached).toBe(false);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
      } finally {
        restore("npm_config_ignore_scripts", saved.npm);
        restore("MY_GATE_FLAG", saved.flag);
      }
    });

    test("a changed nonsecret setting with a secret-looking name misses", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const names = ["GOPRIVATE", "NODE_TLS_REJECT_UNAUTHORIZED"] as const;
      const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
      try {
        process.env.GOPRIVATE = "example.com/*";
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
        const f = start(quick);
        await prepared(f);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
        process.env.GOPRIVATE = "other.example/*";
        expect((await prepared(f)).state?.baselineCached).toBe(false);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        expect((await prepared(f)).state?.baselineCached).toBe(false);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
      } finally {
        for (const k of names) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    });

    // #556 measurement (2026-10-16): alone 9.37 s, paired load 10.62 s; multiple real-Git pipelines.
    test("a timed-out or cancelled baseline is not cached", async () => {
      const count = join(home, "gate-runs");
      // The first execution outlasts its timeout; later ones pass.
      const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -ne 1 || sleep 5`;
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "${check}", timeoutSec = 1 }]\n`);
      const f = start(quick);
      const timedOut = await finish(f);
      expect(timedOut.state?.baseline?.checks[0]?.timedOut).toBe(true);
      expect(cacheRows(f)).toEqual([]);
      const next = await finish(f);
      expect(next.state?.baselineCached).toBe(false);
      expect(next.state?.baseline?.checks[0]?.ok).toBe(true);
      expect(cacheRows(f)).toHaveLength(1);

      rmSync(count);
      await commitGates(
        `[gates]\nchecks = [{ name = "check", run = "${check.replace("sleep 5", "sleep 10")}" }]\n`,
      );
      const cancelled = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      // Redirection creates the file before echo writes the counted attempt.
      await wait(() => existsSync(count) && readFileSync(count, "utf8").includes("x\n"), {
        timeoutMs: 20_000,
        description: "baseline never started",
        subscribe(wake) {
          const watcher = watch(home, wake);
          return () => watcher.close();
        },
      });
      f.cancelRun(cancelled.id);
      expect(await waitFor(f, cancelled.id, ["cancelled", "failed"])).toBe("cancelled");
      expect(cacheRows(f)).toHaveLength(1);
      const after = await finish(f);
      expect(after.state?.baselineCached).toBe(false);
      // Cancelled baseline, then this run's baseline and post-implement gates.
      expect(lines(count)).toBe(3);
    });

    // #556 measurement (2026-10-16): alone 12.15 s, paired load 14.11 s; multiple real-Git pipelines.
    test("a bypass run refreshes a passing entry and evicts it when the base fails", async () => {
      const count = join(home, "gate-runs");
      const broken = join(home, "broken");
      await commitGates(
        `[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'; test ! -f '${broken}'" }]\n`,
      );
      const f = start(quick);
      const primed = await finish(f);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([primed.run.id]);
      const bypass = await finish(f, { noBaselineCache: true });
      expect(f.store.getRun(bypass.run.id)?.noBaselineCache).toBe(true);
      expect([lines(count), bypass.state?.baselineCached]).toEqual([4, false]);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([bypass.run.id]);
      const refreshed = cacheRows(f);

      expect(refreshed).toHaveLength(1);

      // A failing fresh baseline contradicts the cached pass, so it is evicted, not replaced.
      writeFileSync(broken, "");
      const failing = await finish(f, { noBaselineCache: true });
      expect(failing.state?.baseline?.checks[0]?.ok).toBe(false);
      expect(cacheRows(f)).toEqual([]);
      const retried = await f.retryRun(failing.run.id);
      expect(retried.noBaselineCache).toBe(true);
      await waitFor(f, retried.id, ["succeeded", "failed", "needs_human"]);
      expect(cacheRows(f)).toEqual([]);

      // The config kill switch bypasses reads too, and still refreshes on a pass.
      rmSync(broken);
      f.cfg.baselineCache = false;
      const before = lines(count);
      const switchedOff = await finish(f);
      expect([lines(count) - before, switchedOff.state?.baselineCached]).toEqual([2, false]);
      expect(cacheRows(f).map((r) => r.run_id)).toEqual([switchedOff.run.id]);
    });

    test("post-rebase gates execute when prepare reused the cached baseline", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const bare = await githubFixture();
      let advance = false;
      const f = start(async (s) => {
        if (advance && roleOf(s) === "review") {
          advance = false;
          await advanceBase(bare, "base.txt", "new base\n");
        }
        return quick(s);
      });
      registerGithub(f, bare);
      const first = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, first.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(lines(count)).toBe(2);
      advance = true;
      const second = await f.createRun({ repo: "test/repo", prompt: "Add farewell too", profile: "quick" });
      expect(await waitFor(f, second.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(f.store.getRunState<RunState>(second.id)?.baselineCached).toBe(true);
      // Post-implement gates, then the gates after merging the advanced base.
      expect(lines(count)).toBe(4);
      expect(f.store.listStages(second.id).filter((s) => s.name === "gates")).toHaveLength(2);
    });
  });
});
