import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import type { PrivateObjectReader, RunObjectBundle } from "../src/pipeline/run-object-contract.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import {
  createRunObjectPrivacyValidator,
  inspectRunObjectCredentials,
} from "../src/pipeline/run-object-privacy.ts";
import { createRunObjectValidator } from "../src/pipeline/run-object-quarantine.ts";
import { createCredentialRegistry } from "../src/util/credential-matcher.ts";
import { registerCredential, runProcess, sh } from "../src/util/proc.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "object-privacy-tests-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const noop = async () => {};
const binary = Buffer.from([0, 255, 128, 192, 10]);
const makeNeedle = () => `${randomUUID()}${String.fromCharCode(0x96ea)}`;

// A complete offline bundle with a tag and blob outside the advertised commit closure.
function fixture(location = "", needle = makeNeedle()) {
  const objects = new Map<string, { type: "commit" | "tree" | "blob" | "tag"; bytes: Buffer }>();
  const add = (type: "commit" | "tree" | "blob" | "tag", bytes: Buffer) => {
    const oid = createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    objects.set(oid, { type, bytes });
    return oid;
  };
  const blob = add("blob", location === "blob" ? Buffer.concat([binary, Buffer.from(needle)]) : binary);
  const tree = add(
    "tree",
    Buffer.concat([
      Buffer.from(`100644 ${location === "tree" ? needle : "payload"}\0`),
      Buffer.from(blob, "hex"),
    ]),
  );
  const oid = add(
    "commit",
    Buffer.from(
      `tree ${tree}\nauthor ${location === "metadata" ? needle : "Test"} <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\n${location === "commit" ? needle : "message"}\n`,
    ),
  );
  add(
    "tag",
    Buffer.from(
      `object ${oid}\ntype commit\ntag extra\ntagger Test <test@example.com> 1 +0000\n\n${location === "tag" ? needle : "tag"}\n`,
    ),
  );
  add("blob", Buffer.from(location === "unreachable" ? needle : "unreachable"));
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  const entries = [...objects.values()].map(({ type, bytes }) => {
    let size = bytes.length;
    const prefix = [({ commit: 1, tree: 2, blob: 3, tag: 4 }[type] << 4) | (size & 15)];
    size >>>= 4;
    while (size) {
      prefix[prefix.length - 1] = (prefix.at(-1) ?? 0) | 128;
      prefix.push(size & 127);
      size >>>= 7;
    }
    return Buffer.concat([Buffer.from(prefix), deflateSync(bytes)]);
  });
  const pack = Buffer.concat([header, ...entries]);
  const name = `refs/limitless-run-objects/privacy/${oid}`;
  const input: RunObjectBundle = {
    bytes: Buffer.concat([
      Buffer.from(`# v3 git bundle\n@object-format=sha1\n${oid} ${name}\n\n`),
      pack,
      createHash("sha1").update(pack).digest(),
    ]),
    objectFormat: "sha1",
    requiredCommits: [oid],
    refs: [{ name, oid }],
  };
  return { input, objects, needle };
}

