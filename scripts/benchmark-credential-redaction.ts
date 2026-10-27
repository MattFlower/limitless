/** Freeze the pre-change files before running (use a pinned commit for <base>):
 * mkdir -p "$TMPDIR/baseline/src/util" "$TMPDIR/baseline/src/gates"
 * git show <base>:src/util/proc.ts > "$TMPDIR/baseline/src/util/proc.ts"
 * git show <base>:src/util/credential-matcher.ts > "$TMPDIR/baseline/src/util/credential-matcher.ts"
 * git show <base>:src/gates/private.ts > "$TMPDIR/baseline/src/gates/private.ts"
 * bun scripts/benchmark-credential-redaction.ts "$TMPDIR/baseline"
 * Each version/count/workload uses a fresh process, identical seeded inputs, two warmups and five trials.
 * Seven such processes per version alternate with the other version's; the table reports the median.
 * Fixture generation, registration and matcher compilation are outside the measured calls.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentEnv, runProcess } from "../src/util/proc.ts";

const counts = [0, 50, 200, 600];
const workloads = ["plain", "escaped slashes"] as const;
const rounds = 7;
type Measurement = { median: number; stall: number };
type Measurements = Record<"redactCredentials" | "privateMatches", Measurement>;

if (process.argv[2] === "--worker") {
  const root = process.argv[3];
  if (!root) throw new Error("Missing module root");
  const proc: typeof import("../src/util/proc.ts") = await import(`${root}/util/proc.ts`);
  const privateModule: typeof import("../src/gates/private.ts") = await import(`${root}/gates/private.ts`);
  const count = Number(process.argv[4]);
  const escaped = process.argv[5] === "escaped slashes";
  // Pseudorandom secrets are reproducible across isolated workers, including those with no registrations.
  const credentials = Array.from({ length: 600 }, (_, i) =>
    createHash("sha256").update(`privacy-benchmark-seed-880-${i}`).digest("base64"),
  );
  const entries = Array.from({ length: 8 }, (_, i) => ({
    value: `synthetic-private-${i}/host.example`,
    entry: i + 1,
  }));
  for (let i = 0; i < count; i++) proc.registerCredential(`BENCHMARK_${i}`, credentials[i]);
  const lines = Array.from({ length: 65536 }, (_, i) => {
    if (i % 97 === 0) {
      const line = JSON.stringify({
        time: "2026-10-26T12:00:00Z",
        level: "debug",
        message: "request completed",
        path: "/api/runs/status",
        token: credentials[i % credentials.length],
        detail: i % 997 === 0 ? entries[i % entries.length]?.value : "ordinary response",
      });
      return `${escaped ? line.replaceAll("/", "\\/") : line}\n`;
    }
    return `2026-10-26T12:00:00Z INFO invocation ${i}: completed stage check; duration=24ms status=ok\n`;
  });
  const text = lines
    .join("")
    .repeat(2)
    .slice(0, 5 * 1024 * 1024);
  if (Buffer.byteLength(text) !== 5 * 1024 * 1024) throw new Error("Wrong fixture size");
  const result: Partial<Measurements> = {};
  for (const kind of ["redactCredentials", "privateMatches"] as const) {
    const invoke = () =>
      kind === "redactCredentials"
        ? proc.redactCredentials(text)
        : privateModule.privateMatches(text, entries);
    const samples: number[] = [];
    // Amortize clock resolution for the empty dictionary's constant-time return.
    const iterations = count === 0 && kind === "redactCredentials" ? 1_000_000 : 1;
    let stall = 0;
    for (let trial = 0; trial < 7; trial++) {
      // A queued event-loop callback measures the synchronous call's blocking interval.
      let delay = 0;
      const scheduled = performance.now();
      const tick = new Promise<void>((done) =>
        setImmediate(() => {
          delay = performance.now() - scheduled;
          done();
        }),
      );
      const start = performance.now();
      invoke();
      let elapsed = performance.now() - start;
      await tick;
      if (iterations > 1) {
        const batchStart = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++) invoke();
        elapsed = (performance.now() - batchStart) / iterations;
      }
      if (trial >= 2) {
        samples.push(elapsed);
        stall = Math.max(stall, delay);
      }
    }
    result[kind] = { median: samples.sort((a, b) => a - b)[2] ?? 0, stall };
  }
  console.log(JSON.stringify(result));
} else {
  const baseline = process.argv[2];
  if (!baseline) throw new Error("Pass the baseline directory containing src/{util,gates} snapshots");
  const scratch = await mkdtemp(join(tmpdir(), "privacy-benchmark-"));
  const frozen = ["util/proc.ts", "util/credential-matcher.ts", "gates/private.ts"];
  try {
    // Anchor all remaining imports in the checkout; the three explicitly frozen modules stay frozen.
    for (const file of frozen) {
      const source = await readFile(join(baseline, "src", file), "utf8");
      await writeFile(
        join(scratch, file.replaceAll("/", "-")),
        source.replace(/(["'])(\.{1,2}\/[^"']+|entities)\1/g, (_match, quote: string, spec: string) => {
          if (spec === "entities") return `${quote}${import.meta.resolve(spec)}${quote}`;
          const target = resolve(dirname(`/src/${file}`), spec).slice("/src/".length);
          const url = frozen.includes(target)
            ? pathToFileURL(join(scratch, target.replaceAll("/", "-"))).href
            : new URL(`../src/${target}`, import.meta.url).href;
          return `${quote}${url}${quote}`;
        }),
      );
    }
    // Workers import a consistent root; baseline entry modules forward to the rewritten snapshots.
    const { mkdir } = await import("node:fs/promises");
    for (const file of ["util/proc.ts", "gates/private.ts"]) {
      await mkdir(join(scratch, dirname(file)), { recursive: true });
      await writeFile(join(scratch, file), `export * from "../${file.replaceAll("/", "-")}";\n`);
    }
    console.log(
      `Bun ${Bun.version}; 5 MiB ASCII logs + JSON; 8 private entries; median of 5 after 2 warmups, median of ${rounds} alternating processes`,
    );
    console.log("Times and worst queued-callback event-loop stalls in ms; generation/registration excluded.");
    console.log(
      "Empty-dictionary runtime: 1,000,000 calls/trial, reported per call; stalls always use one call.",
    );
    console.log(
      "| Function | Workload | Credentials | Before ms | After ms | Change | Before stall | After stall |",
    );
    console.log("|---|---|---:|---:|---:|---:|---:|---:|");
    for (const workload of workloads) {
      for (const count of counts) {
        const roots = [pathToFileURL(scratch).href, new URL("../src", import.meta.url).href];
        const results: Measurements[][] = [[], []];
        // Alternate which version runs first so drifting machine load affects both versions alike.
        for (let round = 0; round < rounds; round++) {
          for (const version of round % 2 ? [1, 0] : [0, 1]) {
            const result = await runProcess({
              cmd: [
                process.execPath,
                import.meta.path,
                "--worker",
                roots[version] ?? "",
                String(count),
                workload,
              ],
              cwd: process.cwd(),
              env: agentEnv(),
            });
            if (result.exitCode !== 0) throw new Error(result.stderr);
            results[version]?.push(JSON.parse(result.stdout));
          }
        }
        const combine = (runs: Measurements[] | undefined, kind: keyof Measurements): Measurement => {
          const medians = (runs ?? []).map((run) => run[kind].median).sort((a, b) => a - b);
          return {
            median: medians[Math.floor(medians.length / 2)] ?? 0,
            stall: Math.max(...(runs ?? []).map((run) => run[kind].stall)),
          };
        };
        for (const kind of ["redactCredentials", "privateMatches"] as const) {
          const b = combine(results[0], kind);
          const a = combine(results[1], kind);
          const change = ((a.median / b.median - 1) * 100).toFixed(1);
          console.log(
            `| ${kind} | ${workload} | ${count} | ${b.median.toFixed(6)} | ${a.median.toFixed(6)} | ${change}% | ${b.stall.toFixed(3)} | ${a.stall.toFixed(3)} |`,
          );
        }
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
