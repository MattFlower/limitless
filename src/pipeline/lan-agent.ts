import type { Config } from "../config.ts";
import type { AgentJobRequest, WorkerStore } from "../db/workers.ts";
import type { AgentResult } from "../harness/types.ts";
import { redactCredentials } from "../util/proc.ts";
import { AgentEvents, AgentResultReport } from "../workers/agent-protocol.ts";
import type { AgentExecutor, AgentPublication } from "./agent-executor.ts";
import { NeedsHumanError } from "./context.ts";
import { SimulatedTermination } from "./faults.ts";

function storedJson(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

export function lanAgentExecutor(workers: WorkerStore, cfg: Config): AgentExecutor {
  return {
    kind: "lan",
    async run(call, local) {
      const publication = call.publication;
      const { spec } = call;
      if (
        !publication ||
        call.role !== "implement" ||
        !cfg.workers.agents.includes(call.role) ||
        !cfg.workers.repos.includes(call.repoSlug) ||
        call.shadow ||
        call.private ||
        spec.mode !== "edit" ||
        !["claude", "codex"].includes(spec.target.harness)
      )
        return local();
      const cancelled = (id?: string): AgentResult => {
        if (id) workers.cancelAgentJob(id);
        return {
          status: "cancelled",
          finalText: "",
          structured: null,
          sessionId: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          numTurns: 0,
          costUsd: 0,
          costEquivUsd: 0,
          error: "cancelled",
          quota: null,
        };
      };
      const fallback = (id?: string) => (spec.signal.aborted ? cancelled(id) : local());
      let prepared: AgentPublication | null;
      try {
        prepared = await publication.prepare();
      } catch (error) {
        if (error instanceof NeedsHumanError || error instanceof SimulatedTermination || spec.signal.aborted)
          throw error;
        throw new NeedsHumanError(
          `Cannot prepare worker job: ${redactCredentials(error instanceof Error ? error.message : String(error))}`,
        );
      }
      if (spec.signal.aborted) return cancelled();
      if (!prepared) return fallback();
      const {
        prompt,
        systemAppend,
        target,
        mode,
        jsonSchema,
        timeoutMs,
        idleTimeoutMs,
        maxToolCalls,
        fast,
        privateSession,
        confineReads,
      } = spec;
      const request: AgentJobRequest & AgentPublication = {
        ...prepared,
        runId: call.runId,
        invocationId: call.invocationId,
        role: call.role,
        prompt,
        systemAppend,
        target,
        mode,
        jsonSchema,
        timeoutMs,
        idleTimeoutMs,
        maxToolCalls,
        fast,
        privateSession,
        confineReads,
        slottedCommands: call.slottedCommands,
      };
      call.dispatch();
      const id = workers.enqueueAgentJob(request);
      if (!id) return fallback();
      const log = (text: string) => spec.onEvent({ type: "status", text: workers.sanitize(text) });
      let cursor = { attempt: -1, seq: -1 },
        attempt = 0;
      for (;;) {
        if (spec.signal.aborted) return cancelled(id);
        workers.sweepAgentJobs();
        for (const row of workers.agentJobEventsAfter(id, cursor)) {
          const batch = AgentEvents.safeParse({ seq: row.seq, events: storedJson(row.events) });
          if (batch.success) for (const event of batch.data.events) spec.onEvent(event);
          cursor = row;
        }
        const job = workers.agentJob(id);
        if (job && job.attempt !== attempt) {
          attempt = job.attempt;
          log(`Worker job ${id} attempt ${attempt}`);
        }
        let reason = job?.failure_reason ?? "Missing worker result";
        if (job?.state === "done") {
          const report = AgentResultReport.safeParse(storedJson(job.result));
          if (
            report.success &&
            report.data.parentSha === prepared.parentSha &&
            report.data.branch === prepared.branch &&
            report.data.privateStringsDigest === prepared.privateStringsDigest
          ) {
            const {
              sha,
              parentSha: _parent,
              branch: _branch,
              privateStringsDigest: _digest,
              ...result
            } = report.data;
            await publication.adopt(sha, request);
            if (spec.signal.aborted) return cancelled(id);
            if (result.confinement?.ok !== false && result.status !== "cancelled") return result;
            log(`Worker job ${id} attempt ${attempt} could not run the session; running locally`);
            return fallback(id);
          }
          reason = "Invalid worker result";
        } else if (job && !["failed", "cancelled"].includes(job.state)) {
          await Bun.sleep(workers.times.tick);
          continue;
        }
        const remote = await publication.remoteSha();
        if (spec.signal.aborted) return cancelled(id);
        if (remote !== undefined && remote !== prepared.expectedRemoteSha)
          throw new NeedsHumanError(
            `Run branch ${prepared.branch} moved to ${remote} during a failed worker attempt (expected ${prepared.expectedRemoteSha ?? "no branch"}); a worker may have published round ${call.round ?? 0} without reporting it. Adopting unreported worker commits is S6`,
          );
        log(`Worker attempts failed (${reason}); running locally`);
        return fallback(id);
      }
    },
  };
}
