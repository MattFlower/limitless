import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ChatConversation, ChatMessage, ChatRequest, ChatStreamMessage } from "../src/core/types.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { chatProposals, mergeChatMessages } from "../ui/lib/chat.ts";
import { chatFixture, proposalFields } from "./chat-support.ts";
import { type Route, requestWithParams, localServer as server } from "./mcp-support.ts";

let f: ReturnType<typeof chatFixture>;
beforeEach(() => {
  f = chatFixture();
});
afterEach(() => {
  f.close();
});
async function get(conversationId = "one") {
  const routes = createHttpRoutes(f.factory);
  return (routes["/api/chat/:conversationId"] as { GET: Route }).GET(
    requestWithParams(`http://localhost:7400/api/chat/${conversationId}`, {}, { conversationId }),
    server,
  );
}
async function post(input: unknown, conversationId = "one", headers: Record<string, string> = {}) {
  const routes = createHttpRoutes(f.factory);
  return (routes["/api/chat/:conversationId/messages"] as { POST: Route }).POST(
    requestWithParams(
      `http://localhost:7400/api/chat/${conversationId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof input === "string" ? input : JSON.stringify(input),
      },
      { conversationId },
    ),
    server,
  );
}
async function stream(conversationId: string, after = 0, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const route = createHttpRoutes(f.factory)["/api/chat/:conversationId/stream"] as Route;
  const response = await route(
    requestWithParams(
      `http://localhost:7400/api/chat/${conversationId}/stream?after=${after}`,
      { signal: abort.signal, headers },
      { conversationId },
    ),
    server,
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no stream");
  const next = async (): Promise<ChatStreamMessage> => {
    const part = await reader.read();
    if (part.done) throw new Error("closed");
    const text = new TextDecoder().decode(part.value);
    const data = text.match(/data: (.+)/)?.[1];
    if (!data) return next();
    const update = JSON.parse(data) as ChatStreamMessage;
    expect(text).toContain(`id: ${update.message.id}\n`);
    return update;
  };
  return { abort, response, reader, next };
}

test("validated text/edit/confirm endpoints persist isolated history and exact run fields", async () => {
  expect(await (await get()).json()).toEqual({ messages: [], proposals: [] });
  f.action({ type: "propose_run", ...proposalFields });
  const initial = (await (await post({ type: "text", text: "build" })).json()) as ChatConversation;
  const old = initial.proposals[0];
  if (!old) throw new Error("no proposal");
  const revised = { ...proposalFields, profile: "quick", title: "Updated", prompt: "Updated task" };
  const edited = (await (
    await post({ type: "edit", proposalId: old.id, proposal: revised })
  ).json()) as ChatConversation;
  const proposal = edited.proposals.at(-1);
  if (!proposal) throw new Error("no revised proposal");
  expect(f.factory.store.listRuns()).toHaveLength(0);
  expect((await post({ type: "confirm", proposalId: old.id })).status).toBe(400);
  expect((await post({ type: "confirm", proposalId: proposal.id }, "two")).status).toBe(400);
  const confirmed = (await (
    await post({ type: "confirm", proposalId: proposal.id })
  ).json()) as ChatConversation;
  expect(confirmed.proposals.at(-1)?.state).toBe("consumed");
  expect(f.factory.store.listRuns()[0]).toMatchObject({
    title: "Updated",
    prompt: "Updated task",
    profile: "quick",
    source: "chat",
  });
  f.reopen();
  expect(await (await get()).json()).toEqual(confirmed);
  expect(await (await get("two")).json()).toEqual({ messages: [], proposals: [] });
  await post({ type: "confirm", proposalId: proposal.id });
  expect(f.factory.store.listRuns()).toHaveLength(1);
});

test("malformed and unauthorized requests fail without mutations", async () => {
  for (const body of [
    "{",
    null,
    {},
    { type: "text", text: " " },
    { type: "text", text: 12 },
    { type: "confirm" },
    { type: "confirm", proposalId: "fake" },
    { type: "edit", proposalId: "fake", proposal: { ...proposalFields, profile: "invalid" } },
    { type: "text", text: "hi", confirmed: true },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
  const input = { type: "text", text: "hi" };
  expect((await post(input, "one", { origin: "https://evil.example" })).status).toBe(403);
  expect((await post(input, "one", { "content-type": "text/plain" })).status).toBe(415);
  expect((await post(input, "one", { "cf-connecting-ip": "1.2.3.4" })).status).toBe(403);
  expect((await post(input, "discord:guild:channel:owner")).status).toBe(400);
  expect((await get("bad:id")).status).toBe(400);
  const route = createHttpRoutes(f.factory)["/api/chat/:conversationId"] as { GET: Route };
  expect(
    (
      await route.GET(
        requestWithParams(
          "http://localhost:7400/api/chat/one",
          { headers: { "cf-connecting-ip": "1.2.3.4" } },
          { conversationId: "one" },
        ),
        server,
      )
    ).status,
  ).toBe(403);
  expect(f.factory.concierge.history("one").messages).toHaveLength(0);
  expect(f.specs).toHaveLength(0);
});

test("SSE scopes committed updates, replays with persisted IDs, reconciles overlaps and unsubscribes", async () => {
  const store = f.factory.store;
  const original = store.subscribe.bind(store);
  let subscribers = 0;
  spyOn(store, "subscribe").mockImplementation((listener) => {
    subscribers++;
    const unsubscribe = original(listener);
    return () => {
      subscribers--;
      unsubscribe();
    };
  });
  const live = await stream("one");
  expect(live.response.headers.get("content-type")).toBe("text/event-stream");
  expect(subscribers).toBe(1);
  await post({ type: "text", text: "separate" }, "two");
  f.action({ type: "propose_run", ...proposalFields });
  const history = (await (await post({ type: "text", text: "build" })).json()) as ChatConversation;
  const updates: ChatMessage[] = [];
  for (const expected of history.messages) {
    const update = await live.next();
    expect(update.message).toEqual(expected);
    expect(store.listChatMessages("one").some((m) => m.id === update.message.id)).toBe(true);
    updates.push(update.message);
  }
  const cursor = updates.at(-1)?.id ?? 0;
  live.abort.abort();
  expect(subscribers).toBe(0);
  const proposal = history.proposals[0];
  if (!proposal) throw new Error("no proposal");
  await post({ type: "confirm", proposalId: proposal.id });
  const all = (await (await get()).json()) as ChatConversation;
  const reconnect = await stream("one", 0, { "last-event-id": String(cursor) });
  const missed = all.messages.filter((m) => m.id > cursor);
  for (const expected of missed) expect((await reconnect.next()).message).toEqual(expected);
  expect(missed.at(-1)?.runId).toBe(all.proposals[0]?.runId);
  // A stale POST response arriving after newer SSE data must not regress proposal state.
  const visible = mergeChatMessages(all.messages, [...updates, ...missed, ...updates]);
  expect(visible).toEqual(all.messages);
  expect(chatProposals(visible)[0]?.state).toBe("consumed");
  await reconnect.reader.cancel();
  expect(subscribers).toBe(0);
  const replay = await stream("one", cursor);
  for (const expected of missed) expect((await replay.next()).message.id).toBe(expected.id);
  replay.abort.abort();
  expect(subscribers).toBe(0);
});

test("SSE includes recoverable model errors and revised proposal states", async () => {
  f.action({ type: "propose_run", ...proposalFields });
  const first = (await (await post({ type: "text", text: "build" })).json()) as ChatConversation;
  const old = first.proposals[0];
  if (!old) throw new Error("missing");
  const request: ChatRequest = {
    type: "edit",
    proposalId: old.id,
    proposal: { ...proposalFields, title: "Revised" },
  };
  await post(request);
  f.reply({ structured: { action: { type: "unsupported" } } });
  await post({ type: "text", text: "try this" });
  const history = f.factory.concierge.history("one");
  const replay = await stream("one");
  for (const expected of history.messages) expect((await replay.next()).message).toEqual(expected);
  expect(chatProposals(history.messages).map((p) => p.state)).toEqual(["superseded", "pending"]);
  expect(history.messages.at(-1)?.outcome?.error).toBe(true);
  expect(f.factory.store.listRuns()).toHaveLength(0);
  replay.abort.abort();
});
