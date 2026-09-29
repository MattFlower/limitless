import { z } from "zod";
import type { ReviewSystem } from "../core/types.ts";
import { type AgentResult, extractJson } from "../harness/types.ts";
import { reviewPrompt, verifierPrompt } from "./prompts.ts";
import {
  LaterReviewSchema,
  type Review,
  ReviewSchema,
  type StoredReview,
  toStrictJsonSchema,
  type Verification,
  VerifierSchema,
} from "./schemas.ts";

type Finding = Review["findings"][number];

/** Categories a panel never verifies or blocks on; they go straight to the follow-up ledger. */
const UNVERIFIED_CATEGORIES: readonly (Finding["category"] | undefined)[] = ["cleanup", "conventions"];
const FINDER_SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;
/** Candidates verified per review; the rest stay unverified follow-ups. */
export const PANEL_VERIFY_CAP = 20;
const PANEL_BATCH_SIZE = 5;

/**
 * CONFIRMED, or PLAUSIBLE at high or above. PLAUSIBLE raised by two or more finders will also count
 * once panel agreement exists; until then every candidate has exactly one finder.
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

/** Whether an "unaddressed" finding cites one of the previous blocking findings (P1, P2, ...). */
function citesPriorBlocking(finding: Review["findings"][number], priorBlocking: Review["findings"]): boolean {
  const match = /^P(\d+)$/i.exec(finding.prior?.trim() ?? "");
  const index = match ? Number(match[1]) : 0;
  return index >= 1 && index <= priorBlocking.length;
}

/** Panel reviews per run: a run still blocked after the last one goes to a human. */
export const PANEL_REVIEWS = 3;
const VERIFIED_SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

/** Verified by the panel rule, at `min` or above by the verifier's consequence severity. */
function verifiedAtLeast(finding: Finding, min: Verification["severity"]): boolean {
  const severity = finding.verification?.severity;
  return (
    !!severity && panelVerified(finding) && VERIFIED_SEVERITY_RANK[severity] >= VERIFIED_SEVERITY_RANK[min]
  );
}

/**
 * Panel re-reviews (R2, R3) tighten what blocks, and only verified findings ever block:
 * R2 — a cited unaddressed prior blocking finding, a regression of medium or above, or a new high/critical;
 * R3 — a critical finding (cited prior, regression or new) or a security finding.
 */
function panelRereviewBlocks(
  finding: Finding,
  priorBlocking: Review["findings"],
  panelReview: number,
): boolean {
  if (!panelVerified(finding)) return false;
  if (panelReview >= PANEL_REVIEWS)
    return verifiedAtLeast(finding, "critical") || finding.verification?.category === "security";
  if (finding.label === "unaddressed" && citesPriorBlocking(finding, priorBlocking)) return true;
  return verifiedAtLeast(finding, finding.label === "regression" ? "medium" : "high");
}

/**
 * Panel reviews block on the verifier's ruling and never on cleanup or conventions (the verifier's
 * category, else the finder's): in R1 every verified finding; R2 and R3 (`panelReview`, default 2)
 * follow `panelRereviewBlocks`.
 *
 * Single reviews, first round: blockers and majors block. Later rounds may not move the goalposts: a finding blocks
 * only if it is a regression from the latest changes, an unaddressed previous *blocking* finding
 * (cited by id, so rewording can't lose it and follow-ups can't be promoted), or a new blocker or
 * security issue. Everything else becomes a follow-up.
 */
export function blockingReviewFindings(
  review: StoredReview,
  priorBlocking?: Review["findings"],
  panelReview = 2,
): Review["findings"] {
  const panel = review.mode === "panel";
  return review.findings.filter((finding) => {
    if (panel) {
      if (finding.verification?.verdict === "REFUTED") return false;
      if (UNVERIFIED_CATEGORIES.includes(finding.verification?.category ?? finding.category)) return false;
      if (!priorBlocking || panelReview <= 1) return panelVerified(finding);
      return panelRereviewBlocks(finding, priorBlocking, panelReview);
    }
    if (!priorBlocking) return finding.severity === "blocker" || finding.severity === "major";
    if (finding.label === "regression") return true;
    if (finding.label === "unaddressed" && citesPriorBlocking(finding, priorBlocking)) return true;
    return finding.severity === "blocker" || finding.security;
  });
}

