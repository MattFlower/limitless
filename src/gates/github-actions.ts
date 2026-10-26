import { randomUUID } from "node:crypto";
import { z } from "zod";
import { worktreeGit } from "../git/command.ts";
import type { GhRunner } from "../integrations/github.ts";
import { CI_CONFIG } from "./audit.ts";
import type { GateCommand } from "./detect.ts";
import {
  type ExecutionEvent,
  type ExecutionHandle,
  type GateExecutor,
  type GateRequest,
  gateShutdown,
} from "./executor.ts";
import { extractFailures } from "./failures.ts";
import { redactGateOutput } from "./output.ts";
import { type GateResult, type GateRun, OUTPUT_TAIL } from "./run.ts";

export interface ActionsProgress {
  repo: string;
  dispatch: string;
  candidate: string;
  dispatchSha: string;
  candidateSha: string;
  pushed?: boolean;
  dispatched?: boolean;
  runId?: number;
}
interface Dependencies {
  gh: GhRunner;
  /** Ensure an absent branch or the same SHA, using force-with-lease; never overwrite another SHA. */
  push(req: GateRequest, branch: string, sha: string): Promise<void>;
  /** Delete with force-with-lease on expectedSha; a moved/missing branch is left alone. */
  deleteBranch(repo: string, branch: string, expectedSha: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
const sha = z.string().regex(/^[a-f\d]{40}$/);
const runSchema = z.object({
  id: z.number().int().positive(),
  status: z.string(),
  head_branch: z.string(),
  event: z.string(),
});
const jobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
type Job = z.infer<typeof jobSchema>;

/** Parse only this job's framed command sections; candidate output is otherwise opaque. */
function records(log: string, commands: GateCommand[]): GateResult[] {
  const lines = log.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+ /, ""));
  const tokens = lines.filter((line) => /^LIMITLESS_TOKEN [a-f\d]{32}$/.test(line));
  if (tokens.length !== 1) return [];
  const token = tokens[0]?.split(" ")[1];
  const results: GateResult[] = [];
  let section: string[] | undefined;
  for (const line of lines) {
    if (!line.startsWith(`${token} `)) {
      section?.push(line);
      continue;
    }
    const marker = line.slice(`${token} `.length).split(" ");
    const index = Number(marker[1]);
    if (index !== results.length || !commands[index]) throw new Error("Invalid gate record index");
    if (marker[0] === "START" && marker.length === 2 && !section) section = [];
    else if (marker[0] === "END" && marker.length === 5 && section) {
      const [code, duration, timeout] = marker.slice(2).map(Number);
      if (
        code === undefined ||
        duration === undefined ||
        !Number.isInteger(code) ||
        code < 0 ||
        code > 255 ||
        !Number.isSafeInteger(duration) ||
        duration < 0 ||
        (timeout !== 0 && timeout !== 1)
      )
        throw new Error("Invalid gate end record");
      const command = commands[index];
      if (!command) throw new Error("Unknown gate command");
      const output = redactGateOutput(section.join("\n")).trim();
      const ok = code === 0 && !timeout;
      results.push({
        name: command.name,
        command: command.run,
        ok,
        exitCode: timeout ? null : code,
        durationMs: duration,
        output: (timeout ? "[timed out]\n" : "") + output.slice(-OUTPUT_TAIL),
        ...(timeout ? { timedOut: true } : {}),
        ...(!ok ? { failures: extractFailures(output) } : {}),
      });
      section = undefined;
    } else throw new Error("Malformed gate record");
  }
  return results;
}

