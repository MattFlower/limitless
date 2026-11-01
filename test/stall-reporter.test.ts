import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { WorkerStore } from "../src/db/workers.ts";
import * as gateExecution from "../src/gates/executor.ts";
import { collectGarbage } from "../src/gc.ts";
import * as gitCommand from "../src/git/command.ts";
import * as repos from "../src/git/repos.ts";
import { startIssueQueue } from "../src/integrations/issue-queue.ts";
import { LandQueue } from "../src/land/queue.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { EventLoopLag } from "../src/server/event-loop-lag.ts";
import { redactCredentials, registerCredential } from "../src/util/proc.ts";
import { activity, StallReporter, stallReporter } from "../src/util/stall.ts";
import { waitClock } from "./wait-clock.ts";

function timedStore() {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE stall_rows (id INTEGER PRIMARY KEY, value TEXT UNIQUE)");
  let time = 0;
  let step = 0;
  const lines: string[] = [];
  const clock = spyOn(stallReporter, "now").mockImplementation(() => {
    const at = time;
    time += step;
    return at;
  });
  const log = spyOn(console, "warn").mockImplementation((line: string) => lines.push(line));
  stallReporter.sample(0);
  return {
    store,
    lines,
    advance(duration: number) {
      time += duration;
    },
    timed<T>(duration: number, fn: () => T): T {
      step = duration;
      try {
        return fn();
      } finally {
        step = 0;
      }
    },
    close() {
      stallReporter.sample(0);
      clock.mockRestore();
      log.mockRestore();
      store.close();
    },
  };
}

test("Store run, get and all time only executions over 50ms, including cached statements", () => {
  const fixture = timedStore();
  const { store, timed, lines } = fixture;
  try {
    const sql = "INSERT INTO stall_rows(value) VALUES (?)";
    const insert = store.db.query(sql);
    const get = store.db.prepare<{ value: string }, [number]>("SELECT value FROM stall_rows WHERE id=?");
    const all = store.db.query<{ value: string }, []>("SELECT value FROM stall_rows ORDER BY id");
    const markers = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (const [index, duration] of [49, 50, 51, 75, 60].entries()) {
      const value = markers[index] ?? "";
      // Reacquiring a cached statement must neither lose timing nor double-wrap it.
      expect(store.db.query(sql)).toBe(insert);
      expect(timed(duration, () => insert.run(value))).toEqual({
        changes: 1,
        lastInsertRowid: index + 1,
      });
      expect(timed(duration, () => get.get(index + 1))).toEqual({ value });
      expect(timed(duration, () => all.all())).toEqual(
        markers.slice(0, index + 1).map((value) => ({ value })),
      );
    }
    stallReporter.sample(4000);
    expect(lines).toHaveLength(1);
    expect(
      lines[0]?.match(/store\.(?:select|insert)-stall_rows-[a-f0-9]{8}: count=3 total=186ms max=75ms/g),
    ).toHaveLength(3);
    for (const marker of markers) expect(lines[0]).not.toContain(marker);
    stallReporter.sample(4000);
    expect(lines[1]).not.toContain("store.");
  } finally {
    fixture.close();
  }
});

test("Store labels exclude SQL literals and data; slow failures retain SQLite errors and rollback", () => {
  const fixture = timedStore();
  const { store, timed, lines } = fixture;
  try {
    const markers = [crypto.randomUUID(), crypto.randomUUID()];
    for (const marker of markers) {
      const literal = `${marker} -- comment ' quote /* literal */`.replaceAll("'", "''");
      expect(timed(55, () => store.db.prepare(`SELECT '${literal}' AS value`).get())).toEqual({
        value: `${marker} -- comment ' quote /* literal */`,
      });
    }
    store.db.query("INSERT INTO stall_rows VALUES (1, ?)").run(markers[0] ?? "");
    const insert = store.db.prepare("INSERT INTO stall_rows VALUES (?, ?)");
    let failure: unknown;
    try {
      store.db
        .transaction(() => {
          insert.run(2, markers[1] ?? "");
          timed(80, () => insert.run(3, markers[0] ?? ""));
        })
        .immediate();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "SQLiteError",
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: stall_rows.value",
    });
    expect(store.db.inTransaction).toBe(false);
    expect(store.db.query("SELECT id FROM stall_rows").all()).toEqual([{ id: 1 }]);
    const error = new Error(crypto.randomUUID());
    const values = {
      get value(): string {
        throw error;
      },
    };
    let caught: unknown;
    try {
      timed(65, () => store.db.prepare("SELECT $value").get(values));
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
    stallReporter.sample(4000);
    expect(lines[0]).toMatch(/store\.select-[a-f0-9]{8}: count=2 total=110ms max=55ms/);
    expect(lines[0]).toMatch(/store\.insert-stall_rows-[a-f0-9]{8}: count=1 total=80ms max=80ms/);
    expect(lines[0]).toMatch(/store\.select-[a-f0-9]{8}: count=1 total=65ms max=65ms/);
    expect(lines[0]).not.toContain(error.message);
    for (const marker of [...markers, "UNIQUE", "constraint", "literal"]) {
      expect(lines[0]).not.toContain(marker);
    }
    insert.finalize();
    expect(() => insert.run(4, "unused")).toThrow();
  } finally {
    fixture.close();
  }
});

