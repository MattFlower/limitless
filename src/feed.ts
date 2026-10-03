import { z } from "zod";
import type { FeedPage } from "./core/types.ts";
import type { Store } from "./db/store.ts";

export const MAX_FEED_WAIT_S = 60;
export const FEED_RETENTION_DAYS = 30;

const consumer = z.string().trim().min(1).max(200);
const feedId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const FeedQuerySchema = z
  .object({
    consumer: consumer.optional(),
    after: feedId.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    wait: z.number().min(0).max(MAX_FEED_WAIT_S).default(0),
  })
  .strict();
export const FeedAckSchema = z.object({ consumer, id: feedId }).strict();
export type FeedQuery = z.output<typeof FeedQuerySchema>;

export function parseFeedParams(params: URLSearchParams): FeedQuery {
  const num = (name: string) => {
    const value = params.get(name);
    return value === null ? undefined : value.trim() ? Number(value) : Number.NaN;
  };
  return FeedQuerySchema.parse({
    consumer: params.get("consumer") ?? undefined,
    after: num("after"),
    limit: num("limit"),
    wait: num("wait"),
  });
}

/** Returns at once when items exist; otherwise on the first committed item after the cursor or at the timeout. */
export function waitForFeed(store: Store, query: FeedQuery, signal?: AbortSignal): Promise<FeedPage> {
  let cursor = 0;
  let woke = false;
  let wake = (): void => {
    woke = true;
  };
  // Subscribe before the first read so an item committed in between still wakes the wait.
  const off = store.subscribe((msg) => {
    if (msg.kind === "feed" && msg.item.id > cursor) wake();
  });
  const page = store.readFeed(query);
  cursor = page.nextAfter;
  if (page.items.length || query.wait <= 0 || signal?.aborted) {
    off();
    return Promise.resolve(page);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => wake(), query.wait * 1000);
    wake = () => {
      off();
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      wake = () => undefined;
      resolve(store.readFeed({ after: cursor, limit: query.limit }));
    };
    signal?.addEventListener("abort", wake, { once: true });
    if (woke) wake();
  });
}
