/**
 * Each handle dispatches at most once. Restart cleans up interrupted work, which then stays blocked.
 * A run visible only after cleanup's bounded window may run unobserved: it has contents: read,
 * no secrets, and nothing consumes its result. Nothing selects this executor until remote-gate
 * configuration is available.
 */
import { randomUUID } from "node:crypto";
import type { RepoSettings } from "../config.ts";
import { worktreeGit } from "../git/command.ts";
import { checkPrivatePublication } from "../git/repos.ts";
import type { GhRunner } from "../integrations/github.ts";
import { CommandError } from "../util/proc.ts";
import { CI_CONFIG } from "./audit.ts";
import type { GateCommand } from "./detect.ts";
import {
  type ExecutionHandle,
  GateBlockedError,
  type GateExecutor,
  gateDigest,
  gateShutdown,
  protectedEntries,
} from "./executor.ts";
import { extractFailures } from "./failures.ts";
import { redactGateOutput } from "./output.ts";
import { PrivateError, redactPrivate } from "./private.ts";
import { checkPublicationText } from "./publication.ts";
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
  cleanupRunIds?: number[];
  /** Absolute deadlines survive restarts. Discovery uses the same bounded visibility window as cleanup. */
  visibilityDeadline?: number;
  deadline?: number;
  nextPollAt?: number;
  completed?: GateRun;
  runId?: number;
  /** Cleanup is pending or failed; retain the identity until termination and branch deletion succeed. */
  cleanupFailed?: boolean;
  /** Bound run and gate configuration, inputs frozen after inspection, and a blocked interruption's class. */
  owner?: string;
  gateKey?: string;
  inputs?: Record<string, string>;
  interrupted?: string;
}
interface Dependencies {
  gh: GhRunner;
  /** The daemon-owned repository of a run, never derived from the request or candidate Git config. */
  destination: (runId: string | undefined) => string | undefined;
  settings: (repo: string) => RepoSettings;
  /** Ensure both refs point at these SHAs, atomically; refuse refs at other SHAs. */
  push: (progress: ActionsProgress, url: string) => Promise<void>;
  /** Delete only while the ref still points at sha (a remote force-with-lease); an absent or moved ref resolves. */
  delete: (progress: ActionsProgress, branch: string, sha: string, url: string) => Promise<void>;
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
const url = (repo: string) => `https://github.com/${repo}.git`;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const refuse = (message: string, cwd?: string) => new GateBlockedError("refused", message, cwd);

export function githubActionsExecutor(deps: Dependencies): GateExecutor {
  /** Authorization is read live; private repositories also need paid minutes, discreet ones refuse. */
  const admit = (repo: string, visibility: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    const s = deps.settings(repo);
    const paid = !visibility || s.githubActionsPaidMinutes;
    if (s.discreet || !s.githubActions || typeof visibility !== "boolean" || !paid)
      throw refuse(`GitHub Actions is not authorized for ${repo}`);
  };
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
    return data.workflow_runs;
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
  const discoverUntil = async (p: ActionsProgress, deadline: number, signal: AbortSignal) => {
    for (;;) {
      signal.throwIfAborted();
      const runs = await discover(p, signal);
      if (runs.length > 1) throw new Error("Ambiguous gate workflow runs");
      p.runId = runs[0]?.id;
      if (p.runId) return;
      if (deps.now() >= deadline) return;
      await wait(Math.min(deps.pollMs, deadline - deps.now()), signal);
    }
  };
  const discard = async (handle: ExecutionHandle, signal?: AbortSignal) => {
    const p = handle.githubActions;
    if (!p) throw new Error("Missing GitHub Actions progress");
    p.cleanupFailed = true;
    if (p.owner !== undefined && !same(deps.destination(p.owner), p.repo))
      throw refuse("GitHub Actions handle is bound to another repository");
    if (signal && gateShutdown(signal)) throw signal.reason;
    const cleanupSignal = signal?.aborted ? undefined : signal;
    const ids = new Set([...(p.cleanupRunIds ?? []), ...(p.runId ? [p.runId] : [])]);
    if (p.dispatchIntent || p.dispatchSent || p.runId) {
      p.visibilityDeadline ??= deps.now() + deps.discardVisibilityMs;
      for (;;) {
        for (const run of await discover(p, cleanupSignal)) ids.add(run.id);
        p.cleanupRunIds = [...ids];
        if (deps.now() >= p.visibilityDeadline) break;
        await wait(Math.min(deps.pollMs, p.visibilityDeadline - deps.now()), signal, true);
      }
    }
    const deadline = deps.now() + deps.discardVisibilityMs;
    const pending: number[] = [];
    for (const id of ids) {
      const run = await api<Run>(p, `actions/runs/${id}`, "GET", undefined, cleanupSignal);
      if (run.status !== "completed") {
        await api(p, `actions/runs/${id}/cancel`, "POST", undefined, cleanupSignal);
        pending.push(id);
      }
    }
    for (const id of pending) {
      for (;;) {
        const run = await api<Run>(p, `actions/runs/${id}`, "GET", undefined, cleanupSignal);
        if (run.status === "completed") break;
        if (deps.now() >= deadline)
          throw new GateBlockedError("cleanup", "Workflow termination unconfirmed: cleanup deadline expired");
        await wait(Math.min(deps.pollMs, deadline - deps.now()), signal, true);
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
        await deps.delete(p, branch, sha, url(p.repo));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new GateBlockedError(
        "cleanup",
        `GitHub Actions gate cleanup failed: ${failures.map(String).join("; ")}`,
        p.cwd,
      );
    p.cleanupFailed = undefined;
  };
  return {
    kind: "github-actions",
    freshCheckoutFor: () => true,
    discard,
    async start(req, signal) {
      const repo = deps.destination(req.runId);
      if (!repo || !same(req.repo, repo)) throw refuse("Gate request does not match the run's repository");
      if (!/^[a-f\d]{40,64}$/.test(req.headSha)) throw refuse("Candidate SHA is not an immutable object ID");
      admit(repo, false, signal); // Visibility is confirmed again before upload.
      // Remote URLs and rewrites in the candidate's Git configuration must not redirect any transport.
      const remotes = await worktreeGit(
        ["git", "config", "--get-regexp", "^(remote\\..*\\.(push)?url|url\\..*\\.(push)?insteadof)$"],
        { cwd: req.cwd, signal, allowFail: true },
      );
      for (const line of remotes.stdout.split("\n").filter(Boolean))
        if (!line.startsWith("remote.") || line.split(" ")[1] !== url(repo))
          throw refuse("Candidate Git configuration redirects the gate destination");
      const diff = await worktreeGit(
        ["git", "diff", "--no-renames", "--name-only", "-z", req.baseSha, req.headSha, "--"],
        { cwd: req.cwd, signal },
      );
      const unsafe = diff.stdout.split("\0").filter((file) => CI_CONFIG.test(file));
      if (unsafe.length) throw refuse(`Candidate changes CI configuration: ${unsafe.join(", ")}`, req.cwd);
      const id = randomUUID();
      return {
        kind: "github-actions",
        id,
        startedAt: deps.now(),
        githubActions: {
          repo,
          owner: req.runId,
          gateKey: gateDigest(req.gates),
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
      if (!same(deps.destination(req.runId), p.repo) || !same(req.repo, p.repo))
        throw refuse("GitHub Actions handle is bound to another repository");
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
            if (p.nextPollAt && p.nextPollAt > deps.now()) {
              await pause(p.nextPollAt - deps.now());
              continue;
            }
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
              const message =
                error instanceof CommandError
                  ? `${error.stdout}\n${error.stderr}\n${error.message}`
                  : String(error);
              const retry = message.match(/retry-after:\s*([^\r\n;]+)/i)?.[1]?.trim();
              const reset = message.match(/x-ratelimit-reset:\s*(\d+)\s*(?:\r?\n|$)/i)?.[1];
              const primary =
                /HTTP[^\n]*?\b403\b/i.test(message) &&
                /x-ratelimit-remaining:\s*0\s*(?:\r?\n|$)/i.test(message) &&
                reset !== undefined &&
                Number.isFinite(Number(reset) * 1_000);
              if (!primary && !/(?:HTTP[^\n]*?\b429\b|secondary rate limit)/i.test(message)) throw error;
              const until = retry
                ? /^\d+(?:\.\d+)?$/.test(retry)
                  ? deps.now() + Number(retry) * 1_000
                  : Date.parse(retry)
                : Number(reset) * 1_000;
              p.nextPollAt = Number.isFinite(until) ? Math.max(deps.now() + 1, until) : deps.now() + 1_000;
              await checkpoint();
            }
          }
        };
        controller.signal.throwIfAborted();
        if (p.completed) return structuredClone(p.completed);
        alive();
        await checkpoint();
        let visibility: unknown;
        if (!p.dispatchSha) {
          const repo = await api<Record<string, unknown> | null>(p, "");
          if (!same(repo?.full_name, p.repo)) throw refuse("GitHub repository identity is unavailable");
          visibility = repo?.private;
          const branch = repo?.default_branch;
          if (typeof branch !== "string" || [p.dispatch, p.candidate].includes(branch))
            throw refuse("Unsafe gate branch");
          const ref = await api<{ object: { sha: string } }>(
            p,
            `git/ref/heads/${encodeURIComponent(branch)}`,
          );
          if (!/^[a-f\d]{40,64}$/.test(ref.object.sha)) throw refuse("Malformed default branch head");
          p.dispatchSha = ref.object.sha;
          await checkpoint();
          // Everything the destination does not already hold: identities, messages, every commit's content.
          const entries = protectedEntries(p.cwd);
          await checkPrivatePublication(p.cwd, entries, { commits: `${p.dispatchSha}..${p.headSha}` });
          const inputs = {
            sha: p.headSha,
            candidate: p.candidate,
            setup: JSON.stringify(setup),
            checks: JSON.stringify(
              checks.map((c, index) => ({ ...c, index, minutes: Math.ceil((c.timeoutSec ?? 900) / 60) })),
            ),
            setup_minutes: String(Math.max(1, Math.ceil(setup.reduce((n, c) => n + c.timeoutSec, 0) / 60))),
          };
          for (const text of [...Object.values(inputs), ...[...setup, ...checks].map((c) => c.run)])
            checkPublicationText(text, "Dispatch input", entries);
          p.inputs = inputs;
          await checkpoint();
        }
        if (!p.pushed) {
          await checkpoint();
          admit(p.repo, visibility, controller.signal);
          await deps.push(p, url(p.repo));
          p.pushed = true;
          await checkpoint();
        }
        controller.signal.throwIfAborted();
        if (!p.dispatchIntent && !p.dispatchSent && !p.runId) {
          alive();
          p.dispatchIntent = true;
          p.visibilityDeadline = Math.min(deadline, deps.now() + deps.discardVisibilityMs);
          await checkpoint();
          admit(p.repo, visibility, controller.signal);
          try {
            const response = await api<{ workflow_run_id?: number } | null>(
              p,
              `actions/workflows/${workflow}/dispatches`,
              "POST",
              { ref: p.dispatch, return_run_details: true, inputs: p.inputs },
            );
            p.dispatchSent = true;
            p.runId = response?.workflow_run_id;
          } catch {
            // A failed response cannot prove the POST was rejected; discover without resending.
          }
          await checkpoint();
        }
        if (!p.runId) {
          p.visibilityDeadline ??= Math.min(deadline, deps.now() + deps.discardVisibilityMs);
          await checkpoint();
          await discoverUntil(p, p.visibilityDeadline, controller.signal);
          if (!p.runId) throw new GateBlockedError("dispatch", "Dispatch unconfirmed by the deadline");
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
              const safe = redactPrivate(log || "", protectedEntries(p.cwd)); // Before parsing or storage.
              mapped.set(index, parseJob(job, safe, setup, command, p.dispatchSha ?? ""));
            }
            if (run.status === "completed") {
              alive();
              if (seen.size !== checks.length || mapped.size !== checks.length)
                throw new Error("Missing gate matrix job");
              const results = checks.map((_, index) => mapped.get(index));
              // Only supervisor records are results; a command without one is unavailable evidence.
              const ran = (r?: { setup: GateResult[]; check: GateResult }) =>
                r?.setup.every((s) => s.ok) ? [...r.setup, r.check] : (r?.setup ?? []);
              if (results.flatMap(ran).some((r) => r.incomplete))
                throw new GateBlockedError("incomplete", "GitHub Actions did not record every command");
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
          // A completed, cleaned-up handle owes nothing: replaying it must not need GitHub.
          if (gateShutdown(controller.signal) || (p.completed && !p.cleanupFailed)) return;
          try {
            await discard(handle, controller.signal);
            await checkpoint();
          } catch (error) {
            p.cleanupFailed = true;
            await checkpoint();
            throw error;
          }
        })
        .catch(async (error: unknown) => {
          if (gateShutdown(controller.signal)) throw error;
          const aborted = controller.signal.aborted;
          const kind = error instanceof PrivateError ? "refused" : aborted ? "cancelled" : "operational";
          const blocked =
            error instanceof GateBlockedError ? error : new GateBlockedError(kind, String(error), p.cwd);
          // A completed result may replay once cleanup succeeds; anything else stays blocked.
          if (!p.completed) p.interrupted = blocked.classification;
          await checkpoint();
          throw blocked;
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

function parseJob(job: Job, log: string, setup: GateCommand[], check: GateCommand, workflowSha: string) {
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
        executor: { kind: "github-actions" as const, workflowSha, runsOn: "ubuntu-24.04" },
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
