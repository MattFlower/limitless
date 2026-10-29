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
type Block = { text: string; kind: "quote" | "item" | "para" | "cell" | "reference" };

/** Whole units: list items, paragraphs, blockquote paragraphs and table cells; no fences or <details>. */
export function markdownUnits(md: string, references = false): Block[] {
  const out: Block[] = [];
  let current: Block | undefined;
  let fence = "";
  let details = 0;
  const flush = () => {
    if (current && norm(current.text)) out.push({ ...current, text: norm(current.text) });
    current = undefined;
  };
  const lines = md
    .split("\n")
    .map((line) => ({ quoted: /^\s*>/.test(line), body: line.trim().replace(/^(?:>\s?)+/, "") }));
  const separator = (s = "") => /^[\s|:-]+$/.test(s) && s.includes("-") && s.includes("|");
  lines.forEach(({ quoted, body }, i) => {
    const marker = /^(`{3,}|~{3,})/.exec(body.trim())?.[1];
    if (fence || marker) {
      flush();
      if (!fence) fence = marker?.slice(0, 3) ?? "";
      else if (marker?.startsWith(fence)) fence = "";
      return;
    }
    if (details || /^<details\b/i.test(body)) {
      flush();
      details += (body.match(/<details\b/gi)?.length ?? 0) - (body.match(/<\/details>/gi)?.length ?? 0);
      return;
    }
    if (!body.trim() || /^#{1,6}\s/.test(body)) {
      flush();
      return;
    }
    if (!quoted && references && sectionReference.test(body)) {
      flush();
      out.push({ text: body, kind: "reference" });
      return;
    }
    if (body.startsWith("|")) {
      flush();
      if (separator(body) || separator(lines[i + 1]?.body)) return;
      for (const cell of body.replace(/^\||\|\s*$/g, "").split("|"))
        if (norm(cell)) out.push({ text: norm(cell), kind: "cell" });
      return;
    }
    const kind = quoted ? "quote" : "para";
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(body);
    if (item) {
      flush();
      current = { text: item[1] ?? "", kind: quoted ? "quote" : "item" };
    } else if (current && (current.kind === kind || (current.kind === "item" && !quoted)))
      current.text += ` ${body}`;
    else {
      flush();
      current = { text: body, kind };
    }
  });
  flush();
  return out;
}

/** The text under the one heading named `heading`, up to the next heading of the same or a higher level. */
function section(md: string, heading: string): string | undefined {
  const lines = md.split("\n");
  let fence = false;
  let details = 0;
  const heads: { i: number; level: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (!fence && (details || /^\s*<details\b/i.test(line))) {
      details += (line.match(/<details\b/gi)?.length ?? 0) - (line.match(/<\/details>/gi)?.length ?? 0);
      return;
    }
    if (/^\s*(`{3,}|~{3,})/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.*?)[\s#]*$/.exec(line);
    if (h) heads.push({ i, level: h[1]?.length ?? 0, text: norm(h[2] ?? "") });
  });
  const hits = heads.filter((h) => h.text === norm(heading));
  const hit = hits[0];
  if (hits.length !== 1 || !hit) return undefined;
  const end = heads.find((h) => h.i > hit.i && h.level <= hit.level)?.i ?? lines.length;
  return lines.slice(hit.i + 1, end).join("\n");
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
    const from = /^From (#\d+|[\w-]+(?:[./][\w-]+)+)\b.*:$/.exec(block.text);
    if (ref) {
      if (Number(ref[1]) !== parent.number)
        throw new Error(`unresolvable source: #${ref[1]} is not the parent`);
      const body = section(parent.body, ref[2] ?? "");
      if (body === undefined)
        throw new Error(`section "${ref[2]}" does not name exactly one heading of #${ref[1]}`);
      for (const unit of markdownUnits(body)) add(unit.text, !!ref[3], `#${ref[1]} "${ref[2]}"`);
    } else if (block.kind === "para" && from)
      lead = { source: from[1] ?? "", docs: block.text.endsWith("(docs):") };
    else if (block.kind === "quote" || block.kind === "item") {
      if (!(await unitsOf(lead.source)).some((unit) => unit.text === block.text))
        throw new Error(`quote is not a whole source unit: ${block.text.slice(0, 120)}`);
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
