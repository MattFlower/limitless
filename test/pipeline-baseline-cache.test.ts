import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { BaselineCacheKey } from "../src/db/store.ts";
import * as baselineCache from "../src/gates/cache.ts";
import { localExecutor } from "../src/gates/executor.ts";
import * as gateRunner from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import * as proc from "../src/util/proc.ts";
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
      f.store.db
        .query("SELECT base_sha, env_hash, gate_run, run_id, created_at FROM passing_baselines")
        .all() as {
        base_sha: string;
        env_hash: string;
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

    describe("gate Bun identity", () => {
      const restores: (() => void)[] = [];
      afterEach(() => {
        for (const restore of restores.splice(0).reverse()) restore();
      });
      function stub(body: string) {
        const bin = join(home, "gate-bin");
        const log = join(home, "bun-probes");
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          join(bin, "bun"),
          `#!/bin/sh\nprintf '%s\\n' "$PWD|$PATH|$CI|$NO_COLOR|$FORCE_COLOR" >> '${log}'\n${body}\n`,
          { mode: 0o755 },
        );
        return { bin, log };
      }
      function onPath(bin: string) {
        const saved = process.env.PATH;
        process.env.PATH = `${bin}:${saved}`;
        restores.push(() => {
          if (saved === undefined) delete process.env.PATH;
          else process.env.PATH = saved;
        });
      }
      function observeKeys() {
        const spy = spyOn(baselineCache, "baselineCacheKey");
        restores.push(() => spy.mockRestore());
        return spy;
      }
      async function countingGate() {
        const count = join(home, "gate-runs");
        await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
        return count;
      }

      test("an in-place gate Bun upgrade changes cache identity, once per prepare", async () => {
        const count = await countingGate();
        const { bin, log } = stub("echo 1.4.3");
        onPath(bin);
        const keys = observeKeys();
        const probe = spyOn(proc, "sh");
        restores.push(() => probe.mockRestore());
        const f = start(quick);
        f.deps.bunVersion = "9.9.9";
        const first = await prepared(f);
        const firstRows = cacheRows(f);
        const firstKey = keys.mock.results[0]?.value;
        expect([first.state?.baselineCached, lines(count), lines(log)]).toEqual([false, 1, 1]);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
        expect([lines(count), lines(log)]).toEqual([1, 2]);
        expect(cacheRows(f)).toEqual(firstRows);
        expect(keys.mock.results[1]?.value).toEqual(firstKey);
        expect(firstKey).toEqual(expect.objectContaining({ envHash: firstRows[0]?.env_hash }));

        stub("echo 1.4.4");
        const upgraded = await prepared(f);
        expect([upgraded.state?.baselineCached, lines(count), lines(log)]).toEqual([false, 2, 3]);
        expect(
          cacheRows(f)
            .map((r) => r.run_id)
            .sort(),
        ).toEqual([first.run.id, upgraded.run.id].sort());
        expect(keys.mock.results[2]?.value).not.toEqual(firstKey);
        expect(new Set(cacheRows(f).map((r) => r.env_hash)).size).toBe(2);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
        expect([lines(count), lines(log), cacheRows(f).length]).toEqual([2, 4, 2]);
        expect(keys.mock.results[3]?.value).toEqual(keys.mock.results[2]?.value);
        expect(keys.mock.calls.map(([i]) => i.bunVersion)).toEqual(["1.4.3", "1.4.3", "1.4.4", "1.4.4"]);

        const probes = probe.mock.calls.filter(([cmd]) => cmd[0] === "bun" && cmd[1] === "--version");
        expect(probes).toHaveLength(4);
        const [, options] = probes[0] ?? [];
        expect(probes[0]?.[0]).toEqual(["bun", "--version"]);
        expect(options?.timeoutMs).toBe(2_000);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        expect(options?.env).toEqual(gateRunner.gateEnv());
        const [cwd, path, ...flags] = readFileSync(log, "utf8").trim().split("\n")[0]?.split("|") ?? [];
        expect(realpathSync(cwd ?? "")).toBe(realpathSync(join(f.cfg.paths.runs, first.run.id)));
        expect(realpathSync(options?.cwd ?? "")).toBe(realpathSync(cwd ?? ""));
        expect(realpathSync(cwd ?? "")).not.toBe(realpathSync(first.state?.worktreePath ?? ""));
        expect(path).toBe(options?.env?.PATH);
        expect(keys.mock.calls[0]?.[0].envDigest).toBe(
          baselineCache.gateEnvDigest(options?.env ?? {}, f.cfg.baselineEnv),
        );
        expect(flags).toEqual(["1", "1", "0"]);
      });

      test.each(["local", "lan", "excluded"] as const)(
        "%s execution uses the appropriate Bun version",
        async (executor) => {
          const count = await countingGate();
          const { bin, log } = stub("echo 1.4.3");
          onPath(bin);
          const keys = observeKeys();
          // Exercise the executor interface without workers or network services.
          const f = start(quick, false, false, { gateExecutor: { ...localExecutor(), kind: "lan" } });
          f.cfg.gateExecutor = executor === "local" ? "local" : "lan";
          f.cfg.workers.repos = executor === "lan" ? ["local/target"] : [];
          f.deps.bunVersion = "2.0.0";
          const first = await prepared(f);
          f.deps.bunVersion = "2.0.1";
          const second = await prepared(f);
          const lan = executor === "lan";
          expect(keys.mock.calls.map(([i]) => i.executor)).toEqual(lan ? ["lan", "lan"] : ["local", "local"]);
          expect(keys.mock.calls.map(([i]) => i.bunVersion)).toEqual(
            lan ? ["2.0.0", "2.0.1"] : ["1.4.3", "1.4.3"],
          );
          expect(first.state?.baselineCached).toBe(false);
          expect(second.state?.baselineCached).toBe(!lan);
          expect([cacheRows(f).length, lines(count), lines(log)]).toEqual(lan ? [2, 2, 0] : [1, 1, 2]);
          if (lan) expect(keys.mock.results[0]?.value).not.toEqual(keys.mock.results[1]?.value);
          else expect(keys.mock.results[0]?.value).toEqual(keys.mock.results[1]?.value);
        },
      );

      test.each([
        ["missing", null, "none"],
        ["launch failure", "#!/missing-interpreter", "none"],
        ["nonzero with valid stdout", "echo 1.4.3; exit 1", "none"],
        ["timeout with valid stdout", "echo 1.4.3; exec /bin/sleep 30", "none"],
        ["empty", "exit 0", "none"],
        ["malformed", "echo 'not a version'", "none"],
        ["multiline", "printf '1.4.3\\n1.4.4\\n'", "none"],
        ["undotted", "echo 1", "none"],
        ["surrounding whitespace", "printf ' \\t1.4.3\\n'", "1.4.3"],
        ["prerelease and build", "echo 1.4.3-canary.1+build.2", "1.4.3-canary.1+build.2"],
        ["stderr ignored", "echo 1.4.3; echo diagnostic >&2", "1.4.3"],
      ])("probe handles %s", async (_name, body, expected) => {
        const { bin } = stub(body ?? "");
        if (body === null) rmSync(join(bin, "bun"));
        if (body?.startsWith("#!")) writeFileSync(join(bin, "bun"), `${body}\n`);
        expect(
          await baselineCache.gateBunVersion(
            home,
            { ...gateRunner.gateEnv(), PATH: bin },
            prepareWaits.signal,
          ),
        ).toBe(expected);
      });

      test.each([
        ["missing", null],
        ["nonzero", "echo 1.4.3; exit 1"],
        ["malformed", "echo 'not a version'"],
      ])("unusable Bun (%s) keys as none and still caches a passing baseline", async (_name, body) => {
        const count = await countingGate();
        const { bin, log } = stub(body ?? "");
        if (body === null) rmSync(join(bin, "bun"));
        const env = { ...gateRunner.gateEnv(), PATH: bin };
        const gateEnv = spyOn(gateRunner, "gateEnv").mockReturnValue(env);
        restores.push(() => gateEnv.mockRestore());
        const keys = observeKeys();
        const f = start(quick);
        const first = await prepared(f);
        const second = await prepared(f);
        expect(keys.mock.calls.map(([i]) => i.bunVersion)).toEqual(["none", "none"]);
        expect([first.state?.baselineCached, second.state?.baselineCached]).toEqual([false, true]);
        expect([lines(count), lines(log), cacheRows(f).length]).toEqual([1, body === null ? 0 : 2, 1]);
      });

      test("a timed-out probe with a successful exit still keys as none", async () => {
        const original = proc.sh;
        const spy = spyOn(proc, "sh").mockImplementation(async (cmd, options) => {
          if (cmd[0] !== "bun" || cmd[1] !== "--version") return original(cmd, options);
          return { stdout: "1.4.3\n", stderr: "", exitCode: 0, timedOut: true };
        });
        restores.push(() => spy.mockRestore());
        expect(await baselineCache.gateBunVersion(home, gateRunner.gateEnv(), prepareWaits.signal)).toBe(
          "none",
        );
      });

      test("a thrown probe launch error keys as none", async () => {
        const original = proc.sh;
        const spy = spyOn(proc, "sh").mockImplementation(async (cmd, options) => {
          if (cmd[0] !== "bun" || cmd[1] !== "--version") return original(cmd, options);
          throw new Error("probe launch failed");
        });
        restores.push(() => spy.mockRestore());
        expect(await baselineCache.gateBunVersion(home, gateRunner.gateEnv(), prepareWaits.signal)).toBe(
          "none",
        );
      });

      test("probe discovery preserves cancellation", async () => {
        const controller = new AbortController();
        const reason = new Error("cancel version discovery");
        const original = proc.sh;
        const spy = spyOn(proc, "sh").mockImplementation(async (cmd, options) => {
          if (cmd[0] !== "bun" || cmd[1] !== "--version") return original(cmd, options);
          expect(options.signal).toBe(controller.signal);
          controller.abort(reason);
          throw reason;
        });
        restores.push(() => spy.mockRestore());
        await expect(
          baselineCache.gateBunVersion(home, gateRunner.gateEnv(), controller.signal),
        ).rejects.toBe(reason);
      });

      test("the previous cache namespace remains readable but is not reused", async () => {
        const count = await countingGate();
        const { bin } = stub("echo 1.4.3");
        onPath(bin);
        const f = start(quick);
        f.deps.bunVersion = "1.4.3";
        const original = baselineCache.baselineCacheKey;
        let legacyKey: BaselineCacheKey | undefined;
        const legacyBaseline = {
          setupOk: true,
          setup: [],
          checks: [
            {
              name: "check",
              command: `echo x >> '${count}'`,
              ok: true,
              exitCode: 0,
              durationMs: 0,
              output: "legacy",
            },
          ],
        };
        const spy = spyOn(baselineCache, "baselineCacheKey").mockImplementation((i) => {
          const key = original(i);
          if (!legacyKey) {
            legacyKey = {
              ...key,
              envHash: createHash("sha256")
                .update(
                  JSON.stringify({
                    arch: i.arch,
                    buildSha: i.buildSha,
                    bunVersion: i.bunVersion,
                    envDigest: i.envDigest,
                    executor: i.executor,
                    lockfileHash: i.lockfileHash,
                    platform: i.platform,
                    version: 3,
                  }),
                )
                .digest("hex"),
            };
            f.store.putBaselineCache(legacyKey, legacyBaseline, "legacy-writer");
          }
          return key;
        });
        restores.push(() => spy.mockRestore());
        const first = await prepared(f);
        expect(first.state?.baselineCached).toBe(false);
        const legacyRow = cacheRows(f).find((r) => r.run_id === "legacy-writer");
        const second = await prepared(f);
        expect(second.state?.baselineCached).toBe(true);
        expect([lines(count), cacheRows(f).length]).toEqual([1, 2]);
        expect(cacheRows(f).find((r) => r.run_id === "legacy-writer")).toEqual(legacyRow);
        if (!legacyKey) throw new Error("Missing legacy key");
        expect(f.store.getBaselineCache<typeof legacyBaseline>(legacyKey, 0)).toEqual(legacyBaseline);
      });
    });

    test("a second run on the same base reuses a passing baseline", async () => {
      const count = join(home, "gate-runs");
      await commitGates(`[gates]\nchecks = [{ name = "check", run = "echo x >> '${count}'" }]\n`);
      const f = start(quick);
      const first = await finish(f);
      // Baseline and the post-implement gates.
      expect(lines(count)).toBe(2);
      expect(first.state?.baselineCached).toBe(false);
      expect(first.state?.baseline?.sha).toBe(f.store.getRun(first.run.id)?.baseSha ?? undefined);
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

    // #556 (2026-10-17): alone 8.59 s, worst of 10 paired runs 6.56 s; multiple real-Git pipelines.
    // Before cancellable event waits: alone 11.32 s, paired 13.85 s.
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

    // Separate settings so six full pipelines do not share one test's timeout under load.
    test.each([
      ["GOPRIVATE", "other.example/*"],
      ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ])("a changed nonsecret setting %s with a secret-looking name misses", async (name, changed) => {
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
        process.env[name] = changed;
        expect((await prepared(f)).state?.baselineCached).toBe(false);
        expect((await prepared(f)).state?.baselineCached).toBe(true);
      } finally {
        for (const k of names) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    });

    // #556 (2026-10-17): alone 7.01 s, worst of 10 paired runs 8.62 s; multiple real-Git pipelines.
    // Before watching the gate marker: alone 9.59 s, paired 10.94 s.
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

    // #556 (2026-10-17): alone 9.33 s, worst of 10 paired runs 13.62 s; multiple real-Git pipelines.
    // Before cancellable event waits: alone 14.47 s, paired 16.45 s.
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
