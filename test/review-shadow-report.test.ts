import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
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
  setSystemTime();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Store timestamps (run and artifact creation) follow this clock: hour `h` of 2026-09-01. */
const hour = (h: number) => `2026-09-01T${String(h).padStart(2, "0")}:00:00.000Z`;
const at = (h: number) => setSystemTime(new Date(hour(h)));
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
const review = (blocking: unknown[], reviewedSha = "head", findings = blocking) => ({
  verdict: blocking.length ? "request_changes" : "approve",
  reviewedSha,
  findings,
  blocking,
});
const shadow = (blocking: unknown[], extra: Record<string, unknown> = {}) => ({
  round: 0,
  status: "completed",
  reviewedSha: "head",
  blocking,
  ...extra,
});
const PR = "https://github.com/owner/a/pull/7";
const FOLLOW_PR = "https://github.com/owner/a/pull/9";
const basis = "names the file and title";
const fix = (sha: string, h: number, text: string): HistoryRecord => ({
  kind: "fix",
  source: `commit ${sha}`,
  at: hour(h),
  text,
});

function fixture() {
  at(0);
  const a = repoOf("owner/a");
  const b = repoOf("owner/b");
  const create = (repo: Repo, extra: Record<string, unknown> = {}) =>
    store.createRun(repo, { repo: repo.slug, prompt: "work", ...extra });
  const main = create(a);
  store.updateRun(main.id, { status: "succeeded", prUrl: PR });
  at(2);
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
      finding("src/e.ts", "Stale"),
      finding("src/f.ts", "Skewed"),
      finding("src/g.ts", "Missing check"),
    ]),
  );
  at(3);
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
  // A dependent run delivers its own PR, which fixes one panel-only finding.
  const dependent = create(a, { dependsOn: [main.id] });
  store.updateRun(dependent.id, { status: "succeeded", prUrl: FOLLOW_PR });
  // Same finding text in an unrelated run of the repo and on PR 7 of another repo: never evidence.
  const unrelated = create(a);
  store.updateRun(unrelated.id, { prUrl: "https://github.com/owner/a/pull/8" });
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
        // Committed before the shadow review: it cannot fix what the panel found later.
        fix("early", 1, "Fix src/e.ts: Stale"),
        // Precedes the reviewed commit in the PR, whatever its (rebased) commit time says.
        fix("skew", 5, "Fix src/f.ts: Skewed"),
        fix("head", 2, "Add work"),
        fix("abc123", 4, "Fix src/a.ts: Null deref\n"),
        // Touches a panel-only finding's file without naming the finding.
        fix("def456", 4, "Tidy src/c.ts formatting\n"),
        { kind: "review", source: `${PR}#review-1`, at: hour(4), text: "Looks fine overall" },
      ],
    ],
    // Stacked on the reviewed commit: only commits after it in PR order can be fixes.
    [dependent.id, [fix("head", 2, "Add work"), fix("f00d", 5, "Fix src/g.ts: Missing check")]],
    [unrelated.id, [fix("bad", 5, "Fix src/d.ts: Overflow")]],
  ]);
  return { a, create, main, followUp, dependent, history };
}

const reader = (history: Map<string, HistoryRecord[] | null>) => async (run: Run) =>
  history.has(run.id) ? (history.get(run.id) ?? null) : [];

test("panel-only findings match later fixes and review findings from related history only", async () => {
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
  expect(r0.panel).toHaveLength(8);
  const converged = (finding: string) => ({
    finding,
    outcome: "converged-without-fix" as const,
    evidence: [],
  });
  expect(r0.panelOnly).toEqual([
    {
      finding: "src/a.ts: Null deref",
      outcome: "fixed",
      evidence: [{ kind: "fix", source: "commit abc123", at: hour(4), basis }],
    },
    {
      // A matching review finding is not a fix.
      finding: "src/b.ts: Race",
      outcome: "review-matched",
      evidence: [{ kind: "review", source: `run ${followUp.id}/review-0.json`, at: hour(3), basis }],
    },
    // A same-file edit is no evidence: the run converged without a matching fix.
    converged("src/c.ts: Leak"),
    // Matching text in an unrelated run or another repository's PR 7 is ignored.
    converged("src/d.ts: Overflow"),
    // Commits before the shadow review, in time or in PR order, are not later fixes.
    converged("src/e.ts: Stale"),
    converged("src/f.ts: Skewed"),
    {
      // Fixed in the PR of a run that depends on this one.
      finding: "src/g.ts: Missing check",
      outcome: "fixed",
      evidence: [{ kind: "fix", source: "commit f00d", at: hour(5), basis }],
    },
  ]);
  expect(r1).toMatchObject({ reason: "alpha quota headroom is at or below 0.1", panelOnly: [] });
});

