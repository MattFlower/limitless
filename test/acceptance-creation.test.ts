import { expect, mock, test } from "bun:test";
import type { CreateRunRequest, Run } from "../src/core/types.ts";
import { IssueClaimed, Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { ACCEPTANCE_BLOCK, acceptanceEngine, acceptanceRunRequest } from "../src/pipeline/acceptance.ts";
import { initialRunState, RunContext, type RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

const userContentEdits = { nodes: [], pageInfo: { hasNextPage: false } };
const ticket = {
  userContentEdits,
  number: 2,
  body: "## The original intent\n> The goal.",
  author: { login: "owner" },
};
const parent = { userContentEdits, number: 1, body: "The goal.", author: { login: "owner" } };
const request = (number = 2): CreateRunRequest => ({
  repo: "example/repo",
  source: "github",
  sourceRef: { kind: "issue", repo: "example/repo", number },
  prompt: "Assess the intent",
});
const repoInput = {
  slug: "example/repo",
  kind: "github" as const,
  url: "https://github.com/example/repo.git",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr" as const,
};

test("untrusted ticket or parent text and missing parents refuse before creation", () => {
  const store = new Store(":memory:");
  try {
    const repo = store.upsertRepo(repoInput);
    for (const [input, reason] of [
      [{ ticket, parent: null, trusted: ["owner"] }, "no parent"],
      [
        { ticket: { ...ticket, author: { login: "stranger" } }, parent, trusted: ["owner"] },
        "ticket: untrusted author",
      ],
      [
        {
          ticket,
          parent: { ...parent, lastEditedAt: "edited", editor: { login: "stranger" } },
          trusted: ["owner"],
        },
        "parent: untrusted body editor",
      ],
      [
        { ticket, parent: { ...parent, lastEditedAt: "edited" }, trusted: ["owner"] },
        "parent: untrusted body editor",
      ],
      ...(["ticket", "parent"] as const).map(
        (name) =>
          [
            {
              ticket,
              parent,
              trusted: ["owner"],
              [name]: {
                ...(name === "ticket" ? ticket : parent),
                lastEditedAt: "edited",
                editor: { login: "owner" },
                userContentEdits: {
                  nodes: [{ editor: { login: "owner" } }, { editor: { login: "stranger" } }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
            `${name}: untrusted body editor: stranger`,
          ] as const,
      ),
    ] as const) {
      expect(() =>
        store.createAcceptanceRun(
          repo,
          request(),
          acceptanceRunRequest({
            ...input,
            trusted: [...input.trusted],
          }),
        ),
      ).toThrow(reason);
      expect(store.listRuns()).toHaveLength(0);
    }
    expect(acceptanceRunRequest({ ticket, parent, trusted: ["OWNER"] })).toEqual({ ticket, parent });
  } finally {
    store.close();
  }
});

test("the first INSERT includes every default and both rollback guards, within the issue claim", async () => {
  const f = await fixture();
  try {
    const store = f.factory.store;
    const repo = store.upsertRepo(repoInput);
    store.db.exec(`CREATE TEMP TABLE first_state (state TEXT);
      CREATE TEMP TRIGGER record_first_state AFTER INSERT ON runs BEGIN
        INSERT INTO first_state VALUES (NEW.state_json);
      END;`);
    const snapshot = acceptanceRunRequest({ ticket, parent, trusted: ["owner"] });
    const run = store.createAcceptanceRun(repo, request(), snapshot);
    const defaults: RunState = {
      flow: "build",
      phase: "prepare",
      answers: [],
      round: 0,
      roundsOnImplementer: 0,
      triedImplementers: [],
      feedback: null,
      toolCommands: [],
    };
    expect(initialRunState(run)).toEqual(defaults);
    expect(initialRunState({ sourceRef: { kind: "pull_request" } })).toEqual({
      ...defaults,
      flow: "verify-change",
    });
    const expected: RunState = {
      ...defaults,
      flow: "acceptance",
      acceptance: { snapshot },
      needsHumanReason: ACCEPTANCE_BLOCK,
      deliveryComplete: true,
    };
    expect(run.flow).toBe("acceptance");
    const first = store.db.query<{ state: string }, []>("SELECT state FROM first_state").get();
    expect(JSON.parse(first?.state ?? "null")).toEqual(expected);
    expect(store.getRunState<RunState>(run.id)).toEqual(expected);
    expect(new RunContext(f.factory.deps, run, repo, new AbortController().signal).state).toEqual(expected);
    expect(() => store.createAcceptanceRun(repo, request(), snapshot)).toThrow(IssueClaimed);
    expect(store.listRuns()).toHaveLength(1);
    expect(() => store.createAcceptanceRun(repo, { ...request(), sourceRef: undefined }, snapshot)).toThrow(
      "ticket issue sourceRef",
    );
    expect(store.listRuns()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("HTTP run input cannot set persisted acceptance state or its flow", async () => {
  const f = await fixture();
  try {
    const route = (createHttpRoutes(f.factory)["/api/runs"] as { POST: Route }).POST;
    const response = await route(
      requestWithParams("http://localhost/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: f.repo,
          prompt: "Ordinary run",
          flow: "acceptance",
          state_json: { deliveryComplete: true },
          state: { flow: "acceptance" },
          acceptance: { snapshot: { ticket, parent } },
        }),
      }),
      localServer,
    );
    expect(response.status).toBe(201);
    const run = (await response.json()) as Run;
    expect(run.flow).toBe("build");
    expect(f.factory.store.getRunState(run.id)).toBeNull();
  } finally {
    await f.close();
  }
});

test("failed acceptance runs refuse factory and HTTP retry without creating a build", async () => {
  const f = await fixture();
  try {
    const reader = mock(() => ({}));
    f.factory.deps.harnesses = { fake: fakeHarness(reader) };
    const store = f.factory.store;
    const run = store.createAcceptanceRun(store.upsertRepo(repoInput), request(), { ticket, parent });
    store.updateRun(run.id, { status: "failed", error: "Check failed", finishedAt: Date.now() });
    const original = store.getRun(run.id);
    const state = store.getRunState<RunState>(run.id);
    if (!original || !state) throw new Error("missing acceptance run or state");
    const reason = "acceptance runs are restarted from the ticket, not retried";
    await expect(f.factory.retryRun(run.id)).rejects.toThrow(reason);
    const retry = (createHttpRoutes(f.factory)["/api/runs/:id/retry"] as { POST: Route }).POST;
    const response = await retry(
      requestWithParams(
        `http://localhost/api/runs/${run.id}/retry`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        { id: run.id },
      ),
      localServer,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: reason });
    expect(store.listRuns()).toEqual([original]);
    expect(store.getRunState<RunState>(run.id)).toEqual(state);
    expect(store.listStages(run.id)).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("persisted acceptance guards block an engine without acceptance handling at all checkpoints", async () => {
  const f = await fixture();
  try {
    acceptanceEngine.enabled = false;
    const store = f.factory.store;
    const repo = store.upsertRepo(repoInput);
    const gh = mock(async () => {
      throw new Error("unexpected GitHub call");
    });
    const reader = mock(() => ({}));
    const deps = { ...f.factory.deps, gh, harnesses: { fake: fakeHarness(reader) } };
    for (const checkpoint of ["created", "prepared", "output"] as const) {
      const number = checkpoint === "created" ? 2 : checkpoint === "prepared" ? 3 : 4;
      const snapshot = { ticket: { ...ticket, number }, parent };
      const run = store.createAcceptanceRun(repo, request(number), snapshot);
      const state = store.getRunState<RunState>(run.id);
      if (!state) throw new Error("missing initial state");
      if (checkpoint !== "created")
        store.setRunState(run.id, {
          ...state,
          phase: "accept",
          worktreePath: f.repo,
          acceptance: {
            snapshot,
            sha: "a".repeat(40),
            setupDone: true,
            ...(checkpoint === "output" ? { output: { items: [] } } : {}),
          },
        });
      // The seam gives the previous release's block, with no acceptance allowance.
      expect(await executeRun(deps, run.id, new AbortController().signal)).toBe("needs_human");
      expect(store.getRun(run.id)).toMatchObject({
        status: "needs_human",
        error: ACCEPTANCE_BLOCK,
        branch: null,
        prUrl: null,
      });
      expect(store.getRunState<RunState>(run.id)).toMatchObject({
        needsHumanReason: ACCEPTANCE_BLOCK,
        deliveryComplete: true,
      });
    }
    expect(gh).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  } finally {
    acceptanceEngine.enabled = true;
    await f.close();
  }
});
