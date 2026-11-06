import { expect, mock, spyOn } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as subprocess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Store } from "../src/db/store.ts";
import { RunnerFailureEvidence } from "../src/gates/attribution.ts";
import { compareGates, runGates } from "../src/gates/run.ts";
import { BunTestCoverage } from "../src/gates/test-coverage.ts";
import { confinementScope, runSandboxed } from "../src/harness/sandbox.ts";
import { withScratch } from "../src/harness/scratch.ts";
import { privacyLimits } from "../src/util/privacy-boundary.ts";
import {
  CommandError,
  ProcessTerminationError,
  type ProcOptions,
  processBirthInspection,
  processBootInspection,
  processDrainObserver,
  processInspection,
  processScope,
  recoveryProcessStopped,
  registerCredential,
  runProcess,
  sh,
} from "../src/util/proc.ts";
import { processCaptureObserver } from "../src/util/proc-capture.ts";
import { sanitizationObserver } from "../src/util/terminal-redaction.ts";
import { fakeConfinement } from "./confinement.ts";
import { expectProcessStopped } from "./process-support.ts";
import { test } from "./read-policy-support.ts";

type Chunk = { stream: "stdout" | "stderr"; text: string | Buffer };

/** Control pipe chunk boundaries without subprocess scheduling or timing margins. */
async function withChunks<T>(
  chunks: Chunk[] | ((token: string | undefined) => Chunk[]),
  run: () => Promise<T>,
  finish: {
    beforeEnd?: (child: subprocess.ChildProcess) => void | Promise<void>;
    code?: number;
    signal?: string;
  } = {},
): Promise<T> {
  const spawnFixture = (_bin: string, args?: readonly string[]) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      stdio: [stdin, stdout, stderr],
    }) as unknown as subprocess.ChildProcess;
    setImmediate(async () => {
      let ended = 0;
      const end = () => {
        if (++ended === 2) setImmediate(() => child.emit("close", finish.code ?? 0, finish.signal ?? null));
      };
      stdout.once("end", end);
      stderr.once("end", end);
      // The real sandbox wrapper prints this trusted startup token before its payload.
      const token = args?.[3];
      if (Array.isArray(chunks) && typeof token === "string" && token.startsWith("limitless-started-"))
        stdout.write(`${token}\n`);
      for (const chunk of typeof chunks === "function" ? chunks(token) : chunks)
        ({ stdout, stderr })[chunk.stream].write(chunk.text);
      await finish.beforeEnd?.(child);
      stdout.end();
      stderr.end();
    });
    return child;
  };
  const spawn = spyOn(subprocess, "spawn").mockImplementation(spawnFixture as typeof subprocess.spawn);
  try {
    return await run();
  } finally {
    spawn.mockRestore();
  }
}

const options = (): ProcOptions => ({ cmd: ["fixture"], cwd: process.cwd(), env: {} });
const captured = (opts?: Partial<ProcOptions>) =>
  runProcess({ ...options(), captureComplete: true, ...opts });

type DrainEvent = Parameters<NonNullable<ReturnType<typeof processDrainObserver.getStore>>["observe"]>[0];
const pieces = (text: string): Chunk[] =>
  Array.from({ length: Math.ceil(text.length / 131072) }, (_, i) => ({
    stream: "stdout",
    text: text.slice(i * 131072, (i + 1) * 131072),
  }));

test.each(["long", "short"])("captured %s-line bursts yield within the shared budget", async (kind) => {
  const text = kind === "long" ? "x".repeat(8 * 1024 * 1024) : `${"first\nsecond\n".repeat(436906)}last`;
  const events: DrainEvent[] = [];
  let sentinel = false;
  let admittedAtSentinel = 0;
  let admitted = 0;
  let first = true;
  const lines: string[] = [];
  const result = await processDrainObserver.run(
    {
      budget: 32768,
      observe: (e) => {
        events.push(e);
        admitted += e.admitted;
      },
    },
    () =>
      withChunks(pieces(text), () =>
        captured({
          tailLimit: 100,
          maxLineLength: 65536,
          onStdoutLine: (line) => lines.push(line),
          onRawChunk: () => {
            if (!first) return;
            first = false;
            setImmediate(() => {
              sentinel = true;
              admittedAtSentinel = admitted;
            });
          },
        }),
      ),
  );
  expect(sentinel).toBe(true);
  expect(admittedAtSentinel).toBeLessThan(text.length);
  expect(admitted).toBe(text.length);
  expect(new Set(events.filter((e) => e.admitted).map((e) => e.turn)).size).toBeGreaterThan(1);
  expect(lines).toEqual(kind === "long" ? [`${"x".repeat(65536)} [truncated]`] : text.split("\n"));
  expect(result).toMatchObject({
    stdout: text.slice(-100),
    stderr: "",
    truncated: true,
    stdoutTruncated: true,
    stderrTruncated: false,
  });
  expect(result.capture).toEqual({ provenance: { kind: "complete" }, stdout: text, stderr: "" });
});

test.each(["stdout", "stderr"] as const)(
  "captured redaction survives budget slice boundaries on %s",
  async (stream) => {
    const budget = 4096;
    const head = "synthetic-budget-head";
    const foot = "distinct-budget-footer";
    const secret = head + foot;
    registerCredential("BUDGET_SLICE_TEST_TOKEN", secret);
    // One received chunk; the first turn ends inside the escape embedded in the credential.
    const start = "visible-start ";
    const prefix = start + ".".repeat(budget - start.length - head.length - 2);
    const text = `${prefix}${head}\u001b[31m${foot}\u001b[0m visible-end\n`;
    const expected = `${prefix}[redacted] visible-end`;
    const events: DrainEvent[] = [];
    const raw: string[] = [];
    const lines: string[] = [];
    const result = await processDrainObserver.run({ budget, observe: (e) => events.push(e) }, () =>
      withChunks([{ stream, text }], () =>
        captured({
          redactOutput: true,
          onRawChunk: (chunk) => raw.push(chunk),
          onStdoutLine: (line) => lines.push(line),
          onStderrLine: (line) => lines.push(line),
        }),
      ),
    );
    expect(raw).toEqual([text]);
    const admissions = events.filter((e) => e.admitted > 0);
    expect(admissions.map((e) => e.admitted)).toEqual([budget, text.length - budget]);
    expect(new Set(admissions.map((e) => e.turn)).size).toBe(2);
    expect(lines).toEqual([expected]);
    expect(result[stream]).toBe(`${expected}\n`);
    for (const output of [...lines, result[stream]])
      for (const fragment of [secret, head, foot]) expect(output).not.toContain(fragment);
  },
);

test("concurrent captures share a round-robin turn budget", async () => {
  const events: DrainEvent[] = [];
  const text = "entry\n".repeat(40000);
  const results = await processDrainObserver.run({ budget: 32768, observe: (e) => events.push(e) }, () =>
    withChunks(pieces(text), () => Promise.all([captured(), captured()])),
  );
  const admissions = events.filter((e) => e.admitted);
  const turns = new Map<number, number>();
  const progress = new Map<number, number>();
  for (const e of admissions) {
    turns.set(e.turn, (turns.get(e.turn) ?? 0) + e.admitted);
    expect(e.total).toBe(turns.get(e.turn) ?? 0);
    expect(e.total).toBeLessThanOrEqual(32768);
    progress.set(e.process, (progress.get(e.process) ?? 0) + e.admitted);
    if (progress.get(e.process) === text.length) expect(progress.size).toBe(2);
  }
  expect(new Set(admissions.slice(0, 2).map((e) => e.process)).size).toBe(2);
  expect([...progress.values()]).toEqual([text.length, text.length]);
  for (const result of results)
    expect(result.capture).toEqual({ provenance: { kind: "complete" }, stdout: text, stderr: "" });
});

