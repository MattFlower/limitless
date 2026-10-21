/** Usage: git show <base>:src/util/proc.ts > "$TMPDIR/credential-baseline.ts"
 * bun scripts/benchmark-credential-redaction.ts "$TMPDIR/credential-baseline.ts"
 * Each version/size runs in a fresh process; median of 5 trials after 2 warmups.
 */
import { spyOn } from "bun:test";
import * as subprocess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const chunks = Array.from({ length: Math.ceil(text.length / 32768) }, (_, i) =>
    text.slice(i * 32768, (i + 1) * 32768),
  );
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
    for (const kind of ["redactCredentials", "runProcess"] as const) {
      const samples: number[] = [];
      for (let trial = 0; trial < 7; trial++) {
        const start = performance.now();
        if (kind === "redactCredentials") proc.redactCredentials(text);
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
    // Keep the snapshot's imports anchored in the checkout without changing tracked files.
    const util = new URL("../src/util/", import.meta.url).href;
    await writeFile(snapshot, (await readFile(baseline, "utf8")).replaceAll('"./', `"${util}`));
    console.log(`Bun ${Bun.version}; milliseconds, median of 5 after 2 warmups; 5 MiB, 32 KiB chunks`);
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
