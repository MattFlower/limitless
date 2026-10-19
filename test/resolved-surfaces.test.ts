import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { Run, RunStatus, StreamMessage } from "../src/core/types.ts";
import { computeStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function storedRuns(): { store: Store; resolved: Run } {
  if (!dir) throw new Error("missing test directory");
  const store = new Store(join(dir, "store.db"));
  const repo = store.upsertRepo({
    slug: "MattFlower/limitless",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const first = store.createRun(repo, { repo: repo.slug, prompt: "Resolved work" });
  store.updateRun(first.id, {
    status: "resolved",
    prUrl: "https://github.com/MattFlower/limitless/pull/39",
    merged: true,
    mergedBy: "reviewer",
    mergedAt: Date.parse("2026-09-27T20:00:00Z"),
  });
  const second = store.createRun(repo, { repo: repo.slug, prompt: "Still open" });
  store.updateRun(second.id, { status: "needs_human" });
  const failed = store.createRun(repo, { repo: repo.slug, prompt: "Failed work" });
  store.updateRun(failed.id, { status: "failed" });
  const resolved = store.getRun(first.id);
  if (!resolved) throw new Error("missing resolved run");
  return { store, resolved };
}

function attentionFixture() {
  const store = new Store(":memory:");
  const repo = store.upsertRepo({
    slug: "owner/repo",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const pr = "https://github.com/owner/repo/pull/1";
  const head = "a".repeat(40);
  const stoppedAt = Date.now() - 10_000;
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Stopped work" });
  store.updateRun(run.id, { status: "needs_human", prUrl: pr, finishedAt: stoppedAt });
  const approve = (at = stoppedAt + 1, sha = head) => {
    store.recordApproval(run.id, pr, sha, "reviewer");
    store.db
      .query("UPDATE review_approvals SET created_at = ? WHERE id = (SELECT MAX(id) FROM review_approvals)")
      .run(at);
  };
  const round = (source: string, url: string, sequence: number, status: RunStatus, kind = "review") => {
    const child = store.createRun(repo, { repo: repo.slug, prompt: "Later round" });
    store.updateRun(child.id, { status, prUrl: url });
    store.db
      .query(`INSERT INTO review_rounds
      (run_id, source_run_id, pr_url, round, kind, reviewed_sha, findings, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`)
      .run(child.id, source, url, sequence, kind, head, Date.now());
    return child;
  };
  return { store, repo, run, pr, head, stoppedAt, approve, round };
}

test("attention follows active landing by PR and returns on blockage despite its approval", () => {
  const { store, repo, run, pr, head, stoppedAt, approve, round } = attentionFixture();
  try {
    const actor = round(run.id, pr, 1, "succeeded");
    store.observePrHead(pr, head);
    approve();
    const entry = store.createLandEntry({
      runId: actor.id,
      repo: repo.slug,
      prUrl: pr,
      baseBranch: "main",
      headBranch: "limitless/work",
      approvedSha: head,
    });
    for (const state of ["queued", "checking", "waiting_ci", "merging"] as const) {
      store.updateLandEntry(entry.id, { state });
      const stats = computeStats(store);
      expect(stats.needsYouRunIds).not.toContain(run.id);
      expect(stats.totals.openNeedsHuman).toBe(0);
      // Active landing also supersedes a stop newer than its approval.
      store.updateRun(run.id, { finishedAt: stoppedAt + 2 });
      expect(computeStats(store).totals.openNeedsHuman).toBe(0);
      store.updateRun(run.id, { finishedAt: stoppedAt });
    }
    store.updateLandEntry(entry.id, { state: "blocked" });
    store.db.query("UPDATE land_entries SET updated_at = ? WHERE id = ?").run(stoppedAt + 2, entry.id);
    expect(store.approvalFor(pr)?.stale).toBe(false);
    expect(computeStats(store).needsYouRunIds).toEqual([run.id]);
    approve(stoppedAt + 3);
    expect(computeStats(store).totals.openNeedsHuman).toBe(0);
    store.updateLandEntry(entry.id, { state: "cancelled" });
    store.db.query("UPDATE review_approvals SET stale_reason = 'changes requested'").run();
    expect(computeStats(store).totals.openNeedsHuman).toBe(1);
  } finally {
    store.close();
  }
});

test("attention checks later lineage rounds outside list subsets and the stats window", () => {
  const { store, repo, run, pr, round } = attentionFixture();
  try {
    store.updateRun(run.id, { status: "failed" });
    const unrelated = store.createRun(repo, { repo: repo.slug, prompt: "Unrelated work" });
    round(unrelated.id, `${pr}0`, 1, "running");
    expect(computeStats(store).needsYouRunIds).toContain(run.id);
    const child = round(run.id, pr, 1, "queued", "conflict");
    store.db.query("UPDATE runs SET created_at = ? WHERE id = ?").run(Date.now() - 30 * 86_400_000, child.id);
    expect(store.listRuns({ ids: [run.id], limit: 1 }).map((r) => r.id)).toEqual([run.id]);
    for (const status of ["queued", "running", "failed", "cancelled"] as const) {
      store.updateRun(child.id, { status });
      expect(computeStats(store).needsYouRunIds?.includes(run.id)).toBe(
        status === "failed" || status === "cancelled",
      );
    }
    const later = round(child.id, pr, 2, "running", "ci");
    expect(computeStats(store).needsYouRunIds).not.toContain(run.id);
    // Follow source relationships through multiple generations even without the original PR URL.
    store.db.query("UPDATE runs SET pr_url = NULL WHERE id = ?").run(run.id);
    expect(computeStats(store).needsYouRunIds).not.toContain(run.id);
    // Shared PR sequence also links a later round whose recorded source is the original owner.
    store.updateRun(child.id, { status: "failed" });
    store.db.query("UPDATE review_rounds SET source_run_id = ? WHERE run_id = ?").run(run.id, later.id);
    expect(computeStats(store).needsYouRunIds).not.toContain(child.id);
    store.updateRun(later.id, { status: "cancelled" });
    expect(computeStats(store).needsYouRunIds).toContain(run.id);
  } finally {
    store.close();
  }
});

test("attention requires a newer nonstale approval of the recorded current head", () => {
  const { store, run, pr, head, stoppedAt, approve } = attentionFixture();
  try {
    approve();
    expect(computeStats(store).totals.openNeedsHuman).toBe(1); // no recorded head
    store.observePrHead(pr, head);
    expect(computeStats(store).totals.openNeedsHuman).toBe(0);
    approve(stoppedAt - 1);
    expect(computeStats(store).totals.openNeedsHuman).toBe(1);
    approve(stoppedAt);
    expect(computeStats(store).totals.openNeedsHuman).toBe(1);
    approve();
    store.db.query("UPDATE review_approvals SET stale_reason = 'changes requested'").run();
    expect(computeStats(store).totals.openNeedsHuman).toBe(1);
    approve(stoppedAt + 1, "b".repeat(40));
    expect(computeStats(store).totals.openNeedsHuman).toBe(1); // head mismatch, even without stale flag
    approve();
    store.updateRun(run.id, { finishedAt: null });
    expect(computeStats(store).totals.openNeedsHuman).toBe(1); // unknown stopping time
    store.updateRun(run.id, { merged: true });
    expect(computeStats(store).totals.openNeedsHuman).toBe(0);
    store.updateRun(run.id, { merged: false, status: "resolved" });
    expect(computeStats(store).totals.openNeedsHuman).toBe(0);
  } finally {
    store.close();
  }
});

test("dashboard renders resolved list/filter and open needs-human count and rate", async () => {
  dir = mkdtempSync(join(tmpdir(), "limitless-resolved-ui-"));
  const { store, resolved } = storedRuns();
  try {
    const stats = computeStats(store);
    expect(stats.totals.openNeedsHuman).toBe(2);
    expect(stats.totals.openNeedsHumanRate).toBeCloseTo(2 / 3);
    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "../ui/components/StatusPill.tsx"),
        join(import.meta.dir, "../ui/components/FilterChips.tsx"),
        join(import.meta.dir, "../ui/components/KpiStrip.tsx"),
        join(import.meta.dir, "../ui/components/RunsTable.tsx"),
        join(import.meta.dir, "../ui/pages/RunDetail.tsx"),
        join(import.meta.dir, "../ui/pages/Dashboard.tsx"),
      ],
      outdir: join(dir, "ssr"),
      target: "bun",
      plugins: [
        {
          name: "resolved-ssr",
          setup(builder) {
            builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
              let source = await Bun.file(args.path).text();
              if (args.path.endsWith("/RunsTable.tsx"))
                source = source.replace(
                  'import { useNavigate } from "@solidjs/router";',
                  "const useNavigate = () => (_path: string) => {};",
                );
              if (args.path.endsWith("/RunDetail.tsx")) {
                source = source.replace(
                  'import { useNavigate, useParams } from "@solidjs/router";',
                  "const useNavigate = () => (_path: string) => {}; const useParams = <T,>(): T => ({ id: injectedRun.id }) as T;",
                );
                source = source.replace(
                  "createSignal<Run | null>(null)",
                  "createSignal<Run | null>(injectedRun)",
                );
                source = source.replace("onMount(() => {", "((mount: () => void) => mount())(() => {");
                source = source.replace("getRunDetail, openRunStream, ", "");
                source += `
                  let injectedRun: Run = ${JSON.stringify(resolved)};
                  let injectedUpdate: import("../../src/core/types.ts").StreamMessage | undefined;
                  const getRunDetail = async () => ({run: injectedRun, stages: [], invocations: [], questions: [], artifacts: []});
                  const openRunStream = (_id: string, _last: number, receive: (message: import("../../src/core/types.ts").StreamMessage) => void) => {
                    if (injectedUpdate) receive(injectedUpdate);
                    return () => {};
                  };
                  export function withFixture(run: Run, update?: import("../../src/core/types.ts").StreamMessage) {
                    injectedRun = run; injectedUpdate = update; return RunDetail({});
                  }
                `;
              }
              if (args.path.endsWith("/Dashboard.tsx")) {
                source = source.replace(
                  'import { ensureLiveStore, live, subscribeLiveUpdates } from "../store.ts";',
                  "const ensureLiveStore = () => {}; const live = { get runs() { return Object.fromEntries(fixtureRuns.map(r => [r.id, r])); }, alerts: {} };",
                );
                source = source.replace(
                  "createSignal<Stats | null>(null)",
                  "createSignal<Stats | null>(fixtureStats)",
                );
                source = source.replace(
                  "createSignal<RunFilter | null>(null)",
                  "createSignal<RunFilter | null>(fixtureFilter)",
                );
                source += `
                  let fixtureRuns: import("../../src/core/types.ts").Run[] = [];
                  let fixtureStats: Stats;
                  let fixtureFilter: RunFilter | null;
                  export const withFixture = (runs: import("../../src/core/types.ts").Run[], stats: Stats, filter: RunFilter | null) => {
                    fixtureRuns = runs; fixtureStats = stats; fixtureFilter = filter; return Dashboard({});
                  };
                `;
              }
              const transformed = await transformAsync(source, {
                filename: args.path,
                parserOpts: { plugins: ["jsx", "typescript"] },
                presets: [
                  [solid, { generate: "ssr" }],
                  [ts, {}],
                ],
              });
              return { contents: transformed?.code ?? "", loader: "js" };
            });
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    const output = (name: string) => {
      const found = build.outputs.find((item) => item.path.endsWith(`/${name}.js`));
      if (!found) throw new Error(`missing SSR output for ${name}`);
      return found.path;
    };
    const { RunStatusPill } = (await import(
      output("StatusPill")
    )) as typeof import("../ui/components/StatusPill.tsx");
    const { FilterChips } = (await import(
      output("FilterChips")
    )) as typeof import("../ui/components/FilterChips.tsx");
    const { KpiStrip } = (await import(output("KpiStrip"))) as typeof import("../ui/components/KpiStrip.tsx");
    const { RunsTable } = (await import(
      output("RunsTable")
    )) as typeof import("../ui/components/RunsTable.tsx");
    const dashboard = (await import(output("Dashboard"))) as {
      withFixture: (
        runs: Run[],
        stats: ReturnType<typeof computeStats>,
        filter: RunStatus | "needs_you" | null,
      ) => ReturnType<typeof RunDetail>;
    };
    const { RunDetail, withFixture } = (await import(
      output("RunDetail")
    )) as typeof import("../ui/pages/RunDetail.tsx") & {
      withFixture: (run: Run, update?: StreamMessage) => ReturnType<typeof RunDetail>;
    };

    expect(renderToString(() => RunStatusPill({ status: resolved.status }))).toContain(
      'class="pill pill-resolved">resolved',
    );
    const filters = renderToString(() => FilterChips({ active: "resolved", onChange: () => {} }));
    expect(filters).toContain('class="chip active">resolved</button>');
    const list = renderToString(() => RunsTable({ runs: store.listRuns() }));
    expect(list).toContain('class="pill pill-resolved">resolved');
    expect(list).toContain('class="pill pill-needs_human">needs human');
    const kpis = renderToString(() => KpiStrip({ totals: stats.totals }));
    expect(kpis).toMatch(/Needs you \(14d\)<\/span>\s*<span class="kpi-value">2<\/span>/);
    expect(kpis).toContain("67% of runs");
    const detail = renderToString(() => RunDetail({}));
    expect(detail).toContain('class="pill pill-resolved">resolved');
    expect(detail).toContain("Merged by reviewer on ");
    expect(detail).toContain("pull request ↗");
    const manual: Run = {
      ...resolved,
      merged: false,
      mergedBy: null,
      mergedAt: null,
      resolution: {
        kind: "done_elsewhere",
        by: "human",
        at: 42,
        ref: "https://github.com/MattFlower/limitless/pull/40",
        note: "Handled in another change",
      },
    };
    const manualDetail = renderToString(() => withFixture(manual));
    expect(manualDetail).toContain("done_elsewhere");
    expect(manualDetail).toContain("Handled in another change");
    expect(manualDetail).not.toContain("Merged by");
    expect(manualDetail).toContain("https://github.com/MattFlower/limitless/pull/40");
    for (const action of ["Resolve</button>", "Retry", "Take over"])
      expect(manualDetail).not.toContain(action);
    const attention = () =>
      renderToString(() => dashboard.withFixture(store.listRuns(), computeStats(store), "needs_you"));
    expect(renderToString(() => FilterChips({ active: "needs_you", onChange: () => {} }))).toContain(
      'class="chip active">Needs you</button>',
    );
    const initialAttention = attention();
    expect(initialAttention).toContain("Still open");
    expect(initialAttention).toContain("Failed work");
    expect(initialAttention).not.toContain("Resolved work");
    const open = store.listRuns().find((r) => r.status === "needs_human");
    if (!open) throw new Error("missing needs-human run");
    const pr = "https://github.com/MattFlower/limitless/pull/40";
    const head = "a".repeat(40);
    store.updateRun(open.id, { prUrl: pr, finishedAt: Date.now() - 10_000 });
    store.observePrHead(pr, head);
    store.recordApproval(resolved.id, pr, head, "reviewer");
    const superseded = attention();
    expect(superseded).not.toContain("Still open");
    expect(superseded).toContain("Failed work");
    expect(superseded).toMatch(/Needs you \(14d\)<\/span>\s*<span class="kpi-value">1<\/span>/);
    expect(superseded).toContain("33% of runs");
    expect(
      renderToString(() => dashboard.withFixture(store.listRuns(), computeStats(store), "needs_human")),
    ).toContain("Still open");
    const legacy = renderToString(() =>
      dashboard.withFixture(store.listRuns(), { ...stats, needsYouRunIds: undefined }, "needs_you"),
    );
    expect(legacy).toContain("Still open");
    expect(legacy).toContain("Failed work");
    expect(legacy).toMatch(/Needs you \(14d\)<\/span>\s*<span class="kpi-value">2<\/span>/);
    expect(legacy).toContain("67% of runs");
    store.resolveRun(open.id, { kind: "done_elsewhere", by: "human" });
    const afterResolution = attention();
    expect(afterResolution).not.toContain("Still open");
    expect(afterResolution).toContain("Failed work");
    expect(afterResolution).toMatch(/Needs you \(14d\)<\/span>\s*<span class="kpi-value">1<\/span>/);
    expect(computeStats(store).totals.openNeedsHuman).toBe(1);
    const failed = store.listRuns().find((r) => r.status === "failed");
    if (!failed) throw new Error("missing failed run");
    store.resolveRun(failed.id, { kind: "wont_do", by: "human" });
    expect(attention()).not.toContain("Failed work");
    expect(attention()).toMatch(/Needs you \(14d\)<\/span>\s*<span class="kpi-value">0<\/span>/);
    expect(computeStats(store).totals.openNeedsHuman).toBe(0);
    expect(
      renderToString(() =>
        withFixture({ ...manual, merged: true, mergedBy: "owner", mergedAt: resolved.mergedAt }),
      ),
    ).toContain("Merged by owner on ");
    const waiting: Run = {
      ...resolved,
      status: "waiting",
      dependsOn: ["prerequisite-one", "prerequisite-two"],
    };
    expect(renderToString(() => FilterChips({ active: "waiting", onChange: () => {} }))).toContain(
      'class="chip active">waiting</button>',
    );
    expect(renderToString(() => RunsTable({ runs: [waiting] }))).toContain(
      "waiting for prerequisite-one, prerequisite-two to merge",
    );
    expect(renderToString(() => withFixture(waiting))).toContain(
      "waiting for prerequisite-one, prerequisite-two to merge",
    );
    const blocked: Run = {
      ...waiting,
      status: "needs_human",
      error: "Dependency prerequisite-one: PR was closed unmerged",
    };
    const updated = renderToString(() => withFixture(waiting, { kind: "run", run: blocked }));
    expect(updated).toContain('class="pill pill-needs_human">needs human');
    expect(updated).toContain(blocked.error as string);
    expect(updated).not.toContain("waiting for");
    expect(
      renderToString(() => withFixture(waiting, { kind: "run", run: { ...waiting, status: "queued" } })),
    ).toContain('class="pill pill-queued">queued');
  } finally {
    store.close();
  }
});

test("ls and show print a stored resolved run", async () => {
  dir = mkdtempSync(join(tmpdir(), "limitless-resolved-cli-"));
  const { store, resolved } = storedRuns();
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/runs") return Response.json(store.listRuns());
      if (url.pathname === `/api/runs/${resolved.id}`) return Response.json(store.getRunDetail(resolved.id));
      return new Response("missing", { status: 404 });
    },
  });
  try {
    for (const command of [["ls"], ["show", resolved.id]]) {
      const child = Bun.spawn(["bun", "src/cli/main.ts", ...command], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(resolved.id);
      expect(stdout).toContain("resolved");
    }
  } finally {
    server.stop();
    store.close();
  }
});
