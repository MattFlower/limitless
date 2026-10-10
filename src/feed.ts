import { z } from "zod";
import type { FeedItem, FeedPage } from "./core/types.ts";
import type { Store } from "./db/store.ts";

export const MAX_FEED_WAIT_S = 60;
export const FEED_RETENTION_DAYS = 30;
export const MAX_FEED_ITEMS = 100;
export const MAX_FEED_BYTES = 16 * 1024;

const consumer = z.string().trim().min(1).max(200);
const feedId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const FeedQuerySchema = z.strictObject({
  consumer: consumer.optional(),
  after: feedId.optional(),
  from: z.literal("now").optional(),
  repo: z.string().min(1).optional(),
  ownRuns: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  wait: z.number().min(0).max(MAX_FEED_WAIT_S).default(0),
});
export function validateFeedQuery(query: {
  from?: "now";
  after?: number;
  ownRuns?: boolean;
  consumer?: string;
}): void {
  if (query.from !== undefined && query.after !== undefined)
    throw new Error("from and after cannot be combined");
  if (query.ownRuns && query.consumer === undefined) throw new Error("ownRuns requires consumer");
}
export const FeedAckSchema = z.object({ consumer, id: feedId }).strict();
export type FeedQuery = z.output<typeof FeedQuerySchema>;

export function parseFeedParams(params: URLSearchParams): FeedQuery {
  const num = (v: string | null) => (v === null ? undefined : v.trim() ? Number(v) : Number.NaN);
  const [after, limit, wait] = ["after", "limit", "wait"].map((k) => num(params.get(k)));
  const query = FeedQuerySchema.parse({
    consumer: params.get("consumer") ?? undefined,
    from: params.get("from") ?? undefined,
    repo: params.get("repo") ?? undefined,
    ownRuns: params.has("ownRuns")
      ? z.stringbool({ truthy: ["true"], falsy: ["false"] }).parse(params.get("ownRuns"))
      : undefined,
    after,
    limit,
    wait,
  });
  validateFeedQuery(query);
  return query;
}

/** Count the entire UTF-8 JSON page, reserving the largest possible cursor and boolean fields. */
export function limitFeedPage(page: FeedPage, limit = MAX_FEED_ITEMS): FeedPage {
  const items: FeedItem[] = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({ items: [], nextAfter: Number.MAX_SAFE_INTEGER, pruned: false, hasMore: false }),
  );
  let hasMore = page.hasMore ?? false;
  for (let item of page.items) {
    let size = Buffer.byteLength(JSON.stringify(item));
    if (
      items.length >= Math.min(limit, MAX_FEED_ITEMS) ||
      (items.length && bytes + size + 1 > MAX_FEED_BYTES)
    ) {
      hasMore = true;
      break;
    }
    if (bytes + size > MAX_FEED_BYTES) {
      item = {
        id: item.id,
        ts: item.ts,
        kind: item.kind,
        runId: item.runId,
        evalId: item.evalId,
        repo: item.repo,
        title: "Truncated feed item",
        summary: "Item exceeds the feed page budget; inspect its run for details.",
        data: {},
        truncated: true,
      };
      size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > MAX_FEED_BYTES) {
        item.repo = null;
        size = Buffer.byteLength(JSON.stringify(item));
      }
    }
    bytes += size + (items.length ? 1 : 0);
    items.push(item);
  }
  return { items, nextAfter: items.at(-1)?.id ?? page.nextAfter, pruned: page.pruned, hasMore };
}

/** Returns at once when items exist; otherwise on the first committed item after the cursor, the timeout or abort. */
export function waitForFeed(store: Store, query: FeedQuery, signal?: AbortSignal): Promise<FeedPage> {
  validateFeedQuery(query);
  const { promise, resolve } = Promise.withResolvers<void>();
  const wake = () => resolve();
  let cursor = 0;
  // Subscribe before the first read so an item committed in between still ends the wait.
  const off = store.subscribe((msg) => {
    if (msg.kind !== "feed" || msg.item.id <= cursor) return;
    if (query.repo !== undefined && msg.item.repo !== query.repo) return;
    if (query.ownRuns) {
      const run = msg.item.runId === null ? null : store.getRun(msg.item.runId);
      if (run?.source !== "mcp" || run.requestedBy !== query.consumer) return;
    }
    wake();
  });
  const page = store.readFeed(query);
  cursor = page.nextAfter;
  if (query.from === "now" || page.items.length || query.wait <= 0 || signal?.aborted) {
    off();
    return Promise.resolve(page);
  }
  const timer = setTimeout(wake, query.wait * 1000);
  signal?.addEventListener("abort", wake);
  return promise.then(() => {
    off();
    clearTimeout(timer);
    signal?.removeEventListener("abort", wake);
    return store.readFeed({ ...query, from: undefined, after: cursor });
  });
}
