import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo, Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import {
  changedLines,
  formatShadowReport,
  ghPrHistory,
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
const finding = (file: string, line: number, title: string) => ({ file, line, title, severity: "major" });
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
const fixBasis = "changes lines within 5 of it";
const reviewBasis = "reports the same file within 5 lines";
/** A PR commit at hour `h`: each entry is a file and the patch the commit applies to it. */
const commit = (sha: string, h: number, patches: [string, string][] = []): HistoryRecord => ({
  kind: "commit",
  source: `commit ${sha}`,
  at: hour(h),
  spots: patches.flatMap(([file, patch]) => changedLines(patch).map((line) => ({ file, line }))),
});
const comment = (id: number, h: number, author: string | null, file: string, line: number | null) => ({
  kind: "review" as const,
  source: `${PR}#discussion_r${id}`,
  at: hour(h),
  author,
  spots: [{ file, line }],
});
/** Removes old line `n` (a deletion counts at its old line number). */
const del = (n: number) => `@@ -${n},1 +${n},0 @@\n-gone`;
/** Adds a line that becomes new line `n`. */
const add = (n: number) => `@@ -${n - 1},0 +${n},1 @@\n+added`;
/** Eight unchanged context lines from `n`, then one changed line at `n + 8`. */
const contextOnly = (n: number) =>
  `@@ -${n},9 +${n},9 @@\n${Array.from({ length: 8 }, () => " same").join("\n")}\n-old\n+new`;

const PANEL = [
  // Same file as the single finding within 5 lines, under another title: shared.
  finding("src/a.ts", 15, "Different words"),
  // The single finding's title, 6 lines away: panel-only.
  finding("src/a.ts", 16, "Shared bug"),
  // The single finding's title and line in another file: panel-only.
  finding("./src/b.ts", 10, "Shared bug"),
  finding("src/c.ts", 20, "Deleted nearby"),
  finding("src/d.ts", 20, "Context only"),
  finding("src/e.ts", 30, "Changed before review"),
  finding("src/g.ts", 50, "Fixed in follow-up"),
  finding("src/h.ts", 0, "No location"),
  finding("src/i.ts", 10, "Owner commented"),
  finding("src/j.ts", 10, "Untrusted comment"),
  finding("src/k.ts", 10, "Trusted reviewer"),
  finding("src/m.ts", 10, "Later round"),
  finding("src/n.ts", 10, "Other run only"),
];

function fixture(relation: "dependency" | "PR reference" = "dependency") {
  at(0);
  const a = repoOf("owner/a");
  const b = repoOf("owner/b");
  const create = (repo: Repo, extra: Record<string, unknown> = {}) =>
    store.createRun(repo, { repo: repo.slug, prompt: "work", ...extra });
  const main = create(a);
  store.updateRun(main.id, { status: "succeeded", prUrl: PR });
  at(2);
  put(main, "review-0.json", review([finding("src/a.ts", 10, "Shared bug")]));
  put(main, "review-0.shadow.json", shadow(PANEL));
  at(3);
  // A later round of the same run reports m.ts 4 lines away, under its own title.
  put(main, "review-1.json", review([], "head-1", [finding("src/m.ts", 14, "Unrelated wording")]));
  put(main, "review-1.shadow.json", {
    round: 1,
    status: "skipped",
    reason: "beta quota headroom is unknown",
  });
  put(main, "review-2.json", review([], "head-2"));
  // A dependent run delivers its own PR.
  const dependent = create(
    a,
    relation === "dependency"
      ? { dependsOn: [main.id] }
      : { sourceRef: { kind: "pull_request", repo: "owner/a", number: 7 } },
  );
  store.updateRun(dependent.id, { status: "succeeded", prUrl: FOLLOW_PR });
  // The same location in an unrelated run of the repo and in another repository's PR 7: never evidence.
  const unrelated = create(a);
  store.updateRun(unrelated.id, { prUrl: "https://github.com/owner/a/pull/8" });
  put(unrelated, "review-0.json", review([finding("src/n.ts", 10, "Other run only")]));
  const otherRepo = create(b, { sourceRef: { kind: "pull_request", repo: "owner/b", number: 7 } });
  put(otherRepo, "review-0.json", review([finding("src/n.ts", 10, "Other run only")]));
  // Legacy run: no shadow artifacts at all.
  const legacy = create(a);
  put(legacy, "review-0.json", review([]));
  const history = new Map<string, HistoryRecord[] | null>([
    [
      main.id,
      [
        // Precedes the reviewed commit in the PR: not a later change, whatever its time says.
        commit("early", 5, [["src/e.ts", del(30)]]),
        commit("head", 2, [["src/a.ts", add(1)]]),
        // Factory round commits name no finding; their changed lines are the evidence.
        commit("round-1", 4, [
          ["src/c.ts", del(25)],
          ["src/d.ts", contextOnly(18)],
          ["src/h.ts", add(1)],
        ]),
        comment(1, 4, "OWNER", "src/i.ts", 12),
        comment(2, 4, "mallory", "src/j.ts", 10),
        comment(3, 4, "alice", "src/k.ts", 15),
        // The owner, but no usable location: never a match.
        comment(4, 4, "owner", "src/j.ts", null),
        comment(5, 4, null, "src/k.ts", 10),
      ],
    ],
    // Stacked on the reviewed commit: only commits after it in PR order count.
    [dependent.id, [commit("head", 2), commit("f00d", 5, [["src/g.ts", add(54)]])]],
    [unrelated.id, [commit("bad", 5, [["src/n.ts", del(10)]])]],
  ]);
  return { a, create, main, dependent, unrelated, history };
}

/** One page of `gh api --paginate` commit output: its parent count and files, as one JSON line. */
const page = (files: { filename: string; patch?: string | null }[], parents = 1) =>
  `${JSON.stringify({ parents, files })}\n`;

const reader = (history: Map<string, HistoryRecord[] | null>) => async (run: Run) =>
  history.has(run.id) ? (history.get(run.id) ?? null) : [];
const outcomes = (row: ShadowRow | undefined) =>
  Object.fromEntries(
    (row?.panelOnly ?? []).map((p) => [p.finding, [p.outcome, p.evidence.map((e) => e.source)]]),
  );

test("panel findings are shared, fixed or review-matched by file and line within 5, never by title", async () => {
  const { main, history } = fixture();
  const { rows } = await shadowReport(store, reader(history), { trusted: ["alice"] });
  const own = rows.filter((r) => r.runId === main.id);
  expect(own.map((r) => [r.round, r.status])).toEqual([
    ["0", "completed"],
    ["1", "skipped"],
    ["2", "missing"],
  ]);
  const [r0, r1] = own;
  expect(r0).toMatchObject({
    history: true,
    single: ["src/a.ts:10: Shared bug"],
    shared: ["src/a.ts:15: Different words"],
  });
  expect(r0?.panel).toHaveLength(PANEL.length);
  expect(outcomes(r0)).toEqual({
    "src/a.ts:16: Shared bug": ["converged-without-fix", []],
    "./src/b.ts:10: Shared bug": ["converged-without-fix", []],
    // A deletion 5 lines away, in a plain factory round commit.
    "src/c.ts:20: Deleted nearby": ["fixed", ["commit round-1"]],
    // Unchanged hunk context covers line 20; the changed line (26) is 6 away.
    "src/d.ts:20: Context only": ["converged-without-fix", []],
    "src/e.ts:30: Changed before review": ["converged-without-fix", []],
    "src/g.ts:50: Fixed in follow-up": ["fixed", ["commit f00d"]],
    "src/h.ts:0: No location": ["converged-without-fix", []],
    "src/i.ts:10: Owner commented": ["review-matched", [`${PR}#discussion_r1`]],
    // An untrusted author, or one without a login, is no evidence at any location.
    "src/j.ts:10: Untrusted comment": ["converged-without-fix", []],
    "src/k.ts:10: Trusted reviewer": ["review-matched", [`${PR}#discussion_r3`]],
    "src/m.ts:10: Later round": ["review-matched", [`run ${main.id}/review-1.json`]],
    "src/n.ts:10: Other run only": ["converged-without-fix", []],
  });
  const fixed = r0?.panelOnly.find((p) => p.finding.startsWith("src/c.ts"));
  expect(fixed?.evidence).toEqual([
    { kind: "commit", source: "commit round-1", at: hour(4), basis: fixBasis },
  ]);
  const matched = r0?.panelOnly.find((p) => p.finding.startsWith("src/m.ts"));
  expect(matched?.evidence).toEqual([
    { kind: "review", source: `run ${main.id}/review-1.json`, at: hour(3), basis: reviewBasis },
  ]);
  expect(r1).toMatchObject({ reason: "beta quota headroom is unknown", panelOnly: [] });
  // Without configuration, only the repository owner is trusted.
  const ownerOnly = (await shadowReport(store, reader(history))).rows.find((r) => r.runId === main.id);
  expect(outcomes(ownerOnly)["src/k.ts:10: Trusted reviewer"]).toEqual(["converged-without-fix", []]);
  expect(outcomes(ownerOnly)["src/i.ts:10: Owner commented"]?.[0]).toBe("review-matched");
});

test.each([
  [5, "shared", "fixed"],
  [-5, "shared", "fixed"],
  [6, "panel-only", "converged-without-fix"],
  [-6, "panel-only", "converged-without-fix"],
] as const)("offset %d: %s with the single review; a change there is %s", async (offset, kind, outcome) => {
  at(0);
  const run = store.createRun(repoOf("owner/a"), { repo: "owner/a", prompt: "work" });
  store.updateRun(run.id, { status: "succeeded", prUrl: PR });
  at(2);
  put(run, "review-0.json", review([finding("src/x.ts", 40 + offset, "One title")]));
  put(run, "review-0.shadow.json", shadow([finding("src/x.ts", 40, "Another title")]));
  const history = [commit("head", 2), commit("later", 3, [["src/x.ts", add(40 + offset)]])];
  const { rows } = await shadowReport(store, async () => history);
  expect(rows[0]?.shared).toEqual(kind === "shared" ? ["src/x.ts:40: Another title"] : []);
  if (kind === "panel-only") expect(rows[0]?.panelOnly.map((p) => p.outcome)).toEqual([outcome]);
  // The same change in another file is never evidence.
  const elsewhere = [commit("head", 2), commit("later", 3, [["src/y.ts", add(40)]])];
  put(run, "review-0.json", review([]));
  expect((await shadowReport(store, async () => elsewhere)).rows[0]?.panelOnly[0]?.outcome).toBe(
    "converged-without-fix",
  );
});

test("a later commit whose patch GitHub omitted for the finding's file leaves it unknown, history incomplete", async () => {
  at(0);
  const run = store.createRun(repoOf("owner/a"), { repo: "owner/a", prompt: "work" });
  store.updateRun(run.id, { status: "succeeded", prUrl: PR });
  at(2);
  put(run, "review-0.json", review([]));
  put(
    run,
    "review-0.shadow.json",
    shadow([finding("src/a.ts", 40, "Big file"), finding("src/z.ts", 9, "Other")]),
  );
  const gh: GhRunner = async (args) => {
    if (args[0] === "pr")
      return JSON.stringify([
        { oid: "head", at: hour(2) },
        { oid: "later", at: hour(3) },
      ]);
    if (args.some((arg) => arg.includes("/pulls/"))) return "";
    return page(args[1]?.endsWith("/later") ? [{ filename: "src/a.ts", patch: null }] : []);
  };
  const [row] = (await shadowReport(store, ghPrHistory(gh))).rows;
  expect(row?.history).toBe(false);
  expect(outcomes(row)).toEqual({
    "src/a.ts:40: Big file": ["unknown", []],
    "src/z.ts:9: Other": ["converged-without-fix", []],
  });
  expect(formatShadowReport({ rows: row ? [row] : [], limit: 200, capped: false })).toContain(
    "evidence incomplete",
  );
});

test("changed lines count additions and deletions, never unchanged context", () => {
  const patch = [
    "@@ -10,6 +10,7 @@ function f() {",
    " a",
    "-b",
    "+B",
    "+C",
    " d",
    " e",
    "-f",
    "\\ No newline at end of file",
    "@@ -40,2 +41,2 @@",
    " same",
    "+tail",
  ].join("\n");
  // Deletions at old lines 11 and 14; additions at new lines 11, 12 and 42.
  expect(changedLines(patch).sort((x, y) => x - y)).toEqual([11, 11, 12, 14, 42]);
  expect(changedLines("")).toEqual([]);
});

test("a rewritten history without the reviewed commit yields no fix and marks the evidence incomplete", async () => {
  const { main, history } = fixture();
  history.set(main.id, [
    commit("head2", 6, [["src/a.ts", add(1)]]),
    commit("rebased", 6, [["src/c.ts", del(25)]]),
    comment(9, 6, "owner", "src/i.ts", 10),
  ]);
  const { rows } = await shadowReport(store, reader(history));
  const r0 = rows.find((r) => r.runId === main.id);
  expect(r0?.history).toBe(false);
  expect(outcomes(r0)["src/c.ts:20: Deleted nearby"]).toEqual(["unknown", []]);
  // Trusted comments keep their times: still later evidence, but never a fix.
  expect(outcomes(r0)["src/i.ts:10: Owner commented"]).toEqual(["review-matched", [`${PR}#discussion_r9`]]);
  // The dependent PR still holds the reviewed commit, so its later fix stands.
  expect(outcomes(r0)["src/g.ts:50: Fixed in follow-up"]).toEqual(["fixed", ["commit f00d"]]);
  expect(formatShadowReport({ rows: [r0 as ShadowRow], limit: 200, capped: false })).toContain(
    "round 0: completed; evidence incomplete",
  );
});

for (const relation of ["dependency", "PR reference"] as const) {
  test(`a non-stacked follow-up linked by ${relation} supplies later changes without the original SHA`, async () => {
    const { main, dependent: follow, history } = fixture(relation);
    history.set(follow.id, [
      commit("old", 1, [["src/e.ts", del(30)]]),
      commit("same-time", 2, [["src/d.ts", del(20)]]),
      commit("follow-fix", 5, [["src/g.ts", del(45)]]),
    ]);
    const row = (await shadowReport(store, reader(history))).rows.find((r) => r.runId === main.id);
    expect(row?.history).toBe(true);
    expect(outcomes(row)["src/g.ts:50: Fixed in follow-up"]).toEqual(["fixed", ["commit follow-fix"]]);
    // Changes no later than the shadow review are not later fixes.
    expect(outcomes(row)["src/e.ts:30: Changed before review"]).toEqual(["converged-without-fix", []]);
    expect(outcomes(row)["src/d.ts:20: Context only"]).toEqual(["converged-without-fix", []]);
    // A later commit time alone cannot establish a follow-up when its run predates the review.
    store.db.run("UPDATE runs SET created_at = ? WHERE id = ?", [Date.parse(hour(1)), follow.id]);
    const earlier = (await shadowReport(store, reader(history))).rows.find((r) => r.runId === main.id);
    expect(earlier?.history).toBe(false);
    expect(outcomes(earlier)["src/g.ts:50: Fixed in follow-up"]).toEqual(["unknown", []]);
  });
}

test("a later-round commit stamped the same second as the shadow artifact is still a fix", async () => {
  at(0);
  const run = store.createRun(repoOf("owner/a"), { repo: "owner/a", prompt: "work" });
  store.updateRun(run.id, { status: "succeeded", prUrl: PR });
  // The artifact lands mid-second; Git records the round-1 commit at that second's start.
  setSystemTime(new Date(Date.parse(hour(2)) + 500));
  put(run, "review-0.json", review([]));
  put(run, "review-0.shadow.json", shadow([finding("src/x.ts", 40, "Same-second fix")]));
  const history = [commit("head", 1), commit("round-1", 2, [["src/x.ts", add(42)]])];
  const { rows } = await shadowReport(store, async () => history);
  expect(outcomes(rows[0])).toEqual({ "src/x.ts:40: Same-second fix": ["fixed", ["commit round-1"]] });
  // Without the reviewed commit, PR order says nothing: the same-second time alone is not later.
  const unordered = [commit("round-1", 2, [["src/x.ts", add(42)]])];
  const [row] = (await shadowReport(store, async () => unordered)).rows;
  expect(row?.history).toBe(false);
  expect(outcomes(row)["src/x.ts:40: Same-second fix"]?.[0]).toBe("unknown");
});

test("replaying the paired or an earlier review never becomes later evidence", async () => {
  const { main, history } = fixture();
  // Resume rewrites review-0.json later, with a finding at a round-0 panel location.
  at(6);
  put(
    main,
    "review-0.json",
    review([finding("src/a.ts", 10, "Shared bug")], "head", [finding("src/n.ts", 10, "x")]),
  );
  const r0 = (await shadowReport(store, reader(history))).rows.find(
    (r) => r.runId === main.id && r.round === "0",
  );
  expect(outcomes(r0)["src/n.ts:10: Other run only"]).toEqual(["converged-without-fix", []]);
  expect(outcomes(r0)["src/m.ts:10: Later round"]?.[0]).toBe("review-matched");
});

test.each([false, true])(
  "unavailable follow-up history leaves unmatched findings unknown (throws=%s)",
  async (throws) => {
    const { main, dependent, history } = fixture();
    history.set(dependent.id, null);
    const { rows } = await shadowReport(store, async (run) => {
      if (throws && run.id === dependent.id) throw new Error("history unavailable");
      return reader(history)(run);
    });
    const r0 = rows.find((r) => r.runId === main.id);
    expect(r0?.history).toBe(false);
    expect(outcomes(r0)["src/c.ts:20: Deleted nearby"]?.[0]).toBe("fixed");
    expect(outcomes(r0)["src/i.ts:10: Owner commented"]?.[0]).toBe("review-matched");
    expect(outcomes(r0)["src/g.ts:50: Fixed in follow-up"]?.[0]).toBe("unknown");
    expect(outcomes(r0)["src/d.ts:20: Context only"]?.[0]).toBe("unknown");
  },
);

test("unfinished runs and unavailable history stay unknown; broken artifacts keep valid rows", async () => {
  const { a, create, history } = fixture();
  const unfinished = create(a);
  store.updateRun(unfinished.id, { status: "needs_human", prUrl: "https://github.com/owner/a/pull/10" });
  put(unfinished, "review-0.json", review([]));
  put(unfinished, "review-0.shadow.json", shadow([finding("src/e.ts", 3, "Stale cache")]));
  const noHistory = create(a);
  store.updateRun(noHistory.id, { status: "succeeded" });
  history.set(noHistory.id, null);
  put(noHistory, "review-0.json", review([]));
  put(noHistory, "review-0.shadow.json", shadow([finding("src/f.ts", 3, "Lost write")]));
  const broken = create(a);
  store.updateRun(broken.id, { status: "succeeded" });
  put(broken, "review-0.json", review([]));
  put(broken, "review-0.shadow.json", "{not json");
  put(broken, "review-1.json", "{also not json");
  put(broken, "review-1.shadow.json", shadow([finding("src/g.ts", 3, "Bad shape")]));
  put(broken, "review-2.json", review([]));
  put(broken, "review-2.shadow.json", shadow([{ title: "no file" }]));
  put(broken, "review-3.json", review([]));
  put(
    broken,
    "review-3.shadow.json",
    shadow([], { status: "timeout", reason: "running 300s after the single review" }),
  );
  const verification = create(a);
  store.updateRun(verification.id, { status: "succeeded" });
  put(verification, "review--1.json", review([]));
  put(verification, "review--1.shadow.json", shadow([finding("src/h.ts", 3, "Off by one")]));
  const report = await shadowReport(store, reader(history));
  const of = (run: Run) => report.rows.filter((r) => r.runId === run.id);
  expect(of(unfinished)[0]?.panelOnly).toEqual([
    { finding: "src/e.ts:3: Stale cache", outcome: "unknown", evidence: [] },
  ]);
  expect(of(noHistory)[0]).toMatchObject({
    history: false,
    panelOnly: [{ finding: "src/f.ts:3: Lost write", outcome: "unknown", evidence: [] }],
  });
  const single = "single review artifact missing or malformed";
  expect(of(broken).map((r) => [r.round, r.status, r.reason ?? null, r.history])).toEqual([
    ["0", "malformed", null, false],
    ["1", "completed", single, false],
    ["2", "malformed", null, false],
    ["3", "timeout", "running 300s after the single review", false],
  ]);
  expect(of(verification).map((r) => [r.round, r.status, r.panelOnly.length])).toEqual([
    ["-1", "completed", 1],
  ]);
  const text = formatShadowReport(report);
  expect(text).toContain(`${noHistory.id} owner/a round 0: completed; evidence incomplete`);
  expect(text).toContain(`${broken.id} owner/a round 0: malformed`);
  expect(text).toContain("  panel-only src/e.ts:3: Stale cache: unknown");
  expect(text).toContain("round 3: timeout (running 300s after the single review); evidence incomplete");
  expect(text).not.toContain("Showing the newest");
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
  const { rows } = await shadowReport(store, async (run) => {
    reads.push(run.id);
    return history.get(run.id) ?? [];
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(reads.sort()).toEqual([main.id, dependent.id].sort());
  expect(JSON.stringify(store.getRunDetail(main.id))).toBe(before);
});

test("--since applies before history reads; the newest 200 runs are kept; each PR is read once", async () => {
  const repo = repoOf("owner/a");
  const runs: Run[] = [];
  // Run i is created at minute i; every run shares one dependent's PR, and pairs share their own PR.
  for (let i = 0; i < 230; i++) {
    setSystemTime(new Date(Date.parse(hour(0)) + i * 60_000));
    const run = store.createRun(repo, { repo: repo.slug, prompt: `run ${i}` });
    store.updateRun(run.id, {
      status: "succeeded",
      prUrl: `https://github.com/owner/a/pull/${1000 + Math.floor(i / 2)}`,
    });
    put(run, "review-0.json", review([]));
    put(run, "review-0.shadow.json", shadow([finding("src/x.ts", 3, "Panel only")]));
    runs.push(store.getRun(run.id) as Run);
  }
  setSystemTime(new Date(hour(9)));
  const shared = store.createRun(repo, {
    repo: repo.slug,
    prompt: "follow",
    dependsOn: runs.map((r) => r.id),
  });
  store.updateRun(shared.id, { prUrl: FOLLOW_PR });
  const calls = new Map<string, number>();
  const counting = async (run: Run) => {
    calls.set(run.prUrl ?? run.id, (calls.get(run.prUrl ?? run.id) ?? 0) + 1);
    // The shared PR's read fails: a failure is cached too.
    if (run.prUrl === FOLLOW_PR) throw new Error("rate limited");
    return [commit("head", 0)];
  };
  // Inclusive cutoff at run 20: runs 0-19 are excluded before any lookup.
  const cutoff = runs[20]?.createdAt ?? 0;
  const report = await shadowReport(store, counting, { since: cutoff });
  expect(report.rows.map((r) => r.runId)).toEqual(
    runs
      .slice(30)
      .reverse()
      .map((r) => r.id),
  );
  expect(report).toMatchObject({ limit: 200, capped: true });
  // Runs 20-29 fell to the cap; the first PR read belongs to runs 30-31.
  for (let pr = 1000; pr < 1015; pr++)
    expect(calls.get(`https://github.com/owner/a/pull/${pr}`)).toBeUndefined();
  expect(calls.get("https://github.com/owner/a/pull/1015")).toBe(1);
  expect(calls.get(FOLLOW_PR)).toBe(1);
  expect([...calls.values()].every((n) => n === 1)).toBe(true);
  expect(calls.size).toBe(101);
  expect(report.rows.every((r) => !r.history)).toBe(true);
  expect(formatShadowReport(report).split("\n")[0]).toBe(
    "Showing the newest 200 runs; older runs were left out.",
  );
  // Exactly 200 eligible runs: no cap.
  const exact = await shadowReport(store, async () => [], { since: runs[30]?.createdAt });
  expect([exact.rows.length, exact.capped]).toEqual([200, false]);
  expect((await shadowReport(store, async () => [], { since: runs[29]?.createdAt })).capped).toBe(true);
  expect(formatShadowReport(await shadowReport(store, async () => [], { since: Date.parse(hour(10)) }))).toBe(
    "No shadow review comparisons.",
  );
});

test("ghPrHistory reads commit patches and inline review comments with gh only; any failure makes it unavailable", async () => {
  const { main, create, a } = fixture();
  const calls: string[][] = [];
  const commits = [
    { oid: "abc123", at: hour(4) },
    { oid: "d0c5", at: hour(5) },
  ];
  const files: Record<string, { filename: string; patch?: string | null }[]> = {
    abc123: [
      { filename: "src/a.ts", patch: "@@ -10,3 +10,3 @@\n same\n-old\n+new\n same" },
      { filename: "img.png" },
    ],
    d0c5: [{ filename: "docs/NOTES.md", patch: "@@ -0,0 +1,1 @@\n+note" }],
  };
  const comments = [
    { author: "owner", file: "src/a.ts", line: 11, source: `${PR}#discussion_r1`, at: hour(6) },
    { author: "mallory", file: "src/a.ts", line: 11, source: `${PR}#discussion_r2`, at: hour(6) },
  ];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "pr") return JSON.stringify(commits);
    if (args.some((arg) => arg.includes("/pulls/"))) return comments.map((c) => JSON.stringify(c)).join("\n");
    const sha = args[1]?.split("/").pop() ?? "";
    if (!(sha in files)) throw new Error("gh: Not Found (HTTP 404)");
    return page(files[sha] ?? []);
  };
  const read = ghPrHistory(gh);
  const mainRun = store.getRun(main.id) as Run;
  const expected: HistoryRecord[] = [
    {
      kind: "commit",
      source: "commit abc123",
      at: hour(4),
      // GitHub omits some patches (binaries, large diffs): the file changed, its lines are unknown.
      spots: [
        { file: "src/a.ts", line: 11 },
        { file: "src/a.ts", line: 11 },
        { file: "img.png", line: null },
      ],
    },
    { kind: "commit", source: "commit d0c5", at: hour(5), spots: [{ file: "docs/NOTES.md", line: 1 }] },
    ...comments.map(({ file, line, ...c }) => ({ kind: "review" as const, ...c, spots: [{ file, line }] })),
  ];
  expect(await read(mainRun)).toEqual(expected);
  expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
    `pr view ${PR}`,
    "api repos/owner/a/commits/abc123 --paginate",
    "api repos/owner/a/commits/d0c5 --paginate",
    "api --paginate repos/owner/a/pulls/7/comments",
  ]);
  // The inline-comment query keeps author, path and line.
  expect(calls[3]?.at(-1)).toContain("author: .user.login, file: .path, line: (.line // .original_line)");
  expect(calls.every((c) => ["view", "repos/"].some((ro) => c.join(" ").includes(ro)))).toBe(true);
  // No PR: nothing to read. A failing read (here: the second commit vanished): unavailable, never partial.
  expect(await read(create(a))).toBeNull();
  delete files.d0c5;
  expect(await read(mainRun)).toBeNull();
  const r0 = (await shadowReport(store, read)).rows.find((r) => r.runId === main.id);
  expect(r0?.history).toBe(false);
  expect(new Set(r0?.panelOnly.map((p) => p.outcome))).toEqual(new Set(["unknown", "review-matched"]));
});

