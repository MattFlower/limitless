import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  ChatMessage,
  ChatProposal,
  ChatProposalFields,
  ChatRequest,
  Profile,
} from "../../src/core/types.ts";
import { getChat, openChatStream, postChat } from "../api.ts";
import { chatProposals, mergeChatMessages } from "../lib/chat.ts";

export const Chat: Component = () => {
  const key = "limitless-chat-conversation";
  const conversationId = localStorage.getItem(key) || crypto.randomUUID();
  localStorage.setItem(key, conversationId);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [text, setText] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  const [error, setError] = createSignal("");
  const [editing, setEditing] = createSignal<ChatProposal | null>(null);
  const [draft, setDraft] = createSignal<ChatProposalFields>({
    repo: "",
    prompt: "",
    profile: "auto",
    title: "",
  });
  const proposals = createMemo(() => chatProposals(messages()));
  let close: (() => void) | undefined;
  let disposed = false;
  const merge = (incoming: ChatMessage[]) => setMessages((current) => mergeChatMessages(current, incoming));
  const load = async () => {
    try {
      const history = await getChat(conversationId);
      if (disposed) return;
      merge(history.messages);
      close?.();
      close = openChatStream(
        conversationId,
        messages().at(-1)?.id ?? 0,
        (message) => merge([message]),
        setConnected,
      );
      setReady(true);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  onMount(() => {
    void load();
  });
  onCleanup(() => {
    disposed = true;
    close?.();
  });

  const submit = async (request: ChatRequest) => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      const result = await postChat(conversationId, request);
      merge(result.messages);
      if (request.type === "text") setText("");
      if (request.type === "edit") setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };
  const edit = (proposal: ChatProposal) => {
    setDraft({
      repo: proposal.repo,
      prompt: proposal.prompt,
      profile: proposal.profile,
      title: proposal.title,
      allow: proposal.allow,
    });
    setEditing(proposal);
  };
  const editable = () => proposals().find((p) => p.id === editing()?.id)?.state === "pending";

  return (
    <div class="page stack" style={{ "max-width": "900px" }}>
      <div class="page-header">
        <h1 class="page-title">Chat</h1>
        <span>{connected() ? "Connected" : "Reconnecting…"}</span>
      </div>
      <div class="stack" role="log" aria-live="polite" aria-label="Conversation">
        <For each={messages()}>
          {(message) => (
            <div class="card card-pad" classList={{ "error-box": message.outcome?.error === true }}>
              <strong>{message.role === "user" ? "You" : "Limitless"}</strong>
              <p style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>{message.content}</p>
              <Show when={message.runId}>
                <a href={`/runs/${message.runId}`}>View run {message.runId}</a>
              </Show>
            </div>
          )}
        </For>
      </div>
      <For each={proposals()}>
        {(proposal) => (
          <section class="card card-pad stack" aria-label={`Proposal ${proposal.id}`}>
            <strong>{proposal.title}</strong>
            <div>
              Repo: {proposal.repo} · Profile: {proposal.profile} · {proposal.state}
            </div>
            <p style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>{proposal.prompt}</p>
            <p>Allow: {proposal.allow?.join(", ") || "none"}</p>
            <Show when={proposal.runId}>
              <a href={`/runs/${proposal.runId}`}>View created run</a>
            </Show>
            <div class="actions">
              <button
                class="btn btn-primary"
                type="button"
                disabled={pending() || !!editing() || !["pending", "confirmed"].includes(proposal.state)}
                onClick={() => void submit({ type: "confirm", proposalId: proposal.id })}
              >
                Confirm
              </button>
              <button
                class="btn"
                type="button"
                disabled={pending() || proposal.state !== "pending"}
                onClick={() => edit(proposal)}
              >
                Edit
              </button>
            </div>
          </section>
        )}
      </For>
      <Show when={editing()}>
        <form
          class="card card-pad stack"
          onSubmit={(event) => {
            event.preventDefault();
            const proposal = editing();
            if (proposal && editable())
              void submit({ type: "edit", proposalId: proposal.id, proposal: draft() });
          }}
        >
          <strong>Edit proposal — save to review before confirming</strong>
          <For each={["repo", "title", "prompt"] as const}>
            {(field) => (
              <div class="field">
                <label for={`chat-${field}`}>{field}</label>
                <textarea
                  id={`chat-${field}`}
                  required
                  value={draft()[field]}
                  onInput={(event) => setDraft({ ...draft(), [field]: event.currentTarget.value })}
                />
              </div>
            )}
          </For>
          <div class="field">
            <label for="chat-profile">Profile</label>
            <select
              id="chat-profile"
              value={draft().profile}
              onChange={(event) => setDraft({ ...draft(), profile: event.currentTarget.value as Profile })}
            >
              <For each={["auto", "quick", "standard", "deep"]}>
                {(profile) => <option value={profile}>{profile}</option>}
              </For>
            </select>
          </div>
          <button
            class="btn btn-primary"
            type="submit"
            disabled={
              pending() ||
              !editable() ||
              !draft().repo.trim() ||
              !draft().title.trim() ||
              !draft().prompt.trim()
            }
          >
            Save revised proposal
          </button>
          <button class="btn" type="button" onClick={() => setEditing(null)}>
            Cancel edit
          </button>
        </form>
      </Show>
      <Show when={error()}>
        <div class="error-box" role="alert">
          {error()}{" "}
          <button type="button" class="btn" onClick={() => void load()}>
            Reload history
          </button>
        </div>
      </Show>
      <form
        class="card card-pad stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (text().trim()) void submit({ type: "text", text: text() });
        }}
      >
        <div class="field">
          <label for="chat-message">Message</label>
          <textarea
            id="chat-message"
            rows={4}
            maxLength={12000}
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
            placeholder="Describe a task, ask about a run, or answer a question…"
          />
        </div>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={!ready() || pending() || !!editing() || !text().trim()}
        >
          {pending() ? "Working…" : "Send"}
        </button>
      </form>
    </div>
  );
};
