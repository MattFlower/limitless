import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGates } from "../src/gates/run.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { registerCredential } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";

export const gateCredential = "synthetic-gate-output-credential-409";

export async function credentialGate() {
  registerCredential("GATE_OUTPUT_TEST_TOKEN", gateCredential);
  const dir = mkdtempSync(join(tmpdir(), "limitless-gate-output-"));
  try {
    writeFileSync(
      join(dir, "output.txt"),
      `error: credential ${gateCredential}\n(fail) assertion\n${"summary\n".repeat(1_000)}${gateCredential}\n`,
    );
    return await confinementScope.run(fakeConfinement, () =>
      runGates(
        dir,
        {
          setup: [],
          checks: [{ name: "test", run: "cat output.txt; exit 1" }],
          source: "detected",
          protectedPaths: [],
        },
        new AbortController().signal,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