test("capture backpressure bounds a real fast writer beyond the capture cap", async () => {
  const events: DrainEvent[] = [];
  let lines = 0;
  const result = await processDrainObserver.run(
    { budget: 32768, highWater: 65536, lowWater: 32768, observe: (e) => events.push(e) },
    () =>
      captured({
        cmd: [process.execPath, "-e", 'process.stdout.write("x".repeat(32 * 1024 * 1024))'],
        maxLineLength: 65536,
        onStdoutLine: () => lines++,
        timeoutMs: 15000,
      }),
  );
  const peak = Math.max(...events.map((e) => e.queued));
  const chunk = Math.max(...events.map((e) => e.received));
  expect(peak).toBeLessThanOrEqual(65536 + chunk);
  expect(events.some((e) => e.paused)).toBe(true);
  expect(events.some((e, i) => i > 0 && events[i - 1]?.paused && !e.paused)).toBe(true);
  expect(events.reduce((sum, e) => sum + e.admitted, 0)).toBe(32 * 1024 * 1024);
  expect(lines).toBe(1);
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "x".repeat(64000) });
  expect(result.capture).toEqual({ provenance: { kind: "cut", truncated: true } });
}, 20000);

test("end and close flushes finish queued unterminated lines before resolution", async () => {
  const lines: string[] = [];
  let resolved = false;
  const observe = (stream: string) => (line: string) => {
    expect(resolved).toBe(false);
    lines.push(`${stream}:${line}`);
  };
  const result = await processDrainObserver.run({ budget: 1, observe: () => {} }, () =>
    withChunks(
      [
        { stream: "stdout", text: "one\nlast-out" },
        { stream: "stderr", text: "two\nlast-err" },
      ],
      () => captured({ onStdoutLine: observe("out"), onStderrLine: observe("err") }),
    ).then((result) => {
      resolved = true;
      return result;
    }),
  );
  expect(lines).toEqual(["out:one", "err:two", "out:last-out", "err:last-err"]);
  expect(result).toMatchObject({ stdout: "one\nlast-out", stderr: "two\nlast-err" });
});

test("spawn and stdin diagnostics follow previously queued stream data", async () => {
  const lines: string[] = [];
  const result = await processDrainObserver.run({ budget: 1, observe: () => {} }, () =>
    withChunks(
      [{ stream: "stderr", text: "before\n" }],
      () =>
        captured({
          redactOutput: true,
          onStderrLine: (line) => lines.push(line),
        }),
      {
        beforeEnd: (child) => {
          child.emit("error", new Error("spawn diagnostic"));
          child.stdin?.emit("error", new Error("input diagnostic"));
        },
      },
    ),
  );
  expect(lines).toEqual(["before", "[spawn error] spawn diagnostic", "[stdin error] input diagnostic"]);
  expect(result.stderr).toBe("before\n\n[spawn error] spawn diagnostic\n[stdin error] input diagnostic");
});

test("a stream's EOF redaction flush stays ahead of later data on the other stream", async () => {
  registerCredential("EOF_ORDER_TEST", "synthetic-eof-order-credential".padEnd(128, "q"));
  const lines: string[] = [];
  const result = await processDrainObserver.run({ budget: 16, observe: () => {} }, () =>
    withChunks(
      [{ stream: "stdout", text: "out\n" }],
      () =>
        captured({
          redactOutput: true,
          onStdoutLine: (line) => lines.push(line),
          onStderrLine: (line) => lines.push(line),
        }),
      {
        beforeEnd: async (child) => {
          const stdout = child.stdout;
          const stderr = child.stderr;
          if (!(stdout instanceof PassThrough) || !(stderr instanceof PassThrough))
            throw Error("missing fixture streams");
          const ended = new Promise<void>((resolve) => stdout.once("end", resolve));
          stdout.end();
          await ended;
          stderr.write(`err\n${"z".repeat(256)}\n`);
        },
      },
    ),
  );
  expect(lines).toEqual(["out", "err", "z".repeat(256)]);
  expect(result).toMatchObject({ stdout: "out\n", stderr: `err\n${"z".repeat(256)}\n` });
});

test("aborting mid-drain drops pending admission while another capture completes", async () => {
  const controller = new AbortController();
  const text = "line\n".repeat(50000);
  let current: DrainEvent | undefined;
  let cancelledId: number | undefined;
  let admittedAfterAbort = 0;
  const results = await processDrainObserver.run(
    {
      budget: 1024,
      observe: (e) => {
        if (e.process === cancelledId) admittedAfterAbort += e.admitted;
        if (e.admitted) current = e;
      },
    },
    () =>
      withChunks(pieces(text), () =>
        Promise.all([
          captured({
            signal: controller.signal,
            onStdoutLine: () => {
              if (controller.signal.aborted) return;
              expect(current?.queued).toBeGreaterThan(0);
              cancelledId = current?.process;
              controller.abort();
            },
          }),
          captured(),
        ]),
      ),
  );
  expect(cancelledId).toBeDefined();
  expect(admittedAfterAbort).toBe(0);
  expect(results[0]).toMatchObject({ cancelled: true, capture: { provenance: { kind: "legacy-unknown" } } });
  expect(results[1]?.capture).toEqual({ provenance: { kind: "complete" }, stdout: text, stderr: "" });
});

