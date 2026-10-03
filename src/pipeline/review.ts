import { z } from "zod";
import type { FinderPrompt, ReviewFinder, ReviewSystem } from "../core/types.ts";
import { type AgentResult, extractJson } from "../harness/types.ts";
import { parseTarget } from "../router/targets.ts";
import { NoCapacityError } from "./context.ts";
import { MERGE_RULES, mergeReports } from "./panel-merge.ts";
import { reviewPrompt, verifierPrompt } from "./prompts.ts";
import {
  AttributionVerifierSchema,
  LaterReviewSchema,
  type Review,
  ReviewSchema,
  type StoredReview,
  toStrictJsonSchema,
  type Verification,
  VerifierSchema,
} from "./schemas.ts";

type Finding = Review["findings"][number];

/** Categories a panel neither verifies nor blocks on, except security findings; they go to the follow-up ledger. */
const UNVERIFIED_CATEGORIES: readonly (Finding["category"] | undefined)[] = ["cleanup", "conventions"];
const FINDER_SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;
/** Finder candidates verified per review; prior blocking and security findings are exempt. */
export const PANEL_VERIFY_CAP = 20;
const PANEL_BATCH_SIZE = 5;
/** A recheck of a prior blocking finding that no finder repeated. */
const UNRAISED = { agreement: 0, finder: null, vendor: null, raisedBy: [] as number[] };
/**
 * Bumped when what a panel verifies or blocks changes in a way a stored output can't show, so eval
 * caches stop reusing outputs made under the old policy. 2: security candidates are always verified,
 * and missing rulings on security or prior blocking findings fail closed. 3: finder reports merge
 * before verification. 4: a local finder that fails is skipped instead of failing the panel.
 * 5: verifier exclusions use checkpoint identity across backends.
 */
const PANEL_POLICY_VERSION = 5;
/** A local finder's time limit, slot waits and fallbacks included: it must not hold up the panel. */
export const LOCAL_FINDER_TIMEOUT_MS = 15 * 60_000;

/** Thrown by `invoke` when a local finder gets no answer in time; the panel goes on without it. */
export class FinderSkipped extends Error {}

/**
 * CONFIRMED, or PLAUSIBLE at high or above. Agreement between finders is recorded but does not count:
 * whether it should is for the panel ablations to decide.
 */
function panelVerified(finding: Finding): boolean {
  const v = finding.verification;
  if (!v || v.verdict === "REFUTED") return false;
  return v.verdict === "CONFIRMED" || v.severity === "critical" || v.severity === "high";
}

export function reviewFindingKey(finding: Review["findings"][number]): string {
  // Lines and explanations can change while fixing the same issue.
  return JSON.stringify([finding.file, finding.title]);
}

/** The zero-based index an "unaddressed" finding cites among `count` prior blocking findings (P1 = P01). */
function citedPriorIndex(finding: Finding, count: number): number | undefined {
  if (finding.label !== "unaddressed") return undefined;
  const match = /^P(\d+)$/i.exec(finding.prior?.trim() ?? "");
  const index = match ? Number(match[1]) : 0;
  return index >= 1 && index <= count ? index - 1 : undefined;
}

/** Whether an "unaddressed" finding cites one of the previous blocking findings (P1, P2, ...). */
function citesPriorBlocking(finding: Review["findings"][number], priorBlocking: Review["findings"]): boolean {
  return citedPriorIndex(finding, priorBlocking.length) !== undefined;
}

/** Panel reviews per run: a run still blocked after the last one goes to a human. */
export const PANEL_REVIEWS = 3;
const VERIFIED_SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

/**
 * Which panel review decides what blocks: R1-R3 by number, or a conflict-resolution review, which is
 * outside that count and follows R2's rules.
 */
export type PanelReview = number | "resolution";

/** A security finding by the verifier's category or the finder's flag. */
function isSecurity(finding: Finding): boolean {
  return finding.security || finding.verification?.category === "security";
}