export function githubActionsExecutor(deps: Dependencies): GateExecutor {
  async function api(repo: string, path: string, signal?: AbortSignal, body?: unknown) {
    const output = await deps.gh(
      ["api", `repos/${repo}/${path}`, ...(body ? ["--method", "POST", "--input", "-"] : [])],
      signal,
      body ? JSON.stringify(body) : undefined,
      repo,
    );
    return JSON.parse(output || "{}");
  }
  async function discover(p: ActionsProgress) {
    const deadline = deps.now() + 30_000;
    do {
      const data = await api(
        p.repo,
        `actions/workflows/limitless-gates.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(p.dispatch)}&per_page=100`,
      );
      const runs = z
        .object({ workflow_runs: z.array(runSchema) })
        .parse(data)
        .workflow_runs.filter((r) => r.head_branch === p.dispatch && r.event === "workflow_dispatch");
      if (runs.length > 1) throw new Error("Multiple gate workflow runs");
      if (runs[0]) return runs[0].id;
      await deps.sleep(1_000);
    } while (deps.now() < deadline);
    return undefined;
  }
  async function cleanup(handle: ExecutionHandle) {
    const p = handle.progress;
    if (!p) return;
    if (p.dispatched) {
      p.runId ??= await discover(p);
      if (p.runId) {
        const run = runSchema.parse(await api(p.repo, `actions/runs/${p.runId}`));
        if (run.status !== "completed") await api(p.repo, `actions/runs/${p.runId}/cancel`, undefined, {});
      }
    }
    await deps.deleteBranch(p.repo, p.candidate, p.candidateSha);
    await deps.deleteBranch(p.repo, p.dispatch, p.dispatchSha);
  }
  return {
    kind: "github-actions",
    freshCheckoutFor: () => true,
    discard: cleanup,
    async start(req, signal) {
      signal.throwIfAborted();
      sha.parse(req.baseSha);
      sha.parse(req.headSha);
      if (!/^[\w.-]+\/[\w.-]+$/.test(req.repo)) throw new Error("Invalid GitHub repository");
      return { kind: "github-actions", id: randomUUID(), startedAt: deps.now() };
    },
    attach(handle, parent, req) {
      if (!req) throw new Error("GitHub Actions gate request missing");
      const controller = new AbortController();
      const signal = AbortSignal.any([parent, controller.signal]);
      const events: ExecutionEvent[] = [];
      let done = false;
      let changed = Promise.withResolvers<void>();
      const notify = () => {
        const previous = changed;
        changed = Promise.withResolvers<void>();
        previous.resolve();
      };
      const emit = (event: ExecutionEvent) => {
        events.push(event);
        notify();
      };
      const save = () => req.persist?.(handle);
      const result = (async (): Promise<GateRun> => {
        try {
          signal.throwIfAborted();
          sha.parse(req.baseSha);
          sha.parse(req.headSha);
          const diff = await worktreeGit(
            ["git", "diff", "--name-only", "-z", "--no-renames", req.baseSha, req.headSha, "--"],
            { cwd: req.cwd, signal },
          );
          const refused = diff.stdout.split("\0").filter((file) => CI_CONFIG.test(file));
          if (refused.length)
            throw new Error(
              redactGateOutput(`GitHub Actions refuses CI configuration changes: ${refused.join(", ")}`),
            );
          const checks = req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name));
          if (!checks.length) throw new Error("No GitHub Actions checks selected");
          if (!handle.progress) {
            const repo = z.object({ default_branch: z.string() }).parse(await api(req.repo, "", signal));
            const tip = z
              .object({ sha })
              .parse(await api(req.repo, `commits/${encodeURIComponent(repo.default_branch)}`, signal));
            const dispatch = `limitless-gates/${handle.id}/dispatch`,
              candidate = `limitless-gates/${handle.id}/candidate`;
            if (!/^[\w-]+$/.test(handle.id) || [dispatch, candidate].includes(repo.default_branch))
              throw new Error("Unsafe gate branch");
            handle.progress = {
              repo: req.repo,
              dispatch,
              candidate,
              dispatchSha: tip.sha,
              candidateSha: req.headSha,
            };
            await save();
          }
          const p = handle.progress;
          if (p.repo !== req.repo || p.candidateSha !== req.headSha)
            throw new Error("GitHub Actions gate SHA mismatch");
          if (!p.pushed) {
            await save();
            await deps.push(req, p.dispatch, p.dispatchSha);
            await save();
            await deps.push(req, p.candidate, p.candidateSha);
            p.pushed = true;
            await save();
          }
          if (!p.dispatched) {
            signal.throwIfAborted();
            p.dispatched = true;
            await save();
            const response = z
              .object({
                workflow_run_id: z.number().int().positive().optional(),
                html_url: z.string().optional(),
              })
              .parse(
                await api(req.repo, "actions/workflows/limitless-gates.yml/dispatches", signal, {
                  ref: p.dispatch,
                  return_run_details: true,
                  inputs: {
                    sha: p.candidateSha,
                    candidate: p.candidate,
                    setup: JSON.stringify(req.gates.setup),
                    setup_minutes: String(Math.max(1, req.gates.setup.length * 15)),
                    checks: JSON.stringify(
                      checks.map((c, index) => ({
                        ...c,
                        index,
                        minutes: Math.ceil((c.timeoutSec ?? 900) / 60),
                      })),
                    ),
                  },
                }),
              );
            p.runId = response.workflow_run_id;
            handle.url = response.html_url;
            await save();
          }
          p.runId ??= await discover(p);
          if (!p.runId) throw new Error("Dispatched gate workflow did not appear");
          await save();
          emit({ type: "status", text: `GitHub Actions run ${p.runId}` });
          const cache = new Map<string, { etag?: string; data: unknown }>();
          async function poll(path: string): Promise<unknown> {
            const previous = cache.get(path);
            const response = await deps.gh(
              [
                "api",
                `repos/${req?.repo}/${path}`,
                "--include",
                ...(previous?.etag ? ["-H", `If-None-Match: ${previous.etag}`] : []),
              ],
              signal,
              undefined,
              req?.repo,
            );
            const text = response || "";
            if (/^HTTP\/\S+ 304\b/.test(text)) {
              if (!previous) throw new Error("Uncached gate poll");
              return previous.data;
            }
            const boundary = text.search(/\r?\n\r?\n/);
            if (!/^HTTP\/\S+ 200\b/.test(text) || boundary < 0) throw new Error("Invalid gate poll response");
            const data: unknown = JSON.parse(text.slice(boundary).trim());
            cache.set(path, {
              etag: text
                .slice(0, boundary)
                .match(/^etag:\s*(.+)/im)?.[1]
                ?.trim(),
              data,
            });
            return data;
          }
          const parsed = new Map<number, GateResult[]>();
          let jobs: Job[] = [];
          for (;;) {
            signal.throwIfAborted();
            const run = runSchema.parse(await poll(`actions/runs/${p.runId}`));
            jobs = [];
            for (let page = 1; ; page++) {
              const data = z
                .object({ jobs: z.array(jobSchema) })
                .parse(await poll(`actions/runs/${p.runId}/jobs?per_page=100&page=${page}`));
              jobs.push(...data.jobs);
              if (data.jobs.length < 100) break;
            }
            const names = new Set<string>(),
              indexes = new Set<number>();
            for (const job of jobs) {
              const index = Number(job.name.match(/^gate (\d+)$/)?.[1]);
              if (!Number.isInteger(index) || !checks[index] || names.has(job.name) || indexes.has(index))
                throw new Error("Duplicate or unknown gate job");
              names.add(job.name);
              indexes.add(index);
              if (job.status === "completed" && !parsed.has(index)) {
                const log = await deps.gh(
                  ["api", `repos/${p.repo}/actions/jobs/${job.id}/logs`],
                  signal,
                  undefined,
                  p.repo,
                );
                const setup = req.gates.setup.map((run, i) => ({
                  name: `setup${req.gates.setup.length > 1 ? `-${i + 1}` : ""}`,
                  run,
                }));
                parsed.set(
                  index,
                  records(
                    log || "",
                    [...setup, checks[index]].filter((c): c is GateCommand => !!c),
                  ),
                );
              }
            }
            if (run.status === "completed") break;
            await deps.sleep(1_000);
          }
          if (jobs.length !== checks.length) throw new Error("Missing selected gate job");
          const setupCount = req.gates.setup.length;
          for (const results of parsed.values()) {
            const setup = results.slice(0, setupCount);
            if (setup.some((r) => !r.ok)) {
              for (const result of setup) emit({ type: "check", phase: "setup", result });
              return { setupOk: false, setup, checks: [] };
            }
          }
          const setup = parsed.get(0)?.slice(0, setupCount) ?? [];
          const results = checks.map((c, i): GateResult => {
            const r = parsed.get(i)?.[setupCount];
            const job = jobs.find((j) => j.name === `gate ${i}`);
            return r && job?.conclusion !== "cancelled" && job?.conclusion !== "skipped"
              ? r
              : {
                  name: c.name,
                  command: c.run,
                  ok: false,
                  exitCode: null,
                  durationMs: 0,
                  incomplete: true,
                  output: "GitHub Actions check did not complete",
                };
          });
          for (const result of setup) emit({ type: "check", phase: "setup", result });
          for (const result of results) emit({ type: "check", phase: "check", result });
          return { setupOk: true, setup, checks: results };
        } finally {
          try {
            if (!gateShutdown(signal)) await cleanup(handle);
          } finally {
            done = true;
            notify();
          }
        }
      })();
      return {
        result,
        async cancel(reason) {
          controller.abort(reason);
        },
        events: {
          async *[Symbol.asyncIterator]() {
            let i = 0;
            while (!done || i < events.length) {
              const event = events[i++];
              if (event) yield event;
              else {
                i--;
                await changed.promise;
              }
            }
          },
        },
      };
    },
  };
}
