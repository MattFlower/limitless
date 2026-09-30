import { appendFileSync } from "node:fs";
import { z } from "zod";
import { untilAborted } from "../pipeline/faults.ts";
import { type AgentResult, emptyUsage, type Harness, priceOf } from "./types.ts";

/** A typed question. The model never sees its id, so `instructions` carries the whole question. */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

/** A validated answer; `level` is the score rounded to the nearest level, as the API docs advise. */
export type DecisionAnswer =
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; level: number; confidence: number }
  | { type: "noul"; noul: number };

export interface DecisionDecline {
  reason: string;
  /** The answers are sound but unsure: usable as the last resort when no other model can answer. */
  lastResort: boolean;
}

export interface DecisionTask {
  /** The state, or a function building it when the call is made, so an unused task costs nothing. */
  state: string | Record<string, unknown> | (() => string | Record<string, unknown>);
  questions: Record<string, DecisionQuestion>;
  /** Maps the answers (keyed like `questions`) to the role's structured output. */
  interpret(answers: Record<string, DecisionAnswer>): unknown;
  /** Declines the answers so routing tries the next model; see DecisionDecline. */
  decline?(answers: Record<string, DecisionAnswer>): DecisionDecline | null;
}

const Probability = z.number().min(0).max(1);
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("choice"), choice: z.string(), confidence: Probability }),
      z.object({ type: z.literal("score"), score: z.number(), confidence: Probability }),
      z.object({ type: z.literal("noul"), noul: Probability }),
    ]),
  ),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});
type RawAnswers = z.infer<typeof ResponseSchema>["answers"];

const ATTEMPT_MS = 30_000;
const RETRY_DELAY_MS = 500;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

function mapAnswers(task: DecisionTask, raw: RawAnswers): Record<string, DecisionAnswer> | string {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(task.questions)) {
    const answer = raw[id];
    if (answer?.type !== question.type) return `missing or mistyped answer for ${id}`;
    if (question.type === "choice" && answer.type === "choice") {
      if (!Object.hasOwn(question.criteria, answer.choice)) return `unknown option for ${id}`;
      answers[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence };
    } else if (question.type === "score" && answer.type === "score") {
      const top = question.criteria.length - 1;
      const level = Math.min(top, Math.max(0, Math.round(answer.score)));
      answers[id] = { type: "score", score: answer.score, level, confidence: answer.confidence };
    } else if (answer.type === "noul") answers[id] = { type: "noul", noul: answer.noul };
  }
  return answers;
}

function describe(answers: Record<string, DecisionAnswer>): string {
  return Object.entries(answers)
    .map(([id, a]) =>
      a.type === "choice"
        ? `${id}=${a.choice} (${a.confidence.toFixed(2)})`
        : a.type === "score"
          ? `${id}=${a.level} (${a.confidence.toFixed(2)})`
          : `${id} P=${a.noul.toFixed(2)}`,
    )
    .join(", ");
}

/** A short description from FastAPI (`detail`) or OpenRouter-style (`error.message`) error bodies. */
function errorDetail(text: string): string {
  let message = text;
  try {
    const body: unknown = JSON.parse(text);
    const field = (value: unknown, key: string): unknown =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
    const detail = field(body, "detail");
    const nested = field(detail, "message") ?? field(field(body, "error"), "message");
    if (typeof detail === "string") message = detail;
    else if (typeof nested === "string") message = nested;
    else if (Array.isArray(detail))
      message = detail
        .map((d) => `${[field(d, "loc")].flat().join(".")}: ${String(field(d, "msg"))}`)
        .join("; ");
  } catch {
    // Not JSON: keep the raw text.
  }
  message = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return message ? `: ${message}` : "";
}