/** Verified by the panel rule, at `min` or above by the verifier's consequence severity. */
function verifiedAtLeast(finding: Finding, min: Verification["severity"]): boolean {
  const severity = finding.verification?.severity;
  return (
    !!severity && panelVerified(finding) && VERIFIED_SEVERITY_RANK[severity] >= VERIFIED_SEVERITY_RANK[min]
  );
}

/**
 * A security finding blocks in every review unless the verifier refutes it, whatever its severity or
 * category. Otherwise only verified findings block, never cleanup or conventions, and re-reviews
 * tighten what blocks:
 * R2 — a cited unaddressed prior blocking finding, a regression of medium or above, or a new high/critical;
 * R3 — a critical finding (cited prior, regression or new).
 * The panel always sends security findings and prior blocking findings to the verifier, so one without
 * a ruling was left out after a retry: it blocks (fail closed).
 */
function panelBlocks(
  finding: Finding,
  priorBlocking: Review["findings"] | undefined,
  panelReview: PanelReview,
  causalAttribution: boolean,
): boolean {
  const v = finding.verification;
  const cited = !!priorBlocking && citesPriorBlocking(finding, priorBlocking);
  if (!v) return isSecurity(finding) || cited;
  if (v.verdict === "REFUTED") return false;
  if (isSecurity(finding)) return true;
  if (UNVERIFIED_CATEGORIES.includes(v.category)) return false;
  if (!panelVerified(finding)) return false;
  if (
    causalAttribution &&
    !cited &&
    v.attribution &&
    ["preexisting_unchanged", "intended_change", "environment_failure"].includes(v.attribution)
  )
    return false;
  const round = panelReview === "resolution" ? 2 : panelReview;
  if (!priorBlocking || round <= 1) return true;
  if (round >= PANEL_REVIEWS) return verifiedAtLeast(finding, "critical");
  if (cited) return true;
  return verifiedAtLeast(finding, finding.label === "regression" ? "medium" : "high");
}

/**
 * Panel reviews block on the verifier's ruling: see `panelBlocks`. A panel re-review must say which
 * review it is (`panelReview`), a conflict-resolution review included.
 *
 * Single reviews, first round: blockers and majors block. Later rounds may not move the goalposts: a finding blocks
 * only if it is a regression from the latest changes, an unaddressed previous *blocking* finding
 * (cited by id, so rewording can't lose it and follow-ups can't be promoted), or a new blocker or
 * security issue. Everything else becomes a follow-up.
 */
export function blockingReviewFindings(
  review: StoredReview,
  priorBlocking?: Review["findings"],
  panelReview?: PanelReview,
  causalAttribution = false,
): Review["findings"] {
  const panel = review.mode === "panel";
  if (panel && priorBlocking && panelReview === undefined)
    throw new Error('A panel re-review needs its review number or "resolution" to decide what blocks');
  if (
    panel &&
    typeof panelReview === "number" &&
    !(Number.isInteger(panelReview) && panelReview >= 1 && panelReview <= PANEL_REVIEWS)
  )
    throw new Error(`A panel review number is 1-${PANEL_REVIEWS} or "resolution", not ${panelReview}`);
  return review.findings.filter((finding) => {
    if (panel) return panelBlocks(finding, priorBlocking, panelReview ?? 1, causalAttribution);
    if (!priorBlocking) return finding.severity === "blocker" || finding.severity === "major";
    if (finding.label === "regression") return true;
    if (citesPriorBlocking(finding, priorBlocking)) return true;
    return finding.severity === "blocker" || finding.security;
  });
}

/**
 * Blocking findings of earlier reviews that the following review did not cite as unaddressed. A panel
 * re-review rechecks every prior blocking finding (a finder repeats it or the verifier gets it as a
 * candidate), so an uncited one was refuted at head: known resolved, not to be raised again.
 */
export function resolvedPriorFindings(
  history: { blocking: Review["findings"]; followUps: Review["findings"] }[],
): Review["findings"] {
  return history.slice(0, -1).flatMap((entry, i) => {
    const next = history[i + 1];
    const cited = new Set(
      [...(next?.blocking ?? []), ...(next?.followUps ?? [])].map((f) =>
        citedPriorIndex(f, entry.blocking.length),
      ),
    );
    return entry.blocking.filter((_, k) => !cited.has(k));
  });
}

