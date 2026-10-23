import { type Component, createMemo, For, Show } from "solid-js";
import type { Run, StageName } from "../../src/core/types.ts";
import { PIPELINE, pipelineCounts } from "../lib/pipeline.ts";

const column = (stage: StageName) => PIPELINE.findIndex((s) => s.stage === stage) + 1;
/** The implement ⇄ gates/audit/review/preview/verify loop, as a grid-column span. */
const loop = `${column("implement")} / ${column("verify") + 1}`;

export const PipelineMap: Component<{
  runs: readonly Run[];
  delivered?: { succeeded: number; runs: number };
}> = (props) => {
  const counts = createMemo(() => pipelineCounts(props.runs));
  const waiting = () => counts().queued + counts().blocked;
  return (
    <section class="card pipeline" aria-labelledby="pipeline-title">
      <div class="pipeline-head">
        <h2 id="pipeline-title" class="card-title">
          Pipeline, right now
        </h2>
        <span class="text-dim">Active runs at each stage · dashed stages run only when needed</span>
      </div>
      <div class="pipeline-body">
        <div class="pipeline-cap pipeline-cap-queue">
          <span class="pipeline-cap-label">Queue</span>
          <span class="pipeline-cap-value">{waiting()}</span>
          <span class="pipeline-cap-sub">
            {counts().blocked > 0 ? `${counts().blocked} waiting on dependencies` : "next to start"}
          </span>
        </div>
        <div class="pipeline-scroll">
          <div
            class="pipeline-grid"
            style={{ "grid-template-columns": `repeat(${PIPELINE.length}, minmax(0, 1fr))` }}
          >
            <span
              class="pipeline-line"
              aria-hidden="true"
              style={{
                left: `calc(100% / ${PIPELINE.length * 2})`,
                right: `calc(100% / ${PIPELINE.length * 2})`,
              }}
            />
            <ol class="pipeline-stations">
              <For each={PIPELINE}>
                {(s) => {
                  const active = () => counts().active[s.stage] ?? 0;
                  const asking = () => counts().asking[s.stage] ?? 0;
                  return (
                    <li
                      class="pipeline-station"
                      classList={{ busy: active() > 0, asking: asking() > 0, optional: s.optional === true }}
                    >
                      <span class="pipeline-count">{active()}</span>
                      <span class="pipeline-dot" aria-hidden="true" />
                      <span class="pipeline-name">
                        <span class="visually-hidden">{active() === 1 ? " run at " : " runs at "}</span>
                        {s.stage}
                        <Show when={asking() > 0}>
                          <span class="visually-hidden">, {asking()} waiting on you</span>
                        </Show>
                      </span>
                    </li>
                  );
                }}
              </For>
            </ol>
            <div class="pipeline-loop" aria-hidden="true" style={{ "grid-column": loop }} />
            <div class="pipeline-loop-label" style={{ "grid-column": loop }}>
              implement ⇄ checks · failures feed back
            </div>
          </div>
        </div>
        <Show when={props.delivered}>
          {(d) => (
            <div class="pipeline-cap pipeline-cap-done">
              <span class="pipeline-cap-label">Succeeded</span>
              <span class="pipeline-cap-value">{d().succeeded}</span>
              <span class="pipeline-cap-sub">
                of {d().runs} {d().runs === 1 ? "run" : "runs"} in 14 days
                {d().runs > 0 ? ` · ${Math.round((d().succeeded / d().runs) * 100)}%` : ""}
              </span>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
};
