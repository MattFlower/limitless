import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import type { ProviderStatus, QuotaAlert } from "../src/core/types.ts";
import type { ProviderWorkload } from "../src/db/stats.ts";
import type { TestNode } from "./providers-page-support.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
const support = join(import.meta.dir, "providers-page-support.ts");
const provider: ProviderStatus = {
  id: "codex",
  label: "Codex",
  billing: "subscription",
  enabled: true,
  supportsFast: true,
  fast: false,
  state: "ok",
  reason: null,
  until: null,
  windows: {},
  spendUsd: null,
  budgetUsd: null,
  inFlight: 1,
  maxConcurrent: 3,
  updatedAt: 0,
};
const totals = { invocations: 17, tokensIn: 1200, tokensOut: 300, wallTimeMs: 2000, costEquivUsd: 0.5 };
const workload: ProviderWorkload = { provider: "codex", today: totals, sevenDays: totals };
const text = (node: TestNode): string => node.text + node.children.map(text).join("");
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const cards = (root: TestNode) => nodes(root).filter((n) => n.props.class === "card provider-card");
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("Providers keeps controls, sorted live cards and polling; Dashboard retains only quota alerts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-providers-"));
  let dispose = () => {};
  try {
    const entry = join(dir, "entry.ts");
    await Bun.write(
      entry,
      `export * from ${JSON.stringify(support)};
       export { Providers } from ${JSON.stringify(join(import.meta.dir, "../ui/pages/Providers.tsx"))};
       export { Dashboard } from ${JSON.stringify(join(import.meta.dir, "../ui/pages/Dashboard.tsx"))};
       export { NavBar } from ${JSON.stringify(join(import.meta.dir, "../ui/components/NavBar.tsx"))};`,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: join(dir, "build"),
      target: "bun",
      plugins: [
        {
          name: "providers-mounted-test",
          setup(builder) {
            builder.onResolve({ filter: /^solid-js$/ }, () => ({
              path: join(import.meta.dir, "../node_modules/solid-js/dist/solid.js"),
            }));
            builder.onResolve({ filter: /^solid-js\/store$/ }, () => ({
              path: join(import.meta.dir, "../node_modules/solid-js/store/dist/store.js"),
            }));
            builder.onLoad({ filter: /\/ui\/(store|api)\.ts$/ }, () => ({
              contents: `export * from ${JSON.stringify(support)};`,
              loader: "ts",
            }));
            builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
              let source = await Bun.file(args.path).text();
              if (args.path.endsWith("/NavBar.tsx"))
                source = source.replace(
                  'import { A, useLocation } from "@solidjs/router";',
                  'const useLocation = () => ({pathname:"/providers"}); const A = (props: import("solid-js").JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />;',
                );
              if (args.path.endsWith("/RunsTable.tsx"))
                source = source.replace(
                  'import { useNavigate } from "@solidjs/router";',
                  "const useNavigate = () => (_path: string) => {};",
                );
              if (/\/(Providers|Dashboard)\.tsx$/.test(args.path))
                source += `\nimport { setInterval, clearInterval } from ${JSON.stringify(support)};`;
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
    if (!output) throw new Error("missing Providers test build");
    const fixture = (await import(output.path)) as typeof import("./providers-page-support.ts") & {
      Providers: () => TestNode;
      Dashboard: () => TestNode;
      NavBar: () => TestNode;
    };
    const root = fixture.node();
    fixture.setWorkload([workload]);
    dispose = fixture.render(() => fixture.Providers(), root);
    await flush();
    expect(fixture.liveStarts).toBe(1);
    expect(text(root)).toContain("No provider telemetry yet.");
    expect(fixture.workloadReads).toBe(1);
    fixture.setProviders({
      codex: provider,
      claude: { ...provider, id: "claude", label: "Claude", enabled: false, supportsFast: false },
    });
    expect(cards(root)).toHaveLength(2);
    expect(cards(root).map((card) => text(card).startsWith("Claude"))).toEqual([true, false]);
    expect(text(root)).not.toContain("No provider telemetry yet.");
    const codex = cards(root)[1];
    if (!codex) throw new Error("missing Codex card");
    expect(text(codex)).toContain("Invocations1717");
    expect(text(codex)).toContain("Tokens in1.2k1.2k");
    expect(text(codex)).toContain("Tokens out300300");
    expect(text(codex)).toContain("Fast mode");
    expect(nodes(root).filter((n) => n.props.role === "switch")).toHaveLength(1);
    const buttons = nodes(root).filter((n) => n.tag === "button");
    expect(buttons.map(text)).toEqual(["Enable", "Disable"]);
    const toggle = nodes(codex).find((n) => n.tag === "button");
    const fast = nodes(codex).find((n) => n.props.role === "switch");
    if (!toggle || !fast) throw new Error("missing provider controls");
    await (toggle.props.onClick as () => void)();
    await flush();
    await (fast.props.onChange as () => void)();
    await flush();
    expect(fixture.updates).toEqual([
      { id: "codex", enabled: false },
      { id: "codex", fast: true },
    ]);
    fixture.setProviders("codex", { label: "Codex updated", enabled: false, fast: true, inFlight: 2 });
    expect(text(codex)).toContain("Codex updated");
    expect(text(toggle)).toBe("Enable");
    expect(fast.props.checked).toBe(true);
    expect(text(codex)).toContain("in-flight 2/3");
    fixture.setWorkload([{ ...workload, today: { ...totals, invocations: 23 } }]);
    fixture.advanceTimers(29_999);
    expect(fixture.workloadReads).toBe(1);
    fixture.advanceTimers(1);
    await flush();
    expect(fixture.workloadReads).toBe(2);
    expect(text(codex)).toContain("Invocations2317");
    fixture.setWorkload([], true);
    fixture.advanceTimers(30_000);
    await flush();
    expect(fixture.workloadReads).toBe(3);
    expect(text(codex)).toContain("Invocations2317");
    fixture.setProviders("custom", {
      ...provider,
      id: "custom",
      label: "Configured MLX",
      ...{ apiKey: "never-publish-sentinel" },
      inFlight: 1,
      kind: "openai-compatible",
      billing: "free",
      supportsFast: false,
      maxConcurrent: 4,
      enabled: false,
      state: "disabled",
      reason: "missing key EXAMPLE_KEY",
    });
    const custom = cards(root).find((card) => text(card).startsWith("Configured MLX"));
    if (!custom) throw new Error("missing configured provider card");
    expect(text(custom)).toContain("openai-compatible");
    expect(text(custom)).toContain("missing key EXAMPLE_KEY");
    expect(text(custom)).toContain("in-flight 1/4");
    fixture.setProviders("custom", { enabled: true, state: "ok", reason: null, inFlight: 2 });
    expect(text(custom)).not.toContain("missing key EXAMPLE_KEY");
    expect(text(custom)).toContain("in-flight 2/4");
    expect(text(custom)).toContain("Disable");
    expect(text(root)).not.toContain("never-publish-sentinel");
    dispose();
    expect(fixture.timerCount()).toBe(0);
    fixture.advanceTimers(30_000);
    expect(fixture.workloadReads).toBe(3);

    const alert: QuotaAlert = {
      provider: "codex",
      window: "five_hour",
      severity: "warning",
      utilization: 0.9,
      resetsAt: null,
      routing: "Use another provider",
      createdAt: 0,
    };
    fixture.setAlerts({ "codex:five_hour": alert });
    const dashboard = fixture.node();
    dispose = fixture.render(() => fixture.Dashboard(), dashboard);
    await flush();
    expect(cards(dashboard)).toHaveLength(0);
    expect(nodes(dashboard).some((n) => n.props.class === "provider-grid" || n.props.role === "switch")).toBe(
      false,
    );
    expect(text(dashboard)).toContain("Quota warning: codex · five_hour");
    expect(text(dashboard)).toContain("90.0% utilization");
    expect(fixture.workloadReads).toBe(3);
    dispose();

    const nav = fixture.node();
    dispose = fixture.render(() => fixture.NavBar(), nav);
    const links = nodes(nav).filter((n) => n.tag === "a");
    const modelsIndex = links.findIndex((n) => n.props.href === "/models");
    const providersLink = links[modelsIndex + 1];
    expect(providersLink?.props.href).toBe("/providers");
    expect(providersLink?.props.classList).toEqual({ active: true });
    expect(links[modelsIndex]?.props.classList).toEqual({ active: false });
    await flush();
    expect(nodes(nav).filter((n) => n.tag === "button")).toEqual([]);
    dispose();
    fixture.setAuthSession({
      id: "ses-1",
      method: "password",
      device: "Browser",
      createdAt: 0,
      lastSeenAt: 0,
    });
    dispose = fixture.render(() => fixture.NavBar(), nav);
    await flush();
    expect(
      nodes(nav)
        .filter((n) => n.tag === "button")
        .map(text),
    ).toEqual(["Sign out", "Sign out everywhere"]);
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
