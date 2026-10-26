import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repo } from "../core/types.ts";
import { worktreeGit } from "../git/command.ts";
import { deleteBranchAt, pushBranch } from "../git/repos.ts";
import type { GhRunner } from "../integrations/github.ts";
import { CommandError } from "../util/proc.ts";
import { CI_CONFIG } from "./audit.ts";
import type { GateCommand } from "./detect.ts";
import {
  type ExecutionEvent,
  type ExecutionHandle,
  GateCleanupError,
  type GateExecutor,
  type GateRequest,
  gateShutdown,
} from "./executor.ts";
import { extractFailures } from "./failures.ts";
import { redactGateOutput } from "./output.ts";
import { type GateResult, type GateRun, OUTPUT_TAIL } from "./run.ts";

/** Durable progress saved before each external step, enough to discard the work from the handle alone. */
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
export interface ActionsDependencies {
  gh: GhRunner;
  /** Create the branch at `sha`, or accept it already there; never move a branch that exists. */
  push(req: GateRequest, branch: string, sha: string, signal: AbortSignal): Promise<void>;
  /** Delete only while the branch still points at `expectedSha`; a moved or missing branch is left alone. */
  deleteBranch(repo: string, branch: string, expectedSha: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const WORKFLOW = "limitless-gates.yml";
const POLL_MS = 10_000;
const DISCOVERY_MS = 60_000;

/** Git transport for one GitHub repository; `transport` is a factory-owned repository such as its cache. */
export const actionsGit = (
  repo: Repo,
  transport: string,
): Pick<ActionsDependencies, "push" | "deleteBranch"> => ({
  push: (req, branch, sha, signal) => pushBranch(repo, req.cwd, branch, sha, signal, undefined, null),
  deleteBranch: (_slug, branch, expected) => deleteBranchAt(repo, transport, branch, expected),
});

const sha = z.string().regex(/^[a-f\d]{40}$/);
const runSchema = z.object({ id: z.number().int().positive(), status: z.string() });
const jobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const minutes = (seconds: number) => Math.ceil(seconds / 60) + 1;

/** Parse this job's token-framed command sections; any other output is opaque candidate text. */
export function records(log: string, commands: GateCommand[]): GateResult[] {
  const lines = log.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+ /, ""));
  // The token step runs before any candidate code, so only its line is trusted.
  const token = lines.find((line) => /^LIMITLESS_TOKEN [a-f\d]{32}$/.test(line))?.split(" ")[1];
  if (!token) return [];
  const results: GateResult[] = [];
  let section: string[] | undefined;
  for (const line of lines) {
    if (!line.startsWith(`${token} `)) {
      section?.push(line);
      continue;
    }
    const marker = line.slice(token.length + 1).split(" ");
    const command = commands[results.length];
    if (Number(marker[1]) !== results.length || !command) throw new Error("Invalid gate record index");
    if (marker[0] === "START" && marker.length === 2 && !section) section = [];
    else if (marker[0] === "END" && marker.length === 5 && section) {
      const [code = -1, duration = -1, timeout] = marker.slice(2).map(Number);
      if (
        !Number.isInteger(code) ||
        code < 0 ||
        code > 255 ||
        !Number.isSafeInteger(duration) ||
        duration < 0
      )
        throw new Error("Invalid gate end record");
      if (timeout !== 0 && timeout !== 1) throw new Error("Invalid gate end record");
      // Redact the whole section before anything is clipped from it.
      const output = redactGateOutput(section.join("\n")).trim();
      const ok = code === 0 && !timeout;
      const failures = ok ? undefined : extractFailures(output);
      results.push({
        name: command.name,
        command: command.run,
        ok,
        exitCode: timeout ? null : code,
        durationMs: duration,
        output: (timeout ? "[timed out]\n" : "") + output.slice(-OUTPUT_TAIL),
        ...(failures ? { failures } : {}),
        ...(timeout ? { timedOut: true } : {}),
      });
      section = undefined;
    } else throw new Error("Malformed gate record");
  }
  return results;
}

const incomplete = (c: GateCommand): GateResult => ({
  name: c.name,
  command: c.run,
  ok: false,
  exitCode: null,
  durationMs: 0,
  incomplete: true,
  output: "GitHub Actions check did not run to completion",
});

