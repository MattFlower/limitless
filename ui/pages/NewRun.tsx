import { useNavigate } from "@solidjs/router";
import type { Component } from "solid-js";
import { createSignal, For, onMount, Show } from "solid-js";
import type { Profile, RunModels } from "../../src/core/types.ts";
import { createRun, getRepos } from "../api.ts";
import { RunModelPicker } from "../components/RunModelPicker.tsx";

const PROFILES: { id: Profile; desc: string }[] = [
  { id: "auto", desc: "Let triage size the task and pick a profile automatically." },
  { id: "quick", desc: "Fast path: implement, gate, light review — no spec or verify." },
  { id: "standard", desc: "Spec, implement, gated review and acceptance verification." },
  { id: "deep", desc: "Adds planning and cross-vendor review for large or risky work." },
];

export const NewRun: Component = () => {
  const navigate = useNavigate();
  const [repos, setRepos] = createSignal<string[]>([]);
  const [repo, setRepo] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [profile, setProfile] = createSignal<Profile>("auto");
  const [models, setModels] = createSignal<RunModels>({});
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    getRepos()
      .then((list) => setRepos(list.map((r) => r.slug)))
      .catch(() => {});
  });

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!repo().trim() || !prompt().trim() || submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await createRun({
        repo: repo().trim(),
        prompt: prompt().trim(),
        ...(title().trim() ? { title: title().trim() } : {}),
        profile: profile(),
        source: "ui",
        models: models(),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">New run</h1>
      </div>
      <form class="card card-pad stack" style={{ "max-width": "760px" }} onSubmit={submit}>
        <div class="field">
          <label for="repo">Repo</label>
          <input
            id="repo"
            type="text"
            list="repo-suggestions"
            placeholder="owner/name or /absolute/local/path"
            value={repo()}
            onInput={(e) => setRepo(e.currentTarget.value)}
          />
          <datalist id="repo-suggestions">
            <For each={repos()}>{(slug) => <option value={slug} />}</For>
          </datalist>
          <span class="field-hint">A GitHub "owner/name", or an absolute path to a local git repo.</span>
        </div>

        <div class="field">
          <label for="prompt">Prompt</label>
          <textarea
            id="prompt"
            rows={10}
            placeholder="Describe the change you want the factory to make…"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
        </div>

        <div class="field">
          <label for="title">Title (optional)</label>
          <input
            id="title"
            type="text"
            placeholder="Defaults to the first line of the prompt"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>

        <div class="field">
          <span class="field-label-text">Profile</span>
          <div class="profile-grid" role="radiogroup" aria-label="Profile">
            <For each={PROFILES}>
              {(p) => (
                <label class="profile-option" classList={{ selected: profile() === p.id }}>
                  <input
                    class="visually-hidden"
                    type="radio"
                    name="profile"
                    value={p.id}
                    checked={profile() === p.id}
                    onChange={() => setProfile(p.id)}
                  />
                  <span class="profile-option-name">{p.id}</span>
                  <span class="profile-option-desc">{p.desc}</span>
                </label>
              )}
            </For>
          </div>
        </div>

        <details open={error()?.startsWith("models") || undefined}>
          <summary>Models (optional)</summary>
          <RunModelPicker models={models()} onChange={setModels} error={error()} />
        </details>

        <Show when={error()}>
          <div class="error-box">{error()}</div>
        </Show>

        <div>
          <button
            type="submit"
            class="btn btn-primary"
            disabled={submitting() || !repo().trim() || !prompt().trim()}
          >
            {submitting() ? "Queuing…" : "Start run"}
          </button>
        </div>
      </form>
    </div>
  );
};
