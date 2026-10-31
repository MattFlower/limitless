import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { createDefectOutbox } from "../src/integrations/defect-outbox.ts";
import {
  type DefectEvidence,
  type DefectPreparationDeps,
  guardDefectPublication,
  parseDefectEnvelope,
} from "../src/integrations/defect-publication.ts";

const repo: Repo = {
  id: "source",
  slug: "example/product",
  kind: "github",
  url: null,
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
  createdAt: 1,
};
const finding: DefectEvidence = {
  sourceId: repo.id,
  detector: "gate",
  class: "setup",
  phase: "check",
  checkIdentity: "lint",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "defect-outbox-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.sqlite");
  let store = new Store(path);
  cleanup.push(() => store.close());
  let enabled: boolean | undefined = true;
  let calls = 0;
  const deps: DefectPreparationDeps & {
    coordinator: () => { enabled: boolean } | undefined;
  } = {
    factory: "Example/Factory",
    repos: [repo],
    coordinator: () => (enabled === undefined ? undefined : { enabled }),
    identity: async () => {
      calls++;
      return { kind: "app", botLogin: "factory[bot]", token: "unused" };
    },
    policy: async () => {
      calls++;
      return { discreet: false };
    },
    loadPrivateStrings: () => [],
    registeredCredentials: () => [],
  };
  return {
    get store() {
      return store;
    },
    outbox: () => createDefectOutbox(store, deps),
    deps,
    get calls() {
      return calls;
    },
    enable: (value: typeof enabled) => {
      enabled = value;
    },
    reopen: () => {
      store.close();
      store = new Store(path);
    },
    count: (table = "defect_outbox") =>
      store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n,
  };
}

test("submission and consumption roll back together; replay preserves the committed occurrence", async () => {
  const f = fixture();
  const submit = await f.outbox().prepareSubmission("event-1", finding);
  expect(() =>
    f.store.db.transaction(() => {
      submit(() => f.store.setSetting("consumed", "yes"));
      throw new Error("interrupted checkpoint transaction");
    })(),
  ).toThrow("interrupted checkpoint transaction");
  expect(f.count()).toBe(0);
  expect(f.count("defect_signatures")).toBe(0);
  expect(f.store.getSetting("consumed", "no")).toBe("no");
  const row = submit(() => f.store.setSetting("consumed", "yes"));
  expect(row?.state).toBe("prepared");
  expect(row?.occurrence).toMatch(/^[a-f0-9]{32}$/u);
  const calls = f.calls;
  f.reopen();
  expect(f.store.getSetting("consumed", "no")).toBe("yes");
  f.deps.identity = async () => {
    throw new Error("replay must not prepare again");
  };
  expect((await f.outbox().prepareSubmission("event-1", finding))()).toEqual(row);
  expect(f.calls).toBe(calls);
  expect(f.count()).toBe(1);
  expect(f.count("defect_signatures")).toBe(1);
});

test("a failing consumed checkpoint rolls back the nested outbox transaction", async () => {
  const f = fixture();
  const submit = await f.outbox().prepareSubmission("event", finding);
  expect(() =>
    submit(() => {
      f.store.setSetting("consumed", "yes");
      throw new Error("checkpoint failure");
    }),
  ).toThrow("checkpoint failure");
  f.reopen();
  expect(f.count()).toBe(0);
  expect(f.count("defect_signatures")).toBe(0);
  expect(f.store.getSetting("consumed", "no")).toBe("no");
});

test("only approved projections and the posting login are persisted; destination is pinned", async () => {
  const f = fixture();
  const submit = await f.outbox().prepareSubmission("event", finding);
  f.deps.factory = "example/other";
  const row = submit();
  expect(row).toMatchObject({
    destination: "example/factory",
    title: "Factory defect",
    app_login: "factory[bot]",
    operation: null,
    reservation_day: null,
    scan_page: 1,
    scan_matches: "[]",
  });
  if (!row?.body || !row.title || !row.signature || !row.occurrence)
    throw new Error("missing approved projection");
  expect(parseDefectEnvelope(row.body, "issue")).toEqual({
    signature: row.signature,
    occurrence: row.occurrence,
  });
  expect(guardDefectPublication({ title: row.title, body: row.body }, f.deps).status).toBe("safe");
  expect(JSON.parse(row.body.split("\n").at(-2) ?? "")).toEqual({
    detector: "gate",
    class: "setup",
    phase: "check",
    checkIdentity: "lint",
    history: [],
    shas: [],
    runRefs: [],
    landRefs: [],
    checkedPrContext: [],
    timestamps: [],
    sourceKind: "github",
    sourceIdentity: "example/product",
    machineRole: "unknown",
    introducingPr: "unknown",
  });
  f.reopen();
  expect(f.outbox().read(repo.id, "event")).toEqual(row);
});

