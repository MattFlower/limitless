import type { Invocation, Role, Run } from "../core/types.ts";
import type { TestWait } from "../gates/agent-tests.ts";
import { withScratch } from "../harness/scratch.ts";
import { withSlottedCommands } from "../harness/slotted.ts";
import type { SlottedCommands } from "../harness/slotted-config.ts";
import type { AgentResult, AgentSpec, Harness } from "../harness/types.ts";

export interface AgentCall {
  runId: Run["id"];
  invocationId: Invocation["id"];
  role: Role;
  repoSlug: string;
  worktree: string;
  spec: AgentSpec;
  slottedCommands: SlottedCommands;
  shadow: boolean;
  private: boolean;
  denyRead: AgentSpec["denyRead"];
  dispatch: () => void;
}

export interface AgentExecutor {
  kind: string;
  run(call: AgentCall, local: () => Promise<AgentResult>): Promise<AgentResult>;
}

export const localAgentExecutor: AgentExecutor = {
  kind: "local",
  run: (_call, local) => local(),
};

/** One lifecycle for tool-enabled sessions, on the coordinator or a worker. */
export function runToolAgent(
  spec: AgentSpec,
  harness: Harness,
  commands: SlottedCommands,
  port?: number,
  onSlotEvent: (data: TestWait) => void = () => {},
  dispatch?: () => void,
): Promise<AgentResult> {
  return withScratch(spec.cwd, (scratchDir) => {
    dispatch?.();
    return withSlottedCommands(
      commands,
      spec.cwd,
      scratchDir,
      port,
      onSlotEvent,
      (commandPath, idleNow) =>
        harness({ ...spec, scratchDir, idleNow, ...(commandPath ? { commandPath } : {}) }),
      (active, elapsedMs) =>
        spec.onEvent({
          type: "status",
          text: active
            ? "Idle watchdog held off for slotted command"
            : `Idle watchdog resumed after ${elapsedMs}ms held off for slotted command`,
        }),
    );
  });
}
