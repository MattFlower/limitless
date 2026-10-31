import { existsSync } from "node:fs";
import { join } from "node:path";
import { globToRegex } from "../gates/audit.ts";
import { detectGates, readDocs, readRetryFiles } from "../gates/detect.ts";
import { redactGateOutput } from "../gates/output.ts";
import { runLocalGates } from "../gates/run.ts";
import {
  addDetachedWorktree,
  discardChanges,
  ensureCache,
  fetchBase,
  headSha,
  readFileAt,
} from "../git/repos.ts";
import { type IssueText, issueTextRefusal } from "../integrations/issue-trust.ts";
import { CancelledError, NeedsHumanError, type RunContext } from "./context.ts";
import {
  acceptanceCoveringPolicy,
  citedFileRefusal,
  coveringTestRefusal,
  coveringTestUnavailable,
  runCoveringRequests,
  selectCoveringRequests,
  succeededCoveringStages,
} from "./covering-tests.ts";
import { InjectedFault, SimulatedTermination } from "./faults.ts";
import { coveringCitation } from "./gate-evidence.ts";
import { acceptancePrompt } from "./prompts.ts";
import { buildReportArtifacts, saveReport } from "./report.ts";
import { type Acceptance, AcceptanceSchema, toStrictJsonSchema } from "./schemas.ts";

export const ACCEPTANCE_BLOCK = "Acceptance runs require a compatible engine";
/** Test seam: disabling it gives the previous release's handling of persisted acceptance runs. */
export const acceptanceEngine = { enabled: true };
export interface AcceptanceSnapshot {
  ticket: IssueText;
  parent: IssueText;
}
export interface AcceptanceUnit {
  id: string;
  text: string;
  class: "behaviour" | "docs";
  sources: string[];
}
export interface AcceptanceState {
  snapshot: AcceptanceSnapshot;
  sha?: string;
  manifest?: AcceptanceUnit[];
  setupDone?: boolean;
  output?: Acceptance;
  outcome?: {
    sha: string;
    units: {
      unit: string;
      verdict: Acceptance["items"][number]["verdict"] | "not_assessed";
      citations: string[];
      refusals: string[];
      note?: string;
    }[];
    summary: string;
    passed: boolean;
  };
}

