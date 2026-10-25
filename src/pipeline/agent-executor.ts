import type { Invocation, Role, Run } from "../core/types.ts";
import type { AgentJobRequest } from "../db/workers.ts";
import type { FactoryGateHandler, TestWait } from "../gates/agent-tests.ts";
import { redactGateOutput } from "../gates/output.ts";
import { runLocalGates } from "../gates/run.ts";
import { discardChanges } from "../git/repos.ts";
import { withScratch } from "../harness/scratch.ts";
import { withSlottedCommands } from "../harness/slotted.ts";
import type { AgentFullSuite, SlottedCommands } from "../harness/slotted-config.ts";
import type { AgentResult, AgentSpec, Harness } from "../harness/types.ts";

/** Publication inputs owned by the engine; session inputs are supplied by the executor. */
export type AgentPublication = Required<
  Pick<
    AgentJobRequest,
    | "parentSha"
    | "baseSha"
    | "branch"
    | "commit"
    | "repoUrl"
    | "expectedRemoteSha"
    | "discreet"
    | "privateStringsDigest"
  >
> &
  Pick<AgentJobRequest, "uiUrl">;

export interface AgentPublicationHooks {
  started(id: string): Promise<void>;
  retired(id: string): Promise<void>;
  resume(request: AgentPublication): Promise<boolean>;
  prepare(): Promise<AgentPublication | null>;
  adopt(sha: string, request: AgentPublication): Promise<void>;
  remoteSha(): Promise<string | null | undefined>;
}

export interface AgentCall {
  runId: Run["id"];
  invocationId: Invocation["id"];
  role: Role;
  repoSlug: string;
  worktree: string;
  spec: AgentSpec;
  slottedCommands: SlottedCommands;
  agentFullSuite?: AgentFullSuite;
  readerSetup?: string[];
  shadow: boolean;
  private: boolean;
  denyRead: AgentSpec["denyRead"];
  dispatch: () => void;
  publication?: AgentPublicationHooks;
  checkout?: { parentSha: string; baseSha: string; branch: string };
  round?: number;
  agentJob?: { round: number; id: string };
}

export interface AgentExecutor {
  kind: string;
  run(call: AgentCall, local: () => Promise<AgentResult>): Promise<AgentResult>;
}

export const localAgentExecutor: AgentExecutor = {
  kind: "local",
  run: (_call, local) => local(),
};

/** Factory-owned setup: readers retain write access only to their invocation scratch. */
export async function prepareReaderCheckout(cwd: string, setup: string[], signal: AbortSignal) {
  if (!setup.length) return;
  const result = await runLocalGates(
    cwd,
    { setup, checks: [], source: ".limitless.toml", protectedPaths: [] },
    signal,
  );
  signal.throwIfAborted();
  await discardChanges(cwd);
  if (!result.setupOk) {
    const failed = result.setup.find((r) => !r.ok);
    throw new Error(redactGateOutput(`Reader setup failed: $ ${failed?.command}\n${failed?.output}`));
  }
}

/** One lifecycle for tool-enabled sessions, on the coordinator or a worker. */
export function runToolAgent(
  spec: AgentSpec,
  harness: Harness,
  commands: SlottedCommands,
  port?: number,
  onSlotEvent: (data: TestWait) => void = () => {},
  dispatch?: () => void,
  policy: { role?: Role; agentFullSuite?: AgentFullSuite } = {},
  factoryGate?: FactoryGateHandler,
): Promise<AgentResult> {
  return withScratch(spec.cwd, (scratchDir) => {
    dispatch?.();
    return withSlottedCommands(
      commands,
      spec.cwd,
      scratchDir,
      port,
      (data) => {
        if (data.phase === "refused")
          spec.onEvent({
            type: "status",
            text: `agent-test refused: full suite: ${data.command}`,
          });
        else onSlotEvent(data);
      },
      (commandPath, idleNow) =>
        harness({ ...spec, scratchDir, idleNow, ...(commandPath ? { commandPath } : {}) }),
      (active, elapsedMs) =>
        spec.onEvent({
          type: "status",
          text: active
            ? "Idle watchdog held off for slotted command"
            : `Idle watchdog resumed after ${elapsedMs}ms held off for slotted command`,
        }),
      policy,
      undefined,
      factoryGate,
    );
  });
}
