import type { ConfinementBackend } from "../src/harness/sandbox.ts";
import type { WriteRoots } from "../src/harness/scratch.ts";
import type { ProcOptions } from "../src/util/proc.ts";

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
export const seatbeltSkip =
  process.platform !== "darwin"
    ? "requires macOS Seatbelt"
    : process.env.LIMITLESS_CONFINED === "1"
      ? "nested Seatbelt unavailable inside a confined gate"
      : null;