test("a rewritten history without the reviewed commit yields no fix and marks the evidence incomplete", async () => {
  const { main, followUp, history } = fixture();
  // Rebased after the review: every commit has a new id and a later committer time, the fix text unchanged.
  history.set(main.id, [
    fix("early2", 6, "Fix src/e.ts: Stale"),
    fix("head2", 6, "Add work"),
    fix("abc456", 6, "Fix src/a.ts: Null deref\n"),
    // PR reviews and comments keep their times: still later evidence, but never a fix.
    { kind: "review", source: `${PR}#review-2`, at: hour(6), text: "src/c.ts: Leak is still here" },
  ]);
  const [r0] = (await shadowReport(store, reader(history))).filter((r) => r.runId === main.id);
  expect(r0?.history).toBe(false);
  expect(r0?.panelOnly.map((p) => [p.finding, p.outcome, p.evidence.map((e) => e.source)])).toEqual([
    ["src/a.ts: Null deref", "unknown", []],
    ["src/b.ts: Race", "review-matched", [`run ${followUp.id}/review-0.json`]],
    ["src/c.ts: Leak", "review-matched", [`${PR}#review-2`]],
    ["src/d.ts: Overflow", "unknown", []],
    ["src/e.ts: Stale", "unknown", []],
    ["src/f.ts: Skewed", "unknown", []],
    // The dependent PR still holds the reviewed commit, so its later fix stands.
    ["src/g.ts: Missing check", "fixed", ["commit f00d"]],
  ]);
  expect(formatShadowReport([r0 as ShadowRow])).toContain("round 0: completed; evidence incomplete");
});

test("replaying the paired or an earlier review never becomes later evidence", async () => {
  const { main, followUp, history } = fixture();
  // Resume rewrites review-0.json and review-1.json later, with findings the panel raised at round 0.
  at(6);
  put(
    main,
    "review-0.json",
    review([finding("src/a.ts", "Shared bug")], "head", [finding("src/c.ts", "Leak")]),
  );
  put(main, "review-1.json", review([], "head-1", [finding("src/d.ts", "Overflow")]));
  // A genuinely later round naming a round-0 panel finding does count.
  put(main, "review-2.json", review([], "head-2", [finding("src/e.ts", "Stale")]));
  const rows = (await shadowReport(store, reader(history))).filter((r) => r.runId === main.id);
  const outcomes = (round: string) =>
    rows
      .find((r) => r.round === round)
      ?.panelOnly.map((p) => [p.finding, p.outcome, p.evidence.map((e) => e.source)]);
  expect(outcomes("0")).toEqual([
    ["src/a.ts: Null deref", "fixed", ["commit abc123"]],
    ["src/b.ts: Race", "review-matched", [`run ${followUp.id}/review-0.json`]],
    // The paired review's replay names it, yet it is the same round: no later evidence.
    ["src/c.ts: Leak", "converged-without-fix", []],
    ["src/d.ts: Overflow", "review-matched", [`run ${main.id}/review-1.json`]],
    ["src/e.ts: Stale", "review-matched", [`run ${main.id}/review-2.json`]],
    ["src/f.ts: Skewed", "converged-without-fix", []],
    ["src/g.ts: Missing check", "fixed", ["commit f00d"]],
  ]);
});

test("unavailable follow-up history leaves unmatched findings unknown", async () => {
  const { main, dependent, history } = fixture();
  history.set(dependent.id, null);
  const [r0] = (await shadowReport(store, reader(history))).filter((r) => r.runId === main.id);
  expect(r0?.history).toBe(false);
  expect(r0?.panelOnly.map((p) => [p.finding, p.outcome])).toEqual([
    ["src/a.ts: Null deref", "fixed"],
    ["src/b.ts: Race", "review-matched"],
    ["src/c.ts: Leak", "unknown"],
    ["src/d.ts: Overflow", "unknown"],
    ["src/e.ts: Stale", "unknown"],
    ["src/f.ts: Skewed", "unknown"],
    ["src/g.ts: Missing check", "unknown"],
  ]);
});

test("unfinished runs and unavailable history stay unknown; broken artifacts keep valid rows", async () => {
  const { a, create, history } = fixture();
  const unfinished = create(a);
  store.updateRun(unfinished.id, { status: "needs_human", prUrl: "https://github.com/owner/a/pull/10" });
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
  put(broken, "review-4.json", review([null]));
  put(broken, "review-4.shadow.json", shadow([null]));
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
  const single = "single review artifact missing or malformed";
  expect(of(broken).map((r) => [r.round, r.status, r.reason ?? null, r.history])).toEqual([
    ["0", "malformed", null, false],
    ["1", "completed", single, false],
    ["2", "malformed", null, false],
    ["3", "error", "member exploded", false],
    ["4", "malformed", single, false],
  ]);
  // Its own malformed reviews leave the evidence incomplete.
  expect(of(broken)[1]?.panelOnly).toEqual([
    { finding: "src/g.ts: Bad shape", outcome: "unknown", evidence: [] },
  ]);
  expect(of(verification).map((r) => [r.round, r.status, r.panelOnly.length])).toEqual([
    ["-1", "completed", 1],
  ]);
  const text = formatShadowReport(rows);
  expect(text).toContain(`${noHistory.id} owner/a round 0: completed; evidence incomplete`);
  expect(text).toContain(`${broken.id} owner/a round 0: malformed`);
  expect(text).toContain("  panel-only src/e.ts: Stale cache: unknown");
  expect(text).toContain(`round 3: error (member exploded); evidence incomplete`);
});

test("reporting reads only: no store writes, invocations or model calls", async () => {
  const { main, dependent, history } = fixture();
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
  // Only the run's PR and its dependent's PR: runs without a PR of their own have no history to read.
  expect(reads.sort()).toEqual([main.id, dependent.id].sort());
  expect(JSON.stringify(store.getRunDetail(main.id))).toBe(before);
});
