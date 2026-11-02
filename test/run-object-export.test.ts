import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitOptions } from "../src/git/confinement.ts";
import type { RunObjectExportInput } from "../src/pipeline/run-object-contract.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";

const a = "a".repeat(40),
  b = "b".repeat(40),
  parent = "c".repeat(40);
const name = (oid: string) => `refs/limitless-run-objects/run-1/${oid}`;
const deferred = () => Promise.withResolvers<void>();

function fixture() {
  const root = join(tmpdir(), "fake-run-object-export");
  const input: RunObjectExportInput = {
    repository: { path: root, lockPath: root, trust: "agent-controlled" },
    runScope: "run-1",
    commits: [b, a],
    objectFormat: "sha1",
  };
  const refs = new Map([
    ["refs/heads/main", a],
    ["refs/limitless-run-objects/neighbor/keep", b],
  ]);
  const objects = new Map([
    [a, { type: "commit", parents: [parent] }],
    [b, { type: "commit", parents: [a] }],
    [parent, { type: "commit", parents: [] as string[] }],
  ]);
  const calls: { cmd: string[]; options: GitOptions; runner: string }[] = [];
  const events: string[] = [],
    scratch = new Set<string>();
  let serial = 0,
    bytes = new Uint8Array();
  const state = {
    input,
    refs,
    objects,
    calls,
    events,
    scratch,
    format: "sha1",
    empty: false,
    hook: async (_event: string) => {},
    async step(event: string) {
      events.push(event);
      await state.hook(event);
    },
    closure(oids: string[]): string[] {
      const seen = new Set<string>();
      const visit = (oid: string) => {
        if (seen.has(oid)) return;
        seen.add(oid);
        const object = objects.get(oid);
        if (!object) throw new Error("missing local object; remote access forbidden");
        object.parents.forEach(visit);
      };
      oids.forEach(visit);
      return [...seen].sort();
    },
  };
  const runner = (kind: string) => async (cmd: string[], options: GitOptions) => {
    calls.push({ cmd, options, runner: kind });
    expect([root, join(root, "linked")]).toContain(options.cwd);
    expect(options.env).toMatchObject({
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_SHALLOW_FILE: "",
    });
    options.signal?.throwIfAborted();
    options.dispatchGuard?.();
    const [, command, ...args] = cmd;
    if (command === "rev-parse") {
      await state.step("format");
      return { stdout: state.format };
    }
    if (command === "cat-file") {
      await state.step(`type:${args[1]}`);
      const object = objects.get(args[1] ?? "");
      if (!object) throw new Error("private Git diagnostic");
      return { stdout: object.type };
    }
    if (command === "rev-list") {
      await state.step("closure");
      state.closure(args.filter((arg) => /^[a-f0-9]{40,64}$/.test(arg)));
      return { stdout: "" };
    }
    if (command === "update-ref") {
      expect(args[0]).toBe("--no-deref");
      const deleting = args[1] === "-d";
      const ref = args[deleting ? 2 : 1] ?? "",
        oid = args[deleting ? 3 : 2] ?? "";
      await state.step(`${deleting ? "delete" : "create"}:${oid}`);
      if (deleting) {
        if (refs.get(ref) !== oid) throw new Error("ref changed");
        refs.delete(ref);
      } else {
        expect(args[3]).toBe("0".repeat(oid.length));
        if (refs.has(ref)) throw new Error("preexisting ref");
        refs.set(ref, oid);
      }
      return { stdout: "" };
    }
    if (command === "bundle") {
      await state.step("bundle");
      expect(args.slice(0, 2)).toEqual(["create", "--version=3"]);
      bytes = new TextEncoder().encode(
        state.closure(args.slice(3).map((ref) => refs.get(ref) ?? "")).join("\n"),
      );
      return { stdout: "" };
    }
    throw new Error(`Forbidden Git command: ${command}`);
  };
  const run = createRunObjectExporter({
    scratchRoot: root,
    worktreeGit: runner("worktree"),
    cacheGit: runner("cache"),
    makeScratch: async (prefix) => {
      await state.step("scratch");
      const dir = `${prefix}${++serial}`;
      scratch.add(dir);
      return dir;
    },
    readBundle: async (path) => {
      expect(scratch.has(join(path, ".."))).toBe(true);
      await state.step("read");
      return state.empty ? new Uint8Array() : bytes;
    },
    removeScratch: async (dir) => {
      await state.step("remove");
      expect(scratch.has(dir)).toBe(true);
      scratch.delete(dir);
    },
  });
  return { ...state, run, state };
}

