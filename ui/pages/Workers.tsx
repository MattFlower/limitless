import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { WorkerRun } from "../../src/db/workers.ts";
import { getWorkerRuns, getWorkers, type Worker } from "../api.ts";

export const Workers: Component = () => {
  const [workers, setWorkers] = createSignal<Worker[]>();
  const [runs, setRuns] = createSignal<WorkerRun[]>();
  const [error, setError] = createSignal("");
  const [runsUnavailable, setRunsUnavailable] = createSignal(false);
  let workersGeneration = 0;
  let runsGeneration = 0;
  const loadWorkers = async () => {
    const request = ++workersGeneration;
    try {
      const result = await getWorkers();
      if (request !== workersGeneration) return;
      setWorkers(result);
      setError("");
    } catch (err) {
      if (request === workersGeneration) setError(err instanceof Error ? err.message : String(err));
    }
  };
  const loadRuns = async () => {
    const request = ++runsGeneration;
    try {
      const result = await getWorkerRuns();
      if (request !== runsGeneration) return;
      setRuns(result);
      setRunsUnavailable(false);
    } catch {
      if (request !== runsGeneration) return;
      setRuns(undefined);
      setRunsUnavailable(true);
    }
  };
  const load = () => {
    void loadWorkers();
    void loadRuns();
  };
  onMount(() => {
    void load();
    const timer = setInterval(load, 10_000);
    window.addEventListener("focus", load);
    onCleanup(() => {
      workersGeneration++;
      runsGeneration++;
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
      <Show when={workers()} fallback={<Show when={!error()}>loading…</Show>}>
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
      <Show when={runsUnavailable()}>
        <div class="text-danger">Run history unavailable</div>
      </Show>
      <Show when={runs()} fallback={<Show when={!runsUnavailable()}>loading…</Show>}>
        <For each={runs()}>{(run) => <a href={`/runs/${run.runId}`}>{run.title || run.runId}</a>}</For>
      </Show>
    </div>
  );
};
