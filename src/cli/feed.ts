import type { FeedAck, FeedPage } from "../core/types.ts";
import { MAX_FEED_WAIT_S } from "../feed.ts";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const USAGE =
  "usage: limitless feed [--consumer <name>] [--after <id>] [--wait <seconds>] [--json] | feed ack <id> --consumer <name>";
const feedId = (value = "") => (/^\d+$/.test(value) && Number.isSafeInteger(+value) ? +value : undefined);

/** Long-polls in requests of at most 60 s until a page has items or the total wait ends; never acknowledges. */
export async function pollFeed(
  opts: { consumer?: string; after?: number; waitS: number },
  api: Api,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<FeedPage> {
  const deadline = now() + opts.waitS * 1000;
  let { after } = opts;
  let pruned = false;
  let backoff = 1000;
  for (;;) {
    const wait = Math.min(MAX_FEED_WAIT_S, Math.max(0, deadline - now()) / 1000);
    const query = { wait: String(wait), consumer: opts.consumer, after: after?.toString() };
    const params = Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]]));
    let page: FeedPage;
    try {
      page = await api<FeedPage>(`/api/feed?${new URLSearchParams(params)}`);
      backoff = 1000;
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        (error.status !== 0 && !(error.status >= 500 && error.status < 600)) ||
        opts.waitS === 0
      )
        throw error;
      await sleep(Math.min(backoff, Math.max(0, deadline - now())));
      if (now() >= deadline) return { items: [], nextAfter: after ?? 0, pruned };
      backoff = Math.min(backoff * 2, 15_000);
      continue;
    }
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
  const id = feedId(rest[1] ?? values.after);
  if (rest[0] === "ack") {
    if (rest.length !== 2 || !values.consumer || id === undefined) throw new Error(USAGE);
    const body = JSON.stringify({ consumer: values.consumer, id });
    const ack = await deps.api<FeedAck>("/api/feed/ack", { method: "POST", body });
    return deps.print(values.json ? JSON.stringify(ack) : `${ack.consumer} acknowledged through ${ack.id}`);
  }
  const waitS = Number(values.wait ?? 0);
  if (rest.length || values.wait?.trim() === "" || !(waitS >= 0 && waitS < Infinity)) throw new Error(USAGE);
  if (values.after !== undefined && id === undefined) throw new Error(USAGE);
  const page = await pollFeed({ consumer: values.consumer, after: id, waitS }, deps.api, deps.now);
  if (values.json) return deps.print(JSON.stringify(page));
  if (page.pruned)
    deps.print("Note: retention pruned items after this cursor before they were acknowledged.");
  for (const item of page.items) deps.print(`#${item.id} ${item.kind}  ${item.title}\n    ${item.summary}`);
  deps.print(page.items.length ? `next after: ${page.nextAfter}` : `No new items (after ${page.nextAfter}).`);
}