export function acceptanceRunRequest({
  ticket,
  parent,
  trusted,
}: {
  ticket: IssueText;
  parent: IssueText | null | undefined;
  trusted: string[];
}): AcceptanceSnapshot {
  if (!parent) throw new Error("acceptance ticket has no parent");
  for (const [name, issue] of [
    ["ticket", ticket],
    ["parent", parent],
  ] as const) {
    const reason = issueTextRefusal(issue, trusted);
    if (reason) throw new Error(`${name}: ${reason}`);
  }
  return { ticket, parent };
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim();
const sectionReference = /^#(\d+)'s "([^"]+)" section( \(docs\))?$/;
const listItem = /^(?:[-*+]|\d{1,9}[.)]) (?=.*\S)(.*)$/;
/** Every line form outside the grammar, checked in order; the label names it in the refusal. */
const refusedLines: [RegExp, string][] = [
  [/^[ \t]/, "indented line"],
  [/^>/, "blockquote"],
  [/^\|/, "table row"],
  [/^</, "HTML"],
  [/^(?:`{3,}|~{3,})/, "fence"],
  [/^\[(?:\\.|[^\\\]])*\]:/, "link definition"],
  // Before list items: `* * *` and `- - -` are breaks, and a bare `--- | ---` row makes a table.
  [/^[-*_=|:\s]+$/, "thematic break, setext underline or table delimiter"],
];
function atx(line: string) {
  const h = /^(#{1,6})((?:[ \t].*)?)$/.exec(line);
  return h
    ? { level: h[1]?.length ?? 0, text: norm((h[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "")) }
    : undefined;
}

/**
 * Scan the section under the one column-0 ATX heading named `heading` with the strict line grammar.
 * Returns its units (list items and paragraphs), plus reference lines when `intent`; undefined when
 * the heading isn't unique. The whole section is scanned, so no later heading can hide a refusal.
 */
function scanSection(md: string, heading: string, where: string, intent = false) {
  // Trim only ASCII spaces and tabs, as GitHub does: a trailing NBSP keeps `##\u00a0` from being a heading.
  const lines = md.split(/\r\n?|\n/).map((line) => line.replace(/[ \t]+$/, ""));
  const hits = lines.flatMap((line, i) => (atx(line)?.text === norm(heading) ? [i] : []));
  if (hits.length !== 1) return undefined;
  const start = hits[0] ?? 0;
  // A heading inside an earlier fence can't be told apart from a real one.
  const fence = lines.slice(0, start).findIndex((line) => /^ {0,3}(?:`{3,}|~{3,})/.test(line));
  if (fence >= 0)
    throw new Error(`unresolvable source: line ${fence + 1} of ${where}: fence before the section`);
  const level = atx(lines[start] ?? "")?.level ?? 0;
  const out: { text: string; reference?: RegExpExecArray }[] = [];
  let previous: "item" | "para" | "other" = "other";
  let ancestors: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const refuse = (kind: string) => {
      throw new Error(
        `unsupported Markdown in the intent: line ${i + 1} of ${where}: ${kind}; normalize the ticket`,
      );
    };
    const h = atx(line);
    const item = listItem.exec(line);
    const indent = /^ +/.exec(line)?.[0].length ?? 0;
    const child = !intent && indent > 0 && indent % 2 === 0 ? listItem.exec(line.slice(indent)) : null;
    const reference = intent ? sectionReference.exec(line) : null;
    const last = out.at(-1);
    if (!line) previous = "other";
    else if (h && h.level <= level) break;
    else if (h) previous = "other";
    else {
      const refused = refusedLines.find(([form]) => form.test(child ? line.slice(indent) : line));
      if (refused) refuse(refused[1]);
      if (child) {
        if (previous !== "item" || indent / 2 > ancestors.length) refuse("orphan sub-item");
        ancestors.length = indent / 2;
        ancestors.push(child[1] ?? "");
        out.push({ text: ancestors.join(" — ") });
      }
      // In the ticket only references produce units, so a requirement written as a list item would vanish.
      else if (item && intent) refuse("list item; only section references produce units");
      // Only an ordered list starting at 1 can interrupt a paragraph; `2.` there is paragraph text.
      else if (item && previous === "para" && /^\d/.test(line) && !/^0*1[.)]/.test(line))
        refuse("numbered line inside a paragraph");
      else if (item) {
        ancestors = [item[1] ?? ""];
        out.push({ text: ancestors[0] ?? "" });
      } else if (/^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) refuse("malformed list item");
      else if (intent && /^From .*:$/.test(line)) refuse("quote lead-in");
      else if (reference) out.push({ text: line, reference });
      else if (previous === "item") refuse("list item continuation");
      else if (previous === "para" && last) last.text += ` ${line}`;
      else out.push({ text: line });
      previous = item || child ? "item" : reference ? "other" : "para";
    }
  }
  return out;
}

/** Resolve the ticket's section references into the parent's units, from trusted text only. */
export function resolveIntent({ ticket, parent }: AcceptanceSnapshot): AcceptanceUnit[] {
  const units: AcceptanceUnit[] = [];
  // Deduplicate on the text as written: normalizing whitespace would merge distinct code spans.
  const written = new Map<string, AcceptanceUnit>();
  for (const { reference } of scanSection(ticket.body, "The original intent", "the ticket", true) ?? []) {
    if (!reference) continue;
    const [, number, heading = "", docs] = reference;
    if (Number(number) !== parent.number)
      throw new Error(`unresolvable source: #${number} is not the parent`);
    const source = `#${number} "${heading}"`;
    const evidence = docs ? "docs" : "behaviour";
    const section = scanSection(parent.body, heading, `#${number}`);
    if (!section) throw new Error(`section "${heading}" does not name exactly one heading of #${number}`);
    for (const unit of section) {
      const found = written.get(unit.text);
      if (found) {
        if (!found.sources.includes(source)) found.sources.push(source);
        // Behaviour dominates, so referencing a section with (docs) first can't weaken its units.
        if (evidence === "behaviour") found.class = "behaviour";
        continue;
      }
      const added: AcceptanceUnit = {
        id: `U${units.length + 1}`,
        text: norm(unit.text),
        class: evidence,
        sources: [source],
      };
      units.push(added);
      written.set(unit.text, added);
    }
  }
  if (!units.length) throw new Error("the ticket's original intent resolves to no units");
  return units;
}

export async function prepareAcceptance(ctx: RunContext): Promise<void> {
  const acceptance = ctx.state.acceptance as AcceptanceState;
  await ctx.stage("prepare", async () => {
    const { paths } = ctx.deps.cfg;
    const cache = await ensureCache(paths, ctx.repo, ctx.signal);
    if (!acceptance.sha) {
      acceptance.sha = await fetchBase(paths, ctx.repo, ctx.repo.defaultBranch, ctx.signal);
      await ctx.save("acceptance-sha");
    }
    const path = join(paths.work, ctx.run.id);
    if (!existsSync(path)) await addDetachedWorktree(cache, acceptance.sha, path, ctx.signal);
    ctx.state.worktreePath = path;
    ctx.run = ctx.store.updateRun(ctx.run.id, {
      baseBranch: ctx.repo.defaultBranch,
      baseSha: acceptance.sha,
    });
    const toml = await readFileAt(path, acceptance.sha, ".limitless.toml");
    const warn = (message: string) => ctx.log(message, "warn");
    const gates = detectGates(path, warn);
    gates.retryFiles = readRetryFiles(toml, warn);
    gates.docs = readDocs(toml, warn);
    ctx.state.gatesConfig = gates;
    await ctx.save();
    if (!acceptance.setupDone && gates.setup.length) {
      const setup = await runLocalGates(path, { ...gates, checks: [] }, ctx.signal, { holder: ctx.run.id });
      ctx.checkCancelled();
      const failed = setup.setup.find((result) => !result.ok);
      if (!setup.setupOk)
        throw new Error(
          redactGateOutput(`Acceptance setup failed: $ ${failed?.command}\n${failed?.output ?? ""}`),
        );
    }
    acceptance.setupDone = true;
    await ctx.save("acceptance-setup");
    return { summary: `checking ${acceptance.sha}`, value: undefined };
  });
  await ctx.setPhase("accept");
}

export async function runAcceptance(ctx: RunContext): Promise<void> {
  const acceptance = ctx.state.acceptance as AcceptanceState;
  const sha = acceptance.sha ?? "";
  const cwd = ctx.state.worktreePath ?? "";
  const outcome = await ctx.stage("accept", async (stage) => {
    if (!acceptance.outcome) {
      if (!acceptance.manifest) {
        acceptance.manifest = resolveIntent(acceptance.snapshot);
        await ctx.save("acceptance-manifest");
      }
      if (!acceptance.output) {
        try {
          const { result } = await ctx.invoke({
            role: "verify",
            stage,
            mode: "readonly",
            complexity: ctx.complexity,
            cwd,
            prompt: acceptancePrompt(acceptance.manifest, acceptance.snapshot.ticket.body),
            jsonSchema: toStrictJsonSchema(AcceptanceSchema),
            schema: AcceptanceSchema,
            requireStructured: true,
          });
          acceptance.output = AcceptanceSchema.parse(result.structured);
        } catch (e) {
          const interrupted = [CancelledError, SimulatedTermination, InjectedFault].some(
            (c) => e instanceof c,
          );
          if (interrupted || ctx.signal.aborted || ctx.termination) throw e;
          throw new Error(`Acceptance reader failed: ${(e as Error).message}`);
        }
        await discardChanges(cwd);
        await ctx.save("acceptance-output");
      }
      acceptance.outcome = await assess(ctx, acceptance.manifest, acceptance.output, sha);
      await ctx.save("acceptance-outcome");
    }
    ctx.artifact("acceptance.json", "acceptance", JSON.stringify(acceptance.outcome, null, 2));
    saveReport(ctx, buildReportArtifacts(ctx, acceptance.outcome.passed));
    return { summary: acceptance.outcome.summary, value: acceptance.outcome };
  });
  if (!outcome.passed) throw new NeedsHumanError(`Acceptance: ${outcome.summary}`);
}

async function assess(
  ctx: RunContext,
  manifest: AcceptanceUnit[],
  output: Acceptance,
  sha: string,
): Promise<NonNullable<AcceptanceState["outcome"]>> {
  const cwd = ctx.state.worktreePath ?? "";
  const claims = manifest.map((unit) => ({ unit, items: output.items.filter((i) => i.unit === unit.id) }));
  const met = claims.flatMap(({ items }) => (items.length === 1 && items[0]?.verdict === "met" ? items : []));
  const requests = met.map((item) => item.tests);
  await runCoveringRequests(
    ctx,
    requests,
    sha,
    async () => {
      if ((await headSha(cwd)) !== sha)
        throw new Error("Commit changed during acceptance; tests cannot cover it");
    },
    acceptanceCoveringPolicy,
  );
  const selected = selectCoveringRequests(requests, acceptanceCoveringPolicy);
  const succeeded = succeededCoveringStages(ctx);
  const docs = (ctx.state.gatesConfig?.docs ?? []).map(globToRegex);
  const units: NonNullable<AcceptanceState["outcome"]>["units"] = [];
  for (const { unit, items } of claims) {
    const item = items[0];
    if (!item || items.length > 1) {
      const refusals = item ? ["duplicate assessments"] : [];
      units.push({ unit: unit.id, verdict: item ? "unmet" : "not_assessed", citations: [], refusals });
      continue;
    }
    const refusals: string[] = [];
    const citations: string[] = [];
    let rejected = false;
    let docFiles = 0;
    const index = met.indexOf(item);
    for (const test of index < 0 ? [] : item.tests) {
      const record = ctx.state.coveringTestRuns?.find(
        (r) => r.verifiedSha === sha && r.file === test.file && r.name === test.name,
      );
      const capped = selected[index]?.tests.includes(test) ? undefined : selected[index]?.reason;
      const refusal = capped ?? coveringTestRefusal(record, sha, succeeded);
      if (refusal || !record) {
        refusals.push(`${test.file} › ${test.name}: ${refusal}`);
        if (!capped && !coveringTestUnavailable(record)) rejected = true;
      } else citations.push(coveringCitation(record, sha));
    }
    const tests = citations.length;
    for (const { path, lines } of item.files) {
      let refusal = await citedFileRefusal(path, cwd, sha);
      const text = refusal ? "" : ((await readFileAt(cwd, sha, path.replace(/^\.\//, ""))) ?? "");
      const count = text.replace(/\n$/, "").split("\n").length;
      if (!refusal && lines && !(lines.start <= lines.end && lines.end <= count))
        refusal = "line range out of bounds";
      if (refusal) {
        refusals.push(`${path}: ${refusal}`);
        rejected = true;
      } else {
        citations.push(`${path}@${sha}${lines ? `:${lines.start}-${lines.end}` : ""}`);
        if (docs.some((glob) => glob.test(path.replace(/^\.\//, "")))) docFiles++;
      }
    }
    if (item.verdict === "met" && !refusals.length && !tests && !(unit.class === "docs" && docFiles))
      refusals.push(
        unit.class === "behaviour"
          ? "behaviour requirement needs a passing covering test"
          : "docs requirement needs a verified file matching [gates] docs",
      );
    const verdict =
      item.verdict === "met" && refusals.length
        ? rejected || !item.tests.length
          ? "unmet"
          : "not_assessed"
        : item.verdict;
    units.push({ unit: unit.id, verdict, citations, refusals, note: item.note });
  }
  const counts = ["met", "partly_met", "unmet", "regressed", "not_assessed", "manual"].map(
    (v) => [v, units.filter((u) => u.verdict === v).length] as const,
  );
  return {
    sha,
    units,
    passed: units.every((u) => u.verdict === "met"),
    summary: counts
      .filter(([, n]) => n)
      .map(([v, n]) => `${n} ${v.replace("_", " ")}`)
      .join(", "),
  };
}
