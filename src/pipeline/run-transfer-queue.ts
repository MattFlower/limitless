import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { RunTransferError } from "./run-transfer-errors.ts";

/** Trusted database handles alone select paths; inode identity also catches hard links. */
export function transferDatabaseIdentity(db: Database): string | Database {
  if (!db.filename || db.filename === ":memory:") return db;
  const stat = statSync(realpathSync(db.filename), { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
const queues = new Map<string | Database, Map<string, Promise<void>>>();
export async function serializeTransfer<T>(
  identity: string | Database,
  runId: string,
  signal: AbortSignal,
  action: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const runs = queues.get(identity) ?? new Map<string, Promise<void>>();
  queues.set(identity, runs);
  const previous = runs.get(runId) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  runs.set(runId, tail);
  let cancel = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new RunTransferError("aborted"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    await Promise.race([previous, aborted]);
    signal.throwIfAborted();
    return await action();
  } finally {
    signal.removeEventListener("abort", cancel);
    release();
    void tail.then(() => {
      if (runs.get(runId) === tail) runs.delete(runId);
      if (!runs.size) queues.delete(identity);
    });
  }
}