test("captured, normalized commits use deterministic explicit refs and include unpublished ancestry", async () => {
  const f = fixture();
  const captured = { ...f.input, commits: [b.toUpperCase(), a, b] };
  f.refs.set("refs/heads/main", b);
  const result = await f.run(captured, new AbortController().signal);
  expect(result).toMatchObject({
    requiredCommits: [a, b],
    objectFormat: "sha1",
    refs: [
      { name: name(a), oid: a },
      { name: name(b), oid: b },
    ],
  });
  expect(new TextDecoder().decode(result?.bytes)).toBe([a, b, parent].join("\n"));
  const bundle = f.calls.find(({ cmd }) => cmd[1] === "bundle");
  expect(bundle?.cmd).toEqual([
    "git",
    "bundle",
    "create",
    "--version=3",
    join(tmpdir(), "fake-run-object-export", "run-objects-1", "objects.bundle"),
    name(a),
    name(b),
  ]);
  expect(
    f.calls
      .flatMap(({ cmd }) => cmd)
      .some(
        (arg) => arg === "HEAD" || arg === "--all" || arg.startsWith("^") || arg.startsWith("refs/heads/"),
      ),
  ).toBe(false);
  const reordered = await f.run({ ...f.input, commits: [a, b] }, new AbortController().signal);
  expect(reordered?.refs).toEqual(result?.refs);
  expect(f.refs.size).toBe(2);
  expect(f.scratch.size).toBe(0);
});

test("empty valid sets create no resources; factory repositories use only cacheGit", async () => {
  const f = fixture();
  expect(await f.run({ ...f.input, commits: [] }, new AbortController().signal)).toBeNull();
  expect(f.events).toEqual([]);
  expect(f.calls).toEqual([]);
  f.input.repository.trust = "factory-owned";
  await f.run(f.input, new AbortController().signal);
  expect(f.calls.every(({ runner }) => runner === "cache")).toBe(true);
});

test("SHA-256 commits use the repository format and preserve neighboring scratch", async () => {
  const f = fixture(),
    oid = "d".repeat(64),
    neighbor = join(tmpdir(), "neighbor-scratch");
  f.state.format = "sha256";
  f.objects.set(oid, { type: "commit", parents: [] });
  f.scratch.add(neighbor);
  const result = await f.run(
    { ...f.input, commits: [oid], objectFormat: "sha256" },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    objectFormat: "sha256",
    requiredCommits: [oid],
    refs: [{ name: name(oid), oid }],
  });
  expect([...f.scratch]).toEqual([neighbor]);
});

test.each(["HEAD", "abc", ` ${a}`, "0".repeat(40), `${a}^`])(
  "rejects malformed captured commit %s before work",
  async (oid) => {
    const f = fixture();
    await expect(f.run({ ...f.input, commits: [oid] }, new AbortController().signal)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(f.events).toEqual([]);
  },
);
test.each(["../other", "run/1", "run.lock", "", "-run"])(
  "rejects unsafe scope %s before work",
  async (runScope) => {
    const f = fixture();
    await expect(f.run({ ...f.input, runScope }, new AbortController().signal)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(f.events).toEqual([]);
  },
);

test.each(["shallow", "missing-commit", "missing-blob", "non-commit", "format", "mixed", "empty-output"])(
  "incomplete or incompatible exports fail offline: %s",
  async (fault) => {
    const f = fixture();
    let code = "incomplete";
    if (fault === "shallow") f.objects.delete(parent);
    if (fault === "missing-commit") f.objects.delete(a);
    if (fault === "missing-blob")
      f.state.hook = async (event) => {
        if (event === "bundle") throw new Error("missing blob");
      };
    if (fault === "non-commit") {
      f.objects.set(a, { type: "tag", parents: [] });
      code = "invalid";
    }
    if (fault === "format") {
      f.state.format = "sha256";
      code = "unsupported";
    }
    if (fault === "mixed") {
      f.input.commits = [a, "d".repeat(64)];
      code = "unsupported";
    }
    if (fault === "empty-output") f.state.empty = true;
    await expect(f.run(f.input, new AbortController().signal)).rejects.toMatchObject({ code });
    expect(f.refs.size).toBe(2);
    expect(f.scratch.size).toBe(0);
  },
);

test.each(["format", `type:${a}`, "closure", "scratch", `create:${a}`, `create:${b}`, "bundle", "read"])(
  "failure and cancellation release only acquired resources at %s",
  async (step) => {
    for (const cancel of [false, true]) {
      const f = fixture(),
        controller = new AbortController();
      f.state.hook = async (event) => {
        if (event !== step) return;
        if (cancel) controller.abort();
        else throw new Error("private Git diagnostic");
      };
      const error = await f.run(f.input, controller.signal).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RunTransferError);
      expect(String(error)).not.toContain("private Git diagnostic");
      if (cancel) expect(error).toMatchObject({ code: "aborted" });
      expect([...f.refs]).toEqual([
        ["refs/heads/main", a],
        ["refs/limitless-run-objects/neighbor/keep", b],
      ]);
      expect(f.scratch.size).toBe(0);
      expect(
        f.calls.filter(({ cmd }) => cmd.includes("-d")).every(({ options }) => options.signal === undefined),
      ).toBe(true);
    }
  },
);

test("pre-cancelled operations do nothing, including with an empty set", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  for (const commits of [[], [a]])
    await expect(f.run({ ...f.input, commits }, controller.signal)).rejects.toMatchObject({
      code: "aborted",
    });
  expect(f.events).toEqual([]);
});

