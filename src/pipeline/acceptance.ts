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
  citedFileRefusal,
  coveringTestRefusal,
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
type Block = {
  text: string;
  kind: "quote" | "item" | "para" | "cell" | "reference" | "lead";
  refusal?: string;
};
const leadIn = /^From (#\d+|[\w-]+(?:[./][\w-]+)+)\b.*:$/;
const unsupported = (construct: string) =>
  `unsupported Markdown in the intent: ${construct}; normalize the ticket`;
const escapedPipe = unsupported("escaped pipe in a table row");
const quoteLine = (line: string) => line.replace(/^(?: {0,3}>[ \t]?)+/, "");
const tableSeparator = (line = "") => /^ *\|? *:?-+:? *(?:\| *:?-+:? *)+\|? *$/.test(line);
const setext = (line: string) => /^ {0,3}(?:=+|-+)\s*$/.test(line);
function atx(line: string) {
  const h = /^ {0,3}(#{1,6})(?= |$)(.*)$/.exec(line);
  return h ? { level: h[1]?.length ?? 0, text: norm((h[2] ?? "").replace(/ +#+ *$/, "")) } : undefined;
}
function listItem(line: string) {
  const m = /^( *)(?:[-*+]|\d+[.)])([ \t]+)(.*)$/.exec(line);
  return m ? { text: m[3] ?? "", continuation: line.length - (m[3]?.length ?? 0) } : undefined;
}

/** Explicitly bounded rows or a delimiter-backed table; a prose/list pipe is just text. */
function tableRows(lines: (string | null | undefined)[]): Set<number> {
  const rows = new Set<number>();
  let previous = false;
  let inTable = false;
  lines.forEach((line, i) => {
    const body = quoteLine(line ?? "");
    const candidate = body.includes("|") && !listItem(body);
    if (!candidate) inTable = false;
    else if (tableSeparator(body)) {
      if (previous) rows.add(i - 1);
      rows.add(i);
      inTable = true;
    } else if (inTable || /^ *\|.*\| *$/.test(body)) rows.add(i);
    previous = candidate;
  });
  return rows;
}

/** One fence/comment scanner for heading discovery and quote sources. Keep physical line positions. */
function sourceLines(md: string) {
  let fence: string | undefined;
  let comment = false;
  let commentLine: number | undefined;
  let details = 0;
  const lines: (string | null | undefined)[] = [];
  md.split(/\r?\n/).forEach((line, i) => {
    lines.push(undefined);
    const body = quoteLine(line);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      const delimiter = marker?.[1] ?? "";
      if (delimiter[0] === fence[0] && delimiter.length >= fence.length && /^ *$/.test(marker?.[2] ?? ""))
        fence = undefined;
      return;
    }
    if (comment || body.includes("<!--")) {
      const target = commentLine ?? i;
      let visible = "";
      let offset = 0;
      while (offset < body.length) {
        const at = body.indexOf(comment ? "-->" : "<!--", offset);
        const end = at < 0 ? body.length : at + (comment ? 3 : 4);
        if (!comment) visible += body.slice(offset, at < 0 ? end : at);
        offset = end;
        if (at < 0) break;
        comment = !comment;
      }
      // Join across comment newlines so neither a word nor a list item is fragmented.
      lines[i] = null;
      lines[target] =
        target === i
          ? visible.trim()
            ? line.slice(0, line.length - body.length) + visible
            : null
          : (lines[target] ?? "") + visible;
      commentLine = comment ? target : undefined;
      return;
    }
    if (details || /^\s*<details\b/i.test(body)) {
      details += (body.match(/<details\b/gi)?.length ?? 0) - (body.match(/<\/details\s*>/gi)?.length ?? 0);
      return;
    }
    if (marker) {
      fence = marker[1];
      return;
    }
    lines[i] = /^\s*</.test(body) ? undefined : line;
  });
  return { lines, unclosed: !!fence || comment || details > 0 };
}

/** Validate raw lines before considering a later heading as a section boundary. */
function sectionEnd(lines: string[], start: number, level: number): number {
  const rows = tableRows(lines);
  const continuations: number[] = [];
  let paragraph = false;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const body = quoteLine(raw.replace(/\t/g, "    "));
    if (!body.trim()) {
      paragraph = false;
      continue;
    }
    const indent = /^ */.exec(body)?.[0].length ?? 0;
    while (continuations.length && indent < (continuations.at(-1) ?? 0)) continuations.pop();
    const item = listItem(body);
    const content = item?.text ?? body;
    const h = atx(raw);
    const reason = /^ *(`{3,}|~{3,})/.test(content)
      ? "fence"
      : /^ *</.test(content) || content.includes("<!--")
        ? "HTML block or comment"
        : paragraph && setext(body)
          ? "setext heading"
          : indent >= 4 && !continuations.length
            ? "indented code or heading"
            : rows.has(i) && body.includes("\\|")
              ? "escaped pipe in a table row"
              : undefined;
    if (reason) throw new Error(unsupported(reason));
    if (i > start && h && h.level <= level) return i;
    if (item) continuations.push(item.continuation);
    paragraph = !atx(content) && !rows.has(i);
  }
  return lines.length;
}

/** Whole units share list continuation and normalization rules in tickets and quote sources. */
export function markdownUnits(md: string, references = false): Block[] {
  const scanned = sourceLines(md);
  if (scanned.unclosed) throw new Error("unresolvable source: unclosed fence, comment or details");
  const rows = tableRows(scanned.lines);
  const out: Block[] = [];
  let current: Block | undefined;
  let continuation: number | undefined;
  let currentQuoted = false;
  const flush = () => {
    if (current && norm(current.text)) out.push({ ...current, text: norm(current.text) });
    current = undefined;
    continuation = undefined;
  };
  scanned.lines.forEach((line, i) => {
    if (line === null) return;
    if (line === undefined) {
      flush();
      return;
    }
    const quoted = /^ {0,3}>/.test(line);
    const body = quoteLine(line.replace(/\t/g, "    "));
    if (!body.trim()) {
      if (continuation === undefined) flush();
      return;
    }
    const indent = /^ */.exec(body)?.[0].length ?? 0;
    const item = listItem(body);
    if (!quoted && references && (sectionReference.test(body.trim()) || leadIn.test(body.trim()))) {
      flush();
      out.push({ text: body.trim(), kind: leadIn.test(body.trim()) ? "lead" : "reference" });
      return;
    }
    if (atx(quoteLine(line)) || setext(body)) {
      flush();
      return;
    }
    if (
      current &&
      continuation !== undefined &&
      quoted === currentQuoted &&
      indent >= continuation &&
      !item
    ) {
      current.text += ` ${body}`;
      return;
    }
    if (!item && rows.has(i)) {
      flush();
      if (body.includes("\\|")) out.push({ text: norm(body), kind: "cell", refusal: escapedPipe });
      else if (!tableSeparator(body) && !tableSeparator(scanned.lines[i + 1] ?? "")) {
        for (const cell of body
          .trim()
          .replace(/^\||\|\s*$/g, "")
          .split("|"))
          if (norm(cell)) out.push({ text: norm(cell), kind: "cell" });
      }
      return;
    }
    const kind = quoted ? "quote" : "para";
    if (item) {
      flush();
      current = { text: item.text, kind: quoted ? "quote" : "item" };
      continuation = item.continuation;
    } else if (current && continuation === undefined && current.kind === kind) current.text += ` ${body}`;
    else {
      flush();
      current = { text: body, kind };
    }
    currentQuoted = quoted;
  });
  flush();
  return out;
}

/** Match headings globally, then validate the selected range sequentially without exclusions. */
function section(md: string, heading: string): string | undefined {
  const scanned = sourceLines(md);
  const heads = scanned.lines.flatMap((line, i) => {
    const h = typeof line === "string" ? atx(line) : undefined;
    return h ? [{ ...h, i }] : [];
  });
  const hits = heads.filter((h) => h.text === norm(heading));
  const hit = hits[0];
  const raw = md.split(/\r?\n/);
  const end = hit ? sectionEnd(raw, hit.i, hit.level) : raw.length;
  if (scanned.unclosed) throw new Error("unresolvable source: unclosed fence, comment or details");
  const setextMatch = scanned.lines.some((line, i) => {
    const previous = scanned.lines[i - 1];
    return (
      typeof line === "string" &&
      setext(line) &&
      typeof previous === "string" &&
      norm(previous) === norm(heading)
    );
  });
  if (hits.length !== 1 || !hit || setextMatch) return undefined;
  return raw.slice(hit.i + 1, end).join("\n");
}

/** Resolve the ticket's intent into units from trusted text only; throws the refusal reason. */
export async function resolveIntent(
  { ticket, parent }: AcceptanceSnapshot,
  readPath: (path: string) => Promise<string>,
): Promise<AcceptanceUnit[]> {
  const units: AcceptanceUnit[] = [];
  const add = (text: string, docs: boolean, source: string) => {
    const found = units.find((u) => u.text === text);
    if (found && !found.sources.includes(source)) found.sources.push(source);
    if (!found)
      units.push({ id: `U${units.length + 1}`, text, class: docs ? "docs" : "behaviour", sources: [source] });
  };
  let lead = { source: `#${parent.number}`, docs: false };
  const sources = new Map<string, Promise<Block[]>>();
  const unitsOf = (source: string) => {
    if (!sources.has(source))
      sources.set(
        source,
        source === `#${parent.number}`
          ? Promise.resolve(markdownUnits(parent.body))
          : source.startsWith("#")
            ? Promise.reject(new Error(`unresolvable source: ${source} is not the parent`))
            : readPath(source).then(markdownUnits),
      );
    return sources.get(source) as Promise<Block[]>;
  };
  for (const block of markdownUnits(section(ticket.body, "The original intent") ?? "", true)) {
    const ref = block.kind === "reference" && sectionReference.exec(block.text);
    const from = block.kind === "lead" && leadIn.exec(block.text);
    if (ref) {
      if (Number(ref[1]) !== parent.number)
        throw new Error(`unresolvable source: #${ref[1]} is not the parent`);
      const body = section(parent.body, ref[2] ?? "");
      if (body === undefined)
        throw new Error(`section "${ref[2]}" does not name exactly one heading of #${ref[1]}`);
      for (const unit of markdownUnits(body)) add(unit.text, !!ref[3], `#${ref[1]} "${ref[2]}"`);
    } else if (from) lead = { source: from[1] ?? "", docs: block.text.endsWith("(docs):") };
    else if (block.kind === "quote" || block.kind === "item") {
      const sourceUnits = await unitsOf(lead.source);
      const match = sourceUnits.find((unit) => !unit.refusal && unit.text === block.text);
      if (!match) {
        // Refused rows cannot supply evidence, including a fragment created by splitting an escaped pipe.
        const refused = sourceUnits.find((unit) => unit.refusal && unit.text.includes(block.text));
        throw new Error(refused?.refusal ?? `quote is not a whole source unit: ${block.text.slice(0, 120)}`);
      }
      add(block.text, lead.docs, lead.source);
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
        acceptance.manifest = await resolveIntent(acceptance.snapshot, async (path) => {
          const refusal = await citedFileRefusal(path, cwd, sha);
          if (refusal) throw new Error(`unresolvable source: ${path}: ${refusal}`);
          return (await readFileAt(cwd, sha, path)) ?? "";
        });
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
  await runCoveringRequests(ctx, requests, sha, async () => {
    if ((await headSha(cwd)) !== sha)
      throw new Error("Commit changed during acceptance; tests cannot cover it");
  });
  const selected = selectCoveringRequests(requests);
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
    let docFiles = 0;
    const index = met.indexOf(item);
    for (const test of index < 0 ? [] : item.tests) {
      const record = ctx.state.coveringTestRuns?.find(
        (r) => r.verifiedSha === sha && r.file === test.file && r.name === test.name,
      );
      const capped = selected[index]?.tests.includes(test) ? undefined : selected[index]?.reason;
      const refusal = capped ?? coveringTestRefusal(record, sha, succeeded);
      if (refusal || !record) refusals.push(`${test.file} › ${test.name}: ${refusal}`);
      else citations.push(coveringCitation(record, sha));
    }
    const tests = citations.length;
    for (const { path, lines } of item.files) {
      let refusal = await citedFileRefusal(path, cwd, sha);
      const text = refusal ? "" : ((await readFileAt(cwd, sha, path.replace(/^\.\//, ""))) ?? "");
      const count = text.replace(/\n$/, "").split("\n").length;
      if (!refusal && lines && !(lines.start <= lines.end && lines.end <= count))
        refusal = "line range out of bounds";
      if (refusal) refusals.push(`${path}: ${refusal}`);
      else {
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
    const verdict = item.verdict === "met" && refusals.length ? "unmet" : item.verdict;
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
