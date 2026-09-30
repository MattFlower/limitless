import type { Component, JSX } from "solid-js";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { ArtifactMeta } from "../../src/core/types.ts";
import { getArtifact } from "../api.ts";
import { duration } from "../lib/format.ts";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

interface GateResultJson {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}
interface GateComparisonJson {
  name: string;
  verdict: string;
  blocking: boolean;
  result: GateResultJson;
  firstAttempt?: GateResultJson;
}
interface GateRunJson {
  setupOk: boolean;
  setup: GateResultJson[];
  checks: GateResultJson[];
}
interface ReviewFindingJson {
  severity: "blocker" | "major" | "minor" | "nit";
  file: string;
  line: number;
  title: string;
  detail: string;
  suggestion: string;
}
interface ReviewJson {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: ReviewFindingJson[];
  model?: string;
}
interface VerifyCriterionJson {
  id: string;
  status: "met" | "unmet" | "unclear" | "blocked";
  evidence: string;
  requirement?: "request" | "spec" | "not_required" | null;
}
interface VerifyJson {
  criteria: VerifyCriterionJson[];
  overall: "pass" | "fail";
  notes: string;
  model?: string;
  modelId?: string;
}

function isGateResult(v: unknown): v is GateResultJson {
  const o = v as Record<string, unknown>;
  return !!o && typeof o.name === "string" && typeof o.ok === "boolean" && typeof o.durationMs === "number";
}
function isGateRun(v: unknown): v is GateRunJson {
  const o = v as Record<string, unknown>;
  return !!o && typeof o.setupOk === "boolean" && Array.isArray(o.setup) && Array.isArray(o.checks);
}
function isGateComparisonList(v: unknown): v is GateComparisonJson[] {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        c &&
        typeof c === "object" &&
        "verdict" in c &&
        "result" in c &&
        isGateResult((c as { result: unknown }).result),
    )
  );
}
function isReview(v: unknown): v is ReviewJson {
  const o = v as Record<string, unknown>;
  return !!o && (o.verdict === "approve" || o.verdict === "request_changes") && Array.isArray(o.findings);
}
function isVerify(v: unknown): v is VerifyJson {
  const o = v as Record<string, unknown>;
  return !!o && (o.overall === "pass" || o.overall === "fail") && Array.isArray(o.criteria);
}

const GateOutputRow: Component<{ r: GateResultJson; label: string; badgeClass: string }> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <tr class="clickable" onClick={() => setOpen(!open())}>
        <td class="mono">{props.r.name}</td>
        <td>
          <span class={`badge badge-${props.badgeClass}`}>{props.label}</span>
        </td>
        <td class="mono text-faint" title={props.r.command}>
          {props.r.command}
        </td>
        <td class="num mono">{props.r.exitCode ?? "—"}</td>
        <td class="num mono">{duration(props.r.durationMs)}</td>
      </tr>
      <Show when={open()}>
        <tr>
          <td colspan={5}>
            <pre class="log-detail">{props.r.output || "(no output)"}</pre>
          </td>
        </tr>
      </Show>
    </>
  );
};

function verdictBadge(v: string): string {
  if (v === "pass" || v === "fixed" || v === "new_pass") return "pass";
  if (v === "regressed" || v === "new_failure") return "fail";
  return "warn";
}

const GatesArtifact: Component<{ data: GateRunJson | GateComparisonJson[] }> = (props) => (
  <div class="card">
    <table class="table">
      <thead>
        <tr>
          <th>Check</th>
          <th>Result</th>
          <th>Command</th>
          <th class="num">Exit</th>
          <th class="num">Duration</th>
        </tr>
      </thead>
      <tbody>
        <Show
          when={Array.isArray(props.data)}
          fallback={
            <>
              <For each={(props.data as GateRunJson).setup}>
                {(r) => (
                  <GateOutputRow r={r} label={r.ok ? "pass" : "fail"} badgeClass={r.ok ? "pass" : "fail"} />
                )}
              </For>
              <For each={(props.data as GateRunJson).checks}>
                {(r) => (
                  <GateOutputRow r={r} label={r.ok ? "pass" : "fail"} badgeClass={r.ok ? "pass" : "fail"} />
                )}
              </For>
            </>
          }
        >
          <For each={props.data as GateComparisonJson[]}>
            {(c) => (
              <>
                <GateOutputRow r={c.result} label={c.verdict} badgeClass={verdictBadge(c.verdict)} />
                <Show when={c.firstAttempt}>
                  {(first) => <GateOutputRow r={first()} label="first attempt" badgeClass="fail" />}
                </Show>
              </>
            )}
          </For>
        </Show>
      </tbody>
    </table>
  </div>
);