let prs = 100;
/** A succeeded run on its own PR whose shadow, reviewing `reviewedSha`, blocks on `panel`; `gh` serves commits. */
async function ghRow(
  reviewedSha: string,
  panel: ReturnType<typeof finding>[],
  commits: [sha: string, pages: string | Error][],
) {
  at(0);
  const run = store.createRun(repoOf("owner/a"), { repo: "owner/a", prompt: "work" });
  store.updateRun(run.id, { status: "succeeded", prUrl: `https://github.com/owner/a/pull/${prs++}` });
  at(2);
  put(run, "review-0.json", review([]));
  put(run, "review-0.shadow.json", shadow(panel, { reviewedSha }));
  const gh: GhRunner = async (args) => {
    if (args[0] === "pr") return JSON.stringify(commits.map(([oid]) => ({ oid, at: hour(1) })));
    if (args.some((arg) => arg.includes("/pulls/"))) return "";
    const pages = commits.find(([oid]) => args[1]?.endsWith(`/${oid}`))?.[1];
    if (pages === undefined || pages instanceof Error) throw pages ?? new Error("gh: Not Found (HTTP 404)");
    return pages;
  };
  return (await shadowReport(store, ghPrHistory(gh))).rows.find((r) => r.runId === run.id);
}
const files = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ filename: `gen/${from + i}.ts`, patch: add(1) }));

