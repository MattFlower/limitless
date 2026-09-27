import { useNavigate, useParams } from "@solidjs/router";
import type { Component } from "solid-js";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ArtifactMeta, Invocation, Question, Run, RunEvent, Stage } from "../../src/core/types.ts";
import { TERMINAL_STATUSES } from "../../src/core/types.ts";
import { answerRun, cancelRun, getRunDetail, openRunStream, retryRun } from "../api.ts";
import { ArtifactsPanel } from "../components/ArtifactsPanel.tsx";
import { EventLog } from "../components/EventLog.tsx";
import { InvocationsTable } from "../components/InvocationsTable.tsx";
import { StageTimeline } from "../components/StageTimeline.tsx";
import { RunStatusPill } from "../components/StatusPill.tsx";
import { compactNumber, duration, equivMoney, money, relativeTime } from "../lib/format.ts";
import { now } from "../lib/ticker.ts";

const QuestionCard: Component<{ runId: string; question: Question }> = (props) => {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const submit = async () => {
    if (!text().trim()) return;
    setBusy(true);
    setError(null);
    try {
      await answerRun(props.runId, text(), props.question.id);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="question-box">
      <div class="question-text">{props.question.question}</div>
      <textarea
        placeholder="Type your answer…"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        disabled={busy()}
      />
      <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
        <button type="button" class="btn btn-primary" disabled={busy() || !text().trim()} onClick={submit}>
          {busy() ? "Answering…" : "Answer"}
        </button>
        <Show when={error()}>
          <span class="text-danger" style={{ "font-size": "12px" }}>
            {error()}
          </span>
        </Show>
      </div>
    </div>
  );
};

export const RunDetail: Component = () => {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [run, setRun] = createSignal<Run | null>(null);
  const [stagesById, setStagesById] = createStore<Record<number, Stage>>({});
  const [invocationsById, setInvocationsById] = createStore<Record<number, Invocation>>({});
  const [questionsById, setQuestionsById] = createStore<Record<number, Question>>({});
  const [eventsById, setEventsById] = createStore<Record<number, RunEvent>>({});
  const [artifacts, setArtifacts] = createSignal<ArtifactMeta[]>([]);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [selectedInvocation, setSelectedInvocation] = createSignal<number | null>(null);
  const [busyAction, setBusyAction] = createSignal<"cancel" | "retry" | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [copyFeedback, setCopyFeedback] = createSignal<"Copied" | "Selected — press ⌘C or Ctrl+C" | null>(
    null,
  );
  let runIdText: HTMLSpanElement | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const copyRunId = async () => {
    const id = run()?.id;
    if (!id) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(id);
      setCopyFeedback("Copied");
    } catch {
      const selection = window.getSelection();
      if (selection && runIdText) {
        const range = document.createRange();
        range.selectNodeContents(runIdText);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyFeedback("Selected — press ⌘C or Ctrl+C");
    }
    feedbackTimer = setTimeout(() => setCopyFeedback(null), 2500);
  };
  onCleanup(() => {
    if (feedbackTimer) clearTimeout(feedbackTimer);
  });

  const stages = createMemo(() => Object.values(stagesById).sort((a, b) => a.id - b.id));
  const invocations = createMemo(() => Object.values(invocationsById).sort((a, b) => a.id - b.id));
  const questions = createMemo(() => Object.values(questionsById).sort((a, b) => a.id - b.id));
  const events = createMemo(() => Object.values(eventsById).sort((a, b) => a.id - b.id));
  const openQuestions = createMemo(() => questions().filter((q) => q.answer === null));

  const refetchArtifacts = () => {
    getRunDetail(params.id)
      .then((d) => setArtifacts(d.artifacts))
      .catch(() => {});
  };

  onMount(() => {
    getRunDetail(params.id)
      .then((detail) => {
        setRun(detail.run);
        setStagesById(
          produce((d) => {
            for (const s of detail.stages) d[s.id] = s;
          }),
        );
        setInvocationsById(
          produce((d) => {
            for (const i of detail.invocations) d[i.id] = i;
          }),
        );
        setQuestionsById(
          produce((d) => {
            for (const q of detail.questions) d[q.id] = q;
          }),
        );
        setArtifacts(detail.artifacts);
      })
      .catch((e) => setLoadError((e as Error).message));

    const close = openRunStream(
      params.id,
      0,
      (msg) => {
        if (msg.kind === "run") setRun(msg.run);
        else if (msg.kind === "stage") {
          const stage = msg.stage;
          setStagesById(
            produce((d) => {
              d[stage.id] = stage;
            }),
          );
          if (stage.status !== "running") refetchArtifacts();
        } else if (msg.kind === "invocation") {
          const invocation = msg.invocation;
          setInvocationsById(
            produce((d) => {
              d[invocation.id] = invocation;
            }),
          );
        } else if (msg.kind === "question") {
          const question = msg.question;
          setQuestionsById(
            produce((d) => {
              d[question.id] = question;
            }),
          );
        } else if (msg.kind === "event") {
          const event = msg.event;
          setEventsById(
            produce((d) => {
              d[event.id] = event;
            }),
          );
        }
      },
      setConnected,
    );
    onCleanup(close);
  });

  const doCancel = async () => {
    setBusyAction("cancel");
    setActionError(null);
    try {
      await cancelRun(params.id);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  };
  const doRetry = async () => {
    setBusyAction("retry");
    setActionError(null);
    try {
      const created = await retryRun(params.id);
      navigate(`/runs/${created.id}`);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const elapsed = createMemo(() => {
    const r = run();
    if (!r?.startedAt) return null;
    const end = r.finishedAt ?? now();
    return duration(end - r.startedAt);
  });

  return (
    <div class="page stack">
      <Show when={loadError()}>
        <div class="error-box">{loadError()}</div>
      </Show>
      <Show
        when={run()}
        fallback={
          <Show when={!loadError()}>
            <div class="centered-hint">loading run…</div>
          </Show>
        }
      >
        {(r) => (
          <>
            <div class="run-header">
              <div class="run-header-top">
                <div class="stack" style={{ gap: "8px" }}>
                  <div class="run-title-row">
                    <RunStatusPill status={r().status} />
                    <span class="run-title">{r().title}</span>
                  </div>
                  <div class="run-meta-row">
                    <button
                      type="button"
                      class="run-id-copy mono"
                      onClick={copyRunId}
                      aria-label={`Copy run ID ${r().id}`}
                    >
                      <span ref={runIdText}>{r().id}</span>
                    </button>
                    <Show when={copyFeedback()}>
                      <span role="status">{copyFeedback()}</span>
                    </Show>
                    <span>·</span>
                    <span>{r().repoSlug}</span>
                    <Show when={r().branch}>
                      <span>·</span>
                      <span>{r().branch}</span>
                    </Show>
                    <Show when={r().prUrl}>
                      <span>·</span>
                      <a href={r().prUrl as string} target="_blank" rel="noreferrer" class="text-accent">
                        pull request ↗
                      </a>
                    </Show>
                  </div>
                  <div class="run-meta-row">
                    <span class="chip-tag">{r().resolvedProfile ?? r().profile}</span>
                    <Show when={r().taskClass}>
                      <span class="chip-tag">{r().taskClass}</span>
                    </Show>
                    <Show when={r().complexity}>
                      <span class="chip-tag">{r().complexity}</span>
                    </Show>
                    <span class="chip-tag">via {r().source}</span>
                  </div>
                </div>
                <div class="run-actions">
                  <Show when={!TERMINAL_STATUSES.includes(r().status)}>
                    <button
                      type="button"
                      class="btn btn-danger"
                      disabled={busyAction() !== null}
                      onClick={doCancel}
                    >
                      {busyAction() === "cancel" ? "Cancelling…" : "Cancel"}
                    </button>
                  </Show>
                  <Show when={TERMINAL_STATUSES.includes(r().status)}>
                    <button
                      type="button"
                      class="btn btn-primary"
                      disabled={busyAction() !== null}
                      onClick={doRetry}
                    >
                      {busyAction() === "retry" ? "Retrying…" : "Retry"}
                    </button>
                  </Show>
                </div>
              </div>

              <Show when={actionError()}>
                <div class="error-box">{actionError()}</div>
              </Show>

              <div class="stat-row">
                <div class="stat">
                  <span class="stat-label">Cost</span>
                  <span class="stat-value">
                    {r().costUsd > 0 ? (
                      money(r().costUsd)
                    ) : (
                      <span class="text-faint">{equivMoney(r().costEquivUsd)}</span>
                    )}
                  </span>
                </div>
                <div class="stat">
                  <span class="stat-label">Tokens in / out</span>
                  <span class="stat-value">
                    {compactNumber(r().tokensIn)} / {compactNumber(r().tokensOut)}
                  </span>
                </div>
                <div class="stat">
                  <span class="stat-label">Elapsed</span>
                  <span class="stat-value">{elapsed() ?? "—"}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Created</span>
                  <span class="stat-value" style={{ "font-size": "12px" }}>
                    {relativeTime(r().createdAt, now())}
                  </span>
                </div>
              </div>

              <Show when={r().error}>
                <div class="error-box">{r().error}</div>
              </Show>
            </div>

            <For each={openQuestions()}>{(q) => <QuestionCard runId={params.id} question={q} />}</For>

            <div>
              <div class="section-label">Stage timeline</div>
              <div class="card card-pad">
                <StageTimeline stages={stages()} />
              </div>
            </div>

            <div>
              <div class="section-label">Invocations</div>
              <div class="card">
                <InvocationsTable
                  invocations={invocations()}
                  selectedId={selectedInvocation()}
                  onSelect={setSelectedInvocation}
                />
              </div>
            </div>

            <div>
              <div class="section-label">Event log {connected() ? "" : "(reconnecting…)"}</div>
              <EventLog
                events={events()}
                invocationFilter={selectedInvocation()}
                onClearInvocationFilter={() => setSelectedInvocation(null)}
              />
            </div>

            <div>
              <div class="section-label">Artifacts</div>
              <ArtifactsPanel runId={params.id} artifacts={artifacts()} />
            </div>
          </>
        )}
      </Show>
    </div>
  );
};
