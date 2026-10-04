import { expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/harness/claude.ts";
import { CodexReaderProbe, runCodex } from "../src/harness/codex.ts";
import {
  ConfinementError,
  confinementScope,
  runConfined,
  runSandboxed,
  seatbeltBackend,
  verifySeatbelt,
} from "../src/harness/sandbox.ts";
import { withScratch } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { agentEnv, type ProcOptions, runProcess } from "../src/util/proc.ts";
import { recordingConfinement } from "./confinement.ts";

const payload = join(import.meta.dir, "fixtures/signal-payload.ts");
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
async function stop(child: ChildProcess) {
  if (!alive(child)) return;
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  await closed;
}
async function markerProcess(marker: string, roots?: { write: string[]; protect: string[] }) {
  const cmd = [process.execPath, payload, "marker", marker];
  const [bin, ...args] = roots ? seatbeltBackend.wrap(cmd, roots) : cmd;
  if (!bin) throw new Error("missing executable");
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => {
    if (alive(child)) child.kill("SIGTERM");
  }, 5000);
  try {
    const result = await Promise.race([once(child.stdout, "data"), once(child, "exit")]);
    if (!String(result[0]).includes("ready")) throw new Error("marker failed its readiness handshake");
    return child;
  } finally {
    clearTimeout(timer);
  }
}
function spec(cwd: string, scratchDir: string, mode: AgentSpec["mode"]): AgentSpec {
  return {
    cwd,
    scratchDir,
    mode,
    prompt: "offline substitute",
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    maxToolCalls: 5,
    signal: new AbortController().signal,
    logPath: join(scratchDir, "inv.log"),
    onEvent: () => {},
    target: {
      modelId: "test",
      provider: "test",
      harness: "claude",
      model: "test",
      vendor: "test",
      tier: 1,
      billing: "subscription",
    },
  };
}
function substitute(env: Record<string, string>, calls: string[][] = []): typeof runProcess {
  return (opts: ProcOptions) => {
    calls.push(opts.cmd);
    const cli = opts.cmd.findIndex((arg) => ["claude", "codex", "codex-substitute"].includes(arg));
    return runProcess({
      ...opts,
      env: { ...opts.env, ...env },
      cmd: cli < 0 ? opts.cmd : [...opts.cmd.slice(0, cli), process.execPath, payload],
    });
  };
}
function codexProbe() {
  const probe = new CodexReaderProbe();
  spyOn(probe, "verify").mockResolvedValue({
    ok: true,
    path: "codex-substitute",
    version: "offline-substitute",
    reason: null,
    exitCode: 0,
  });
  return probe;
}

