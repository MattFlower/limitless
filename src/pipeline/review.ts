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

/**
 * Panel reviews block on the verifier's ruling: in round 1 every verified finding outside cleanup and
 * conventions; later rounds apply the rules below with verified critical/high standing in for blocker.
 *
 * Single reviews, first round: blockers and majors block. Later rounds may not move the goalposts: a finding blocks
 * only if it is a regression from the latest changes, an unaddressed previous *blocking* finding
 * (cited by id, so rewording can't lose it and follow-ups can't be promoted), or a new blocker or
 * security issue. Everything else becomes a follow-up.
 */
export function blockingReviewFindings(
  review: StoredReview,
  priorBlocking?: Review["findings"],
): Review["findings"] {
  const panel = review.mode === "panel";
  return review.findings.filter((finding) => {
    if (panel && finding.verification?.verdict === "REFUTED") return false;
    if (panel && !priorBlocking)
      return panelVerified(finding) && !UNVERIFIED_CATEGORIES.includes(finding.verification?.category);
    if (!priorBlocking) return finding.severity === "blocker" || finding.severity === "major";
    if (finding.label === "regression") return true;
    if (finding.label === "unaddressed" && citesPriorBlocking(finding, priorBlocking)) return true;
    if (panel)
      return (
        finding.security ||
        (panelVerified(finding) &&
          (finding.verification?.severity === "critical" || finding.verification?.severity === "high"))
      );
    return finding.severity === "blocker" || finding.security;
  });
}

export function reviewVerdict(review: StoredReview, priorBlocking?: Review["findings"]): Review["verdict"] {
  return blockingReviewFindings(review, priorBlocking).length ? "request_changes" : "approve";
}

export interface ReviewInput {
  prompt: Parameters<typeof reviewPrompt>[0];
  timeoutMs: number;
  /** Follow-ups already recorded for this round and commit, when a review is replayed after a restart. */
  replayedFollowUps?: Review["findings"];
  /** Defaults to one finder (`single`). */
  system?: Pick<ReviewSystem, "mode" | "finders">;
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
}

type Invoked = { result: AgentResult; target?: { vendor: string } };

export interface ReviewDeps<T extends Invoked> {
  /** Runs finder `finder` (an index into the system's finders). */
  invoke: (request: ReviewRequest, finder: number) => Promise<T>;
  /** Panel only: one read-only verifier batch, routed away from the vendor that raised it. */
  verify?: (request: VerifierRequest, avoidVendor: string | undefined) => Promise<T>;
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
  const review: Review = { ...found, verdict: reviewVerdict(found, prior) };
  const blocking = blockingReviewFindings(review, prior);
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
function combined(results: AgentResult[], last: AgentResult, structured: unknown): AgentResult {
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
    if (!output.success) return { ...invoked, result: combined(results, invoked.result, null), output };
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
  const verdicts = new Map<string, PanelRecord["verdicts"][number]>();
  let last = first.invoked.result;
  for (const batch of batches) {
    if (!deps.verify) throw new Error('mode "panel" needs a verifier');
    const invoked = await deps.verify(
      {
        prompt: verifierPrompt({
          prompt: input.prompt.prompt,
          spec: input.prompt.spec,
          baseSha: input.prompt.baseSha,
          headSha: input.prompt.headSha,
          stat: input.prompt.stat,
          candidates: batch.map(({ id, file, line, title, failure_scenario }) => ({
            id,
            file,
            line,
            title,
            failure_scenario: failure_scenario ?? "",
          })),
        }),
        schema: VerifierSchema,
        jsonSchema: toStrictJsonSchema(VerifierSchema),
        timeoutMs: input.timeoutMs,
      },
      batch[0]?.vendor ?? undefined,
    );
    results.push(invoked.result);
    last = invoked.result;
    const parsed = VerifierSchema.safeParse(
      invoked.result.structured ?? extractJson(invoked.result.finalText),
    );
    // Exactly one result per submitted id: an omitted candidate must not silently become nonblocking.
    const ids = parsed.success ? parsed.data.results.map((r) => r.id) : [];
    const complete =
      ids.length === batch.length &&
      new Set(ids).size === ids.length &&
      batch.every((c) => ids.includes(c.id));
    if (invoked.result.status !== "ok" || !parsed.success || !complete) {
      const message =
        invoked.result.status !== "ok"
          ? `Verifier ${invoked.result.status}: ${invoked.result.error ?? "no output"}`
          : !parsed.success
            ? `Invalid verifier output: ${parsed.error.message}`
            : `Invalid verifier output: expected one result for each of ${batch.map((c) => c.id).join(", ")}, got ${JSON.stringify(ids)}`;
      return {
        ...first.invoked,
        result: combined(results, invoked.result, null),
        output: z.custom<Review>(() => false, message).safeParse(null),
      };
    }
    for (const result of parsed.data.results) verdicts.set(result.id, result);
  }

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
  const refutedKeys = new Set(
    candidates.filter((c) => verdicts.get(c.id)?.verdict === "REFUTED").map(reviewFindingKey),
  );
  decision.followUps = decision.followUps.filter((f) => !refutedKeys.has(reviewFindingKey(f)));
  return {
    ...first.invoked,
    result: combined(results, last, decision.review),
    output: { success: true, data: decision.review },
    decision,
    panel: {
      candidates,
      verdicts: [...verdicts.values()],
      refuted: [...verdicts.values()].filter((v) => v.verdict === "REFUTED").map((v) => v.id),
      capped: ranked.slice(PANEL_VERIFY_CAP).map((c) => c.id),
    },
  };
}
