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
    { stream: "stdout", text: Buffer.from(`${secret.slice(9)}\n\nfinal`) },
  ];
  const result = await withChunks(chunks, () =>
    runProcess({
      ...options(),
      tailLimit: 12,
      onStdoutLine: (line) => stdoutLines.push(line),
      onStderrLine: (line) => stderrLines.push(line),
    }),
  );
  expect(stdoutLines).toEqual([secret, "final"]);
  expect(stderrLines).toEqual([secret, "last-error"]);
  expect(result.stdout).toBe(`${secret}\n\nfinal`.slice(-12));
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