test("overlapping preparations of a source key reuse one occurrence and signature row", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.outbox().prepareSubmission("event", finding),
    f.outbox().prepareSubmission("event", finding),
  ]);
  expect(a()?.occurrence).toBe(b()?.occurrence);
  expect(f.count()).toBe(1);
  const c = (await f.outbox().prepareSubmission("other-event", finding))();
  expect(c?.occurrence).not.toBe(a()?.occurrence);
  expect(c?.signature).toBe(a()?.signature);
  expect(f.count()).toBe(2);
  expect(f.count("defect_signatures")).toBe(1);
});

test.each(["blocked", "suppressed", "no-report"] as const)(
  "%s submissions persist only the source key and fixed status",
  async (state) => {
    const f = fixture();
    if (state === "blocked") f.deps.loadPrivateStrings = () => [{ value: "lint", entry: 1 }];
    if (state === "suppressed") f.deps.policy = async () => ({ discreet: true });
    const row = (
      await f.outbox().prepareSubmission("event", {
        ...finding,
        class: state === "no-report" ? "regression" : "setup",
      })
    )();
    expect(row?.state).toBe(state);
    for (const value of [
      row?.title,
      row?.body,
      row?.comment_body,
      row?.signature,
      row?.occurrence,
      row?.destination,
      row?.app_login,
    ])
      expect(value).toBeNull();
    expect(row?.diagnostic).toBe(state === "blocked" ? "Defect publication blocked" : null);
    expect(f.count("defect_signatures")).toBe(0);
  },
);

test.each(["credential", "policy", "unavailable"])(
  "the final persistence guard rejects newly changed %s without unsafe diagnostics",
  async (change) => {
    const f = fixture();
    const submit = await f.outbox().prepareSubmission("event", {
      ...finding,
      checkIdentity: "credential\nsecret",
    });
    if (change === "credential") f.deps.registeredCredentials = () => ["credential\nsecret"];
    if (change === "policy") f.deps.loadPrivateStrings = () => [{ value: "credential\nsecret", entry: 1 }];
    if (change === "unavailable")
      f.deps.loadPrivateStrings = () => {
        throw new Error("private error credential\nsecret");
      };
    expect(submit()).toMatchObject({
      state: "blocked",
      title: null,
      body: null,
      app_login: null,
      diagnostic: "Defect publication blocked",
    });
    expect(f.count("defect_signatures")).toBe(0);
  },
);

test.each([false, undefined])("%s coordinator context makes no calls or mutations", async (value) => {
  const f = fixture();
  f.enable(value);
  let consumed = false;
  const submit = await f.outbox().prepareSubmission("event", finding);
  expect(
    submit(() => {
      consumed = true;
    }),
  ).toBeUndefined();
  expect(f.calls).toBe(0);
  expect(f.count()).toBe(0);
  expect(consumed).toBe(false);
});

test("disabling after preparation prevents persistence and checkpoint consumption", async () => {
  const f = fixture();
  const submit = await f.outbox().prepareSubmission("event", finding);
  f.enable(false);
  let consumed = false;
  expect(
    submit(() => {
      consumed = true;
    }),
  ).toBeUndefined();
  expect(consumed).toBe(false);
  expect(f.count()).toBe(0);
});

test("disabling during policy lookup prevents subsequent policy and App calls", async () => {
  const f = fixture();
  let policyCalls = 0;
  f.deps.policy = async () => {
    policyCalls++;
    f.enable(false);
    return { discreet: false };
  };
  expect((await f.outbox().prepareSubmission("event", finding))()).toBeUndefined();
  expect(policyCalls).toBe(1);
  expect(f.calls).toBe(0);
  expect(f.count()).toBe(0);
});

test("a suppressed source key never releases a payload when discreet policy is removed", async () => {
  const f = fixture();
  f.deps.policy = async () => ({ discreet: true });
  const suppressed = (await f.outbox().prepareSubmission("event", finding))();
  expect(suppressed?.state).toBe("suppressed");
  f.reopen();
  f.deps.policy = async () => ({ discreet: false });
  expect((await f.outbox().prepareSubmission("event", finding))()).toEqual(suppressed);
  expect(f.count()).toBe(1);
  expect(f.count("defect_signatures")).toBe(0);
});