/** Retry-After (seconds or HTTP date) or retry-after-ms, clamped; the API sends it only sometimes. */
function cooldownMs(headers: Headers): number {
  const ms = Number(headers.get("retry-after-ms"));
  const after = headers.get("retry-after")?.trim();
  let wait = ms > 0 ? ms : Number.NaN;
  if (Number.isNaN(wait) && after)
    wait = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
  return wait > 0 ? Math.min(Math.max(wait, 1000), MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;
}

/**
 * One typed-question call to a decision model (TypeSafe `POST /v1/systemone`). Overloads, 5xx,
 * transport errors and attempt timeouts are retried once; everything else is classified for the
 * router: 402 and rejected keys stop the provider, 429 cools down only this model.
 */
export const runDecisions: Harness = async (spec) => {
  const endpoint = spec.target.decisions;
  const task = spec.decisionTask;
  const usage = emptyUsage();
  const log = (entry: Record<string, unknown>) => appendFileSync(spec.logPath, `${JSON.stringify(entry)}\n`);
  const finish = (
    status: AgentResult["status"],
    error: string | null,
    extra: Partial<AgentResult> = {},
  ): AgentResult => {
    const cost = priceOf(usage, spec.target.price);
    const result: AgentResult = {
      status,
      error,
      finalText: "",
      structured: null,
      sessionId: null,
      usage,
      numTurns: status === "ok" ? 1 : 0,
      costUsd: spec.target.billing === "metered" ? cost : 0,
      costEquivUsd: cost,
      quota: null,
      usageFinal: false,
      ...extra,
    };
    log({ event: "complete", status, inputTokens: usage.input, costUsd: result.costUsd });
    return result;
  };
  // A request the server refused, or one never sent, spent nothing; a parsed response reports its usage.
  const settled = { usageFinal: true };
  log({ event: "start", provider: spec.target.provider, model: spec.target.model });
  if (!endpoint || !task)
    return finish("error", "decision call requires a decisions endpoint and task", settled);

  const deadline = AbortSignal.timeout(spec.timeoutMs);
  const state = typeof task.state === "function" ? task.state() : task.state;
  const body = JSON.stringify({ model: spec.target.model, state, questions: task.questions });
  let failure: { status: "unavailable" | "timeout"; error: string } = {
    status: "unavailable",
    error: "decision call failed",
  };
  for (let attempt = 1; attempt <= 2 && !deadline.aborted; attempt++) {
    if (attempt > 1) await untilAborted(AbortSignal.any([spec.signal, deadline]), RETRY_DELAY_MS);
    if (spec.signal.aborted) return finish("cancelled", "decision call cancelled");
    const attemptTimeout = AbortSignal.timeout(ATTEMPT_MS);
    let response: Response;
    try {
      response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.authToken}` },
        body,
        signal: AbortSignal.any([spec.signal, deadline, attemptTimeout]),
      });
    } catch {
      if (spec.signal.aborted) return finish("cancelled", "decision call cancelled");
      failure =
        deadline.aborted || attemptTimeout.aborted
          ? { status: "timeout", error: "decision call timed out" }
          : { status: "unavailable", error: "decision call transport failure" };
      continue;
    }
    log({ event: "response", attempt, httpStatus: response.status });
    if (!response.ok) {
      const code = response.status;
      // Key errors keep no server text (it could echo the key); other bodies are untrusted, so redact it.
      if (code === 401 || code === 403) return finish("quota", `API key rejected (HTTP ${code})`, settled);
      const text = await response.text().catch(() => "");
      const detail = errorDetail(
        endpoint.authToken ? text.replaceAll(endpoint.authToken, "[redacted]") : text,
      );
      if (code >= 500 || code === 408) {
        failure = { status: "unavailable", error: `decision service unavailable (HTTP ${code})${detail}` };
        continue;
      }
      if (code === 429)
        return finish("quota", `model rate-limited (HTTP 429)${detail}`, {
          ...settled,
          modelCooldownMs: cooldownMs(response.headers),
        });
      if (code === 402) return finish("quota", `provider out of credit (HTTP 402)${detail}`, settled);
      return finish("error", `decision request rejected (HTTP ${code})${detail}`, settled);
    }
    let parsed: ReturnType<typeof ResponseSchema.safeParse>;
    try {
      parsed = ResponseSchema.safeParse(await response.json());
    } catch {
      // Reading the body can also be cut short by cancellation or a timeout.
      if (spec.signal.aborted) return finish("cancelled", "decision call cancelled");
      if (deadline.aborted || attemptTimeout.aborted) {
        failure = { status: "timeout", error: "decision call timed out" };
        continue;
      }
      return finish("unavailable", "malformed decisions response");
    }
    if (!parsed.success) return finish("unavailable", "malformed decisions response");
    usage.input = parsed.data.usage.input_tokens;
    usage.output = parsed.data.usage.output_tokens;
    const answers = mapAnswers(task, parsed.data.answers);
    if (typeof answers === "string")
      return finish("unavailable", `malformed decisions response: ${answers}`, settled);
    log({ event: "answers", model: parsed.data.model, answers });
    spec.onEvent({ type: "status", text: `${parsed.data.model}: ${describe(answers)}` });
    try {
      // A declined result keeps its structured output so evals can grade what the model answered.
      const structured = task.interpret(answers);
      const decline = task.decline?.(answers) ?? null;
      return finish(decline ? "declined" : "ok", decline?.reason ?? null, {
        ...settled,
        structured,
        finalText: JSON.stringify(answers),
        ...(decline ? { decline } : {}),
      });
    } catch (error) {
      return finish("error", `decision mapping failed: ${(error as Error).message}`, settled);
    }
  }
  if (spec.signal.aborted) return finish("cancelled", "decision call cancelled");
  return finish(
    deadline.aborted ? "timeout" : failure.status,
    deadline.aborted ? "decision call timed out" : failure.error,
  );
};
