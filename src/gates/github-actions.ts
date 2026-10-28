import { randomUUID } from "node:crypto";
import { worktreeGit } from "../git/command.ts";
import type { GhRunner } from "../integrations/github.ts";
import { CI_CONFIG } from "./audit.ts";
import type { GateCommand } from "./detect.ts";
import { type ExecutionHandle, type GateExecutor, gateShutdown } from "./executor.ts";
import { extractFailures } from "./failures.ts";
import { redactGateOutput } from "./output.ts";
import type { GateResult, GateRun } from "./run.ts";

export interface ActionsProgress {
  repo: string;
  cwd: string;
  candidate: string;
  dispatch: string;
  headSha: string;
  dispatchSha?: string;
  pushed?: boolean;
  dispatchIntent?: boolean;
  dispatchSent?: boolean;
  recoveryAttempted?: boolean;
  /** Absolute deadlines survive restarts. Discovery uses the same bounded visibility window as cleanup. */
  visibilityDeadline?: number;
  deadline?: number;
  completed?: GateRun;
  runId?: number;
  /** Cleanup is pending or failed; retain the identity until termination and branch deletion succeed. */
  cleanupFailed?: boolean;
}
interface Dependencies {
  gh: GhRunner;
  /** Ensure both refs point at these SHAs, atomically; refuse refs at other SHAs. */
  push: (progress: ActionsProgress) => Promise<void>;
  /** Delete only while the ref still points at sha (a remote force-with-lease); an absent or moved ref resolves. */
  delete: (progress: ActionsProgress, branch: string, sha: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  discardVisibilityMs: number;
}
interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}
interface Run {
  id: number;
  status: string;
}
const workflow = "limitless-gates.yml";

