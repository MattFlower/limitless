import type { FeedAck, FeedPage } from "../core/types.ts";
import { MAX_FEED_WAIT_S } from "../feed.ts";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

const USAGE =
  "usage: limitless feed [--consumer <name>] [--after <id>] [--wait <seconds>] [--json] | feed ack <id> --consumer <name>";

function feedId(value: string | undefined): number {
  const id = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(id)) throw new Error(USAGE);
  return id;
}

/** Long-polls in requests of at most 60 s until a page has items or the total wait ends; never acknowledges. */
export async function pollFeed(
  opts: { consumer?: string; after?: number; waitS: number },
  api: Api,
  now: () => number = Date.now,
): Promise<FeedPage> {
  const deadline = now() + opts.waitS * 1000;
  let after = opts.after;
  let pruned = false;
  for (;;) {
    const wait = Math.min(MAX_FEED_WAIT_S, Math.max(0, deadline - now()) / 1000);
    const query = new URLSearchParams({ wait: String(wait) });
    if (opts.consumer !== undefined) query.set("consumer", opts.consumer);
    if (after !== undefined) query.set("after", String(after));
    const page = await api<FeedPage>(`/api/feed?${query}`);
    pruned ||= page.pruned;
    // Later requests keep the first request's effective cursor.
    after = page.nextAfter;
    if (page.items.length || now() >= deadline) return { ...page, pruned };
  }
}

export async function feedCommand(
  rest: string[],
  values: { consumer?: string; after?: string; wait?: string; json?: boolean },
  deps: { api: Api; print: (line: string) => void; now?: () => number },
): Promise<void> {
  if (rest[0] === "ack") {
    if (rest.length !== 2 || !values.consumer) throw new Error(USAGE);
    const ack = await deps.api<FeedAck>("/api/feed/ack", {
      method: "POST",
      body: JSON.stringify({ consumer: values.consumer, id: feedId(rest[1]) }),
    });
    deps.print(values.json ? JSON.stringify(ack) : `${ack.consumer} acknowledged through ${ack.id}`);
    return;
  }
  const waitS = Number(values.wait ?? 0);
  if (rest.length || values.wait?.trim() === "" || !Number.isFinite(waitS) || waitS < 0)
    throw new Error(USAGE);
  const page = await pollFeed(
    {
      ...(values.consumer === undefined ? {} : { consumer: values.consumer }),
      ...(values.after === undefined ? {} : { after: feedId(values.after) }),
      waitS,
    },
    deps.api,
    deps.now,
  );
  if (values.json) return deps.print(JSON.stringify(page));
  if (page.pruned)
    deps.print("Note: retention pruned items after this cursor before they were acknowledged.");
  for (const item of page.items) deps.print(`#${item.id} ${item.kind}  ${item.title}\n    ${item.summary}`);
  deps.print(page.items.length ? `next after: ${page.nextAfter}` : `No new items (after ${page.nextAfter}).`);
}
