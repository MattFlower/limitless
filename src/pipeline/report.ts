import { effortLabel } from "../core/effort-format.ts";
import type { Invocation } from "../core/types.ts";
import type { RunContext, RunState } from "./context.ts";
import { type Review, rowKind } from "./schemas.ts";
import { notRequired } from "./verification.ts";

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
    | "flow"
    | "implementerReport"
    | "spec"
    | "holdout"
    | "lastVerify"
    | "lastGates"
    | "gateTimeoutReruns"
    | "lastReview"
    | "reviewFollowUps"
    | "reviewHistory"
    | "lastAudit"
    | "rebaseNote"
    | "terminalReason"
    | "reviewedSha"
  >;
  invocations: Invocation[];
  totals: { costUsd: number; costEquivUsd: number };
  runUrl: string;
  /** Issue in the same repository this run was started from; the PR closes it on merge. */
  closesIssue?: number;
  freeFirstRouting?: boolean;
  verifiedFailure?: { sha: string; stage: string; reason: string; base: string };
}

/** Markdown evidence report used as the PR body. Each block is one markdown element. */
export function renderReport(input: ReportInput): string {
  const { state } = input;
  const blocks: string[] = [
    input.success
      ? state.flow === "verify-change"
        ? "Verified by **Limitless** — checks below have no blocking regressions."
        : "Built by **Limitless** — every gate below passed."
      : "⚠️ Built by **Limitless** but it **needs a human**: the checks below did not all pass.",
    `Flow: ${state.flow ?? "build"}`,
    ...(input.success && state.flow === "verify-change" && state.reviewedSha
      ? [`Verified commit: \`${state.reviewedSha}\``]
      : []),
    ...(state.rebaseNote ? [`> [!NOTE]\n> ${state.rebaseNote}`] : []),
    ...(state.terminalReason ? [`🚧 ${state.terminalReason}`] : []),
    ...(input.verifiedFailure
      ? [
          "## Failed after verification",
          `Verified at \`${input.verifiedFailure.sha}\`; failed after verification at \`${input.verifiedFailure.stage}\`: \`${input.verifiedFailure.reason}\`. The PR may conflict with \`${input.verifiedFailure.base}\`.`,
        ]
      : []),
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
          const v = verify?.criteria.find(
            (c) => c.id === ac.id && rowKind(c.id, state.spec ?? null, state.holdout) === "public",
          );
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
    const results = state.holdout.scenarios.map((scenario) => ({
      scenario,
      result: state.lastVerify?.criteria.find((c) => c.id === scenario.id),
    }));
    const followUps = results.filter(({ result }) => result && notRequired(result));
    const blocking = results.filter(
      ({ result }) => result?.status !== "met" && !(result && notRequired(result)),
    );
    blocks.push(
      "## Holdout scenarios",
      table(
        ["", "Scenario", "Result", "Evidence"],
        results.map(({ scenario, result }) => [
          scenario.id,
          escapeCell(scenario.description),
          result?.status === "blocked"
            ? "🚧 blocked"
            : result?.status === "unmet"
              ? `unmet (${result.requirement ? result.requirement.replace("_", " ") : "unclassified"})`
              : (result?.status ?? "unclear"),
          escapeCell(result?.evidence ?? "not verified"),
        ]),
      ),
    );
    if (state.lastVerify)
      blocks.push(`Holdouts not met: ${blocking.length} blocking, ${followUps.length} not required.`);
    if (followUps.length)
      blocks.push(
        "**Holdout follow-ups** (not required by the request or spec; they did not trigger another round)",
        followUps
          .map(
            ({ scenario, result }) =>
              `- ${scenario.id}: ${escapeCell(scenario.description)} — ${escapeCell(result?.evidence ?? "")}`,
          )
          .join("\n"),
      );
  }

  blocks.push("## Checks");
  if (state.gateTimeoutReruns) blocks.push(`Timeout-caused gate re-runs: ${state.gateTimeoutReruns}.`);
  if (state.lastGates?.length) {
    // PR verdict comments omit commands: they can name local paths and generated outputs.
    const commands = state.flow !== "verify-change";
    blocks.push(
      table(
        ["Check", "Result", ...(commands ? ["Command"] : [])],
        state.lastGates.map((g) => {
          const warn = g.verdict === "still_failing" || g.verdict === "flaky";
          const icon = g.blocking ? "❌" : warn ? "⚠️" : "✅";
          const row = [g.name, `${icon} ${g.result.timedOut ? "timed out" : g.verdict.replace("_", " ")}`];
          return commands ? [...row, `\`${escapeCell(g.result.command)}\``] : row;
        }),
      ),
    );
    const flaky = state.lastGates.filter((g) => g.verdict === "flaky").map((g) => `\`${g.name}\``);
    if (flaky.length)
      blocks.push(
        `> [!WARNING]\n> Flaky: ${flaky.join(", ")} failed, then passed when re-run. Both outputs are kept in the gates artifact.`,
      );
  } else {
    blocks.push("No automated checks were detected for this repository.");
  }

  // Panel findings carry the verifier's consequence severity; unverified ones keep the finder's.
  const severity = (f: Review["findings"][number]) =>
    f.verification?.severity ??
    (state.lastReview?.mode === "panel" ? `${f.severity} (unverified)` : f.severity);
  if (state.lastReview) {
    const r = state.lastReview;
    blocks.push(`## Code review (\`${r.modelId}\`)`);
    const schedule = (state.reviewHistory ?? []).flatMap((e) =>
      e.scope?.kind === "resolution"
        ? [`- Conflict-resolution review — change against the new base \`${e.scope.range}\``]
        : e.panelReview && e.scope
          ? [
              `- Panel review R${e.panelReview} — ${e.scope.kind === "fix" ? "fix diff" : "full change"} \`${e.scope.range}\``,
            ]
          : [],
    );
    if (schedule.length) blocks.push(schedule.join("\n"));
    blocks.push(`**${r.verdict}** — ${r.summary}`);
    if (r.findings.length) {
      blocks.push(
        r.findings
          .map(
            (f) =>
              `- ${severity(f)}: ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${f.title}`,
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
            `- ${severity(f)}${f.security ? " (security)" : ""}: ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${f.title} — ${f.detail}`,
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

  // Shadow review calls are observational: kept out of the work log, their spend shown on its own line.
  const work = input.invocations.filter((inv) => inv.role !== "review_shadow");
  const shadow = input.invocations.filter((inv) => inv.role === "review_shadow");
  const spent = (key: "costUsd" | "costEquivUsd") =>
    money(shadow.reduce((total, inv) => total + inv[key], 0));
  const shadowSpend = `**Shadow review (included in total):** ${spent("costUsd")} spent, ${spent("costEquivUsd")} API-equivalent on subscriptions.`;
  if (work.length) {
    blocks.push(
      "## Work log",
      table(
        ["Role", "Model", "Effort", "Status", "Tokens in / out", "Cost", "Duration"],
        work.map((inv) => [
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
      ...(shadow.length ? [shadowSpend] : []),
    );
  }

  if (input.closesIssue) blocks.push(`Closes #${input.closesIssue}`);
  blocks.push(`Run \`${input.runId}\` · ${input.runUrl}`, "🤖 Generated by Limitless");
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The state a verified-failure report describes: the evidence saved when the run last verified.
 * Reviews after that point are dropped (evidence saved before it kept the history has none), so the
 * listed rounds and the shown verdict refer to the same commit.
 */
export function verifiedFailureState(state: RunState): ReportInput["state"] {
  return { ...state, reviewHistory: undefined, ...state.lastVerifiedEvidence };
}

export function buildReport(
  ctx: RunContext,
  success: boolean,
  verifiedFailure?: ReportInput["verifiedFailure"],
): string {
  const latest = ctx.store.getRun(ctx.run.id) ?? ctx.run;
  return renderReport({
    success,
    runId: ctx.run.id,
    prompt: ctx.run.prompt,
    state: verifiedFailure ? verifiedFailureState(ctx.state) : ctx.state,
    verifiedFailure,
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