/** Nothing selects this executor until remote-gate configuration is available. */
export function githubActionsExecutor(deps: Dependencies): GateExecutor {
  const api = async <T>(
    p: ActionsProgress,
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const raw = await deps.gh(
      ["api", `repos/${p.repo}/${path}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])],
      signal,
      body === undefined ? undefined : JSON.stringify(body),
      p.repo,
    );
    return JSON.parse(raw || "null") as T;
  };
  const discover = async (p: ActionsProgress, signal?: AbortSignal) => {
    const data = await api<{ workflow_runs: Run[] }>(
      p,
      `actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(p.dispatch)}&per_page=100`,
      "GET",
      undefined,
      signal,
    );
    if (data.workflow_runs.length > 1) throw new Error("Ambiguous gate workflow runs");
    return data.workflow_runs[0]?.id;
  };
  const wait = async (ms: number, signal?: AbortSignal, shutdownOnly = false) => {
    const stopped = () => signal?.aborted && (!shutdownOnly || gateShutdown(signal));
    if (stopped()) throw signal?.reason;
    let abort = () => {};
    try {
      await Promise.race([
        deps.sleep(ms),
        new Promise<never>((_resolve, reject) => {
          abort = () => {
            if (stopped()) reject(signal?.reason);
          };
          signal?.addEventListener("abort", abort, { once: !shutdownOnly });
          abort();
        }),
      ]);
      if (stopped()) throw signal?.reason;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
  const discoverUntil = async (
    p: ActionsProgress,
    deadline: number,
    signal?: AbortSignal,
    cleanup = false,
  ) => {
    for (;;) {
      if (signal?.aborted && (!cleanup || gateShutdown(signal))) throw signal.reason;
      p.runId = await discover(p, signal?.aborted ? undefined : signal);
      if (p.runId) return;
      if (deps.now() >= deadline) return;
      await wait(Math.min(deps.pollMs, deadline - deps.now()), signal, cleanup);
    }
  };
  const discard = async (handle: ExecutionHandle, signal?: AbortSignal) => {
    const p = handle.githubActions;
    if (!p) throw new Error("Missing GitHub Actions progress");
    p.cleanupFailed = true;
    if (signal && gateShutdown(signal)) throw signal.reason;
    const cleanupSignal = signal?.aborted ? undefined : signal;
    const deadline = deps.now() + deps.discardVisibilityMs;
    if ((p.dispatchIntent || p.dispatchSent) && !p.runId) {
      await discoverUntil(p, deadline, signal, true);
      if (!p.runId) throw new Error("Dispatch unconfirmed: cleanup discovery deadline expired");
    }
    if (p.runId) {
      let run = await api<Run>(p, `actions/runs/${p.runId}`, "GET", undefined, cleanupSignal);
      if (run.status !== "completed") {
        await api(p, `actions/runs/${p.runId}/cancel`, "POST", undefined, cleanupSignal);
        for (;;) {
          run = await api<Run>(p, `actions/runs/${p.runId}`, "GET", undefined, cleanupSignal);
          if (run.status === "completed") break;
          if (deps.now() >= deadline)
            throw new Error("Workflow termination unconfirmed: cleanup deadline expired");
          await wait(Math.min(deps.pollMs, deadline - deps.now()), signal, true);
        }
      }
    }
    // Only branch deletion is independent, after workflow termination is confirmed.
    const failures: unknown[] = [];
    for (const [branch, sha] of [
      [p.dispatch, p.dispatchSha],
      [p.candidate, p.headSha],
    ]) {
      if (!branch || !sha) continue;
      try {
        await deps.delete(p, branch, sha);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `GitHub Actions gate cleanup failed: ${failures.map(String).join("; ")}`,
      );
    p.cleanupFailed = undefined;
  };
  return {
    kind: "github-actions",
    freshCheckoutFor: () => true,
    discard,
    async start(req, signal) {
      signal.throwIfAborted();
      const diff = await worktreeGit(
        ["git", "diff", "--no-renames", "--name-only", "-z", req.baseSha, req.headSha, "--"],
        { cwd: req.cwd, signal },
      );
      const unsafe = diff.stdout.split("\0").filter((file) => CI_CONFIG.test(file));
      if (unsafe.length)
        throw new Error(redactGateOutput(`Candidate changes CI configuration: ${unsafe.join(", ")}`));
      const id = randomUUID();
      return {
        kind: "github-actions",
        id,
        startedAt: deps.now(),
        githubActions: {
          repo: req.repo,
          cwd: req.cwd,
          headSha: req.headSha,
          candidate: `limitless-gates/${id}/candidate`,
          dispatch: `limitless-gates/${id}/dispatch`,
        },
      };
    },
    attach(handle, signal, req, _hooks, persist = async () => {}) {
      const p = handle.githubActions;
      if (!p || !req) throw new Error("Missing GitHub Actions gate request");
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const checkpoint = () => persist(handle);
      const checks = req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name));
      const setup = req.gates.setup.map((run) => ({ name: run, run, timeoutSec: 900 }));
      const result = (async (): Promise<GateRun> => {
        const etags = new Map<string, { etag?: string; data: unknown }>();
        p.deadline ??=
          handle.startedAt +
          (setup.reduce((n, c) => n + c.timeoutSec, 0) +
            checks.reduce((n, c) => n + (c.timeoutSec ?? 900), 0)) *
            1_000;
        const deadline = p.deadline;
        const alive = () => {
          controller.signal.throwIfAborted();
          if (deps.now() >= deadline) throw new Error("GitHub Actions execution deadline expired");
        };
        const pause = (ms: number) =>
          wait(Math.min(ms, Math.max(0, deadline - deps.now())), controller.signal);
        const poll = async <T>(path: string): Promise<T> => {
          const old = etags.get(path);
          for (;;) {
            alive();
            try {
              const raw = await deps.gh(
                [
                  "api",
                  `repos/${p.repo}/${path}`,
                  "--include",
                  ...(old?.etag ? ["-H", `If-None-Match: ${old.etag}`] : []),
                ],
                controller.signal,
                undefined,
                p.repo,
              );
              alive();
              const [headers, ...body] = (raw || "").split(/\r?\n\r?\n/);
              const status = headers?.match(/^HTTP\/\S+ (\d+)/)?.[1];
              if (status === "304" && old) return old.data as T;
              if (status !== "200") throw new Error(redactGateOutput(`GitHub poll ${raw}`));
              const data: T = JSON.parse(body.join("\n\n"));
              etags.set(path, { etag: headers?.match(/^etag:\s*(.+)\r?$/im)?.[1]?.trim(), data });
              return data;
            } catch (error) {
              const message = String(error);
              if (!/(?:HTTP[^\n]*?\b429\b|secondary rate limit)/i.test(message)) throw error;
              const retry = message.match(/retry-after:\s*([^\r\n;]+)/i)?.[1]?.trim();
              const reset = message.match(/x-ratelimit-reset:\s*(\d+)/i)?.[1];
              const until = retry
                ? /^\d+(?:\.\d+)?$/.test(retry)
                  ? deps.now() + Number(retry) * 1_000
                  : Date.parse(retry)
                : Number(reset) * 1_000;
              await pause(Number.isFinite(until) ? Math.max(1, until - deps.now()) : 1_000);
            }
          }
        };
        controller.signal.throwIfAborted();
        if (p.cleanupFailed && !p.completed)
          throw new Error("Previous GitHub Actions execution failed; retrying cleanup");
        if (p.completed) return structuredClone(p.completed);
        alive();
        await checkpoint();
        if (!p.dispatchSha) {
          const repo = await api<{ default_branch: string }>(p, "");
          if ([p.dispatch, p.candidate].includes(repo.default_branch)) throw new Error("Unsafe gate branch");
          const ref = await api<{ object: { sha: string } }>(
            p,
            `git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
          );
          p.dispatchSha = ref.object.sha;
          await checkpoint();
        }
        if (!p.pushed) {
          await checkpoint();
          await deps.push(p);
          p.pushed = true;
          await checkpoint();
        }
        controller.signal.throwIfAborted();
        const send = async () => {
          alive();
          p.dispatchIntent = true;
          p.visibilityDeadline = Math.min(deadline, deps.now() + deps.discardVisibilityMs);
          await checkpoint();
          let response: { workflow_run_id?: number } | null;
          try {
            response = await api<{ workflow_run_id?: number } | null>(
              p,
              `actions/workflows/${workflow}/dispatches`,
              "POST",
              {
                ref: p.dispatch,
                return_run_details: true,
                inputs: {
                  sha: p.headSha,
                  candidate: p.candidate,
                  setup: JSON.stringify(setup),
                  checks: JSON.stringify(
                    checks.map((c, index) => ({
                      ...c,
                      index,
                      minutes: Math.ceil((c.timeoutSec ?? 900) / 60),
                    })),
                  ),
                  setup_minutes: String(
                    Math.max(1, Math.ceil(setup.reduce((n, c) => n + c.timeoutSec, 0) / 60)),
                  ),
                },
              },
            );
          } catch {
            // A failed response cannot prove the POST was rejected. Discover before recovering.
            return;
          }
          p.dispatchSent = true;
          p.runId = response?.workflow_run_id;
          await checkpoint();
        };
        if (!p.dispatchSent && !p.dispatchIntent && !p.runId) await send();
        if (!p.runId) {
          p.visibilityDeadline ??= Math.min(deadline, deps.now() + deps.discardVisibilityMs);
          await checkpoint();
          await discoverUntil(p, p.visibilityDeadline, controller.signal);
          if (!p.runId && !p.dispatchSent && !p.recoveryAttempted) {
            p.recoveryAttempted = true;
            await send();
            if (!p.runId) await discoverUntil(p, p.visibilityDeadline, controller.signal);
          }
          if (!p.runId) throw new Error("Dispatch unconfirmed: discovery deadline expired");
          p.dispatchSent = true;
          await checkpoint();
        }
        const mapped = new Map<number, { setup: GateResult[]; check: GateResult }>();
        for (;;) {
          alive();
          if (p.runId) {
            const run = await poll<Run>(`actions/runs/${p.runId}`);
            const { jobs, total_count } = await poll<{ jobs: Job[]; total_count: number }>(
              `actions/runs/${p.runId}/jobs?per_page=100`,
            );
            if (total_count > jobs.length) throw new Error("Incomplete matrix job listing");
            const seen = new Set<number>();
            for (const job of jobs) {
              const index = Number(job.name.match(/^gate-(\d+)$/)?.[1] ?? NaN);
              const command = checks[index];
              if (!command || seen.has(index)) throw new Error("Unexpected or duplicate gate matrix index");
              seen.add(index);
              if (job.status !== "completed" || mapped.has(index)) continue;
              const log = ["cancelled", "skipped", "startup_failure", "action_required"].includes(
                job.conclusion ?? "",
              )
                ? ""
                : await deps.gh(
                    ["run", "view", "--repo", p.repo, "--job", String(job.id), "--log"],
                    undefined,
                    undefined,
                    p.repo,
                  );
              mapped.set(index, parseJob(job, log || "", setup, command));
            }
            if (run.status === "completed") {
              alive();
              if (seen.size !== checks.length || mapped.size !== checks.length)
                throw new Error("Missing gate matrix job");
              const results = checks.map((_, index) => mapped.get(index));
              const failed = results.find((r) => r?.setup.some((s) => !s.ok));
              p.completed = failed
                ? { setupOk: false, setup: failed.setup, checks: [] }
                : {
                    setupOk: true,
                    setup: results[0]?.setup ?? [],
                    checks: results.flatMap((r) => (r ? [r.check] : [])),
                  };
              p.cleanupFailed = true;
              await checkpoint();
              return structuredClone(p.completed);
            }
          }
          await pause(deps.pollMs);
        }
      })()
        .finally(async () => {
          if (gateShutdown(controller.signal)) return;
          try {
            await discard(handle, controller.signal);
            await checkpoint();
          } catch (error) {
            p.cleanupFailed = true;
            await checkpoint();
            throw error;
          }
        })
        .finally(() => signal.removeEventListener("abort", abort));
      return {
        result,
        cancel: async (reason) => {
          controller.abort(reason);
        },
        events: {
          async *[Symbol.asyncIterator]() {
            const run = await result;
            for (const item of run.setup)
              yield { type: "check" as const, phase: "setup" as const, result: item };
            for (const item of run.checks)
              yield { type: "check" as const, phase: "check" as const, result: item };
          },
        },
      };
    },
  };
}