export function githubActionsExecutor(deps: ActionsDependencies): GateExecutor {
  async function api(repo: string, path: string, signal?: AbortSignal, body?: unknown) {
    const args = ["api", `repos/${repo}/${path}`, ...(body ? ["--method", "POST", "--input", "-"] : [])];
    const output = await deps.gh(args, signal, body ? JSON.stringify(body) : undefined, repo);
    return JSON.parse(output || "{}");
  }
  /** Identify the run by its per-handle dispatch branch alone; no title or local-clock filter. */
  async function discover(p: ActionsProgress, signal?: AbortSignal) {
    const deadline = deps.now() + DISCOVERY_MS;
    for (;;) {
      const query = `event=workflow_dispatch&branch=${encodeURIComponent(p.dispatch)}&per_page=100`;
      const runs = z
        .object({ workflow_runs: z.array(runSchema.extend({ head_branch: z.string(), event: z.string() })) })
        .parse(await api(p.repo, `actions/workflows/${WORKFLOW}/runs?${query}`, signal))
        .workflow_runs.filter((r) => r.head_branch === p.dispatch && r.event === "workflow_dispatch");
      if (runs.length > 1) throw new Error("Multiple gate workflow runs for one dispatch branch");
      if (runs[0] || deps.now() >= deadline) return runs[0]?.id;
      await deps.sleep(1_000);
    }
  }
  /** Cancel a live run first, then delete both branches. */
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
  async function createRef(repo: string, branch: string, target: string, signal: AbortSignal) {
    try {
      await api(repo, "git/refs", signal, { ref: `refs/heads/${branch}`, sha: target });
    } catch (error) {
      // A restart finds the branch this handle already created; any other SHA is someone else's.
      const existing = await api(repo, `git/ref/heads/${branch}`, signal).catch(() => null);
      if (existing?.object?.sha !== target) throw error;
    }
  }
  return {
    kind: "github-actions",
    freshCheckoutFor: () => true,
    discard: cleanup,
    async start(req, signal) {
      signal.throwIfAborted();
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
      const cache = new Map<string, { etag?: string; data: unknown }>();
      /** Conditional GET: a 304 returns the previous body unchanged. */
      async function poll(repo: string, path: string): Promise<unknown> {
        const previous = cache.get(path);
        const etag = previous?.etag ? ["-H", `If-None-Match: ${previous.etag}`] : [];
        const args = ["api", `repos/${repo}/${path}`, "--include", ...etag];
        // gh exits non-zero on a 304 but still prints the response.
        const text = String(
          (await deps.gh(args, signal, undefined, repo).catch((error: unknown) => {
            if (error instanceof CommandError && /^HTTP\/\S+ 304\b/.test(error.stdout)) return error.stdout;
            throw error;
          })) ?? "",
        );
        if (/^HTTP\/\S+ 304\b/.test(text)) {
          if (!previous) throw new Error("Unexpected 304 for an uncached gate poll");
          return previous.data;
        }
        const boundary = text.search(/\r?\n\r?\n/);
        if (!/^HTTP\/\S+ 200\b/.test(text) || boundary < 0) throw new Error("Invalid gate poll response");
        const data: unknown = JSON.parse(text.slice(boundary).trim());
        cache.set(path, {
          etag: text
            .slice(0, boundary)
            .match(/^etag:\s*(.+)$/im)?.[1]
            ?.trim(),
          data,
        });
        return data;
      }
      const result = (async (): Promise<GateRun> => {
        try {
          signal.throwIfAborted();
          const checks = req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name));
          if (!checks.length) throw new Error("No GitHub Actions checks selected");
          if (!handle.progress) {
            // A candidate push must never run a workflow the candidate wrote.
            const base = sha.safeParse(req.baseSha);
            if (!base.success) throw new Error("GitHub Actions gates need the candidate's base commit");
            sha.parse(req.headSha);
            const diff = await worktreeGit(
              ["git", "diff", "--name-only", "-z", "--no-renames", base.data, req.headSha, "--"],
              { cwd: req.cwd, signal },
            );
            const refused = diff.stdout.split("\0").filter((file) => CI_CONFIG.test(file));
            if (refused.length)
              throw new Error(
                redactGateOutput(`GitHub Actions refuses CI configuration changes: ${refused.join(", ")}`),
              );
            const repo = z.object({ default_branch: z.string() }).parse(await api(req.repo, "", signal));
            const tip = z
              .object({ sha })
              .parse(await api(req.repo, `commits/${encodeURIComponent(repo.default_branch)}`, signal));
            const dispatch = `limitless-gates/${handle.id}/dispatch`;
            const candidate = `limitless-gates/${handle.id}/candidate`;
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
            await createRef(p.repo, p.dispatch, p.dispatchSha, signal);
            await deps.push(req, p.candidate, p.candidateSha, signal);
            p.pushed = true;
            await save();
          }
          if (!p.dispatched) {
            signal.throwIfAborted();
            // Intent is durable first: a crash mid-request counts as dispatched and is found by branch.
            p.dispatched = true;
            await save();
            const response = z
              .object({
                workflow_run_id: z.number().int().positive().optional(),
                html_url: z.string().optional(),
              })
              .parse(
                await api(req.repo, `actions/workflows/${WORKFLOW}/dispatches`, signal, {
                  ref: p.dispatch,
                  return_run_details: true,
                  inputs: {
                    sha: p.candidateSha,
                    setup: JSON.stringify(req.gates.setup),
                    setup_minutes: String(minutes(900 * req.gates.setup.length)),
                    checks: JSON.stringify(
                      checks.map((c, index) => ({
                        index,
                        run: c.run,
                        timeoutSec: c.timeoutSec ?? 900,
                        minutes: minutes(c.timeoutSec ?? 900),
                      })),
                    ),
                  },
                }),
              );
            p.runId = response.workflow_run_id;
            handle.url = response.html_url;
            await save();
          }
          if (!p.runId) {
            p.runId = await discover(p, signal);
            if (!p.runId) throw new Error("Dispatched gate workflow did not appear");
            await save();
          }
          emit({ type: "status", text: `GitHub Actions run ${p.runId}` });
          const setupCommands = req.gates.setup.map((run, i) => ({
            name: `setup${req.gates.setup.length > 1 ? `-${i + 1}` : ""}`,
            run,
          }));
          // null marks a job that never ran its commands to completion.
          const parsed = new Map<number, GateResult[] | null>();
          let jobs: z.infer<typeof jobSchema>[];
          for (;;) {
            signal.throwIfAborted();
            const run = runSchema.parse(await poll(p.repo, `actions/runs/${p.runId}`));
            jobs = [];
            for (let page = 1; ; page++) {
              const data = z
                .object({ jobs: z.array(jobSchema) })
                .parse(await poll(p.repo, `actions/runs/${p.runId}/jobs?per_page=100&page=${page}`));
              jobs.push(...data.jobs);
              if (data.jobs.length < 100) break;
            }
            const indexes = new Set<number>();
            for (const job of jobs) {
              const index = Number(job.name.match(/^gate (\d+)$/)?.[1]);
              const check = checks[index];
              if (!check || indexes.has(index)) throw new Error(`Duplicate or unknown gate job: ${job.name}`);
              indexes.add(index);
              if (job.status !== "completed" || parsed.has(index)) continue;
              // Cancelled, skipped or unstarted jobs may have no logs; never fetch them.
              if (job.conclusion !== "success" && job.conclusion !== "failure") {
                parsed.set(index, null);
                continue;
              }
              const log = await deps.gh(
                ["api", `repos/${p.repo}/actions/jobs/${job.id}/logs`],
                signal,
                undefined,
                p.repo,
              );
              parsed.set(index, records(log || "", [...setupCommands, check]));
            }
            if (run.status === "completed") break;
            await deps.sleep(POLL_MS);
          }
          if (jobs.length !== checks.length) throw new Error("Missing selected gate job");
          const complete = [...parsed.values()].filter((r): r is GateResult[] => !!r);
          const failedSetup = complete.find((r) => r.slice(0, setupCommands.length).some((s) => !s.ok));
          if (failedSetup) {
            const setup = failedSetup.slice(0, setupCommands.length);
            for (const result of setup) emit({ type: "check", phase: "setup", result });
            return { setupOk: false, setup, checks: [] };
          }
          const setup =
            complete.find((r) => r.length > setupCommands.length)?.slice(0, setupCommands.length) ?? [];
          const results = checks.map((c, i) => parsed.get(i)?.[setupCommands.length] ?? incomplete(c));
          for (const result of setup) emit({ type: "check", phase: "setup", result });
          for (const result of results) emit({ type: "check", phase: "check", result });
          return { setupOk: true, setup, checks: results };
        } finally {
          try {
            // Daemon shutdown leaves the run and branches for re-attach.
            if (!gateShutdown(signal))
              await cleanup(handle).catch((cause: unknown) => {
                throw new GateCleanupError("GitHub Actions gate cleanup failed", { cause });
              });
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