test("distinct fast Store query shapes leave capacity for a later slow query", () => {
  const fixture = timedStore();
  const { store, timed, lines } = fixture;
  try {
    for (let i = 0; i < 100; i++) {
      timed(1, () => store.db.query(`SELECT ? AS column_${i}`).get(crypto.randomUUID()));
    }
    const query = store.db.query("SELECT ? AS result");
    for (let i = 0; i < 100; i++) timed(51, () => query.get(crypto.randomUUID()));
    stallReporter.sample(4000);
    expect(lines[0]).toMatch(/store\.select-[a-f0-9]{8}: count=100 total=5100ms max=51ms/);
    expect(lines[0]?.match(/store\.select-/g)).toHaveLength(1);
    stallReporter.sample(4000);
    expect(lines[1]).not.toContain("store.select-");
  } finally {
    fixture.close();
  }
});

test("sample reclaims completed Store query slots while preserving active handles", () => {
  const fixture = timedStore();
  const { store, timed, lines } = fixture;
  const end = stallReporter.beginActivity("pending");
  try {
    for (let i = 0; i < 70; i++) {
      timed(60, () => store.db.query(`SELECT ? AS column_${i}`).get(crypto.randomUUID()));
      stallReporter.sample(4000);
      expect(lines[i]).toMatch(/store\.select-[a-f0-9]{8}: count=1 total=60ms max=60ms/);
      expect(lines[i]?.match(/store\.select-/g)).toHaveLength(1);
      expect(lines[i]).toContain("pending: count=0 total=0ms max=0ms active=1");
    }
    end();
    end();
    timed(5, () => stallReporter.activity("new.activity", () => {}));
    stallReporter.sample(4000);
    expect(lines[70]).toContain("pending: count=1");
    expect(lines[70]).not.toContain("active=");
    expect(lines[70]).toContain("new.activity: count=1 total=5ms max=5ms");
    expect(lines[70]).not.toContain("store.select-");
    stallReporter.sample(4000);
    expect(lines[71]).not.toMatch(/pending|new\.activity|store\.select-/);
  } finally {
    end();
    fixture.close();
  }
});

test("Store labels name SQL structure while stripping comments, literals and parameters", () => {
  const fixture = timedStore();
  const { store, timed, lines } = fixture;
  const markers = Array.from({ length: 3 }, () => `data_${crypto.randomUUID().replaceAll("-", "")}`);
  const [bound, literal, comment] = markers;
  try {
    const shapes = [
      ["SELECT value FROM stall_rows WHERE value=?", "select-stall_rows"],
      ["INSERT INTO stall_rows(value) VALUES (?)", "insert-stall_rows"],
      ["UPDATE OR IGNORE stall_rows SET value=value WHERE value=?", "update-stall_rows"],
      [`UPDATE stall_rows SET value='${literal}' WHERE value=?`, "update-stall_rows"],
      ["WITH selected AS (SELECT * FROM stall_rows) SELECT * FROM selected WHERE value=?", "with-stall_rows"],
      [`SELECT '${literal}' AS value, ? AS bound`, "select"],
      ["SELECT value FROM stall_rows ORDER BY value, ?", "select-stall_rows"],
    ];
    const labels: string[] = [];
    for (const [sql, label] of shapes) {
      timed(75, () => store.db.prepare(`/* ${comment} FROM decoy */ -- ${comment}\n${sql}`).all(bound ?? ""));
      stallReporter.sample(4000);
      const line = lines.at(-1) ?? "";
      expect(line).toMatch(new RegExp(`store\\.${label}-[a-f0-9]{8}: count=1 total=75ms max=75ms`));
      for (const marker of [...markers, "decoy"]) expect(line).not.toContain(marker);
      labels.push(line);
    }
    expect(labels[0]).not.toBe(labels[6]);
    store.db.exec(`CREATE TABLE "${literal}" (value)`);
    timed(60, () => store.db.prepare(`SELECT * FROM "${literal}"`).all());
    stallReporter.sample(4000);
    expect(lines.at(-1)).toMatch(/store\.select-[a-f0-9]{8}:/);
    expect(lines.at(-1)).not.toContain(literal ?? "");
    const parameter = bound ?? "unused";
    timed(60, () => store.db.prepare(`SELECT $${parameter}`).get({ [parameter]: literal ?? "" }));
    stallReporter.sample(4000);
    expect(lines.at(-1)).toMatch(/store\.select-[a-f0-9]{8}:/);
    for (const marker of markers) expect(lines.at(-1)).not.toContain(marker);
  } finally {
    fixture.close();
  }
});

