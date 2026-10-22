/** bun scripts/benchmark-worker-reporting.ts; bounded comparison with the previous literal masker. */
import { redactGateData } from "../src/gates/output.ts";
import { registerCredential } from "../src/util/proc.ts";
import { agentPathMask } from "../src/workers/reporting.ts";

const credential = (i: number) => `synthetic-worker-reporting-${String(i).padStart(6, "0")}-value`;
for (let i = 0; i < 600; i++) registerCredential(`REPORT_BENCHMARK_${i}`, credential(i));
const root = "/private/tmp/worker-report-benchmark";
const paths = [root, `${root}/checkout`, "/private/var/worker-report-benchmark/scratch"];
const literals = [...paths].sort((a, b) => b.length - a.length);
const before = (data: unknown): unknown =>
  JSON.parse(
    literals.reduce(
      (text, path) => text.replaceAll(JSON.stringify(path).slice(1, -1), "<worktree>"),
      JSON.stringify(redactGateData(data)),
    ),
  );
const after = agentPathMask(paths);
const text = Array.from({ length: 65536 }, (_, i) =>
  i % 997 === 0
    ? `${paths[i % paths.length]} /tmp/worker-report-benchmark/checkout ${credential(i % 600)}\n`
    : "agent output: ordinary deterministic progress record completed successfully without errors\n",
)
  .join("")
  .slice(0, 5 * 1024 * 1024);
const data = {
  events: Array.from({ length: 200 }, (_, i) => ({
    type: "text",
    text: text.slice(Math.floor((i * text.length) / 200), Math.floor(((i + 1) * text.length) / 200)),
  })),
};
console.log(`Bun ${Bun.version}; 5 MiB, 200 events, 600 credentials; median of 5 after 2 warmups`);
for (const [name, mask] of [
  ["before", before],
  ["after", after],
] as const) {
  const samples: number[] = [];
  for (let trial = 0; trial < 7; trial++) {
    const start = performance.now();
    mask(data);
    if (trial >= 2) samples.push(performance.now() - start);
  }
  console.log(`${name}: ${samples.sort((a, b) => a - b)[2]?.toFixed(2)} ms`);
}
