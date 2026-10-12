import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedItem, StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";

/** A real SQLite store in a temporary directory, with one local repository. */
export function feedStore() {
  const dir = mkdtempSync(join(tmpdir(), "limitless-feed-"));
  const path = join(dir, "db.sqlite");
  const ctx = {
    dir,
    path,
    store: new Store(path),
    reopen() {
      ctx.store.close();
      ctx.store = new Store(path);
      return ctx.store;
    },
    repo() {
      return (
        ctx.store.getRepoBySlug("local/feed") ??
        ctx.store.upsertRepo({
          slug: "local/feed",
          kind: "local",
          url: null,
          localPath: dir,
          defaultBranch: "main",
          mergePolicy: "none",
        })
      );
    },
    run(title = "work", dependsOn?: string[]) {
      return ctx.store.createRun(ctx.repo(), { repo: "local/feed", prompt: title, title, dependsOn });
    },
    /** Feed items published to subscribers, in order. */
    published() {
      const items: FeedItem[] = [];
      const off = ctx.store.subscribe((msg: StreamMessage) => {
        if (msg.kind === "feed") items.push(msg.item);
      });
      return { items, off };
    },
    close() {
      ctx.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ctx;
}

export function allItems(store: Store): FeedItem[] {
  const items: FeedItem[] = [];
  let after = 0;
  for (;;) {
    const page = store.readFeed({ after });
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (page.nextAfter <= after) throw new Error("Feed cursor did not advance");
    after = page.nextAfter;
  }
}