/**
 * Blocking findings of earlier reviews that the following review did not cite as unaddressed: known
 * resolved, so a re-review is told not to raise them again.
 */
export function resolvedPriorFindings(
  history: { blocking: Review["findings"]; followUps: Review["findings"] }[],
): Review["findings"] {
  return history.slice(0, -1).flatMap((entry, i) => {
    const next = history[i + 1];
    const cited = new Set(
      [...(next?.blocking ?? []), ...(next?.followUps ?? [])]
        .filter((f) => f.label === "unaddressed")
        .map((f) => f.prior?.trim().toUpperCase()),
    );
    return entry.blocking.filter((_, k) => !cited.has(`P${k + 1}`));
  });
}

export function reviewVerdict(
  review: StoredReview,
  priorBlocking?: Review["findings"],
  panelReview?: number,
): Review["verdict"] {
  return blockingReviewFindings(review, priorBlocking, panelReview).length ? "request_changes" : "approve";
}

export interface ReviewInput {
  prompt: Parameters<typeof reviewPrompt>[0];
  timeoutMs: number;
  /** Follow-ups already recorded for this round and commit, when a review is replayed after a restart. */
  replayedFollowUps?: Review["findings"];
  /** Defaults to one finder (`single`). */
  system?: Pick<ReviewSystem, "mode" | "finders">;
  /** Panel only: which review this is (1–3); decides what blocks. `prompt.fixReview` scopes the diff. */
  panelReview?: number;
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
  schema: typeof VerifierSchema;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
}

/** What `review-N.json` records about a panel beyond the derived review. */
export interface PanelRecord {
  candidates: (Finding & { id: string; finder: number; vendor: string | null })[];
  verdicts: (Verification & { id: string })[];
  refuted: string[];
  /** Eligible for verification but over the per-review cap: unverified follow-ups. */
  capped: string[];
  /** Sent to the verifier but left without a ruling after one retry: unverified follow-ups. */
  omitted: string[];
}

type Invoked = { result: AgentResult; target?: { vendor: string } };

export interface ReviewDeps<T extends Invoked> {
  /** Runs finder `finder` (an index into the system's finders). */
  invoke: (request: ReviewRequest, finder: number) => Promise<T>;
  /** Panel only: one read-only verifier batch, routed away from the vendor that raised it. */
  verify?: (request: VerifierRequest, avoidVendor: string | undefined) => Promise<T>;
  /** Panel only: problems that degrade the review without failing it. */
  warn?: (message: string) => void;
}

/** Fixed input that renders the verifier prompt template, for cache identity. */
const TEMPLATE_INPUT: Parameters<typeof verifierPrompt>[0] = {
  prompt: "",
  spec: null,
  baseSha: "BASE",
  headSha: "HEAD",
  stat: "",
  candidates: [],
};

/**
 * What a panel's derived output depends on besides its finders' prompt: the verifier prompt templates,
 * its schema and the batching policy. Eval caches key panel trials on it.
 */
export function panelVerifierIdentity(): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        verifierPrompt(TEMPLATE_INPUT),
        verifierPrompt({ ...TEMPLATE_INPUT, externalChange: true }),
        toStrictJsonSchema(VerifierSchema),
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
  if (input.system?.mode === "panel") return runPanel(deps, input, input.system.finders.length);
  const request = reviewRequest(input);
  const invoked = await deps.invoke(request, 0);
  const output = request.schema.safeParse(invoked.result.structured ?? extractJson(invoked.result.finalText));
  if (!output.success) return { ...invoked, output };
  return { ...invoked, output, decision: decide(input, output.data, output.data.verdict) };
}