test.each(["metadata", "commit", "tree", "blob", "tag"])(
  "rejects credentials in raw %s content across reader chunks",
  async (location) => {
    const f = fixture(location),
      path = await mkdtemp(join(root, "split-"));
    const registry = createCredentialRegistry();
    registry.add(f.needle);
    let projected = false;
    await expect(
      createRunObjectPrivacyValidator({
        scratchRoot: path,
        credentials: registry.values,
        runProcess: async (options) => {
          expect(options.tailLimit).toBe(0);
          expect(options.onStdoutLine).toBeUndefined();
          const object = f.objects.get(options.cmd.at(-1) ?? "");
          if (!object) throw new Error("missing fixture object");
          for (const byte of object.bytes)
            options.onRawChunk?.(Buffer.from([byte]).toString("latin1"), "stdout");
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            signal: null,
            cancelled: false,
            timedOut: false,
            idleTimedOut: false,
            truncated: false,
            durationMs: 0,
          };
        },
      })(
        f.input,
        async () => {
          projected = true;
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(projected).toBe(false);
    expect(await readdir(path)).toEqual([]);
  },
);

test("physical inventory catches unreachable credentials after structural validation succeeds", async () => {
  const f = fixture("unreachable"),
    path = await mkdtemp(join(root, "unreachable-"));
  await createRunObjectValidator({ scratchRoot: path })(f.input, noop, signal());
  let retained: Uint8Array | undefined,
    projected = false;
  await expect(
    (async () => {
      await createRunObjectPrivacyValidator({ scratchRoot: path, credentials: () => [f.needle] })(
        f.input,
        async () => {
          projected = true;
        },
        signal(),
      );
      retained = f.input.bytes;
    })(),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(retained).toBeUndefined();
  expect(projected).toBe(false);
  expect(await readdir(path)).toEqual([]);
});

test("binary content stays unchanged and destination registry is independent", async () => {
  const f = fixture("blob"),
    path = await mkdtemp(join(root, "destination-"));
  const original = f.input.bytes.slice();
  let inspected = 0;
  await createRunObjectPrivacyValidator({
    scratchRoot: path,
    credentials: () => [String.fromCharCode(0xfffd)],
  })(
    f.input,
    async (reader) => {
      for await (const object of reader.objects()) {
        const expected = f.objects.get(object.oid);
        if (!expected) throw new Error("unexpected imported object");
        expect(await reader.read(object.oid)).toEqual(expected.bytes);
        inspected++;
      }
    },
    signal(),
  );
  expect(inspected).toBe(5);
  expect(f.input.bytes).toEqual(original);
  await expect(
    createRunObjectPrivacyValidator({ scratchRoot: path, credentials: () => [f.needle] })(
      f.input,
      noop,
      signal(),
    ),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(f.input.bytes).toEqual(original);
  expect(await readdir(path)).toEqual([]);
});

test.each(["enumeration", "read", "cancel-enumeration", "empty-registry"])(
  "partial inspection fails closed without exposing underlying data: %s",
  async (fault) => {
    const needle = makeNeedle(),
      controller = new AbortController();
    const payload = `private payload ${needle}`;
    const reader: PrivateObjectReader = {
      async *objects() {
        yield { oid: "first", type: "blob" };
        if (fault === "cancel-enumeration") controller.abort(new Error(payload));
        throw new Error(payload, { cause: payload });
      },
      type: async () => "blob",
      read: async () => {
        if (fault === "read") throw new Error(payload, { cause: payload });
        return binary;
      },
    };
    let retained = false;
    const validate = createRunObjectPrivacyValidator({
      scratchRoot: root,
      credentials: () => (fault === "empty-registry" ? [] : [needle]),
      validate: async (_input, inspect) => {
        await inspect(reader);
      },
    });
    const error: unknown = await validate(fixture().input, noop, controller.signal).then(
      () => {
        retained = true;
      },
      (error: unknown) => error,
    );
    expect(retained).toBe(false);
    expect(error).toMatchObject({
      message: fault === "cancel-enumeration" ? "Run transfer was aborted" : "Run transfer data is invalid",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(needle);
    expect(String(error)).not.toContain("private payload");
  },
);

test.each(["success", "failure", "cancel", "claim-wait", "claim-lost"])(
  "real inspection reads while quarantine is live and waits for cleanup: %s",
  async (outcome) => {
    const f = fixture(),
      path = await mkdtemp(join(root, "lifetime-")),
      controller = new AbortController();
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>(),
      remove = Promise.withResolvers<void>();
    const control = outcome === "claim-wait" ? new ClaimWaitError("lease") : new ClaimLostError();
    const logs = [
      spyOn(console, "error").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
      spyOn(console, "log").mockImplementation(() => {}),
    ];
    let reads = 0,
      accepted = false,
      projected = false,
      settled = false;
    try {
      const validation = createRunObjectPrivacyValidator({
        scratchRoot: path,
        credentials: () => [f.needle],
        runProcess: async (options) => {
          const result = await runProcess(options);
          if (++reads === f.objects.size + 1) {
            expect(await readdir(options.cwd)).toContain("repo.git");
            ready.resolve();
            await release.promise;
            if (outcome === "failure") {
              options.onRawChunk?.(`private payload ${f.needle}`, "stdout");
              throw new Error(`private payload ${f.needle}`, { cause: result });
            }
            if (outcome.startsWith("claim-")) throw control;
          }
          return result;
        },
        removeScratch: async (dir) => {
          cleaning.resolve();
          await remove.promise;
          await rm(dir, { recursive: true });
        },
      })(
        f.input,
        async () => {
          projected = true;
        },
        controller.signal,
      ).then(
        () => {
          accepted = true;
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await ready.promise;
      expect(settled).toBe(false);
      if (outcome === "cancel") controller.abort();
      release.resolve();
      await cleaning.promise;
      expect(settled).toBe(false);
      expect(await readdir(path)).toHaveLength(1);
      remove.resolve();
      const error = await validation;
      expect(await readdir(path)).toEqual([]);
      expect(accepted).toBe(outcome === "success");
      expect(projected).toBe(outcome === "success");
      if (outcome.startsWith("claim-")) expect(error).toBe(control);
      else if (outcome !== "success") {
        expect(error).toMatchObject({
          message: outcome === "cancel" ? "Run transfer was aborted" : "Run transfer data is invalid",
        });
        expect(error).not.toHaveProperty("cause");
        expect(String(error)).not.toContain(f.needle);
      }
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      remove.resolve();
      for (const log of logs) log.mockRestore();
    }
  },
);

test("export default boundary rejects registered credentials and returns clean original bytes", async () => {
  for (const unsafe of [true, false]) {
    const f = fixture(unsafe ? "commit" : ""),
      path = await mkdtemp(join(root, "export-"));
    const source = join(path, "source"),
      scratch = join(path, "scratch");
    await mkdir(source);
    await mkdir(scratch);
    registerCredential(`OBJECT_TEST_${randomUUID()}`, f.needle);
    const bundle = join(path, "input.bundle");
    await writeFile(bundle, f.input.bytes);
    await sh(["git", "init", "--bare", "--template=", "--object-format=sha1"], { cwd: source });
    await sh(["git", "fetch", bundle, ...f.input.refs.map((ref) => `${ref.name}:${ref.name}`)], {
      cwd: source,
    });
    let original: Uint8Array | undefined, accepted: Uint8Array | undefined;
    const exported = createRunObjectExporter({
      scratchRoot: scratch,
      readBundle: async (path) => {
        original = await readFile(path);
        return original;
      },
    })(
      {
        repository: { path: source, lockPath: source, trust: "factory-owned" },
        runScope: "export",
        commits: f.input.requiredCommits,
        objectFormat: "sha1",
      },
      signal(),
    ).then((bundle) => {
      accepted = bundle?.bytes;
    });
    if (unsafe) {
      await expect(exported).rejects.toMatchObject({ code: "invalid" });
      expect(accepted).toBeUndefined();
    } else {
      await exported;
      expect(accepted).toBeDefined();
      expect(accepted).toEqual(original);
    }
    expect(await readdir(scratch)).toEqual([]);
    expect(
      (
        await sh(["git", "for-each-ref", "--format=%(refname)", "refs/limitless-run-objects/export/"], {
          cwd: source,
        })
      ).stdout,
    ).toBe("");
  }
});

test("claim control survives callback enumeration and composed validation failures", async () => {
  for (const control of [new ClaimWaitError("lease"), new ClaimLostError()]) {
    const reader: PrivateObjectReader = {
      objects() {
        throw control;
      },
      read: async () => binary,
      type: async () => "blob",
    };
    await expect(inspectRunObjectCredentials(reader, [], signal())).rejects.toBe(control);
    await expect(
      createRunObjectPrivacyValidator({
        scratchRoot: root,
        validate: async () => {
          throw control;
        },
      })(fixture().input, noop, signal()),
    ).rejects.toBe(control);
  }
});

test.each(["missing-callback", "cleanup-failure", "invalid-structure"])(
  "an empty registry cannot accept incomplete validation: %s",
  async (fault) => {
    const path = await mkdtemp(join(root, "incomplete-")),
      input = fixture().input;
    if (fault === "invalid-structure") input.requiredCommits = [];
    let retained = false;
    const validate = createRunObjectPrivacyValidator({
      scratchRoot: path,
      credentials: () => [],
      validate: fault === "missing-callback" ? noop : undefined,
      removeScratch: async (dir) => {
        await rm(dir, { recursive: true });
        if (fault === "cleanup-failure") throw new Error(makeNeedle());
      },
    });
    const error: unknown = await validate(input, noop, signal()).then(
      () => {
        retained = true;
      },
      (error: unknown) => error,
    );
    expect(retained).toBe(false);
    expect(error).toMatchObject({
      code:
        fault === "missing-callback" ? "incomplete" : fault === "cleanup-failure" ? "unavailable" : "invalid",
    });
    expect(error).not.toHaveProperty("cause");
    expect(await readdir(path)).toEqual([]);
  },
);
