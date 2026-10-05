import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { ProviderStatus } from "../src/core/types.ts";
import { workloadFor } from "../ui/lib/provider-workload.ts";
import { windowLabel } from "../ui/lib/window-label.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;

let dir: string | null = null;
afterEach(() => {
  setSystemTime();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("window labels are compact and readable", () => {
  expect(windowLabel("five_hour")).toBe("5h");
  expect(windowLabel("seven_day")).toBe("7d");
  expect(windowLabel("seven_day_overage_included")).toBe("7d overage included");
  expect(windowLabel("seven_day_opus")).toBe("7d opus");
  expect(windowLabel("five_hour_sonnet")).toBe("5h sonnet");
  expect(windowLabel("other_window_name")).toBe("other window name");
});

test("OpenRouter card keeps one budget gauge and reports only material differences", async () => {
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
    spendUsd: 10,
    budgetUsd: 50,
    reportedUsageUsd: 10.5,
    reportedAt: 1_000_000,
    limit: 100,
    limitRemaining: 82,
    limitReset: "daily",
    inFlight: 0,
    maxConcurrent: 2,
    updatedAt: 1_000_000,
  };
  const html = renderToString(() => ProviderCard({ provider: status }));
  const discovered = renderToString(() =>
    ProviderCard({
      provider: {
        ...status,
        id: "local",
        discovery: {
          served: ["new-build"],
          observedAt: 100,
          observations: [],
          servedNotInCatalog: ["new-build"],
          catalogNotServed: ["local/old"],
        },
      },
    }),
  );
  expect(discovered).toContain("Catalog models not served by local: local/old");
  expect(discovered).toContain('role="alert"');
  expect(discovered).toContain("Served models not in catalog: new-build");
  expect(html).not.toContain('role="switch"');
  for (const id of ["codex", "claude"]) {
    const card = renderToString(() =>
      ProviderCard({
        provider: {
          ...status,
          id,
          supportsFast: true,
          fast: true,
          fastModeUnavailableReason: id === "claude" ? "extra_usage_disabled" : null,
        },
      }),
    );
    expect(card).toContain('role="switch"');
    expect(card).toContain('aria-checked="true"');
    expect(card).toContain("Fast mode");
    expect(card).toContain(id === "codex" ? "0.159.2" : "paid extra usage");
    if (id === "claude") expect(card).toContain("fast mode unavailable: extra_usage_disabled");
  }
  expect(html).toContain("30-day spend");
  expect(html).toContain("$10.00 / $50.00");
  expect(html).toContain("key $82.00 left of $100.00 · resets daily");
  expect(html).not.toContain("reported this month");
  expect(html).not.toContain("Last 7 days");
  expect(html.match(/class="gauge-details"/g)).toHaveLength(1);
  expect(html).toMatch(
    /class="gauge-label"[^>]*>.*30-day spend.*\$10\.00 \/ \$50\.00.*<\/div><div class="gauge-track"/,
  );
  expect(html).toMatch(/title="reading [^"]+"/);
  const reading = new Date(status.reportedAt ?? 0).toLocaleString();
  expect(html.replace(/title="[^"]*"/g, "")).not.toContain(reading);

  const atThreshold = renderToString(() => ProviderCard({ provider: { ...status, reportedUsageUsd: 11 } }));
  expect(atThreshold).not.toContain("reported this month");
  const aboveThreshold = renderToString(() =>
    ProviderCard({ provider: { ...status, reportedUsageUsd: 11.01 } }),
  );
  expect(aboveThreshold).toContain("key $82.00 left of $100.00 · resets daily · reported this month $11.01");
  expect(aboveThreshold.match(/class="gauge-details"/g)).toHaveLength(1);
  const belowFloor = renderToString(() =>
    ProviderCard({ provider: { ...status, spendUsd: 2, reportedUsageUsd: 2.5 } }),
  );
  expect(belowFloor).not.toContain("reported this month");
  const aboveFloor = renderToString(() =>
    ProviderCard({ provider: { ...status, spendUsd: 2, reportedUsageUsd: 2.51 } }),
  );
  expect(aboveFloor).toContain("reported this month $2.51");
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
  expect(missing).toContain("key unavailable left of unavailable · resets unavailable");
  expect(missing).not.toContain("reading");
  expect(missing.match(/class="gauge-details"/g)).toHaveLength(1);
  const workload = workloadFor("openrouter", [
    {
      provider: "openrouter",
      today: { invocations: 1, tokensIn: 12, tokensOut: 4, wallTimeMs: 62_000, costEquivUsd: 0.4 },
      sevenDays: { invocations: 3, tokensIn: 120, tokensOut: 40, wallTimeMs: 120_000, costEquivUsd: 1.2 },
    },
  ]);
  const metered = renderToString(() => ProviderCard({ provider: status, workload }));
  expect(metered).toContain("7 days");
  expect(metered).toContain("API-equivalent");
  expect(metered).toContain("1m 2s");
  expect(metered).toContain("$1.20");
  const free = renderToString(() =>
    ProviderCard({ provider: { ...status, id: "mtplx", billing: "free" }, workload }),
  );
  expect(free).toContain("API-equivalent work");
  const empty = renderToString(() =>
    ProviderCard({
      provider: { ...status, id: "twilight", billing: "free" },
      workload: workloadFor("twilight", []),
    }),
  );
  expect(empty).toContain("API-equivalent work");
  expect(empty).toContain("$0.00");
});

test("provider card renders each window's label, bar, and full-width details in order", async () => {
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
      seven_day_overage_included: { utilization: 1, resetsAt: null, observedAt: now + 60_000 },
    },
  };
  const html = renderToString(() => ProviderCard({ provider: status }));
  expect(html).not.toContain("seven_day_overage_included");
  expect(html).not.toContain("Last 7 days");
  expect(html).toContain("resets in 1m · updated 12 min ago");
  expect(html).toContain("updated unknown");
  expect(html).toContain("updated just now");
  for (const [label, value] of [
    ["5h", "73%"],
    ["7d", "0%"],
    ["7d overage included", "100%"],
  ] as const) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(html).toMatch(
      new RegExp(
        `class="gauge-label"[^>]*><span>${escapedLabel}</span><span class="gauge-value">${value}</span></div><div class="gauge-track"`,
      ),
    );
  }
  expect(html.match(/class="gauge-details"/g)).toHaveLength(3);
  expect(html).not.toContain("Confined readers");

  const codex = (confinement: ProviderStatus["confinement"]) =>
    renderToString(() => ProviderCard({ provider: { ...status, id: "codex", label: "Codex", confinement } }))
      .replace(/<!--[^>]*-->/g, "")
      .replace(/\s+/g, " ");
  const reason = "reader profile not enforced";
  expect(
    codex({ ok: false, path: "/old/bin/codex", version: "codex-cli 0.154.0", reason, exitCode: 0 }),
  ).toContain(`Confined readers skip this provider: ${reason} (/old/bin/codex, codex-cli 0.154.0, exit 0)`);
  expect(
    codex({ ok: false, path: null, version: null, reason: "codex sandbox failed to start", exitCode: null }),
  ).toContain("Confined readers skip this provider: codex sandbox failed to start (no CLI)");
  expect(
    codex({
      ok: true,
      path: "/opt/homebrew/bin/codex",
      version: "codex-cli 0.157.1",
      reason: null,
      exitCode: 0,
    }),
  ).not.toContain("Confined readers");
});
