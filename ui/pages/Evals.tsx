import { useParams } from "@solidjs/router";
import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { effortLabel } from "../../src/core/effort-format.ts";
import { formatEvalReport } from "../../src/evals/format.ts";
import type { EvalPolicyResponse } from "../../src/evals/policy.ts";
import type { EvalReport } from "../../src/evals/stats.ts";
import { getEvalPolicy, getEvalReport } from "../api.ts";
import { evalMatrix } from "../lib/evals.ts";
import { money } from "../lib/format.ts";

export const EvalsView: Component<{ data?: EvalPolicyResponse; error?: string }> = (props) => (
  <div class="page stack">
    <h1 class="page-title">Evals</h1>
    <Show when={props.error}>
      <p role="alert">{props.error}</p>
    </Show>
    <Show when={props.data} fallback={!props.error && <p>Loading evals…</p>}>
      {(data) => (
        <>
          <h2>Eligibility matrix</h2>
          <p>Latest completed evidence under current daemon floors. Select a result to inspect its run.</p>
          <details>
            <summary>Current settings</summary>
            <pre>{JSON.stringify(data().evaluation.settings, null, 2)}</pre>
          </details>
          <div class="card">
            <table class="table">
              <thead>
                <tr>
                  <th>Role / model</th>
                  <For each={evalMatrix(data()).models}>{(model) => <th>{model}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={evalMatrix(data()).rows}>
                  {(row) => (
                    <tr>
                      <th>{row.role}</th>
                      <For each={row.cells}>
                        {(cell) => (
                          <td title={cell.reasons.join("; ")}>
                            <span
                              class={`badge ${cell.state === "eligible" ? "badge-pass" : cell.state === "ineligible" ? "badge-error" : cell.state === "insufficient evidence" ? "badge-warn" : "badge-info"}`}
                            >
                              <Show when={cell.href} fallback={cell.state}>
                                {(href) => <a href={href()}>{cell.state}</a>}
                              </Show>
                            </span>
                            <Show when={cell.candidate}>
                              <div>Effort: {effortLabel(cell.candidate?.summary.effort)}</div>
                            </Show>
                            <For each={cell.candidate?.metrics}>
                              {(metric) => (
                                <div>
                                  {metric.name}:{" "}
                                  {metric.rate === null ? "n/a" : `${(metric.rate * 100).toFixed(1)}%`} (
                                  {metric.numerator}/{metric.denominator}); CI{" "}
                                  {metric.ci?.map((n) => `${(n * 100).toFixed(1)}%`).join(" – ") ?? "n/a"}
                                </div>
                              )}
                            </For>
                            <Show when={cell.costPerCase !== null}>
                              <div>Estimated cost/case: ${cell.costPerCase?.toFixed(4)}</div>
                            </Show>
                            <Show when={cell.comparison}>
                              {(comparison) => (
                                <div>
                                  vs {comparison().bestModel ?? "n/a"}: paired {comparison().pairedCases},
                                  lower {comparison().lowerBound?.toFixed(4) ?? "n/a"};{" "}
                                  {comparison().nonInferior === null
                                    ? "insufficient pairs"
                                    : comparison().nonInferior
                                      ? "non-inferior"
                                      : "non-inferiority not established"}
                                </div>
                              )}
                            </Show>
                            <Show when={cell.availabilityFallback}>
                              <div>Availability fallback</div>
                            </Show>
                            <Show when={cell.reasons.length}>
                              <details>
                                <summary>Reasons</summary>
                                {cell.reasons.join("; ")}
                              </details>
                            </Show>
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <For each={evalMatrix(data()).rows.filter((r) => r.decision)}>{(r) => <p>{r.decision}</p>}</For>
          <For each={data().evaluation.roles.filter((r) => !r.order.length)}>
            {(r) => (
              <Show when={r.role !== "implement"}>
                <p>{r.decision}</p>
              </Show>
            )}
          </For>
          <h2>Eval runs</h2>
          <Show when={data().runs.length} fallback={<p>No eval runs yet.</p>}>
            <div class="card">
              <table class="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Role</th>
                    <th>Models</th>
                    <th>k</th>
                    <th>Status</th>
                    <th>Metered cost</th>
                    <th>API-equivalent cost</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={data().runs}>
                    {(run) => (
                      <tr>
                        <td>
                          <a href={`/evals/${encodeURIComponent(run.id)}`}>{run.id}</a>
                        </td>
                        <td>{run.role}</td>
                        <td>{run.models.join(", ")}</td>
                        <td>{run.k}</td>
                        <td>{run.status}</td>
                        <td>{money(run.costUsd)}</td>
                        <td>{money(run.costEquivUsd)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </>
      )}
    </Show>
  </div>
);

export const EvalDetailView: Component<{ report?: EvalReport; error?: string }> = (props) => (
  <div class="page stack">
    <a href="/evals">← Evals</a>
    <h1 class="page-title">Eval run detail</h1>
    <Show when={props.error}>
      <p role="alert">{props.error}</p>
    </Show>
    <Show when={props.report} fallback={!props.error && <p>Loading eval report…</p>}>
      {(report) => (
        <>
          <h2>Model metrics and paired comparisons</h2>
          <p>
            Comparisons below use this run. The matrix compares the latest completed evidence across runs.
          </p>
          <pre class="eval-report card">{formatEvalReport(report())}</pre>
          <h2>Case trials</h2>
          <Show when={report().trials.length} fallback={<p>No trials recorded.</p>}>
            <div class="card">
              <table class="table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Model</th>
                    <th>Effort</th>
                    <th>Repetition</th>
                    <th>Status</th>
                    <th>Pass / score</th>
                    <th>Grading, error, skip and cache details</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={report().trials}>
                    {(t) => (
                      <tr>
                        <td>{t.caseId}</td>
                        <td>{t.modelId}</td>
                        <td>{effortLabel(t.effort)}</td>
                        <td>{t.trial}</td>
                        <td>{t.status}</td>
                        <td>
                          {String(t.pass ?? "n/a")} / {t.score ?? "n/a"}
                        </td>
                        <td>
                          <pre class="eval-report">{JSON.stringify(t.details, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </>
      )}
    </Show>
  </div>
);
export const Evals: Component = () => {
  const [data, setData] = createSignal<EvalPolicyResponse>();
  const [error, setError] = createSignal<string>();
  onMount(() => {
    void getEvalPolicy()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  });
  return <EvalsView data={data()} error={error()} />;
};
export const EvalDetail: Component = () => {
  const params = useParams();
  const [report, setReport] = createSignal<EvalReport>();
  const [error, setError] = createSignal<string>();
  onMount(() => {
    void getEvalReport(params.id ?? "")
      .then(setReport)
      .catch((e: Error) => setError(e.message));
  });
  return <EvalDetailView report={report()} error={error()} />;
};
