import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { WorkerStore } from "../src/db/workers.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { AgentEvent } from "../src/harness/types.ts";
import type { AgentCall, AgentPublication } from "../src/pipeline/agent-executor.ts";
import { NeedsHumanError } from "../src/pipeline/context.ts";
import { SimulatedTermination } from "../src/pipeline/faults.ts";
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";
import { registerCredential } from "../src/util/proc.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const parentSha = "a".repeat(40),
  sha = "b".repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lan-agent-"));
  const prior = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = join(root, "config");
  mkdirSync(process.env.LIMITLESS_CONFIG_DIR);
  cleanup.push(() => {
    if (prior === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
    else process.env.LIMITLESS_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const cfg = loadConfig({ home: root, configDir: process.env.LIMITLESS_CONFIG_DIR, raw: {} });
  cfg.workers.agents = ["implement"];
  cfg.workers.repos = ["test/repo"];
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  store.putProviderRow({
    provider: "test",
    state: "degraded",
    reason: "Existing failures",
    until: 10_000,
    windows: {},
    windowObservedAt: {},
    consecutiveFailures: 3,
  });
  const health = store.getProviderRow("test");
  let now = 0;
  const workers = new WorkerStore(store, sha, { tick: 1, pickup: 10 }, () => now);
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const publication: AgentPublication = {
    parentSha,
    baseSha: parentSha,
    branch: "change/test",
    commit: {
      message: "Change\n",
      authorName: "Test",
      authorEmail: "test@example.com",
      committerName: "Test",
      committerEmail: "test@example.com",
    },
    repoUrl: "https://github.com/test/repo.git",
    expectedRemoteSha: null,
    discreet: false,
    uiUrl: "https://example.com",
    privateStringsDigest: "c".repeat(64),
  };
  let prepared = 0,
    adopted = 0,
    locals = 0;
  const call: AgentCall = {
    runId: "run",
    invocationId: 1,
    role: "implement",
    repoSlug: "test/repo",
    worktree: root,
    shadow: false,
    private: false,
    denyRead: undefined,
    slottedCommands: [],
    dispatch() {},
    spec: {
      cwd: root,
      mode: "edit",
      prompt: "Edit",
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 10,
      signal: controller.signal,
      logPath: join(root, "log"),
      onEvent: (e) => events.push(e),
      target: {
        modelId: "test",
        model: "test",
        provider: "test",
        vendor: "test",
        tier: 1,
        harness: "claude",
        billing: "subscription",
      },
    },
    round: 1,
    publication: {
      async started(id) {
        call.agentJob = { round: 1, id };
      },
      async resume() {
        return true;
      },
      async prepare() {
        prepared++;
        return publication;
      },
      async adopt() {
        adopted++;
      },
      async remoteSha() {
        return null;
      },
    },
  };
  const local = async () => {
    locals++;
    return fakeHarness(() => ({ text: "local" }))(call.spec);
  };
  const enqueued = Promise.withResolvers<void>();
  const enqueue = workers.enqueueAgentJob.bind(workers);
  workers.enqueueAgentJob = (request, id) => {
    const job = enqueue(request, id);
    enqueued.resolve();
    return job;
  };
  const run = async () => {
    try {
      return await lanAgentExecutor(workers, cfg).run(call, local);
    } finally {
      expect(store.getProviderRow("test")).toEqual(health);
    }
  };
  const counts = () => ({
    prepared,
    adopted,
    locals,
    jobs: store.db.query<{ n: number }, []>("SELECT count(*) n FROM agent_jobs").get()?.n,
  });
  const job = () => store.db.query<{ id: string }, []>("SELECT id FROM agent_jobs").get()?.id ?? "";
  const report = async () => ({
    ...(await fakeHarness(() => ({ text: "remote" }))(call.spec)),
    parentSha,
    sha,
    branch: publication.branch,
    privateStringsDigest: publication.privateStringsDigest,
  });
  const complete = (id: string, result: unknown) => {
    store.db.query("UPDATE agent_jobs SET state='leased' WHERE id=?").run(id);
    workers.completeAgentJob(id, result, sha);
  };
  return {
    cfg,
    workers,
    store,
    call,
    run,
    enqueued: enqueued.promise,
    counts,
    job,
    report,
    complete,
    events,
    controller,
    advance() {
      now += 11;
    },
  };
}

test.each([
  "agents off",
  "repo excluded",
  "review",
  "no publication",
  "dirty",
  "shadow",
  "private",
  "readonly",
  "other harness",
  "credential target",
])("ineligible agent stays local: %s", async (reason) => {
  const f = fixture();
  if (reason === "agents off") f.cfg.workers.agents = [];
  if (reason === "repo excluded") f.cfg.workers.repos = [];
  if (reason === "review") {
    f.call.role = "review";
    f.cfg.workers.agents = ["review"];
  }
  if (reason === "no publication") f.call.publication = undefined;
  if (reason === "dirty" && f.call.publication) f.call.publication.prepare = async () => null;
  if (reason === "shadow") f.call.shadow = true;
  if (reason === "private") f.call.private = true;
  if (reason === "readonly") f.call.spec.mode = "readonly";
  if (reason === "other harness") f.call.spec.target.harness = "fake";
  if (reason === "credential target")
    f.call.spec.target.backend = { baseUrl: "https://example.com", authToken: "fixture-key" };
  expect((await f.run()).finalText).toBe("local");
  expect(f.counts()).toMatchObject({ locals: 1, jobs: 0, adopted: 0 });
});

test.each([
  "failed",
  "no pickup",
  "malformed",
  "withheld",
  "confinement",
  "cancelled session",
  "cancelled job",
])("worker infrastructure falls back once: %s", async (reason) => {
  const f = fixture();
  const running = f.run();
  await f.enqueued;
  const id = f.job();
  if (reason === "no pickup") {
    f.advance();
    f.workers.sweepAgentJobs();
    f.advance();
    f.workers.sweepAgentJobs();
  } else if (reason === "failed") {
    f.workers.failAgentJob(id, "Disconnected");
    f.workers.failAgentJob(id, "Disconnected");
  } else if (reason === "cancelled job") f.workers.cancelAgentJob(id);
  else if (reason === "malformed") {
    f.store.db.query("UPDATE agent_jobs SET state='done',result='{' WHERE id=?").run(id);
  } else {
    const result = await f.report();
    f.complete(
      id,
      reason === "withheld"
        ? "withheld"
        : reason === "confinement"
          ? {
              ...result,
              confinement: {
                ok: false,
                path: null,
                version: null,
                reason: "probe inconclusive",
                exitCode: 1,
              },
            }
          : { ...result, status: "cancelled" },
    );
  }
  expect((await running).finalText).toBe("local");
  expect(f.counts()).toMatchObject({
    locals: 1,
    adopted: reason === "confinement" || reason === "cancelled session" ? 1 : 0,
  });
  expect(f.events.some((e) => e.type === "status" && e.text.includes("running locally"))).toBe(true);
});

test("unreported push stops rather than running locally", async () => {
  const f = fixture();
  if (!f.call.publication) throw new Error("Missing hooks");
  f.call.publication.remoteSha = async () => sha;
  const running = f.run();
  const rejected = running.catch((error) => error);
  await f.enqueued;
  f.workers.failAgentJob(f.job(), "Lost");
  f.workers.failAgentJob(f.job(), "Lost");
  expect(await rejected).toBeInstanceOf(NeedsHumanError);
  expect((await rejected).message).toContain("moved to");
  expect(f.counts()).toMatchObject({ locals: 0, adopted: 0 });
});

test("events use an attempt cursor and adoption precedes the result", async () => {
  const f = fixture();
  if (!f.call.publication) throw new Error("Missing publication");
  const adopt = spyOn(f.call.publication, "adopt");
  const running = f.run();
  await f.enqueued;
  const id = f.job();
  f.store.db
    .query("INSERT INTO agent_job_events (job_id,seq,events,created_at) VALUES (?,0,?,0)")
    .run(id, JSON.stringify([{ type: "text", text: "legacy" }]));
  for (const [attempt, seq, text] of [
    [2, 0, "retry"],
    [1, 1, "second"],
    [1, 0, "first"],
  ] as const)
    f.workers.agentJobEvents(id, attempt, seq, [{ type: "text", text }]);
  f.complete(id, { ...(await f.report()), status: "quota", quota: { windows: {}, exhaustedUntil: 1 } });
  const result = await running;
  expect(result.status).toBe("quota");
  expect(result).not.toHaveProperty("sha");
  expect(f.counts()).toMatchObject({ adopted: 1, locals: 0 });
  expect(adopt).toHaveBeenCalledWith(
    sha,
    expect.objectContaining({ runId: "run", invocationId: 1, prompt: "Edit", parentSha }),
  );
  expect(
    f.events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .slice(-4),
  ).toEqual(["legacy", "first", "second", "retry"]);
  expect(f.workers.agentJobEventsAfter(id, { attempt: 1, seq: 1 }).map((e) => e.attempt)).toEqual([2]);
});

test("abort cancels the waiting job", async () => {
  const f = fixture();
  const running = f.run();
  await f.enqueued;
  f.controller.abort();
  expect((await running).status).toBe("cancelled");
  expect(f.workers.agentJob(f.job())?.state).toBe("cancelled");
  expect(f.workers.cancelledHeld([f.job()], "runner")).toEqual([f.job()]);
  expect(f.counts().locals).toBe(0);
});

test.each([
  ["error", "Cannot read [redacted]"],
  ["string", "Cannot read [redacted]"],
  ["number", "42"],
  ["null", "null"],
  ["undefined", "undefined"],
  ["object", "[object Object]"],
])("unexpected preparation failure stops without dispatch: %s", async (kind, detail) => {
  const f = fixture();
  if (!f.call.publication) throw new Error("Missing hooks");
  const secret = "synthetic-lan-preparation-credential";
  registerCredential("lan-preparation-test", secret);
  const failure = {
    error: new Error(`Cannot read ${secret}`),
    string: `Cannot read ${secret}`,
    number: 42,
    null: null,
    undefined: undefined,
    object: { reason: "unreadable" },
  }[kind];
  f.call.publication.prepare = async () => {
    throw failure;
  };
  const error: unknown = await f.run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NeedsHumanError);
  expect(error).toMatchObject({ message: `Cannot prepare worker job: ${detail}` });
  expect(f.counts()).toMatchObject({ locals: 0, jobs: 0, adopted: 0 });
});

test.each([new NeedsHumanError("Branch moved"), new SimulatedTermination("Restart")])(
  "preparation propagates %s unchanged without dispatch",
  async (error) => {
    const f = fixture();
    if (!f.call.publication) throw new Error("Missing hooks");
    f.call.publication.prepare = async () => {
      throw error;
    };
    await expect(f.run()).rejects.toBe(error);
    expect(f.counts()).toMatchObject({ locals: 0, jobs: 0, adopted: 0 });
  },
);

test.each(["reject", "null", "prepared"])("abort during preparation: %s", async (outcome) => {
  const f = fixture();
  if (!f.call.publication) throw new Error("Missing hooks");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prepare = f.call.publication.prepare;
  const error = new Error("Preparation interrupted");
  f.call.publication.prepare = async () => {
    entered.resolve();
    await release.promise;
    if (outcome === "reject") throw error;
    return outcome === "null" ? null : prepare();
  };
  const running = f.run();
  await entered.promise;
  f.controller.abort();
  release.resolve();
  if (outcome === "reject") await expect(running).rejects.toBe(error);
  else expect(await running).toMatchObject({ status: "cancelled", error: "cancelled", numTurns: 0 });
  expect(f.counts()).toMatchObject({ locals: 0, jobs: 0, adopted: 0 });
});

test("abort when enqueue rejects prevents local fallback", async () => {
  const f = fixture();
  const enqueue = spyOn(f.workers, "enqueueAgentJob").mockImplementation(() => {
    f.controller.abort();
    return null;
  });
  expect(await f.run()).toMatchObject({ status: "cancelled", error: "cancelled", numTurns: 0 });
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(f.counts()).toMatchObject({ locals: 0, jobs: 0 });
});

test.each(["confinement", "cancelled session", "failed job", "cancelled job"])(
  "abort during async worker handling prevents local fallback: %s",
  async (reason) => {
    const f = fixture();
    if (!f.call.publication) throw new Error("Missing hooks");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const adoption = reason === "confinement" || reason === "cancelled session";
    const adopt = spyOn(f.call.publication, "adopt");
    if (adoption)
      adopt.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
    else
      f.call.publication.remoteSha = async () => {
        entered.resolve();
        await release.promise;
        return sha;
      };
    const running = f.run();
    await f.enqueued;
    const id = f.job();
    if (adoption) {
      const result = await f.report();
      f.complete(
        id,
        reason === "confinement"
          ? {
              ...result,
              confinement: {
                ok: false,
                path: null,
                version: null,
                reason: "probe inconclusive",
                exitCode: 1,
              },
            }
          : { ...result, status: "cancelled" },
      );
    } else if (reason === "cancelled job") f.workers.cancelAgentJob(id);
    else {
      f.workers.failAgentJob(id, "Disconnected");
      f.workers.failAgentJob(id, "Disconnected");
    }
    await entered.promise;
    f.controller.abort();
    release.resolve();
    expect(await running).toMatchObject({ status: "cancelled", error: "cancelled", numTurns: 0 });
    expect(adopt).toHaveBeenCalledTimes(adoption ? 1 : 0);
    expect(f.counts()).toMatchObject({ locals: 0, jobs: 1 });
  },
);

async function detach(f: ReturnType<typeof fixture>) {
  const running = f.run();
  await f.enqueued;
  f.controller.abort(new Error("shutdown"));
  expect((await running).status).toBe("cancelled");
  const id = f.job();
  expect(f.workers.agentJob(id)?.state).toBe("queued");
  const controller = new AbortController();
  f.call.spec.signal = controller.signal;
  return { id, controller };
}

test.each(["target", "digest", "HEAD", "dirty", "expected SHA"])(
  "resume mismatch replaces the open job: %s",
  async (mismatch) => {
    const f = fixture();
    const { id } = await detach(f);
    const hooks = f.call.publication;
    if (!hooks) throw new Error("Missing publication");
    if (mismatch === "target") f.call.spec.target = { ...f.call.spec.target, effort: "high" };
    else hooks.resume = async () => false;
    const next = Promise.withResolvers<string>();
    const started = hooks.started;
    hooks.started = async (id) => {
      await started(id);
      next.resolve(id);
    };
    const running = f.run();
    const newId = await next.promise;
    // The id is durable before its row exists.
    expect(f.workers.agentJob(newId)).toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.workers.agentJob(id)?.state).toBe("cancelled");
    f.complete(newId, await f.report());
    expect((await running).finalText).toBe("remote");
    expect(f.counts()).toMatchObject({ jobs: 2, locals: 0, adopted: 1 });
  },
);

