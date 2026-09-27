import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { roleDescription } from "../../src/core/role-descriptions.ts";
import type { Invocation, Role } from "../../src/core/types.ts";
import { compactNumber, duration, equivMoney, money, truncate } from "../lib/format.ts";
import { invocationModelLabel } from "../lib/invocation-model.ts";
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

const RoleHelp: Component<{ role: Role; id: number }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ top: 0, left: 0 });
  let button: HTMLButtonElement | undefined;
  const show = () => {
    const rect = button?.getBoundingClientRect();
    if (rect) {
      setPosition({
        top: rect.bottom + 100 > window.innerHeight ? rect.top - 100 : rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 308)),
      });
    }
    setOpen(true);
  };
  onMount(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!button?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    onCleanup(() => document.removeEventListener("pointerdown", closeOutside));
  });
  return (
    <span class="role-help">
      <button
        ref={button}
        type="button"
        class="role-help-button"
        aria-label={`About ${props.role} role`}
        aria-describedby={open() ? `role-help-${props.id}` : undefined}
        aria-expanded={open()}
        onPointerEnter={show}
        onPointerLeave={() => {
          if (document.activeElement !== button) setOpen(false);
        }}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.stopPropagation();
          show();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            button?.blur();
          }
        }}
      >
        ?
      </button>
      <span
        id={`role-help-${props.id}`}
        class="role-help-tooltip"
        role="tooltip"
        data-open={open()}
        aria-hidden={!open()}
        style={{ top: `${position().top}px`, left: `${position().left}px` }}
      >
        {roleDescription(props.role)}
      </span>
    </span>
  );
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
            <td colspan={10}>No invocations yet.</td>
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
              <td class="mono">
                {inv.role} <RoleHelp role={inv.role} id={inv.id} />
              </td>
              <td class="mono text-accent">{invocationModelLabel(inv)}</td>
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
