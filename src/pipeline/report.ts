import { repoSettings } from "../config.ts";
import { cacheHitRate } from "../core/cache-format.ts";
import { effortLabel } from "../core/effort-format.ts";
import type { Invocation, RunModels } from "../core/types.ts";
import { redactGateData } from "../gates/output.ts";
import { publicationWorktree, sanitizePublication } from "../gates/publication.ts";
import { activity } from "../util/stall.ts";
import type { RunContext, RunState } from "./context.ts";
import {
  markReportArtifacts,
  type ReportArtifacts,
  type ReportPart,
  reportJoin,
  reportText,
} from "./report-privacy.ts";
import { type Review, rowKind } from "./schemas.ts";
import { notRequired } from "./verification.ts";

function money(n: number): string {
  return n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** Every display cut retains the complete rendering for privacy matching. */
function clipText(text: string, limit: number, atLine = false): { text: string; source?: string } {
  if (text.length <= limit) return { text };
  const line = atLine ? text.lastIndexOf("\n", limit) : -1;
  const displayed = text.slice(0, line > 0 ? line : limit);
  return { text: atLine ? displayed.trimEnd() : displayed, source: text };
}

// Line breaks stay visible as <br> so the change view can still join a wrapped quotation.
function clipCell(s: string): { text: string; source?: string } {
  return clipText(s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"), 300);
}

// Only private spans may discard a clipped source: the view always withholds them whole.
function escapeCell(s: string): string {
  return clipCell(s).text;
}

function cell(kind: "prose" | "verifier", text: string) {
  const clipped = clipCell(text);
  return reportText(kind, clipped.text, clipped.source);
}

function table(
  header: string[],
  rows: (string | ReturnType<typeof reportText>)[][],
  privateRows: boolean[] = [],
): ReportPart {
  return reportJoin(
    [
      `| ${header.join(" | ")} |`,
      `|${header.map(() => "---").join("|")}|`,
      ...rows.map((row, index) =>
        privateRows[index]
          ? reportText("private", `| ${row.map((c) => (typeof c === "string" ? c : c.text)).join(" | ")} |`)
          : ["| ", reportJoin(row, " | "), " |"],
      ),
    ],
    "\n",
  );
}

export interface ReportInput {
  discreet?: boolean;
  signalWarnings?: number;
  models?: RunModels;
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
    | "baseline"
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
  return renderReportArtifacts(input).report;
}

export function renderReportArtifacts(
  input: ReportInput,
  publication?: (text: string) => string,
): ReportArtifacts {
  return activity("report.render", () => renderArtifacts(input, publication));
}

function renderArtifacts(input: ReportInput, publication?: (text: string) => string): ReportArtifacts {
  input = redactGateData(input);
  // Normalize complete strings before display cuts, spans and clipped-source metadata.
  if (publication)
    input = JSON.parse(
      JSON.stringify(input, (_key, value: unknown) =>
        typeof value === "string" ? publication(value) : value,
      ),
    );
  const { state } = input;
  const blocks: ReportPart[] = [
    input.discreet
      ? input.success
        ? state.flow === "verify-change"
          ? "Checks below have no blocking regressions."
          : "Every gate below passed."
        : "⚠️ Needs a human: the checks below did not all pass."
      : input.success
        ? state.flow === "verify-change"
          ? "Verified by **Limitless** — checks below have no blocking regressions."
          : "Built by **Limitless** — every gate below passed."
        : "⚠️ Built by **Limitless** but it **needs a human**: the checks below did not all pass.",
    `Flow: ${state.flow ?? "build"}`,
    ...(input.success && state.flow === "verify-change" && state.reviewedSha
      ? [`Verified commit: \`${state.reviewedSha}\``]
      : []),
    ...(state.rebaseNote ? [reportText("prose", `> [!NOTE]\n> ${state.rebaseNote}`)] : []),
    ...(state.terminalReason ? [reportText("verifier", `🚧 ${state.terminalReason}`)] : []),
    ...(input.verifiedFailure
      ? [
          "## Failed after verification",
          `Verified at \`${input.verifiedFailure.sha}\`; failed after verification at \`${input.verifiedFailure.stage}\`: \`${input.verifiedFailure.reason}\`. The PR may conflict with \`${input.verifiedFailure.base}\`.`,
        ]
      : []),
    ...(input.freeFirstRouting ? ["Routing: free-first (Dependabot)"] : []),
    "## Request",
    reportText(
      "prose",
      input.prompt
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n"),
    ),
  ];

  if (Object.keys(input.models ?? {}).length)
    blocks.push(
      "## Routing — model experiment",
      ...Object.entries(input.models ?? {}).map(([role, chain]) => `- ${role}: \`${chain.join(", ")}\``),
    );

  if (state.implementerReport) {
    const summary = clipText(state.implementerReport.trim(), 5000, true);
    blocks.push("## Implementer's summary", reportText("implementer", summary.text, summary.source));
  }

  if (state.spec) {
    const verify = state.lastVerify;
    const privateRows: boolean[] = [];
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
          const isPrivate = rowKind(ac.id, state.spec ?? null, state.holdout) !== "public";
          privateRows.push(isPrivate);
          return isPrivate
            ? [`${icon} ${ac.id}`, escapeCell(ac.criterion), escapeCell(v?.evidence ?? "not verified")]
            : [
                reportText("prose", `${icon} ${ac.id}`),
                cell("prose", ac.criterion),
                cell("verifier", v?.evidence ?? "not verified"),
              ];
        }),
        privateRows,
      ),
    );
    if (verify) blocks.push(`Verified by \`${verify.modelId}\` in a separate session from the implementer.`);
    if (state.spec.assumptions.length) {
      blocks.push(
        "**Assumptions**",
        reportText("prose", state.spec.assumptions.map((a) => `- ${a}`).join("\n")),
      );
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
        results.map(() => true),
      ),
    );
    if (state.lastVerify)
      blocks.push(`Holdouts not met: ${blocking.length} blocking, ${followUps.length} not required.`);
    if (followUps.length)
      blocks.push(
        "**Holdout follow-ups** (not required by the request or spec; they did not trigger another round)",
        reportJoin(
          followUps.map(({ scenario, result }) =>
            reportText(
              "private",
              `- ${scenario.id}: ${escapeCell(scenario.description)} — ${escapeCell(result?.evidence ?? "")}`,
            ),
          ),
          "\n",
        ),
      );
  }

  if (input.signalWarnings)
    blocks.push(
      `> [!WARNING]\n> ${input.signalWarnings} process signal attempt(s) detected. See the invocation event log; this does not establish that a signal succeeded.`,
    );
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
          const command = clipCell(g.result.command);
          return commands
            ? [
                ...row,
                reportText(
                  "prose",
                  `\`${command.text}\``,
                  command.source === undefined ? undefined : `\`${command.source}\``,
                ),
              ]
            : row;
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
  const flakyBaseline = (state.baseline?.checks ?? []).flatMap((check) => {
    const first = check.firstAttempt;
    if (!first || first.ok || !check.ok) return [];
    const result = `${first.timedOut ? "timed out" : "failed"}${first.exitCode === null ? "" : ` (exit ${first.exitCode})`}`;
    return [[cell("prose", check.name), `${result}; passed on retry`]];
  });
  if (flakyBaseline.length)
    blocks.push("**Flaky baseline checks**", table(["Check", "First attempt → Retry"], flakyBaseline));

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
    blocks.push(reportText("prose", `**${r.verdict}** — ${r.summary}`));
    if (r.findings.length) {
      blocks.push(
        reportText(
          "prose",
          r.findings
            .map(
              (f) =>
                `- ${severity(f)}: ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${f.title}`,
            )
            .join("\n"),
        ),
      );
    }
  }
  if (state.reviewFollowUps?.length) {
    blocks.push(
      "## Review follow-ups",
      reportText(
        "prose",
        state.reviewFollowUps
          .map(
            (f) =>
              `- ${severity(f)}${f.security ? " (security)" : ""}: ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${f.title} — ${f.detail}`,
          )
          .join("\n"),
      ),
    );
  }

  const audit = state.lastAudit ?? [];
  if (audit.length) {
    blocks.push(
      "## Audit flags",
      reportText(
        "prose",
        audit.map((f) => `- ${f.severity} [${f.rule}] ${f.file ? `${f.file}: ` : ""}${f.detail}`).join("\n"),
      ),
    );
  }

  // Shadow review calls are observational: kept out of the work log, their spend shown on its own line.
  const work = input.invocations.filter((inv) => inv.role !== "review_shadow");
  const shadow = input.invocations.filter((inv) => inv.role === "review_shadow");
  const spent = (key: "costUsd" | "costEquivUsd") =>
    money(shadow.reduce((total, inv) => total + inv[key], 0));
  const shadowSpend = `**Shadow review (included in total):** ${spent("costUsd")} spent, ${spent("costEquivUsd")} API-equivalent on subscriptions.`;
  const promptTokens = (list: Invocation[]) =>
    list.reduce((n, inv) => n + inv.inputTokens + inv.cacheReadTokens + inv.cacheWriteTokens, 0);
  if (work.length) {
    const uncached = work.reduce((n, inv) => n + inv.inputTokens, 0);
    const cached = work.reduce((n, inv) => n + inv.cacheReadTokens, 0);
    const written = work.reduce((n, inv) => n + inv.cacheWriteTokens, 0);
    blocks.push(
      "## Work log",
      table(
        ["Role", "Model", "Effort", "Status", "Tokens in / out", "Cached", "Cache write", "Cost", "Duration"],
        work.map((inv) => [
          inv.role,
          `\`${inv.modelId}\``,
          effortLabel(inv.effort),
          inv.status,
          `${(inv.inputTokens + inv.cacheReadTokens + inv.cacheWriteTokens).toLocaleString("en-US")} / ${inv.outputTokens.toLocaleString("en-US")}`,
          inv.cacheReadTokens.toLocaleString("en-US"),
          inv.cacheWriteTokens.toLocaleString("en-US"),
          inv.costUsd > 0 ? money(inv.costUsd) : `${money(inv.costEquivUsd)} equiv.`,
          inv.finishedAt ? `${Math.round((inv.finishedAt - inv.startedAt) / 1000)}s` : "–",
        ]),
      ),
      `**Total:** ${money(input.totals.costUsd)} spent, ${money(input.totals.costEquivUsd)} API-equivalent on subscriptions.`,
      `**Cache:** ${cacheHitRate(cached, promptTokens(work))} of prompt tokens read from cache (${cached.toLocaleString("en-US")} cached, ${written.toLocaleString("en-US")} written, ${uncached.toLocaleString("en-US")} not cached; cache writes older rows never recorded count here).`,
      ...(shadow.length ? [shadowSpend] : []),
    );
  }

  if (input.closesIssue) blocks.push(`Closes #${input.closesIssue}`);
  if (!input.discreet) blocks.push(`Run \`${input.runId}\` · ${input.runUrl}`, "🤖 Generated by Limitless");
  return markReportArtifacts(blocks);
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
  return buildReportArtifacts(ctx, success, verifiedFailure).report;
}

