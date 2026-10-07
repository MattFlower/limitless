import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/harness/claude.ts";
import {
  ConfinementError,
  confinementScope,
  runConfined,
  seatbeltBackend,
  verifySeatbelt,
} from "../src/harness/sandbox.ts";
import { withScratch } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { agentEnv, type ProcOptions, runProcess } from "../src/util/proc.ts";
import { recordingConfinement, seatbeltSkip } from "./confinement.ts";

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
    const cli = opts.cmd.indexOf("claude");
    return runProcess({
      ...opts,
      env: { ...opts.env, ...env },
      cmd: cli < 0 ? opts.cmd : [...opts.cmd.slice(0, cli), process.execPath, payload],
    });
  };
}

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
        if (seatbeltSkip === null) throw error;
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
      const paths: [string, string, () => Promise<unknown>][] = [
        ["claude edit", started, () => runClaude(spec(cwd, scratch, "edit"), substitute(env))],
      ];
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
          expect(JSON.stringify(result)).toContain("owned-terminated");
          console.log(`${name}: OS signal enforcement exercised`);
        } catch (error) {
          if (seatbeltSkip === null) throw error;
          expect(error).toBeInstanceOf(ConfinementError);
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

test("Claude editors refuse failed signal verification without an unconfined retry", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "signal-refusal-"));
  try {
    await withScratch(cwd, async (scratch) => {
      const started = join(scratch, "started");
      for (const failure of ["probe ineffective", "probe inconclusive", "unsupported platform"]) {
        const { backend } = recordingConfinement();
        backend.verify = async () => {
          throw new ConfinementError(`Signal confinement: ${failure}`);
        };
        const calls: string[][] = [];
        await expect(
          confinementScope.run(backend, () =>
            runClaude(spec(cwd, scratch, "edit"), substitute({ SIGNAL_STARTED: started }, calls)),
          ),
        ).rejects.toThrow(`Signal confinement: ${failure}`);
        expect(calls).toHaveLength(0);
        expect(existsSync(started)).toBe(false);
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const action of ["timeout", "cancel"] as const) {
  test(`gate ${action} cleans owned descendants while outside marker survives, or refuses`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "signal-cleanup-"));
    const outside = await markerProcess(`outside-${crypto.randomUUID()}`);
    const abort = new AbortController();
    let owned: number | undefined;
    try {
      const result = await runConfined({
        cwd,
        command: `sleep 30 & child=$!
kill -TERM "$child"
wait "$child"; status=$?
[ "$status" -gt 128 ] || exit 1
printf 'owned-terminated\\n'
exec "${process.execPath}" "${payload}"`,
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
      expect(existsSync(join(cwd, "started"))).toBe(true);
      expect(result.stdout).toContain("owned-terminated");
      expect(owned).toBeDefined();
      expect(result[action === "timeout" ? "timedOut" : "cancelled"]).toBe(true);
      // Retained test-owned PID, never a process-name lookup.
      expect(() => process.kill(owned ?? 0, 0)).toThrow();
    } catch (error) {
      if (seatbeltSkip === null) throw error;
      expect(error).toBeInstanceOf(ConfinementError);
      expect(existsSync(join(cwd, "started"))).toBe(false);
    } finally {
      expect(alive(outside)).toBe(true);
      await stop(outside);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
}
