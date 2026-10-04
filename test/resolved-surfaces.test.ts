import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { Run, StreamMessage } from "../src/core/types.ts";
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
  const resolved = store.getRun(first.id);
  if (!resolved) throw new Error("missing resolved run");
  return { store, resolved };
}

test("dashboard renders resolved list/filter and open needs-human count and rate", async () => {
  dir = mkdtempSync(join(tmpdir(), "limitless-resolved-ui-"));
  const { store, resolved } = storedRuns();
  try {
    const stats = computeStats(store);
    expect(stats.totals.openNeedsHuman).toBe(1);
    expect(stats.totals.openNeedsHumanRate).toBe(0.5);
    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "../ui/components/StatusPill.tsx"),
        join(import.meta.dir, "../ui/components/FilterChips.tsx"),
        join(import.meta.dir, "../ui/components/KpiStrip.tsx"),
        join(import.meta.dir, "../ui/components/RunsTable.tsx"),
        join(import.meta.dir, "../ui/pages/RunDetail.tsx"),
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
                  'const useNavigate = () => (_path: string) => {}; const useParams = <T,>(): T => ({ id: "run" }) as T;',
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
    expect(kpis).toMatch(/Open needs human \(14d\)<\/span>\s*<span class="kpi-value">1<\/span>/);
    expect(kpis).toContain("50% of runs");
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
        ref: null,
        note: "Handled in another change",
      },
    };
    const manualDetail = renderToString(() => withFixture(manual));
    expect(manualDetail).toContain("done_elsewhere");
    expect(manualDetail).toContain("Handled in another change");
    expect(manualDetail).not.toContain("Merged by");
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