test("a merge commit's first-parent changes are never a fix; later commits still are, even after a merged reviewed commit", async () => {
  const panel = [finding("src/x.ts", 40, "Upstream only"), finding("src/y.ts", 10, "Fixed later")];
  // The factory's base merge brings upstream changes at the finding's lines; GitHub lists them as its files.
  const row = await ghRow("head", panel, [
    ["head", page([])],
    ["merge", page([{ filename: "src/x.ts", patch: add(41) }], 2)],
    ["fix", page([{ filename: "src/y.ts", patch: del(12) }])],
  ]);
  expect(row?.history).toBe(true);
  expect(outcomes(row)).toEqual({
    "src/x.ts:40: Upstream only": ["converged-without-fix", []],
    "src/y.ts:10: Fixed later": ["fixed", ["commit fix"]],
  });
  // The reviewed commit is itself a merge: it still anchors PR order, and its own files never count.
  const merged = await ghRow("merge-head", panel, [
    ["merge-head", page([{ filename: "src/y.ts", patch: add(10) }], 3)],
    ["fix", page([{ filename: "src/x.ts", patch: add(40) }])],
  ]);
  expect(merged?.history).toBe(true);
  expect(outcomes(merged)).toEqual({
    "src/x.ts:40: Upstream only": ["fixed", ["commit fix"]],
    "src/y.ts:10: Fixed later": ["converged-without-fix", []],
  });
});