export function reviewVerdict(
  review: StoredReview,
  priorBlocking?: Review["findings"],
  panelReview?: PanelReview,
  causalAttribution = false,
): Review["verdict"] {
  return blockingReviewFindings(review, priorBlocking, panelReview, causalAttribution).length
    ? "request_changes"
    : "approve";
}

export interface ReviewInput {
  prompt: Parameters<typeof reviewPrompt>[0];
  timeoutMs: number;
  /** Follow-ups already recorded for this round and commit, when a review is replayed after a restart. */
  replayedFollowUps?: Review["findings"];
  /** Defaults to one finder (`single`). */
  system?: Pick<ReviewSystem, "mode" | "finders" | "causalAttribution">;
  /**
   * Panel only: which review this is (1–3, or "resolution"); decides what blocks and is required once
   * there is a previous review. `prompt.fixReview` scopes the diff.
   */
  panelReview?: PanelReview;
  /** Panel only: the implementer's model, so a finder that ran on it (a fresh session) is recorded. */
  implementerModel?: string;
}

/** What the invoker sends to the model; later rounds (with previous findings) use the labelled schema. */
export interface ReviewRequest {
  prompt: string;
  schema: typeof ReviewSchema | typeof LaterReviewSchema;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
}

export interface ReviewDecision {
  /** Verdict derived from the findings; the model's own is kept in modelVerdict for inspection only. */
  review: Review;
  modelVerdict: Review["verdict"];
  blocking: Review["findings"];
  followUps: Review["findings"];
}

export interface VerifierRequest {
  prompt: string;
  schema: typeof VerifierSchema | typeof AttributionVerifierSchema;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
}

/** What `review-N.json` records about a panel beyond the derived review. */
export interface PanelRecord {
  /** Each finder's prompt and the vendor it ran on, by finder index; why a local finder was skipped. */
  finders: {
    prompt: FinderPrompt;
    lens?: string;
    vendor: string | null;
    skipped?: string;
    /** Ran on the implementer's own model, in a fresh session. */
    implementerModel?: true;
  }[];
  /**
   * `finder` and `vendor` are the report that represents the candidate, `raisedBy` every finder that
   * reported it (the others are its `duplicates`). `finder` is null for a prior blocking finding no
   * finder repeated: the verifier rechecks it.
   */
  candidates: (Finding & { id: string; finder: number | null; vendor: string | null; raisedBy: number[] })[];
  verdicts: (Verification & { id: string })[];
  refuted: string[];
  /** Eligible for verification but over the per-review cap: unverified follow-ups. */
  capped: string[];
  /**
   * Sent to the verifier but left without a ruling after one retry: unverified follow-ups, except
   * security and prior blocking findings, which block.
   */
  omitted: string[];
  /** Where independence was compromised, e.g. a verifier sharing a vendor with a finder it checks. */
  warnings?: string[];
}

type Invoked = { result: AgentResult; target?: { vendor: string; modelId?: string } };

export interface ReviewDeps<T extends Invoked> {
  /** Runs finder `finder` (an index into the system's finders); a local one may throw FinderSkipped. */
  invoke: (request: ReviewRequest, finder: number) => Promise<T>;
  /**
   * Panel only: one read-only verifier batch, routed away from every vendor that raised it and never
   * to a model that did.
   */
  verify?: (
    request: VerifierRequest,
    avoidVendors: string[],
    avoidModels: string[],
    candidates: string[],
  ) => Promise<T>;
  /** Panel only: problems that degrade the review without failing it. */
  warn?: (message: string) => void;
  /** Any finder, not just a local one, may throw FinderSkipped (a shadow panel without a free slot). */
  skipAny?: boolean;
  finished?: Record<string, unknown>[];
}

/**
 * A batch's verifier from ordered `targets`: the first whose vendor and model raised none of it, else
 * the first whose model raised none (the panel records the shared vendor). Shared by engine and evals.
 */
