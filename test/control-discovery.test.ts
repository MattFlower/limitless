import { expect, mock, test } from "bun:test";
import { createControlDirectory } from "../src/integrations/control-discovery.ts";
import { createControlRefClient, createControlRefReader } from "../src/integrations/control-ref.ts";
import {
  type SharedStoreDeps,
  SharedStoreError,
  type SharedStoreErrorCode,
} from "../src/integrations/shared-store.ts";
import { dataKey, deferred, graphqlUrl, json, Remote, token } from "./shared-store-fake.ts";

const prefix = "refs/control/receipt/";
const id = (n: number) => n.toString(16).padStart(64, "0");
const node = (name = id(1), refPrefix = prefix) => ({ name, prefix: refPrefix });
const connection = (nodes: unknown = [node()], hasNextPage: unknown = false, endCursor: unknown = null) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor },
});
const envelope = (refs: unknown = connection()) => ({
  data: { repository: { id: "repository-id", refs } },
});

// Only remote refs and opaque directory positions survive; no claim or local input index exists.
class DirectoryRemote extends Remote {
  positions = new Map<string, string>();
  listings: { after: unknown; query: string }[] = [];
  listingResponse?: () => Response;
  deps(overrides: Partial<SharedStoreDeps> = {}): SharedStoreDeps {
    return { repo: "Example/Companion", token, dataKey, request: this.request, ...overrides };
  }
  override handle(call: Parameters<Remote["handle"]>[0]): Response {
    const { query = "" } = call.body;
    if (!query.includes("refs(")) return super.handle(call);
    expect(call.url).toBe(graphqlUrl);
    expect(call.method).toBe("POST");
    expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(query).toMatch(/refs\(refPrefix:"refs\/control\/receipt\/",first:100,after:\$after\)/);
    expect(query).not.toContain("target");
    const variables: Record<string, unknown> = JSON.parse(String(call.init.body)).variables;
    expect(variables.r).toBe("repository-id");
    this.listings.push({ after: variables.after, query });
    if (this.listingResponse) return this.listingResponse();
    const names = [...this.refs.keys()].filter((key) => key.startsWith(prefix)).sort();
    const boundary = variables.after === null ? undefined : this.positions.get(String(variables.after));
    if (variables.after !== null && !boundary) throw new Error("Unknown directory cursor");
    // Repeating a boundary is intentional: consumers must deduplicate candidate keys.
    const start = boundary ? names.findIndex((name) => name >= boundary) : 0;
    const selected = names.slice(start, start + 100);
    const more = start + selected.length < names.length;
    const cursor = `directory:${this.positions.size}`;
    const last = selected.at(-1);
    if (last) this.positions.set(cursor, last);
    return json(
      envelope(
        connection(
          selected.map((name) => node(name.slice(prefix.length))),
          more,
          last ? cursor : null,
        ),
      ),
    );
  }
}

async function rejects(pending: Promise<unknown>, code: SharedStoreErrorCode = "unavailable") {
  const error: unknown = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SharedStoreError);
  expect(error).toMatchObject({ code, message: `Shared store error: ${code}` });
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(token);
  expect(String(error)).not.toContain("upstream-sentinel");
}

async function reservedRemote() {
  const remote = new DirectoryRemote();
  const result = await createControlRefClient(remote.deps()).write(
    { kind: "receipt", id: id(17) },
    null,
    Buffer.from(JSON.stringify({ state: "reserved", run: "original-run", claim: "original-claim" })),
  );
  expect(result.kind).toBe("applied");
  remote.calls = [];
  return remote;
}

test("new traversal recovers reserved lineage with only remote storage and no supplied candidate", async () => {
  const remote = await reservedRemote();
  expect([...remote.refs.keys()]).toHaveLength(1);
  expect([...remote.refs.keys()].every((name) => name.startsWith(prefix))).toBe(true);
  const page = await createControlDirectory(remote.deps()).listReceiptCandidates();
  expect(page.keys).toHaveLength(1);
  expect(remote.calls).toHaveLength(2); // Metadata and directory only; no content reads.
  const fresh = createControlRefReader(remote.deps());
  for (const key of page.keys) {
    const read = await fresh.read(key);
    if (read.kind !== "tip") throw new Error("Expected authenticated receipt");
    expect(JSON.parse(Buffer.from(read.tip.bytes).toString())).toEqual({
      state: "reserved",
      run: "original-run",
      claim: "original-claim",
    });
  }
});