test.each([a, b])("a preexisting deterministic ref %s is refused even at the expected OID", async (oid) => {
  const f = fixture();
  f.refs.set(name(oid), oid);
  await expect(f.run(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "conflict" });
  expect(f.refs.get(name(oid))).toBe(oid);
  expect(f.refs.size).toBe(3);
  expect(f.events).not.toContain(`delete:${oid}`);
});

test.each(["changed", "deletion-failure", "scratch-failure"])(
  "cleanup attempts all owned resources and rejects on %s",
  async (fault) => {
    const f = fixture();
    f.state.hook = async (event) => {
      if (event === "read" && fault === "changed") f.refs.set(name(a), parent);
      if (
        (event === `delete:${a}` && fault === "deletion-failure") ||
        (event === "remove" && fault === "scratch-failure")
      )
        throw new Error("cleanup failure");
    };
    await expect(f.run(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.events.slice(-3)).toEqual([`delete:${a}`, `delete:${b}`, "remove"]);
    expect(f.refs.has(name(b))).toBe(false);
    expect(f.refs.get(name(a))).toBe(
      fault === "changed" ? parent : fault === "deletion-failure" ? a : undefined,
    );
    expect(f.refs.has("refs/limitless-run-objects/neighbor/keep")).toBe(true);
  },
);

test.each(["none", "bundle", "cleanup"])(
  "linked worktree exports hold the shared lock through deferred cleanup: %s cancellation",
  async (cancel) => {
    const f = fixture(),
      controller = new AbortController();
    const bundled = deferred(),
      releaseBundle = deferred(),
      cleaning = deferred(),
      releaseCleanup = deferred();
    let first = true,
      settled = false;
    f.state.hook = async (event) => {
      if (!first) return;
      if (event === "bundle") {
        bundled.resolve();
        await releaseBundle.promise;
      }
      if (event === "remove") {
        cleaning.resolve();
        await releaseCleanup.promise;
        first = false;
      }
    };
    const p = f.run(f.input, controller.signal).then(
      (result) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        expect(error).toMatchObject({ code: "aborted" });
        return null;
      },
    );
    await bundled.promise;
    const second = f.run(
      { ...f.input, repository: { ...f.input.repository, path: join(f.input.repository.path, "linked") } },
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(f.events.filter((event) => event === "format")).toHaveLength(1);
    if (cancel === "bundle") controller.abort();
    releaseBundle.resolve();
    await cleaning.promise;
    expect(settled).toBe(false);
    expect(f.events.filter((event) => event === "format")).toHaveLength(1);
    if (cancel === "cleanup") controller.abort();
    releaseCleanup.resolve();
    expect((await p) === null).toBe(cancel !== "none");
    expect(await second).not.toBeNull();
    expect(f.events.filter((event) => event === "format")).toHaveLength(2);
    expect(f.refs.size).toBe(2);
    expect(f.scratch.size).toBe(0);
  },
);
