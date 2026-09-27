import type { Component } from "solid-js";
import { Show } from "solid-js";
import { formatCost } from "../../src/core/cost-format.ts";

export const CostCell: Component<{ costUsd: number; costEquivUsd: number }> = (props) => {
  const cost = () => formatCost(props.costUsd, props.costEquivUsd);
  return (
    <td class="num mono" title={cost().title}>
      <span class="text-faint">{cost().primary}</span>
      <Show when={cost().paid}>{(paid) => <span class="bold"> {paid()}</span>}</Show>
    </td>
  );
};
