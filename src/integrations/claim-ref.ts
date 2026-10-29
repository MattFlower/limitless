import { randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import type { RunStatus } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { CommandError, redactCredentials } from "../util/proc.ts";
import type { GhRunner } from "./github.ts";

export type ClaimKind = "issue" | "pr" | "run";
export type ClaimRecord = z.infer<typeof fields>;
export type ClaimTip = { sha: string; committedAt: string; record: ClaimRecord | "malformed" };
export type ClaimRead =
  | { kind: "absent" }
  | { kind: "tip"; tip: ClaimTip }
  | { kind: "unconfirmed"; error: string };
export type Anchor = { inclusive: number; exclusive: number };
export type WriteOutcome =
  | { kind: "applied"; tip: ClaimTip; anchor: Anchor | null }
  | { kind: "unchanged"; tip: ClaimTip | null }
  | { kind: "moved"; tip: ClaimTip }
  | { kind: "unconfirmed"; error: string };
export interface ClaimClient {
  read(repo: string, ref: string, signal?: AbortSignal): Promise<ClaimRead>;
  write(
    repo: string,
    ref: string,
    before: ClaimTip | null,
    record: ClaimRecord,
    opts?: { signal?: AbortSignal; beforeSend?: () => boolean; onCommit?: (sha: string) => void },
  ): Promise<WriteOutcome>;
}
const checkpointPattern = /^ckpt1:[0-9a-f]{32}:[0-9a-f]{64}$/;
const fields = z
  .strictObject({
    kind: z.enum(["issue", "pr", "run"]),
    state: z.enum(["held", "released"]),
    generation: z.number().int().nonnegative(),
    number: z.number().int().positive().optional(),
    holder: z.string().regex(/^m-[0-9a-f]{16}$/),
    run: z.string().regex(/^[^\r\n]+$/),
    status: z.enum([
      "queued",
      "waiting",
      "running",
      "waiting_input",
      "succeeded",
      "failed",
      "cancelled",
      "needs_human",
      "resolved",
    ] satisfies RunStatus[]),
    checkpoint: z.string().regex(checkpointPattern).optional(),
  })
  .refine((r) => r.kind === "run" || r.number !== undefined);

export function formatRecord(r: ClaimRecord): string {
  const lines = Object.entries(fields.parse(r)).flatMap(([k, v]) => (v === undefined ? [] : [`${k}: ${v}`]));
  return ["limitless-claim: 1", ...lines].join("\n");
}

export function parseRecord(message: string, ref: string): ClaimRecord | "malformed" {
  try {
    const [header, ...lines] = message.replace(/\n$/, "").split("\n");
    if (header !== "limitless-claim: 1") return "malformed";
    const data: Record<string, unknown> = Object.create(null);
    for (const line of lines) {
      const match = /^([a-z]+): (.+)$/.exec(line);
      if (!match || Object.hasOwn(data, match[1] ?? "")) return "malformed";
      const [, key = "", value = ""] = match;
      data[key] = ["generation", "number"].includes(key) && /^\d+$/.test(value) ? Number(value) : value;
    }
    const r = fields.parse(data);
    const suffix = r.kind === "issue" ? r.number : r.kind === "pr" ? `pr-${r.number}` : `run-${r.run}`;
    return ref === `refs/limitless/claims/${suffix}` ? r : "malformed";
  } catch {
    return "malformed";
  }
}
const oid = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const commitData = z.object({ message: z.string(), committer: z.object({ date: z.iso.datetime() }) });
const mutation =
  "mutation($r:ID!,$u:[RefUpdate!]!){updateRefs(input:{repositoryId:$r,refUpdates:$u}){clientMutationId}}";
const repositoryQuery = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}";
const treeBody = {
  tree: [{ path: "claim", mode: "100644", type: "blob", content: "limitless claim\n" }],
};
const failure = (e: unknown) => ({ kind: "unconfirmed" as const, error: redactCredentials(String(e)) });
const status = (output: string) => /^HTTP\/\S+ (\d{3})(?: .*)?(?:\r?\n|$)/.exec(output)?.[1];

