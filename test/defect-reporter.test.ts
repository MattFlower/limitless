import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import {
  type DefectEvidence,
  guardDefectPublication,
  parseDefectEnvelope,
  prepareDefectPublication,
} from "../src/integrations/defect-publication.ts";
import {
  createDefectReporter,
  type DefectGitHub,
  type DefectOutboxRow,
  type DefectReporterDeps,
} from "../src/integrations/defect-reporter.ts";
import type { GitHubIdentity } from "../src/integrations/github-identity.ts";

const APP = { kind: "app", botLogin: "factory[bot]", token: "app-token" } as const;
const DAY = Date.UTC(2026, 9, 31, 12);
const FIXED = new Set([
  null,
  "Defect App identity unavailable",
  "Defect label missing",
  "Defect issue lacks label",
  "Defect daily cap reached",
  "Defect delivery check failed",
  "Defect policy unavailable",
  "Defect issue provenance unavailable",
  "Defect object conflicts with outbox",
  "Defect delivery outcome unknown",
  "Defect publication blocked",
]);
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
const finding = (checkIdentity = "lint"): DefectEvidence => ({
  sourceId: repo.id,
  detector: "gate",
  class: "setup",
  phase: "check",
  checkIdentity,
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

type Obj = {
  number: number;
  createdAt: string;
  body: string;
  author: { login: string; type: string };
  lastEditedAt: string | null;
  includesCreatedEdit: boolean;
  labels: { name: string }[];
  state: "open" | "closed";
};
type Post = Parameters<DefectGitHub["post"]>;
type Mode = { apply: boolean; labels: boolean; respond: "ok" | "throw" | "hang" };
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Shared fake GitHub destination; one instance may serve several coordinator databases. */
class Remote {
  issues: Obj[] = [];
  comments = new Map<number, Obj[]>();
  calls: string[] = [];
  posts: Post[] = [];
  label = true;
  mode: Mode = { apply: true, labels: true, respond: "ok" };
  posted = deferred();
  listGate?: () => Promise<void>;
  onLabel?: () => void;
  seq = 0;
  object(body: string, extra: Partial<Obj> = {}): Obj {
    const number = ++this.seq;
    return {
      number,
      createdAt: new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString(),
      body,
      author: { login: APP.botLogin, type: "Bot" },
      lastEditedAt: null,
      includesCreatedEdit: false,
      labels: [],
      state: "open",
      ...extra,
    };
  }
  noise(count: number) {
    for (let i = 0; i < count; i++)
      this.issues.push(this.object(`unrelated ${i}`, { author: { login: "someone", type: "User" } }));
  }
  postsTo = (issue: number | null) => this.posts.filter(([, target]) => target === issue);
  client(): DefectGitHub {
    return {
      list: async (repo, issue, page, token) => {
        this.calls.push(issue === null ? `list:${page.page}` : `comments:${issue}:${page.page}`);
        await this.listGate?.();
        if (token !== APP.token || repo !== "example/factory") throw new Error("unauthenticated read");
        const all =
          issue === null
            ? this.issues.filter((value) => page.state === "all" || value.state === "open")
            : (this.comments.get(issue) ?? []);
        return structuredClone(all.slice((page.page - 1) * page.perPage, page.page * page.perPage));
      },
      issue: async (repo, issue, token) => {
        this.calls.push(`issue:${issue}`);
        if (token !== APP.token || repo !== "example/factory") throw new Error("unauthenticated read");
        return structuredClone(this.issues.find((value) => value.number === issue));
      },
      label: async (_repo, _name, token) => {
        this.calls.push("label");
        this.onLabel?.();
        if (token !== APP.token) throw new Error("unauthenticated read");
        return this.label;
      },
      post: async (...args) => {
        const [repo, issue, input, token] = args;
        this.calls.push(issue === null ? "post:issue" : `post:comment:${issue}`);
        this.posts.push(structuredClone(args));
        if (token !== APP.token || repo !== "example/factory") throw new Error("unauthenticated write");
        const mode = this.mode;
        const labels = mode.labels ? (input.labels ?? []).map((name) => ({ name })) : [];
        const created = this.object(input.body, { labels });
        if (mode.apply && issue === null) this.issues.push(created);
        if (mode.apply && issue !== null)
          this.comments.set(issue, [...(this.comments.get(issue) ?? []), created]);
        this.posted.resolve();
        if (mode.respond === "throw") throw new Error("socket reset secret-response-text");
        if (mode.respond === "hang") return new Promise(() => {});
        return structuredClone(created);
      },
    };
  }
}

function harness(remote = new Remote()) {
  const dir = mkdtempSync(join(tmpdir(), "defect-reporter-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.sqlite");
  let store = new Store(path);
  cleanup.push(() => store.close());
  const clock = { now: DAY, enabled: true as boolean | undefined };
  const deps: DefectReporterDeps = {
    factory: "Example/Factory",
    repos: [repo],
    coordinator: () => (clock.enabled === undefined ? undefined : { enabled: clock.enabled }),
    identity: async (): Promise<GitHubIdentity> => APP,
    policy: async () => ({ discreet: false }),
    loadPrivateStrings: () => [],
    registeredCredentials: () => [],
    github: remote.client(),
    now: () => clock.now,
  };
  let reporter = createDefectReporter(store, deps);
  const h = {
    remote,
    deps,
    clock,
    get store() {
      return store;
    },
    get reporter() {
      return reporter;
    },
    reopen() {
      store.close();
      store = new Store(path);
      reporter = createDefectReporter(store, deps);
    },
    submit: async (key: string, input = finding()) => (await reporter.prepareSubmission(key, input))(),
    row: (key: string) =>
      store.db.query<DefectOutboxRow, [string]>("SELECT * FROM defect_outbox WHERE source_key=?").get(key),
    count: (table = "defect_outbox") =>
      store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n,
    async settle(passes = 6) {
      for (let i = 0; i < passes; i++) await reporter.reconcile();
    },
  };
  return h;
}
const commentOf = (body: string) => body.replace(":v1:issue:", ":v1:comment:");
const withoutOccurrence = (row: { body: string | null; occurrence: string | null } | null) =>
  row?.body?.replace(row.occurrence ?? "", "");
function expectFixedDiagnostics(h: ReturnType<typeof harness>) {
  for (const row of h.store.db.query<DefectOutboxRow, []>("SELECT * FROM defect_outbox").all())
    expect(FIXED.has(row.diagnostic)).toBe(true);
}

test("submission and checkpoint commit together; replay keeps one occurrence; refusals store no payload", async () => {
  const h = harness();
  const submit = await h.reporter.prepareSubmission("event-1", finding());
  expect(() =>
    h.store.db.transaction(() => {
      submit(() => h.store.setSetting("consumed", "yes"));
      throw new Error("interrupted checkpoint transaction");
    })(),
  ).toThrow("interrupted checkpoint transaction");
  expect(h.count()).toBe(0);
  expect(h.store.getSetting("consumed", "no")).toBe("no");
  const row = submit(() => h.store.setSetting("consumed", "yes"));
  expect(row?.state).toBe("prepared");
  h.reopen();
  expect(h.store.getSetting("consumed", "no")).toBe("yes");
  h.deps.identity = async () => {
    throw new Error("replay must not prepare again");
  };
  expect(await h.submit("event-1")).toEqual(row);
  expect(h.count()).toBe(1);

  h.deps.identity = async () => APP;
  h.deps.policy = async () => ({ discreet: true });
  const discreet = await h.submit("discreet");
  h.deps.policy = async () => ({ discreet: false });
  const noReport = await h.submit("regression", { ...finding(), class: "regression" });
  for (const [refused, state] of [
    [discreet, "blocked"],
    [noReport, "no-report"],
  ] as const) {
    expect(refused?.state).toBe(state);
    for (const column of ["title", "body", "signature", "occurrence", "destination", "app_login"] as const)
      expect(refused?.[column]).toBeNull();
  }
});

test("a prepared record stores approved bytes only and is delivered once after reopen and fresh lookup", async () => {
  const h = harness();
  const row = await h.submit("event");
  const fresh = await prepareDefectPublication(finding(), h.deps);
  if (fresh.status !== "prepared" || !row?.body || !row.title)
    throw new Error("expected prepared publication");
  expect(row).toMatchObject({
    destination: fresh.destination,
    signature: fresh.signature,
    title: fresh.title,
    app_login: APP.botLogin,
    comment_body: null,
    operation: null,
  });
  expect(withoutOccurrence(row)).toBe(fresh.body.replace(fresh.occurrence, ""));
  expect(parseDefectEnvelope(row.body, "issue")).toEqual({
    signature: fresh.signature,
    occurrence: row.occurrence ?? "",
  });
  expect(guardDefectPublication({ title: row.title, body: row.body }, h.deps).status).toBe("safe");
  h.reopen();
  expect(h.remote.calls).toEqual([]);
  await h.reporter.reconcile();
  expect(h.remote.calls).toEqual(["list:1", "label", "post:issue"]);
  expect(h.remote.posts[0]?.[2]).toEqual({ title: "Factory defect", body: row.body, labels: ["defect"] });
  expect(h.row("event")).toMatchObject({ state: "delivered", object_id: 1, reservation_day: "2026-10-31" });
  h.reopen();
  await h.settle();
  expect(h.remote.posts).toHaveLength(1);
});

test("reconciliation needs an enabled coordinator and coalesces overlapping calls", async () => {
  const h = harness();
  await h.submit("event");
  for (const value of [false, undefined]) {
    h.clock.enabled = value;
    await h.reporter.reconcile();
    expect(h.remote.calls).toEqual([]);
    expect(h.row("event")).toMatchObject({ state: "prepared", diagnostic: null });
  }
  h.clock.enabled = true;
  const first = h.reporter.reconcile();
  expect(h.reporter.reconcile()).toBe(first);
  await first;
  expect(h.remote.posts).toHaveLength(1);
});

test.each(["issue", "comment"] as const)(
  "a lost %s response is recovered after restart without reposting",
  async (kind) => {
    const h = harness();
    if (kind === "comment") {
      await h.submit("first");
      await h.reporter.reconcile();
    }
    const row = await h.submit("event");
    h.remote.posted = deferred();
    h.remote.mode = { apply: true, labels: true, respond: "hang" };
    void h.reporter.reconcile();
    await h.remote.posted.promise;
    expect(h.row("event")?.state).toBe("sending");
    h.reopen();
    h.remote.mode = { apply: true, labels: true, respond: "ok" };
    await h.settle();
    const expected = kind === "issue" ? h.remote.issues.at(-1) : h.remote.comments.get(1)?.at(-1);
    expect(h.remote.posts).toHaveLength(kind === "issue" ? 1 : 2);
    expect(h.row("event")).toMatchObject({
      state: "delivered",
      object_id: expected?.number,
      operation: kind,
    });
    if (kind === "comment") {
      expect(h.row("event")?.comment_body).toBe(commentOf(row?.body ?? ""));
      expect(expected?.body).toBe(h.row("event")?.comment_body ?? "");
      expect(h.remote.issues).toHaveLength(1);
    }
  },
);

test.each([
  ["body edit", (value: Obj) => Object.assign(value, { body: `${value.body}\nedited` })],
  ["provenance edit", (value: Obj) => Object.assign(value, { lastEditedAt: "2026-10-31T13:00:00Z" })],
  [
    "foreign occurrence marker",
    (value: Obj) =>
      Object.assign(value, { body: value.body.replace('"lint"', `"lint <!-- ${"b".repeat(32)} -->"`) }),
  ],
  [
    "foreign occurrence envelope",
    (value: Obj) =>
      Object.assign(value, { body: value.body.replace(/:[a-f0-9]{32} -->/u, `:${"e".repeat(32)} -->`) }),
  ],
])("a recovered App object with a %s is held, not accepted or reposted", async (_name, edit) => {
  const h = harness();
  await h.submit("event");
  h.remote.mode = { apply: true, labels: true, respond: "hang" };
  void h.reporter.reconcile();
  await h.remote.posted.promise;
  const posted = h.remote.issues.at(-1);
  if (!posted) throw new Error("expected remote issue");
  edit(posted);
  h.reopen();
  await h.settle();
  expect(h.remote.posts).toHaveLength(1);
  expect(h.row("event")).toMatchObject({
    state: "held",
    object_id: null,
    diagnostic: "Defect object conflicts with outbox",
  });
});

test("a remotely created unlabelled issue with a lost response keeps its ID and stays held", async () => {
  const h = harness();
  await h.submit("event");
  h.remote.mode = { apply: true, labels: false, respond: "hang" };
  void h.reporter.reconcile();
  await h.remote.posted.promise;
  h.reopen();
  await h.settle();
  expect(h.remote.posts).toHaveLength(1);
  expect(h.row("event")).toMatchObject({
    state: "held",
    object_id: 1,
    diagnostic: "Defect issue lacks label",
  });
});

test("enumeration is complete, bounded, resumable and comments once on the oldest closed match", async () => {
  const h = harness();
  const existing = await prepareDefectPublication(finding(), h.deps);
  if (existing.status !== "prepared") throw new Error("expected publication");
  h.remote.noise(3250);
  const legitimate = (occurrence: string, state: "open" | "closed", createdAt: string) =>
    h.remote.object(existing.body.replace(existing.occurrence, occurrence), { state, createdAt });
  const duplicate = legitimate("c".repeat(32), "open", "2026-03-01T00:00:00Z");
  const oldest = legitimate("d".repeat(32), "closed", "2026-02-01T00:00:00Z");
  h.remote.issues.push(duplicate, oldest);
  await h.submit("event");
  const perPass: number[] = [];
  for (let pass = 0; pass < 4 && h.row("event")?.state === "prepared"; pass++) {
    const before = h.remote.calls.length;
    await h.reporter.reconcile();
    perPass.push(h.remote.calls.length - before);
    if (h.row("event")?.state === "prepared") {
      expect(h.remote.posts).toHaveLength(0);
      expect(JSON.parse(h.row("event")?.scan ?? "").page).toBeGreaterThan(1);
      h.reopen();
    }
  }
  expect(Math.max(...perPass)).toBeLessThanOrEqual(32);
  expect(perPass.length).toBeGreaterThan(1);
  expect(h.remote.calls.filter((call) => call.startsWith("list:")).at(-1)).toBe("list:33");
  expect(h.remote.calls.at(-1)).toBe(`post:comment:${oldest.number}`);
  expect(h.remote.posts).toHaveLength(1);
  expect(oldest.state).toBe("closed");
  expect(h.row("event")).toMatchObject({ state: "delivered", target_issue: oldest.number });
});

test("a match saved by an earlier pass is inspected again and held once edited", async () => {
  const h = harness();
  const existing = await prepareDefectPublication(finding(), h.deps);
  if (existing.status !== "prepared") throw new Error("expected publication");
  h.remote.noise(150);
  const match = h.remote.object(existing.body.replace(existing.occurrence, "d".repeat(32)));
  h.remote.issues.push(match);
  h.remote.noise(3800);
  await h.submit("event");
  await h.reporter.reconcile();
  expect(JSON.parse(h.row("event")?.scan ?? "").matches).toEqual([[match.number, match.createdAt]]);
  match.lastEditedAt = "2026-10-31T13:00:00Z";
  h.reopen();
  await h.settle();
  expect(h.remote.calls).toContain(`issue:${match.number}`);
  expect(h.remote.posts).toHaveLength(0);
  expect(h.row("event")).toMatchObject({ state: "held", diagnostic: "Defect issue provenance unavailable" });
});

test.each([
  ["missing author", (value: Obj) => Reflect.deleteProperty(value, "author")],
  ["malformed edit provenance", (value: Obj) => Object.assign(value, { lastEditedAt: "yesterday" })],
])("an App candidate with %s cannot authorize creation", async (_name, corrupt) => {
  const h = harness();
  const existing = await prepareDefectPublication(finding(), h.deps);
  if (existing.status !== "prepared") throw new Error("expected publication");
  const candidate = h.remote.object(existing.body.replace(existing.occurrence, "d".repeat(32)));
  corrupt(candidate);
  h.remote.issues.push(candidate);
  await h.submit("event");
  await h.settle();
  expect(h.remote.posts).toHaveLength(0);
  expect(h.row("event")).toMatchObject({ state: "prepared", diagnostic: "Defect delivery check failed" });
});

test("cap-deferred creations do not starve a later occurrence that only needs a comment", async () => {
  const h = harness();
  h.deps.dailyCap = 1;
  h.reopen();
  await h.submit("first");
  await h.reporter.reconcile();
  expect(h.remote.postsTo(null)).toHaveLength(1);
  for (let i = 0; i < 30; i++) await h.submit(`capped-${i}`, finding(`check-${i}`));
  await h.submit("again");
  await h.settle(4);
  expect(h.remote.postsTo(1)).toHaveLength(1);
  expect(h.remote.postsTo(null)).toHaveLength(1);
  expect(h.row("again")).toMatchObject({ state: "delivered", operation: "comment" });
  expect(h.row("capped-0")).toMatchObject({ state: "prepared", diagnostic: "Defect daily cap reached" });
  expect(h.remote.calls.filter((call) => call === "label")).toHaveLength(1);
});

test.each([
  [
    "identity changes during the awaited policy",
    (h: ReturnType<typeof harness>) => {
      h.deps.policy = async () => {
        await Promise.resolve();
        h.deps.identity = async () => ({ kind: "owner" });
        return { discreet: false };
      };
    },
    { state: "prepared", diagnostic: "Defect App identity unavailable" },
  ],
  [
    "policy becomes discreet during the awaited identity",
    (h: ReturnType<typeof harness>) => {
      h.deps.identity = async () => {
        await Promise.resolve();
        h.deps.policy = async () => ({ discreet: true });
        return APP;
      };
    },
    { state: "suppressed", body: null },
  ],
])("%s before dispatch prevents the POST", async (_name, change, expected) => {
  const h = harness();
  await h.submit("event");
  h.remote.onLabel = () => change(h);
  await h.reporter.reconcile();
  expect(h.remote.posts).toHaveLength(0);
  expect(h.row("event")).toMatchObject(expected);
});

test("an ambiguous send without a recoverable object stays uncertain and pauses every POST", async () => {
  const h = harness();
  const row = await h.submit("event");
  h.remote.mode = { apply: false, labels: true, respond: "throw" };
  await h.reporter.reconcile();
  expect(h.row("event")).toMatchObject({
    state: "uncertain",
    diagnostic: "Defect delivery outcome unknown",
    reservation_day: "2026-10-31",
  });
  h.reopen();
  h.remote.mode = { apply: true, labels: true, respond: "ok" };
  h.clock.now += 3 * 86_400_000;
  await h.submit("other", finding("test"));
  await h.settle();
  expect(h.remote.posts).toHaveLength(1);
  expect(h.row("event")?.state).toBe("uncertain");
  expect(h.row("other")?.state).toBe("prepared");
  const late = h.remote.object(row?.body ?? "", { labels: [{ name: "defect" }] });
  h.remote.issues.push(late);
  await h.reporter.reconcile();
  expect(h.row("event")).toMatchObject({ state: "delivered", object_id: late.number });
  expect(h.remote.posts.filter(([, , input]) => input.body === row?.body)).toHaveLength(1);
  expect(h.row("other")?.state).toBe("delivered");
  expectFixedDiagnostics(h);
});

test("the durable UTC cap admits one racing creation, survives reopen, permits comments and rolls over", async () => {
  for (const cap of [0, 1.5, -1])
    expect(() => createDefectReporter(harness().store, { ...harness().deps, dailyCap: cap })).toThrow();
  const h = harness();
  h.deps.dailyCap = 2;
  h.reopen();
  await h.submit("a", finding("a"));
  h.remote.mode = { apply: false, labels: true, respond: "throw" };
  await h.reporter.reconcile();
  expect(h.row("a")?.state).toBe("uncertain");
  h.remote.mode = { apply: true, labels: true, respond: "ok" };
  h.remote.issues.push(h.remote.object(h.row("a")?.body ?? "", { labels: [{ name: "defect" }] }));
  await h.reporter.reconcile();
  expect(h.row("a")).toMatchObject({ state: "delivered", reservation_day: "2026-10-31" });
  await h.submit("b", finding("b"));
  await h.submit("c", finding("c"));
  const other = createDefectReporter(h.store, h.deps);
  await Promise.all([h.reporter.reconcile(), other.reconcile(), h.reporter.reconcile()]);
  h.reopen();
  await h.settle();
  const reservations = () =>
    h.store.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM defect_outbox WHERE reservation_day='2026-10-31'")
      .get()?.n;
  expect(reservations()).toBe(2);
  expect(h.remote.postsTo(null)).toHaveLength(2);
  const capped = h.row("b")?.state === "prepared" ? "b" : "c";
  expect(h.row(capped)).toMatchObject({ state: "prepared", diagnostic: "Defect daily cap reached" });
  await h.submit("a-again", finding("a"));
  await h.settle();
  expect(h.row("a-again")).toMatchObject({ state: "delivered", operation: "comment", reservation_day: null });
  expect(h.row(capped)?.state).toBe("prepared");
  h.clock.now = Date.UTC(2026, 10, 1, 0, 0, 1);
  await h.settle();
  expect(h.row(capped)).toMatchObject({ state: "delivered", reservation_day: "2026-11-01" });
  expect(h.remote.postsTo(null)).toHaveLength(3);
});

test("the default cap is ten new issues per UTC day", async () => {
  const h = harness();
  for (let i = 0; i < 11; i++) await h.submit(`event-${i}`, finding(`check-${i}`));
  await h.settle(8);
  expect(h.remote.postsTo(null)).toHaveLength(10);
  expect(h.count()).toBe(11);
});

test.each([
  ["owner identity", (h: ReturnType<typeof harness>) => (h.deps.identity = async () => ({ kind: "owner" }))],
  [
    "failed identity exchange",
    (h: ReturnType<typeof harness>) =>
      (h.deps.identity = async () => {
        throw new Error("exchange failed secret-exchange-text");
      }),
  ],
  [
    "changed bot login",
    (h: ReturnType<typeof harness>) => (h.deps.identity = async () => ({ ...APP, botLogin: "other[bot]" })),
  ],
  ["missing label", (h: ReturnType<typeof harness>) => (h.remote.label = false)],
  [
    "owner identity during the label check",
    (h: ReturnType<typeof harness>) =>
      (h.remote.onLabel = () => {
        h.deps.identity = async () => ({ kind: "owner" });
      }),
  ],
])("%s never produces a POST or delivered record", async (_name, change) => {
  const h = harness();
  await h.submit("event");
  change(h);
  await h.settle();
  expect(h.remote.posts).toHaveLength(0);
  expect(h.row("event")?.state).toBe("prepared");
  expect(h.row("event")?.diagnostic).not.toBeNull();
  expectFixedDiagnostics(h);
  expect(JSON.stringify(h.row("event"))).not.toContain("secret-exchange-text");
});

test("a creation response lacking `defect` is held with its ID and never replaced", async () => {
  const h = harness();
  await h.submit("event");
  h.remote.mode = { apply: true, labels: false, respond: "ok" };
  await h.settle();
  expect(h.remote.posts).toHaveLength(1);
  expect(h.remote.posts[0]?.[2].labels).toEqual(["defect"]);
  expect(h.row("event")).toMatchObject({
    state: "held",
    object_id: 1,
    diagnostic: "Defect issue lacks label",
  });
});

test.each([
  [
    "escaped credential",
    (h: ReturnType<typeof harness>) => (h.deps.registeredCredentials = () => ["credential\nsecret"]),
  ],
  [
    "private policy",
    (h: ReturnType<typeof harness>) =>
      (h.deps.loadPrivateStrings = () => [{ value: "credential\nsecret", entry: 1 }]),
  ],
  [
    "policy loading failure",
    (h: ReturnType<typeof harness>) =>
      (h.deps.loadPrivateStrings = () => {
        throw new Error("private error credential secret");
      }),
  ],
  [
    "credential registered during the label check",
    (h: ReturnType<typeof harness>) =>
      (h.remote.onLabel = () => {
        h.deps.registeredCredentials = () => ["credential\nsecret"];
      }),
  ],
])("a newly unsafe %s blocks the stored payload before POST", async (_name, change) => {
  const h = harness();
  await h.submit("event", finding("credential\nsecret"));
  change(h);
  await h.settle();
  expect(h.remote.posts).toHaveLength(0);
  expect(h.row("event")).toMatchObject({ state: "blocked", diagnostic: "Defect publication blocked" });
  expectFixedDiagnostics(h);
});

test.each(["source", "destination"])("a %s that becomes discreet is suppressed permanently", async (side) => {
  const h = harness();
  await h.submit("event");
  h.deps.policy = async (target) => ({ discreet: (typeof target === "string") === (side === "destination") });
  await h.settle();
  h.deps.policy = async () => ({ discreet: false });
  await h.settle();
  expect(h.remote.posts).toHaveLength(0);
  expect(h.row("event")).toMatchObject({ state: "suppressed", title: null, body: null, comment_body: null });
});

test("two coordinator databases may duplicate, and a later occurrence comments once on the oldest", async () => {
  const remote = new Remote();
  const [a, b] = [harness(remote), harness(remote)];
  await a.submit("event");
  await b.submit("event");
  const gate = deferred();
  let listed = 0;
  remote.listGate = async () => {
    if (++listed === 2) gate.resolve();
    await gate.promise;
  };
  await Promise.all([a.reporter.reconcile(), b.reporter.reconcile()]);
  remote.listGate = undefined;
  expect(remote.postsTo(null)).toHaveLength(2);
  const [older] = remote.issues;
  await b.submit("later");
  await b.settle();
  expect(remote.postsTo(null)).toHaveLength(2);
  expect(remote.calls.filter((call) => call.startsWith("post:comment"))).toEqual([
    `post:comment:${older?.number}`,
  ]);
  expect(b.row("later")).toMatchObject({ state: "delivered", target_issue: older?.number });
});

test("two occurrences of one signature create one issue and one comment", async () => {
  const h = harness();
  await h.submit("a");
  await h.submit("b");
  await h.reporter.reconcile();
  expect(h.remote.calls.slice(0, 2)).toEqual(["list:1", "list:1"]);
  expect(h.remote.postsTo(null)).toHaveLength(1);
  expect(h.row("b")?.state).toBe("prepared");
  await h.settle();
  expect(h.remote.postsTo(null)).toHaveLength(1);
  expect(h.remote.postsTo(1)).toHaveLength(1);
  expect(h.row("b")).toMatchObject({ state: "delivered", operation: "comment", target_issue: 1 });
});

test("a saved negative scan resumed after reopen still cannot create a second issue", async () => {
  const h = harness();
  h.remote.noise(250);
  await h.submit("a");
  await h.submit("b");
  h.remote.label = false;
  await h.reporter.reconcile();
  expect(JSON.parse(h.row("b")?.scan ?? "").page).toBe(3);
  expect(h.remote.posts).toHaveLength(0);
  h.reopen();
  h.remote.label = true;
  await h.reporter.reconcile();
  expect(h.remote.postsTo(null)).toHaveLength(1);
  expect(h.row("b")?.state).toBe("prepared");
  await h.settle();
  const created = h.remote.issues.at(-1)?.number ?? 0;
  expect(h.remote.postsTo(null)).toHaveLength(1);
  expect(h.remote.postsTo(created)).toHaveLength(1);
  expect(h.row("b")).toMatchObject({ state: "delivered", target_issue: created });
});
