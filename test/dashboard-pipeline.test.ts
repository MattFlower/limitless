import { expect, test } from "bun:test";
import type { Run, RunStatus, StageName } from "../src/core/types.ts";
import type { DayStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import { padDays } from "../ui/lib/days.ts";
import { pipelineCounts } from "../ui/lib/pipeline.ts";

function runs(cases: [RunStatus, StageName | null][]): Run[] {
  const store = new Store(":memory:");
  try {
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const base = store.createRun(repo, { repo: repo.slug, prompt: "Pipeline work" });
    return cases.map(([status, stage], i) => ({ ...base, id: `run-${i}`, status, stage }));
  } finally {
    store.close();
  }
}

test("pipeline counts place active runs at their stage and keep the queue separate", () => {
  const counts = pipelineCounts(
    runs([
      ["queued", null],
      ["queued", null],
      ["waiting", null],
      ["running", "implement"],
      ["running", "implement"],
      ["waiting_input", "clarify"],
      ["running", null],
      ["succeeded", null],
      ["failed", "gates"],
      ["needs_human", "review"],
      ["cancelled", "spec"],
      ["resolved", null],
    ]),
  );
  expect(counts.queued).toBe(2);
  expect(counts.blocked).toBe(1);
  expect(counts.active).toEqual({ implement: 2, clarify: 1, prepare: 1 });
  expect(counts.asking).toEqual({ clarify: 1 });
});

const day = (date: string, costEquivUsd: number): DayStats => ({
  day: date,
  runs: 1,
  succeeded: 1,
  failed: 0,
  costUsd: 0,
  costEquivUsd,
});

test("cost days cover the whole window, keep reported values and any day outside it", () => {
  // Local noon on 5 November 2026; the window crosses the 1 November DST change in US zones.
  const now = new Date(2026, 10, 5, 12).getTime();
  const padded = padDays([day("2026-11-01", 0.72), day("2026-10-22", 0.1)], 14, now);
  expect(padded.map((d) => d.day)).toEqual([
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
  ]);
  expect(padded.find((d) => d.day === "2026-11-01")?.costEquivUsd).toBe(0.72);
  expect(padded.find((d) => d.day === "2026-10-22")?.costEquivUsd).toBe(0.1);
  expect(padded.find((d) => d.day === "2026-11-05")).toEqual({
    day: "2026-11-05",
    runs: 0,
    succeeded: 0,
    failed: 0,
    costUsd: 0,
    costEquivUsd: 0,
  });
});
