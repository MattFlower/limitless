import type { ConfinementBackend } from "../src/harness/sandbox.ts";
import type { WriteRoots } from "../src/harness/scratch.ts";
import { agentEnv, type ProcOptions, type ProcResult, runProcess } from "../src/util/proc.ts";

export function recordingConfinement() {
  const calls: { roots: WriteRoots; opts: ProcOptions }[] = [];
  const backend: ConfinementBackend = {
    verify: async (roots, opts) => {
      calls.push({ roots, opts });
    },
    wrap: (cmd) => cmd,
  };
  return { backend, calls };
}
export const fakeConfinement = recordingConfinement().backend;

export function seatbeltProbeSkip(probe: Pick<ProcResult, "exitCode" | "stderr">): string | null {
  return probe.exitCode !== 0 && probe.stderr.includes("sandbox_apply: Operation not permitted")
    ? "nested Seatbelt unavailable in this sandbox"
    : null;
}

export const seatbeltSkip =
  process.platform !== "darwin"
    ? "requires macOS Seatbelt"
    : process.env.LIMITLESS_CONFINED === "1"
      ? "nested Seatbelt unavailable inside a confined gate"
      : seatbeltProbeSkip(
          await runProcess({
            cmd: ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"],
            cwd: process.cwd(),
            env: agentEnv(),
          }),
        );
