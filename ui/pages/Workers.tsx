import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { WorkerRun } from "../../src/db/workers.ts";
import { getWorkerRuns, getWorkers, type Worker } from "../api.ts";

export const Workers: Component = () => {
  const [workers, setWorkers] = createSignal<Worker[]>();
  const [runs, setRuns] = createSignal<WorkerRun[]>([]);
  const [error, setError] = createSignal("");
  let generation = 0;
  const load = async () => {
    const request = ++generation;
    try {
      const [workers, runs] = await Promise.all([getWorkers(), getWorkerRuns()]);
      if (request !== generation) return;
      setWorkers(workers);
      setRuns(runs);
      setError("");
    } catch (err) {
      if (request === generation) setError(err instanceof Error ? err.message : String(err));
    }
  };
  onMount(() => {
    void load();
    const timer = setInterval(load, 10_000);
    window.addEventListener("focus", load);
    onCleanup(() => {
      generation++;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    });
  });
  return (
    <div class="page stack">
      <h1 class="page-title">Workers</h1>
      <Show when={error()}>
        <div class="text-danger">{error()}</div>
      </Show>
      <Show when={workers()} fallback={<div>loading…</div>}>
        <Show when={workers()?.length === 0}>
          <div>No paired workers</div>
        </Show>
        <For each={workers()}>
          {(w) => (
            <section class="card stack">
              <h2>{w.name}</h2>
              <div>
                {w.state} · Last heartbeat:{" "}
                {w.lastHeartbeatAt == null ? "unknown" : new Date(w.lastHeartbeatAt).toLocaleString()}
              </div>
              <div>Release: {w.capabilities?.releaseSha?.slice(0, 7) ?? "unknown"}</div>
              <For each={["claude", "codex"] as const}>
                {(cli) => (
                  <div>
                    {cli}: {w.agents?.[cli]?.version ?? "unavailable"} ·{" "}
                    {w.agents?.[cli] ? (w.agents?.[cli]?.loggedIn ? "logged in" : "logged out") : "unknown"}
                  </div>
                )}
              </For>
              <div>
                Private strings:{" "}
                {w.privateStrings === "match" || w.privateStrings === "differs"
                  ? w.privateStrings
                  : "unknown"}
              </div>
              <Show when={w.state === "pending" && w.code}>
                <div>Pairing code: {w.code}</div>
              </Show>
              <Show when={w.setupWarning}>
                <div class="text-danger">{w.setupWarning}</div>
              </Show>
              <For each={w.agentJobs ?? []}>
                {(job) => (
                  <div>
                    {job.id} · Attempt {job.attempt} · <a href={`/runs/${job.runId}`}>{job.runId}</a>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </Show>
      <h2 class="section-label">Runs that used workers</h2>
      <For each={runs()}>{(run) => <a href={`/runs/${run.runId}`}>{run.title || run.runId}</a>}</For>
    </div>
  );
};
