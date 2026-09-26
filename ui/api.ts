// Typed client for the Limitless HTTP + SSE API. Domain types are imported from the backend so
// the UI can never drift from the wire shape.
import type {
  CreateRunRequest,
  ProviderStatus,
  Question,
  QuotaAlert,
  Repo,
  Run,
  RunDetail,
  RunEvent,
  RunStatus,
  StreamMessage,
} from "../src/core/types.ts";
import type { Stats } from "../src/db/stats.ts";
import type { ModelDef, Policy } from "../src/router/catalog.ts";

export type { StreamMessage };

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // not JSON — keep raw text
    }
    throw new ApiError(message, res.status);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export function listRuns(opts: { status?: RunStatus[]; limit?: number } = {}): Promise<Run[]> {
  const qs = new URLSearchParams();
  if (opts.status?.length) qs.set("status", opts.status.join(","));
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<Run[]>(`/api/runs${q ? `?${q}` : ""}`);
}

export function createRun(req: CreateRunRequest): Promise<Run> {
  return request<Run>("/api/runs", { method: "POST", body: JSON.stringify(req) });
}

export function getRunDetail(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${id}`);
}

export function cancelRun(id: string): Promise<{ cancelled: boolean }> {
  return request(`/api/runs/${id}/cancel`, { method: "POST" });
}

export function retryRun(id: string): Promise<Run> {
  return request<Run>(`/api/runs/${id}/retry`, { method: "POST" });
}

export function answerRun(id: string, answer: string, questionId?: number): Promise<Question[]> {
  return request(`/api/runs/${id}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer, ...(questionId !== undefined ? { questionId } : {}) }),
  });
}

export function getArtifact(runId: string, name: string): Promise<string> {
  return fetch(`/api/runs/${runId}/artifacts/${encodeURIComponent(name)}`).then(async (res) => {
    if (!res.ok) throw new ApiError(await res.text(), res.status);
    return res.text();
  });
}

export function listEvents(
  runId: string,
  opts: { after?: number; limit?: number; invocation?: number } = {},
): Promise<RunEvent[]> {
  const qs = new URLSearchParams();
  if (opts.after) qs.set("after", String(opts.after));
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.invocation !== undefined) qs.set("invocation", String(opts.invocation));
  return request<RunEvent[]>(`/api/runs/${runId}/events?${qs.toString()}`);
}

export function getProviders(): Promise<ProviderStatus[]> {
  return request<ProviderStatus[]>("/api/providers");
}

export function getAlerts(): Promise<QuotaAlert[]> {
  return request<QuotaAlert[]>("/api/alerts");
}

export function getModels(): Promise<{ models: ModelDef[]; policy: Policy }> {
  return request("/api/models");
}

export function getStats(days = 14): Promise<Stats> {
  return request<Stats>(`/api/stats?days=${days}`);
}

export function getRepos(): Promise<Repo[]> {
  return request<Repo[]>("/api/repos");
}

/**
 * Open the global SSE stream (run/stage/invocation/provider/question — events are excluded).
 * The browser's native EventSource retries on drop; `onConnected` tracks readyState for a UI
 * indicator.
 */
export function openGlobalStream(
  onMessage: (msg: StreamMessage) => void,
  onConnected: (connected: boolean) => void,
): () => void {
  const source = new EventSource("/api/stream");
  source.onopen = () => onConnected(true);
  source.onerror = () => onConnected(false);
  source.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as StreamMessage);
    } catch {
      // ignore malformed frame
    }
  };
  return () => source.close();
}

/** Per-run SSE stream: replays the event backlog after `after`, then streams live. */
export function openRunStream(
  runId: string,
  after: number,
  onMessage: (msg: StreamMessage) => void,
  onConnected: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`/api/runs/${runId}/stream?after=${after}`);
  source.onopen = () => onConnected(true);
  source.onerror = () => onConnected(false);
  source.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as StreamMessage);
    } catch {
      // ignore malformed frame
    }
  };
  return () => source.close();
}

export function getChat(id: string): Promise<import("../src/core/types.ts").ChatConversation> {
  return request(`/api/chat/${encodeURIComponent(id)}`);
}

export function postChat(
  id: string,
  input: import("../src/core/types.ts").ChatRequest,
): Promise<import("../src/core/types.ts").ChatConversation> {
  return request(`/api/chat/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function openChatStream(
  id: string,
  after: number,
  onMessage: (message: import("../src/core/types.ts").ChatMessage) => void,
  onConnected: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`/api/chat/${encodeURIComponent(id)}/stream?after=${after}`);
  source.onopen = () => onConnected(true);
  source.onerror = () => onConnected(false);
  source.onmessage = (event) => {
    const update = JSON.parse(event.data) as import("../src/core/types.ts").ChatStreamMessage;
    if (update.kind === "chat" && update.message.conversationId === id) onMessage(update.message);
  };
  return () => source.close();
}
