import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { cacheGit } from "../src/git/command.ts";
import type { GitOptions } from "../src/git/confinement.ts";
import type {
  ObjectFormat,
  PrivateObjectReader,
  RunObjectBundle,
} from "../src/pipeline/run-object-contract.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import { createRunObjectValidator } from "../src/pipeline/run-object-quarantine.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import { runProcess, sh } from "../src/util/proc.ts";

let root: string;
const signal = () => new AbortController().signal;
const ref = (oid: string) => `refs/limitless-run-objects/run-1/${oid}`;
const content = Buffer.from([0, 255, 128, 10, 97]);
const hashObject = (format: ObjectFormat, type: string, bytes: Uint8Array) =>
  createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const git = async (cwd: string, args: string[], stdin?: string) =>
  (await sh(["git", ...args], { cwd, stdin, encoding: "latin1" })).stdout.trim();
const samples = new Map<
  ObjectFormat,
  { input: RunObjectBundle; prerequisite: RunObjectBundle; tree: string; blob: string }
>();
const clone = (input: RunObjectBundle): RunObjectBundle => ({
  ...input,
  bytes: input.bytes.slice(),
  refs: input.refs.map((r) => ({ ...r })),
  requiredCommits: [...input.requiredCommits],
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "quarantine-tests-"));
  for (const format of ["sha1", "sha256"] as const) {
    const source = join(root, format);
    await mkdir(source);
    await git(source, ["init", `--object-format=${format}`, "--template="]);
    await writeFile(join(source, "payload"), content);
    await writeFile(join(source, ".gitattributes"), "payload filter=evil\n");
    await git(source, ["add", "payload", ".gitattributes"]);
    await git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "unpublished",
    ]);
    const parent = await git(source, ["rev-parse", "HEAD"]);
    await git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "child",
    ]);
    const oid = await git(source, ["rev-parse", "HEAD"]),
      tree = await git(source, ["rev-parse", "HEAD^{tree}"]);
    const exported = await createRunObjectExporter({ scratchRoot: root })(
      {
        repository: { path: source, lockPath: source, trust: "factory-owned" },
        runScope: "run-1",
        commits: [oid, parent],
        objectFormat: format,
      },
      signal(),
    );
    if (!exported) throw new Error("expected export");
    await git(source, ["update-ref", ref(oid), oid]);
    const incremental = join(root, `incremental-${format}.bundle`);
    await git(source, ["bundle", "create", "--version=3", incremental, ref(oid), `^${parent}`]);
    samples.set(format, {
      input: exported,
      prerequisite: {
        ...exported,
        bytes: await readFile(incremental),
        refs: [{ name: ref(oid), oid }],
        requiredCommits: [oid],
      },
      tree,
      blob: hashObject(format, "blob", content),
    });
    await rm(source, { recursive: true });
  }
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
function sample(format: ObjectFormat = "sha1") {
  const value = samples.get(format);
  if (!value) throw new Error("missing fixture");
  return { ...value, input: clone(value.input) };
}
async function sandbox() {
  const path = await mkdtemp(join(root, "operation-"));
  await writeFile(join(path, "neighbor"), "keep");
  return path;
}
async function clean(path: string) {
  expect(await readdir(path)).toEqual(["neighbor"]);
}
function withPack(input: RunObjectBundle, pack: Buffer) {
  const bytes = Buffer.from(input.bytes),
    boundary = bytes.indexOf("\n\n") + 2;
  return { ...input, bytes: Buffer.concat([bytes.subarray(0, boundary), pack]) };
}
function packFor(format: ObjectFormat, objects: { type: number; bytes: Buffer }[]) {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const entries = objects.map(({ type, bytes }) => {
    let size = bytes.length,
      first = (type << 4) | (size & 15);
    size >>>= 4;
    const prefix = [first | (size ? 128 : 0)];
    while (size) {
      first = size & 127;
      size >>>= 7;
      prefix.push(first | (size ? 128 : 0));
    }
    return Buffer.concat([Buffer.from(prefix), deflateSync(bytes)]);
  });
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash(format).update(body).digest()]);
}

