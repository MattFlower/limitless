import { computeProviderWorkload } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";

const store = new Store(":memory:");
try {
  store.db.exec(`PRAGMA foreign_keys=OFF;
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO invocations(run_id,role,harness,provider,model,model_id,status,started_at)
    SELECT 'r','triage','fake','fake','m','m','ok',${Date.now()} FROM n`);
  for (const name of ["reads", "updates + reads", "workload scans"]) {
    const count = name === "workload scans" ? 10 : 20000;
    const samples: number[] = [];
    for (let trial = 0; trial < 7; trial++) {
      const start = performance.now();
      for (let i = 1; i <= count; i++) {
        if (name === "reads") store.getInvocation(i);
        else if (name === "updates + reads") store.updateInvocation(i, { status: "ok" });
        else computeProviderWorkload(store);
      }
      if (trial >= 2) samples.push(performance.now() - start);
    }
    console.log(
      `${count} ${name}: ${samples.sort((a, b) => a - b)[2]?.toFixed(2)} ms (median of 5, 2 warmups)`,
    );
  }
} finally {
  store.close();
}
