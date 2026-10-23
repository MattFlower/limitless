import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { AgentJobRequest, WorkerStore } from "../db/workers.ts";
import { gateShutdown } from "../gates/executor.ts";
import type { AgentResult } from "../harness/types.ts";
import { redactCredentials } from "../util/proc.ts";
import { AgentEvents, AgentResultReport } from "../workers/agent-protocol.ts";
import type { AgentCall, AgentExecutor, AgentPublication } from "./agent-executor.ts";
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
      const readonly =
        call.role === "review" &&
        spec.mode === "readonly" &&
        !!call.checkout &&
        !publication &&
        !spec.target.backend &&
        !spec.target.openai &&
        !spec.target.decisions;
      const eligible = !(
        (!readonly && (!publication || call.role !== "implement" || spec.mode !== "edit")) ||
        !cfg.workers.agents.includes(call.role) ||
        !cfg.workers.repos.includes(call.repoSlug) ||
        call.shadow ||
        call.private ||
        !["claude", "codex"].includes(spec.target.harness)
      );
      const cancelled = (id?: string): AgentResult => {
        if (id && (readonly || !gateShutdown(spec.signal))) workers.cancelAgentJob(id);
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
      let id = publication && call.agentJob?.round === call.round ? call.agentJob?.id : undefined;
      const open = (state: string) => state === "queued" || state === "leased";
      if (spec.signal.aborted) return cancelled(id);
      if (!eligible) {
        if (id && open(workers.agentJob(id)?.state ?? "")) workers.cancelAgentJob(id);
        return local();
      }
      const matches = (request: AgentJobRequest) =>
        request.target.provider === spec.target.provider &&
        request.target.modelId === spec.target.modelId &&
        request.target.effort === spec.target.effort;
      let request: AgentJobRequest;
      let cursor = { attempt: -1, seq: -1 };
      while (id) {
        let job = workers.agentJob(id);
        if (!job) {
          id = undefined;
          break;
        }
        request = JSON.parse(job.request);
        if (job.state === "done") break;
        let resume = false;
        try {
          resume = !!(
            open(job.state) &&
            matches(request) &&
            (await publication?.resume(request as AgentPublication))
          );
        } catch (error) {
          job = workers.agentJob(id);
          if (spec.signal.aborted) return cancelled(id);
          if (job?.state === "done") continue;
          if (job && open(job.state)) workers.cancelAgentJob(id);
          throw error;
        }
        job = workers.agentJob(id);
        if (job?.state === "done") continue;
        if (spec.signal.aborted) return cancelled(id);
        if (job && open(job.state) && resume) {
          cursor = workers.agentJobEventsAfter(id).at(-1) ?? cursor;
          spec.onEvent({ type: "status", text: `Re-attached worker job ${id} attempt ${job.attempt}` });
          break;
        }
        if (job && open(job.state)) workers.cancelAgentJob(id);
        if (workers.agentJob(id)?.state === "done") continue;
        id = undefined;
      }
      dispatchLoop: for (;;) {
        if (!id) {
          let prepared: AgentPublication | AgentCall["checkout"] | null;
          try {
            prepared = readonly ? call.checkout : await publication?.prepare();
          } catch (error) {
            if (
              error instanceof NeedsHumanError ||
              error instanceof SimulatedTermination ||
              spec.signal.aborted
            )
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
          request = {
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
          id = randomUUID();
          await publication?.started(id);
          if (spec.signal.aborted) return cancelled(id);
          if (!workers.enqueueAgentJob(request, id)) return fallback();
          cursor = { attempt: -1, seq: -1 };
        } else {
          const job = workers.agentJob(id);
          if (!job) {
            id = undefined;
            continue;
          }
          request = JSON.parse(job.request);
        }
        call.dispatch();
        const log = (text: string) => spec.onEvent({ type: "status", text: workers.sanitize(text) });
        let attempt = workers.agentJob(id)?.attempt ?? 0;
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
              report.data.parentSha === request.parentSha &&
              report.data.branch === request.branch &&
              (!readonly || report.data.sha === request.parentSha) &&
              report.data.privateStringsDigest === request.privateStringsDigest
            ) {
              const {
                sha,
                parentSha: _parent,
                branch: _branch,
                privateStringsDigest: _digest,
                ...result
              } = report.data;
              await publication?.adopt(sha, request as AgentPublication);
              if (workers.agentJob(id)?.state !== "done") continue;
              if (spec.signal.aborted) return cancelled(id);
              if (!matches(request)) {
                id = undefined;
                continue dispatchLoop;
              }
              if (result.confinement?.ok !== false && result.status !== "cancelled") return result;
              log(`Worker job ${id} attempt ${attempt} could not run the session; running locally`);
              return fallback(id);
            }
            reason = "Invalid worker result";
          } else if (job && !["failed", "cancelled"].includes(job.state)) {
            await Bun.sleep(workers.times.tick);
            continue;
          }
          const remote = await publication?.remoteSha();
          if (spec.signal.aborted) return cancelled(id);
          if (workers.agentJob(id)?.state === "done" && job?.state !== "done") continue;
          if (remote !== undefined && remote !== request.expectedRemoteSha)
            throw new NeedsHumanError(
              `Run branch ${request.branch} moved to ${remote} during a failed worker attempt (expected ${request.expectedRemoteSha ?? "no branch"}); a commit was pushed without an accepted report for round ${call.round ?? 0}`,
            );
          log(`Worker attempts failed (${reason}); running locally`);
          return fallback(id);
        }
      }
    },
  };
}
