import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo, Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import {
  formatShadowReport,
  type HistoryRecord,
  type ShadowRow,
  shadowReport,
} from "../src/pipeline/shadow-report.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-shadow-report-"));
  store = new Store(join(dir, "store.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const repoOf = (slug: string): Repo =>
  store.upsertRepo({
    slug,
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
const finding = (file: string, title: string) => ({ file, title, severity: "major", line: 1 });
const put = (run: Run, name: string, value: unknown) =>
  store.putArtifact(run.id, name, "review", typeof value === "string" ? value : JSON.stringify(value));
const review = (blocking: ReturnType<typeof finding>[], reviewedSha = "head", findings = blocking) => ({
  verdict: blocking.length ? "request_changes" : "approve",
  reviewedSha,
  findings,
  blocking,
});
const shadow = (blocking: unknown[], extra: Record<string, unknown> = {}) => ({
  round: 0,
  status: "completed",
  blocking,
  ...extra,
});
const PR = "https://github.com/owner/a/pull/7";
const at = "2026-09-01T00:00:00Z";
const basis = "names the file and title";

function fixture() {
  const a = repoOf("owner/a");
  const b = repoOf("owner/b");
  const create = (repo: Repo, extra: Record<string, unknown> = {}) =>
    store.createRun(repo, { repo: repo.slug, prompt: "work", ...extra });
  const main = create(a);
  store.updateRun(main.id, { status: "succeeded", prUrl: PR });
  put(main, "review-0.json", review([finding("src/a.ts", "Shared bug")]));
  put(
    main,
    "review-0.shadow.json",
    shadow([
      finding("src/a.ts", "Shared bug"),
      finding("src/a.ts", "Null deref"),
      finding("src/b.ts", "Race"),
      finding("src/c.ts", "Leak"),
      finding("src/d.ts", "Overflow"),
    ]),
  );
  put(main, "review-1.json", review([], "head-1"));
  put(main, "review-1.shadow.json", {
    round: 1,
    status: "skipped",
    reason: "alpha quota headroom is at or below 0.1",
  });
  put(main, "review-2.json", review([], "head-2"));
  // A follow-up run on the same PR raises one panel-only finding; it fixes nothing by itself.
  const followUp = create(a, { sourceRef: { kind: "pull_request", repo: "owner/a", number: 7 } });
  put(followUp, "review-0.json", review([], "follow-sha", [finding("src/b.ts", "Race")]));
  // Same finding text in an unrelated run of the repo and on PR 7 of another repo: never evidence.
  const unrelated = create(a);
  put(unrelated, "review-0.json", review([finding("src/d.ts", "Overflow")]));
  const otherRepo = create(b, { sourceRef: { kind: "pull_request", repo: "owner/b", number: 7 } });
  put(otherRepo, "review-0.json", review([finding("src/d.ts", "Overflow")]));
  // Legacy run: no shadow artifacts at all.
  const legacy = create(a);
  put(legacy, "review-0.json", review([]));
  const history = new Map<string, HistoryRecord[] | null>([
    [
      main.id,
      [
        { kind: "fix", source: "commit abc123", at, text: "Fix src/a.ts: Null deref\n" },
        // Touches a panel-only finding's file without naming the finding.
        { kind: "fix", source: "commit def456", at, text: "Tidy src/c.ts formatting\n" },
        { kind: "review", source: `${PR}#review-1`, at, text: "Looks fine overall" },
      ],
    ],
  ]);
  return { a, b, create, main, followUp, history };
}

const reader = (history: Map<string, HistoryRecord[] | null>) => async (run: Run) =>
  history.has(run.id) ? (history.get(run.id) ?? null) : [];

test("panel-only findings match fixes and review findings from related history only", async () => {
  const { main, followUp, history } = fixture();
  const rows = (await shadowReport(store, reader(history))).filter((r) => r.runId === main.id);
  expect(rows.map((r) => [r.round, r.status])).toEqual([
    ["0", "completed"],
    ["1", "skipped"],
    ["2", "missing"],
  ]);
  const [r0, r1] = rows as [ShadowRow, ShadowRow];
  expect(r0).toMatchObject({
    repo: "owner/a",
    pr: PR,
    history: true,
    single: ["src/a.ts: Shared bug"],
    shared: ["src/a.ts: Shared bug"],
  });
  expect(r0.panel).toHaveLength(5);
  expect(r0.panelOnly).toEqual([
    {
      finding: "src/a.ts: Null deref",
      outcome: "fixed",
      evidence: [{ kind: "fix", source: "commit abc123", at, basis }],
    },
    {
      // A matching review finding is not a fix.
      finding: "src/b.ts: Race",
      outcome: "review-matched",
      evidence: [{ kind: "review", source: `run ${followUp.id}/review-0.json`, at: "follow-sha", basis }],
    },
    // A same-file edit is no evidence: the run converged without a matching fix.
    { finding: "src/c.ts: Leak", outcome: "converged-without-fix", evidence: [] },
    // Matching text in an unrelated run or another repository's PR 7 is ignored.
    { finding: "src/d.ts: Overflow", outcome: "converged-without-fix", evidence: [] },
  ]);
  expect(r1).toMatchObject({ reason: "alpha quota headroom is at or below 0.1", panelOnly: [] });
});

test("unfinished runs and unavailable history stay unknown; broken artifacts keep valid rows", async () => {
  const { a, create, history } = fixture();
  const unfinished = create(a);
  store.updateRun(unfinished.id, { status: "needs_human", prUrl: "https://github.com/owner/a/pull/8" });
  put(unfinished, "review-0.json", review([]));
  put(unfinished, "review-0.shadow.json", shadow([finding("src/e.ts", "Stale cache")]));
  const noHistory = create(a);
  store.updateRun(noHistory.id, { status: "succeeded" });
  history.set(noHistory.id, null);
  put(noHistory, "review-0.json", review([]));
  put(noHistory, "review-0.shadow.json", shadow([finding("src/f.ts", "Lost write")]));
  const broken = create(a);
  store.updateRun(broken.id, { status: "succeeded" });
  put(broken, "review-0.json", review([]));
  put(broken, "review-0.shadow.json", "{not json");
  put(broken, "review-1.json", "{also not json");
  put(broken, "review-1.shadow.json", shadow([finding("src/g.ts", "Bad shape")]));
  put(broken, "review-2.json", review([]));
  put(broken, "review-2.shadow.json", shadow([{ title: "no file" }]));
  put(broken, "review-3.json", review([]));
  put(broken, "review-3.shadow.json", shadow([], { status: "error", reason: "member exploded" }));
  // PR verification reviews before its first round, at round -1.
  const verification = create(a);
  store.updateRun(verification.id, { status: "succeeded" });
  put(verification, "review--1.json", review([]));
  put(verification, "review--1.shadow.json", shadow([finding("src/h.ts", "Off by one")]));
  const rows = await shadowReport(store, reader(history));
  const of = (run: Run) => rows.filter((r) => r.runId === run.id);
  expect(of(unfinished)[0]?.panelOnly).toEqual([
    { finding: "src/e.ts: Stale cache", outcome: "unknown", evidence: [] },
  ]);
  expect(of(noHistory)[0]).toMatchObject({
    history: false,
    panelOnly: [{ finding: "src/f.ts: Lost write", outcome: "unknown", evidence: [] }],
  });
  expect(of(broken).map((r) => [r.round, r.status, r.reason ?? null])).toEqual([
    ["0", "malformed", null],
    ["1", "completed", "single review artifact missing or malformed"],
    ["2", "malformed", null],
    ["3", "error", "member exploded"],
  ]);
  expect(of(broken)[1]?.panelOnly).toEqual([
    { finding: "src/g.ts: Bad shape", outcome: "converged-without-fix", evidence: [] },
  ]);
  expect(of(verification).map((r) => [r.round, r.status, r.panelOnly.length])).toEqual([
    ["-1", "completed", 1],
  ]);
  const text = formatShadowReport(rows);
  expect(text).toContain(`${noHistory.id} owner/a round 0: completed; PR history unavailable`);
  expect(text).toContain(`${broken.id} owner/a round 0: malformed`);
  expect(text).toContain("  panel-only src/e.ts: Stale cache: unknown");
  expect(text).toContain(`round 3: error (member exploded)`);
});

test("reporting reads only: no store writes, invocations or model calls", async () => {
  const { main, history } = fixture();
  const reads: string[] = [];
  const forbidden = [
    "putArtifact",
    "updateRun",
    "setRunState",
    "addEvent",
    "createInvocation",
    "updateInvocation",
    "startStage",
    "finishStage",
    "upsertRepo",
    "createRun",
  ] as const;
  for (const name of forbidden)
    Object.assign(store, {
      [name]: () => {
        throw new Error(`report wrote ${name}`);
      },
    });
  const before = JSON.stringify(store.getRunDetail(main.id));
  const rows = await shadowReport(store, async (run) => {
    reads.push(run.id);
    return history.get(run.id) ?? [];
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(reads).toEqual([main.id]);
  expect(JSON.stringify(store.getRunDetail(main.id))).toBe(before);
});
