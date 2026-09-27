import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { effortLabel } from "../../src/core/effort-format.ts";
import type { Invocation } from "../../src/core/types.ts";
import { compactNumber, duration, equivMoney, money, truncate } from "../lib/format.ts";
import { now } from "../lib/ticker.ts";

const STATUS_BADGE: Record<string, string> = {
  ok: "pass",
  error: "fail",
  cancelled: "info",
  timeout: "warn",
  stuck: "warn",
  quota: "warn",
  unavailable: "warn",
  running: "info",
};

export const InvocationsTable: Component<{
  invocations: Invocation[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}> = (props) => (
  <table class="table">
    <thead>
      <tr>
        <th>Role</th>
        <th>Model</th>
        <th>Effort</th>
        <th>Provider</th>
        <th>Status</th>
        <th class="num">In</th>
        <th class="num">Out</th>
        <th class="num">Cost</th>
        <th class="num">Turns</th>
        <th class="num">Duration</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
      <Show
        when={props.invocations.length > 0}
        fallback={
          <tr class="empty-row">
            <td colspan={11}>No invocations yet.</td>
          </tr>
        }
      >
        <For each={props.invocations}>
          {(inv) => (
            <tr
              class="clickable"
              style={{
                background: props.selectedId === inv.id ? "var(--bg-hover)" : undefined,
              }}
              onClick={() => props.onSelect(props.selectedId === inv.id ? null : inv.id)}
              title="Click to filter the event log to this invocation"
            >
              <td class="mono">{inv.role}</td>
              <td class="mono text-accent">{inv.modelId}</td>
              <td>{effortLabel(inv.effort)}</td>
              <td class="mono text-faint">{inv.provider}</td>
              <td>
                <span class={`badge badge-${STATUS_BADGE[inv.status] ?? "info"}`}>{inv.status}</span>
              </td>
              <td class="num mono">{compactNumber(inv.inputTokens)}</td>
              <td class="num mono">{compactNumber(inv.outputTokens)}</td>
              <td class="num mono">
                <Show
                  when={inv.costUsd > 0}
                  fallback={<span class="text-faint">{equivMoney(inv.costEquivUsd)}</span>}
                >
                  <span class="bold">{money(inv.costUsd)}</span>
                </Show>
              </td>
              <td class="num mono">{inv.numTurns}</td>
              <td class="num mono">{duration((inv.finishedAt ?? now()) - inv.startedAt)}</td>
              <td class="text-danger" title={inv.error ?? ""}>
                {inv.error ? truncate(inv.error, 40) : ""}
              </td>
            </tr>
          )}
        </For>
      </Show>
    </tbody>
  </table>
);
