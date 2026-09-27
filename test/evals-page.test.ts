import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import { summarize } from "../src/evals/stats.ts";
import { evidence, local, response } from "./evals-policy-support.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
test("Evals SSR renders navigation, loading/errors/empty states, matrix, run costs and detailed trial evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evals-ssr-"));
  try {
    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "../ui/pages/Evals.tsx"),
        join(import.meta.dir, "../ui/components/NavBar.tsx"),
        join(import.meta.dir, "../ui/components/InvocationsTable.tsx"),
      ],
      outdir: dir,
      target: "bun",
      plugins: [
        {
          name: "evals-ssr",
          setup(builder) {
            builder.onLoad({ filter: /\/ui\/store\.ts$/ }, () => ({
              contents: "export const live = {connected:()=>false}; export function ensureLiveStore() {}",
              loader: "js",
            }));
            builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
              let source = await Bun.file(args.path).text();
              if (args.path.endsWith("/NavBar.tsx"))
                source = source.replace(
                  'import { A, useLocation } from "@solidjs/router";',
                  'const useLocation = () => ({pathname:"/evals"}); const A = (props: import("solid-js").JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />;',
                );
              const result = await transformAsync(source, {
                filename: args.path,
                parserOpts: { plugins: ["jsx", "typescript"] },
                presets: [
                  [solid, { generate: "ssr" }],
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
    const pages = build.outputs.find((o) => o.path.endsWith("Evals.js"));
    const nav = build.outputs.find((o) => o.path.endsWith("NavBar.js"));
    if (!pages || !nav) throw new Error("Missing SSR output");
    const { EvalsView, EvalDetailView } = (await import(
      pages.path
    )) as typeof import("../ui/pages/Evals.tsx");
    const { NavBar } = (await import(nav.path)) as typeof import("../ui/components/NavBar.tsx");
    expect(renderToString(() => NavBar({}))).toContain('href="/evals"');
    expect(renderToString(() => EvalsView({}))).toContain("Loading evals");
    expect(renderToString(() => EvalsView({ error: "API unavailable" }))).toContain('role="alert"');
    expect(renderToString(() => EvalsView({ error: "API unavailable" }))).not.toContain("Loading evals");
    expect(renderToString(() => EvalsView({ data: response([]) }))).toContain("No eval runs yet");
    const variants = evidence("triage", [
      "codex/luna@low",
      "codex/luna@high",
      "codex/luna@none",
      "codex/luna",
    ]);
    // Bare codex/luna rows here predate effort recording.
    for (const t of variants.trials) if (t.effort === "default") t.effort = null;
    const variantHtml = renderToString(() => EvalsView({ data: response([variants]) }));
    for (const target of variants.run.models) expect(variantHtml).toContain(target);
    expect(variantHtml).toContain("unknown (legacy)");
    expect(variantHtml).toContain("legacy evidence with unknown effort");
    const detailHtml = renderToString(() =>
      EvalDetailView({ report: { ...variants, summaries: summarize(variants.run, variants.trials) } }),
    );
    for (const effort of ["low", "high", "none", "unknown (legacy)"]) expect(detailHtml).toContain(effort);
    const invocationOutput = build.outputs.find((o) => o.path.endsWith("InvocationsTable.js"));
    if (!invocationOutput) throw new Error("missing invocation output");
    const { InvocationsTable } = (await import(
      invocationOutput.path
    )) as typeof import("../ui/components/InvocationsTable.tsx");
    const invocations = (["low", "high", "none", "default", null] as const).map(
      (effort, id): import("../src/core/types.ts").Invocation => ({
        id,
        effort,
        runId: "run",
        stageId: null,
        role: "implement",
        harness: "fake",
        provider: "codex",
        model: "gpt-6-luna",
        modelId: "codex/luna",
        status: "ok",
        costUsd: 0,
        costEquivUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        numTurns: 1,
        sessionId: null,
        error: null,
        startedAt: 1,
        finishedAt: 2,
      }),
    );
    const invocationHtml = renderToString(() =>
      InvocationsTable({ invocations, selectedId: null, onSelect: () => {} }),
    );
    for (const effort of ["low", "high", "none", "backend default", "unknown (legacy)"])
      expect(invocationHtml).toContain(`>${effort}</td>`);
    expect(invocationHtml.match(/<th[ >]/g)).toHaveLength(11);
    expect(
      renderToString(() => InvocationsTable({ invocations: [], selectedId: null, onSelect: () => {} })),
    ).toContain('colspan="11"');
    const rows = [evidence("triage"), evidence("review"), evidence("verify")];
    const html = renderToString(() => EvalsView({ data: response(rows) }));
    for (const text of [
      "Eligibility matrix",
      "triage-run",
      "review-run",
      "verify-run",
      "completed",
      "Metered cost",
      "API-equivalent cost",
      "eligible",
      "no result",
      "/evals/triage-run",
      "<th>k</th>",
    ])
      expect(html).toContain(text);
    expect(renderToString(() => EvalDetailView({}))).toContain("Loading eval report");
    expect(renderToString(() => EvalDetailView({ error: "Missing run" }))).toContain("Missing run");
    for (const row of rows) {
      const base = row.trials[0];
      if (!base) throw new Error("missing trial");
      row.trials.push(
        {
          ...base,
          caseId: "broken",
          trial: 2,
          status: "error",
          pass: false,
          details: { reason: "synthetic failure" },
        },
        {
          ...base,
          caseId: "skipped",
          trial: 3,
          status: "skipped",
          pass: null,
          details: { reason: "synthetic skip" },
        },
        {
          ...base,
          caseId: "cached",
          trial: 4,
          details: {
            cache: {
              evalRunId: "original-cache-run",
              caseId: "cached",
              costUsd: 0.2,
              costEquivUsd: 0.3,
              durationMs: 123,
              tokensIn: 1,
              tokensOut: 1,
            },
          },
        },
      );
      const report = { ...row, summaries: summarize(row.run, row.trials) };
      const detail = renderToString(() => EvalDetailView({ report }));
      for (const text of [
        local,
        "Wilson 95% CI",
        "paired cases=",
        "prediction coverage",
        "p50 invocation",
        "API-equivalent",
        "metered",
        "Repetition",
        "Pass / score",
        "synthetic failure",
        "synthetic skip",
        "original-cache-run",
        "riskUnderCall",
        "<td>4</td>",
      ])
        expect(detail).toContain(text);
      if (row.run.role === "review") expect(detail).toContain("defect recall");
      if (row.run.role === "verify") expect(detail).toContain("false-accept");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
