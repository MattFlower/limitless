import type { Invocation, Role, Run } from "../core/types.ts";
import type { SlottedCommands } from "../harness/slotted-config.ts";
import type { AgentResult, AgentSpec } from "../harness/types.ts";

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
