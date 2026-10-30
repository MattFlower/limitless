import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateConfig } from "../src/gates/detect.ts";
import {
  citedFileRefusal,
  coveringTestCommand,
  selectCoveringRequests,
  trackedAtShaRefusal,
} from "../src/pipeline/covering-tests.ts";
import { sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

const config: GateConfig = {
  setup: [],
  checks: [{ name: "test", run: "bun test" }],
  retryFiles: "bun test {files}",
  source: ".limitless.toml",
  protectedPaths: [],
};
const seed = seeded(async (cwd) => {
  writeFileSync(join(cwd, "tracked.test.ts"), "");
  await sh(["git", "init", "-q"], { cwd });
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "fixture"], { cwd });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
});

test("shared preflight preserves the first refusal with several invalid properties", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "covering-requests-"));
  try {
    const { value: sha } = await seed(cwd);
    writeFileSync(join(cwd, "untracked.txt"), "");
    writeFileSync(join(cwd, "untracked.test.ts"), "");
    const requests = [
      { file: "../outside.test.ts", name: "bad\nname" },
      { file: "untracked.txt", name: "bad\nname" },
      { file: "untracked.test.ts", name: "bad\nname" },
    ];
    const reasons = [
      "file outside repository or invalid retry file",
      "file is not a test file",
      "invalid test name",
    ];
    for (const [i, request] of requests.entries()) {
      expect((await coveringTestCommand(request, config, cwd, sha)).reason).toBe(reasons[i]);
      expect(
        await coveringTestCommand(request, { ...config, retryFiles: "bun test -- {files}" }, cwd, sha),
      ).toEqual({ reason: "covering tests do not support an option terminator (--) in retry_files" });
    }
    expect(await citedFileRefusal("../outside.test.ts", cwd, "bad-sha")).toBe(reasons[0]);
    expect(await citedFileRefusal("untracked.txt", cwd, sha)).toBe("file not tracked at verified SHA");
    expect(await citedFileRefusal("tracked.test.ts", cwd, sha)).toBeUndefined();
    expect(await trackedAtShaRefusal("untracked.txt", cwd, "bad-sha")).toBe("invalid verified SHA");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shared requests retain the per-item and per-round caps and their reasons", () => {
  const item = (n: number) => Array.from({ length: n }, (_, i) => ({ file: "x.test.ts", name: `${i}` }));
  const selected = selectCoveringRequests([item(4), item(3), item(3), item(2)]);
  expect(selected.map((s) => s.tests.length)).toEqual([3, 3, 3, 1]);
  expect(selected.map((s) => s.reason)).toEqual([
    "per-criterion limit reached",
    undefined,
    undefined,
    "per-round limit reached",
  ]);
});
