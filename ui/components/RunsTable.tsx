import { useNavigate } from "@solidjs/router";
import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import type { Run } from "../../src/core/types.ts";
import { duration, relativeTime, truncate } from "../lib/format.ts";
import { now } from "../lib/ticker.ts";
import { CostCell } from "./CostCell.tsx";
import { RunStatusPill } from "./StatusPill.tsx";

function runDuration(run: Run, nowMs: number): string {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? (run.status === "running" || run.status === "waiting_input" ? nowMs : start);
  return duration(end - start);
}

export const RunsTable: Component<{ runs: Run[] }> = (props) => {
  const navigate = useNavigate();
  return (
    <table class="table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Title</th>
          <th>Repo</th>
          <th>Stage</th>
          <th>Source</th>
          <th>Profile</th>
          <th class="num">Cost</th>
          <th class="num">Duration</th>
          <th class="num">Created</th>
        </tr>
      </thead>
      <tbody>
        <Show
          when={props.runs.length > 0}
          fallback={
            <tr class="empty-row">
              <td colspan={9}>No runs match this filter.</td>
            </tr>
          }
        >
          <For each={props.runs}>
            {(run) => (
              <tr class="clickable" onClick={() => navigate(`/runs/${run.id}`)}>
                <td>
                  <RunStatusPill status={run.status} />
                  <Show when={run.status === "waiting"}>
                    <div>waiting for {run.dependsOn.join(", ")} to merge</div>
                  </Show>
                </td>
                <td title={run.title}>{truncate(run.title, 64)}</td>
                <td class="mono text-dim">{run.repoSlug}</td>
                <td class="mono text-faint">{run.stage ?? "—"}</td>
                <td class="mono text-faint">{run.source}</td>
                <td class="mono text-faint">{run.resolvedProfile ?? run.profile}</td>
                <CostCell costUsd={run.costUsd} costEquivUsd={run.costEquivUsd} />
                <td class="num mono">{runDuration(run, now())}</td>
                <td class="num mono text-faint" title={new Date(run.createdAt).toLocaleString()}>
                  {relativeTime(run.createdAt, now())}
                </td>
              </tr>
            )}
          </For>
        </Show>
      </tbody>
    </table>
  );
};