function decide(input: ReviewInput, found: Review, modelVerdict: Review["verdict"]): ReviewDecision {
  const prior = input.prompt.previous?.findings;
  const review: Review = { ...found, verdict: reviewVerdict(found, prior, input.panelReview) };
  const blocking = blockingReviewFindings(review, prior, input.panelReview);
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
  finders: number,
): Promise<ReviewOutcome<T>> {
  const request = reviewRequest(input);
  const results: AgentResult[] = [];
  const found: { invoked: T; review: Review }[] = [];
  for (let finder = 0; finder < finders; finder++) {
    const invoked = await deps.invoke(request, finder);
    results.push(invoked.result);
    const output = request.schema.safeParse(
      invoked.result.structured ?? extractJson(invoked.result.finalText),
    );
    if (!output.success)
      return {
        ...invoked,
        result: failedPanel(
          results,
          invoked.result,
          `Invalid review output from finder ${finder}: ${output.error.message}`,
        ),
        output,
      };
    found.push({ invoked, review: output.data });
  }
  const first = found[0];
  if (!first) throw new Error('mode "panel" needs at least one finder');

  const candidates: PanelRecord["candidates"] = found
    .flatMap(({ invoked, review }, finder) =>
      review.findings.map((f) => ({ ...f, finder, vendor: invoked.target?.vendor ?? null })),
    )
    .map((c, i) => ({ ...c, id: `C${i + 1}` }));
  // Stable sort: equal severities keep finder order.
  const ranked = candidates
    .filter((c) => !UNVERIFIED_CATEGORIES.includes(c.category))
    .sort((a, b) => FINDER_SEVERITY_RANK[a.severity] - FINDER_SEVERITY_RANK[b.severity]);
  const selected = ranked.slice(0, PANEL_VERIFY_CAP);
  // One batch never mixes files or finder vendors, so each call avoids exactly its finder's vendor.
  const groups = new Map<string, typeof selected>();
  for (const c of candidates.filter((c) => selected.includes(c))) {
    const key = JSON.stringify([c.vendor, c.file]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const batches = [...groups.values()].flatMap((group) =>
    Array.from({ length: Math.ceil(group.length / PANEL_BATCH_SIZE) }, (_, i) =>
      group.slice(i * PANEL_BATCH_SIZE, (i + 1) * PANEL_BATCH_SIZE),
    ),
  );
  // A re-review's verifier checks the same fix diff, and whether each prior finding is really resolved.
  const { fixReview, previous } = input.prompt;
  const fix =
    fixReview && previous
      ? {
          review: fixReview,
          sha: previous.sha,
          prior: previous.findings.map(({ file, line, title }, i) => {
            const id = `P${i + 1}`;
            const citing = candidates.filter(
              (c) => c.label === "unaddressed" && c.prior?.trim().toUpperCase() === id,
            );
            return {
              id,
              file,
              line,
              title,
              status: citing.length
                ? `reported unaddressed by ${citing.map((c) => c.id).join(", ")}`
                : "reported resolved: no finder cited it",
            };
          }),
        }
      : undefined;
  const verdicts = new Map<string, PanelRecord["verdicts"][number]>();
  const omitted: string[] = [];
  let last = first.invoked.result;
  for (const batch of batches) {
    if (!deps.verify) throw new Error('mode "panel" needs a verifier');
    // Candidates the verifier leaves out get one more call, then stay unverified follow-ups.
    let pending = batch;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const invoked = await deps.verify(
        {
          prompt: verifierPrompt({
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
              ...(fix ? { label: label ?? "new", prior: prior ?? "" } : {}),
            })),
            ...(fix ? { fix } : {}),
          }),
          schema: VerifierSchema,
          jsonSchema: toStrictJsonSchema(VerifierSchema),
          timeoutMs: input.timeoutMs,
        },
        pending[0]?.vendor ?? undefined,
      );
      results.push(invoked.result);
      last = invoked.result;
      const parsed = VerifierSchema.safeParse(
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
        `Verifier gave no ruling for ${pending.map((c) => c.id).join(", ")} after a retry; they stay unverified follow-ups`,
      );
    }
  }

  // Refuted candidates are dropped here, by id; a same-titled candidate keeps its own ruling.
  const findings: Finding[] = [];
  for (const { id, finder: _finder, vendor: _vendor, ...finding } of candidates) {
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
      ...found.map(({ review }) => review.summary),
      `Verifier: ${candidates.length} candidates, ${verdicts.size} checked, ${[...verdicts.values()].filter((v) => v.verdict === "REFUTED").length} refuted.`,
    ].join("\n\n"),
    findings,
  };
  const modelVerdict = found.some(({ review }) => review.verdict === "request_changes")
    ? "request_changes"
    : "approve";
  const decision = decide(input, review, modelVerdict);
  const panel: PanelRecord = {
    candidates,
    verdicts: [...verdicts.values()],
    refuted: [...verdicts.values()].filter((v) => v.verdict === "REFUTED").map((v) => v.id),
    capped: ranked.slice(PANEL_VERIFY_CAP).map((c) => c.id),
    omitted,
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
