import { afterEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import { createSharedStore, type SharedStoreDeps } from "../src/integrations/shared-store.ts";

const runId = "abc123";
const otherRun = "def456";
const role = "manifest";
const keyA = "0123456789abcdef".repeat(2);
const keyB = "fedcba9876543210".repeat(2);
const keyC = "00112233445566778899aabbccddeeff";
const zeros = "0".repeat(40);
const dataKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const token = ["companion", "credential", "for", "offline", "test"].join("-");
const synthetic = { name: "limitless", email: "factory@example.invalid" };
const base = "https://api.github.com/repos/example/companion/";
const graphqlUrl = "https://api.github.com/graphql";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = <T>() => Promise.withResolvers<T>();
const never = () => new Promise<Response>(() => undefined);
const ref = (run: string) => `refs/limitless/store/${run}`;

type Entry = { path: string; mode: string; type: string; sha: string };
type Update = { name: string; beforeOid: string; afterOid: string; force: boolean };
type Body = {
  query?: string;
  variables?: { r?: string; u?: Update[] };
  content?: string;
  encoding?: string;
  base_tree?: string;
  tree?: string | Entry[];
  message?: string;
  parents?: string[];
  author?: unknown;
  committer?: unknown;
};
type Call = { url: string; method: string; init: RequestInit; body: Body };
type Hook = (call: Call, next: () => Promise<Response>) => Promise<Response>;

const isMeta = (c: Call) => c.body.query?.startsWith("query(") === true;
const isCas = (c: Call) => c.body.query?.startsWith("mutation(") === true;
const isPost = (path: string) => (c: Call) => c.method === "POST" && c.url === base + path;
const isRead = (path: string) => (c: Call) => c.method === "GET" && c.url.startsWith(base + path);
const writes = (calls: Call[]) =>
  calls.filter((c) => isCas(c) || (c.method !== "GET" && c.url !== graphqlUrl));
const entry = (path: string, sha: string): Entry => ({ path, mode: "100644", type: "blob", sha });
const notFound = () => json({ message: "Not Found" }, 404);
function wrap(content: string) {
  // GitHub returns blob content as base64 wrapped at 60 columns.
  const lines: string[] = [];
  for (let i = 0; i < content.length; i += 60) lines.push(content.slice(i, i + 60));
  return `${lines.join("\n")}\n`;
}

const remotes: Remote[] = [];
afterEach(() => {
  for (const remote of remotes.splice(0)) expect(remote.unexpected).toEqual([]);
});

// Offline GitHub: immutable content-addressed objects, exact CAS with fast-forward enforcement.
class Remote {
  calls: Call[] = [];
  unexpected: string[] = [];
  blobs = new Map<string, string>();
  trees = new Map<string, Entry[]>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  refs = new Map<string, string>();
  metadata: unknown = { id: "repository-id", nameWithOwner: "Example/Companion", isPrivate: true };
  unconditional = false;
  hook?: Hook;
  private clock = 0;
  constructor() {
    remotes.push(this);
  }
  request = async (url: string, init: RequestInit): Promise<Response> => {
    const body: Body = init.body === undefined ? {} : JSON.parse(String(init.body));
    const call = { url, method: String(init.method), init, body };
    this.calls.push(call);
    const next = async () => this.handle(call);
    return this.hook ? this.hook(call, next) : next();
  };
  client(overrides: Partial<SharedStoreDeps> = {}) {
    return createSharedStore({
      repo: "Example/Companion",
      token,
      dataKey,
      request: this.request,
      ...overrides,
    });
  }
  oid(kind: string, content: string) {
    return createHash("sha1").update(`${kind}\0${content}`).digest("hex");
  }
  blob(content: string) {
    const sha = this.oid("blob", content);
    this.blobs.set(sha, content);
    return sha;
  }
  tree(entries: Entry[]) {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    const sha = this.oid("tree", JSON.stringify(sorted));
    this.trees.set(sha, sorted);
    return sha;
  }
  commit(tree: string, parents: string[], message: string) {
    // GitHub stamps each commit, so equal content still yields a new commit.
    const sha = this.oid("commit", JSON.stringify([tree, parents, message, ++this.clock]));
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
  plant(run: string, root: Entry[], message = "limitless-store: 1") {
    const parent = this.refs.get(ref(run));
    const sha = this.commit(this.tree(root), parent ? [parent] : [], message);
    this.refs.set(ref(run), sha);
    return sha;
  }
  store(run: string, objects: Entry[], message?: string) {
    return this.plant(
      run,
      [{ path: "objects", mode: "040000", type: "tree", sha: this.tree(objects) }],
      message,
    );
  }
  retained(run: string) {
    const root = this.trees.get(this.commits.get(this.refs.get(ref(run)) ?? "")?.tree ?? "") ?? [];
    const objects = this.trees.get(root.find((e) => e.path === "objects")?.sha ?? "") ?? [];
    return new Map(objects.map((e) => [e.path, e.sha]));
  }
  // Another client appends an object to the run.
  append(run: string, key: string) {
    const entries = [...this.retained(run)].map(([path, sha]) => entry(path, sha));
    return this.store(run, [...entries, entry(key, this.blob(Buffer.from(key).toString("base64")))]);
  }
  insert(entries: Entry[], [head = "", ...rest]: string[], leaf: Omit<Entry, "path">): string {
    const others = entries.filter((e) => e.path !== head);
    if (rest.length === 0) return this.tree([...others, { path: head, ...leaf }]);
    const existing = entries.find((e) => e.path === head && e.type === "tree");
    const sub = this.insert(this.trees.get(existing?.sha ?? "") ?? [], rest, leaf);
    return this.tree([...others, { path: head, mode: "040000", type: "tree", sha: sub }]);
  }
  descends(commit: string, ancestor: string): boolean {
    if (ancestor === zeros || commit === ancestor) return true;
    return (this.commits.get(commit)?.parents ?? []).some((p) => this.descends(p, ancestor));
  }
  updateRefs({ variables }: Body): Response {
    const update = variables?.u?.[0];
    if (variables?.r !== "repository-id" || variables.u?.length !== 1 || !update || update.force !== false) {
      this.unexpected.push("updateRefs input");
      return json({ errors: [{ message: "invalid" }] });
    }
    const current = this.refs.get(update.name) ?? zeros;
    const conditional = current === update.beforeOid && this.descends(update.afterOid, current);
    if (!this.commits.has(update.afterOid) || (!this.unconditional && !conditional))
      return json({ data: { updateRefs: null }, errors: [{ message: "Reference update failed" }] });
    this.refs.set(update.name, update.afterOid);
    return json({ data: { updateRefs: { clientMutationId: null } } });
  }
  handle({ url, method, body }: Call): Response {
    if (url === graphqlUrl && method === "POST" && body.query?.startsWith("query("))
      return json({ data: { repository: this.metadata } });
    if (url === graphqlUrl && method === "POST" && body.query?.startsWith("mutation("))
      return this.updateRefs(body);
    const path = url.startsWith(base) ? url.slice(base.length) : "";
    const id = (pattern: RegExp) => pattern.exec(path)?.[1];
    const named = id(/^git\/ref\/((?:limitless\/store\/[0-9a-z]+|control\/[a-z-]+\/[0-9a-f]{64}))$/);
    const commit = id(/^git\/commits\/([0-9a-f]{40})$/);
    const tree = id(/^git\/trees\/([0-9a-f]{40})$/);
    const blob = id(/^git\/blobs\/([0-9a-f]{40})$/);
    if (method === "GET" && named !== undefined) {
      const sha = this.refs.get(`refs/${named}`);
      return sha ? json({ ref: `refs/${named}`, object: { sha, type: "commit" } }) : notFound();
    }
    if (method === "GET" && commit !== undefined) {
      const c = this.commits.get(commit);
      if (!c) return notFound();
      const parents = c.parents.map((sha) => ({ sha }));
      return json({ sha: commit, message: c.message, tree: { sha: c.tree }, parents });
    }
    if (method === "GET" && tree !== undefined) {
      const entries = this.trees.get(tree);
      return entries ? json({ sha: tree, truncated: false, tree: entries }) : notFound();
    }
    if (method === "GET" && blob !== undefined) {
      const content = this.blobs.get(blob);
      return content === undefined
        ? notFound()
        : json({ sha: blob, encoding: "base64", content: wrap(content) });
    }
    if (method === "POST" && path === "git/blobs" && body.encoding === "base64" && body.content !== undefined)
      return json({ sha: this.blob(body.content) }, 201);
    if (method === "POST" && path === "git/trees" && Array.isArray(body.tree)) {
      let entries = body.base_tree === undefined ? [] : this.trees.get(body.base_tree);
      let sha = "";
      for (const { path: name, ...leaf } of body.tree) {
        if (!entries || !this.blobs.has(leaf.sha)) return json({ message: "Invalid tree" }, 422);
        sha = this.insert(entries, name.split("/"), leaf);
        entries = this.trees.get(sha);
      }
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "git/commits" && typeof body.tree === "string") {
      const parents = body.parents ?? [];
      if (!this.trees.has(body.tree) || !parents.every((p) => this.commits.has(p)) || !body.message)
        return json({ message: "Invalid commit" }, 422);
      return json({ sha: this.commit(body.tree, parents, body.message) }, 201);
    }
    this.unexpected.push(`${method} ${url}`);
    return json({ message: "Unexpected" }, 500);
  }
}

export {
  type Body,
  base,
  bytesOf,
  type Call,
  dataKey,
  deferred,
  type Entry,
  entry,
  graphqlUrl,
  type Hook,
  hash,
  isCas,
  isMeta,
  isPost,
  isRead,
  json,
  keyA,
  keyB,
  keyC,
  never,
  notFound,
  otherRun,
  Remote,
  ref,
  role,
  runId,
  synthetic,
  token,
  type Update,
  writes,
  zeros,
};
