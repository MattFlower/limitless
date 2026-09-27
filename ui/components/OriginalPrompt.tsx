import type { Component } from "solid-js";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

export async function copyPrompt(prompt: string, clipboard: Pick<Clipboard, "writeText"> | undefined) {
  try {
    if (!clipboard) throw new Error("Clipboard unavailable");
    await clipboard.writeText(prompt);
    return "Prompt copied";
  } catch {
    return "Could not copy prompt";
  }
}

export const OriginalPrompt: Component<{ prompt: string }> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  const [feedback, setFeedback] = createSignal<string | null>(null);
  let promptText: HTMLDivElement | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    if (!promptText) return;
    const text = promptText;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
      setOverflows(text.getBoundingClientRect().height > lineHeight * 4 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    onCleanup(() => observer.disconnect());
  });

  onCleanup(() => {
    if (feedbackTimer) clearTimeout(feedbackTimer);
  });

  const copy = async () => {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    setFeedback(null);
    setFeedback(await copyPrompt(props.prompt, navigator.clipboard));
    feedbackTimer = setTimeout(() => setFeedback(null), 2500);
  };

  return (
    <section aria-label="Original prompt">
      <div class="section-label">Original prompt</div>
      <div class="card card-pad original-prompt-card">
        <div class="original-prompt-viewport" classList={{ collapsed: !expanded() }}>
          <div id="original-prompt-text" class="original-prompt-text" ref={promptText}>
            {props.prompt}
          </div>
        </div>
        <div class="original-prompt-actions">
          <Show when={overflows()}>
            <button
              type="button"
              class="btn"
              aria-controls="original-prompt-text"
              aria-expanded={expanded()}
              onClick={() => setExpanded(!expanded())}
            >
              {expanded() ? "Show less" : "Show more"}
            </button>
          </Show>
          <button type="button" class="btn" onClick={copy}>
            Copy prompt
          </button>
          <Show when={feedback()}>
            <span role="status">{feedback()}</span>
          </Show>
        </div>
      </div>
    </section>
  );
};