export function pickVerifier<V extends { vendor: string; modelId: string }>(
  targets: V[],
  avoidVendors: string[],
  avoidModels: string[],
  identity: (id: string) => string = (id) => parseTarget(id).modelId,
): V {
  const raised = new Set(avoidModels.map(identity));
  const picked =
    targets.find((t) => !avoidVendors.includes(t.vendor) && !raised.has(identity(t.modelId))) ??
    targets.find((t) => !raised.has(identity(t.modelId)));
  if (!picked)
    throw new NoCapacityError(
      `verifier ${targets.map((t) => t.modelId).join(", ")} raised a candidate it would check`,
    );
  return picked;
}

/** A verifier's lone `target` or ordered `targets`, each mapped by `f` (resolved or stored for replay). */
export function mapVerifier(verifier: NonNullable<ReviewSystem["verifier"]>, f: (target: string) => string) {
  return verifier.targets ? { targets: verifier.targets.map(f) } : { target: f(verifier.target ?? "") };
}

/** Fixed inputs that render the finder and verifier prompt templates, for cache identity. */
const FINDER_TEMPLATE: Parameters<typeof reviewPrompt>[0] = {
  prompt: "",
  spec: null,
  baseSha: "BASE",
  stat: "",
  gates: [],
  audit: [],
  implementerReport: "",
};
const TEMPLATE_INPUT: Parameters<typeof verifierPrompt>[0] = {
  prompt: "",
  spec: null,
  baseSha: "BASE",
  headSha: "HEAD",
  stat: "",
  candidates: [],
};

/**
 * What a panel's derived output depends on besides the case: the policy version, the finder and
 * verifier prompt templates, the verifier schema, and the merge and batching policy. Eval caches key
 * panel trials on it.
 */
export function panelIdentity(causalAttribution = false): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        PANEL_POLICY_VERSION,
        (["standard", "adversarial", "careful"] as const).map((finder) =>
          reviewPrompt({ ...FINDER_TEMPLATE, finder }),
        ),
        reviewPrompt({ ...FINDER_TEMPLATE, finder: "standard", lens: { name: "LENS", focus: "FOCUS" } }),
        LOCAL_FINDER_TIMEOUT_MS,
        MERGE_RULES,
        verifierPrompt({ ...TEMPLATE_INPUT, causalAttribution }),
        verifierPrompt({ ...TEMPLATE_INPUT, externalChange: true, causalAttribution }),
        toStrictJsonSchema(causalAttribution ? AttributionVerifierSchema : VerifierSchema),
        PANEL_VERIFY_CAP,
        PANEL_BATCH_SIZE,
      ]),
    )
    .digest("hex");
}

export type ReviewOutcome<T> = T & {
  output: z.ZodSafeParseResult<Review>;
  decision?: ReviewDecision;
  panel?: PanelRecord;
};

export function reviewRequest(input: ReviewInput): ReviewRequest {
  const schema = input.prompt.previous ? LaterReviewSchema : ReviewSchema;
  const jsonSchema = toStrictJsonSchema(schema);
  return { prompt: reviewPrompt(input.prompt), schema, jsonSchema, timeoutMs: input.timeoutMs };
}

/**
 * One review round: prompt, invocation, parsing and the derived decision. `decision` is absent when the
 * output does not parse; callers keep their own error handling.
 */
export async function runReview<T extends Invoked>(
  deps: ReviewDeps<T>,
  input: ReviewInput,
): Promise<ReviewOutcome<T>> {
  if (input.system?.mode === "panel") return runPanel(deps, input, input.system.finders);
  const request = reviewRequest(input);
  const invoked = await deps.invoke(request, 0);
  const output = request.schema.safeParse(invoked.result.structured ?? extractJson(invoked.result.finalText));
  if (!output.success) return { ...invoked, output };
  return { ...invoked, output, decision: decide(input, output.data, output.data.verdict) };
}