test.each(["default", "deferred", "immediate", "exclusive"] as const)(
  "Store transaction %s times success and failure, preserving receivers, arguments and rollback",
  (mode) => {
    const fixture = timedStore();
    const { store, advance, lines } = fixture;
    const receiver = { result: {} };
    const sentinel = new Error(crypto.randomUUID());
    try {
      const transaction = store.db.transaction(function (
        this: typeof receiver,
        duration: number,
        fail: boolean,
      ) {
        expect(this).toBe(receiver);
        store.db.query("INSERT INTO stall_rows(value) VALUES (?)").run(String(duration));
        advance(duration);
        if (fail) throw sentinel;
        return this.result;
      });
      const execute = mode === "default" ? transaction : transaction[mode];
      for (const duration of [49, 50]) expect(execute.call(receiver, duration, false)).toBe(receiver.result);
      stallReporter.sample(4000);
      expect(lines[0]).not.toContain("store.");
      expect(execute.call(receiver, 51, false)).toBe(receiver.result);
      let caught: unknown;
      try {
        execute.call(receiver, 80, true);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      expect(store.db.inTransaction).toBe(false);
      expect(store.db.query("SELECT value FROM stall_rows ORDER BY id").all()).toEqual([
        { value: "49" },
        { value: "50" },
        { value: "51" },
      ]);
      stallReporter.sample(4000);
      expect(lines[1]).toContain(`store.transaction-${mode}: count=2 total=131ms max=80ms`);
      expect(lines[1]).not.toContain(sentinel.message);
      stallReporter.sample(4000);
      expect(lines[2]).not.toContain("store.transaction");
    } finally {
      fixture.close();
    }
  },
);

test("nested Store and direct transactions retain inner statement attribution and variant identities", () => {
  const fixture = timedStore();
  const { store, advance, lines } = fixture;
  try {
    const insert = store.db.query("INSERT INTO stall_rows(value) VALUES ($value)");
    const nested = store.db.transaction(() =>
      insert.run({
        get value() {
          advance(75);
          return "value";
        },
      }),
    );
    // Bun exposes the same variant family on every callable, including its default alias.
    const family = nested as typeof nested & { default: typeof nested; database: Database };
    expect(family.default).toBe(nested);
    expect(family.database).toBe(store.db);
    expect((family.immediate as typeof family).exclusive).toBe(nested.exclusive);
    expect(store.transaction(() => store.transaction(() => nested.immediate()))).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    stallReporter.sample(4000);
    expect(lines[0]).toContain("store.transaction-deferred: count=1 total=75ms max=75ms");
    expect(lines[0]).toContain("store.transaction-immediate: count=1 total=75ms max=75ms");
    expect(lines[0]).toMatch(/store\.insert-stall_rows-[a-f0-9]{8}: count=1 total=75ms max=75ms/);
  } finally {
    fixture.close();
  }
});

test("Store immediate transaction reports a real lock wait even when BEGIN throws SQLITE_BUSY", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-lock-"));
  const lines: string[] = [];
  let store: Store | undefined;
  let holder: Database | undefined;
  const log = spyOn(console, "warn").mockImplementation((line: string) => lines.push(line));
  try {
    store = new Store(join(dir, "store.db"));
    holder = new Database(join(dir, "store.db"));
    store.db.exec("PRAGMA busy_timeout=150");
    holder.exec("BEGIN IMMEDIATE");
    stallReporter.sample(0);
    let entered = false;
    let caught: unknown;
    try {
      store.transaction(() => {
        entered = true;
      }, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "SQLITE_BUSY" });
    expect(entered).toBe(false);
    expect(store.db.inTransaction).toBe(false);
    stallReporter.sample(4000);
    expect(lines[0]).toMatch(/store\.transaction-immediate: count=1 total=\d+ms max=\d+ms/);
  } finally {
    if (holder?.inTransaction) holder.exec("ROLLBACK");
    holder?.close();
    store?.close();
    stallReporter.sample(0);
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one stall line per late sample, including the threshold boundary", () => {
  let time = 0;
  const lines: string[] = [];
  const reporter = new StallReporter(
    () => time,
    (line) => lines.push(line),
  );
  const lag = new EventLoopLag(() => time);
  for (const lateness of [0, 1999, 4500, 2000, 0]) {
    time += 1000 + lateness;
    reporter.sample(lag.sample());
  }
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("lag=4500ms");
  expect(lines[1]).toContain("lag=2000ms");
});

test("completed, throwing and active work is aggregated, sorted, capped and reset", () => {
  let time = 0;
  const lines: string[] = [];
  const reporter = new StallReporter(
    () => time,
    (line) => lines.push(line),
  );
  reporter.activity("old", () => {
    time += 10;
  });
  reporter.sample(0);
  reporter.activity("ci-log.inspect", () => {
    time += 3000;
  });
  const error = new Error("same error");
  expect(() =>
    reporter.activity("report.render", () => {
      time += 100;
      throw error;
    }),
  ).toThrow(error);
  try {
    reporter.activity("throw.identity", () => {
      throw error;
    });
  } catch (caught) {
    expect(caught).toBe(error);
  }
  const value = {};
  expect(reporter.activity("return.identity", () => value)).toBe(value);
  for (let i = 0; i < 50; i++)
    reporter.activity("redact", () => {
      time++;
    });
  const end = reporter.beginActivity("poller.cycle");
  time += 2000;
  reporter.sample(4000);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("ci-log.inspect: count=1 total=3000ms max=3000ms");
  expect(lines[0]).toContain("report.render: count=1 total=100ms");
  expect(lines[0]).toContain("redact: count=50 total=50ms");
  expect(lines[0]).toContain("poller.cycle: count=0 total=0ms max=0ms active=1 elapsed=2000ms");
  expect(lines[0]).not.toContain("old");
  expect(lines[0]?.match(/count=/g)).toHaveLength(5);
  expect(lines[0]?.indexOf("ci-log.inspect")).toBeLessThan(lines[0]?.indexOf("poller.cycle") ?? 0);
  end();
  end();
  reporter.sample(4000);
  expect(lines[1]).toContain("poller.cycle: count=1 total=2000ms");
  expect(lines[1]).not.toContain("active=");
  reporter.sample(4000);
  expect(lines[2]).not.toContain("poller.cycle");
  for (let i = 0; i < 10_000; i++)
    reporter.activity(`bounded-${i}`, () => {
      time++;
    });
  reporter.sample(4000);
  expect(lines[3]?.match(/count=/g)).toHaveLength(5);
});

test("real credential and report paths preserve output and record their work", () => {
  let time = 0;
  const lines: string[] = [];
  const clock = spyOn(stallReporter, "now").mockImplementation(() => time++);
  const log = spyOn(console, "warn").mockImplementation((line: string) => {
    lines.push(line);
  });
  try {
    stallReporter.sample(0);
    registerCredential("STALL_TEST_TOKEN", "synthetic-stall-token");
    expect(redactCredentials("value=synthetic-stall-token")).toBe("value=[redacted]");
    expect(redactCredentials("value=synthetic-stall-token", { start: 10, end: 20 })).toBe("[redacted]");
    expect(["plain", "synthetic-stall-token"].map(redactCredentials)).toEqual(["plain", "[redacted]"]);
    const report = renderReport({
      success: true,
      runId: "r1",
      prompt: "Build",
      state: {},
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "u",
    });
    expect(report).toStartWith("Built by **Limitless**");
    stallReporter.sample(4000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("credentials.redact");
    expect(lines[0]).toContain("report.render");
  } finally {
    clock.mockRestore();
    log.mockRestore();
  }
});

function backgroundFixture() {
  const f = timedStore();
  const root = mkdtempSync(join(tmpdir(), "stall-background-"));
  const marker = crypto.randomUUID();
  const cfg = loadConfig({
    home: root,
    configDir: join(root, "config"),
    raw: { github: { queue: { repos: [`owner/${marker}`], trusted: [marker] } } },
  });
  const repo = f.store.upsertRepo({
    slug: `owner/${marker}`,
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  return {
    ...f,
    root,
    cfg,
    repo,
    marker,
    block() {
      f.advance(3000);
      stallReporter.sample(3000);
    },
    active(label: string, count = 1, elapsed = 3000) {
      expect(f.lines.at(-1)).toContain(
        `${label}: count=0 total=0ms max=0ms active=${count} elapsed=${elapsed}ms`,
      );
      expect(f.lines.at(-1)).not.toContain(marker);
      expect(f.lines.at(-1)).not.toContain(root);
      expect(f.lines.at(-1)).not.toContain(repo.id);
    },
    settled(label: string) {
      stallReporter.sample(3000);
      expect(f.lines.at(-1)).toContain(`${label}: count=1`);
      expect(f.lines.at(-1)).not.toContain("active=");
      stallReporter.sample(3000);
      expect(f.lines.at(-1)).not.toContain(label);
    },
    close() {
      f.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const operation of ["gc.collect", "workers.sweep", "workers.sweep-agent-jobs"] as const) {
  test.each([false, true])(
    `${operation} covers synchronous work and cleans up on failure=%s`,
    async (fail) => {
      const f = backgroundFixture();
      const failure = new Error(f.marker);
      const callback = () => {
        f.block();
        f.active(operation);
        if (fail) throw failure;
        return 0;
      };
      const workers = new WorkerStore(f.store, f.marker, {}, callback);
      const finished = spyOn(f.store, "finishedRuns");
      if (operation === "gc.collect")
        finished.mockImplementation(() => {
          callback();
          return [];
        });
      try {
        const invoke = () =>
          operation === "gc.collect"
            ? collectGarbage(f.store, f.cfg)
            : operation === "workers.sweep"
              ? workers.sweep()
              : workers.sweepAgentJobs();
        if (fail) {
          let caught: unknown;
          try {
            await invoke();
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(failure);
        } else await invoke();
        f.settled(operation);
        expect(f.lines.join("\n")).not.toContain(failure.message);
      } finally {
        finished.mockRestore();
        f.close();
      }
    },
  );
}

test.each(["resume", "shutdown"] as const)(
  "drain is one session across repeated requests until %s",
  async (finish) => {
    const f = backgroundFixture();
    const factory = new Factory(f.cfg, { store: f.store, providers: [] });
    try {
      factory.scheduler.drain();
      factory.scheduler.drain();
      f.block();
      f.active("deploy.drain");
      await Promise.resolve();
      factory.scheduler.drain();
      f.block();
      f.active("deploy.drain", 1, 6000);
      if (finish === "resume") factory.scheduler.resume();
      else await factory.scheduler.stop();
      f.settled("deploy.drain");
      if (finish === "resume") {
        factory.scheduler.drain();
        f.block();
        f.active("deploy.drain");
        factory.scheduler.resume();
        f.settled("deploy.drain");
      }
    } finally {
      await factory.stop();
      f.close();
    }
  },
);

test.each(["success", "failure", "cancelled"] as const)(
  "complete issue polling spans lifecycle work and awaits: %s",
  async (outcome) => {
    const f = backgroundFixture();
    const factory = new Factory(f.cfg, { store: f.store, providers: [] });
    const clock = waitClock();
    const gate = Promise.withResolvers<string>();
    const done = Promise.withResolvers<void>();
    // Lifecycle reconciliation precedes the per-repository span.
    const lifecycle = spyOn(f.store, "issueLifecycleRuns").mockImplementation(() => {
      f.block();
      f.active("issue-queue.poll");
      expect(f.lines.at(-1)).not.toContain("issue-queue.repository");
      return [];
    });
    const stop = startIssueQueue(factory, {
      clock: { now: clock.now, set: clock.timer.set as typeof setTimeout, clear: clock.timer.clear },
      gh: async (_args, signal) => {
        signal?.addEventListener("abort", () => gate.reject(new Error(f.marker)), { once: true });
        try {
          return await gate.promise;
        } finally {
          done.resolve();
        }
      },
      log: () => {},
      lifecycle: { identity: async () => ({ kind: "owner" }) },
    });
    try {
      await clock.advance(0);
      f.block();
      f.active("issue-queue.poll", 1, 6000);
      expect(f.lines.at(-1)).toContain(
        "issue-queue.repository: count=0 total=0ms max=0ms active=1 elapsed=3000ms",
      );
      if (outcome === "success")
        gate.resolve("HTTP/2.0 200 OK\r\nDate: Thu, 01 Jan 2026 00:00:00 GMT\r\n\r\n{}");
      else if (outcome === "failure") gate.reject(new Error(f.marker));
      else stop();
      await done.promise;
      await clock.flush();
      f.settled("issue-queue.poll");
      expect(f.lines.join("\n")).not.toContain(f.marker);
    } finally {
      stop();
      lifecycle.mockRestore();
      await factory.stop();
      f.close();
    }
  },
);

function landFixture(f: ReturnType<typeof backgroundFixture>) {
  const entry = f.store.createLandEntry({
    runId: null,
    repo: f.repo.slug,
    prUrl: `https://github.com/${f.repo.slug}/pull/123`,
    approvedSha: "a".repeat(40),
    baseBranch: "main",
    headBranch: f.marker,
  });
  const queue = new LandQueue({ store: f.store, paths: f.cfg.paths });
  const internals = queue as unknown as {
    checks: (typeof queue)["checks"];
    merge: (typeof queue)["merge"];
    assertClaim: (id: number) => void;
    mergeMetadata: (typeof queue)["mergeMetadata"];
    landed: (typeof queue)["landed"];
  };
  const claim = spyOn(internals, "assertClaim").mockImplementation(() => {});
  return { queue: internals, entry, claim };
}

test.each(["failure", "cancelled"] as const)(
  "land checks retain overlapping spans through awaits: %s",
  async (outcome) => {
    const f = backgroundFixture();
    const { queue, entry, claim } = landFixture(f);
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let calls = 0;
    const exportCommit = spyOn(repos, "exportCommit").mockImplementation(async () => {
      const gate = gates[calls++];
      if (!gate) throw new Error("unexpected export");
      return gate.promise;
    });
    const controllers = [new AbortController(), new AbortController()];
    const failures = controllers.map((c) => {
      c.signal.addEventListener("abort", () => gates[0]?.reject(c.signal.reason));
      return new Error(f.marker);
    });
    const pending: Promise<unknown>[] = [];
    try {
      for (const [i, c] of controllers.entries()) {
        pending.push(
          queue
            .checks({ ...entry, id: entry.id + i }, join(f.root, String(i)), "a".repeat(40), c.signal)
            .catch((e: unknown) => e),
        );
      }
      f.block();
      f.active("land.check", 2, 6000);
      if (outcome === "cancelled") controllers[0]?.abort(failures[0]);
      else gates[0]?.reject(failures[0]);
      expect(await pending[0]).toBe(failures[0]);
      stallReporter.sample(3000);
      expect(f.lines.at(-1)).toContain("land.check: count=1 total=3000ms max=3000ms active=1 elapsed=3000ms");
      gates[1]?.reject(failures[1]);
      expect(await pending[1]).toBe(failures[1]);
      f.settled("land.check");
      expect(f.lines.join("\n")).not.toContain(f.marker);
    } finally {
      for (const gate of gates) gate.reject(new Error("cleanup"));
      await Promise.allSettled(pending);
      exportCommit.mockRestore();
      claim.mockRestore();
      f.close();
    }
  },
);

test.each(["early", "failure", "cancelled", "success"] as const)(
  "land merge span settles on %s",
  async (outcome) => {
    const f = backgroundFixture();
    const { queue, entry, claim } = landFixture(f);
    const gate = Promise.withResolvers<"merged">();
    const controller = new AbortController();
    const failure = new Error(f.marker);
    controller.signal.addEventListener("abort", () => gate.reject(failure));
    const getEntry = spyOn(f.store, "getLandEntry").mockImplementationOnce(() => {
      f.block();
      f.active("land.merge");
      return { ...entry, state: outcome === "early" ? "cancelled" : "waiting_ci" };
    });
    const merge = spyOn(repos, "mergePullRequest").mockImplementation(() => gate.promise);
    const metadata = spyOn(queue, "mergeMetadata").mockResolvedValue(null);
    const landed = spyOn(queue, "landed").mockImplementation(() => {});
    try {
      const pending = queue
        .merge(
          entry,
          f.repo,
          join(f.root, "checkout"),
          entry.approvedSha,
          f.marker,
          f.marker,
          controller.signal,
        )
        .catch((e: unknown) => e);
      if (outcome !== "early") {
        f.block();
        f.active("land.merge", 1, 6000);
        if (outcome === "failure") gate.reject(failure);
        else if (outcome === "cancelled") controller.abort();
        else gate.resolve("merged");
      }
      expect(await pending).toBe(outcome === "failure" || outcome === "cancelled" ? failure : undefined);
      f.settled("land.merge");
      expect(f.lines.join("\n")).not.toContain(f.marker);
    } finally {
      getEntry.mockRestore();
      merge.mockRestore();
      metadata.mockRestore();
      landed.mockRestore();
      claim.mockRestore();
      f.close();
    }
  },
);

function gcRuns(f: ReturnType<typeof backgroundFixture>, count = 3) {
  return Array.from({ length: count }, () => {
    const run = f.store.createRun(f.repo, { repo: f.repo.slug, prompt: f.marker });
    f.store.updateRun(run.id, { status: "succeeded", finishedAt: 1 });
    const logDir = join(f.cfg.paths.runs, run.id);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "inv-1.log"), f.marker);
    return { run, logDir, worktree: join(f.cfg.paths.work, run.id) };
  });
}

test.each([49, 50, 51])(
  "GC aggregates synchronous filesystem passes at %sms, retained after span closes",
  async (duration) => {
    const f = backgroundFixture();
    const runs = gcRuns(f);
    const originalExists = fs.existsSync,
      originalLstat = fs.lstatSync;
    const seen = new Set<string>();
    const exists = spyOn(fs, "existsSync").mockImplementation((path) => {
      const key = String(path);
      if (runs.some((r) => r.worktree === key) && !seen.has(key)) {
        seen.add(key);
        f.advance(duration / runs.length);
      }
      return originalExists(path);
    });
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (runs.some((r) => r.logDir === String(args[0]))) f.advance(duration / (runs.length * 2));
      return originalLstat(...args);
    }) as typeof fs.lstatSync);
    try {
      const result = await collectGarbage(f.store, f.cfg, { now: Date.now() });
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(3);
      expect(result.worktrees).toEqual([]);
      stallReporter.sample(3000);
      expect(f.lines.at(-1)).not.toContain("active=");
      for (const label of ["gc.worktrees", "gc.logs"]) {
        if (duration > 50) expect(f.lines.at(-1)).toContain(`${label}: count=1 total=51ms max=51ms`);
        else expect(f.lines.at(-1)).not.toContain(label);
      }
      expect(f.lines.at(-1)).not.toContain(f.marker);
      for (const { run } of runs) expect(f.lines.at(-1)).not.toContain(run.id);
      stallReporter.sample(3000);
      expect(f.lines.at(-1)).not.toContain("gc.");
    } finally {
      exists.mockRestore();
      lstat.mockRestore();
      f.close();
    }
  },
);

test("GC awaits Git under its span without inflating synchronous scan timing", async () => {
  const f = backgroundFixture();
  const runs = gcRuns(f, 1);
  const run = runs[0];
  if (!run) throw new Error("missing run");
  mkdirSync(run.worktree, { recursive: true });
  const gate = Promise.withResolvers<never>();
  const ready = Promise.withResolvers<void>();
  const originalExists = fs.existsSync;
  let scanned = false;
  const exists = spyOn(fs, "existsSync").mockImplementation((path) => {
    if (String(path) === run.worktree && !scanned) {
      f.advance(51);
      scanned = true;
    }
    return originalExists(path);
  });
  const git = spyOn(gitCommand, "cacheGit").mockImplementation(() => {
    ready.resolve();
    return gate.promise;
  });
  try {
    const pending = collectGarbage(f.store, f.cfg, { dryRun: true });
    await ready.promise;
    f.block();
    f.active("gc.collect", 1, 3051);
    gate.reject(new Error(f.marker));
    const result = await pending;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(f.marker);
    stallReporter.sample(3000);
    expect(f.lines.at(-1)).not.toContain("active=");
    // The first sample consumed the completed scan; the Git wait creates no second measurement.
    expect(f.lines.at(-1)).not.toContain("gc.worktrees");
    expect(f.lines[0]).toContain("gc.worktrees: count=1 total=51ms max=51ms");
    expect(f.lines.join("\n")).not.toContain(f.marker);
  } finally {
    exists.mockRestore();
    git.mockRestore();
    f.close();
  }
});

test.each([50, 51])("thresholded synchronous activity retains exceptional completion at %sms", (duration) => {
  const f = timedStore();
  const error = new Error(crypto.randomUUID());
  try {
    expect(() =>
      activity(
        "gc.logs",
        () => {
          f.advance(duration);
          throw error;
        },
        50,
      ),
    ).toThrow(error);
    stallReporter.sample(3000);
    if (duration > 50) expect(f.lines.at(-1)).toContain("gc.logs: count=1 total=51ms max=51ms");
    else expect(f.lines.at(-1)).not.toContain("gc.logs");
    expect(f.lines.at(-1)).not.toContain(error.message);
  } finally {
    f.close();
  }
});

test("successful land checks keep their span through gate completion", async () => {
  const f = backgroundFixture();
  const { queue, entry, claim } = landFixture(f);
  const ready = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof gateExecution.executeGate>>>();
  const exported = spyOn(repos, "exportCommit").mockResolvedValue(undefined);
  const head = spyOn(repos, "headSha").mockResolvedValue(entry.approvedSha);
  const execute = spyOn(gateExecution, "executeGate").mockImplementation(() => {
    ready.resolve();
    return gate.promise;
  });
  let pending: Promise<void> | undefined;
  try {
    pending = queue.checks(entry, join(f.root, "checkout"), entry.approvedSha, new AbortController().signal);
    await ready.promise;
    f.block();
    f.active("land.check");
    gate.resolve({ setupOk: true, setup: [], checks: [] });
    await pending;
    f.settled("land.check");
  } finally {
    gate.resolve({ setupOk: true, setup: [], checks: [] });
    await pending?.catch(() => {});
    execute.mockRestore();
    head.mockRestore();
    exported.mockRestore();
    claim.mockRestore();
    f.close();
  }
});

test("land check cleanup remains in flight and cannot leak its span when filesystem cleanup fails", async () => {
  const f = backgroundFixture();
  const { queue, entry, claim } = landFixture(f);
  const failure = new Error(f.marker);
  const exported = spyOn(repos, "exportCommit").mockRejectedValue(new Error("export failed"));
  const originalRm = fs.rmSync;
  let calls = 0;
  const rm = spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (String(path) === join(f.root, "checkout-base") && ++calls === 2) {
      f.block();
      f.active("land.check");
      throw failure;
    }
    return originalRm(path, options);
  });
  try {
    const result = await queue
      .checks(entry, join(f.root, "checkout"), entry.approvedSha, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(result).toBe(failure);
    f.settled("land.check");
    expect(f.lines.join("\n")).not.toContain(f.marker);
  } finally {
    rm.mockRestore();
    exported.mockRestore();
    claim.mockRestore();
    f.close();
  }
});

test("GC records slow filesystem failures without publishing their data", async () => {
  const f = backgroundFixture();
  const [run] = gcRuns(f, 1);
  if (!run) throw new Error("missing run");
  const originalExists = fs.existsSync;
  const exists = spyOn(fs, "existsSync").mockImplementation((path) => {
    if (String(path) === run.worktree || String(path) === run.logDir) {
      f.advance(51);
      throw new Error(f.marker);
    }
    return originalExists(path);
  });
  try {
    const result = await collectGarbage(f.store, f.cfg, { dryRun: true });
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((error) => error.includes(f.marker))).toBe(true);
    stallReporter.sample(3000);
    for (const label of ["gc.worktrees", "gc.logs"])
      expect(f.lines.at(-1)).toContain(`${label}: count=1 total=51ms max=51ms`);
    expect(f.lines.at(-1)).not.toContain("active=");
    expect(f.lines.at(-1)).not.toContain(f.marker);
    expect(f.lines.at(-1)).not.toContain(run.run.id);
  } finally {
    exists.mockRestore();
    f.close();
  }
});