test("captured timeout stops a yielded drain with a backpressured child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-drain-timeout-"));
  const ready = join(dir, "backpressured");
  const drained = join(dir, "drained");
  const events: DrainEvent[] = [];
  const controller = new AbortController();
  const children: subprocess.ChildProcess[] = [];
  const spawn = subprocess.spawn;
  const setTimer = globalThis.setTimeout;
  const immediate = globalThis.setImmediate;
  const held = Promise.withResolvers<void>();
  let firstAdmission = true;
  let holdNext = false;
  let resumeDrain = () => {};
  let fire: () => void = () => {
    throw new Error("timeout was not installed");
  };
  const deadline = Promise.withResolvers<never>();
  // Bound both readiness and close, independently of the intercepted timeout.
  const deadlineTimer = setTimer(
    () => deadline.reject(new Error("captured timeout did not complete")),
    10000,
  );
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms !== 25) return setTimer(fn, ms, ...args);
    fire = () => fn(...args);
    return setTimer(() => {}, 60000);
  }) as typeof setTimeout);
  const scheduling = spyOn(globalThis, "setImmediate").mockImplementation(((
    fn: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => {
    if (!holdNext) return immediate(fn, ...args);
    holdNext = false;
    resumeDrain = () => {
      resumeDrain = () => {};
      immediate(fn, ...args);
    };
    held.resolve();
    return immediate(() => {});
  }) as typeof setImmediate);
  const spawning = spyOn(subprocess, "spawn").mockImplementation(((
    ...args: Parameters<typeof subprocess.spawn>
  ) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof subprocess.spawn);
  try {
    const running = processDrainObserver.run(
      {
        budget: 1024,
        highWater: 4096,
        lowWater: 2048,
        observe: (e) => {
          events.push(e);
          if (e.admitted && firstAdmission) {
            firstAdmission = false;
            // This step consumes the whole budget; hold the drain's next scheduled turn.
            holdNext = true;
          }
        },
      },
      () =>
        captured({
          cmd: [
            process.execPath,
            "-e",
            `import { writeFileSync } from "node:fs";
             if (process.stdout.write(Buffer.alloc(32 * 1024 * 1024, 120))) throw Error("expected backpressure");
             process.stdout.once("drain", () => writeFileSync(${JSON.stringify(drained)}, "drained"));
             writeFileSync(${JSON.stringify(ready)}, "ready");
             setInterval(() => {}, 1000);`,
          ],
          signal: controller.signal,
          timeoutMs: 25,
        }),
    );
    await Promise.race([held.promise, running, deadline.promise]);
    while (!existsSync(ready)) await Promise.race([Bun.sleep(10), deadline.promise]);
    const pending = events.at(-1);
    expect(pending?.queued).toBeGreaterThan(0);
    expect(pending?.paused).toBe(true);
    expect(existsSync(drained)).toBe(false);
    expect(events.reduce((sum, e) => sum + e.admitted, 0)).toBe(1024);
    const beforeTimeout = events.length;
    fire();
    resumeDrain();
    const result = await Promise.race([running, deadline.promise]);
    expect(
      events
        .slice(beforeTimeout)
        .reduce((sum, e) => sum + (e.process === pending?.process ? e.admitted : 0), 0),
    ).toBe(0);
    expect(result).toMatchObject({
      timedOut: true,
      cancelled: false,
      capture: { provenance: { kind: "legacy-unknown" } },
    });
  } finally {
    scheduling.mockRestore();
    timer.mockRestore();
    spawning.mockRestore();
    controller.abort();
    resumeDrain();
    clearTimeout(deadlineTimer);
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("the shared drain restores each capture's async context instead of its waker's", async () => {
  const store = new AsyncLocalStorage<string>();
  const received: string[] = [];
  const observed: string[] = [];
  await processDrainObserver.run({ budget: 16, observe: () => {} }, () =>
    withChunks([{ stream: "stdout", text: "first\nsecond\nlast" }], async () => {
      const start = (name: string) =>
        store.run(name, () =>
          captured({
            onRawChunk: () => received.push(name),
            onStdoutLine: () => {
              observed.push(name);
              expect(store.getStore()).toBe(name);
            },
          }),
        );
      await Promise.all([start("waker"), start("other")]);
    }),
  );
  expect(received).toEqual(["waker", "other"]);
  expect(observed.filter((name) => name === "other")).toHaveLength(3);
});

test("complete capture preserves split UTF-8 and pre-redaction text on both streams", async () => {
  const secret = "synthetic-complete-capture-credential";
  registerCredential("COMPLETE_CAPTURE_TEST_TOKEN", secret);
  const text = `\uFEFFé€🔑\u001b[31m${secret}\u001b[0m\nlast`;
  const bytes = Buffer.from(text);
  const chunks = Array.from(bytes, (_, i) =>
    (["stdout", "stderr"] as const).map((stream) => ({ stream, text: bytes.subarray(i, i + 1) })),
  ).flat();
  const lines: string[] = [];
  const raw = { stdout: "", stderr: "" };
  const result = await withChunks(
    chunks,
    () =>
      captured({
        redactOutput: true,
        onRawChunk: (chunk, stream) => {
          raw[stream] += chunk;
        },
        onStdoutLine: (line) => lines.push(line),
        onStderrLine: (line) => lines.push(line),
      }),
    { code: 7 },
  );
  expect(result.capture).toEqual({ provenance: { kind: "complete" }, stdout: text, stderr: text });
  expect(raw).toEqual({ stdout: text, stderr: text });
  expect(result.stdout).toBe("\uFEFFé€🔑[redacted]\nlast");
  expect(result.stderr).toBe(result.stdout);
  expect(lines).toEqual(["\uFEFFé€🔑[redacted]", "\uFEFFé€🔑[redacted]", "last", "last"]);
  expect(result.exitCode).toBe(7);
});

test("captured observers sanitize once with exact whole-line credentials on both streams", async () => {
  const secret = "synthetic-sanitize-once-credential";
  const short = "a1short";
  registerCredential("SANITIZE_ONCE_LONG", secret);
  registerCredential("SANITIZE_ONCE_SHORT", short);
  const input = [
    "\u001b[32mvisible\u001b[0m",
    secret,
    short,
    `prefix-${short}-suffix`,
    `test/${secret}.test.ts:`,
    "(pass) synthetic",
    "(skip) unavailable",
    "1 pass",
    "0 fail",
    "1 skip",
    "Ran 2 tests across 1 file.",
    short,
  ];
  const expected = [
    "visible",
    "[redacted]",
    "[redacted]",
    `prefix-${short}-suffix`,
    "test/[redacted].test.ts:",
    "(pass) synthetic",
    "(skip) unavailable",
    "1 pass",
    "0 fail",
    "1 skip",
    "Ran 2 tests across 1 file.",
    "[redacted]",
  ];
  for (const stream of ["stdout", "stderr"] as const) {
    const coverage = new BunTestCoverage();
    const evidence = new RunnerFailureEvidence();
    const seen: string[] = [];
    const counts = { stream: 0, full: 0 };
    const observe = (line: string) => {
      seen.push(line);
      coverage.observe(line);
      evidence.observe(line);
    };
    const text = input.join("\n");
    const split = text.indexOf(secret) + 13;
    const chunks = [text.slice(0, split), text.slice(split)].map((text) => ({ stream, text }));
    const result = await sanitizationObserver.run(
      (kind) => counts[kind]++,
      () =>
        withChunks(chunks, () =>
          captured({
            redactOutput: true,
            maxLineLength: 65536,
            onStdoutLine: observe,
            onStderrLine: observe,
          }),
        ),
    );
    expect(counts).toEqual({ stream: 6, full: 0 }); // Two data pushes; end and close flush both streams.
    expect(seen).toEqual(expected);
    expect(result.capture).toEqual({
      provenance: { kind: "complete" },
      stdout: stream === "stdout" ? text : "",
      stderr: stream === "stderr" ? text : "",
    });
    expect(result[stream]).toBe(["visible", "[redacted]", short, ...expected.slice(3, -1), short].join("\n"));
    expect(coverage.result()).toEqual({
      passedFiles: ["test/[redacted].test.ts"],
      skippedFiles: ["test/[redacted].test.ts"],
      skippedTestsIncomplete: true,
      summary: { passed: 1, failed: 0 },
    });
    expect(evidence.agrees({ tests: 2, failures: 0, errors: 0, skipped: 1 })).toBe(true);
  }
});

test.each(["stdout", "stderr"] as const)("capture refuses malformed %s bytes", async (stream) => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xf0, 0x9f])]) {
    const result = await withChunks(
      [
        { stream, text: "unpublished-capture-sentinel" },
        { stream, text: bytes },
      ],
      () => captured(),
    );
    expect(result.capture).toEqual({ provenance: { kind: "legacy-unknown" } });
    expect(result[stream]).toBe("unpublished-capture-sentinel\uFFFD");
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, cancelled: false });
  }
});

test("capture shares one UTF-16 cap and discards overflow while draining", async () => {
  const out = "🔑".repeat(privacyLimits.inputUnits / 4);
  const err = "e".repeat(privacyLimits.inputUnits / 2);
  for (const extra of [false, true]) {
    let retained = 0;
    const observed: number[] = [];
    const chunks: Chunk[] = [
      { stream: "stdout", text: out },
      { stream: "stderr", text: err },
    ];
    if (extra) chunks.push({ stream: "stderr", text: "!" }, { stream: "stdout", text: "after-overflow" });
    const run = () =>
      withChunks(chunks, () => captured({ tailLimit: 14, onRawChunk: () => observed.push(retained) }));
    const result = await processCaptureObserver.run(
      (units) => {
        expect(units).toBeLessThanOrEqual(privacyLimits.inputUnits);
        retained = units;
      },
      () => processDrainObserver.run({ highWater: 16 * 1024 * 1024, observe: () => {} }, run),
    );
    expect(observed).toEqual(
      extra ? [out.length, privacyLimits.inputUnits, 0, 0] : [out.length, privacyLimits.inputUnits],
    );
    expect(result.capture).toEqual(
      extra
        ? { provenance: { kind: "cut", truncated: true } }
        : { provenance: { kind: "complete" }, stdout: out, stderr: err },
    );
    if (extra) expect(result.stdout).toBe("after-overflow");
  }
});