function fakeInput(): RunObjectBundle {
  const oid = "a".repeat(40);
  return {
    objectFormat: "sha1",
    requiredCommits: [oid],
    refs: [{ name: ref(oid), oid }],
    bytes: Buffer.concat([
      Buffer.from(`# v3 git bundle\n@object-format=sha1\n${oid} ${ref(oid)}\n\n`),
      packFor("sha1", [{ type: 1, bytes: Buffer.from("x") }]),
    ]),
  };
}
async function fake(fault = "", abort = false, bodies = [["x"]], size = "1", faultRead = 1) {
  const path = await sandbox(),
    calls: { cmd: string[]; options: GitOptions }[] = [],
    bodyCalls: string[][] = [];
  const controller = new AbortController();
  const input = fakeInput();
  const runner = async (cmd: string[], options: GitOptions) => {
    calls.push({ cmd, options });
    const command = cmd.find((arg) =>
      ["init", "bundle", "index-pack", "fetch", "cat-file", "rev-list"].includes(arg),
    );
    const event =
      command === "cat-file"
        ? cmd.includes("-t")
          ? "type"
          : cmd.includes("--batch-all-objects")
            ? "inventory"
            : "read"
        : command;
    if (event === fault) {
      if (abort) controller.abort();
      throw new Error("private Git diagnostic");
    }
    if (command === "init") {
      await mkdir(join(cmd.at(-1) ?? "", "objects", "pack"), { recursive: true });
    }
    const oid = input.requiredCommits[0] ?? "";
    return {
      stdout:
        command === "index-pack"
          ? Buffer.from(input.bytes).subarray(-20).toString("hex")
          : event === "type"
            ? fault === "noncommit"
              ? "blob"
              : "commit"
            : event === "inventory"
              ? fault === "bad-inventory"
                ? "garbage"
                : `${oid} commit ${fault === "size" ? 2 : size}\n${fault === "late-inventory" ? "garbage\n" : ""}`
              : event === "read"
                ? "x"
                : "",
    };
  };
  const validate = createRunObjectValidator({
    scratchRoot: path,
    cacheGit: runner,
    runProcess: async (options) => {
      const chunks = bodies[Math.min(bodyCalls.length, bodies.length - 1)] ?? [];
      bodyCalls.push(options.cmd);
      await runner(options.cmd, options);
      options.onRawChunk?.("ignored diagnostic", "stderr");
      for (const chunk of chunks) options.onRawChunk?.(chunk, "stdout");
      const streamFault = bodyCalls.length === faultRead ? fault : "";
      if (abort && streamFault.startsWith("stream-")) controller.abort();
      return {
        stdout: "",
        stderr: "",
        exitCode: streamFault === "stream-exit" ? 1 : 0,
        signal: null,
        cancelled: streamFault === "stream-cancelled",
        timedOut: streamFault === "stream-timeout",
        idleTimedOut: streamFault === "stream-idle",
        truncated: false,
        durationMs: 0,
      };
    },
  });
  return { path, calls, bodyCalls, input, controller, validate };
}