function decide(input: ReviewInput, found: Review, modelVerdict: Review["verdict"]): ReviewDecision {
  const prior = input.prompt.previous?.findings;
  const review: Review = {
    ...found,
    verdict: reviewVerdict(found, prior, input.panelReview, input.system?.causalAttribution),
  };
  const blocking = blockingReviewFindings(review, prior, input.panelReview, input.system?.causalAttribution);
  // A panel's first round also has a ledger: whatever it does not block.
  const followUps =
    prior || review.mode === "panel"
      ? [
          ...new Map(
            [...(input.replayedFollowUps ?? []), ...review.findings.filter((f) => !blocking.includes(f))].map(
              (f) => [reviewFindingKey(f), f] as const,
            ),
          ).values(),
        ]
      : [];
  return { review, modelVerdict, blocking, followUps };
}

/** Sums spend across a panel's invocations; the eval runner records the panel as one result. */
export function combined(results: AgentResult[], last: AgentResult, structured: unknown): AgentResult {
  const sum = (pick: (r: AgentResult) => number) => results.reduce((total, r) => total + pick(r), 0);
  return {
    ...last,
    structured,
    numTurns: sum((r) => r.numTurns),
    costUsd: sum((r) => r.costUsd),
    costEquivUsd: sum((r) => r.costEquivUsd),
    usage: {
      input: sum((r) => r.usage.input),
      output: sum((r) => r.usage.output),
      cacheRead: sum((r) => r.usage.cacheRead),
      cacheWrite: sum((r) => r.usage.cacheWrite),
    },
  };
}

/**
 * A failed panel: an error result with the spend so far and no text, so no caller can re-parse one
 * member's raw output as the panel's review.
 */
function failedPanel(results: AgentResult[], last: AgentResult, message: string): AgentResult {
  return {
    ...combined(results, last, null),
    status: last.status === "ok" ? "error" : last.status,
    finalText: "",
    error: last.status === "ok" ? message : (last.error ?? message),
  };
}