function parseJob(job: Job, log: string, setup: GateCommand[], check: GateCommand) {
  const sections = new Map<string, string[]>();
  for (const line of log.split(/\r?\n/)) {
    const [, step, content] = line.match(/^[^\t]+\t([^\t]+)\t(?:\S+ )?(.*)$/) ?? [];
    if (step && content !== undefined) {
      const lines = sections.get(step) ?? [];
      lines.push(content);
      sections.set(step, lines);
    }
  }
  const tokens = (sections.get("Token") ?? []).filter((line) => /^LIMITLESS_TOKEN [a-f\d]{32}$/.test(line));
  if (tokens.length > 1) throw new Error("Duplicate gate token");
  const token = tokens[0]?.slice(16);
  const parse = (step: string, commands: GateCommand[]): GateResult[] => {
    const section = (sections.get(step) ?? []).join("\n");
    const records = token ? section.split("\n").filter((l) => l.startsWith(`LIMITLESS:${token}:`)) : [];
    const values = new Map<number, { exit: number; ms: number; timeout: boolean }>();
    for (const record of records) {
      const m = record.match(/^LIMITLESS:[a-f\d]{32}:(\d+):(\d+):(\d+):(true|false)$/);
      const index = Number(m?.[1]);
      if (!m || !commands[index] || values.has(index)) throw new Error("Malformed gate record");
      values.set(index, { exit: Number(m[2]), ms: Number(m[3]), timeout: m[4] === "true" });
    }
    const output = redactGateOutput(section);
    return commands.map((c, i) => {
      const v = values.get(i);
      const incomplete =
        !v || ["cancelled", "skipped", "startup_failure", "action_required"].includes(job.conclusion ?? "")
          ? "job did not complete command"
          : undefined;
      const timedOut = v?.timeout || (!v && job.conclusion === "timed_out");
      const ok = !!v && v.exit === 0 && !timedOut && !incomplete;
      return {
        name: c.name,
        command: c.run,
        ok,
        exitCode: v?.exit ?? null,
        durationMs: v?.ms ?? 0,
        timedOut,
        incomplete,
        output: output.slice(-6_000),
        failures: ok ? undefined : extractFailures(output),
      };
    });
  };
  const setupResults = parse("Setup", setup);
  const failure = setupResults.findIndex((r) => !r.ok);
  return {
    setup: failure < 0 ? setupResults : setupResults.slice(0, failure + 1),
    check:
      parse("Check", [check])[0] ??
      (() => {
        throw new Error("Missing check");
      })(),
  };
}
