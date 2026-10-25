/** Usage: mkdir "$TMPDIR/baseline"; for f in proc credential-matcher terminal-redaction; do
 *   git show <base>:src/util/$f.ts > "$TMPDIR/baseline/$f.ts"; done
 * bun scripts/benchmark-credential-redaction.ts "$TMPDIR/baseline/proc.ts"
 * Freeze terminal-redaction too so process output uses the snapshot's credential registry.
 * Modules beside the snapshot stay frozen; other imports resolve in the checkout.
 * Each version/size runs in a fresh process; median of 5 trials after 2 warmups.
 */
import { spyOn } from "bun:test";
import * as subprocess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { agentEnv, runProcess } from "../src/util/proc.ts";

const credential = (i: number) => `synthetic-benchmark-${String(i).padStart(6, "0")}-value`;
if (process.argv[2] === "--worker") {
  const modulePath = process.argv[3];
  if (!modulePath) throw new Error("Missing module path");
  const proc: typeof import("../src/util/proc.ts") = await import(modulePath);
  const count = Number(process.argv[4]);
  for (let i = 0; i < count; i++) proc.registerCredential(`BENCHMARK_${i}`, credential(i));
  const lines = Array.from({ length: 65536 }, (_, i) =>
    i % 997 === 0
      ? `invocation event ${credential(0)} ${credential(49)}\n`
      : "invocation event: deterministic ordinary stdout log record completed successfully\n",
  );
  const text = lines
    .join("")
    .repeat(2)
    .slice(0, 5 * 1024 * 1024);
  // The same workload with SGR colouring, as gate output often has.
  const colored = text.replaceAll("event", "\u001b[32mevent\u001b[0m").slice(0, text.length);
  const split = (s: string) =>
    Array.from({ length: Math.ceil(s.length / 32768) }, (_, i) => s.slice(i * 32768, (i + 1) * 32768));
  const events = Array.from({ length: 20000 }, (_, i) => ({
    timestamp: 1700000000000 + i,
    input: [12345678 + i, 23456789 + i, 34567890 + i],
    output: [45678901 + i, 56789012 + i, 67890123 + i],
  }));
  let chunks = split(text);
  const spawnFixture = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    setImmediate(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0, null));
    });
    return child as unknown as subprocess.ChildProcess;
  };
  const fixture = spyOn(subprocess, "spawn").mockImplementation(spawnFixture as typeof subprocess.spawn);
  try {
    const result: Record<string, number> = {};
    for (const kind of [
      "redactCredentials",
      "redactCredentialData",
      "runProcess",
      "runProcessSGR",
    ] as const) {
      chunks = split(kind === "runProcessSGR" ? colored : text);
      const samples: number[] = [];
      for (let trial = 0; trial < 7; trial++) {
        const start = performance.now();
        if (kind === "redactCredentials") proc.redactCredentials(text);
        else if (kind === "redactCredentialData")
          for (const event of events) proc.redactCredentialData(event);
        else
          await proc.runProcess({
            cmd: ["fixture"],
            cwd: process.cwd(),
            env: {},
            redactOutput: true,
            tailLimit: 128 * 1024,
            maxLineLength: 4096,
          });
        if (trial >= 2) samples.push(performance.now() - start);
      }
      result[kind] = Number(samples.sort((a, b) => a - b)[2]?.toFixed(2));
    }
    console.log(JSON.stringify({ count, ...result }));
  } finally {
    fixture.mockRestore();
  }
} else {
  const baseline = process.argv[2];
  if (!baseline) throw new Error("Pass the baseline proc.ts snapshot path");
  const scratch = await mkdtemp(join(tmpdir(), "credential-benchmark-"));
  try {
    const snapshot = join(scratch, "proc.ts");
    // Keep the snapshot's other imports anchored in the checkout without changing tracked files.
    const util = new URL("../src/util/", import.meta.url).href;
    const frozen = (await readdir(dirname(baseline))).filter((file) => file.endsWith(".ts"));
    for (const file of frozen)
      await writeFile(
        join(scratch, file),
        (await readFile(join(dirname(baseline), file), "utf8")).replace(/"\.\/([^"]+)"/g, (spec, name) =>
          frozen.includes(name) ? spec : `"${util}${name}"`,
        ),
      );
    console.log(`Bun ${Bun.version}; milliseconds, median of 5 after 2 warmups; 5 MiB, 32 KiB chunks`);
    console.log("redactCredentialData: 20,000 events, seven numbers of eight or more digits per event");
    for (const [version, path] of [
      ["before", pathToFileURL(snapshot).href],
      ["after", new URL("../src/util/proc.ts", import.meta.url).href],
    ]) {
      if (!path) continue;
      for (const count of [0, 50, 200, 600]) {
        const result = await runProcess({
          cmd: [process.execPath, import.meta.path, "--worker", path, String(count)],
          cwd: process.cwd(),
          env: agentEnv(),
        });
        if (result.exitCode !== 0) throw new Error(result.stderr);
        console.log(version, result.stdout.trim());
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
