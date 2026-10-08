import { expect, spyOn, test } from "bun:test";
import * as subprocess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { compareGates, runGates } from "../src/gates/run.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { type ProcOptions, registerCredential, runProcess, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";

type Chunk = { stream: "stdout" | "stderr"; text: string | Buffer };

/** Control pipe chunk boundaries without subprocess scheduling or timing margins. */
async function withChunks<T>(chunks: Chunk[], run: () => Promise<T>): Promise<T> {
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
      if (typeof token === "string" && token.startsWith("limitless-started-")) stdout.write(`${token}\n`);
      for (const chunk of chunks) ({ stdout, stderr })[chunk.stream].write(chunk.text);
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

test("raw confinement marker split at every offset remains authoritative before runner redaction", async () => {
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
              process.cwd(),
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
          process.cwd(),
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
});

test("sh forwards opt-in redaction to the runner", async () => {
  const secret = "synthetic-sh-stream-credential";
  registerCredential("SH_STREAM_TEST_TOKEN", secret);
  const result = await withChunks([{ stream: "stdout", text: secret }], () =>
    sh(["fixture"], { cwd: process.cwd(), redactOutput: true }),
  );
  expect(result.stdout).toBe("[redacted]");
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
  const body = "x".repeat(5_000);
  await withChunks(
    [
      { stream: "stdout", text: `before\n\u001b]${body}\n` },
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
  expect(seenAtChunk[1]).toBe(2);
  expect(lines.at(-1)).toBe("after");
});
