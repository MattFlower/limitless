import type { z } from "zod";
import { type AgentResult, extractJson } from "../harness/types.ts";
import { reviewPrompt } from "./prompts.ts";
import {
  LaterReviewSchema,
  type Review,
  ReviewSchema,
  type StoredReview,
  toStrictJsonSchema,
} from "./schemas.ts";

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
 * First round: blockers and majors block. Later rounds may not move the goalposts: a finding blocks
 * only if it is a regression from the latest changes, an unaddressed previous *blocking* finding
 * (cited by id, so rewording can't lose it and follow-ups can't be promoted), or a new blocker or
 * security issue. Everything else becomes a follow-up.
 */
export function blockingReviewFindings(
  review: StoredReview,
  priorBlocking?: Review["findings"],
): Review["findings"] {
  return review.findings.filter((finding) => {
    if (!priorBlocking) return finding.severity === "blocker" || finding.severity === "major";
    if (finding.label === "regression") return true;
    if (finding.label === "unaddressed" && citesPriorBlocking(finding, priorBlocking)) return true;
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
}

/** What the invoker sends to the model; later rounds (with previous findings) use the labelled schema. */
export interface ReviewRequest {
  prompt: string;
  schema: typeof ReviewSchema | typeof LaterReviewSchema;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
}

export interface ReviewDeps<T extends { result: AgentResult }> {
  invoke: (request: ReviewRequest) => Promise<T>;
}

export interface ReviewDecision {
  /** The model's output with the verdict derived from its findings; control flow uses this one. */
  review: Review;
  /** The model's own verdict, kept for inspection only. */
  modelVerdict: Review["verdict"];
  blocking: Review["findings"];
  followUps: Review["findings"];
}

/** `data` is the model output as returned (with its own verdict). */
export type ReviewParse =
  | { success: true; data: Review; decision: ReviewDecision }
  | { success: false; error: z.ZodError };

export function reviewRequest(input: ReviewInput): ReviewRequest {
  const schema = input.prompt.previous ? LaterReviewSchema : ReviewSchema;
  return {
    prompt: reviewPrompt(input.prompt),
    schema,
    jsonSchema: toStrictJsonSchema(schema),
    timeoutMs: input.timeoutMs,
  };
}

/**
 * One review round: prompt, invocation, parsing and the derived decision. Parsing runs whatever the
 * invocation status so callers keep their own error handling.
 */
export async function runReview<T extends { result: AgentResult }>(
  deps: ReviewDeps<T>,
  input: ReviewInput,
): Promise<T & { request: ReviewRequest; parsed: ReviewParse }> {
  const request = reviewRequest(input);
  const invoked = await deps.invoke(request);
  const output = request.schema.safeParse(invoked.result.structured ?? extractJson(invoked.result.finalText));
  if (!output.success) return { ...invoked, request, parsed: { success: false, error: output.error } };
  const prior = input.prompt.previous?.findings;
  const review: Review = { ...output.data, verdict: reviewVerdict(output.data, prior) };
  const blocking = blockingReviewFindings(review, prior);
  const followUps = prior
    ? [
        ...new Map(
          [...(input.replayedFollowUps ?? []), ...review.findings.filter((f) => !blocking.includes(f))].map(
            (f) => [reviewFindingKey(f), f] as const,
          ),
        ).values(),
      ]
    : [];
  const decision = { review, modelVerdict: output.data.verdict, blocking, followUps };
  return { ...invoked, request, parsed: { success: true, data: output.data, decision } };
}