test.each(["queued", "finished during resume", "already done", "owner cancellation", "ineligible"])(
  "reconciliation: %s",
  async (scenario) => {
    const f = fixture();
    const { id, controller } = await detach(f);
    const hooks = f.call.publication;
    if (!hooks) throw new Error("Missing publication");
    f.workers.agentJobEvents(id, 1, 0, [{ type: "text", text: "old batch" }]);
    if (scenario === "already done") f.complete(id, await f.report());
    if (scenario === "finished during resume")
      hooks.resume = async () => {
        f.complete(id, await f.report());
        return false;
      };
    if (scenario === "ineligible") f.cfg.workers.agents = [];
    const running = f.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (scenario === "owner cancellation") controller.abort();
    else if (scenario === "queued") {
      f.workers.agentJobEvents(id, 1, 1, [{ type: "text", text: "new batch" }]);
      f.complete(id, await f.report());
    }
    const result = await running;
    expect(f.counts().jobs).toBe(1);
    expect(f.counts().prepared).toBe(1);
    if (scenario === "owner cancellation" || scenario === "ineligible") {
      expect(f.workers.agentJob(id)?.state).toBe("cancelled");
      expect(result.status).toBe(scenario === "ineligible" ? "ok" : "cancelled");
      expect(f.workers.cancelledHeld([id], "runner")).toEqual([id]);
    } else {
      expect(result.finalText).toBe("remote");
      expect(f.counts().adopted).toBe(1);
      if (scenario === "queued") {
        expect(f.events.filter((e) => e.type === "text").map((e) => e.text)).toEqual(["remote", "new batch"]);
        expect(f.events).toContainEqual({ type: "status", text: `Re-attached worker job ${id} attempt 1` });
      }
    }
  },
);