test.each(["stdout", "stderr", "spawn", "signal", "cancel", "invalid after overflow"])(
  "capture is textless unknown after %s",
  async (failure) => {
    const controller = new AbortController();
    const chunks: Chunk[] = [{ stream: "stdout", text: "partial" }];
    if (failure === "invalid after overflow")
      chunks.push(
        { stream: "stderr", text: "x".repeat(privacyLimits.inputUnits) },
        { stream: "stdout", text: Buffer.from([0xff]) },
      );
    const result = await withChunks(chunks, () => captured({ signal: controller.signal }), {
      signal: failure === "signal" ? "SIGTERM" : undefined,
      beforeEnd: (child) => {
        if (failure === "stdout" || failure === "stderr")
          child[failure]?.emit("error", new Error("unpublished-stream-error"));
        if (failure === "spawn") child.emit("error", new Error("injected spawn failure"));
        if (failure === "cancel") controller.abort();
      },
    });
    expect(result.capture).toEqual({ provenance: { kind: "legacy-unknown" } });
    expect(result).toMatchObject({
      cancelled: failure === "cancel",
      timedOut: false,
      idleTimedOut: false,
      signal: failure === "signal" ? "SIGTERM" : null,
    });
    expect(result.stderr).not.toContain("unpublished-stream-error");
    if (failure === "cancel") expect(result.stdout).toBe("");
    else expect(result.stdout).toStartWith("partial");
  },
);