describe("orchestration", () => {
  test.each(["omitted", "late-inventory", "unsafe-size"])(
    "rejects %s inventory before reading any bodies",
    async (fault) => {
      const f = await fake(fault, false, [["x"]], fault === "unsafe-size" ? "9007199254740993" : "1");
      if (fault === "omitted") {
        const bytes = Buffer.from(f.input.bytes);
        bytes.writeUInt32BE(2, bytes.indexOf("\n\n") + 10);
        f.input.bytes = bytes;
      }
      let inspections = 0;
      await expect(
        f.validate(
          f.input,
          async () => {
            inspections++;
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: fault === "unsafe-size" ? "unsupported" : "invalid" });
      expect(f.bodyCalls).toHaveLength(0);
      expect(inspections).toBe(0);
      await clean(f.path);
    },
  );
  test.each([
    ["eager", "short"],
    ["eager", "long"],
    ["inspection", "short"],
    ["inspection", "long"],
  ])("rejects %s %s streamed bodies as corrupt", async (phase, fault) => {
    const exact = [content.subarray(0, 2).toString("latin1"), content.subarray(2).toString("latin1")];
    const wrong = fault === "short" ? [exact[0] ?? ""] : [...exact, Buffer.from([255]).toString("latin1")];
    const f = await fake("", false, phase === "eager" ? [wrong] : [exact, wrong], `${content.length}`);
    let inspections = 0;
    await expect(
      f.validate(
        f.input,
        async (reader) => {
          inspections++;
          await reader.read(f.input.requiredCommits[0] ?? "");
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(inspections).toBe(phase === "eager" ? 0 : 1);
    expect(f.bodyCalls).toHaveLength(phase === "eager" ? 1 : 2);
    await clean(f.path);
  });
  test.each(["binary", "empty"])("accepts exact-size %s streams in both phases", async (kind) => {
    const bytes = kind === "empty" ? Buffer.alloc(0) : content;
    const chunks = [...bytes].map((byte) => Buffer.from([byte]).toString("latin1"));
    const f = await fake("", false, [chunks], `${bytes.length}`);
    await f.validate(
      f.input,
      async (reader) => {
        expect(await reader.read(f.input.requiredCommits[0] ?? "")).toEqual(bytes);
      },
      signal(),
    );
    expect(f.bodyCalls).toHaveLength(2);
    await clean(f.path);
  });
  test.each(["stream-exit", "stream-cancelled", "stream-timeout", "stream-idle"])(
    "preserves inspection read failure and cancellation at %s",
    async (fault) => {
      for (const abort of [false, true]) {
        const f = await fake(fault, abort, [["x"]], "1", 2);
        let inspections = 0;
        await expect(
          f.validate(
            f.input,
            async (reader) => {
              inspections++;
              await reader.read(f.input.requiredCommits[0] ?? "");
            },
            f.controller.signal,
          ),
        ).rejects.toMatchObject({ code: abort ? "aborted" : "corrupt" });
        expect(inspections).toBe(1);
        expect(f.bodyCalls).toHaveLength(2);
        await clean(f.path);
      }
    },
  );
  test.each([
    "init",
    "bundle",
    "index-pack",
    "fetch",
    "type",
    "rev-list",
    "inventory",
    "read",
    "stream-exit",
    "stream-cancelled",
    "stream-timeout",
    "stream-idle",
    "noncommit",
    "bad-inventory",
    "size",
  ])("fails closed and cleans up at %s", async (fault) => {
    for (const abort of [false, true]) {
      const f = await fake(fault, abort);
      let inspected = false;
      const error = await f
        .validate(
          f.input,
          async () => {
            inspected = true;
          },
          f.controller.signal,
        )
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RunTransferError);
      expect(String(error)).not.toContain("private Git diagnostic");
      expect(inspected).toBe(false);
      await clean(f.path);
    }
  });
  test.each([
    "unexpected",
    "missing",
    "wrong-target",
    "format",
    "duplicate",
    "prerequisite",
    "capability",
    "version",
    "zero",
    "scope",
    "empty",
    "malformed",
  ])("rejects %s before import", async (fault) => {
    const f = await fake();
    let text = Buffer.from(f.input.bytes).toString("latin1");
    if (fault === "unexpected") text = text.replace("\n\n", `\n${"b".repeat(40)} refs/heads/hostile\n\n`);
    if (fault === "missing") text = text.replace(/^a+ refs\/[^\n]+\n/m, "");
    if (fault === "wrong-target") text = text.replace(/^a+ /m, `${"b".repeat(40)} `);
    if (fault === "duplicate")
      text = text.replace("\n\n", `\n${f.input.refs[0]?.oid} ${f.input.refs[0]?.name}\n\n`);
    if (fault === "prerequisite") text = text.replace("\n\n", `\n-${"b".repeat(40)} prerequisite\n\n`);
    if (fault === "capability") text = text.replace("@object-format=sha1", "@filter=blob:none");
    if (fault === "version") text = text.replace("# v3", "# v9");
    if (fault === "format") f.input.objectFormat = "sha256";
    if (fault === "zero") f.input.requiredCommits = ["0".repeat(40)];
    if (fault === "scope") f.input.refs = [{ name: "refs/heads/main", oid: "a".repeat(40) }];
    if (fault === "empty") f.input.requiredCommits = [];
    if (fault === "malformed") f.input.refs = [];
    f.input.bytes = Buffer.from(text, "latin1");
    await expect(
      f.validate(
        f.input,
        async () => {
          throw new Error("inspection reached");
        },
        signal(),
      ),
    ).rejects.toBeInstanceOf(RunTransferError);
    expect(f.calls).toHaveLength(0);
    await clean(f.path);
  });
  test("pre-abort and allocation failure do not inspect; abort after allocation still cleans up", async () => {
    const path = await sandbox(),
      controller = new AbortController();
    let allocations = 0,
      inspections = 0;
    const validate = createRunObjectValidator({
      scratchRoot: path,
      makeScratch: async (prefix) => {
        allocations++;
        const dir = await mkdtemp(prefix);
        controller.abort();
        return dir;
      },
    });
    await expect(
      validate(
        fakeInput(),
        async () => {
          inspections++;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(allocations).toBe(1);
    await clean(path);
    await expect(
      validate(
        fakeInput(),
        async () => {
          inspections++;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(allocations).toBe(1);
    await expect(
      createRunObjectValidator({
        scratchRoot: path,
        makeScratch: async () => {
          throw new Error("private allocation error");
        },
      })(
        fakeInput(),
        async () => {
          inspections++;
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(inspections).toBe(0);
    await clean(path);
  });
  test("uses explicit mappings, rejects revision expressions and cleanup failure", async () => {
    const f = await fake();
    await f.validate(
      f.input,
      async (reader) => {
        await expect(reader.type("HEAD")).rejects.toMatchObject({ code: "invalid" });
        await expect(reader.read(`${f.input.requiredCommits[0]}:path`)).rejects.toMatchObject({
          code: "invalid",
        });
      },
      signal(),
    );
    const fetch = f.calls.find((c) => c.cmd.includes("fetch"));
    expect(fetch?.cmd.slice(-1)).toEqual([`${ref("a".repeat(40))}:${ref("a".repeat(40))}`]);
    expect(fetch?.cmd).toEqual(
      expect.arrayContaining([
        "--no-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
      ]),
    );
    await clean(f.path);
    const broken = createRunObjectValidator({
      scratchRoot: f.path,
      cacheGit: async () => {
        throw new Error("verify failure");
      },
      removeScratch: async (dir) => {
        await rm(dir, { recursive: true });
        throw new Error("private cleanup error");
      },
    });
    await expect(broken(f.input, async () => {}, signal())).rejects.toMatchObject({ code: "unavailable" });
    await clean(f.path);
  });
});

describe("offline proof", () => {
  test.each(["object", "aggregate"])(
    "rejects the expanded %s limit before any body read or inspection",
    async (limit) => {
      const { input } = sample(),
        path = await sandbox();
      const original = Buffer.from(input.bytes),
        pack = original.subarray(original.indexOf("\n\n") + 2, -20),
        entries = [pack];
      // Reuse one expanded buffer; only the small compressed entries accumulate.
      const bytes = Buffer.alloc(limit === "object" ? 104_857_601 : 104_857_600, 97),
        count = limit === "object" ? 1 : 21;
      for (let index = 0; index < count; index++) {
        bytes.writeUInt32BE(index);
        entries.push(packFor("sha1", [{ type: 3, bytes }]).subarray(12, -20));
      }
      const body = Buffer.concat(entries);
      body.writeUInt32BE(pack.readUInt32BE(8) + count, 8);
      const oversized = withPack(input, Buffer.concat([body, createHash("sha1").update(body).digest()]));
      const metadataCalls: string[][] = [],
        bodyCalls: string[][] = [];
      let inspections = 0;
      await expect(
        createRunObjectValidator({
          scratchRoot: path,
          cacheGit: async (cmd, options) => {
            metadataCalls.push(cmd);
            return cacheGit(cmd, options);
          },
          runProcess: async (options) => {
            bodyCalls.push(options.cmd);
            // A regression must fail without expanding gigabytes in the test runner.
            throw new Error("oversized inventory reached a body read");
          },
        })(
          oversized,
          async () => {
            inspections++;
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(metadataCalls.some((cmd) => cmd.includes("--batch-all-objects"))).toBe(true);
      expect(bodyCalls).toHaveLength(0);
      expect(inspections).toBe(0);
      await clean(path);
    },
    120_000,
  );
  test("reads a valid binary blob exactly at the expanded object cap", async () => {
    const source = await mkdtemp(join(root, "large-source-")),
      path = await sandbox();
    const bytes = Buffer.alloc(104_857_600, 97);
    bytes.set([0, 255, 254, 128], 65_535);
    await git(source, ["init", "--template="]);
    await writeFile(join(source, "large"), bytes);
    await git(source, ["add", "large"]);
    await git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "large blob",
    ]);
    const commit = await git(source, ["rev-parse", "HEAD"]),
      blob = hashObject("sha1", "blob", bytes);
    const input = await createRunObjectExporter({ scratchRoot: root })(
      {
        repository: { path: source, lockPath: source, trust: "factory-owned" },
        runScope: "large",
        commits: [commit],
        objectFormat: "sha1",
      },
      signal(),
    );
    if (!input) throw new Error("expected export");
    await rm(source, { recursive: true });
    let inspected = false;
    await createRunObjectValidator({ scratchRoot: path })(
      input,
      async (reader) => {
        inspected = true;
        expect(await reader.type(blob)).toBe("blob");
        const raw = await reader.read(blob);
        expect(raw.byteLength).toBe(bytes.length);
        expect(Buffer.from(raw).equals(bytes)).toBe(true);
      },
      signal(),
    );
    expect(inspected).toBe(true);
    await clean(path);
  }, 30_000);
  test.each(["sha1", "sha256"] as const)(
    "unpublished %s closure survives retention and source removal",
    async (format) => {
      const { input, tree, blob } = sample(format),
        path = await sandbox();
      const validate = createRunObjectValidator({ scratchRoot: path });
      const inspect = async (reader: PrivateObjectReader) => {
        const objects = new Map<string, string>();
        for await (const item of reader.objects()) objects.set(item.oid, item.type);
        for (const oid of input.requiredCommits) expect(await reader.type(oid)).toBe("commit");
        expect(objects.get(tree)).toBe("tree");
        expect(objects.get(blob)).toBe("blob");
        expect(await reader.read(blob)).toEqual(content);
        for (const [oid, type] of objects) expect(hashObject(format, type, await reader.read(oid))).toBe(oid);
      };
      await validate(input, inspect, signal());
      await clean(path);
      const retained = join(root, `retained-${format}`);
      await writeFile(retained, input.bytes);
      const reopened = await readFile(retained);
      await validate({ ...input, bytes: reopened }, inspect, signal());
      const exportedAgain = join(root, `reexport-${format}`);
      await writeFile(exportedAgain, reopened);
      expect(await readFile(exportedAgain)).toEqual(Buffer.from(input.bytes));
      await clean(path);
    },
  );
  test("accepts version 2 SHA-1 without capabilities", async () => {
    const { input } = sample(),
      path = await sandbox();
    input.bytes = Buffer.from(
      Buffer.from(input.bytes)
        .toString("latin1")
        .replace("# v3 git bundle\n@object-format=sha1", "# v2 git bundle"),
      "latin1",
    );
    let calls = 0;
    await createRunObjectValidator({ scratchRoot: path })(
      input,
      async () => {
        calls++;
      },
      signal(),
    );
    expect(calls).toBe(1);
    await clean(path);
  });
  test.each(["prerequisite", "truncated", "malformed", "unexpected", "noncommit", "missing-closure"])(
    "rejects actual %s bundle",
    async (fault) => {
      const { input } = sample(),
        path = await sandbox();
      const bytes = Buffer.from(input.bytes),
        boundary = bytes.indexOf("\n\n");
      if (fault === "prerequisite") Object.assign(input, sample().prerequisite);
      if (fault === "truncated") input.bytes = bytes.subarray(0, bytes.length - 10);
      if (fault === "malformed") {
        bytes[boundary + 15] = (bytes[boundary + 15] ?? 0) ^ 255;
        input.bytes = bytes;
      }
      if (fault === "unexpected")
        input.bytes = Buffer.concat([
          bytes.subarray(0, boundary),
          Buffer.from(`\n${input.requiredCommits[0]} refs/heads/extra`),
          bytes.subarray(boundary),
        ]);
      if (fault === "noncommit" || fault === "missing-closure") {
        const raw =
          fault === "noncommit"
            ? content
            : Buffer.from(
                `tree ${"b".repeat(40)}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nmissing tree\n`,
              );
        const type = fault === "noncommit" ? "blob" : "commit",
          oid = hashObject("sha1", type, raw);
        input.requiredCommits = [oid];
        input.refs = [{ name: ref(oid), oid }];
        input.bytes = Buffer.concat([
          Buffer.from(`# v3 git bundle\n@object-format=sha1\n${oid} ${ref(oid)}\n\n`),
          packFor("sha1", [{ type: fault === "noncommit" ? 3 : 1, bytes: raw }]),
        ]);
      }
      let inspected = false;
      await expect(
        createRunObjectValidator({ scratchRoot: path })(
          input,
          async () => {
            inspected = true;
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(RunTransferError);
      expect(inspected).toBe(false);
      await clean(path);
    },
  );
});

describe("unreachable object", () => {
  test.each(["sha1", "sha256"] as const)(
    "enumerates and reads all original %s pack objects",
    async (format) => {
      const { input } = sample(format),
        path = await sandbox(),
        width = format === "sha1" ? 20 : 32;
      const original = Buffer.from(input.bytes),
        old = original.subarray(original.indexOf("\n\n") + 2, -width);
      const extra = Buffer.from([0, 255, 254, 128, 0, 13, 10, 1]),
        oid = hashObject(format, "blob", extra);
      const empty = Buffer.alloc(0),
        emptyOID = hashObject(format, "blob", empty);
      const single = packFor(format, [
        { type: 3, bytes: extra },
        { type: 3, bytes: empty },
      ]);
      const body = Buffer.concat([old, single.subarray(12, -width)]);
      body.writeUInt32BE(old.readUInt32BE(8) + 2, 8);
      const updated = withPack(input, Buffer.concat([body, createHash(format).update(body).digest()]));
      await createRunObjectValidator({ scratchRoot: path })(
        updated,
        async (reader) => {
          const inventory = [];
          for await (const item of reader.objects()) inventory.push(item.oid);
          expect(inventory).toContain(oid);
          expect(inventory).toContain(emptyOID);
          expect(await reader.type(oid)).toBe("blob");
          expect(await reader.read(oid)).toEqual(extra);
          expect(await reader.type(emptyOID)).toBe("blob");
          expect(await reader.read(emptyOID)).toEqual(empty);
        },
        signal(),
      );
      await clean(path);
    },
  );
});

describe("hostile configuration", () => {
  test("ambient selectors cannot execute commands or redirect imported objects", async () => {
    const { input } = sample(),
      path = await sandbox(),
      hostile = join(root, "hostile"),
      marker = join(root, "executed");
    await mkdir(hostile);
    const script = join(hostile, "reference-transaction");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const config = join(hostile, "config");
    await writeFile(
      config,
      `[core]\n hooksPath = ${hostile}\n[filter "evil"]\n smudge = ${script}\n process = ${script}\n[url "ext::${script}"]\n insteadOf = file://\n[fetch]\n recurseSubmodules = true\n[remote "hostile"]\n url = ext::${script}\n tagOpt = --tags\n`,
    );
    const existing = join(hostile, "existing.git"),
      stored = join(root, "existing.bundle");
    await git(hostile, ["init", "--bare", "--template=", existing]);
    await writeFile(stored, input.bytes);
    await git(existing, ["fetch", "--no-tags", stored, `${input.refs[0]?.name}:refs/heads/keep`]);
    const refsBefore = await git(existing, ["show-ref"]),
      objectsBefore = await git(existing, ["cat-file", "--batch-all-objects", "--batch-check"]);
    const changes = {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hostile,
      GIT_OBJECT_DIRECTORY: join(existing, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(existing, "objects"),
      GIT_DIR: existing,
      GIT_COMMON_DIR: existing,
      GIT_WORK_TREE: hostile,
      GIT_EXEC_PATH: hostile,
      GIT_SHALLOW_FILE: config,
    };
    const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    const before = await readdir(hostile),
      calls: string[][] = [];
    try {
      Object.assign(process.env, changes);
      await createRunObjectValidator({
        scratchRoot: path,
        cacheGit: async (cmd, opts) => {
          calls.push(cmd);
          expect(opts.env?.GIT_OBJECT_DIRECTORY).toBeUndefined();
          return cacheGit(cmd, opts);
        },
      })(
        input,
        async (reader) => {
          expect(await reader.type(input.requiredCommits[0] ?? "")).toBe("commit");
        },
        signal(),
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(await git(existing, ["show-ref"])).toBe(refsBefore);
    expect(await git(existing, ["cat-file", "--batch-all-objects", "--batch-check"])).toBe(objectsBefore);
    expect(await readdir(hostile)).toEqual(before);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(calls.find((cmd) => cmd.includes("fetch"))?.slice(-input.refs.length)).toEqual(
      input.refs.map((r) => `${r.name}:${r.name}`),
    );
    await clean(path);
  });
});

describe("inspection lifetime", () => {
  test("reader subprocess failures hide private diagnostics and still clean up", async () => {
    const { input, blob } = sample(),
      path = await sandbox();
    let inspecting = false;
    await createRunObjectValidator({
      scratchRoot: path,
      runProcess: async (options) => {
        if (inspecting) throw new Error("private Git diagnostic");
        return runProcess(options);
      },
    })(
      input,
      async (reader) => {
        inspecting = true;
        const error: unknown = await reader.read(blob).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: "corrupt" });
        expect(String(error)).not.toContain("private Git diagnostic");
      },
      signal(),
    );
    await clean(path);
  });
  test("in-flight reads cannot escape inspection and finish before scratch removal", async () => {
    const { input, blob } = sample(),
      path = await sandbox();
    const reading = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    let inspecting = false,
      cleaned = false,
      read: Promise<Uint8Array> | undefined;
    const validation = createRunObjectValidator({
      scratchRoot: path,
      runProcess: async (options) => {
        const result = await runProcess(options);
        if (inspecting) {
          reading.resolve();
          await finish.promise;
        }
        return result;
      },
      removeScratch: async (dir) => {
        await rm(dir, { recursive: true });
        cleaned = true;
      },
    })(
      input,
      async (reader) => {
        inspecting = true;
        read = reader.read(blob);
        await reading.promise;
      },
      signal(),
    );
    await reading.promise;
    await Promise.resolve();
    expect(cleaned).toBe(false);
    finish.resolve();
    if (!read) throw new Error("expected pending read");
    await expect(read).rejects.toMatchObject({ code: "unavailable" });
    await validation;
    expect(cleaned).toBe(true);
    await clean(path);
  });
  test.each(["success", "failure", "abort", "final-abort", "cleanup-abort"])(
    "owns quarantine through %s and invalidates escaped readers",
    async (outcome) => {
      const { input, blob } = sample(),
        path = await sandbox(),
        controller = new AbortController();
      const ready = Promise.withResolvers<PrivateObjectReader>(),
        release = Promise.withResolvers<void>(),
        cleaning = Promise.withResolvers<void>(),
        remove = Promise.withResolvers<void>();
      let settled = false;
      const validation = createRunObjectValidator({
        scratchRoot: path,
        removeScratch: async (dir) => {
          cleaning.resolve();
          await remove.promise;
          await rm(dir, { recursive: true });
        },
      })(
        input,
        async (reader) => {
          ready.resolve(reader);
          await release.promise;
          if (outcome === "failure") throw new Error("private inspection error");
          if (outcome === "final-abort") controller.abort();
        },
        controller.signal,
      ).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const reader = await ready.promise,
        iterable = reader.objects(),
        iterator = iterable[Symbol.asyncIterator]();
      expect(await reader.read(blob)).toEqual(content);
      expect((await iterator.next()).done).toBe(false);
      expect(settled).toBe(false);
      if (outcome === "abort") controller.abort();
      release.resolve();
      await cleaning.promise;
      if (outcome === "cleanup-abort") controller.abort();
      expect(settled).toBe(false);
      await expect(reader.read(blob)).rejects.toMatchObject({ code: "unavailable" });
      await expect(reader.type(blob)).rejects.toMatchObject({ code: "unavailable" });
      expect(() => reader.objects()).toThrow(RunTransferError);
      expect(() => iterable[Symbol.asyncIterator]()).toThrow(RunTransferError);
      await expect(iterator.next()).rejects.toMatchObject({ code: "unavailable" });
      remove.resolve();
      const result = await validation;
      await clean(path);
      if (outcome === "success") expect(result).toBeUndefined();
      else expect(result).toMatchObject({ code: outcome.includes("abort") ? "aborted" : "invalid" });
    },
  );
});
