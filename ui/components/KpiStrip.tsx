import type { Component } from "solid-js";
import type { Stats } from "../../src/db/stats.ts";
import { money } from "../lib/format.ts";

export const KpiStrip: Component<{ totals: Stats["totals"] }> = (props) => (
  <div class="kpi-strip">
    <div class="kpi">
      <span class="kpi-label">Active</span>
      <span class="kpi-value accent">{props.totals.active}</span>
      <span class="kpi-sub">running / waiting</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Queued</span>
      <span class="kpi-value">{props.totals.queued}</span>
      <span class="kpi-sub">next to start</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Succeeded (14d)</span>
      <span class="kpi-value">
        {props.totals.succeeded}
        <span class="text-faint" style={{ "font-size": "14px" }}>
          {" "}
          / {props.totals.runs}
        </span>
      </span>
      <span class="kpi-sub">
        {props.totals.runs
          ? `${Math.round((props.totals.succeeded / props.totals.runs) * 100)}% success`
          : "—"}
      </span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Needs you (14d)</span>
      <span class="kpi-value">{props.totals.openNeedsHuman}</span>
      <span class="kpi-sub">{Math.round(props.totals.openNeedsHumanRate * 100)}% of runs</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Real spend (14d)</span>
      <span class="kpi-value">{money(props.totals.costUsd)}</span>
      <span class="kpi-sub">metered providers</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">API-equivalent work (14d)</span>
      <span class="kpi-value text-faint">{money(props.totals.costEquivUsd)}</span>
      <span class="kpi-sub">what it would've cost at list price</span>
    </div>
  </div>
);
