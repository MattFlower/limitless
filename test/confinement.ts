import { landlockCommand } from "../src/harness/landlock.ts";
import type { ConfinementBackend } from "../src/harness/sandbox.ts";
import { BWRAP } from "../src/harness/sandbox-linux.ts";
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

/** Exercise the launcher's fd-bind mode, including distribution backports. */
export async function bwrapProbeSkip(bwrap = BWRAP): Promise<string | null> {
  const probe = await runProcess({
    cmd: [
      ...landlockCommand(0),
      "--bwrap",
      bwrap,
      "--unshare-user",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--",
      "/bin/true",
    ],
    cwd: process.cwd(),
    env: agentEnv(),
  });
  return probe.exitCode !== 0
    ? "bubblewrap with --ro-bind-fd, user namespaces and Landlock ABI 6 unavailable"
    : null;
}

export const bwrapSkip = process.platform !== "linux" ? "requires Linux bubblewrap" : await bwrapProbeSkip();
