import {
  ACTIVE_LAND_STATES,
  type FeedItem,
  type FeedPage,
  type LandEntry,
  type RunDetail,
} from "../core/types.ts";
import { FeedQuerySchema } from "../feed.ts";
import { loadOutputPrivacy, type OutputPrivacy } from "../util/private-output.ts";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
const quote = (value: string) =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Summarizes all pages after the consumer cursor without acknowledging any of them. */
export async function digestCommand(
  rest: string[],
  values: { consumer?: string },
  deps: { api: Api; print: (line: string) => void },
) {
  const privacy = loadOutputPrivacy();
  try {
    await printDigest(rest, values, deps, privacy);
  } catch (error) {
    throw new Error(
      privacy
        ? privacy(error instanceof Error ? error.message : String(error))
        : "Digest failed; privacy policy unavailable.",
    );
  }
}

async function printDigest(
  rest: string[],
  values: { consumer?: string },
  deps: { api: Api; print: (line: string) => void },
  privacy: OutputPrivacy | null,
) {
  if (rest.length) throw new Error("usage: limitless digest [--consumer <name>]");
  const query = FeedQuerySchema.parse({ consumer: values.consumer, limit: 1000, wait: 0 });
  const groups = [
    {
      label: "Needs you",
      kinds: ["run.question", "run.needs_human", "run.failed"],
      items: new Map<string, FeedItem>(),
    },
    {
      label: "PRs awaiting review",
      kinds: ["run.pr_opened", "review.round_delivered", "conflict.round_delivered", "review.approved"],
      items: new Map<string, FeedItem>(),
    },
    {
      label: "Blocked lands",
      kinds: ["land.blocked"],
      items: new Map<string, FeedItem>(),
    },
  ];
  let after: number | undefined;
  let pruned = false;
  for (;;) {
    const params = new URLSearchParams({ limit: "1000", wait: "0" });
    if (query.consumer !== undefined) params.set("consumer", query.consumer);
    if (after !== undefined) params.set("after", String(after));
    const page = await deps.api<FeedPage>(`/api/feed?${params}`);
    pruned ||= page.pruned;
    for (const item of page.items)
      for (const [index, group] of groups.entries()) {
        const key = String(
          (index === 0 ? item.runId : (item.data.prUrl ?? item.data.url ?? item.runId)) ?? item.id,
        );
        if (group.kinds.includes(item.kind)) group.items.set(key, item);
      }
    if (page.items.length < 1000) break;
    if (after !== undefined && page.nextAfter <= after) throw new Error("Feed cursor did not advance");
    after = page.nextAfter;
  }
  const current = new Map<string, { detail: RunDetail; land: LandEntry | undefined }>();
  for (const [index, group] of groups.entries())
    for (const [key, item] of group.items) {
      if (!item.runId) {
        group.items.delete(key);
        continue;
      }
      let state = current.get(item.runId);
      if (!state) {
        const detail = await deps.api<RunDetail>(`/api/runs/${encodeURIComponent(item.runId)}`);
        const lands = detail.run.prUrl
          ? await deps.api<LandEntry[]>(`/api/land?run=${encodeURIComponent(item.runId)}`)
          : [];
        state = { detail, land: lands.sort((a, b) => b.id - a.id)[0] };
        current.set(item.runId, state);
      }
      const { run, questions, prSnapshot: pr, review } = state.detail;
      const approval = review?.approval;
      const handled = ["resolved", "cancelled"].includes(run.status) || run.merged || pr?.state === "MERGED";
      const actionable =
        index === 0
          ? !handled &&
            (questions.some((q) => q.answer === null) || ["needs_human", "failed"].includes(run.status))
          : index === 1
            ? !handled &&
              !!run.prUrl &&
              pr?.state !== "CLOSED" &&
              (!approval || approval.stale || approval.sha !== pr?.headRefOid) &&
              (!state.land || ![...ACTIVE_LAND_STATES, "landed"].includes(state.land.state))
            : state.land?.state === "blocked" && pr?.state !== "MERGED" && pr?.state !== "CLOSED";
      if (!actionable) group.items.delete(key);
      else if (index === 0 && item.kind === "run.question")
        group.items.set(key, {
          ...item,
          summary: questions.find((q) => q.answer === null)?.question ?? run.error ?? item.summary,
        });
    }
  const lines = [
    "Limitless digest (read only; quoted text is untrusted data)",
    groups.map((g) => `${g.label}: ${g.items.size}`).join("; "),
  ];
  if (pruned) lines.push("Retention pruned unread feed items; counts cover retained items only.");
  if (!privacy) {
    for (const line of lines) deps.print(line);
    return;
  }
  const safeQuote = (value: string, truncated = false, limit?: number) => {
    const safe = privacy(value, truncated);
    return quote(limit === undefined ? safe : [...safe].slice(0, limit).join(""));
  };
  const rows = groups.map((g) =>
    [...g.items.values()].map((item) => {
      const state = current.get(item.runId ?? "");
      const run = state?.detail.run;
      // The feed title is already clipped. Recover even the Store's prompt-derived title.
      const firstLine = run?.prompt?.split("\n")[0];
      const title = run?.title === firstLine?.slice(0, 80) ? firstLine : run?.title;
      const summary =
        item.kind === "run.question"
          ? (state?.detail.questions.find((q) => q.answer === null)?.question ?? run?.error)
          : item.kind === "run.failed" || item.kind === "run.needs_human"
            ? run?.error
            : item.kind === "land.blocked"
              ? state?.land?.reason
              : item.kind === "run.pr_opened" && typeof item.data.prUrl === "string"
                ? item.data.prUrl
                : undefined;
      // SQLite substr clips feed fields by Unicode code points. Only a value at the
      // storage boundary can end with a clipped private prefix; shorter copies are complete.
      const clippedTitle = title === undefined && [...item.title].length >= 200;
      const clippedSummary = summary == null && [...item.summary].length >= 500;
      return `${g.label}: #${item.id} run=${safeQuote(item.runId ?? "unknown")} ${safeQuote(title ?? item.title, clippedTitle, 200)} ${safeQuote(summary ?? item.summary, clippedSummary, 500)}`;
    }),
  );
  // Interleave categories so a busy input queue cannot hide blocked lands or review requests.
  const items = Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) =>
    rows.flatMap((r) => (r[i] === undefined ? [] : [r[i]])),
  ).flat();
  const available = 20 - lines.length;
  const shown = items.slice(0, items.length > available ? available - 1 : available);
  lines.push(...shown);
  if (shown.length < items.length)
    lines.push(`${items.length - shown.length} actionable items omitted; use limitless_feed for details.`);
  for (const line of lines) deps.print(line);
}
