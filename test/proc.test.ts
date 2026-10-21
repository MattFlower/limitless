import { expect, spyOn } from "bun:test";
import * as subprocess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Store } from "../src/db/store.ts";
import { compareGates, runGates } from "../src/gates/run.ts";
import { confinementScope, runSandboxed } from "../src/harness/sandbox.ts";
import { withScratch } from "../src/harness/scratch.ts";
import {
  CommandError,
  ProcessTerminationError,
  type ProcOptions,
  processBirthInspection,
  processBootInspection,
  processInspection,
  processScope,
  recoveryProcessStopped,
  registerCredential,
  runProcess,
  sh,
} from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { expectProcessStopped } from "./process-support.ts";
import { test } from "./read-policy-support.ts";

type Chunk = { stream: "stdout" | "stderr"; text: string | Buffer };

/** Control pipe chunk boundaries without subprocess scheduling or timing margins. */
async function withChunks<T>(
  chunks: Chunk[] | ((token: string | undefined) => Chunk[]),
  run: () => Promise<T>,
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
    setImmediate(() => {
      // The real sandbox wrapper prints this trusted startup token before its payload.
      const token = args?.[3];
      if (Array.isArray(chunks) && typeof token === "string" && token.startsWith("limitless-started-"))
        stdout.write(`${token}\n`);
      for (const chunk of typeof chunks === "function" ? chunks(token) : chunks)
        ({ stdout, stderr })[chunk.stream].write(chunk.text);
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", 0, null));
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
  // One redactCredentials call also matches the marker text it inserts, once.
  expect(JSON.parse(result.stdout)).toBe(`[[redacted]] [redacted] ${"q".repeat(40)}`);
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

test("runner releases an unterminated terminal sequence instead of holding the stream", async () => {
  const lines: string[] = [];
  const seenAtChunk: number[] = [];
  // Larger than any credential carry, which other tests' registrations can make long.
  const body = "x".repeat(200_000);
  await withChunks(
    [
      { stream: "stdout", text: `\u001b]${body}\n${body}\n` },
      { stream: "stdout", text: "after\n" },
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
  expect(lines.at(-1)).toBe("after");
});

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
    try {
      const invoke = () =>
        processBootInspection.run(failure === "boot" ? fail : () => "test-boot", () =>
          processScope.run(scope, () =>
            runProcess({
              cmd: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
              cwd: directory,
              env: {},
              onStdoutLine: (line) => {
                member = Number(line);
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
      await expect(pending).rejects.toThrow(`injected ${failure} failure`);
      await expect(pending).rejects.toBeInstanceOf(ProcessTerminationError);
      const deadline = performance.now() + 5000;
      while (!recoveryProcessStopped(member) && performance.now() < deadline) await Bun.sleep(10);
      expectProcessStopped(member);
    } finally {
      recorder?.mockRestore();
      for (const child of scope.children.keys()) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
      const result = await runProcess({ cmd, cwd: process.cwd(), env: {}, ...timeout });
      expect(result).toMatchObject({ exitCode: code, signal: null, timedOut: false, idleTimedOut: false });
      if (!idle && code === 0)
        await expect(sh(cmd, { cwd: process.cwd(), ...timeout })).resolves.toMatchObject({ exitCode: 0 });
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
  });
  expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: "SIGKILL" });
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
        `process.stdin.resume(); process.stdin.on("end", () => process.exit(${code})); console.log("ready")`,
      ];
      const timeout = idle ? { idleTimeoutMs: 100_000, idleNow: () => now } : { timeoutMs: 100_000 };
      const opts = { cwd: process.cwd(), ...timeout };
      const result = await processInspection.run(inspect, () => runProcess({ cmd, env: {}, ...opts }));
      expect(result).toMatchObject({ exitCode: code, signal: null, timedOut: !idle, idleTimedOut: idle });
      if (!idle && code === 0) {
        await expect(processInspection.run(inspect, () => sh(cmd, opts))).rejects.toMatchObject({
          timedOut: true,
          exitCode: 0,
        });
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