test.each(["queued", "leased", "done", "failed", "cancelled", "missing"])(
  "reconciliation exception rechecks the job before cancelling: %s",
  async (state) => {
    const f = fixture();
    const { id } = await detach(f);
    const hooks = f.call.publication;
    if (!hooks) throw new Error("Missing publication");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const error = new Error("Reconciliation failed");
    hooks.resume = async () => {
      entered.resolve();
      await release.promise;
      throw error;
    };
    f.store.db.query("UPDATE agent_jobs SET state='leased' WHERE id=?").run(id);
    const dispatch = spyOn(f.call, "dispatch");
    const cancel = spyOn(f.workers, "cancelAgentJob");
    const running = f.run().catch((error: unknown) => error);
    await entered.promise;
    if (state === "done") f.complete(id, await f.report());
    else if (state === "missing") f.store.db.query("DELETE FROM agent_jobs WHERE id=?").run(id);
    else f.store.db.query("UPDATE agent_jobs SET state=? WHERE id=?").run(state, id);
    release.resolve();
    const result = await running;
    if (state === "done") {
      expect(result).toMatchObject({ finalText: "remote" });
      expect(f.workers.agentJob(id)?.state).toBe("done");
      expect(f.counts().adopted).toBe(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toBe(error);
      expect(f.workers.agentJob(id)?.state).toBe(
        state === "missing" ? undefined : state === "failed" ? "failed" : "cancelled",
      );
      expect(f.counts().adopted).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
    }
    expect(cancel).toHaveBeenCalledTimes(state === "queued" || state === "leased" ? 1 : 0);
    expect(f.counts()).toMatchObject({ prepared: 1, jobs: state === "missing" ? 0 : 1, locals: 0 });
  },
);

test("done job for another target is adopted before a new dispatch", async () => {
  const f = fixture();
  const { id } = await detach(f);
  f.complete(id, await f.report());
  f.call.spec.target = { ...f.call.spec.target, modelId: "other" };
  const hooks = f.call.publication;
  if (!hooks) throw new Error("Missing publication");
  const started = hooks.started;
  const next = Promise.withResolvers<string>();
  hooks.started = async (id) => {
    expect(f.counts().adopted).toBe(1);
    await started(id);
    next.resolve(id);
  };
  const running = f.run();
  const newId = await next.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.complete(newId, { ...(await f.report()), finalText: "new target" });
  expect((await running).finalText).toBe("new target");
  expect(f.counts()).toMatchObject({ jobs: 2, adopted: 2, locals: 0 });
});

function reviewFixture() {
  const f = fixture();
  f.cfg.workers.agents = ["review", "verify", "holdout"];
  f.call.role = "review";
  f.call.spec.mode = "readonly";
  f.call.publication = undefined;
  f.call.checkout = { parentSha, baseSha: sha, branch: "change/review" };
  return f;
}

test.each([
  "eligible",
  "agents off",
  "repo excluded",
  "shadow",
  "private",
  "backend",
  "openai",
  "decisions",
  "verify",
  "holdout",
  "no checkout",
  "publication",
  "edit",
  "other harness",
])("readonly review eligibility: %s", async (reason) => {
  const f = reviewFixture();
  if (reason === "agents off") f.cfg.workers.agents = ["implement"];
  if (reason === "repo excluded") f.cfg.workers.repos = [];
  if (reason === "shadow") f.call.shadow = true;
  if (reason === "private") f.call.private = true;
  if (reason === "backend" || reason === "openai" || reason === "decisions")
    Object.assign(f.call.spec.target, { [reason]: { baseUrl: "https://example.com" } });
  if (reason === "verify" || reason === "holdout") f.call.role = reason;
  if (reason === "no checkout") f.call.checkout = undefined;
  if (reason === "publication")
    f.call.publication = {
      async started() {
        throw new Error("Unexpected publication");
      },
      async resume() {
        throw new Error("Unexpected publication");
      },
      async prepare() {
        throw new Error("Unexpected publication");
      },
      async adopt() {
        throw new Error("Unexpected publication");
      },
      async remoteSha() {
        throw new Error("Unexpected publication");
      },
    };
  if (reason === "edit") f.call.spec.mode = "edit";
  if (reason === "other harness") f.call.spec.target.harness = "fake";
  const running = f.run();
  if (reason === "eligible") {
    await f.enqueued;
    const request = JSON.parse(f.workers.agentJob(f.job())?.request ?? "null");
    expect(request).toMatchObject({ role: "review", mode: "readonly", ...f.call.checkout });
    for (const key of ["commit", "repoUrl", "expectedRemoteSha", "privateStringsDigest", "discreet", "uiUrl"])
      expect(request).not.toHaveProperty(key);
    f.complete(f.job(), {
      ...(await f.report()),
      branch: "change/review",
      sha: parentSha,
      privateStringsDigest: undefined,
    });
  }
  expect((await running).finalText).toBe(reason === "eligible" ? "remote" : "local");
  expect(f.counts()).toMatchObject({
    jobs: reason === "eligible" ? 1 : 0,
    locals: reason === "eligible" ? 0 : 1,
    prepared: 0,
    adopted: 0,
  });
  expect(f.call.agentJob).toBeUndefined();
});

test.each([
  "failed",
  "malformed",
  "parentSha",
  "branch",
  "sha",
  "confinement",
  "cancelled job",
  "cancelled session",
])("readonly review falls back once without provider health changes: %s", async (reason) => {
  const f = reviewFixture();
  const running = f.run();
  await f.enqueued;
  const id = f.job();
  if (reason === "failed") {
    f.workers.failAgentJob(id, "Disconnected");
    f.workers.failAgentJob(id, "Disconnected");
  } else if (reason === "cancelled job") f.workers.cancelAgentJob(id);
  else if (reason === "malformed") f.complete(id, {});
  else {
    f.complete(id, {
      ...(await f.report()),
      parentSha,
      branch: "change/review",
      sha: parentSha,
      privateStringsDigest: undefined,
      ...(["parentSha", "branch", "sha"].includes(reason) ? { [reason]: sha } : {}),
      ...(reason === "cancelled session" ? { status: "cancelled" } : {}),
      ...(reason === "confinement"
        ? {
            confinement: { ok: false, path: null, version: null, reason: "probe inconclusive", exitCode: 1 },
          }
        : {}),
    });
  }
  expect((await running).finalText).toBe("local");
  expect(f.counts()).toMatchObject({ locals: 1, prepared: 0, adopted: 0 });
  expect(f.events.some((e) => e.type === "status" && e.text.includes("running locally"))).toBe(true);
});

test.each(["queued", "leased"])("shutdown cancels %s review jobs without a durable handle", async (state) => {
  const f = reviewFixture();
  const running = f.run();
  await f.enqueued;
  const id = f.job();
  f.store.db.query("UPDATE agent_jobs SET state=? WHERE id=?").run(state, id);
  f.controller.abort(new Error("shutdown"));
  expect((await running).status).toBe("cancelled");
  expect(f.workers.agentJob(id)?.state).toBe("cancelled");
  expect(f.counts()).toMatchObject({ locals: 0 });
  expect(f.call.agentJob).toBeUndefined();
});
