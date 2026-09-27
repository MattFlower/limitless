import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { DayStats } from "../src/db/stats.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("cost chart exposes every day to hover and focus and sums displayed days", async () => {
  dir = mkdtempSync(join(tmpdir(), "limitless-cost-chart-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../ui/components/CostChart.tsx")],
    outdir: dir,
    target: "bun",
    plugins: [
      {
        name: "solid-ssr-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
            const transformed = await transformAsync(await Bun.file(args.path).text(), {
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
  const output = build.outputs[0];
  if (!output) throw new Error("No chart output");
  const { CostChart } = (await import(output.path)) as typeof import("../ui/components/CostChart.tsx");
  const days: DayStats[] = [
    { day: "2026-09-26", runs: 2, succeeded: 2, failed: 0, costUsd: 0.19, costEquivUsd: 6.75 },
    { day: "2026-09-27", runs: 0, succeeded: 0, failed: 0, costUsd: 0, costEquivUsd: 0 },
  ];
  const html = renderToString(() => CostChart({ days }));
  expect(html).toContain('tabindex="0"');
  expect(html).toContain(
    'aria-label="September 26, 2026: metered $0.19, subscription/local $6.56, API-equivalent total $6.75, 2 runs"',
  );
  expect(html).toContain(
    'title="September 27, 2026: metered $0.00, subscription/local $0.00, API-equivalent total $0.00, 0 runs"',
  );
  expect(html).toContain("Metered: $0.00");
  expect(html).toContain("Subscription/local: $6.56");
  expect(html).toContain("API-equivalent total: $6.75");
  expect(html).toContain('class="cost-stack" style="height:100%"');
  const subscription = html.match(/class="cost-equivalent" style="height:([\d.]+)%"/);
  const metered = html.match(/class="cost-metered" style="height:([\d.]+)%"/);
  expect(Number(subscription?.[1])).toBeCloseTo((6.56 / 6.75) * 100);
  expect(Number(metered?.[1])).toBeCloseTo((0.19 / 6.75) * 100);
  expect(html).toContain("Visible range · Metered");
  expect(html).toContain("$6.75");
  const empty = renderToString(() => CostChart({ days: [] }));
  expect(empty).toContain("No cost data in this range.");
  expect(empty).not.toContain("cost-totals");
  expect(empty).not.toContain("$0.00");
});
