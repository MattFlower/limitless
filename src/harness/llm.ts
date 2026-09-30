import { appendFileSync } from "node:fs";
import {
  type AgentResult,
  emptyUsage,
  extractJson,
  type Harness,
  type ModelTarget,
  priceOf,
  type Usage,
} from "./types.ts";

/** `usageFinal`: every request sent was accounted (parsed with usage) or refused before any work. */
function failure(
  status: AgentResult["status"],
  error: string,
  usage: Usage,
  target: ModelTarget,
  usageFinal = false,
): AgentResult {
  const cost = priceOf(usage, target.price);
  return {
    status,
    error,
    finalText: "",
    structured: null,
    sessionId: null,
    usage,
    numTurns: 0,
    costUsd: target.billing === "metered" ? cost : 0,
    costEquivUsd: cost,
    quota: null,
    usageFinal,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The response's token counts, or null when the server sent no authoritative usage. */
function reportedUsage(response: Record<string, unknown> | null): { input: number; output: number } | null {
  const tokens = object(response?.usage);
  const input = tokens?.prompt_tokens;
  const output = tokens?.completion_tokens;
  return typeof input === "number" && typeof output === "number" && input >= 0 && output >= 0
    ? { input, output }
    : null;
}

export function effortFields(target: ModelTarget): Record<string, unknown> {
  if (target.effort === undefined) return {};
  if (!target.openai) throw new Error("Effort requires an HTTP endpoint");
  switch (target.effortMapping) {
    case "openrouter":
      return { reasoning: { effort: target.effort } };
    case "generic":
      return { reasoning_effort: target.effort };
    case "qwen":
      if (target.vendor !== "qwen" || target.billing !== "free")
        throw new Error("Qwen thinking mapping requires a local Qwen target");
      return { chat_template_kwargs: { enable_thinking: target.effort !== "none" } };
    default:
      throw new Error("Unsupported effort transport: configure an explicit HTTP effort mapping");
  }
}

/** One structured completion, with one bounded repair attempt for unsupported/invalid JSON. */
export const runLlm: Harness = async (spec) => {
  const endpoint = spec.target.openai;
  const usage = emptyUsage();
  const log = (entry: Record<string, string | number>) =>
    appendFileSync(spec.logPath, `${JSON.stringify(entry)}\n`);
  const finish = (result: AgentResult): AgentResult => {
    log({
      event: "complete",
      status: result.status,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd: result.costUsd,
      costEquivUsd: result.costEquivUsd,
    });
    return result;
  };
  log({ event: "start", provider: spec.target.provider, model: spec.target.model });
  if (!endpoint || !spec.jsonSchema || !spec.schema)
    return finish(
      failure("error", "HTTP completion requires an endpoint and a schema", usage, spec.target, true),
    );

  let reasoning: Record<string, unknown>;
  try {
    reasoning = effortFields(spec.target);
  } catch (error) {
    return finish(failure("error", String(error), usage, spec.target, true));
  }
  const timeout = AbortSignal.timeout(spec.timeoutMs);
  const signal = AbortSignal.any([spec.signal, timeout]);
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (spec.systemAppend) messages.push({ role: "system", content: spec.systemAppend });
  messages.push({ role: "user", content: spec.prompt });
  let lastError = "invalid structured response";
  // A valid answer is not final accounting: a metered response without usage may still be billed,
  // and once a request went unaccounted no later request makes this call's spend final again.
  let accounted = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (spec.stopOnUnknownUsage && !accounted) break;
    if (signal.aborted)
      return finish(
        failure(spec.signal.aborted ? "cancelled" : "timeout", "completion interrupted", usage, spec.target),
      );
    const body: Record<string, unknown> = {
      model: spec.target.model,
      messages,
      stream: false,
      ...reasoning,
    };
    if (attempt === 0)
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "completion", strict: true, schema: spec.jsonSchema },
      };
    log({ event: "request", attempt: attempt + 1, format: attempt === 0 ? "json_schema" : "plain" });
    try {
      const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.authToken ? { authorization: `Bearer ${endpoint.authToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      log({ event: "response", attempt: attempt + 1, httpStatus: response.status });
      if (!response.ok) {
        if (attempt === 0 && [400, 422].includes(response.status)) {
          lastError = `structured format rejected (HTTP ${response.status})`;
          messages.push({
            role: "user",
            content: "Return only a JSON object matching the requested schema.",
          });
          continue;
        }
        const status = response.status === 429 ? "quota" : response.status >= 500 ? "unavailable" : "error";
        // A refusal spent nothing, but a timeout or server failure may leave backend work unaccounted.
        return finish(
          failure(
            status,
            `completion rejected (HTTP ${response.status})`,
            usage,
            spec.target,
            accounted && response.status < 500 && response.status !== 408,
          ),
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return finish(failure("unavailable", "malformed completion response", usage, spec.target));
      }
      const parsed = object(data);
      const tokens = reportedUsage(parsed);
      if (tokens) {
        usage.input += tokens.input;
        usage.output += tokens.output;
      } else accounted = false;
      const choices = parsed?.choices;
      const choice = Array.isArray(choices) ? object(choices[0]) : null;
      const message = object(choice?.message);
      const content = message?.content;
      if (typeof content !== "string")
        return finish(failure("unavailable", "malformed completion response", usage, spec.target));
      let candidate: unknown;
      try {
        candidate = JSON.parse(content);
      } catch {
        candidate = extractJson(content);
      }
      const valid = spec.schema.safeParse(candidate);
      if (valid.success && object(valid.data)) {
        const cost = priceOf(usage, spec.target.price);
        return finish({
          status: "ok",
          error: null,
          finalText: content,
          structured: valid.data,
          sessionId: null,
          usage,
          numTurns: attempt + 1,
          costUsd: spec.target.billing === "metered" ? cost : 0,
          costEquivUsd: cost,
          quota: null,
          usageFinal: accounted,
        });
      }
      lastError = "completion failed schema validation";
      messages.push({
        role: "user",
        content: "Your previous answer was invalid. Return only a JSON object matching the requested schema.",
      });
    } catch {
      if (spec.signal.aborted)
        return finish(failure("cancelled", "completion cancelled", usage, spec.target));
      if (timeout.aborted) return finish(failure("timeout", "completion timed out", usage, spec.target));
      return finish(failure("unavailable", "completion transport failure", usage, spec.target));
    }
  }
  // Sent requests returned parsed responses (or a refusal); usage is complete if each reported it.
  return finish(failure("error", lastError, usage, spec.target, accounted));
};
