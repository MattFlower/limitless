import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORPHAN = /^limitless-holdout-(\d+)-.+$/;

/** A private parent for one holdout base snapshot, named after this process to identify orphans. */
export function createSnapshotParent(root = tmpdir()): string {
  return mkdtempSync(join(root, `limitless-holdout-${process.pid}-`));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove base snapshots left behind by processes that died mid-holdout (a crash skips the cleanup
 * in `finally`). Snapshots of live processes, such as another daemon or a test run, stay.
 */
export function sweepOrphanedSnapshots(root = tmpdir()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const pid = Number(ORPHAN.exec(name)?.[1] ?? Number.NaN);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(join(root, name));
    } catch {
      // Another user's directory in a shared /tmp, or already gone: not ours to remove.
    }
  }
  return removed;
}
