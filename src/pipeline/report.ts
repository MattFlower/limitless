import { effortLabel } from "../core/effort-format.ts";
import type { Invocation } from "../core/types.ts";
import type { RunContext, RunState } from "./context.ts";

function money(n: number): string {
  return n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 300);
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

export interface ReportInput {
  success: boolean;
  runId: string;
  prompt: string;
  state: Pick<
    RunState,
    | "implementerReport"
    | "spec"
    | "holdout"
    | "lastVerify"
    | "lastGates"
    | "lastReview"
    | "reviewFollowUps"
    | "lastAudit"
    | "rebaseNote"
    | "terminalReason"
  >;
  invocations: Invocation[];
  totals: { costUsd: number; costEquivUsd: number };
  runUrl: string;
  /** Issue in the same repository this run was started from; the PR closes it on merge. */
  closesIssue?: number;
  freeFirstRouting?: boolean;
}

/** Markdown evidence report used as the PR body. Each block is one markdown element. */
export function renderReport(input: ReportInput): string {
  const { state } = input;
  const blocks: string[] = [
    input.success
      ? "Built by **Limitless** — every gate below passed."
      : "⚠️ Built by **Limitless** but it **needs a human**: the checks below did not all pass.",
    ...(state.rebaseNote ? [`> [!NOTE]\n> ${state.rebaseNote}`] : []),
    ...(state.terminalReason ? [`🚧 ${state.terminalReason}`] : []),
    ...(input.freeFirstRouting ? ["Routing: free-first (Dependabot)"] : []),
    "## Request",
    input.prompt
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
  ];

  if (state.implementerReport)
    blocks.push("## Implementer's summary", state.implementerReport.trim().slice(0, 5000));

  if (state.spec) {
    const verify = state.lastVerify;
    blocks.push(
      "## Acceptance criteria",
      table(
        ["", "Criterion", "Evidence"],
        state.spec.acceptance_criteria.map((ac) => {
          const v = verify?.criteria.find((c) => c.id === ac.id);
          const icon = !v
            ? "·"
            : v.status === "met"
              ? "✅"
              : v.status === "unmet"
                ? "❌"
                : v.status === "blocked"
                  ? "🚧 blocked"
                  : "❔";
          return [`${icon} ${ac.id}`, escapeCell(ac.criterion), escapeCell(v?.evidence ?? "not verified")];
        }),
      ),
    );
    if (verify) blocks.push(`Verified by \`${verify.modelId}\` in a separate session from the implementer.`);
    if (state.spec.assumptions.length) {
      blocks.push("**Assumptions**", state.spec.assumptions.map((a) => `- ${a}`).join("\n"));
    }
  }

  if (state.holdout) {
    blocks.push(
      "## Holdout scenarios",
      table(
        ["", "Scenario", "Result", "Evidence"],
        state.holdout.scenarios.map((scenario) => {
          const result = state.lastVerify?.criteria.find((c) => c.id === scenario.id);
          return [
            scenario.id,
            escapeCell(scenario.description),
            result?.status === "blocked" ? "🚧 blocked" : (result?.status ?? "unclear"),
            escapeCell(result?.evidence ?? "not verified"),
          ];
        }),
      ),
    );
  }

  blocks.push("## Checks");
  if (state.lastGates?.length) {
    blocks.push(
      table(
        ["Check", "Result", "Command"],
        state.lastGates.map((g) => {
          const icon = g.blocking ? "❌" : g.verdict === "still_failing" ? "⚠️" : "✅";
          return [g.name, `${icon} ${g.verdict.replace("_", " ")}`, `\`${escapeCell(g.result.command)}\``];
        }),
      ),
    );
  } else {
    blocks.push("No automated checks were detected for this repository.");
  }

  if (state.lastReview) {
    const r = state.lastReview;
    blocks.push(`## Code review (\`${r.modelId}\`)`, `**${r.verdict}** — ${r.summary}`);
    if (r.findings.length) {
      blocks.push(
        r.findings
          .map(
            (f) =>
              `- ${f.severity}: ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${f.title}`,
          )
          .join("\n"),
      );
    }
  }
  if (state.reviewFollowUps?.length) {
    blocks.push(
      "## Review follow-ups",
      state.reviewFollowUps
        .map(
          (f) =>
            `- ${f.severity}${f.security ? " (security)" : ""}: ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${f.title} — ${f.detail}`,
        )
        .join("\n"),
    );
  }

  const audit = state.lastAudit ?? [];
  if (audit.length) {
    blocks.push(
      "## Audit flags",
      audit.map((f) => `- ${f.severity} [${f.rule}] ${f.file ? `${f.file}: ` : ""}${f.detail}`).join("\n"),
    );
  }

  if (input.invocations.length) {
    blocks.push(
      "## Work log",
      table(
        ["Role", "Model", "Effort", "Status", "Tokens in / out", "Cost", "Duration"],
        input.invocations.map((inv) => [
          inv.role,
          `\`${inv.modelId}\``,
          effortLabel(inv.effort),
          inv.status,
          `${(inv.inputTokens + inv.cacheReadTokens).toLocaleString("en-US")} / ${inv.outputTokens.toLocaleString("en-US")}`,
          inv.costUsd > 0 ? money(inv.costUsd) : `${money(inv.costEquivUsd)} equiv.`,
          inv.finishedAt ? `${Math.round((inv.finishedAt - inv.startedAt) / 1000)}s` : "–",
        ]),
      ),
      `**Total:** ${money(input.totals.costUsd)} spent, ${money(input.totals.costEquivUsd)} API-equivalent on subscriptions.`,
    );
  }

  if (input.closesIssue) blocks.push(`Closes #${input.closesIssue}`);
  blocks.push(`Run \`${input.runId}\` · ${input.runUrl}`, "🤖 Generated by Limitless");
  return `${blocks.join("\n\n")}\n`;
}

export function buildReport(ctx: RunContext, success: boolean): string {
  const latest = ctx.store.getRun(ctx.run.id) ?? ctx.run;
  return renderReport({
    success,
    runId: ctx.run.id,
    prompt: ctx.run.prompt,
    state: ctx.state,
    invocations: ctx.store.listInvocations(ctx.run.id),
    totals: { costUsd: latest.costUsd, costEquivUsd: latest.costEquivUsd },
    runUrl: `${ctx.deps.cfg.uiUrl}/runs/${ctx.run.id}`,
    freeFirstRouting: ctx.freeFirstRouting,
    ...(issueClosedBy(ctx) ? { closesIssue: issueClosedBy(ctx) as number } : {}),
  });
}

function issueClosedBy(ctx: RunContext): number | null {
  const ref = ctx.run.sourceRef;
  return ref?.kind === "issue" && ref.repo === ctx.repo.slug && typeof ref.number === "number"
    ? ref.number
    : null;
}