test("a commit's files beyond GitHub's first page of 300 are read; a truncated or failed list is never convergence", async () => {
  const panel = [finding("src/x.ts", 40, "Deep in a big commit")];
  // 301 files: the match is on the second page.
  const paged = await ghRow("head", panel, [
    ["head", page([])],
    ["big", page(files(300)) + page([{ filename: "src/x.ts", patch: add(40) }])],
  ]);
  expect(paged?.history).toBe(true);
  expect(outcomes(paged)).toEqual({ "src/x.ts:40: Deep in a big commit": ["fixed", ["commit big"]] });
  // Exactly one full page and no next page: complete, and nothing matched.
  const full = await ghRow("head", panel, [
    ["head", page([])],
    ["full", page(files(300))],
  ]);
  expect(full?.history).toBe(true);
  expect(outcomes(full)).toEqual({ "src/x.ts:40: Deep in a big commit": ["converged-without-fix", []] });
  // GitHub's 3000-file cap: the list may be cut short, so any file may have changed.
  const capped = await ghRow("head", panel, [
    ["head", page([])],
    ["huge", Array.from({ length: 10 }, (_, i) => page(files(300, i * 300))).join("")],
  ]);
  expect(capped?.history).toBe(false);
  expect(outcomes(capped)).toEqual({ "src/x.ts:40: Deep in a big commit": ["unknown", []] });
  // A later page fails: gh fails the whole read, so the history is unavailable.
  const failed = await ghRow("head", panel, [
    ["head", page([])],
    ["big", new Error("gh: HTTP 502 on page 2")],
  ]);
  expect(failed?.history).toBe(false);
  expect(outcomes(failed)).toEqual({ "src/x.ts:40: Deep in a big commit": ["unknown", []] });
});
