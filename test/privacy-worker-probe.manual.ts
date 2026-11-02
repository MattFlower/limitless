// Manual real-worker regression: bun test/privacy-worker-probe.manual.ts (outside the unit suite).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentEnv, runProcess } from "../src/util/proc.ts";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "privacy-worker-visibility-"));
try {
  await mkdir(join(scratch, "src/util/privacy-worker.ts"), { recursive: true });
  const child = await runProcess({
    cmd: [
      process.execPath,
      "scripts/probe-privacy-worker.ts",
      "--probe-packaged",
      root,
      scratch,
      join(scratch, "missing"),
    ],
    cwd: root,
    env: agentEnv(),
    timeoutMs: 30_000,
  });
  assert.equal(child.exitCode, 0, child.stderr);
  const report = JSON.parse(child.stdout) as Record<string, unknown>;
  assert.deepEqual(report.visible, [root]);
  assert.equal(report.workers, 1);
  assert.equal(report.disposed, true);
  assert.equal(report.results, "safe, private-match");
  console.log("Privacy worker visibility, results and disposal passed.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
