import { expect, spyOn } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { WorkerStore } from "../src/db/workers.ts";
import { type GateExecutor, type GateRequest, gateProvenance } from "../src/gates/executor.ts";
import type { GateRun } from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import type { RunState } from "../src/pipeline/context.ts";
import * as proc from "../src/util/proc.ts";

/** Remote results go through WorkerStore withholding; only confirmation executes local commands. */
export function postMergeWorkerFixture(f: Factory, scenario = "pass", onRetry?: () => void) {
  const workers = new WorkerStore(f.store, undefined);
  const requests = new Map<string, GateRequest>();
  const remote: string[] = [];
  const local: { command: string; sha: string; cwd: string }[] = [];
  let mergedSha = "";
  const executor: GateExecutor = {
    kind: scenario === "local" ? "local" : "lan",
    async start(req) {
      const merged = existsSync(join(req.cwd, "base.txt"));
      const kind = merged && scenario !== "local" ? "lan" : "local";
      const id = kind === "lan" ? workers.enqueue(req) : crypto.randomUUID();
      requests.set(id, req);
      return { kind, id, startedAt: Date.now() };
    },
    attach(handle, signal) {
      const req = requests.get(handle.id);
      if (!req) throw new Error("missing fake request");
      const result = (async (): Promise<GateRun> => {
        const merged = existsSync(join(req.cwd, "base.txt"));
        if (merged) {
          mergedSha = req.headSha;
          remote.push(...req.gates.checks.map((c) => c.run));
        }
        const run: GateRun = {
          setupOk: true,
          setup: [],
          checks: req.gates.checks.map((c) => ({
            name: c.name,
            command: scenario === "mismatch" && merged ? "other-suite" : c.run,
            ok: !merged,
            exitCode: merged ? 1 : 0,
            durationMs: merged ? 400_000 : 100_000,
            output: merged ? "worker diagnostic [redacted]" : "pass",
            failures: merged ? "worker diagnostic [redacted]" : undefined,
            failedFiles: scenario === "invalid files" ? ["../outside.test.ts"] : ["greeting.txt"],
            failedFileTimes: { "greeting.txt": 1 },
            failureAttributionComplete: scenario !== "missing attribution",
          })),
          ...(await gateProvenance(req.cwd, signal, req.headSha)),
        };
        if (handle.kind === "lan") {
          f.store.db
            .query("UPDATE gate_jobs SET state='leased',worker='test-worker' WHERE id=?")
            .run(handle.id);
          workers.complete(handle.id, run);
          if (scenario === "fallback")
            f.store.db
              .query("UPDATE gate_jobs SET failure_reason='local fallback',setup_fallback=1 WHERE id=?")
              .run(handle.id);
          if (scenario === "unknown worker")
            f.store.db.query("UPDATE gate_jobs SET worker=NULL WHERE id=?").run(handle.id);
        }
        if (merged && remote.length === 2) onRetry?.();
        return handle.kind === "lan" ? workers.sanitize(run) : run;
      })();
      return { result, cancel: async () => {}, events: { async *[Symbol.asyncIterator]() {} } };
    },
  };
  f.deps.gateExecutor = executor;
  const original = proc.runProcess;
  const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
    if (opts.cmd[0] !== "/bin/sh") return original(opts);
    opts.signal?.throwIfAborted();
    expect(opts.env?.CI).toBe("1");
    expect(opts.env?.LIMITLESS_CONFINED).toBe("1");
    opts.onStdoutLine?.(opts.cmd[4] ?? "");
    const command = opts.cmd.at(-1) ?? "";
    const cwd = opts.cwd ?? "";
    const sha = (await proc.sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
    expect(sha).toBe(mergedSha);
    expect(gateSlots.snapshot().holders).toContain(
      opts.env?.LIMITLESS_RUN_ID ?? f.store.listRuns()[0]?.id ?? "missing run",
    );
    local.push({ command, cwd, sha });
    const failed = scenario === "fail" || scenario === "restart fail";
    const lines = failed
      ? ["error: coordinator assertion detail", "(fail) confirmation case", "0 pass", "1 fail"]
      : ["1 pass", "0 fail"];
    for (const line of lines) opts.onStdoutLine?.(line);
    if (opts.env?.LIMITLESS_GATE_REPORT)
      writeFileSync(
        opts.env.LIMITLESS_GATE_REPORT,
        '<testsuites tests="1" failures="0" errors="0" skipped="0"/>',
      );
    return {
      exitCode: failed ? 1 : 0,
      signal: null,
      cancelled: false,
      timedOut: false,
      idleTimedOut: false,
      truncated: false,
      stdout: lines.join("\n"),
      stderr: "",
      durationMs: 1,
    };
  });
  return {
    remote,
    local,
    processSpy,
    saved: (id: string) => f.store.getRunState<RunState>(id)?.postMergeGates,
  };
}
