import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { pushBranch } from "../git/repos.ts";
import { type GhRunner, runGh } from "../integrations/github.ts";
import { CommandError } from "../util/proc.ts";
import type { GateCommand } from "./detect.ts";
import {
  type ExecutionEvent,
  type ExecutionHandle,
  type GateExecutor,
  type GateRequest,
  gateShutdown,
} from "./executor.ts";
import { redactGateOutput } from "./output.ts";
import type { GateResult, GateRun } from "./run.ts";

interface Step {
  name: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string;
}
interface Job extends Step {
  id: number;
  status: string;
  steps: Step[];
}
interface Run {
  id: number;
  html_url: string;
  display_title: string;
  conclusion: string | null;
  status: string;
}
interface Dependencies {
  gh?: GhRunner;
  push?: (req: GateRequest, branch: string, signal: AbortSignal) => Promise<void>;
  deleteBranch?: (repo: string, branch: string) => Promise<void>;
  defaultBranch?: (repo: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  discoveryTimeoutMs?: number;
  log?: (message: string) => void;
}
const workflow = "actions/workflows/limitless-gates.yml";
const branchFor = (handle: ExecutionHandle) => `limitless-gates/${handle.id}`;
const setupRecord = z.object({
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  output: z.string(),
});

export function githubActionsExecutor(deps: Dependencies = {}): GateExecutor {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  const interval = deps.pollIntervalMs ?? 15_000;
  const starts = new Map<string, { req: GateRequest; signal: AbortSignal }>();
  const executions = new Map<string, ReturnType<GateExecutor["attach"]>>();
  const discards = new Map<string, Promise<void>>();
  const api = async (
    repo: string,
    path: string,
    signal?: AbortSignal,
    method = "GET",
    body?: unknown,
    etag?: string,
  ) => {
    const args = ["api", `repos/${repo}${path ? `/${path}` : ""}`, "--include", "--method", method];
    if (etag) args.push("--header", `If-None-Match: ${etag}`);
    if (body !== undefined) args.push("--input", "-");
    let raw: string;
    try {
      raw = String(
        (await (deps.gh ?? runGh)(
          args,
          signal,
          body === undefined ? undefined : JSON.stringify(body),
          repo,
        )) ?? "",
      );
    } catch (error) {
      if (!(error instanceof CommandError)) throw new Error(redactGateOutput(String(error)));
      raw = error.stdout;
    }
    const split = raw.search(/\r?\n\r?\n/);
    if (split < 0) throw new Error("Missing GitHub response headers");
    const headers = raw.slice(0, split);
    const status = Number(headers.match(/^HTTP\/\S+ (\d+)/)?.[1]);
    if (
      status !== 304 &&
      !(status === 409 && path.endsWith("/cancel")) &&
      (status < 200 || status >= 300 || !status)
    )
      throw new Error(`GitHub gate HTTP ${status}`);
    const text = raw.slice(split).trim();
    return {
      status,
      etag: headers.match(/^etag:\s*(.+)$/im)?.[1]?.trim(),
      text,
      json: <T>() => JSON.parse(text) as T,
    };
  };
  const find = async (handle: ExecutionHandle, signal?: AbortSignal): Promise<Run | undefined> => {
    const repo = handle.id.split("/").slice(0, -1).join("/");
    for (let page = 1; ; page++) {
      const response = await api(
        repo,
        `${workflow}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${new Date(Math.floor(handle.startedAt / 1000) * 1000).toISOString()}`)}&per_page=100&page=${page}`,
        signal,
      );
      const runs = response.json<{ workflow_runs: Run[] }>().workflow_runs;
      const run = runs.find((r) => r.display_title === `limitless-gates/${handle.id}`);
      if (run || runs.length < 100) return run;
    }
  };
  const discover = async (handle: ExecutionHandle, signal = new AbortController().signal) => {
    const deadline = now() + (deps.discoveryTimeoutMs ?? 60_000);
    for (;;) {
      const run = await find(handle, signal);
      if (run) return run;
      if (now() >= deadline) throw new Error("GitHub gate dispatch did not become visible");
      await sleep(interval, signal);
    }
  };
  const remove = async (handle: ExecutionHandle) => {
    const repo = handle.id.split("/").slice(0, -1).join("/");
    try {
      if (deps.deleteBranch) await deps.deleteBranch(repo, branchFor(handle));
      else await api(repo, `git/refs/heads/${branchFor(handle)}`, undefined, "DELETE");
    } catch (error) {
      (deps.log ?? console.warn)(redactGateOutput(`Gate branch cleanup failed: ${String(error)}`));
    }
  };
  return {
    kind: "github-actions",
    async start(req, signal) {
      signal.throwIfAborted();
      // Include the repository in the durable nonce: discard has no request after a restart.
      const id = `${req.repo}/${randomUUID()}`;
      starts.set(id, { req, signal });
      return { kind: "github-actions", id, startedAt: now() };
    },
    discard(handle) {
      const live = executions.get(handle.id);
      if (live) return live.cancel();
      let pending = discards.get(handle.id);
      if (!pending) {
        pending = (async () => {
          const run = await find(handle);
          if (!run) return;
          try {
            await api(
              handle.id.split("/").slice(0, -1).join("/"),
              `actions/runs/${run.id}/cancel`,
              undefined,
              "POST",
            );
          } finally {
            await remove(handle);
          }
        })();
        discards.set(handle.id, pending);
      }
      return pending;
    },
    attach(handle, signal, request) {
      const known = executions.get(handle.id);
      if (known) return known;
      const started = starts.get(handle.id);
      const req = request ?? started?.req;
      if (!req) throw new Error("GitHub gate execution is missing its request");
      signal = AbortSignal.any([signal, ...(started ? [started.signal] : [])]);
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      let stream: ReadableStreamDefaultController<ExecutionEvent>;
      const events = new ReadableStream<ExecutionEvent>({
        start(controller) {
          stream = controller;
        },
      });
      const emit = (phase: "setup" | "check", result: GateResult) =>
        stream.enqueue({ type: "check", phase, result });
      let run: Run | undefined;
      const result = (async (): Promise<GateRun> => {
        const active = controller.signal;
        const checks = req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name));
        let sent = false;
        try {
          active.throwIfAborted();
          if (!checks.length) throw new Error("GitHub gates require at least one selected check");
          run = started ? undefined : await find(handle, active);
          if (!run) {
            const refs = started
              ? []
              : (await api(req.repo, `git/matching-refs/heads/${branchFor(handle)}`, active)).json<
                  { ref: string }[]
                >();
            sent = refs.some((r) => r.ref === `refs/heads/${branchFor(handle)}`);
            if (!sent) {
              const ref = deps.defaultBranch
                ? await deps.defaultBranch(req.repo, active)
                : (await api(req.repo, "", active)).json<{ default_branch: string }>().default_branch;
              active.throwIfAborted();
              if (deps.push) await deps.push(req, branchFor(handle), active);
              else
                await pushBranch(
                  {
                    id: req.repo,
                    slug: req.repo,
                    kind: "github",
                    url: `https://github.com/${req.repo}.git`,
                    localPath: null,
                    defaultBranch: ref,
                    mergePolicy: "none",
                    createdAt: 0,
                  },
                  req.cwd,
                  branchFor(handle),
                  req.headSha,
                  active,
                );
              active.throwIfAborted();
              sent = true;
              const dispatched = await api(req.repo, `${workflow}/dispatches`, active, "POST", {
                ref,
                return_run_details: true,
                inputs: {
                  base_sha: req.baseSha,
                  head_sha: req.headSha,
                  checks: JSON.stringify(
                    checks.map((c) => ({ ...c, timeout: Math.ceil((c.timeoutSec ?? 900) / 60) })),
                  ),
                  setup: JSON.stringify(req.gates.setup),
                  request_id: handle.id,
                },
              });
              if (dispatched.text) {
                const details = dispatched.json<{ workflow_run_id: number; html_url: string }>();
                if (details.workflow_run_id)
                  run = {
                    id: details.workflow_run_id,
                    html_url: details.html_url,
                    display_title: `limitless-gates/${handle.id}`,
                    status: "queued",
                    conclusion: null,
                  };
              }
            }
            run ??= await discover(handle, active);
          }
          handle.url = redactGateOutput(run.html_url);
          const completed = new Map<number, { setup: GateResult[]; check: GateResult }>();
          const pages = new Map<number, { etag?: string; jobs: Job[]; total_count: number }>();
          for (;;) {
            active.throwIfAborted();
            const state = (await api(req.repo, `actions/runs/${run.id}`, active)).json<Run>();
            if (state.conclusion === "cancelled") throw new Error("GitHub gate run was cancelled externally");
            const jobs: Job[] = [];
            for (let page = 1; ; page++) {
              const cached = pages.get(page);
              const response = await api(
                req.repo,
                `actions/runs/${run.id}/jobs?per_page=100${page > 1 ? `&page=${page}` : ""}`,
                active,
                "GET",
                undefined,
                cached?.etag,
              );
              const data =
                response.status === 304 ? cached : response.json<{ jobs: Job[]; total_count: number }>();
              if (!data) throw new Error("Missing GitHub gate jobs");
              pages.set(page, { ...data, etag: response.etag ?? cached?.etag });
              jobs.push(...data.jobs);
              if (jobs.length >= data.total_count) break;
              if (!data.jobs.length) throw new Error("Missing GitHub gate jobs");
            }
            for (const job of jobs) {
              if (job.status !== "completed" || completed.has(job.id)) continue;
              const command = checks.find((_, i) => job.name === `gate-${i}`);
              if (!command) throw new Error("Unexpected GitHub gate job");
              const rawLog = (await api(req.repo, `actions/jobs/${job.id}/logs`, active)).text;
              const log = redactGateOutput(rawLog);
              // Only the setup step's bounded records count; check stdout may contain marker text.
              const setupLog =
                rawLog
                  .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "")
                  .match(/^LIMITLESS_SETUP_BEGIN\r?\n([\s\S]*?)^LIMITLESS_SETUP_END\r?$/m)?.[1] ?? "";
              const setupStep = job.steps.find((s) => s.name === "Setup gates");
              const setupConclusion =
                job.conclusion === "timed_out" && setupStep?.conclusion !== "success"
                  ? "timed_out"
                  : setupStep?.conclusion;
              const setup = req.gates.setup.map((run, i) => {
                const marker = [...setupLog.matchAll(new RegExp(`^LIMITLESS_SETUP_${i}=(.+)$`, "gm"))].at(
                  -1,
                )?.[1];
                if (marker) {
                  const decoded = setupRecord.parse(JSON.parse(marker));
                  return {
                    ok: decoded.ok,
                    exitCode: decoded.exitCode,
                    durationMs: decoded.durationMs,
                    output: redactGateOutput(decoded.output).slice(-6_000),
                    name: `setup${req.gates.setup.length > 1 ? `-${i + 1}` : ""}`,
                    command: run,
                  };
                }
                return mapped(
                  { name: `setup${req.gates.setup.length > 1 ? `-${i + 1}` : ""}`, run },
                  setupStep,
                  log,
                  setupConclusion,
                );
              });
              const failed = setup.findIndex((s) => !s.ok);
              if (failed >= 0) setup.splice(failed + 1);
              if (setupStep?.conclusion !== "success" && setup.length && setup.every((s) => s.ok))
                setup[setup.length - 1] = mapped(
                  { name: setup.at(-1)?.name ?? "setup", run: setup.at(-1)?.command ?? "" },
                  setupStep,
                  log,
                  setupConclusion,
                );
              const check = mapped(
                command,
                job.steps.find((s) => s.name === "Check gate"),
                log,
                job.conclusion,
              );
              completed.set(job.id, { setup, check });
              if (completed.size === 1) for (const s of setup) emit("setup", s);
              if (setup.every((s) => s.ok)) emit("check", check);
            }
            if (state.status === "completed" && jobs.every((j) => j.status === "completed")) {
              if (completed.size !== checks.length) throw new Error("Incomplete GitHub gate results");
              const ordered = checks.map((_, i) =>
                completed.get(jobs.find((j) => j.name === `gate-${i}`)?.id ?? -1),
              );
              const setup =
                ordered.find((r) => r?.setup.some((s) => !s.ok))?.setup ?? ordered[0]?.setup ?? [];
              const setupOk = setup.every((s) => s.ok);
              return {
                setupOk,
                setup,
                checks: setupOk ? ordered.flatMap((r) => (r ? [r.check] : [])) : [],
              };
            }
            await sleep(interval, active);
          }
        } catch (error) {
          throw new Error(redactGateOutput(String(error)));
        } finally {
          if (!gateShutdown(active)) {
            try {
              if (active.aborted) {
                run ??= sent ? await discover(handle) : undefined;
                if (run) await api(req.repo, `actions/runs/${run.id}/cancel`, undefined, "POST");
              }
            } finally {
              await remove(handle);
            }
          }
          active.throwIfAborted();
        }
      })().finally(() => {
        signal.removeEventListener("abort", abort);
        starts.delete(handle.id);
        executions.delete(handle.id);
        stream.close();
      });
      const execution = {
        result,
        async cancel(reason?: unknown) {
          controller.abort(reason);
          await result.catch(() => {});
        },
        events,
      };
      executions.set(handle.id, execution);
      return execution;
    },
  };
}

function mapped(
  command: GateCommand,
  step: Step | undefined,
  log: string,
  conclusion = step?.conclusion,
): GateResult {
  const ok = conclusion === "success" && step?.conclusion === "success";
  const timedOut = conclusion === "timed_out";
  const exitCode = Number([...log.matchAll(/Process completed with exit code (\d+)/g)].at(-1)?.[1] ?? 1) || 1;
  return {
    name: command.name,
    command: command.run,
    ok,
    exitCode: ok ? 0 : timedOut || conclusion === "cancelled" ? null : exitCode,
    durationMs: step ? Math.max(0, Date.parse(step.completed_at) - Date.parse(step.started_at)) || 0 : 0,
    output: (timedOut ? "[timed out]\n" : "") + log.slice(-6_000),
    ...(!ok ? { failures: log.slice(-6_000) } : {}),
    ...(timedOut ? { timedOut: true } : {}),
  };
}
