import { z } from "zod";
import type { Factory } from "../app.ts";
import { CommentProcessed, IssueClaimed } from "../db/store.ts";
import { redactCredentialData, redactCredentials } from "../util/proc.ts";
import { commentRunRequest, type GhRunner, submitCommentCommand } from "./github.ts";
import { githubIdentity } from "./github-identity.ts";

const date = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const pageSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    node_id: z.string(),
    body: z.string(),
    created_at: date,
    updated_at: date,
    issue_url: z.string(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
  }),
);
const currentSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    rateLimit: z.object({ cost: z.number(), remaining: z.number(), resetAt: date }).optional(),
    node: z
      .object({
        body: z.string(),
        createdAt: date,
        lastEditedAt: date.nullable(),
        userContentEdits: z.object({
          totalCount: z.number(),
          nodes: z.array(z.object({ editor: z.object({ login: z.string() }).nullable() })),
        }),
      })
      .nullable(),
  }),
});
const CURRENT_QUERY = `query($id: ID!) { node(id: $id) { ... on IssueComment { body createdAt lastEditedAt
  userContentEdits(first: 100) { totalCount nodes { editor { login } } } } } rateLimit { cost remaining resetAt } }`;
type QueueFactory = Pick<Factory, "cfg" | "store" | "scheduler" | "createRun">;
type Cached = { key: string; etag: string };

/** A fetched page survives budget pauses; each command is re-read before it runs. */
export async function pollIssueComments(
  factory: QueueFactory,
  repo: string,
  gh: GhRunner,
  signal: AbortSignal,
  now: number,
  budget: { remaining: number },
  cache: Map<string, Cached>,
  log: (s: string) => void,
  identity = githubIdentity,
  observeRate?: (rate: { cost: number; remaining: number; resetAt: string }) => boolean,
) {
  const { store, cfg } = factory;
  const state = store.commentStream(repo, now);
  const boundary = Date.parse(state.initializedAt);
  const posting = await identity(repo);
  const bot = posting.kind === "app" ? posting.botLogin : undefined;
  const exhausted = Symbol();
  const call = (args: string[]) => {
    if (signal.aborted || budget.remaining <= 0) throw exhausted;
    budget.remaining--;
    return gh(["api", ...args], signal, undefined, repo);
  };
  try {
    while (!signal.aborted) {
      let comments = state.pending ? pageSchema.parse(JSON.parse(state.pending)) : null;
      if (!comments) {
        const path = `repos/${repo}/issues/comments?since=${encodeURIComponent(state.since)}&sort=updated&direction=asc&per_page=100&page=${state.page}`;
        const key = `${posting.kind === "app" ? posting.token : "owner"}:${path}`;
        const cached = cache.get(repo)?.key === key ? cache.get(repo) : undefined;
        const raw = String(
          await call([path, "--include", ...(cached ? ["-H", `If-None-Match: ${cached.etag}`] : [])]),
        );
        const split = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
        const end = raw.indexOf(split);
        if (/^HTTP\/\S+ 304\b/.test(raw)) return;
        if (end < 0 || !/^HTTP\/\S+ 200\b/.test(raw)) throw new Error("invalid comment stream response");
        comments = pageSchema.parse(redactCredentialData(JSON.parse(raw.slice(end + split.length))));
        const etag = /^etag:\s*(.+)$/im.exec(raw.slice(0, end))?.[1]?.trim();
        if (etag) cache.set(repo, { key, etag });
        store.saveCommentPage(repo, JSON.stringify(comments));
      }
      for (const comment of comments) {
        if (signal.aborted || factory.scheduler.draining) return;
        const id = { repo, id: comment.id };
        if (store.commentCommand(id)) continue;
        const author = comment.user?.login ?? "";
        const target = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(
          comment.issue_url,
        );
        const issue = { repo, number: Number(target?.[2]), title: "", body: "", author };
        const request = (body: string) =>
          commentRunRequest(issue, body, cfg.githubOwner, cfg.githubQueue?.trusted ?? [], bot);
        const factoryOrOld = (body: string, created: string) =>
          Date.parse(created) < boundary || store.isFactoryComment(repo, comment.id, body, author);
        if (
          factoryOrOld(comment.body, comment.created_at) ||
          comment.user?.type === "Bot" ||
          target?.[1]?.toLowerCase() !== repo.toLowerCase() ||
          !request(comment.body)
        ) {
          store.finishCommentCommand(id, "ignored comment");
          continue;
        }
        // The page may be an old snapshot, so decide on the comment as it is now.
        if (budget.remaining < 2) throw exhausted;
        Object.assign(
          issue,
          z
            .object({
              title: z.string(),
              body: z
                .string()
                .nullable()
                .transform((b) => b ?? ""),
            })
            .parse(JSON.parse(String(await call([`repos/${repo}/issues/${issue.number}`])))),
        );
        const current = currentSchema.safeParse(
          redactCredentialData(
            JSON.parse(
              String(await call(["graphql", "-f", `query=${CURRENT_QUERY}`, "-f", `id=${comment.node_id}`])),
            ),
          ),
        );
        if (current.success && current.data.data.rateLimit && observeRate?.(current.data.data.rateLimit))
          throw exhausted;
        const node = current.success && !current.data.errors?.length ? current.data.data.node : null;
        const edits = node?.userContentEdits;
        const authorOnly =
          !node?.lastEditedAt ||
          (!!edits?.totalCount &&
            edits.totalCount === edits.nodes.length &&
            edits.nodes.every((e) => e.editor?.login.toLowerCase() === author.toLowerCase()));
        const run =
          node && authorOnly && !factoryOrOld(node.body, node.createdAt) ? request(node.body) : null;
        if (signal.aborted) return;
        if (!run) {
          store.finishCommentCommand(id, node ? "ignored comment" : "comment deleted or unreadable");
          continue;
        }
        try {
          await submitCommentCommand(factory, run, id, false, () =>
            signal.aborted || factory.scheduler.draining ? "queue stopped or draining" : null,
          );
        } catch (error) {
          if (!(error instanceof IssueClaimed || error instanceof CommentProcessed)) throw error;
          log(redactCredentials(`Issue comment ${repo}#${issue.number}: ${error.message}`));
        }
      }
      // Anything unseen sorts at or after the last update, even if edits reorder earlier results.
      // Timestamps are whole seconds and can tie, so overlap one second; processed ids absorb repeats.
      // Only a full page inside that second needs a page offset.
      const since = Math.max(
        Date.parse(state.since),
        Date.parse(comments.at(-1)?.updated_at ?? "") - 1000 || 0,
      );
      const full = comments.length === 100;
      const page = full && since === Date.parse(state.since) ? state.page + 1 : 1;
      Object.assign(state, { since: new Date(since).toISOString(), page, pending: null });
      store.advanceCommentStream(repo, state.since, page);
      if (!full) return;
    }
  } catch (error) {
    if (error !== exhausted && !signal.aborted)
      log(redactCredentials(`Issue comments ${repo}: ${String(error)}`));
  }
}