export function createClaimClient(deps: { gh: GhRunner; sample: () => Anchor }): ClaimClient {
  const trees = cache<string>();
  const repositories = cache<string>();
  const commits = cache<z.infer<typeof commitData>>();
  function cache<T>() {
    // Shared requests have no caller signal; only each caller's wait is cancellable.
    const values = new Map<string, Promise<T>>();
    return async (key: string, load: () => Promise<T>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      let pending = values.get(key);
      if (!pending) {
        pending = load().catch((e) => {
          values.delete(key);
          throw e;
        });
        values.set(key, pending);
      }
      return wait(pending, signal);
    };
  }
  async function wait<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
    // Observe the request even if it synchronously aborted the signal.
    const aborted = Promise.withResolvers<never>();
    const listener = signal && addAbortListener(signal, () => aborted.reject(signal.reason));
    try {
      const output = await Promise.race([request, aborted.promise]);
      signal?.throwIfAborted();
      return output;
    } finally {
      listener?.[Symbol.dispose]();
    }
  }
  async function call(repo: string, signal: AbortSignal | undefined, args: string[], body?: unknown) {
    signal?.throwIfAborted();
    const request = deps.gh(args, signal, body === undefined ? undefined : JSON.stringify(body), repo);
    return wait(
      request.then((output) => output ?? ""),
      signal,
    );
  }
  async function api(repo: string, signal: AbortSignal | undefined, path: string, body?: unknown) {
    const args = ["api", `repos/${repo}/${path}`];
    if (body !== undefined) args.push("--method", "POST", "--input", "-");
    return JSON.parse(await call(repo, signal, args, body)) as unknown;
  }
  async function graphql(repo: string, signal: AbortSignal | undefined, query: string, variables: unknown) {
    const output = await call(repo, signal, ["api", "graphql", "--input", "-"], { query, variables });
    const result = JSON.parse(output);
    if (result.errors) throw new Error("GraphQL request failed");
    return result;
  }
  const client: ClaimClient = {
    async read(repo, ref, signal) {
      try {
        const path = `repos/${repo}/git/ref/${ref.replace(/^refs\//, "")}`;
        const output = await call(repo, signal, ["api", path, "--include"]).catch((e: unknown) => {
          signal?.throwIfAborted();
          if (e instanceof CommandError && status(e.stdout) === "404") return e.stdout;
          throw e;
        });
        const code = status(output);
        if (code === "404") return { kind: "absent" };
        if (!code?.startsWith("2")) throw new Error("Unconfirmed ref HTTP status");
        const body = output.replace(/^.*?\r?\n\r?\n/s, "");
        const tipSha = z.object({ object: oid }).parse(JSON.parse(body)).object.sha;
        const raw = await commits(
          tipSha,
          async () => commitData.parse(await api(repo, undefined, `git/commits/${tipSha}`)),
          signal,
        );
        signal?.throwIfAborted();
        return {
          kind: "tip",
          tip: { sha: tipSha, committedAt: raw.committer.date, record: parseRecord(raw.message, ref) },
        };
      } catch (e) {
        signal?.throwIfAborted();
        return failure(e);
      }
    },
    async write(repo, ref, before, requested, opts = {}) {
      const { signal } = opts;
      const unchanged = { kind: "unchanged" as const, tip: before };
      let attempted = false;
      try {
        signal?.throwIfAborted();
        const message = formatRecord(requested);
        const record = parseRecord(message, ref);
        if (record === "malformed") return unchanged;
        const tree = await trees(
          repo,
          async () => oid.parse(await api(repo, undefined, "git/trees", treeBody)).sha,
          signal,
        );
        const id = await repositories(
          repo,
          async () => {
            const [owner, name] = repo.split("/");
            const result = await graphql(repo, undefined, repositoryQuery, { owner, name });
            return z
              .object({ data: z.object({ repository: z.object({ id: z.string().min(1) }) }) })
              .parse(result).data.repository.id;
          },
          signal,
        );
        const author = { name: "limitless", email: "factory@example.invalid" };
        const body = { message, tree, parents: before ? [before.sha] : [], author, committer: author };
        const anchor = deps.sample();
        const result = await api(repo, signal, "git/commits", body);
        const tip = {
          sha: oid.parse(result).sha,
          committedAt: commitData.parse(result).committer.date,
          record,
        };
        opts.onCommit?.(tip.sha);
        signal?.throwIfAborted();
        const allowed = opts.beforeSend?.();
        signal?.throwIfAborted();
        if (allowed === false) return unchanged;
        attempted = true;
        try {
          const response = await graphql(repo, signal, mutation, {
            r: id,
            u: [{ name: ref, beforeOid: before?.sha ?? "0".repeat(40), afterOid: tip.sha, force: false }],
          });
          z.object({
            data: z.object({ updateRefs: z.object({ clientMutationId: z.string().nullable() }) }),
          }).parse(response);
          return { kind: "applied", tip, anchor };
        } catch {
          signal?.throwIfAborted();
        }
        const confirmed = await client.read(repo, ref, signal);
        if (confirmed.kind === "unconfirmed") return confirmed;
        if (confirmed.kind === "absent") return before ? failure("Claim disappeared") : unchanged;
        if (confirmed.tip.sha === before?.sha) return unchanged;
        if (confirmed.tip.sha === tip.sha) return { kind: "applied", tip: confirmed.tip, anchor };
        if (confirmed.tip.record !== "malformed" && formatRecord(confirmed.tip.record) === message)
          return { kind: "applied", tip: confirmed.tip, anchor: null };
        return { kind: "moved", tip: confirmed.tip };
      } catch (e) {
        signal?.throwIfAborted();
        return attempted ? failure(e) : unchanged;
      }
    },
  };
  return client;
}
export function memberId(store: Store): string {
  const existing = store.getSetting<string | null>("member.id", null);
  if (existing !== null) return existing;
  store.db
    .query("INSERT OR IGNORE INTO settings (key, value) VALUES ('member.id', ?)")
    .run(JSON.stringify(`m-${randomBytes(8).toString("hex")}`));
  return z.string().parse(store.getSetting("member.id", null));
}
