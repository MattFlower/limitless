import type { Component } from "solid-js";
import type { ProviderStatus, RunStatus } from "../../src/core/types.ts";

const RUN_LABEL: Record<RunStatus, string> = {
  waiting: "waiting",
  queued: "queued",
  running: "running",
  waiting_input: "waiting on you",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  needs_human: "needs human",
  resolved: "resolved",
};

export const RunStatusPill: Component<{ status: RunStatus }> = (props) => (
  <span class={`pill pill-${props.status}`}>{RUN_LABEL[props.status]}</span>
);

const PROVIDER_LABEL: Record<ProviderStatus["state"], string> = {
  ok: "ok",
  degraded: "degraded",
  down: "down",
  exhausted: "exhausted",
  disabled: "disabled",
};

export const ProviderStatePill: Component<{ state: ProviderStatus["state"] }> = (props) => (
  <span class={`pill pill-${props.state}`}>{PROVIDER_LABEL[props.state]}</span>
);

const STAGE_LABEL: Record<string, string> = {
  running: "running",
  succeeded: "ok",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
};

export const StageStatusBadge: Component<{ status: string }> = (props) => (
  <span
    class={`badge badge-${props.status === "succeeded" ? "pass" : props.status === "failed" ? "fail" : "info"}`}
  >
    {STAGE_LABEL[props.status] ?? props.status}
  </span>
);