export function saveReport(ctx: RunContext, rendered: ReportArtifacts): void {
  ctx.artifact("report-sources.json", "report", JSON.stringify(rendered.sources));
  ctx.artifact("report.md", "report", rendered.report);
}

export function buildReportArtifacts(
  ctx: RunContext,
  success: boolean,
  verifiedFailure?: ReportInput["verifiedFailure"],
): ReportArtifacts {
  const latest = ctx.store.getRun(ctx.run.id) ?? ctx.run;
  // Report privacy matches historical reports with the spellings rewritten here.
  const worktree = publicationWorktree(ctx.state);
  if (worktree.length && worktree.join("\0") !== ctx.state.worktreeAliases?.join("\0")) {
    ctx.state.worktreeAliases = worktree;
    ctx.store.setRunState(ctx.run.id, ctx.state);
  }
  return renderReportArtifacts(
    {
      success,
      discreet: repoSettings(ctx.deps.cfg, ctx.repo.slug).discreet,
      signalWarnings: ctx.store.countEvents(ctx.run.id, "signal_attempt"),
      runId: ctx.run.id,
      prompt: ctx.run.prompt,
      state: verifiedFailure ? verifiedFailureState(ctx.state) : ctx.state,
      verifiedFailure,
      invocations: ctx.store.listInvocations(ctx.run.id),
      totals: { costUsd: latest.costUsd, costEquivUsd: latest.costEquivUsd },
      runUrl: `${ctx.deps.cfg.uiUrl}/runs/${ctx.run.id}`,
      freeFirstRouting: ctx.freeFirstRouting,
      models: ctx.run.models,
      ...(issueClosedBy(ctx) ? { closesIssue: issueClosedBy(ctx) as number } : {}),
    },
    (text) => sanitizePublication(text, worktree, ctx.deps.cfg.paths.home),
  );
}

function issueClosedBy(ctx: RunContext): number | null {
  const ref = ctx.run.sourceRef;
  return ref?.kind === "issue" && ref.repo === ctx.repo.slug && typeof ref.number === "number"
    ? ref.number
    : null;
}
