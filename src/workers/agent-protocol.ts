import { z } from "zod";
import { isBranchName } from "../core/delivery.ts";
import type { AgentEvent, AgentResult } from "../harness/types.ts";

const number = z.number().finite();
const window = z.object({ utilization: number, resetsAt: number.nullable() }).strict();
const windows = z.record(z.string(), window);
const event: z.ZodType<AgentEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), sessionId: z.string(), model: z.string().optional() }).strict(),
  ...(["text", "thinking", "stderr", "status"] as const).map((type) =>
    z.object({ type: z.literal(type), text: z.string() }).strict(),
  ),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), input: z.json() }).strict(),
  z
    .object({ type: z.literal("tool_result"), id: z.string(), output: z.string(), isError: z.boolean() })
    .strict(),
  z
    .object({ type: z.literal("rate_limit"), status: z.string(), windows, resetsAt: number.nullable() })
    .strict(),
  z
    .object({
      type: z.literal("warning"),
      id: z.string(),
      text: z.string(),
      code: z.literal("browser_unavailable").optional(),
    })
    .strict(),
]);
export const AgentEvents = z
  .object({
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    events: z.array(event),
  })
  .strict();
const result = z
  .object({
    status: z.enum(["ok", "error", "cancelled", "timeout", "stuck", "quota", "unavailable", "declined"]),
    failureClass: z.literal("authentication").optional(),
    finalText: z.string(),
    structured: z.json(),
    sessionId: z.string().nullable(),
    usage: z
      .object({
        input: number,
        output: number,
        cacheRead: number,
        cacheWrite: number,
        cacheWrite1h: number.optional(),
      })
      .strict(),
    numTurns: number,
    costUsd: number,
    costEquivUsd: number,
    error: z.string().nullable(),
    quota: z.object({ windows, exhaustedUntil: number.nullable() }).strict().nullable(),
    modelCooldownMs: number.optional(),
    decline: z.object({ reason: z.string(), lastResort: z.boolean() }).strict().optional(),
    confinement: z
      .object({
        ok: z.boolean(),
        path: z.string().nullable(),
        version: z.string().nullable(),
        reason: z
          .enum([
            "reader profile not enforced",
            "write profile not enforced",
            "probe inconclusive",
            "probe timed out",
            "codex sandbox failed to start",
          ])
          .nullable(),
        exitCode: number.nullable(),
      })
      .strict()
      .optional(),
    fastModeState: z.string().nullable().optional(),
    fastModeDisabledReason: z.string().nullable().optional(),
  })
  .strict() satisfies z.ZodType<AgentResult>;
export const AgentResultReport = result
  .extend({
    privateStringsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    parentSha: z.string(),
    sha: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i),
    branch: z.string().refine(isBranchName),
  })
  .strict();
export const AgentFailure = z.object({ reason: z.string() }).strict();
