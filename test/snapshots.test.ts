import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createSnapshotParent, sweepOrphanedSnapshots } from "../src/pipeline/snapshots.ts";

test("the startup sweep removes snapshots of dead processes only", () => {
  const root = mkdtempSync(join(tmpdir(), "snapshot-sweep-"));
  try {
    const exited = Bun.spawnSync(["true"]).pid;
    const orphan = join(root, `limitless-holdout-${exited}-AbC123`);
    mkdirSync(join(orphan, "base"), { recursive: true });
    writeFileSync(join(orphan, "base", "file.txt"), "base\n");
    const mine = createSnapshotParent(root);
    expect(basename(mine)).toStartWith(`limitless-holdout-${process.pid}-`);
    const live = join(root, `limitless-holdout-${process.ppid}-XyZ789`);
    const unrelated = [join(root, "limitless-holdout-notapid"), join(root, "limitless-private-1-abc")];
    for (const dir of [live, ...unrelated]) mkdirSync(dir);

    expect(sweepOrphanedSnapshots(root)).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    for (const dir of [mine, live, ...unrelated]) expect(existsSync(dir)).toBe(true);
    expect(sweepOrphanedSnapshots(join(root, "missing"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
