import { expect, spyOn, test } from "bun:test";
import { Store } from "../src/db/store.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { EventLoopLag } from "../src/server/event-loop-lag.ts";
import { redactCredentials, registerCredential } from "../src/util/proc.ts";
import { StallReporter, stallReporter } from "../src/util/stall.ts";

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
    expect(lines[0]?.match(/store\.query-[a-f0-9]+: count=3 total=186ms max=75ms/g)).toHaveLength(3);
    for (const marker of markers) expect(lines[0]).not.toContain(marker);
    stallReporter.sample(4000);
    expect(lines[1]).not.toContain("store.query-");
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
    expect(lines[0]).toMatch(/store\.query-[a-f0-9]+: count=2 total=110ms max=55ms/);
    expect(lines[0]).toMatch(/store\.query-[a-f0-9]+: count=1 total=80ms max=80ms/);
    expect(lines[0]).toMatch(/store\.query-[a-f0-9]+: count=1 total=65ms max=65ms/);
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
    expect(lines[0]).toMatch(/store\.query-[a-f0-9]+: count=100 total=5100ms max=51ms/);
    expect(lines[0]?.match(/store\.query-/g)).toHaveLength(1);
    stallReporter.sample(4000);
    expect(lines[1]).not.toContain("store.query-");
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
      expect(lines[i]).toMatch(/store\.query-[a-f0-9]+: count=1 total=60ms max=60ms/);
      expect(lines[i]?.match(/store\.query-/g)).toHaveLength(1);
      expect(lines[i]).toContain("pending: count=0 total=0ms max=0ms active=1");
    }
    end();
    end();
    timed(5, () => stallReporter.activity("new.activity", () => {}));
    stallReporter.sample(4000);
    expect(lines[70]).toContain("pending: count=1");
    expect(lines[70]).not.toContain("active=");
    expect(lines[70]).toContain("new.activity: count=1 total=5ms max=5ms");
    expect(lines[70]).not.toContain("store.query-");
    stallReporter.sample(4000);
    expect(lines[71]).not.toMatch(/pending|new\.activity|store\.query-/);
  } finally {
    end();
    fixture.close();
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