async function runPanel<T extends Invoked>(
  deps: ReviewDeps<T>,
  input: ReviewInput,
  finders: ReviewFinder[],
): Promise<ReviewOutcome<T>> {
  const verifierSchema = input.system?.causalAttribution ? AttributionVerifierSchema : VerifierSchema;
  // Finders run in parallel, each within its provider's limits. Every call settles before the panel
  // goes on or fails, so none outlives it and each one's spend is recorded.
  const settled = await Promise.allSettled(
    finders.map(async ({ prompt, lens, local }, finder) => {
      const request = reviewRequest({
        ...input,
        timeoutMs: local ? Math.min(input.timeoutMs, LOCAL_FINDER_TIMEOUT_MS) : input.timeoutMs,
        prompt: { ...input.prompt, finder: prompt, ...(lens ? { lens } : {}) },
      });
      const invoked = await deps.invoke(request, finder).catch((error: unknown) => {
        if (error instanceof FinderSkipped && (local || deps.skipAny))
          deps.finished?.push({ finder, skipped: error.message.slice(0, 300) });
        throw error;
      });
      deps.finished?.push({ finder, status: invoked.result.status, review: invoked.result.structured });
      const output = request.schema.safeParse(
        invoked.result.structured ?? extractJson(invoked.result.finalText),
      );
      return { invoked, output };
    }),
  );
  const skippable = (member: (typeof settled)[number], finder: number) =>
    member.status === "rejected" &&
    member.reason instanceof FinderSkipped &&
    !!(finders[finder]?.local || deps.skipAny);
  for (const [finder, member] of settled.entries())
    if (member.status === "rejected" && !skippable(member, finder)) throw member.reason;
  const results: AgentResult[] = settled.flatMap((m) =>
    m.status === "fulfilled" ? [m.value.invoked.result] : [],
  );
  // By finder index; a skipped local finder leaves a gap.
  const found: ({ invoked: T; review: Review } | undefined)[] = [];
  const skipped = new Map<number, string>();
  for (const [finder, member] of settled.entries()) {
    const value = member.status === "fulfilled" ? member.value : undefined;
    if (value?.output.success) {
      found[finder] = { invoked: value.invoked, review: value.output.data };
      continue;
    }
    found[finder] = undefined;
    const result = value?.invoked.result;
    if (finders[finder]?.local || skippable(member, finder)) {
      const problem =
        member.status === "rejected"
          ? String((member.reason as Error).message)
          : result && result.status !== "ok"
            ? `${result.status}: ${result.error ?? "no output"}`
            : "invalid review output";
      skipped.set(finder, problem.slice(0, 300));
      deps.warn?.(`Local finder ${finder} skipped: ${problem}`);
      continue;
    }
    if (!value) throw new Error(`Finder ${finder} settled without a result`);
    return {
      ...value.invoked,
      result: failedPanel(
        results,
        value.invoked.result,
        `Invalid review output from finder ${finder}: ${value.output.error?.message}`,
      ),
      output: value.output,
    };
  }
  const first = found.find((member) => member !== undefined);
  if (!first) throw new Error(`mode "panel" needs a finder that is not skipped: ${[...skipped.values()]}`);

  const { fixReview, previous } = input.prompt;
  const priorBlocking = previous?.findings ?? [];
  const cited = (c: Finding) => citedPriorIndex(c, priorBlocking.length);
  // A citation of a prior blocking finding takes that finding's category (the verifier's, else the
  // finder's), so retagging it can't drop it from verification. A citation or recheck of a prior
  // security finding (either definition) stays one: no later ruling's category releases it unrefuted.
  const raised = found.flatMap((member, finder) =>
    (member?.review.findings ?? []).map((f) => {
      const prior = priorBlocking[cited(f) ?? -1];
      const category = prior ? (prior.verification?.category ?? prior.category ?? f.category) : f.category;
      return {
        ...f,
        ...(category ? { category } : {}),
        security: f.security || (!!prior && isSecurity(prior)),
        finder,
        vendor: member?.invoked.target?.vendor ?? null,
      };
    }),
  );
  const merged = mergeReports(raised, cited);
  const fix = fixReview && previous ? { review: fixReview, ...previous } : undefined;
  // A re-review never assumes a prior blocking finding fixed: whatever no finder repeated, the
  // verifier rechecks as a candidate of its own, outside the cap.
  const rechecks = (fix?.findings ?? []).flatMap((prior, i) => {
    if (raised.some((c) => cited(c) === i)) return [];
    const { verification: _stale, ...f } = prior;
    const recheck = { ...f, security: isSecurity(prior), label: "unaddressed" as const, prior: `P${i + 1}` };
    return [{ ...recheck, ...UNRAISED }];
  });
  const candidates: PanelRecord["candidates"] = [...merged, ...rechecks].map((c, i) => ({
    ...c,
    id: `C${i + 1}`,
  }));
  // Prior blocking findings (a citation replaces the automatic recheck) and security findings are
  // always verified, whatever their category.
  const exempt = (c: PanelRecord["candidates"][number]) =>
    c.finder === null || cited(c) !== undefined || c.security;
  // Stable sort: equal severities keep finder order.
  const ranked = candidates
    .filter((c) => !exempt(c) && !UNVERIFIED_CATEGORIES.includes(c.category))
    .sort((a, b) => FINDER_SEVERITY_RANK[a.severity] - FINDER_SEVERITY_RANK[b.severity]);
  const selected = [...ranked.slice(0, PANEL_VERIFY_CAP), ...candidates.filter(exempt)];
  // One batch never mixes files or the vendors that raised them, so each call avoids exactly those.
  const vendorsOf = (c: PanelRecord["candidates"][number]) =>
    [...new Set(c.raisedBy.flatMap((i) => found[i]?.invoked.target?.vendor ?? []))].sort();
  const modelsOf = (list: PanelRecord["candidates"]) => [
    ...new Set(list.flatMap((c) => c.raisedBy.flatMap((i) => found[i]?.invoked.target?.modelId ?? []))),
  ];
  const batchesOf = (list: typeof candidates) => {
    const groups = new Map<string, typeof candidates>();
    for (const c of list) {
      const key = JSON.stringify([vendorsOf(c), c.file]);
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    return [...groups.values()].flatMap((group) =>
      Array.from({ length: Math.ceil(group.length / PANEL_BATCH_SIZE) }, (_, i) =>
        group.slice(i * PANEL_BATCH_SIZE, (i + 1) * PANEL_BATCH_SIZE),
      ),
    );
  };
  const batches = batchesOf(candidates.filter((c) => selected.includes(c)));
  const firstPass = batches.length;
  // A re-review's verifier checks the same fix diff, and whether each prior finding is really resolved.
  const verdicts = new Map<string, PanelRecord["verdicts"][number]>();
  // Statuses name only candidates not yet refuted, so a second pass points at its own candidates.
  const verifierFixNow = () =>
    fix
      ? {
          review: fix.review,
          sha: fix.sha,
          prior: fix.findings.map(({ file, line, title }, i) => {
            const [repeated, recheck] = [true, false].map((byFinder) =>
              candidates
                .filter(
                  (c) =>
                    (c.finder !== null) === byFinder &&
                    cited(c) === i &&
                    verdicts.get(c.id)?.verdict !== "REFUTED",
                )
                .map((c) => c.id)
                .join(", "),
            );
            return {
              id: `P${i + 1}`,
              file,
              line,
              title,
              status: repeated
                ? `reported unaddressed by ${repeated}`
                : recheck
                  ? `not repeated by any finder; recheck it as ${recheck}`
                  : "refuted at this review",
            };
          }),
          resolved: (fix.resolved ?? []).map(({ file, line, title }) => ({
            file,
            line,
            title,
            status: "resolved at an earlier review",
          })),
        }
      : undefined;
  let verifierFix = verifierFixNow();
  const omitted: string[] = [];
  const warnings: string[] = [];
  let last = first.invoked.result;
  // A skipped (shadow) verifier leaves its batch unverified: the panel goes on with what it has.
  const verify = (...args: Parameters<NonNullable<typeof deps.verify>>) =>
    deps.verify?.(...args).catch((error: unknown) => {
      if (!(deps.skipAny && error instanceof FinderSkipped)) throw error;
      deps.finished?.push({ verifier: args[3], skipped: error.message });
    });
  for (const [index, batch] of batches.entries()) {
    if (!deps.verify) throw new Error('mode "panel" needs a verifier');
    // Candidates the verifier leaves out get one more call, then stay unverified follow-ups.
    let pending = batch;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const invoked = await verify(
        {
          prompt: verifierPrompt({
            causalAttribution: input.system?.causalAttribution,
            prompt: input.prompt.prompt,
            spec: input.prompt.spec,
            baseSha: input.prompt.baseSha,
            headSha: input.prompt.headSha,
            externalChange: input.prompt.externalChange,
            stat: input.prompt.stat,
            candidates: pending.map(({ id, file, line, title, failure_scenario, label, prior }) => ({
              id,
              file,
              line,
              title,
              failure_scenario: failure_scenario ?? "",
              ...(verifierFix ? { label: label ?? "new", prior: prior ?? "" } : {}),
            })),
            ...(verifierFix ? { fix: verifierFix } : {}),
          }),
          schema: verifierSchema,
          jsonSchema: toStrictJsonSchema(verifierSchema),
          timeoutMs: input.timeoutMs,
        },
        pending[0] ? vendorsOf(pending[0]) : [],
        modelsOf(pending),
        pending.map((c) => c.id),
      );
      if (!invoked) break;
      deps.finished?.push({
        verifier: pending.map((c) => c.id),
        status: invoked.result.status,
        result: invoked.result.structured,
      });
      const shared = invoked.target?.vendor;
      if (shared && pending[0] && vendorsOf(pending[0]).includes(shared)) {
        const warning = `Verifier ${invoked.target?.modelId ?? "?"} shares vendor ${shared} with a finder it checks (${pending.map((c) => c.id).join(", ")}); no other vendor was available`;
        warnings.push(warning);
        deps.warn?.(warning);
      }
      results.push(invoked.result);
      last = invoked.result;
      const parsed = verifierSchema.safeParse(
        invoked.result.structured ?? extractJson(invoked.result.finalText),
      );
      if (invoked.result.status !== "ok" || !parsed.success) {
        const message =
          invoked.result.status !== "ok"
            ? `Verifier ${invoked.result.status}: ${invoked.result.error ?? "no output"}`
            : `Invalid verifier output: ${parsed.error?.message}`;
        return {
          ...first.invoked,
          result: failedPanel(results, invoked.result, message),
          output: z.custom<Review>(() => false, message).safeParse(null),
        };
      }
      // Only the first ruling per submitted id counts; ids from outside this call are ignored.
      for (const result of parsed.data.results)
        if (pending.some((c) => c.id === result.id) && !verdicts.has(result.id))
          verdicts.set(result.id, result);
      pending = pending.filter((c) => !verdicts.has(c.id));
    }
    if (pending.length) {
      omitted.push(...pending.map((c) => c.id));
      deps.warn?.(
        `Verifier gave no ruling for ${pending.map((c) => c.id).join(", ")} after a retry; security and prior blocking findings among them block, the rest stay unverified follow-ups`,
      );
    }
    // After the first pass, a refuted report doesn't settle the reports merged into it that differ in
    // line or title: each is then verified as a candidate of its own, outside the cap.
    if (index === firstPass - 1) {
      const split = candidates.flatMap(({ duplicates, ...c }) =>
        verdicts.get(c.id)?.verdict === "REFUTED"
          ? (duplicates ?? [])
              .filter((d) => d.line !== c.line || d.title !== c.title)
              .map((d) => ({
                ...c,
                ...d,
                severity: d.severity ?? c.severity,
                failure_scenario: d.failure_scenario ?? "",
                agreement: 1,
                vendor: found[d.finder]?.invoked.target?.vendor ?? null,
                raisedBy: [d.finder],
              }))
          : [],
      );
      const own = split.map((c, i) => ({ ...c, id: `C${candidates.length + i + 1}` }));
      candidates.push(...own);
      verifierFix = verifierFixNow();
      batches.push(...batchesOf(own));
    }
  }

  // Refuted candidates are dropped here, by id; a same-titled candidate keeps its own ruling.
  const findings: Finding[] = [];
  for (const { id, finder: _finder, vendor: _vendor, raisedBy: _raisedBy, ...finding } of candidates) {
    const verdict = verdicts.get(id);
    if (!verdict) findings.push(finding);
    else if (verdict.verdict !== "REFUTED") {
      const { id: _id, ...verification } = verdict;
      findings.push({ ...finding, verification });
    }
  }
  const review: Review = {
    mode: "panel",
    verdict: "approve",
    // The tally also keeps a fully refuted panel from reading as a placeholder review.
    summary: [
      ...found.flatMap((member) => (member ? [member.review.summary] : [])),
      `Verifier: ${candidates.length} candidates, ${verdicts.size} checked, ${[...verdicts.values()].filter((v) => v.verdict === "REFUTED").length} refuted.`,
    ].join("\n\n"),
    findings,
  };
  const modelVerdict = found.some((member) => member?.review.verdict === "request_changes")
    ? "request_changes"
    : "approve";
  const decision = decide(input, review, modelVerdict);
  const panel: PanelRecord = {
    finders: finders.map(({ prompt, lens }, i) => ({
      prompt,
      ...(lens ? { lens: lens.name } : {}),
      vendor: found[i]?.invoked.target?.vendor ?? null,
      ...(skipped.has(i) ? { skipped: skipped.get(i) } : {}),
      ...(input.implementerModel && found[i]?.invoked.target?.modelId === input.implementerModel
        ? { implementerModel: true as const }
        : {}),
    })),
    candidates,
    verdicts: [...verdicts.values()],
    refuted: [...verdicts.values()].filter((v) => v.verdict === "REFUTED").map((v) => v.id),
    capped: ranked.filter((c) => !selected.includes(c)).map((c) => c.id),
    omitted,
    ...(warnings.length ? { warnings } : {}),
  };
  return {
    ...first.invoked,
    // Evals store the structured result as the trial output; the record lets refuted candidates be regraded.
    result: combined(results, last, { ...decision.review, panel }),
    output: { success: true, data: decision.review },
    decision,
    panel,
  };
}
