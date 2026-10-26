import { z } from "zod";
import type { Factory } from "../app.ts";
import { CommentProcessed, IssueClaimed } from "../db/store.ts";
import { redactCredentialData, redactCredentials } from "../util/proc.ts";
import { commentRunRequest, type GhRunner, submitCommentCommand } from "./github.ts";
import { githubIdentity } from "./github-identity.ts";

const date = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const commentSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string(),
  body: z.string(),
  created_at: date,
  updated_at: date,
  issue_url: z.string(),
  user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
});
const pageSchema = z.object({
  comments: z.array(commentSchema),
  etag: z.string().optional(),
  checked: z.array(z.number()).default([]),
});
type QueueFactory = Pick<Factory, "cfg" | "store" | "scheduler" | "createRun">;
type Cached = { key: string; etag: string };

/** Fixed-since pages survive budget pauses. Only fully handled pages advance the durable stream. */
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
  const posting = await identity(repo);
  const bot = posting.kind === "app" ? posting.botLogin : undefined;
  const exhausted = Symbol();
  const call = (args: string[]) => {
    if (signal.aborted || budget.remaining <= 0) throw exhausted;
    budget.remaining--;
    return gh(["api", ...args], signal, undefined, repo);
  };
  try {
    while (!signal.aborted && (budget.remaining > 0 || state.pending)) {
      const path = `repos/${repo}/issues/comments?since=${encodeURIComponent(state.since)}&sort=updated&direction=asc&per_page=100&page=${state.page}`;
      const key = `${posting.kind === "app" ? posting.token : "owner"}:${path}`;
      const previous = cache.get(repo);
      const cached = previous?.key === key ? previous : undefined;
      const fromPending = !!state.pending;
      let page = state.pending ? pageSchema.parse(JSON.parse(state.pending)) : null;
      const save = () => {
        state.pending = JSON.stringify(page);
        store.saveCommentPage(repo, state.pending);
      };
      if (!page) {
        const raw = String(
          await call([path, "--include", ...(cached ? ["-H", `If-None-Match: ${cached.etag}`] : [])]),
        );
        const split = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
        const boundary = raw.indexOf(split);
        if (/^HTTP\/\S+ 304\b/.test(raw)) return;
        if (boundary < 0 || !/^HTTP\/\S+ 200\b/.test(raw)) throw new Error("invalid comment stream response");
        page = pageSchema.parse(
          redactCredentialData({
            comments: JSON.parse(raw.slice(boundary + split.length)),
            etag: /^etag:\s*(.+)$/im.exec(raw.slice(0, boundary))?.[1]?.trim(),
          }),
        );
        save();
      }
      const { comments, etag } = page;
      for (const comment of comments) {
        if (signal.aborted || factory.scheduler.draining) return;
        const identity = { repo, id: comment.id };
        if (store.commentCommand(identity)) continue;
        const author = comment.user?.login ?? "";
        const target = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(
          comment.issue_url,
        );
        const request = commentRunRequest(
          { repo, number: Number(target?.[2]), title: "", body: "", author },
          comment.body,
          cfg.githubOwner,
          cfg.githubQueue?.trusted ?? [],
          bot,
        );
        let ignored =
          Date.parse(comment.created_at) < Date.parse(state.initializedAt) ||
          Date.parse(comment.updated_at) < Date.parse(comment.created_at) ||
          !request ||
          comment.user?.type === "Bot" ||
          target?.[1]?.toLowerCase() !== repo.toLowerCase() ||
          store.isFactoryComment(repo, comment.id, comment.body, author);
        if (
          !ignored &&
          Date.parse(comment.updated_at) !== Date.parse(comment.created_at) &&
          !page.checked.includes(comment.id)
        ) {
          const evidence = JSON.parse(
            String(
              await call([
                "graphql",
                "-f",
                `query=query { node(id:${JSON.stringify(comment.node_id)}) { ... on IssueComment { userContentEdits(first:100) { totalCount nodes { editor { login } } } } } rateLimit { cost remaining resetAt } }`,
              ]),
            ),
          );
          const edits = z
            .object({
              errors: z.array(z.unknown()).optional(),
              data: z.object({
                rateLimit: z.object({ cost: z.number(), remaining: z.number(), resetAt: date }).optional(),
                node: z
                  .object({
                    userContentEdits: z.object({
                      totalCount: z.number(),
                      nodes: z.array(z.object({ editor: z.object({ login: z.string() }).nullable() })),
                    }),
                  })
                  .nullable(),
              }),
            })
            .safeParse(evidence);
          if (edits.success && edits.data.data.rateLimit && observeRate?.(edits.data.data.rateLimit))
            throw exhausted;
          const history =
            edits.success && !edits.data.errors?.length ? edits.data.data.node?.userContentEdits : null;
          ignored =
            !history?.totalCount ||
            history.totalCount !== history.nodes.length ||
            history.nodes.some((e) => e.editor?.login.toLowerCase() !== author.toLowerCase());
          if (!ignored) {
            page.checked.push(comment.id);
            save();
          }
        }
        if (ignored) store.finishCommentCommand(identity, "ignored comment");
        else {
          const issue = z
            .object({ title: z.string(), body: z.string().nullable() })
            .parse(JSON.parse(String(await call([`repos/${repo}/issues/${target?.[2]}`]))));
          if (signal.aborted) return;
          const request = commentRunRequest(
            { repo, number: Number(target?.[2]), title: issue.title, body: issue.body ?? "", author },
            comment.body,
            cfg.githubOwner,
            cfg.githubQueue?.trusted ?? [],
            bot,
          );
          if (!request) throw new Error("command changed during processing");
          try {
            await submitCommentCommand(factory, request, identity, false, () =>
              signal.aborted || factory.scheduler.draining ? "queue stopped or draining" : null,
            );
          } catch (error) {
            if (!(error instanceof IssueClaimed || error instanceof CommentProcessed)) throw error;
            log(redactCredentials(`Issue comment ${repo}#${target?.[2]}: ${error.message}`));
          }
        }
      }
      const high = new Date(
        Math.max(Date.parse(state.high), ...comments.map((c) => Date.parse(c.updated_at))),
      ).toISOString();
      const more = comments.length === 100;
      // Retain a one-second overlap: GitHub's since is exclusive and timestamps can tie.
      const since = more
        ? state.since
        : new Date(Math.max(Date.parse(state.initializedAt) - 1000, Date.parse(high) - 1000)).toISOString();
      store.advanceCommentStream(repo, since, more ? state.page + 1 : 1, high);
      if (etag && !fromPending) {
        cache.set(repo, { key, etag });
      }
      if (!more) return;
      Object.assign(state, { high, page: state.page + 1, pending: null });
    }
  } catch (error) {
    if (error !== exhausted && !signal.aborted)
      log(redactCredentials(`Issue comments ${repo}: ${String(error)}`));
  }
}