test("legacy result shape and pre-dispatch encoding refusal", async () => {
  const result = await withChunks([{ stream: "stdout", text: "ok" }], () => runProcess(options()));
  expect(result).toEqual({
    exitCode: 0,
    signal: null,
    cancelled: false,
    cancelKilled: false,
    timedOut: false,
    idleTimedOut: false,
    stdout: "ok",
    stderr: "",
    truncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: expect.any(Number),
  });
  const spawn = spyOn(subprocess, "spawn");
  const dispatchGuard = mock(() => {});
  try {
    await expect(captured({ encoding: "latin1", dispatchGuard })).rejects.toThrow("requires UTF-8");
    await expect(captured({ idleTimeoutMs: 1000, dispatchGuard })).rejects.toThrow(
      "cannot use idleTimeoutMs",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(dispatchGuard).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("bounded framing releases oversized lines on both streams and preserves separate startup lines", async () => {
  const lines: string[] = [];
  const observed: number[] = [];
  const body = "x".repeat(256_000);
  await withChunks(
    (token) => [
      // An oversized line containing the token must not count as a startup handshake.
      { stream: "stdout", text: `${body}${token}\n` },
      { stream: "stdout", text: token?.slice(0, 20) ?? "" },
      { stream: "stdout", text: `${token?.slice(20)}\nshort-out\n${body}` },
      { stream: "stderr", text: `short-error\n${body}` },
      ...Array.from({ length: 16 }, () => [
        { stream: "stdout" as const, text: body },
        { stream: "stderr" as const, text: body },
      ]).flat(),
      { stream: "stdout", text: "\nafter-out\nlast-out" },
      { stream: "stderr", text: "\nafter-error\nlast-error" },
    ],
    () =>
      runSandboxed(
        {
          ...options(),
          maxLineLength: 128,
          tailLimit: 128,
          onRawChunk: () => observed.push(lines.length),
          onStarted: () => lines.push("started"),
          onStdoutLine: (line) => lines.push(line),
          onStderrLine: (line) => lines.push(line),
        },
        { write: [], protect: [] },
        runProcess,
        async () => {},
        fakeConfinement,
      ),
  );
  const truncated = `${"x".repeat(128)} [truncated]`;
  expect(lines).toEqual([
    truncated,
    "started",
    "short-out",
    truncated,
    "short-error",
    truncated,
    "after-out",
    "after-error",
    "last-out",
    "last-error",
  ]);
  // Overflow is released before another chunk arrives, rather than retained until EOF.
  expect(observed[1]).toBe(1);
});

test.each([53, 16])("sandbox startup ignores the caller's %i-character line cap", async (maxLineLength) => {
  const markerLength = "limitless-started-".length + 36;
  for (let offset = 0; offset <= markerLength; offset++) {
    const lines: string[] = [];
    const result = await withChunks(
      (token) => [
        { stream: "stdout", text: token?.slice(0, offset) ?? "" },
        {
          stream: "stdout",
          text: `${token?.slice(offset)}\n${"x".repeat(maxLineLength + 1)}\n${"x".repeat(256)}\nafter-out`,
        },
        { stream: "stderr", text: `${"y".repeat(maxLineLength + 1)}\n${"y".repeat(256)}\nafter-error` },
      ],
      () =>
        runSandboxed(
          {
            ...options(),
            maxLineLength,
            onStarted: () => lines.push("started"),
            onStdoutLine: (line) => lines.push(line),
            onStderrLine: (line) => lines.push(line),
          },
          { write: [], protect: [] },
          runProcess,
          async () => {},
          fakeConfinement,
        ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("limitless-started-");
    expect(lines).toEqual([
      "started",
      `${"x".repeat(maxLineLength)} [truncated]`,
      `${"x".repeat(maxLineLength)} [truncated]`,
      `${"y".repeat(maxLineLength)} [truncated]`,
      `${"y".repeat(maxLineLength)} [truncated]`,
      "after-out",
      "after-error",
    ]);
  }
});

test.each(["missing", "incomplete", "oversized prefix", "oversized suffix"])(
  "sandbox startup fails closed with %s marker",
  async (form) => {
    await expect(
      withChunks(
        (token) => [
          {
            stream: "stdout",
            text:
              form === "missing"
                ? "candidate output\n"
                : form === "incomplete"
                  ? `${token?.slice(0, -1)}\n`
                  : form === "oversized prefix"
                    ? `${"x".repeat(256_000)}${token}\n`
                    : `${token}${"x".repeat(256_000)}\n`,
          },
        ],
        () =>
          runSandboxed(
            { ...options(), maxLineLength: 16 },
            { write: [], protect: [] },
            runProcess,
            async () => {},
            fakeConfinement,
          ),
      ),
    ).rejects.toThrow("payload did not start");
  },
);

test.each(["complete", "missing", "incomplete", "oversized suffix"])(
  "captured startup confirmation survives discarded queues only for a %s token",
  async (form) => {
    const controller = new AbortController();
    const started = mock(() => {});
    const run = () =>
      withChunks(
        (token) => [
          {
            stream: "stdout",
            text:
              form === "complete"
                ? `${token}\n`
                : form === "missing"
                  ? "candidate\n"
                  : form === "incomplete"
                    ? (token?.slice(0, -1) ?? "")
                    : `${token}extra\n`,
          },
        ],
        () =>
          runSandboxed(
            {
              ...options(),
              captureComplete: true,
              redactOutput: true,
              signal: controller.signal,
              onStarted: started,
            },
            { write: [], protect: [] },
            runProcess,
            async () => {},
            fakeConfinement,
          ),
        { beforeEnd: () => controller.abort() },
      );
    if (form === "complete") {
      const result = await run();
      expect(result).toMatchObject({ cancelled: true, stdout: "", cancelKilled: false });
      expect(started).toHaveBeenCalledTimes(1);
    } else {
      await expect(run()).rejects.toThrow("payload did not start");
      expect(started).not.toHaveBeenCalled();
    }
  },
);

test("runner keeps overlapping credentials raw in one chunk and at every split offset", async () => {
  const short = 'synthetic-overlap-"key"-\\prefix';
  const long = `${short}-private-overlap-footer`;
  registerCredential("OVERLAP_SHORT_TEST_TOKEN", short);
  registerCredential("OVERLAP_LONG_TEST_TOKEN", long);
  for (const value of [long, JSON.stringify(long).slice(1, -1)]) {
    for (const stream of ["stdout", "stderr"] as const) {
      // Also split after the full value, so a complete match can cross the carry cut.
      for (let offset = 0; offset < value.length + 20; offset++) {
        const text = `error: ${value}\n(fail) overlap\n${"z".repeat(200)}`;
        const chunks = offset
          ? [
              { stream, text: text.slice(0, 7 + offset) },
              { stream, text: text.slice(7 + offset) },
            ]
          : [{ stream, text }];
        const lines: string[] = [];
        const result = await withChunks(chunks, () =>
          runProcess({
            ...options(),
            redactOutput: true,
            onStdoutLine: (line) => lines.push(line),
            onStderrLine: (line) => lines.push(line),
          }),
        );
        expect(result[stream]).toBe(`error: [redacted]\n(fail) overlap\n${"z".repeat(200)}`);
        expect(lines).toEqual(["error: [redacted]", "(fail) overlap", "z".repeat(200)]);
      }
    }
  }
});

test("runner redacts output that is wholly a short credential at every split", async () => {
  const short = "Sy7x2Q";
  registerCredential("SHORT_WHOLE_TEST_TOKEN", short);
  for (const [text, expected] of [
    [short, "[redacted]"],
    [`\u001b[1m${short}\u001b[0m`, "[redacted]"],
    [`${short} and more`, `${short} and more`],
  ] as const)
    for (const stream of ["stdout", "stderr"] as const)
      for (let offset = 0; offset <= text.length; offset++) {
        const lines: string[] = [];
        const result = await withChunks(
          [
            { stream, text: text.slice(0, offset) },
            { stream, text: text.slice(offset) },
          ],
          () =>
            runProcess({
              ...options(),
              redactOutput: true,
              onStdoutLine: (line) => lines.push(line),
              onStderrLine: (line) => lines.push(line),
            }),
        );
        expect(result[stream]).toBe(expected);
        expect(lines).toEqual([expected]);
      }
});

test("open streams apply new registrations to raw carry and later split output", async () => {
  registerCredential("LATE_CARRY_LENGTH", `synthetic-carry-${"x".repeat(200)}`);
  for (const stream of ["stdout", "stderr"] as const) {
    const secret = `synthetic-late-"key"-\\tail-${stream}`;
    const longer = `${secret}-late-footer`;
    const escaped = JSON.stringify(longer).slice(1, -1);
    const raw: string[] = [];
    const lines: string[] = [];
    let observed = 0;
    const chunks = [
      { stream, text: longer.slice(0, 12) },
      { stream, text: `${longer.slice(12)}\n${escaped.slice(0, 17)}` },
      { stream, text: `${escaped.slice(17)}\nlast` },
    ];
    const result = await withChunks(chunks, () =>
      runProcess({
        ...options(),
        redactOutput: true,
        tailLimit: 20,
        onRawChunk: (text) => {
          raw.push(text);
          // This runs before processing the second observed chunk, after the first is buffered.
          if (++observed === 2) {
            registerCredential("LATE_STREAM_SHORT", secret);
            registerCredential("LATE_STREAM_LONG", longer);
          }
        },
        onStdoutLine: (line) => lines.push(line),
        onStderrLine: (line) => lines.push(line),
      }),
    );
    expect(result[stream]).toBe("ted]\n[redacted]\nlast");
    expect(lines).toEqual(["[redacted]", "[redacted]", "last"]);
    expect(raw.join("")).toBe(`${longer}\n${escaped}\nlast`);
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const sample = `synthetic-late-terminal-${stream}-000-credential`;
    const terminal = (secret: string) =>
      `error: \u001b[${secret.slice(0, 8)}\u001b[31m${secret.slice(8)}\u001b[0m\nlast\n`;
    for (let offset = 0; offset <= terminal(sample).length; offset++) {
      // Registered while the stream is open, before any credential-bearing input arrives.
      const secret = sample.replace("000", String(offset).padStart(3, "0"));
      const text = terminal(secret);
      const lines: string[] = [];
      const result = await withChunks(
        [
          { stream, text: text.slice(0, offset) },
          { stream, text: text.slice(offset) },
        ],
        () =>
          runProcess({
            ...options(),
            redactOutput: true,
            onRawChunk: () => registerCredential(`LATE_TERMINAL_${stream}_${offset}`, secret),
            onStdoutLine: (line) => lines.push(line),
            onStderrLine: (line) => lines.push(line),
          }),
      );
      expect(result[stream]).toBe("error: [redacted]\nlast\n");
      expect(lines).toEqual(["error: [redacted]", "last"]);
    }
  }
});

test("runner strips split terminal sequences before matching and leaves raw observation unchanged", async () => {
  const secret = "synthetic-terminal-chunk-credential";
  registerCredential("TERMINAL_CHUNK_TEST_TOKEN", secret);
  for (const control of ["\u001b[31m", "\u009b38;5;1m", "\u001b]0;title\u0007", "\u001b]0;title\u001b\\"]) {
    for (const stream of ["stdout", "stderr"] as const) {
      for (let offset = 1; offset < control.length; offset++) {
        const raw: string[] = [];
        const lines: string[] = [];
        const prefix = `error: ${secret.slice(0, 12)}`;
        const suffix = `${secret.slice(12)}\u001b[0m\n(fail) terminal\n`;
        const result = await withChunks(
          [
            { stream, text: prefix + control.slice(0, offset) },
            { stream, text: control.slice(offset) + suffix },
          ],
          () =>
            runProcess({
              ...options(),
              redactOutput: true,
              onRawChunk: (chunk) => raw.push(chunk),
              onStdoutLine: (line) => lines.push(line),
              onStderrLine: (line) => lines.push(line),
            }),
        );
        expect(result[stream]).toBe("error: [redacted]\n(fail) terminal\n");
        expect(lines).toEqual(["error: [redacted]", "(fail) terminal"]);
        expect(raw.join("")).toBe(prefix + control + suffix);
      }
    }
  }
  // A stray introducer would consume the first character; the tail cut falls inside the result.
  const stray = "terminal-synthetic-stray-credential";
  // Digits would instead be consumed as the parameters of the stray sequence.
  const digits = "70707070synthetic-stray-digits";
  registerCredential("TERMINAL_STRAY_TEST_TOKEN", stray);
  registerCredential("TERMINAL_STRAY_DIGITS_TEST_TOKEN", digits);
  for (const text of [
    `error: \u001b[${stray.slice(0, 9)}\u001b[31m${stray.slice(9)}\u001b[0m\n(fail) terminal\n`,
    `error: \u009b${digits.slice(0, 4)}\u001b[31m${digits.slice(4, 12)}\u001b[0m${digits.slice(12)}\n(fail) terminal\n`,
  ])
    for (const stream of ["stdout", "stderr"] as const) {
      for (let offset = 0; offset <= text.length; offset++) {
        const raw: string[] = [];
        const lines: string[] = [];
        const result = await withChunks(
          [
            { stream, text: text.slice(0, offset) },
            { stream, text: text.slice(offset) },
          ],
          () =>
            runProcess({
              ...options(),
              redactOutput: true,
              tailLimit: 25,
              onRawChunk: (chunk) => raw.push(chunk),
              onStdoutLine: (line) => lines.push(line),
              onStderrLine: (line) => lines.push(line),
            }),
        );
        expect(lines).toEqual(["error: [redacted]", "(fail) terminal"]);
        expect(result[stream]).toBe("error: [redacted]\n(fail) terminal\n".slice(-25));
        expect(raw.join("")).toBe(text);
      }
    }
});

test("runner strips ANSI before the tail cap around a long credential", async () => {
  const secret = `synthetic-ansi-cap-${"s".repeat(2_000)}-private-ansi-cap-footer`;
  registerCredential("ANSI_CAP_TEST_TOKEN", secret);
  const colored = `${secret.slice(0, 1_800)}\u001b[31m${secret.slice(1_800)}`;
  const text = colored + "\u001b[0m".repeat(16_000);
  for (const stream of ["stdout", "stderr"] as const) {
    const result = await withChunks([{ stream, text }], () =>
      runProcess({ ...options(), redactOutput: true }),
    );
    expect(result[stream]).toBe("[redacted]");
    expect(result.truncated).toBe(false);
  }
});

test("runner does not reprocess redaction markers in its carry", async () => {
  // Isolate the registration of marker text from every other test's credentials.
  const script = `
    import { spyOn } from "bun:test";
    import * as subprocess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { PassThrough } from "node:stream";
    import { registerCredential, runProcess } from ${JSON.stringify(new URL("../src/util/proc.ts", import.meta.url).href)};
    registerCredential("MARKER_TEXT_TEST_TOKEN", "redacted");
    const secret = "synthetic-marker-[redacted]-" + "x".repeat(100);
    registerCredential("MARKER_CREDENTIAL_TEST_TOKEN", secret);
    const fixture = spyOn(subprocess, "spawn").mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
      });
      setImmediate(() => {
        child.stdout.write(secret);
        child.stdout.write(" redacted ");
        for (let i = 0; i < 40; i++) child.stdout.write("q");
        child.stdout.end(); child.stderr.end();
        setImmediate(() => child.emit("close", 0, null));
      });
      return child;
    });
    try {
      const result = await runProcess({ cmd: ["fixture"], cwd: process.cwd(), env: {}, redactOutput: true });
      console.log(JSON.stringify(result.stdout));
    } finally { fixture.mockRestore(); }
  `;
  const result = await runProcess({ ...options(), cmd: [process.execPath, "-e", script] });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toBe(`[redacted] [redacted] ${"q".repeat(40)}`);
});

test("runner redaction handles every two-chunk offset on both streams before framing and cuts", async () => {
  const secret = 'synthetic-offset-"key"-\\slash\n\n(fail) x\nsecret-footer';
  registerCredential("CHUNK_OFFSET_TEST_TOKEN", secret);
  for (const value of [secret, JSON.stringify(secret).slice(1, -1)]) {
    for (const stream of ["stdout", "stderr"] as const) {
      for (let offset = 1; offset < value.length; offset++) {
        const lines: string[] = [];
        const result = await withChunks(
          [
            { stream, text: `error: ${value.slice(0, offset)}` },
            { stream, text: `${value.slice(offset)}\n(fail) assertion\n` },
          ],
          () =>
            runProcess({
              ...options(),
              redactOutput: true,
              tailLimit: 30,
              onStdoutLine: (line) => lines.push(line),
              onStderrLine: (line) => lines.push(line),
            }),
        );
        expect(lines).toEqual(["error: [redacted]", "(fail) assertion"]);
        expect(result[stream]).toBe("error: [redacted]\n(fail) assertion\n".slice(-30));
        expect(result.truncated).toBe(true);
      }
    }
  }
});

test("runner redacts a multiline credential split into UTF-8 bytes and flushes unterminated text", async () => {
  const secret = "synthetic-byte-🔑\n\n(fail) x\nbyte-footer";
  registerCredential("BYTE_CHUNK_TEST_TOKEN", secret);
  const bytes = Buffer.from(`error: ${secret}\n(fail) assertion`);
  const chunks = Array.from(bytes, (_, i) => ({ stream: "stdout" as const, text: bytes.subarray(i, i + 1) }));
  const lines: string[] = [];
  const raw: string[] = [];
  const result = await withChunks(chunks, () =>
    runProcess({
      ...options(),
      redactOutput: true,
      onStdoutLine: (line) => lines.push(line),
      onRawChunk: (chunk) => raw.push(chunk),
    }),
  );
  expect(result.stdout).toBe("error: [redacted]\n(fail) assertion");
  expect(lines).toEqual(["error: [redacted]", "(fail) assertion"]);
  expect(raw.join("")).toBe(`error: ${secret}\n(fail) assertion`);
});

test.each(["literal", "JSON"])(
  "runner redacts a 35,000-character %s credential before the 64k tail cut",
  async (form) => {
    const prefix = "synthetic-runner-huge-";
    const suffix = "-runner-huge-footer";
    const secret = prefix + "\\".repeat(35_000 - prefix.length - suffix.length) + suffix;
    registerCredential("HUGE_RUNNER_TEST_TOKEN", secret);
    const value = form === "JSON" ? JSON.stringify(secret).slice(1, -1) : secret;
    const output = `error: ${value}${"q".repeat(59_000)}`;
    for (const stream of ["stdout", "stderr"] as const) {
      const chunks = Array.from({ length: Math.ceil(output.length / 1024) }, (_, i) => ({
        stream,
        text: output.slice(i * 1024, (i + 1) * 1024),
      }));
      const result = await withChunks(chunks, () => runProcess({ ...options(), redactOutput: true }));
      expect(result[stream]).toBe(`error: [redacted]${"q".repeat(59_000)}`);
      expect(result.truncated).toBe(false);
      const fragments = new Set(Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8)));
      for (const fragment of fragments) expect(result[stream]).not.toContain(fragment);
    }
  },
);

test("raw confinement marker split at every offset remains authoritative before runner redaction", () =>
  withScratch(process.cwd(), async (cwd) => {
    const marker = "sandbox_apply: Operation not permitted";
    const secret = `${marker} synthetic-marker-secret`;
    registerCredential("SPLIT_MARKER_TEST_TOKEN", secret);
    for (const stream of ["stdout", "stderr"] as const) {
      for (let offset = 1; offset < marker.length; offset++) {
        const result = await withChunks(
          [
            { stream, text: secret.slice(0, offset) },
            { stream, text: secret.slice(offset) },
          ],
          () =>
            confinementScope.run(fakeConfinement, () =>
              runGates(
                cwd,
                {
                  setup: [],
                  checks: [{ name: "marker", run: "fixture" }],
                  source: "detected",
                  protectedPaths: [],
                },
                new AbortController().signal,
              ),
            ),
        );
        expect(result.checks[0]).toMatchObject({ output: "[redacted]", confinementError: true, ok: false });
        expect(compareGates(null, result)[0]?.verdict).toBe("confinement_error");
      }
    }
    const interrupted = marker.replace("Operation", "Oper\u001b[0mation");
    const result = await withChunks(
      Array.from(interrupted, (text) => ({ stream: "stdout", text })),
      () =>
        confinementScope.run(fakeConfinement, () =>
          runGates(
            cwd,
            {
              setup: [],
              checks: [{ name: "marker", run: "fixture" }],
              source: "detected",
              protectedPaths: [],
            },
            new AbortController().signal,
          ),
        ),
    );
    expect(result.checks[0]).toMatchObject({ output: marker, confinementError: false, ok: true });
  }));

test("sh forwards opt-in redaction to the runner", async () => {
  const secret = "synthetic-sh-stream-credential";
  registerCredential("SH_STREAM_TEST_TOKEN", secret);
  const result = await withChunks([{ stream: "stdout", text: secret }], () =>
    sh(["fixture"], { cwd: process.cwd(), redactOutput: true }),
  );
  expect(result.stdout).toBe("[redacted]");
});

test("sh redacts command errors before truncation and preserves raw output", async () => {
  const secret = "synthetic-sh-error-boundary-credential";
  registerCredential("SH_ERROR_BOUNDARY_TEST_TOKEN", secret);
  const cmd = [
    process.execPath,
    "-e",
    'process.stdout.write("raw stdout"); process.stderr.write(await Bun.stdin.text()); process.exit(1);',
  ];
  const prefix = `Command failed (1): ${cmd.join(" ")}\n`;
  const stderr = `${"x".repeat(4000 - prefix.length - 12)}${secret}${"z".repeat(100)}`;
  const error: unknown = await sh(cmd, { cwd: process.cwd(), stdin: stderr }).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(CommandError);
  if (!(error instanceof CommandError)) throw error;
  expect(error.message).not.toContain(secret.slice(0, 12));
  expect(error.message).toContain("[redacted]");
  expect(error.message).toHaveLength(4000);
  expect(error.stdout).toBe("raw stdout");
  expect(error.stderr).toBe(stderr);
  expect(error.exitCode).toBe(1);
});

test("runner without redaction retains raw callbacks, empty-line framing, tails and encoding", async () => {
  const secret = "synthetic-plain-stream-credential";
  registerCredential("PLAIN_STREAM_TEST_TOKEN", secret);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const chunks: Chunk[] = [
    { stream: "stdout", text: Buffer.from(`\n${secret.slice(0, 9)}`) },
    { stream: "stderr", text: Buffer.from(`\n${secret}\nlast-error`) },
    { stream: "stdout", text: Buffer.from(`${secret.slice(9)}\n\n\u001b[`) },
    { stream: "stdout", text: Buffer.from("31mfinal\u001b[0m") },
  ];
  const result = await withChunks(chunks, () =>
    runProcess({
      ...options(),
      tailLimit: 12,
      onStdoutLine: (line) => stdoutLines.push(line),
      onStderrLine: (line) => stderrLines.push(line),
    }),
  );
  expect(stdoutLines).toEqual([secret, "\u001b[31mfinal\u001b[0m"]);
  expect(stderrLines).toEqual([secret, "last-error"]);
  expect(result.stdout).toBe(`${secret}\n\n\u001b[31mfinal\u001b[0m`.slice(-12));
  expect(result.stderr).toBe(`${secret}\nlast-error`.slice(-12));
  expect(result).toMatchObject({
    exitCode: 0,
    truncated: true,
    stdoutTruncated: true,
    stderrTruncated: true,
  });
  const encoded = await withChunks([{ stream: "stdout", text: Buffer.from([0xff]) }], () =>
    runProcess({ ...options(), encoding: "latin1" }),
  );
  expect(encoded.stdout).toBe("ÿ");
});

test.each([
  ["OSC", "\u001b]"],
  ["DCS", "\u001bP"],
  ["C1 OSC", "\u009d"],
])("runner releases an unterminated %s string instead of holding the stream", async (_kind, introducer) => {
  const secret = "synthetic-released-string-credential";
  registerCredential("RELEASED_STRING_TEST_TOKEN", secret);
  const lines: string[] = [];
  const seenAtChunk: number[] = [];
  // Larger than any credential carry, which other tests' registrations can make long.
  const body = "x".repeat(200_000);
  await withChunks(
    [
      { stream: "stdout", text: `${introducer}${body}\n${body}\n` },
      { stream: "stdout", text: `after ${secret}\n` },
    ],
    () =>
      runProcess({
        ...options(),
        redactOutput: true,
        onRawChunk: () => seenAtChunk.push(lines.length),
        onStdoutLine: (line) => lines.push(line),
      }),
  );
  // Past the hold limit, the stray sequence's text is released while the stream is still running.
  expect(seenAtChunk[1]).toBeGreaterThanOrEqual(1);
  expect(lines[0]).toBe(`${introducer.slice(1)}${body}`);
  expect(lines.at(-1)).toBe("after [redacted]");
});

const RECOVERY_SECRET = "synthetic-terminal-recovery-credential";
const [HELD, LINES] = ["t".repeat(4_200), "line\n".repeat(840)];
// A line break, another escape, the hold and EOF each end a string as visible text.
test.each([
  [
    "a line break",
    `BEFORE \u001b]0;title\nerror: ${RECOVERY_SECRET}\nAFTER\n`,
    "BEFORE ]0;title\nerror: [redacted]\nAFTER\n",
  ],
  [
    "an escape",
    `BEFORE \u001bPq data\u001b[31m ${RECOVERY_SECRET}\u001b[0m\nAFTER\n`,
    "BEFORE Pq data [redacted]\nAFTER\n",
  ],
  [
    "the hold",
    `BEFORE \u001b]0;${HELD} ${RECOVERY_SECRET}\nAFTER\n`,
    `BEFORE ]0;${HELD} [redacted]\nAFTER\n`,
  ],
  [
    "a multiline string over the hold and a BEL",
    `BEFORE \u001b]0;${LINES}\u0007${RECOVERY_SECRET}\nAFTER\n`,
    `BEFORE ]0;${LINES}[redacted]\nAFTER\n`,
  ],
  ["EOF", `BEFORE \u001b]0;title ${RECOVERY_SECRET}`, "BEFORE ]0;title [redacted]"],
])(
  "a terminal string ended by %s releases visible text and later credentials at every split",
  async (_end, text, expected) => {
    registerCredential("TERMINAL_RECOVERY_TEST_TOKEN", RECOVERY_SECRET);
    for (const stream of ["stdout", "stderr"] as const) {
      for (let offset = 0; offset <= text.length; offset++) {
        const result = await withChunks(
          [
            { stream, text: text.slice(0, offset) },
            { stream, text: text.slice(offset) },
          ],
          () => runProcess({ ...options(), redactOutput: true }),
        );
        expect(result[stream]).toBe(expected);
      }
    }
  },
  // Every split of a string longer than the hold, on both streams, runs the runner about 8,500 times.
  20_000,
);

test("cleanup records ownership before the first signal and deletes it after confirmation", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "limitless-record-")));
  const store = new Store(":memory:");
  const signal = process.kill.bind(process);
  let marker = "";
  let member = 0;
  let signalled = false;
  const kill = spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (sig === "SIGSTOP" || sig === "SIGKILL") {
      const row = store.listProcessCleanups().find((row) => row.pid === pid);
      expect(row).toMatchObject({ runId: "recorded", invocation: marker, directory, pid, boot: "test-boot" });
      expect(row?.birth).toBeTruthy();
      expect(row?.createdAt).toBeGreaterThan(0);
      signalled = true;
    }
    return signal(pid, sig);
  });
  try {
    await processBootInspection.run(
      () => "test-boot",
      () =>
        processScope.run(
          {
            signal: new AbortController().signal,
            killGraceMs: 0,
            children: new Map(),
            scratchDirs: new Set(),
            runId: "recorded",
            cleanups: store,
          },
          async () => {
            const result = await runProcess({
              cmd: [
                process.execPath,
                "-e",
                `
          const child = require('node:child_process').spawn(process.execPath,
            ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {detached: true, stdio: ['ignore','pipe','ignore']});
          child.stdout.once('data', () => { console.log(JSON.stringify({pid:child.pid, marker:process.env.LIMITLESS_INVOCATION})); process.exit(0); });
        `,
              ],
              cwd: directory,
              env: {},
              onStdoutLine: (line) => {
                const data = JSON.parse(line) as { pid: number; marker: string };
                member = data.pid;
                marker = data.marker;
              },
            });
            expect(result.exitCode).toBe(0);
            expect(signalled).toBe(true);
            expectProcessStopped(member);
            expect(store.listProcessCleanups()).toEqual([]);
          },
        ),
    );
  } finally {
    kill.mockRestore();
    if (member > 0 && !recoveryProcessStopped(member)) {
      try {
        signal(member, "SIGKILL");
      } catch {}
    }
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ["discovery", "birth", "recording", "boot"] as const) {
  test(`a cleanup ${failure} failure still kills the live direct child and preserves the reason`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "limitless-child-kill-"));
    const store = new Store(":memory:");
    const controller = new AbortController();
    const scope = {
      signal: controller.signal,
      killGraceMs: 0,
      children: new Map<subprocess.ChildProcess, Promise<void>>(),
      scratchDirs: new Set<string>(),
      cleanups: store,
    };
    const fail = () => {
      throw new Error(`injected ${failure} failure`);
    };
    const recorder =
      failure === "recording" ? spyOn(store, "recordProcessCleanup").mockImplementation(fail) : undefined;
    let member = 0;
    let cleaning = false;
    try {
      const invoke = () =>
        processBootInspection.run(
          () => (failure === "boot" && cleaning ? fail() : "test-boot"),
          () =>
            processScope.run(scope, () =>
              runProcess({
                cmd: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
                cwd: directory,
                env: {},
                onStdoutLine: (line) => {
                  member = Number(line);
                  cleaning = true;
                  controller.abort();
                },
              }),
            ),
        );
      const pending =
        failure === "discovery"
          ? processInspection.run(fail, invoke)
          : failure === "birth"
            ? processBirthInspection.run({ read: fail }, invoke)
            : invoke();
      // Spawn-time evidence can fail before the child gets to print its PID.
      const child = scope.children.keys().next().value;
      if (child?.pid === undefined) throw new Error("Missing spawned child");
      member = child.pid;
      await expect(pending).rejects.toThrow(`injected ${failure} failure`);
      await expect(pending).rejects.toBeInstanceOf(ProcessTerminationError);
      const deadline = performance.now() + 5000;
      while (!recoveryProcessStopped(member) && performance.now() < deadline) await Bun.sleep(10);
      expectProcessStopped(member);
    } finally {
      recorder?.mockRestore();
      for (const child of scope.children.keys()) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const [idle, code] of [
  [false, 0],
  [false, 7],
  [true, 0],
  [true, 7],
] as const) {
  test(`an exited child keeps status ${code} when the ${idle ? "idle" : "overall"} timer runs before its exit handler`, async () => {
    const spawn = subprocess.spawn;
    const setTimer = idle ? globalThis.setInterval : globalThis.setTimeout;
    const children: subprocess.ChildProcess[] = [];
    let fire: () => void = () => {
      throw new Error("timer was not installed");
    };
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timer = spyOn(globalThis, idle ? "setInterval" : "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      fire = () => {
        now += 200_000;
        if (typeof fn === "function") fn(...args);
      };
      return setTimer(fn, ms, ...args);
    }) as typeof setTimeout);
    const spawning = spyOn(subprocess, "spawn").mockImplementation(((
      ...args: Parameters<typeof subprocess.spawn>
    ) => {
      const child = spawn(...args);
      children.push(child);
      const emit = child.emit.bind(child);
      child.emit = (event: string | symbol, ...values: unknown[]) => {
        if (event === "exit") {
          // Hide the runtime's status until its exit handler runs, as during an event-loop stall.
          const code = child.exitCode;
          Object.defineProperty(child, "exitCode", { value: null });
          try {
            fire();
          } finally {
            Object.defineProperty(child, "exitCode", { value: code });
          }
        }
        return emit(event, ...values);
      };
      return child;
    }) as typeof subprocess.spawn);
    try {
      const cmd = [process.execPath, "-e", `process.exit(${code})`];
      const timeout = idle ? { idleTimeoutMs: 100_000 } : { timeoutMs: 100_000 };
      const result = await captured({ cmd, ...timeout, captureComplete: !idle });
      expect(result).toMatchObject({ exitCode: code, signal: null, timedOut: false, idleTimedOut: false });
      expect(result.capture).toEqual(
        idle ? undefined : { provenance: { kind: "complete" }, stdout: "", stderr: "" },
      );
      if (!idle && code === 0) {
        await expect(sh(cmd, { cwd: process.cwd(), ...timeout })).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false,
        });
        await expect(sh(cmd, { cwd: process.cwd(), ...timeout, allowFail: true })).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false,
        });
      }
    } finally {
      spawning.mockRestore();
      timer.mockRestore();
      clock.mockRestore();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  });
}

