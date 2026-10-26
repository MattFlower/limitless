import { describe, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import * as merges from "../src/git/merge.ts";
import * as repos from "../src/git/repos.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { SimulatedTermination } from "../src/pipeline/faults.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
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
import { postMergeWorkerFixture } from "./post-merge-worker-support.ts";
import { test } from "./read-policy-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const {
  start,
  wait,
  githubFixture,
  registerGithub,
  advanceBase,
  assertPublished,
  assertUnpublished,
  resolveBaseConflict,
} = pipelineSetup({
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
  test.each(["pass", "fail", "confinement", "legacy fail"])(
    "post-merge confirmation checkpoint resumes %s without another execution",
    async (savedOutcome) => {
      const outcome = savedOutcome.replace("legacy ", "");
      const secret = "synthetic-confirmation-restart-credential";
      registerCredential("confirmation-restart", secret);
      writeFileSync(
        join(repoDir, ".limitless.toml"),
        `[gates]\nretry_files = "bun test {files} '${secret}'"\nchecks = [{ name = "test", run = "bun test" }]\n`,
      );
      await sh(
        [
          "git",
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-qam",
          "confirmation restart fixture",
        ],
        { cwd: repoDir },
      );
      const bare = await githubFixture();
      const f = start(async (s) => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (roleOf(s) === "review") {
          await advanceBase(bare, "base.txt", "new base\n");
          return { structured: approve };
        }
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      await f.stop();
      registerGithub(f, bare);
      let confinementChecks = 0;
      if (outcome === "confinement")
        f.deps.confinement = {
          verify: async () => {
            confinementChecks++;
            throw new Error("coordinator confinement unavailable");
          },
          wrap: (cmd) => cmd,
        };
      const fixture = postMergeWorkerFixture(f, outcome);
      const save = f.store.setRunState.bind(f.store);
      const persist = spyOn(f.store, "setRunState").mockImplementation((id, state) => {
        save(id, state);
        if ((state as RunState).postMergeGates?.result?.comparison[0]?.coordinatorConfirmation)
          throw new SimulatedTermination("after confirmation checkpoint");
      });
      let reopened: Store | undefined;
      try {
        const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
        expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("running");
        persist.mockRestore();
        reopened = new Store(f.deps.cfg.paths.db);
        const state = reopened.getRunState<RunState>(run.id);
        expect(state?.postMergeRejection).toBeUndefined();
        const saved = state?.postMergeGates;
        expect(JSON.stringify(saved)).not.toContain(secret);
        if (savedOutcome === "legacy fail" && saved?.result) {
          delete saved.result.workers;
          for (const c of saved.result.comparison) delete c.postMergeWorker;
          reopened.setRunState(run.id, state);
        }
        const check = saved?.result?.comparison[0];
        const confirmation = check?.coordinatorConfirmation;
        expect(confirmation?.worker).toBe("test-worker");
        expect(confirmation?.originalVerdict).toBe("regressed");
        expect(check?.verdict).toBe(outcome === "pass" ? "flaky" : "regressed");
        expect(check?.firstAttempt?.ok).toBe(false);
        if (outcome === "confinement") {
          expect(confirmation?.result).toBeUndefined();
          expect(confirmation?.reason).toContain("coordinator confinement unavailable");
          expect(confinementChecks).toBe(1);
        } else expect(confirmation?.result?.ok).toBe(outcome === "pass");
        expect(fixture.local).toHaveLength(outcome === "confinement" ? 0 : 1);
        expect(fixture.remote).toHaveLength(2);
        expect(await executeRun({ ...f.deps, store: reopened }, run.id, new AbortController().signal)).toBe(
          outcome === "pass" ? "succeeded" : "needs_human",
        );
        expect(fixture.local).toHaveLength(outcome === "confinement" ? 0 : 1);
        expect(fixture.remote).toHaveLength(2);
        expect(reopened.getRunState<RunState>(run.id)?.postMergeGates).toEqual(saved);
        expect(JSON.stringify(reopened.getRunState<RunState>(run.id)?.postMergeGates)).not.toContain(secret);
        expect(reopened.getArtifact(run.id, "gates-rebase-0.json")).not.toContain(secret);
        if (outcome === "fail") {
          expect(reopened.getRun(run.id)?.error).toContain("coordinator assertion detail");
          expect(reopened.getArtifact(run.id, "gates-rebase-0.json")).toContain(
            "coordinator assertion detail",
          );
        }
        if (outcome === "confinement") {
          expect(confinementChecks).toBe(1);
          expect(reopened.getRun(run.id)?.error).toContain(confirmation?.reason ?? "missing reason");
        }
      } finally {
        persist.mockRestore();
        reopened?.close();
        fixture.processSpy.mockRestore();
      }
    },
  );

  test.each(["reset", "state save"])(
    "rejected post-merge restart after %s never retries the attempt",
    async (boundary) => {
      writeFileSync(
        join(repoDir, ".limitless.toml"),
        '[gates]\nretry_files = "bun test {files}"\nchecks = [{ name = "test", run = "bun test" }]\n',
      );
      await sh(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "rejection restart fixture"],
        { cwd: repoDir },
      );
      const bare = await githubFixture();
      const f = start(async (s) => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (roleOf(s) === "review") {
          await advanceBase(bare, "base.txt", "new base\n");
          return { structured: approve };
        }
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      await f.stop();
      registerGithub(f, bare);
      const fixture = postMergeWorkerFixture(f, "fail");
      const executor = f.deps.gateExecutor;
      if (!executor) throw new Error("Missing gate executor");
      const gateStarts = spyOn(executor, "start");
      const attach = executor.attach.bind(executor);
      let resuming = false;
      executor.attach = (handle, signal) => {
        const execution = attach(handle, signal);
        return {
          ...execution,
          result: execution.result.then((result) =>
            resuming
              ? { ...result, checks: result.checks.map((c) => ({ ...c, ok: true, exitCode: 0 })) }
              : result,
          ),
        };
      };
      const prepare = spyOn(merges, "prepareMerge");
      const git = merges.mergeGit;
      let runId = "";
      let beforeRollback: RunState | undefined;
      const reset = spyOn(merges, "mergeGit").mockImplementation(async (cwd, args, ...rest) => {
        const state = f.store.getRunState<RunState>(runId);
        const rollback = args[0] === "reset" && args[2] === state?.preRebaseHead;
        if (rollback) beforeRollback = state ?? undefined;
        const result = await git(cwd, args, ...rest);
        if (rollback && boundary === "reset") throw new SimulatedTermination("after rollback reset");
        return result;
      });
      const update = f.store.updateRun.bind(f.store);
      const persist = spyOn(f.store, "updateRun").mockImplementation((...args) => {
        const result = update(...args);
        if (
          boundary === "state save" &&
          beforeRollback &&
          args[1].headSha === beforeRollback.preRebaseHead &&
          args[2] &&
          !(args[2] as RunState).pendingRebaseSha
        )
          throw new SimulatedTermination("after rollback state save");
        return result;
      });
      let reopened: Store | undefined;
      try {
        const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
        runId = run.id;
        expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("running");
        reset.mockRestore();
        persist.mockRestore();
        reopened = new Store(f.deps.cfg.paths.db);
        const originalBase = reopened.getRun(run.id)?.baseSha;
        const interrupted = reopened.getRunState<RunState>(run.id);
        const cwd = interrupted?.worktreePath;
        const head = beforeRollback?.preRebaseHead;
        if (!cwd || !head || !beforeRollback?.postMergeGates || !beforeRollback.pendingRebaseSha)
          throw new Error("Missing rollback checkpoint");
        const rejected = beforeRollback?.postMergeRejection;
        const evidence = beforeRollback.postMergeGates;
        const gates = gateStarts.mock.calls.length;
        const mergesBeforeResume = prepare.mock.calls.length;
        expect(fixture.remote).toHaveLength(2);
        expect(fixture.local).toHaveLength(1);
        expect(interrupted?.pendingRebaseSha).toBe(
          boundary === "reset" ? beforeRollback?.pendingRebaseSha : undefined,
        );
        if (boundary === "state save") {
          expect(interrupted?.preRebaseHead).toBeUndefined();
          expect(interrupted?.preRebaseGates).toBeUndefined();
        }
        resuming = true;
        expect(await executeRun({ ...f.deps, store: reopened }, run.id, new AbortController().signal)).toBe(
          "needs_human",
        );
        expect(rejected).toEqual({
          reason: expect.stringContaining("post-merge gates regressed"),
          sha: evidence.sha,
          base: beforeRollback.pendingRebaseSha,
          head,
          round: 0,
        });
        expect(rejected?.reason).toContain("coordinator assertion detail");
        expect(rejected?.reason).toEndWith(`after merging onto ${evidence?.base.slice(0, 8)}`);
        expect(interrupted?.postMergeRejection).toEqual(rejected);
        const finished = reopened.getRun(run.id);
        expect(finished?.status).toBe("needs_human");
        expect(finished?.error).toBe(rejected?.reason.slice(0, 2000));
        expect(finished?.headSha).toBe(head);
        expect(finished?.baseSha).toBe(originalBase);
        expect(finished?.baseSha).not.toBe(rejected?.base);
        expect((await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim()).toBe(head);
        const state = reopened.getRunState<RunState>(run.id);
        expect(state?.postMergeRejection).toEqual(rejected);
        expect(state?.postMergeGates).toEqual(evidence);
        expect(state?.lastGates).toMatchObject(beforeRollback.preRebaseGates ?? []);
        expect(state?.pendingRebaseSha).toBeUndefined();
        expect(state?.preRebaseHead).toBeUndefined();
        expect(state?.preRebaseGates).toBeUndefined();
        expect(prepare.mock.calls).toHaveLength(mergesBeforeResume);
        expect(gateStarts.mock.calls).toHaveLength(gates);
        expect(fixture.remote).toHaveLength(2);
        expect(fixture.local).toHaveLength(1);
      } finally {
        reset.mockRestore();
        persist.mockRestore();
        prepare.mockRestore();
        gateStarts.mockRestore();
        reopened?.close();
        fixture.processSpy.mockRestore();
      }
    },
  );

  test("restart between coordinator confirmations keeps the completed first check", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nretry_files = "bun test {files}"\nchecks = [{ name = "test-a", run = "bun test --test-name-pattern suite-a" }, { name = "test-b", run = "bun test --test-name-pattern suite-b" }]\n`,
    );
    await sh(
      [
        "git",
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-qam",
        "interrupted confirmation fixture",
      ],
      { cwd: repoDir },
    );
    const bare = await githubFixture();
    const f = start(async (s) => {
      if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (roleOf(s) === "review") {
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    await f.stop();
    registerGithub(f, bare);
    const fixture = postMergeWorkerFixture(f);
    const execute = fixture.processSpy.getMockImplementation();
    if (!execute) throw new Error("Missing process mock");
    let confirmations = 0;
    fixture.processSpy.mockImplementation(async (opts) => {
      if (opts.cmd[0] === "/bin/sh" && ++confirmations === 2)
        throw new SimulatedTermination("during second coordinator confirmation");
      return execute(opts);
    });
    let reopened: Store | undefined;
    const remoteCommands = [
      "bun test --test-name-pattern suite-a",
      "bun test --test-name-pattern suite-b",
      "bun test './greeting.txt'",
      "bun test './greeting.txt'",
    ];
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("running");
      expect(fixture.local).toHaveLength(1);
      expect(fixture.remote).toEqual(remoteCommands);
      reopened = new Store(f.deps.cfg.paths.db);
      const saved = reopened.getRunState<RunState>(run.id)?.postMergeGates;
      expect(saved?.result?.comparison[0]).toMatchObject({
        verdict: "flaky",
        blocking: false,
        coordinatorConfirmation: { worker: "test-worker", result: { ok: true } },
      });
      expect(saved?.result?.comparison[1]?.coordinatorConfirmation).toBeUndefined();
      fixture.processSpy.mockImplementation(execute);
      expect(await executeRun({ ...f.deps, store: reopened }, run.id, new AbortController().signal)).toBe(
        "succeeded",
      );
      expect(fixture.local).toHaveLength(2);
      expect(fixture.local.map((c) => c.command)).toEqual([
        "bun test './greeting.txt'",
        "bun test './greeting.txt'",
      ]);
      expect(fixture.remote).toEqual(remoteCommands);
      const resumed = reopened.getRunState<RunState>(run.id)?.postMergeGates;
      expect(resumed?.deadline).toBe(saved?.deadline);
      expect(resumed?.result?.comparison[0]).toEqual(saved?.result?.comparison[0]);
    } finally {
      reopened?.close();
      fixture.processSpy.mockRestore();
    }
  });

  test.each([
    "pass",
    "unknown worker",
    "local",
    "fallback",
    "collision",
    "legacy",
    "legacy collision",
    "legacy missing",
  ])("preconfirmation checkpoint resumes with persisted attribution: %s", async (scenario) => {
    const secrets = [crypto.randomUUID(), crypto.randomUUID()];
    const collision = scenario.includes("collision");
    const names = secrets.slice(0, collision ? 2 : 1).map((secret) => `test-${secret}`);
    const checks = names.map((name, index) => ({ name, run: `bun test --test-name-pattern suite-${index}` }));
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nretry_files = "bun test {files}"\nchecks = [${checks.map((c) => `{ name = "${c.name}", run = "${c.run}" }`).join(", ")}]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "pending fixture"], {
      cwd: repoDir,
    });
    const bare = await githubFixture();
    const f = start(async (s) => {
      if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (roleOf(s) === "review") {
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    await f.stop();
    registerGithub(f, bare);
    const fixture = postMergeWorkerFixture(
      f,
      scenario,
      () => {
        // Register after worker execution so its known gate identities reach the checkpoint redactor.
        for (const secret of secrets) registerCredential("worker-gate", secret);
      },
      (name) =>
        collision ? `worker-${name === names[0] ? "a" : "b"}-${secrets[0]}` : `test-worker-${secrets[0]}`,
    );
    const save = f.store.setRunState.bind(f.store);
    const checkpoints: string[] = [];
    const persist = spyOn(f.store, "setRunState").mockImplementation((id, state) => {
      save(id, state);
      const saved = f.store.getRunState<RunState>(id)?.postMergeGates;
      if (saved) checkpoints.push(JSON.stringify(saved));
      if (saved?.result) throw new SimulatedTermination("before coordinator confirmation");
    });
    let reopened: Store | undefined;
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("running");
      persist.mockRestore();
      reopened = new Store(f.deps.cfg.paths.db);
      const state = reopened.getRunState<RunState>(run.id);
      const saved = state?.postMergeGates;
      for (const checkpoint of checkpoints)
        for (const secret of secrets) expect(checkpoint).not.toContain(secret);
      expect(saved?.result).toMatchObject({ setupOk: true, timedOut: false });
      expect(saved?.result?.workers).toBeUndefined();
      expect(saved?.result?.comparison.map((c) => c.postMergeWorker)).toEqual(
        collision
          ? [null, null]
          : [
              scenario === "unknown worker"
                ? null
                : ["local", "fallback"].includes(scenario)
                  ? undefined
                  : "test-worker-[redacted]",
            ],
      );
      expect(saved?.result?.comparison[0]).toMatchObject({
        name: "test-[redacted]",
        blocking: true,
        verdict: "regressed",
        result: { ok: false, ...(collision ? {} : { targetedRetry: { ok: false } }) },
      });
      expect(saved?.result?.comparison[0]?.coordinatorConfirmation).toBeUndefined();
      expect(fixture.local).toHaveLength(0);
      const remote = collision
        ? [
            "bun test --test-name-pattern suite-0",
            "bun test --test-name-pattern suite-1",
            "bun test './greeting.txt'",
            "bun test './greeting.txt'",
          ]
        : ["bun test --test-name-pattern suite-0", "bun test './greeting.txt'"];
      expect(fixture.remote).toEqual(remote);
      if (scenario.startsWith("legacy") && saved?.result) {
        for (const c of saved.result.comparison) delete c.postMergeWorker;
        if (scenario !== "legacy missing")
          saved.result.workers = Object.fromEntries(
            names.map((name, index) => [
              name,
              collision ? `worker-${index}-${secrets[0]}` : `test-worker-${secrets[0]}`,
            ]),
          );
        reopened.setRunState(run.id, state);
      }
      const resumeSave = reopened.setRunState.bind(reopened);
      const resumePersist = spyOn(reopened, "setRunState").mockImplementation((id, value) => {
        resumeSave(id, value);
        const persisted = reopened?.getRunState<RunState>(id)?.postMergeGates;
        if (persisted) checkpoints.push(JSON.stringify(persisted));
      });
      const passes = scenario === "pass" || scenario === "legacy";
      expect(await executeRun({ ...f.deps, store: reopened }, run.id, new AbortController().signal)).toBe(
        passes ? "succeeded" : "needs_human",
      );
      resumePersist.mockRestore();
      for (const checkpoint of checkpoints)
        for (const secret of secrets) expect(checkpoint).not.toContain(secret);
      expect(fixture.local).toHaveLength(passes ? 1 : 0);
      expect(fixture.remote).toEqual(remote);
      const resumed = reopened.getRunState<RunState>(run.id)?.postMergeGates;
      expect(resumed?.deadline).toBe(saved?.deadline);
      const check = resumed?.result?.comparison[0];
      expect(resumed?.result?.workers).toBeUndefined();
      if (passes)
        expect(check).toMatchObject({
          verdict: "flaky",
          coordinatorConfirmation: { worker: "test-worker-[redacted]", result: { ok: true } },
        });
      else if (scenario === "unknown worker")
        expect(check?.coordinatorConfirmation?.reason).toContain("attribution unavailable");
      else if (collision) {
        expect(reopened.getRun(run.id)?.error).toContain("distinct once sanitized");
        expect(resumed?.result?.comparison.every((c) => c.postMergeWorker === null)).toBe(true);
        expect(resumed?.result?.comparison.every((c) => !c.coordinatorConfirmation)).toBe(true);
      } else expect(check?.coordinatorConfirmation).toBeUndefined();
    } finally {
      persist.mockRestore();
      reopened?.close();
      fixture.processSpy.mockRestore();
    }
  });

  const invalidMergeHeads = [
    "wrong MERGE_HEAD",
    "multiple MERGE_HEAD entries",
    "abbreviated MERGE_HEAD",
    "empty MERGE_HEAD",
    "garbage MERGE_HEAD",
    "MERGE_HEAD read failure",
    "MERGE_HEAD path failure",
  ];

  async function setMergeHead(cwd: string, scenario: string, base: string, other: string) {
    const path = resolve(
      cwd,
      (await sh(["git", "rev-parse", "--git-path", "MERGE_HEAD"], { cwd })).stdout.trim(),
    );
    if (scenario === "MERGE_HEAD read failure") {
      rmSync(path);
      mkdirSync(path); // Deterministic EISDIR, independent of permission bits and user privileges.
      return;
    }
    const contents: Record<string, string> = {
      "wrong MERGE_HEAD": `${other}\n`,
      "multiple MERGE_HEAD entries": `${base}\n${other}\n`,
      "abbreviated MERGE_HEAD": `${base.slice(0, 12)}\n`,
      "empty MERGE_HEAD": "",
      "garbage MERGE_HEAD": "not-an-object-id\n",
      "MERGE_HEAD without newline": base,
    };
    const content = contents[scenario];
    if (content !== undefined) writeFileSync(path, content);
  }

  async function assertRefusedResume(bare: string, runId: string, handler: Handler, scenario: string) {
    const publication = spyOn(repos, "pushBranch");
    const git = merges.mergeGit;
    let pathFailure = false;
    const resolution =
      scenario === "MERGE_HEAD path failure"
        ? spyOn(merges, "mergeGit").mockImplementation((cwd, args, ...rest) => {
            if (args.join(" ") === "rev-parse --git-path MERGE_HEAD") {
              pathFailure = true;
              // Even ENOENT from path resolution must not count as an absent MERGE_HEAD file.
              throw Object.assign(new Error("injected path resolution failure"), { code: "ENOENT" });
            }
            return git(cwd, args, ...rest);
          })
        : undefined;
    try {
      const resumed = start(handler);
      expect(await waitFor(resumed, runId, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
      const finished = resumed.store.getRun(runId);
      expect(finished?.error).toContain("Delivery refused");
      expect(finished?.prUrl).toBeNull();
      expect(publication).not.toHaveBeenCalled();
      expect(
        (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
          .stdout,
      ).toBe("");
      expect(readFileSync(join(home, "gh-calls"), "utf8")).not.toContain("pr create");
      if (resolution) expect(pathFailure).toBe(true);
    } finally {
      publication.mockRestore();
      resolution?.mockRestore();
    }
  }

  async function interruptGatedMerge() {
    const bare = await githubFixture();
    let base = "";
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        base = await advanceBase(bare, "base.txt", "first base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const update = f.store.updateRun.bind(f.store);
    const persist = spyOn(f.store, "updateRun").mockImplementation((...args) => {
      const result = update(...args);
      if (base && args[1].baseSha === base && args[1].headSha !== base && args[2])
        throw new SimulatedTermination("interrupted after persisted gated merge, before push");
      return result;
    });
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    await wait(
      () => f.store.listStages(run.id).findLast((s) => s.name === "deliver")?.status === "cancelled",
      { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => f.store.subscribe(wake) },
    );
    persist.mockRestore();
    await f.stop();
    const state = f.store.getRunState<RunState>(run.id);
    const merge = f.store.getRun(run.id)?.headSha;
    if (!state?.worktreePath || !state.reviewedSha || !merge) throw new Error("missing merged state");
    expect(state.pendingRebaseSha).toBeUndefined();
    expect(
      f.store.listStages(run.id).filter((s) => s.name === "gates" && s.status === "succeeded"),
    ).toHaveLength(2);
    await assertUnpublished(bare);
    expect(
      (await sh(["git", "rev-list", "--parents", "-n", "1", merge], { cwd: state.worktreePath })).stdout
        .trim()
        .split(" "),
    ).toEqual([merge, state.reviewedSha, base]);
    return { f, run, state, bare, base, merge, cwd: state.worktreePath };
  }

  test.each(["confirmed", "different tip", "absent branch", "lookup fails"])(
    "delivery reconciles an interrupted push before merging the newer base (%s)",
    async (scenario) => {
      const bare = await githubFixture();
      const f = start(
        (s) => {
          if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
          if (roleOf(s) === "review") return { structured: approve };
          return { files: { "farewell.txt": "goodbye\n" } };
        },
        false,
        false,
        { faults: { "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-pushed" } } },
      );
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      await wait(
        () => f.store.listStages(run.id).findLast((s) => s.name === "deliver")?.status === "cancelled",
        { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => f.store.subscribe(wake) },
      );
      await f.stop();
      const state = f.store.getRunState<RunState>(run.id);
      const saved = f.store.getRun(run.id);
      if (!state?.worktreePath || !state.publishingSha || !saved?.branch || !saved.baseSha)
        throw new Error("missing interrupted push state");
      const pending = state.publishingSha;
      const prior = saved.baseSha;
      const ref = `refs/heads/${saved.branch}`;
      expect((await sh(["git", "rev-parse", ref], { cwd: bare })).stdout.trim()).toBe(pending);
      expect(state.publishedSha).toBeUndefined();
      expect(existsSync(join(home, "gh-calls"))).toBe(false);
      const nextBase = await advanceBase(bare, "next.txt", "base advanced after push\n");
      if (scenario !== "confirmed") {
        // An earlier confirmed publication must survive an unconfirmed pending intent.
        state.publishedSha = prior;
        f.store.setRunState(run.id, state);
        if (scenario !== "lookup fails")
          await sh(
            scenario === "different tip"
              ? ["git", "update-ref", ref, nextBase]
              : ["git", "update-ref", "-d", ref],
            { cwd: bare },
          );
      }
      f.store.close();
      const push = repos.pushBranch;
      const checkpoints: RunState[] = [];
      const reconciled: RunState[] = [];
      let resumed: Factory;
      const lookup =
        scenario === "lookup fails"
          ? spyOn(repos, "remoteBranchSha").mockRejectedValue(new Error("injected remote lookup failure"))
          : undefined;
      const publication = spyOn(repos, "pushBranch").mockImplementation(async (...args) => {
        const checkpoint = resumed.store.getRunState<RunState>(run.id);
        if (!checkpoint) throw new Error("missing pre-push checkpoint");
        checkpoints.push(checkpoint);
        expect(checkpoint.publishingSha).toBe(args[3]);
        expect(checkpoint.publishedSha).toBe(scenario === "confirmed" ? pending : prior);
        expect(args[6]).toBe(checkpoint.publishedSha);
        return push(...args);
      });
      try {
        resumed = start(
          () => {
            throw new Error("delivery must not invoke agents");
          },
          false,
          false,
          {
            faults: {
              "store:save": {
                action: "continue",
                when: (c) => c.checkpoint === "delivery-publishing",
                onHit: () => {
                  const checkpoint = resumed.store.getRunState<RunState>(run.id);
                  if (checkpoint) reconciled.push(checkpoint);
                },
              },
            },
          },
        );
        const status = await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"]);
        const finished = resumed.store.getRun(run.id);
        const final = resumed.store.getRunState<RunState>(run.id);
        if (scenario === "lookup fails") {
          expect(status).toBe("needs_human");
          expect(finished?.error).toContain("injected remote lookup failure");
          expect(final?.publishedSha).toBe(prior);
          expect(final?.publishingSha).toBe(pending);
          expect(checkpoints).toHaveLength(0);
          expect(reconciled).toHaveLength(0);
          expect((await sh(["git", "rev-parse", ref], { cwd: bare })).stdout.trim()).toBe(pending);
          expect(finished?.prUrl).toBeNull();
          return;
        }
        expect(checkpoints.length).toBeGreaterThan(0);
        expect(reconciled[0]).toMatchObject({
          publishedSha: scenario === "confirmed" ? pending : prior,
        });
        expect(reconciled[0]?.publishingSha).toBeUndefined();
        if (scenario === "confirmed") {
          expect(status).toBe("succeeded");
          expect(finished?.prUrl).toContain("/pull/1");
          expect(finished?.baseSha).toBe(nextBase);
          expect(final?.publishedSha).toBe(finished?.headSha ?? "missing");
          expect(final?.publishingSha).toBeUndefined();
          const head = (await sh(["git", "rev-parse", ref], { cwd: bare })).stdout.trim();
          expect(head).toBe(final?.publishedSha ?? "missing");
          expect(
            (await sh(["git", "show", "-s", "--format=%P", head], { cwd: bare })).stdout.trim().split(" "),
          ).toEqual([pending, nextBase]);
          expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("pr create");
        } else {
          expect(status).toBe("needs_human");
          expect(final?.publishedSha).toBe(saved.baseSha);
          expect(finished?.prUrl).toBeNull();
          const remote = await sh(["git", "show-ref", "--verify", ref], { cwd: bare, allowFail: true });
          if (scenario === "different tip") expect(remote.stdout.trim()).toBe(`${nextBase} ${ref}`);
          else expect(remote.exitCode).not.toBe(0);
          expect(readFileSync(join(home, "gh-calls"), "utf8")).not.toContain("pr create");
        }
      } finally {
        publication.mockRestore();
        lookup?.mockRestore();
      }
    },
  );

  test.each(["recorded", "legacy", "worker published", "HEAD moved before push"])(
    "delivery resumes a gated merge when the base advances a second time (%s)",
    async (scenario) => {
      const { f, run, state, bare, base, merge, cwd } = await interruptGatedMerge();
      if (scenario === "legacy") {
        state.deliveryMerges = undefined;
        f.store.setRunState(run.id, state);
      }
      if (scenario === "worker published") {
        const branch = f.store.getRun(run.id)?.branch;
        await sh(["git", "push", bare, `${state.reviewedSha}:refs/heads/${branch}`], { cwd });
        state.publishedSha = state.reviewedSha;
        f.store.setRunState(run.id, state);
      }
      const nextBase = await advanceBase(bare, "again.txt", "second base\n");
      expect((await sh(["git", "rev-parse", `${nextBase}^`], { cwd: bare })).stdout.trim()).toBe(base);
      f.store.close();
      const push = repos.pushBranch;
      let changed = "";
      const publication = spyOn(repos, "pushBranch").mockImplementation(async (...args) => {
        if (scenario === "HEAD moved before push") {
          await sh(["git", "commit", "--allow-empty", "-qm", "unreviewed late commit"], { cwd });
          changed = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
          expect(args[3]).not.toBe(changed);
          expect(args[3]).not.toBe("HEAD");
        }
        return push(...args);
      });
      try {
        const resumed = start(() => {
          throw new Error("delivery must not invoke agents");
        });
        const status = await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"]);
        const finished = resumed.store.getRun(run.id);
        const newest = finished?.headSha;
        if (!newest) throw new Error("missing delivered SHA");
        expect(newest).not.toBe(state.reviewedSha);
        expect(newest).not.toBe(merge);
        expect(finished?.baseSha).toBe(nextBase);
        expect(
          (
            await sh(["git", "rev-list", "--parents", "-n", "1", newest], {
              cwd: status === "succeeded" ? bare : cwd,
            })
          ).stdout
            .trim()
            .split(" "),
        ).toEqual([newest, merge, nextBase]);
        expect(
          resumed.store.listStages(run.id).filter((s) => s.name === "gates" && s.status === "succeeded"),
        ).toHaveLength(3);
        expect(resumed.store.getRunState<RunState>(run.id)?.publishedSha).toBe(newest);
        expect(finished?.error).toBeNull();
        expect(status).toBe("succeeded");
        expect(
          (await sh(["git", "rev-parse", `refs/heads/${finished?.branch}`], { cwd: bare })).stdout.trim(),
        ).toBe(newest);
        if (changed)
          expect(
            (await sh(["git", "cat-file", "-e", changed], { cwd: bare, allowFail: true })).exitCode,
          ).not.toBe(0);
      } finally {
        publication.mockRestore();
      }
    },
  );

  test.each([
    "pass",
    "block",
    "merge still in progress",
    "MERGE_HEAD without newline",
    "absent MERGE_HEAD",
    ...invalidMergeHeads.slice(0, 3),
    "completed merge retains MERGE_HEAD",
  ])(
    "a pending second delivery merge resumes its own gates or refuses inconsistent state (%s)",
    async (scenario) => {
      const { f, run, bare, merge, cwd } = await interruptGatedMerge();
      const nextBase = await advanceBase(bare, "again.txt", scenario === "block" ? "BAD\n" : "second base\n");
      f.store.close();
      const noAgents = () => {
        throw new Error("delivery must not invoke agents");
      };
      const interrupted = start(noAgents, false, false, {
        faults: { "stage:gates:before": { action: "kill" } },
      });
      await wait(
        () =>
          interrupted.store.listStages(run.id).findLast((s) => s.name === "deliver")?.status === "cancelled",
        { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => interrupted.store.subscribe(wake) },
      );
      await interrupted.stop();
      const pending = interrupted.store.getRunState<RunState>(run.id);
      if (!pending?.reviewedSha) throw new Error("missing pending review evidence");
      expect(pending?.pendingRebaseSha).toBe(nextBase);
      expect(pending?.preRebaseHead).toBe(merge);
      const newest = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
      expect(
        (await sh(["git", "rev-list", "--parents", "-n", "1", newest], { cwd })).stdout.trim().split(" "),
      ).toEqual([newest, merge, nextBase]);
      expect(
        (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
          .stdout,
      ).toBe("");
      expect(readFileSync(join(home, "gh-calls"), "utf8")).not.toContain("pr create");
      if (scenario !== "pass" && scenario !== "block" && scenario !== "completed merge retains MERGE_HEAD") {
        await sh(["git", "reset", "--hard", merge], { cwd });
        if (scenario !== "absent MERGE_HEAD")
          await sh(["git", "merge", "--no-ff", "--no-commit", nextBase], { cwd });
        await setMergeHead(cwd, scenario, nextBase, pending.reviewedSha);
      } else if (scenario === "completed merge retains MERGE_HEAD") {
        const path = (await sh(["git", "rev-parse", "--git-path", "MERGE_HEAD"], { cwd })).stdout.trim();
        writeFileSync(resolve(cwd, path), `${nextBase}\n`);
      }
      interrupted.store.close();
      if (scenario === "completed merge retains MERGE_HEAD" || invalidMergeHeads.includes(scenario)) {
        await assertRefusedResume(bare, run.id, noAgents, scenario);
        return;
      }
      const resumed = start(noAgents);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        scenario === "block" ? "needs_human" : "succeeded",
      );
      const stages = resumed.store.listStages(run.id).filter((s) => s.name === "gates");
      expect(stages.map((s) => s.status)).toEqual([
        "succeeded",
        "succeeded",
        "cancelled",
        scenario === "block" ? "failed" : "succeeded",
      ]);
      const finished = resumed.store.getRun(run.id);
      const published = (
        await sh(["git", "rev-parse", `refs/heads/${finished?.branch}`], { cwd: bare })
      ).stdout.trim();
      if (scenario === "block") {
        expect(finished?.error).toContain("post-merge gates regressed");
        expect(published).toBe(pending?.reviewedSha);
        expect(published).not.toBe(newest);
      } else {
        expect(finished?.headSha).toBe(published);
        expect(
          (await sh(["git", "rev-list", "--parents", "-n", "1", published], { cwd: bare })).stdout
            .trim()
            .split(" "),
        ).toEqual([published, merge, nextBase]);
      }
    },
  );

  test.each([
    "unrecorded commit",
    "unrecorded merge",
    "extra parent at HEAD",
    "extra parent in history",
    "another review",
    "another run",
    "another review at HEAD",
    "another run at HEAD",
  ])("delivery refuses a chain with %s without a draft fallback", async (scenario) => {
    const { f, run, state, bare, base, merge, cwd } = await interruptGatedMerge();
    const reviewed = state.reviewedSha;
    if (!reviewed) throw new Error("missing reviewed SHA");
    const nextBase = await advanceBase(bare, "again.txt", "second base\n");
    await sh(["git", "fetch", bare, "main"], { cwd });
    const tree = (await sh(["git", "rev-parse", `${merge}^{tree}`], { cwd })).stdout.trim();
    const commit = async (parents: string[]) =>
      (
        await sh(["git", "commit-tree", tree, ...parents.flatMap((p) => ["-p", p])], {
          cwd,
          stdin: "test ancestry\n",
        })
      ).stdout.trim();
    const record = (sha: string, head: string, base: string) => ({
      runId: run.id,
      reviewedSha: reviewed,
      sha,
      head,
      base,
    });
    let intermediate = merge;
    state.deliveryMerges = [record(merge, reviewed, base)];
    if (scenario.startsWith("unrecorded"))
      intermediate = await commit(scenario === "unrecorded commit" ? [merge] : [merge, nextBase]);
    if (scenario === "extra parent in history") {
      // Three-parent (octopus) commits must be refused even with a matching recorded parent pair.
      intermediate = await commit([reviewed, base, nextBase]);
      state.deliveryMerges = [record(intermediate, reviewed, base)];
    }
    if (scenario.startsWith("another"))
      state.deliveryMerges = [
        {
          ...record(merge, reviewed, base),
          ...(scenario.startsWith("another review") ? { reviewedSha: base } : { runId: `${run.id}-other` }),
        },
      ];
    const newest =
      scenario.startsWith("another") && scenario.endsWith("at HEAD")
        ? merge
        : await commit(
            scenario === "extra parent at HEAD" ? [intermediate, nextBase, base] : [intermediate, nextBase],
          );
    if (newest !== merge) state.deliveryMerges.push(record(newest, intermediate, nextBase));
    await sh(["git", "reset", "--hard", newest], { cwd });
    expect((await sh(["git", "merge-base", "--is-ancestor", reviewed, newest], { cwd })).exitCode).toBe(0);
    f.store.updateRun(run.id, { headSha: newest, baseSha: newest === merge ? base : nextBase }, state);
    const refs = (await sh(["git", "show-ref"], { cwd: bare })).stdout;
    f.store.close();
    const resumed = start(() => {
      throw new Error("delivery must not invoke agents");
    });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(resumed.store.getRun(run.id)?.error).toContain("Delivery refused");
    expect(resumed.store.getRun(run.id)?.prUrl).toBeNull();
    expect((await sh(["git", "show-ref"], { cwd: bare })).stdout).toBe(refs);
    expect(readFileSync(join(home, "gh-calls"), "utf8")).not.toContain("pr create");
  });

  test.each([
    "amended HEAD",
    "missing reviewed SHA",
    "missing verified SHA",
    "mismatched gate SHA",
    "completed clean merge",
  ])("new PR restart validates %s, including the draft fallback", async (scenario) => {
    const bare = await githubFixture();
    const handler: Handler = async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        if (scenario === "completed clean merge") await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler);
    registerGithub(f, bare);
    f.deps.faults =
      scenario === "completed clean merge"
        ? { "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-pr-created" } }
        : { "stage:deliver:before": { action: "kill" } };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    await wait(
      () => f.store.listStages(run.id).findLast((stage) => stage.name === "deliver")?.status === "cancelled",
      {
        timeoutMs: 10_000,
        description: "delivery interruption timed out",
        pollMs: null,
        subscribe: (wake) => f.store.subscribe(wake),
      },
    );
    await f.stop();
    const state = f.store.getRunState<RunState>(run.id);
    if (!state?.worktreePath || !state.reviewedSha || !state.gateEvidence)
      throw new Error("missing checked delivery state");
    expect(state.phase).toBe("deliver");
    const expected = state.reviewedSha;
    const cwd = state.worktreePath;
    if (scenario === "completed clean merge") {
      state.deliveryMerges = undefined;
      f.store.setRunState(run.id, state);
    }
    if (scenario === "amended HEAD") {
      writeFileSync(join(cwd, "farewell.txt"), "unreviewed amendment\n");
      await sh(["git", "add", "farewell.txt"], { cwd });
      await sh(["git", "commit", "--amend", "--no-edit", "-q"], { cwd });
    } else if (scenario !== "completed clean merge") {
      if (scenario === "missing reviewed SHA") state.reviewedSha = undefined;
      else if (scenario === "missing verified SHA") state.lastVerifiedSha = undefined;
      else
        state.gateEvidence.sha = state.gateEvidence.sha === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
      f.store.setRunState(run.id, state);
    }
    const actual = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
    f.store.close();
    const resumed = start(() => {
      throw new Error("delivery resume must not invoke an agent");
    });
    const status = await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"]);
    const finished = resumed.store.getRun(run.id);
    if (scenario === "completed clean merge") {
      expect(status).toBe("succeeded");
      expect(actual).not.toBe(expected);
      expect(state.pendingRebaseSha).toBeUndefined();
      expect(finished?.headSha).toBe(actual);
      expect((await sh(["git", "rev-parse", `${actual}^1`], { cwd: bare })).stdout.trim()).toBe(expected);
      expect(
        (await sh(["git", "rev-parse", `refs/heads/${finished?.branch}`], { cwd: bare })).stdout.trim(),
      ).toBe(actual);
      expect(resumed.store.listStages(run.id).filter((stage) => stage.name === "gates")).toHaveLength(2);
      return;
    }
    expect(status).toBe("needs_human");
    expect(finished?.error).toContain(actual);
    if (scenario === "amended HEAD") expect(finished?.error).toContain(expected);
    else expect(finished?.error).toContain("missing or inconsistent passing round evidence");
    expect(finished?.prUrl).toBeNull();
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");
    expect(readFileSync(join(home, "gh-calls"), "utf8")).not.toContain("pr create");
  });

  for (const checkpoint of [
    "post-rebase-gates",
    "post-rebase-gates-fail",
    "interrupted-merge",
    "interrupted-merge MERGE_HEAD without newline",
    "interrupted-merge absent MERGE_HEAD",
    ...invalidMergeHeads.map((scenario) => `interrupted-merge ${scenario}`),
    "base-moved",
    "base-moved-during-gates",
    "conflict-implement",
    "conflict-committed",
  ] as const) {
    const timeout = checkpoint === "conflict-committed" ? 30_000 : undefined;
    const checkCheckpoint = async () => {
      const conflict = checkpoint.startsWith("conflict-");
      const marker = join(home, "checking");
      const release = join(home, "release");
      if (checkpoint !== "conflict-implement") {
        const check = `if test -f base.txt && ! test -f '${release}'; then echo dirty > greeting.txt; touch '${marker}'; while ! test -f '${release}'; do sleep 0.05; done; fi; test -f greeting.txt${checkpoint === "post-rebase-gates-fail" ? " && test ! -f base.txt" : ""}`;
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "slow gate"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let baseTip = "";
      let implementsCount = 0;
      let reviews = 0;
      let verifies = 0;
      let restarting = false;
      const handler: Handler = async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews === 1) {
            writeFileSync(join(repoDir, "base.txt"), "base only\n");
            baseTip = await advanceBase(bare, conflict ? "greeting.txt" : "base.txt", "new base\n");
          }
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          return { structured: pass };
        }
        implementsCount++;
        if (implementsCount > 1) {
          expect(s.prompt).toContain("do not run Git");
          if (checkpoint === "conflict-committed") return resolveBaseConflict(s.cwd, bare);
          if (!restarting) {
            writeFileSync(join(s.cwd, "greeting.txt"), "partially resolved\n");
            writeFileSync(marker, "implementing");
            return { delayMs: 30_000 };
          }
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("partially resolved\n");
          expect((await sh(["git", "rev-parse", "MERGE_HEAD"], { cwd: s.cwd })).stdout.trim()).toBe(baseTip);
          return { files: { "greeting.txt": "hello from both intents\nnew base\n" } };
        }
        return {
          files: {
            "farewell.txt": "goodbye\n",
            ...(conflict ? { "greeting.txt": "feature\n" } : {}),
          },
        };
      };
      const f = start(handler);
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
      await wait(() => existsSync(marker), {
        timeoutMs: checkpoint === "conflict-committed" ? 25_000 : 10_000,
        description: "delivery gate never reached its barrier",
        subscribe(wake) {
          const watcher = watch(home, wake);
          return () => watcher.close();
        },
      });
      expect(existsSync(marker)).toBe(true);
      if (checkpoint === "base-moved-during-gates") {
        await assertUnpublished(bare);
        await advanceBase(bare, "again.txt", "newer base\n");
        writeFileSync(release, "finish gates");
        // The head that passed the post-rebase gates is published; the newer base is the PR's concern.
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const published = f.store.getRun(run.id);
        expect(published?.baseSha).toBe(baseTip);
        expect(f.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(2);
        expect(implementsCount).toBe(1);
        expect(reviews).toBe(1);
        expect(verifies).toBe(1);
        expect(
          (await sh(["git", "show", `${published?.headSha}:greeting.txt`], { cwd: bare })).stdout,
        ).not.toContain("dirty");
        await assertPublished(bare);
        return;
      }
      await f.stop();
      expect(f.store.getRun(run.id)?.status).toBe("queued");
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.phase).toBe(conflict ? "loop" : "deliver");
      expect(state?.lastVerifiedSha).toHaveLength(40);
      if (conflict) {
        expect(f.store.getRun(run.id)?.baseSha).toBe(baseTip);
        expect(state?.conflictRound).toBe(1);
      } else {
        expect(state?.pendingRebaseSha).toBe(baseTip);
        expect(f.store.getRun(run.id)?.baseSha).not.toBe(baseTip);
      }
      await assertUnpublished(bare);
      if (checkpoint.startsWith("interrupted-merge")) {
        const cwd = state?.worktreePath;
        if (!cwd || !state?.preRebaseHead) throw new Error("missing delivery checkpoint");
        await sh(["git", "reset", "--hard", state.preRebaseHead], { cwd });
        if (checkpoint !== "interrupted-merge absent MERGE_HEAD")
          await sh(
            ["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-commit", baseTip],
            { cwd },
          );
        expect(state.reviewedSha).toBe(state.preRebaseHead);
        await setMergeHead(cwd, checkpoint.slice("interrupted-merge ".length), baseTip, state.preRebaseHead);
      }
      if (checkpoint === "conflict-committed" && state) {
        // Also exercise the crash window after git commit but before implementedRound is saved.
        state.implementedRound = undefined;
        f.store.updateRun(run.id, {}, state);
      }
      f.store.close();
      restarting = true;
      if (checkpoint === "base-moved" || conflict) await advanceBase(bare, "again.txt", "newer base\n");
      writeFileSync(release, "resume");
      if (invalidMergeHeads.includes(checkpoint.slice("interrupted-merge ".length))) {
        await assertRefusedResume(bare, run.id, handler, checkpoint.slice("interrupted-merge ".length));
        return;
      }
      const resumed = start(handler);
      if (checkpoint === "post-rebase-gates-fail") {
        expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
        const finished = resumed.store.getRun(run.id);
        const savedSha = state?.lastVerifiedSha ?? "missing";
        expect(resumed.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBe(savedSha);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(savedSha);
        expect(finished?.prUrl).toContain("/pull/1");
        return;
      }
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const finished = resumed.store.getRun(run.id);
      expect(finished?.baseSha).toBe(baseTip);
      expect(resumed.store.getRunState<RunState>(run.id)?.pendingRebaseSha).toBeUndefined();
      expect(implementsCount).toBe(conflict ? (checkpoint === "conflict-implement" ? 3 : 2) : 1);
      expect(reviews).toBe(conflict ? 2 : 1);
      expect(verifies).toBe(conflict ? 2 : 1);
      expect(
        (await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], { cwd: bare }))
          .exitCode,
      ).toBe(0);
      expect(
        (await sh(["git", "show", `${finished?.headSha}:greeting.txt`], { cwd: bare })).stdout,
      ).not.toContain("dirty");
      expect(
        (
          await sh(["git", "rev-list", "--count", "--merges", finished?.headSha ?? ""], { cwd: bare })
        ).stdout.trim(),
      ).toBe("1");
      expect(
        (await sh(["git", "rev-list", "--parents", "-n", "1", finished?.headSha ?? ""], { cwd: bare })).stdout
          .trim()
          .split(" ")
          .slice(1),
      ).toEqual([state?.preRebaseHead ?? "", baseTip]);
      expect(resumed.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(
        checkpoint === "conflict-implement" ? 2 : 3,
      );
    };
    // #556 (2026-10-16), conflict-committed: alone 6.85 s, paired load 8.41 s; Git and crash recovery.
    test(`delivery checkpoint ${checkpoint} never publishes unchecked work`, checkCheckpoint, timeout);
  }

  test.each([
    ["main", null],
    ["main", "not-a-sha"],
    ["main.lock", "b".repeat(40)],
  ])("PR verification rejects invalid base metadata: %s %s", async (baseRef, baseSha) => {
    const f = start(() => {
      throw new Error("No model should run");
    });
    const run = await f.createRun({
      repo: repoDir,
      prompt: "verify",
      sourceRef: { kind: "pull_request", baseRef, baseSha, headSha: "a".repeat(40), number: 1 },
    });
    expect(await waitFor(f, run.id, ["failed", "succeeded"])).toBe("failed");
    expect(f.store.getRun(run.id)?.error).toContain("valid PR baseRef");
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
  });
});
