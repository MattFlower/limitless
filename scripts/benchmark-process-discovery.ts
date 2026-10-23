/** bun scripts/benchmark-process-discovery.ts
 * Isolates the existing spawn hook: absent persistence versus one discovery insert.
 * OS spawning and shutdown scans are excluded from both measurements.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import type { ProcessCleanupStore, ProcessDiscovery } from "../src/util/proc.ts";

const directory = mkdtempSync(join(tmpdir(), "process-discovery-benchmark-"));
const store = new Store(join(directory, "store.db"));
const retained = 5000;
const batch = 1000;
const row = (i: number): ProcessDiscovery => ({
  invocation: `benchmark-${i}`,
  runId: `run-${i % 100}`,
  directory: join(directory, `work-${i % 100}`),
  boot: "benchmark-boot",
  createdAt: 1700000000000,
  discovery: {
    group: 10000 + i,
    started: 1700000000000,
    directories: [join(directory, `work-${i % 100}`), join(directory, `scratch-${i}`)],
    leader: { pid: 10000 + i, birth: `birth-${i}`, session: 10000 + i, group: 10000 + i },
    spawnedAt: "1234567890123456",
  },
});
const median = (samples: number[]) => samples.sort((a, b) => a - b)[2] ?? 0;
try {
  for (let i = 0; i < retained; i++) store.recordProcessDiscovery(row(i));
  const rows = Array.from({ length: batch }, (_, i) => row(retained + i));
  const samples: Record<"before" | "after", number[]> = { before: [], after: [] };
  const changes = () => store.db.query<{ count: number }, []>("SELECT total_changes() AS count").get()?.count;
  for (let trial = 0; trial < 7; trial++) {
    for (const kind of ["before", "after"] as const) {
      const target: Pick<ProcessCleanupStore, "recordProcessDiscovery"> = kind === "before" ? {} : store;
      const count = changes();
      const start = performance.now();
      for (const evidence of rows) target.recordProcessDiscovery?.(evidence);
      const elapsed = performance.now() - start;
      if (trial >= 2) samples[kind].push(elapsed);
      if (changes() !== (count ?? 0) + (kind === "after" ? batch : 0))
        throw new Error("Expected exactly one inserted row per spawn hook");
      store.db.query("DELETE FROM process_discoveries WHERE rowid > ?").run(retained);
    }
  }
  const before = median(samples.before);
  const after = median(samples.after);
  console.log(`Bun ${Bun.version}; disk SQLite WAL, synchronous=NORMAL; ${retained} retained discoveries`);
  console.log(`${batch} spawn hooks/trial; median of 5 after 2 warmups; full leader and directory evidence`);
  console.log(`Before (hook absent): ${before.toFixed(3)} ms; after: ${after.toFixed(3)} ms`);
  console.log(
    `Incremental persistence: ${(((after - before) * 1000) / batch).toFixed(3)} microseconds/spawn`,
  );
  console.log("Exactly one inserted row/hook; recording uses no process inspection or collection rewrite.");
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
