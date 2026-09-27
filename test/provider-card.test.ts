import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { ProviderStatus } from "../src/core/types.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;

let dir: string | null = null;
afterEach(() => {
  setSystemTime();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("OpenRouter card renders reported and estimated spend and missing reading", async () => {
  dir = mkdtempSync(join(tmpdir(), "limitless-card-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../ui/components/ProviderCard.tsx")],
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
  if (!output) throw new Error("Provider card build produced no output");
  const { ProviderCard } = (await import(output.path)) as typeof import("../ui/components/ProviderCard.tsx");
  const status: ProviderStatus = {
    id: "openrouter",
    label: "OpenRouter",
    billing: "metered",
    enabled: true,
    state: "ok",
    reason: null,
    until: null,
    windows: {},
    spendUsd: 12,
    budgetUsd: 50,
    reportedUsageUsd: 18,
    reportedAt: 1_000_000,
    limit: 100,
    limitRemaining: 82,
    limitReset: "daily",
    inFlight: 0,
    maxConcurrent: 2,
    updatedAt: 1_000_000,
  };
  const html = renderToString(() => ProviderCard({ provider: status }));
  expect(html).toContain("estimated (30d)");
  expect(html).toContain("reported (monthly)");
  expect(html).toContain("$12.00");
  expect(html).toContain("$18.00");
  expect(html).toContain("daily");
  const missing = renderToString(() =>
    ProviderCard({
      provider: {
        ...status,
        reportedUsageUsd: null,
        reportedAt: null,
        limit: null,
        limitRemaining: null,
        limitReset: null,
      },
    }),
  );
  expect(missing).toContain("unavailable");
});

test("provider card shows rounded utilization and each window's live reading age", async () => {
  const now = 1_000_000;
  setSystemTime(now);
  dir = mkdtempSync(join(tmpdir(), "limitless-card-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../ui/components/ProviderCard.tsx")],
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
  if (!output) throw new Error("Provider card build produced no output");
  const { ProviderCard } = (await import(output.path)) as typeof import("../ui/components/ProviderCard.tsx");
  const status: ProviderStatus = {
    id: "claude",
    label: "Claude",
    billing: "subscription",
    enabled: true,
    state: "ok",
    reason: null,
    until: null,
    spendUsd: null,
    budgetUsd: null,
    inFlight: 0,
    maxConcurrent: 1,
    updatedAt: now,
    windows: {
      five_hour: { utilization: 0.721, resetsAt: now + 60_000, observedAt: now - 12 * 60_000 },
      seven_day: { utilization: 0, resetsAt: null, observedAt: null },
      other: { utilization: 1, resetsAt: null, observedAt: now + 60_000 },
    },
  };
  const html = renderToString(() => ProviderCard({ provider: status }));
  expect(html).toContain("73% · as of 12 min ago");
  expect(html).toContain("0% · as of unknown");
  expect(html).toContain("100% · as of just now");
  expect(html).not.toContain("·  ·");
});
