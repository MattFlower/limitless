import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import type { ProviderStatus, Run, RunStatus, StageName } from "../src/core/types.ts";
import type { DayStats, Stats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import { padDays } from "../ui/lib/days.ts";
import type { TestNode } from "./providers-page-support.ts";

type Fixture = typeof import("./providers-page-support.ts") & {
  PipelineMap: (props: { runs: Run[] }) => TestNode;
  SidebarStatus: () => TestNode;
  ProviderCard: (props: { provider: ProviderStatus }) => TestNode;
  NavBar: () => TestNode;
  CostChart: (props: { days: DayStats[] }) => TestNode;
  Dashboard: () => TestNode;
};
const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
const support = join(import.meta.dir, "providers-page-support.ts");
const dir = mkdtempSync(join(tmpdir(), "limitless-ui-redesign-"));
const fixedNow = new Date(2026, 9, 22, 12).getTime();
let fixture: Fixture;
const disposers: (() => void)[] = [];
const text = (node: TestNode): string => node.text + node.children.map(text).join("");
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const byClass = (root: TestNode, name: string) =>
  nodes(root).filter((n) =>
    String(n.props.class ?? "")
      .split(" ")
      .includes(name),
  );
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function mount(component: () => TestNode): TestNode {
  const root = fixture.node();
  disposers.push(fixture.render(component, root));
  return root;
}

beforeAll(async () => {
  const entry = join(dir, "entry.ts");
  const router = join(dir, "router.tsx");
  await Bun.write(
    router,
    `import { location } from ${JSON.stringify(support)};
     export const useLocation = () => location;
     export const useNavigate = () => (_path: string) => {};
     export const A = (props) => <a {...props} />;`,
  );
  await Bun.write(
    entry,
    `export * from ${JSON.stringify(support)};
     ${["PipelineMap", "SidebarStatus", "ProviderCard", "NavBar", "CostChart"]
       .map(
         (name) =>
           `export { ${name} } from ${JSON.stringify(join(import.meta.dir, `../ui/components/${name}.tsx`))};`,
       )
       .join("\n")}
     export { Dashboard } from ${JSON.stringify(join(import.meta.dir, "../ui/pages/Dashboard.tsx"))};`,
  );
  const build = await Bun.build({
    entrypoints: [entry],
    outdir: join(dir, "build"),
    target: "bun",
    plugins: [
      {
        name: "ui-redesign-mounted-test",
        setup(builder) {
          builder.onResolve({ filter: /^solid-js$/ }, () => ({
            path: join(import.meta.dir, "../node_modules/solid-js/dist/solid.js"),
          }));
          builder.onResolve({ filter: /^solid-js\/store$/ }, () => ({
            path: join(import.meta.dir, "../node_modules/solid-js/store/dist/store.js"),
          }));
          builder.onResolve({ filter: /^@solidjs\/router$/ }, () => ({ path: router }));
          builder.onLoad({ filter: /\/ui\/(store|api)\.ts$|\/ui\/lib\/ticker\.ts$/ }, () => ({
            contents: `export * from ${JSON.stringify(support)};`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
            let source = await Bun.file(args.path).text();
            if (args.path.endsWith("/Dashboard.tsx"))
              source += `\nimport { setInterval, clearInterval, setTimeout, clearTimeout } from ${JSON.stringify(support)};`;
            const result = await transformAsync(source, {
              filename: args.path,
              parserOpts: { plugins: ["jsx", "typescript"] },
              presets: [
                [solid, { generate: "universal", moduleName: support }],
                [ts, {}],
              ],
            });
            return { contents: result?.code ?? "", loader: "js" };
          });
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("missing UI test build");
  fixture = (await import(output.path)) as Fixture;
});
beforeEach(() => {
  setSystemTime(fixedNow);
  fixture.setNow(fixedNow);
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  expect(fixture.timerCount()).toBe(0);
  expect(fixture.listenerCount()).toBe(0);
  setSystemTime();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = (id: string, windows: ProviderStatus["windows"] = {}): ProviderStatus => ({
  id,
  label: id,
  billing: "subscription",
  enabled: true,
  state: "ok",
  reason: null,
  until: null,
  windows,
  spendUsd: null,
  budgetUsd: null,
  inFlight: 0,
  maxConcurrent: 3,
  updatedAt: fixedNow,
});

test("sidebar and provider cards share freshness boundaries and update with only the clock", () => {
  const windows = {
    five_hour: { utilization: 0.76, resetsAt: fixedNow + 1000, observedAt: fixedNow },
    seven_day: { utilization: 0.45, resetsAt: null, observedAt: fixedNow },
    expired: { utilization: 0.99, resetsAt: fixedNow, observedAt: fixedNow },
    past: { utilization: 0.98, resetsAt: fixedNow - 1, observedAt: fixedNow },
    stale: { utilization: 0.97, resetsAt: fixedNow + 10000, observedAt: fixedNow - 3600000 },
    unknown: { utilization: 0.96, resetsAt: null, observedAt: null },
    missing: JSON.parse('{"utilization":0.95,"resetsAt":null}'),
  } satisfies ProviderStatus["windows"];
  const alpha = provider("Alpha", windows);
  const beta = provider("Beta", {
    seven_day: { utilization: 0.92, resetsAt: null, observedAt: fixedNow - 3600000 + 2000 },
  });
  fixture.setProviders({
    beta,
    alpha,
    disabled: { ...provider("Disabled", beta.windows), enabled: false },
    empty: provider("Empty"),
    expired: provider("Expired", { five_hour: windows.expired }),
    stale: provider("Stale", { seven_day: windows.stale }),
    unknown: provider("Unknown", { seven_day: windows.unknown }),
  });
  const sidebar = mount(() => fixture.SidebarStatus());
  const alphaCard = mount(() => fixture.ProviderCard({ provider: alpha }));
  const betaCard = mount(() => fixture.ProviderCard({ provider: beta }));
  const readings = () => byClass(sidebar, "sidebar-quota").map(text);
  const bars = (root: TestNode) => byClass(root, "gauge-track");
  expect(readings()).toEqual(["Alpha5h 76%", "Beta7d 92%"]);
  expect(byClass(sidebar, "sidebar-quota-fill").map((n) => n.props.class)).toEqual([
    "sidebar-quota-fill warn",
    "sidebar-quota-fill crit",
  ]);
  expect(bars(alphaCard)).toHaveLength(2);
  expect(bars(betaCard)).toHaveLength(1);
  expect(text(alphaCard)).toContain("99%");
  expect(text(alphaCard)).toContain("updated");
  expect(text(alphaCard)).toContain("unknown");
  fixture.setNow(fixedNow + 999);
  expect(readings()).toEqual(["Alpha5h 76%", "Beta7d 92%"]);
  fixture.setNow(fixedNow + 1000);
  expect(readings()).toEqual(["Alpha7d 45%", "Beta7d 92%"]);
  expect(bars(alphaCard)).toHaveLength(1);
  fixture.setNow(fixedNow + 1999);
  expect(bars(betaCard)).toHaveLength(1);
  fixture.setNow(fixedNow + 2000);
  expect(readings()).toEqual(["Alpha7d 45%"]);
  expect(bars(betaCard)).toHaveLength(0);
  fixture.setNow(fixedNow + 3600000);
  expect(readings()).toEqual([]);
  expect(bars(alphaCard)).toHaveLength(0);
  // Freshness is display-only; the source readings survive expiry.
  expect(alpha.windows.five_hour?.utilization).toBe(0.76);
  expect(beta.windows.seven_day?.utilization).toBe(0.92);
});

test("sidebar gate telemetry caps dots at eight and renders only present holders", () => {
  fixture.setGateSlots(undefined);
  const root = mount(() => fixture.SidebarStatus());
  expect(byClass(root, "sidebar-gates")).toHaveLength(0);
  fixture.setGateSlots({ occupied: 3, limit: 12, holders: ["lint", "tests"] });
  expect(text(root)).toContain("Gate slots3/12lint, tests");
  expect(byClass(root, "gate-dot")).toHaveLength(8);
  expect(byClass(root, "gate-dot").filter((n) => (n.props.classList as { busy: boolean }).busy)).toHaveLength(
    3,
  );
  expect(byClass(root, "sidebar-holders").map(text)).toEqual(["lint, tests"]);
  fixture.setGateSlots({ occupied: 10, limit: 12, holders: [] });
  expect(byClass(root, "gate-dot").filter((n) => (n.props.classList as { busy: boolean }).busy)).toHaveLength(
    8,
  );
  expect(byClass(root, "sidebar-holders")).toHaveLength(0);
  fixture.setGateSlots({ occupied: 0, limit: 2, holders: [] });
  expect(byClass(root, "gate-dot")).toHaveLength(2);
  expect(byClass(root, "gate-dot").every((n) => !(n.props.classList as { busy: boolean }).busy)).toBe(true);
  expect(text(root)).toContain("0/2");
});

const emptyDay: DayStats = {
  day: "2026-10-22",
  runs: 0,
  succeeded: 0,
  failed: 0,
  costUsd: 0,
  costEquivUsd: 0,
};

test("cost chart hides bars, totals and legend for empty input and zero-padded days", () => {
  for (const days of [[], padDays([], 14, fixedNow)]) {
    const root = mount(() => fixture.CostChart({ days }));
    expect(text(root)).toBe("No cost data in this range.");
    for (const name of ["cost-bars", "cost-totals", "cost-legend"])
      expect(byClass(root, name)).toHaveLength(0);
  }
});

test.each([
  { runs: 1, costUsd: 0, costEquivUsd: 0 },
  { runs: 0, costUsd: 1.25, costEquivUsd: 0 },
  { runs: 0, costUsd: 0, costEquivUsd: 2.5 },
])("cost chart retains activity for %j", (activity) => {
  const root = mount(() => fixture.CostChart({ days: [{ ...emptyDay, ...activity }] }));
  expect(text(root)).not.toContain("No cost data");
  expect(byClass(root, "cost-bar")).toHaveLength(1);
  expect(byClass(root, "cost-totals")).toHaveLength(1);
  expect(byClass(root, "cost-legend")).toHaveLength(1);
});

test("pipeline stations render active counts, asking runs and the combined queue", () => {
  const store = new Store(":memory:");
  let runs: Run[];
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
    const cases: [RunStatus, StageName | null][] = [
      ["queued", null],
      ["queued", null],
      ["waiting", null],
      ["running", "plan"],
      ["running", "implement"],
      ["running", "implement"],
      ["waiting_input", "clarify"],
      ["running", null],
      ["succeeded", "deliver"],
      ["failed", "gates"],
      ["needs_human", "review"],
      ["cancelled", "spec"],
      ["resolved", "audit"],
    ];
    runs = cases.map(([status, stage], i) => ({ ...base, id: `run-${i}`, status, stage }));
  } finally {
    store.close();
  }
  const root = mount(() => fixture.PipelineMap({ runs }));
  const stations = byClass(root, "pipeline-station");
  expect(stations.map((s) => byClass(s, "pipeline-name").map(text).join(""))).toEqual([
    " run at prepare",
    " runs at triage",
    " run at clarify, 1 waiting on you",
    " runs at spec",
    " run at plan",
    " runs at holdout",
    " runs at implement",
    " runs at gates",
    " runs at audit",
    " runs at review",
    " runs at preview",
    " runs at verify",
    " runs at deliver",
  ]);
  expect(stations.map((s) => byClass(s, "pipeline-count").map(text).join(""))).toEqual([
    "1",
    "0",
    "1",
    "0",
    "1",
    "0",
    "2",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
  ]);
  expect(stations.filter((s) => (s.props.classList as { busy: boolean }).busy)).toHaveLength(4);
  expect(stations.filter((s) => (s.props.classList as { asking: boolean }).asking).map(text)).toEqual([
    "1 run at clarify, 1 waiting on you",
  ]);
  expect(byClass(root, "pipeline-cap-queue").map(text)).toEqual(["Queue31 waiting on dependencies"]);
});

test("navigation activates exact and nested destinations without matching similar prefixes", async () => {
  const root = mount(() => fixture.NavBar());
  await flush();
  for (const [path, active] of [
    ["/", ["/"]],
    ["/providers", ["/providers"]],
    ["/providers/example", ["/providers"]],
    ["/providers-extra", []],
  ] as const) {
    fixture.setLocation("pathname", path);
    expect(
      byClass(root, "nav-link")
        .filter((n) => (n.props.classList as { active: boolean }).active)
        .map((n) => n.props.href),
    ).toEqual([...active]);
  }
});

test("Dashboard renders windowed runs, current attention and the real padded cost chart", async () => {
  const root = mount(() => fixture.Dashboard());
  await flush();
  const stats: Stats = {
    days: [],
    models: [],
    needsYouRunIds: ["old-a", "old-b"],
    totals: {
      runs: 4,
      succeeded: 2,
      costUsd: 0,
      costEquivUsd: 0,
      active: 0,
      queued: 0,
      openNeedsHuman: 1,
      openNeedsHumanRate: 0.25,
    },
  };
  expect(fixture.statsRequests.at(-1)?.days).toBe(14);
  fixture.statsRequests.at(-1)?.resolve(stats);
  await flush();
  expect(byClass(root, "page-subtitle").map(text)).toEqual(["4 runs in the last 14 days · 2 need you"]);
  expect(text(root)).toContain("No cost data in this range.");
  expect(byClass(root, "cost-bar")).toHaveLength(0);

  const refresh = async (next: Stats) => {
    fixture.publishLiveUpdate({ kind: "reconnected" });
    fixture.advanceTimers(250);
    fixture.statsRequests.at(-1)?.resolve(next);
    await flush();
  };
  await refresh({
    ...stats,
    needsYouRunIds: ["old-a"],
    totals: { ...stats.totals, runs: 1 },
    days: [{ ...emptyDay, runs: 1, costUsd: 1.25, costEquivUsd: 3.5 }],
  });
  expect(byClass(root, "page-subtitle").map(text)).toEqual(["1 run in the last 14 days · 1 needs you"]);
  expect(text(root)).not.toContain("No cost data");
  expect(byClass(root, "cost-bar")).toHaveLength(14);
  expect(byClass(root, "cost-bar").at(-1)?.props["aria-label"]).toContain(
    "metered $1.25, subscription/local $2.25, API-equivalent total $3.50, 1 run",
  );
  expect(byClass(root, "cost-totals").map(text)).toEqual([
    "Visible range · Metered $1.25API-equivalent total $3.50",
  ]);
  await refresh({ ...stats, needsYouRunIds: [], totals: { ...stats.totals, runs: 0 } });
  expect(byClass(root, "page-subtitle").map(text)).toEqual([
    "0 runs in the last 14 days · nothing needs you right now",
  ]);
  expect(text(root)).toContain("No cost data in this range.");
  expect(byClass(root, "cost-bar")).toHaveLength(0);
});
