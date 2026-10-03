import { z } from "zod";
import type { FeedPage } from "./core/types.ts";
import type { Store } from "./db/store.ts";

export const MAX_FEED_WAIT_S = 60;
export const FEED_RETENTION_DAYS = 30;

const consumer = z.string().trim().min(1).max(200);
const feedId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const FeedQuerySchema = z.strictObject({
  consumer: consumer.optional(),
  after: feedId.optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  wait: z.number().min(0).max(MAX_FEED_WAIT_S).default(0),
});
export const FeedAckSchema = z.object({ consumer, id: feedId }).strict();
export type FeedQuery = z.output<typeof FeedQuerySchema>;

export function parseFeedParams(params: URLSearchParams): FeedQuery {
  const num = (v: string | null) => (v === null ? undefined : v.trim() ? Number(v) : Number.NaN);
  const [after, limit, wait] = ["after", "limit", "wait"].map((k) => num(params.get(k)));
  return FeedQuerySchema.parse({ consumer: params.get("consumer") ?? undefined, after, limit, wait });
}

/** Returns at once when items exist; otherwise on the first committed item after the cursor, the timeout or abort. */
export function waitForFeed(store: Store, query: FeedQuery, signal?: AbortSignal): Promise<FeedPage> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const wake = () => resolve();
  let cursor = 0;
  // Subscribe before the first read so an item committed in between still ends the wait.
  const off = store.subscribe((msg) => {
    if (msg.kind === "feed" && msg.item.id > cursor) wake();
  });
  const page = store.readFeed(query);
  cursor = page.nextAfter;
  if (page.items.length || query.wait <= 0 || signal?.aborted) {
    off();
    return Promise.resolve(page);
  }
  const timer = setTimeout(wake, query.wait * 1000);
  signal?.addEventListener("abort", wake);
  return promise.then(() => {
    off();
    clearTimeout(timer);
    signal?.removeEventListener("abort", wake);
    return store.readFeed({ after: cursor, limit: query.limit });
  });
}