test("returned cursors cover multiple pages with duplicates; explicit restart finds a behind-cursor insertion", async () => {
  const remote = new DirectoryRemote();
  for (let n = 1; n <= 205; n++) remote.refs.set(prefix + id(n), "unused-tip");
  remote.refs.set(`refs/control/run-index/${id(999)}`, "unused-tip");
  const directory = createControlDirectory(remote.deps());
  let page = await directory.listReceiptCandidates();
  const found = new Set(page.keys.map((key) => key.id));
  const observed = [...page.keys];
  remote.refs.set(prefix + id(0), "unused-tip");
  const cursors: string[] = [];
  while (page.next !== null) {
    cursors.push(page.next);
    expect(cursors.length).toBeLessThan(5);
    page = await directory.listReceiptCandidates(page.next);
    for (const key of page.keys) found.add(key.id);
    observed.push(...page.keys);
  }
  expect(found).toEqual(new Set(Array.from({ length: 205 }, (_, n) => id(n + 1))));
  expect(observed.length).toBeGreaterThan(found.size);
  expect(remote.listings.map((call) => call.after)).toEqual([null, ...cursors]);
  expect(remote.calls).toHaveLength(remote.listings.length * 2);
  const restart = await directory.listReceiptCandidates();
  expect(restart.keys).toContainEqual({ kind: "receipt", id: id(0) });
  expect(remote.listings.at(-1)?.after).toBeNull();
});

test("listing has only identities; a subsequent authenticated read observes a changed selection", async () => {
  const remote = await reservedRemote();
  const page = await createControlDirectory(remote.deps()).listReceiptCandidates();
  expect(page).toEqual({ keys: [{ kind: "receipt", id: id(17) }], next: null });
  expect(remote.calls.every((call) => call.url === graphqlUrl)).toBe(true);
  const selected = page.keys[0];
  if (!selected) throw new Error("Missing candidate");
  const before = remote.refs.get(prefix + selected.id);
  if (!before) throw new Error("Missing original selection");
  const bytes = Buffer.from(JSON.stringify({ state: "reserved", run: "new-selection", claim: "new-claim" }));
  const update = await createControlRefClient(remote.deps()).write(selected, before, bytes);
  if (update.kind !== "applied") throw new Error("Expected changed selection");
  expect(update.tip.sha).not.toBe(before);
  expect(await createControlRefReader(remote.deps()).read(selected)).toEqual({
    kind: "tip",
    tip: update.tip,
  });
  expect(update.tip.bytes).toEqual(bytes);
});

const malformed: [string, unknown][] = [
  ["errors", { errors: [{ message: "upstream-sentinel" }] }],
  ["partial data", { ...envelope(), errors: [{ message: "upstream-sentinel" }] }],
  ["empty errors", { ...envelope(), errors: [] }],
  ["null", null],
  ["array", []],
  ["missing data", {}],
  ["null data", { data: null }],
  ["null repository", { data: { repository: null } }],
  ["wrong repository", { data: { repository: { id: "other", refs: connection() } } }],
  ["null connection", envelope(null)],
  ["missing nodes", envelope({ pageInfo: { hasNextPage: false, endCursor: null } })],
  ["null nodes", envelope(connection(null))],
  ["null ref", envelope(connection([null]))],
  ["oversized", envelope(connection(Array.from({ length: 101 }, () => node())))],
  ...["refs/control/run-index/", "refs/control/receipt", "refs/control/receipt//"].map(
    (value): [string, unknown] => [`prefix ${value}`, envelope(connection([node(id(1), value)]))],
  ),
  ...[
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    `${id(1)}/extra`,
    `${prefix}${id(1)}`,
    `${id(1)}\n`,
  ].map((value): [string, unknown] => [`name ${JSON.stringify(value)}`, envelope(connection([node(value)]))]),
  ["missing prefix", envelope(connection([{ name: id(1) }]))],
  ["missing name", envelope(connection([{ prefix }]))],
  ["missing pagination", envelope({ nodes: [] })],
  ["null pagination", envelope({ nodes: [], pageInfo: null })],
  ["missing next flag", envelope({ nodes: [], pageInfo: { endCursor: null } })],
  ["wrong next flag", envelope(connection([], "false"))],
  ["missing cursor", envelope({ nodes: [], pageInfo: { hasNextPage: false } })],
  ...[null, "", " ", "bad\ncursor", "cursor\n", `cursor${String.fromCharCode(0)}`, 3, "previous"].map(
    (value): [string, unknown] => [
      `nonadvancing ${JSON.stringify(value)}`,
      envelope(connection([node()], true, value)),
    ],
  ),
  ["empty nonterminal", envelope(connection([], true, "next"))],
  ["oversized continuation cursor", envelope(connection([node()], true, "a".repeat(1025)))],
  ["invalid terminal cursor", envelope(connection([], false, 3))],
  ["mixed valid and malformed", envelope(connection([node(), node("bad")]))],
];
test.each(malformed)("incomplete or malformed discovery rejects: %s", async (_name, response) => {
  const remote = new DirectoryRemote();
  remote.listingResponse = () => json(response);
  await rejects(createControlDirectory(remote.deps()).listReceiptCandidates("previous"));
});

