import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { Paths } from "../config.ts";
import { type AgentJobRequest, PairingLimitError, type WorkerStore } from "../db/workers.ts";
import type { GateRequest } from "../gates/executor.ts";
import { worktreeGit } from "../git/command.ts";
import { cachePath, withRepoLock } from "../git/repos.ts";
import { AgentEvents, AgentFailure, AgentResultReport } from "../workers/agent-protocol.ts";
import { CheckEvent, Claim, Heartbeat, LeaseRequest, Pair, Result } from "../workers/protocol.ts";
import { certificate } from "../workers/tls.ts";
import { validCheck, validRun } from "../workers/validation.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
class BodyTooLarge extends Error {}
async function readJson(req: Request, limit = 2 * 1024 * 1024): Promise<unknown> {
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          void reader.cancel().catch(() => {});
          throw new BodyTooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
async function jobBundle(cache: string, id: string, commits: string[], signal: AbortSignal) {
  const dir = mkdtempSync(join(tmpdir(), "worker-bundle-"));
  try {
    const bundle = join(dir, "job.bundle");
    await withRepoLock(cache, async () => {
      const refs = [...new Set(commits)];
      if (refs.some((sha) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)))
        throw new Error("Invalid commit SHA");
      // Temporary refs advertise exact commits without relying on movable branches.
      const names = refs.map((_sha, i) => `refs/limitless-bundles/${id}/${i}`);
      try {
        for (const [i, sha] of refs.entries())
          await worktreeGit(["git", "update-ref", names[i] ?? "", sha], { cwd: cache, signal });
        await worktreeGit(["git", "bundle", "create", bundle, ...names], {
          cwd: cache,
          additionalWriteRoots: [dir],
          signal,
          timeoutMs: 300_000,
        });
      } finally {
        for (const name of names) await worktreeGit(["git", "update-ref", "-d", name], { cwd: cache });
      }
    });
    return readFileSync(bundle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export async function startWorkerListener(
  workers: WorkerStore,
  paths: Paths,
  listen?: string,
  log: (text: string) => void = console.log,
) {
  if (!listen) return undefined;
  const tls = await certificate(join(paths.home, "worker-tls"));
  workers.pairingKey = tls.key;
  const limits = new Map<string, { at: number; count: number }>();
  const closing = new AbortController();
  const fetch = async (req: Request, server: Server<undefined>): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/worker/")) return new Response(null, { status: 404 });
    try {
      if (path === "/worker/pair" && req.method === "POST") {
        const ip = server.requestIP(req)?.address ?? "unknown",
          now = workers.now();
        for (const [key, limit] of limits) if (now - limit.at >= 60_000) limits.delete(key);
        if (!limits.has(ip) && limits.size >= 1024)
          return json({ error: "Pairing rate limit exceeded" }, 429);
        const limit = limits.get(ip) ?? { at: now, count: 0 };
        limits.set(ip, limit);
        if (++limit.count >= 5) return json({ error: "Pairing rate limit exceeded" }, 429);
        const p = Pair.parse(await readJson(req));
        const pending = workers.pair(p.name, p.fingerprint, tls.fingerprint);
        log(`Worker pairing code: ${pending.code}`);
        return json(pending);
      }
      if (path === "/worker/pair/claim" && req.method === "POST")
        return json(workers.claim(Claim.parse(await readJson(req)).secret));
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "")?.[1];
      const worker = token ? workers.authenticate(token) : null;
      if (!worker) return json({ error: "Worker authentication required" }, 401);
      if (path === "/worker/heartbeat" && req.method === "POST") {
        const capabilities = Heartbeat.parse(await readJson(req));
        const current = workers.authenticate(token ?? "");
        if (!current) return json({ error: "Worker revoked" }, 401);
        return json(workers.heartbeat(current, capabilities));
      }
      if (path === "/worker/lease" && req.method === "POST") {
        const held = LeaseRequest.parse(await readJson(req)).jobs;
        const end = performance.now() + workers.times.poll;
        do {
          if (closing.signal.aborted || req.signal.aborted) return json({ job: null, agentJob: null });
          if (!workers.authenticate(token ?? "")) return json({ error: "Worker revoked" }, 401);
          workers.sweep();
          workers.sweepAgentJobs();
          const cancelled = workers.cancelledHeld(held, worker.name);
          if (cancelled.length) return json({ job: null, agentJob: null, cancelled });
          const job = workers.lease(worker.name, false);
          if (job) {
            const request: GateRequest = JSON.parse(job.request);
            return json({
              agentJob: null,
              job: {
                id: job.id,
                remainingMs: Math.max(0, (job.attempt_deadline_at ?? workers.now()) - workers.now()),
                request: { ...request, cwd: "" },
              },
            });
          }
          const agentJob = workers.leaseAgentJob(worker.name);
          if (agentJob) {
            const { runId, invocationId, parentSha, baseSha, prompt, target, timeoutMs }: AgentJobRequest =
              JSON.parse(agentJob.request);
            return json({
              job: null,
              agentJob: {
                id: agentJob.id,
                remainingMs: Math.max(0, (agentJob.attempt_deadline_at ?? workers.now()) - workers.now()),
                request: { runId, invocationId, parentSha, baseSha, prompt, target, timeoutMs },
              },
            });
          }
          await Bun.sleep(workers.times.tick);
        } while (performance.now() < end);
        return json({ job: null, agentJob: null });
      }
      const agent = /^\/worker\/agent-jobs\/([^/]+)\/(bundle|events|result|failure)$/.exec(path);
      if (agent) {
        const id = agent[1] ?? "",
          action = agent[2];
        const held = () => {
          if (!workers.authenticate(token ?? "")) return json({ error: "Worker revoked" }, 401);
          if (!workers.holdsAgentJob(id, worker.name))
            return json({ error: "Job lease is no longer held" }, 409);
        };
        const denied = held();
        if (denied) return denied;
        const job = workers.agentJob(id);
        if (!job) return json({ error: "Job lease is no longer held" }, 409);
        if (action === "bundle" && req.method === "GET") {
          const run = job.run_id ? workers.store.getRun(job.run_id) : null;
          const repo = run ? workers.store.getRepo(run.repoId) : null;
          if (!repo) throw new Error("Repository cache unavailable");
          const request: AgentJobRequest = JSON.parse(job.request);
          const bundle = await jobBundle(
            cachePath(paths, repo),
            id,
            [job.parent_sha, ...(request.baseSha ? [request.baseSha] : [])],
            AbortSignal.any([req.signal, closing.signal]),
          );
          return held() ?? new Response(bundle, { headers: { "content-type": "application/x-git-bundle" } });
        }
        if (req.method !== "POST" || action === "bundle") return new Response(null, { status: 404 });
        const body = await readJson(req, (action === "events" ? 1 : 2) * 1024 * 1024);
        const lateDenied = held();
        if (lateDenied) return lateDenied;
        if (action === "events") {
          const { seq, events } = AgentEvents.parse(body);
          workers.agentJobEvents(id, seq, events);
        } else if (action === "failure") workers.failAgentJob(id, AgentFailure.parse(body).reason);
        else {
          const result = AgentResultReport.parse(body);
          if (result.parentSha !== job.parent_sha) return json({ error: "Result parent SHA mismatch" }, 400);
          workers.completeAgentJob(id, result, result.sha);
        }
        return json({ ok: true });
      }
      const match = /^\/worker\/jobs\/([^/]+)\/(bundle|events|result|failure)$/.exec(path);
      const id = match?.[1],
        action = match?.[2];
      if (!id) return new Response(null, { status: 404 });
      const job = workers.holds(id, worker.name);
      if (!job) return json({ error: "Job lease is no longer held" }, 409);
      const request: GateRequest = JSON.parse(job.request);
      if (action === "bundle" && req.method === "GET") {
        const repo = workers.store.getRepoBySlug(request.repo);
        if (!repo) throw new Error("Repository cache unavailable");
        const bundle = await jobBundle(
          cachePath(paths, repo),
          id,
          [request.headSha, ...(request.baseSha ? [request.baseSha] : [])],
          AbortSignal.any([req.signal, closing.signal]),
        );
        if (!workers.authenticate(token ?? "")) return json({ error: "Worker revoked" }, 401);
        if (!workers.holds(id, worker.name)) return json({ error: "Job lease is no longer held" }, 409);
        return new Response(bundle, { headers: { "content-type": "application/x-git-bundle" } });
      }
      if (req.method !== "POST" || action === "bundle") return new Response(null, { status: 404 });
      const body: unknown = await readJson(req).catch((error: unknown) => {
        if (error instanceof BodyTooLarge) throw error;
        return null;
      });
      if (!workers.authenticate(token ?? "")) return json({ error: "Worker revoked" }, 401);
      if (!workers.holds(id, worker.name)) return json({ error: "Job lease is no longer held" }, 409);
      if (action === "failure") {
        workers.fail(id, "Worker execution failed");
        return json({ ok: true });
      }
      const event = CheckEvent.safeParse(body),
        result = Result.safeParse(body);
      const invalid =
        action === "events"
          ? !event.success || !validCheck(request, event.data.result, event.data.phase)
          : !result.success
            ? true
            : result.data.sha !== request.headSha
              ? "Result SHA mismatch"
              : !validRun(request, result.data.run);
      if (invalid) {
        workers.fail(id, typeof invalid === "string" ? invalid : "Invalid gate result or requested checks");
        return json({ error: "Invalid gate result" }, 400);
      }
      if (action === "events" && event.success) workers.event(id, event.data);
      else if (result.success) workers.complete(id, result.data.run);
      return json({ ok: true });
    } catch (error) {
      return json(
        { error: "Invalid worker request" },
        error instanceof BodyTooLarge ? 413 : error instanceof PairingLimitError ? 429 : 400,
      );
    }
  };
  const split = listen.lastIndexOf(":"),
    hostname = listen.slice(0, split).replace(/^\[|\]$/g, "");
  try {
    const server = Bun.serve({
      hostname,
      port: Number(listen.slice(split + 1)),
      tls: { key: tls.key, cert: tls.cert },
      maxRequestBodySize: 2 * 1024 * 1024,
      idleTimeout: 60,
      fetch,
    });
    return {
      url: server.url,
      tls,
      async stop() {
        closing.abort();
        await server.stop(true);
        tls.release();
      },
    };
  } catch (error) {
    tls.release();
    throw error;
  }
}