const ReviewArtifact: Component<{ data: ReviewJson }> = (props) => (
  <div class="stack" style={{ gap: "12px" }}>
    <div class="card card-pad" style={{ display: "flex", "align-items": "center", gap: "10px" }}>
      <span class={`pill ${props.data.verdict === "approve" ? "pill-succeeded" : "pill-waiting_input"}`}>
        {props.data.verdict.replace("_", " ")}
      </span>
      <span class="text-dim">{props.data.summary}</span>
      <Show when={props.data.model}>
        <span class="text-faint mono" style={{ "margin-left": "auto" }}>
          {props.data.model}
        </span>
      </Show>
    </div>
    <For each={props.data.findings}>
      {(f) => (
        <div class="finding">
          <div class="finding-head">
            <span class={`badge badge-${f.severity}`}>{f.severity}</span>
            <span class="finding-title">{f.title}</span>
            <Show when={f.file}>
              <span class="finding-loc">
                {f.file}
                {f.line ? `:${f.line}` : ""}
              </span>
            </Show>
          </div>
          <div class="finding-detail">{f.detail}</div>
          <Show when={f.suggestion}>
            <div class="finding-suggestion">{f.suggestion}</div>
          </Show>
        </div>
      )}
    </For>
    <Show when={props.data.findings.length === 0}>
      <div class="text-faint mono">No findings.</div>
    </Show>
  </div>
);

export const VerifyArtifact: Component<{ data: VerifyJson }> = (props) => (
  <div class="stack" style={{ gap: "12px" }}>
    <div class="card card-pad" style={{ display: "flex", "align-items": "center", gap: "10px" }}>
      <span class={`pill ${props.data.overall === "pass" ? "pill-succeeded" : "pill-failed"}`}>
        {props.data.overall}
      </span>
      <span class="text-dim">{props.data.notes}</span>
      <Show when={props.data.modelId ?? props.data.model}>
        <span class="text-faint mono" style={{ "margin-left": "auto" }}>
          {props.data.modelId ?? props.data.model}
        </span>
      </Show>
    </div>
    <table class="table">
      <thead>
        <tr>
          <th>Criterion</th>
          <th>Status</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.data.criteria}>
          {(c) => (
            <tr>
              <td class="mono">{c.id}</td>
              <td>
                <span class={`badge badge-${c.status}`}>
                  {c.status === "blocked"
                    ? "🚧 blocked"
                    : c.status === "unmet" && c.requirement === "not_required"
                      ? "unmet (not required)"
                      : c.status}
                </span>
              </td>
              <td class="text-dim">{c.evidence}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  </div>
);

function renderContentEl(name: string, content: string): JSX.Element {
  if (name.endsWith(".md")) return <Markdown text={content} />;
  if (name === "diff.patch") return <DiffView patch={content} />;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return <pre class="log-detail">{content}</pre>;
  }
  if ((name.startsWith("review-") || name === "review.json") && isReview(parsed)) {
    return <ReviewArtifact data={parsed} />;
  }
  if ((name.startsWith("verify-") || name === "verify.json") && isVerify(parsed)) {
    return <VerifyArtifact data={parsed} />;
  }
  if (
    (name.startsWith("gates-") || name === "baseline-gates.json") &&
    (isGateRun(parsed) || isGateComparisonList(parsed))
  ) {
    return <GatesArtifact data={parsed} />;
  }
  return <pre class="log-detail">{JSON.stringify(parsed, null, 2)}</pre>;
}

export const ArtifactsPanel: Component<{ runId: string; artifacts: ArtifactMeta[] }> = (props) => {
  const [active, setActive] = createSignal<string | null>(props.artifacts[0]?.name ?? null);
  const [cache, setCache] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal(false);

  createEffect(() => {
    const name = active();
    if (!name || cache()[name] !== undefined) return;
    setLoading(true);
    getArtifact(props.runId, name)
      .then((text) => setCache((c) => ({ ...c, [name]: text })))
      .catch((e) => setCache((c) => ({ ...c, [name]: `(failed to load: ${(e as Error).message})` })))
      .finally(() => setLoading(false));
  });

  createEffect(() => {
    if (active() === null && props.artifacts.length) setActive(props.artifacts[0]?.name ?? null);
  });

  return (
    <div>
      <div class="tabs">
        <For each={props.artifacts}>
          {(a) => (
            <button
              type="button"
              class="tab"
              classList={{ active: active() === a.name }}
              onClick={() => setActive(a.name)}
            >
              {a.name}
            </button>
          )}
        </For>
      </div>
      <Show when={props.artifacts.length === 0}>
        <div class="text-faint mono" style={{ padding: "10px 0" }}>
          No artifacts yet.
        </div>
      </Show>
      <Show when={active() && cache()[active() as string] !== undefined}>
        {renderContentEl(active() as string, cache()[active() as string] as string)}
      </Show>
      <Show when={active() && cache()[active() as string] === undefined && loading()}>
        <div class="centered-hint">
          <span class="spinner" /> &nbsp;loading {active()}…
        </div>
      </Show>
    </div>
  );
};