test("a live direct child is still killed and reported as timed out", async () => {
  const result = await runProcess({
    cmd: ["/bin/sleep", "30"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 25,
    captureComplete: true,
  });
  expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: "SIGKILL" });
  expect(result.capture).toEqual({ provenance: { kind: "legacy-unknown" } });
}, 15_000);

for (const [idle, code] of [
  [false, 0],
  [false, 7],
  [true, 0],
  [true, 7],
] as const) {
  test(`a child exiting ${code} during cleanup retains its ${idle ? "idle" : "overall"} timeout`, async () => {
    const spawn = subprocess.spawn;
    const setTimer = idle ? globalThis.setInterval : globalThis.setTimeout;
    const children: subprocess.ChildProcess[] = [];
    let fire = () => {};
    let releaseInput = () => {};
    let exited = Promise.resolve();
    let now = 0;
    const timer = spyOn(globalThis, idle ? "setInterval" : "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      fire = () => {
        now = 200_000;
        fn(...args);
      };
      return setTimer(fn, ms, ...args);
    }) as typeof setTimeout);
    const spawning = spyOn(subprocess, "spawn").mockImplementation(((
      ...args: Parameters<typeof subprocess.spawn>
    ) => {
      const child = spawn(...args);
      children.push(child);
      const input = child.stdin;
      if (!input) throw new Error("missing stdin");
      const end = input.end.bind(input);
      input.end = (() => input) as typeof input.end;
      releaseInput = () => {
        end();
      };
      exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdout?.once("data", () => fire());
      return child;
    }) as typeof subprocess.spawn);
    const inspect = async (_environment: boolean, marker: string) => {
      // The timer has observed a live child. Let it exit before cleanup's first snapshot finishes.
      releaseInput();
      await exited;
      return `${process.pid} ${process.getuid?.()} S scanner LIMITLESS_PROCESS_SCAN=${marker}`;
    };
    try {
      const cmd = [
        process.execPath,
        "-e",
        `process.stdin.resume(); process.stdin.on("end", () => process.exit(${code})); console.error("diagnostic"); console.log("ready")`,
      ];
      const timeout = idle ? { idleTimeoutMs: 100_000, idleNow: () => now } : { timeoutMs: 100_000 };
      const opts = { cwd: process.cwd(), ...timeout };
      const result = await processInspection.run(inspect, () =>
        captured({ cmd, ...opts, captureComplete: !idle }),
      );
      expect(result).toMatchObject({ exitCode: code, signal: null, timedOut: !idle, idleTimedOut: idle });
      expect(result.capture).toEqual(idle ? undefined : { provenance: { kind: "legacy-unknown" } });
      if (!idle && code === 0) {
        await expect(
          processInspection.run(inspect, () => sh(cmd, { ...opts, allowFail: true })),
        ).resolves.toMatchObject({
          timedOut: true,
          exitCode: 0,
          stdout: "ready\n",
          stderr: "diagnostic\n",
        });
        for (const timeoutMs of [100_000, undefined]) {
          const error: unknown = await processInspection
            .run(inspect, () => sh(cmd, { cwd: process.cwd(), timeoutMs }))
            .catch((e: unknown) => e);
          expect(error).toBeInstanceOf(CommandError);
          if (!(error instanceof CommandError)) throw error;
          expect(error.message).toContain(`timed out after ${(timeoutMs ?? 120_000) / 1000} s`);
          expect(error.message).toContain(cmd.join(" "));
          expect(error.message).toContain("diagnostic");
          expect(error).toMatchObject({
            timedOut: true,
            exitCode: 0,
            stdout: "ready\n",
            stderr: "diagnostic\n",
          });
        }
      }
    } finally {
      spawning.mockRestore();
      timer.mockRestore();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  });
}