test("valid empty terminal page succeeds; invalid JSON, HTTP and transport failures stay fixed", async () => {
  const remote = new DirectoryRemote();
  expect(await createControlDirectory(remote.deps()).listReceiptCandidates()).toEqual({
    keys: [],
    next: null,
  });
  for (const response of [
    () => new Response("upstream-sentinel"),
    () => json({ message: "upstream-sentinel" }, 503),
    () => {
      throw new Error(`upstream-sentinel ${token}`);
    },
  ]) {
    remote.listingResponse = response;
    await rejects(createControlDirectory(remote.deps()).listReceiptCandidates());
  }
});

test("construction is inert; invalid cursors and pre-abort perform no requests", async () => {
  const remote = new DirectoryRemote();
  const request = mock(remote.request);
  const random = mock(() => new Uint8Array(12));
  const deadline = mock(() => ({ signal: new AbortController().signal, dispose() {} }));
  const directory = createControlDirectory(remote.deps({ request, random, deadline }));
  expect([request.mock.calls.length, random.mock.calls.length, deadline.mock.calls.length]).toEqual([
    0, 0, 0,
  ]);
  for (const after of ["", " ", "bad\ncursor", "cursor\n", "a".repeat(1025), 3, null])
    await rejects(directory.listReceiptCandidates(after as string), "invalid");
  const caller = new AbortController();
  caller.abort();
  await rejects(directory.listReceiptCandidates(undefined, caller.signal), "aborted");
  expect([request.mock.calls.length, random.mock.calls.length, deadline.mock.calls.length]).toEqual([
    0, 0, 0,
  ]);
});

test("input and continuation cursors accept the 1024-character boundary", async () => {
  const remote = new DirectoryRemote();
  const after = "a".repeat(1024);
  const next = "b".repeat(1024);
  remote.listingResponse = () => json(envelope(connection([node()], true, next)));
  expect(await createControlDirectory(remote.deps()).listReceiptCandidates(after)).toEqual({
    keys: [{ kind: "receipt", id: id(1) }],
    next,
  });
  expect(remote.listings.map((call) => call.after)).toEqual([after]);
});

test("every continuation freshly checks private repository metadata before listing", async () => {
  const remote = new DirectoryRemote();
  remote.listingResponse = () => json(envelope(connection([node()], true, "continuation")));
  const directory = createControlDirectory(remote.deps());
  const first = await directory.listReceiptCandidates();
  if (!first.next) throw new Error("Expected continuation");
  for (const [metadata, code] of [
    [{ id: "repository-id", nameWithOwner: "Example/Companion", isPrivate: false }, "configuration"],
    [{ id: "repository-id", nameWithOwner: "other/companion", isPrivate: true }, "configuration"],
    [{ id: "repository-id", nameWithOwner: "Example/Companion", isPrivate: "true" }, "unavailable"],
    [null, "unavailable"],
  ] as const) {
    remote.metadata = metadata;
    const count = remote.calls.length;
    await rejects(directory.listReceiptCandidates(first.next), code);
    expect(remote.calls.length - count).toBe(1);
    expect(remote.listings).toHaveLength(1);
  }
});

for (const operation of ["metadata", "listing"])
  for (const phase of ["headers", "body"])
    for (const cancel of [false, true])
      test(`${operation} stalled ${phase}: ${cancel ? "caller abort" : "deadline"} releases resources`, async () => {
        const remote = new DirectoryRemote();
        const reached = deferred<void>();
        const caller = new AbortController();
        const handles: { controller: AbortController; disposed: number }[] = [];
        let stalled: AbortSignal | null | undefined;
        let bodyCancelled = false;
        remote.hook = async (call, next) => {
          const listing = call.body.query?.includes("refs(") === true;
          if (listing !== (operation === "listing")) return next();
          stalled = call.init.signal;
          if (phase === "headers") {
            reached.resolve();
            return new Promise<Response>(() => undefined);
          }
          return new Response(
            new ReadableStream(
              {
                pull(controller) {
                  controller.enqueue(Buffer.from("upstream-sentinel"));
                  reached.resolve();
                  return new Promise<void>(() => undefined);
                },
                cancel() {
                  bodyCancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
          );
        };
        const directory = createControlDirectory(
          remote.deps({
            deadline: (ms) => {
              expect(ms).toBe(30_000);
              const handle = { controller: new AbortController(), disposed: 0 };
              handles.push(handle);
              return { signal: handle.controller.signal, dispose: () => handle.disposed++ };
            },
          }),
        );
        const pending = directory.listReceiptCandidates(undefined, caller.signal);
        await reached.promise;
        expect(handles.at(-1)?.disposed).toBe(0);
        if (cancel) caller.abort();
        else handles.at(-1)?.controller.abort();
        await rejects(pending, cancel ? "aborted" : "unavailable");
        expect(stalled?.aborted).toBe(true);
        expect(bodyCancelled).toBe(phase === "body");
        expect(handles).toHaveLength(remote.calls.length);
        for (const handle of handles) expect(handle.disposed).toBe(1);
      });
