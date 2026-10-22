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
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";

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
    publication: {
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
  const run = () => lanAgentExecutor(workers, cfg).run(call, local);
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
  await Promise.resolve();
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
  expect(f.counts().locals).toBe(1);
  expect(f.events.some((e) => e.type === "status" && e.text.includes("running locally"))).toBe(true);
});

test("unreported push stops rather than running locally", async () => {
  const f = fixture();
  if (!f.call.publication) throw new Error("Missing hooks");
  f.call.publication.remoteSha = async () => sha;
  const running = f.run();
  const rejected = running.catch((error) => error);
  await Promise.resolve();
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
  await Promise.resolve();
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
  await Promise.resolve();
  f.controller.abort();
  expect((await running).status).toBe("cancelled");
  expect(f.workers.agentJob(f.job())?.state).toBe("cancelled");
  expect(f.workers.cancelledHeld([f.job()], "runner")).toEqual([f.job()]);
  expect(f.counts().locals).toBe(0);
});

test("preparation refusal does not dispatch", async () => {
  const f = fixture();
  if (!f.call.publication) throw new Error("Missing hooks");
  f.call.publication.prepare = async () => {
    throw new NeedsHumanError("Branch moved");
  };
  await expect(f.run()).rejects.toThrow("Branch moved");
  expect(f.counts()).toMatchObject({ locals: 0, jobs: 0 });
});