test("offline substitutes cover default readers without starting installed CLIs", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "signal-substitute-")));
  try {
    await withScratch(cwd, async (scratch) => {
      const started = join(scratch, "started");
      for (const launch of [
        runClaude,
        (s: AgentSpec, r: typeof runProcess) => runCodex(s, r, codexProbe()),
      ]) {
        const { backend } = recordingConfinement();
        rmSync(started, { force: true });
        const result = await confinementScope.run(backend, () =>
          launch(
            spec(cwd, scratch, "readonly"),
            substitute({ SIGNAL_STARTED: started, SIGNAL_HANDSHAKE_ONLY: "1" }),
          ),
        );
        expect(existsSync(started)).toBe(true);
        expect(result.status).toBe("ok");
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("offline adapters and gates protect outside/sibling markers or explicitly refuse before payload", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "signal-smoke-")));
  const marker = `limitless-signal-${crypto.randomUUID()}`;
  const outside = await markerProcess(marker);
  let sibling: ChildProcess | undefined;
  try {
    await withScratch(cwd, async (scratch) => {
      let refusal: unknown;
      try {
        await verifySeatbelt(undefined, undefined, undefined, { write: [scratch], protect: [] });
      } catch (error) {
        refusal = error;
      }
      if (!refusal) sibling = await markerProcess(marker, { write: [scratch], protect: [] });
      else expect(refusal).toBeInstanceOf(ConfinementError);
      const started = join(scratch, "started");
      const env = {
        SIGNAL_MARKER: marker,
        SIGNAL_STARTED: started,
        SIGNAL_OUTSIDE: String(outside.pid),
        SIGNAL_SIBLING: String(sibling?.pid ?? outside.pid),
      };
      const paths: [string, string, () => Promise<unknown>][] = [];
      for (const mode of ["edit", "readonly"] as const) {
        for (const confineReads of mode === "readonly" ? [false, true] : [false]) {
          const invocation = { ...spec(cwd, scratch, mode), confineReads };
          paths.push([
            `claude ${mode} confineReads=${confineReads}`,
            started,
            () => runClaude(invocation, substitute(env)),
          ]);
          paths.push([
            `codex ${mode} confineReads=${confineReads}`,
            started,
            () => runCodex(invocation, substitute(env), codexProbe()),
          ]);
        }
      }
      // Gates own a different scratch; their handshake belongs in their writable checkout.
      const gateStarted = join(cwd, "gate-started");
      paths.push([
        "gate",
        gateStarted,
        () =>
          runConfined({
            cwd,
            env: agentEnv({ ...env, SIGNAL_STARTED: gateStarted }),
            command: `"${process.execPath}" "${payload}"`,
            timeoutMs: 5000,
          }),
      ]);
      for (const [name, handshake, launch] of paths) {
        rmSync(handshake, { force: true });
        try {
          const result = await launch();
          expect(refusal).toBeUndefined();
          expect(existsSync(handshake)).toBe(true);
          expect(JSON.stringify(result)).toMatch(/owned-terminated|"status":"ok"/);
          console.log(`${name}: OS signal enforcement exercised`);
        } catch (error) {
          expect(error).toBeInstanceOf(ConfinementError);
          expect(String(error)).toMatch(/signal confinement/i);
          expect(existsSync(handshake)).toBe(false);
          console.log(`${name}: confinement refused; OS enforcement not exercised`);
        }
        expect(alive(outside)).toBe(true);
        if (sibling) expect(alive(sibling)).toBe(true);
      }
    });
  } finally {
    await stop(outside);
    if (sibling) await stop(sibling);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

for (const mode of ["edit", "readonly"] as const) {
  test(`both ${mode} adapters refuse failed signal verification and nested startup without unconfined retry`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "signal-refusal-"));
    try {
      await withScratch(cwd, async (scratch) => {
        const started = join(scratch, "started");
        for (const failure of [
          "probe ineffective",
          "probe inconclusive",
          "unsupported platform",
          "nested startup",
        ]) {
          const { backend } = recordingConfinement();
          const refuse = async () => {
            throw new ConfinementError(`Signal confinement: ${failure}`);
          };
          if (failure === "nested startup") backend.nested = refuse;
          else backend.verify = refuse;
          for (const harness of ["claude", "codex"]) {
            // Claude editors intentionally disable internal Seatbelt under the outer boundary.
            if (harness === "claude" && mode === "edit" && failure === "nested startup") continue;
            const calls: string[][] = [];
            const runner = substitute({ SIGNAL_STARTED: started }, calls);
            await expect(
              confinementScope.run(backend, () =>
                harness === "claude"
                  ? runClaude(spec(cwd, scratch, mode), runner)
                  : runCodex(spec(cwd, scratch, mode), runner, codexProbe()),
              ),
            ).rejects.toThrow(`Signal confinement: ${failure}`);
            expect(calls).toHaveLength(0);
            expect(existsSync(started)).toBe(false);
          }
        }
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const action of ["timeout", "cancel"] as const) {
  test(`gate ${action} cleans owned descendants while outside marker survives, or refuses`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "signal-cleanup-"));
    const outside = await markerProcess(`outside-${crypto.randomUUID()}`);
    const abort = new AbortController();
    let owned: number | undefined;
    try {
      const result = await runConfined({
        cwd,
        command: `"${process.execPath}" "${payload}"`,
        env: agentEnv({
          SIGNAL_WAIT: "1",
          SIGNAL_MARKER: `inside-${crypto.randomUUID()}`,
          SIGNAL_STARTED: join(cwd, "started"),
        }),
        signal: abort.signal,
        timeoutMs: action === "timeout" ? 1000 : 5000,
        onStdoutLine: (line) => {
          if (line.startsWith("owned:")) {
            owned = Number(line.slice(6));
            if (action === "cancel") abort.abort();
          }
        },
      });
      expect(owned).toBeDefined();
      expect(result[action === "timeout" ? "timedOut" : "cancelled"]).toBe(true);
      // Retained test-owned PID, never a process-name lookup.
      expect(() => process.kill(owned ?? 0, 0)).toThrow();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfinementError);
      expect(existsSync(join(cwd, "started"))).toBe(false);
    } finally {
      expect(alive(outside)).toBe(true);
      await stop(outside);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
}

test("a nested CLI startup diagnostic after the outer handshake cannot report success or disappear in truncation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "signal-nested-"));
  try {
    await withScratch(cwd, async (scratch) => {
      for (const stream of ["stdout", "stderr"] as const) {
        let launches = 0;
        const { backend } = recordingConfinement();
        await expect(
          runSandboxed(
            { cmd: ["fake-cli"], cwd, env: agentEnv() },
            { write: [scratch], protect: [] },
            async (opts) => {
              launches++;
              opts.onStdoutLine?.(opts.cmd[4] ?? "");
              const observe = stream === "stdout" ? opts.onStdoutLine : opts.onStderrLine;
              observe?.("sandbox_init: Operation not permitted");
              observe?.("x".repeat(70_000));
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                idleTimedOut: false,
                cancelled: false,
                stdout: "ok",
                stderr: "",
                truncated: true,
                durationMs: 1,
              };
            },
            undefined,
            backend,
            true,
          ),
        ).rejects.toThrow(/signal confinement/i);
        expect(launches).toBe(1);
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
