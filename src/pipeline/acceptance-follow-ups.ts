import { z } from "zod";
import type { AcceptancePass } from "../db/store.ts";
import { loadPrivateStrings } from "../gates/private.ts";
import { checkPublicationText, publicationWorktree, sanitizePublication } from "../gates/publication.ts";
import { runGh } from "../integrations/github.ts";
import { githubIdentity } from "../integrations/github-identity.ts";
import { lifecycleManaged } from "../integrations/issue-lifecycle.ts";
import { redactCredentials, registeredCredentials } from "../util/proc.ts";
import {
  type AcceptanceSnapshot,
  type AcceptanceState,
  type AcceptanceUnit,
  resolveIntent,
} from "./acceptance.ts";
import { CancelledError, NeedsHumanError, type RunContext } from "./context.ts";
import { InjectedFault, SimulatedTermination } from "./faults.ts";

const GAPS = ["partly_met", "unmet", "regressed"];
const MAX_PASSES = 2;
const NEEDS_YOU = "limitless:needs-you";
const LIMIT_MARKER = "<!-- limitless-acceptance-limit -->";
export const followUpMarker = (ticket: number, pass: number, item: string) =>
  `<!-- limitless-acceptance:${ticket}:${pass}:${item} -->`;
const firstLine = (body: string) => body.split(/\r?\n/)[0];
const issueList = (record: AcceptancePass) => record.items.flatMap((h) => (h.issue ? [h.issue] : []));

/** Group by top-level item, confirming legacy ancestry against the persisted snapshot. */
export function groupAcceptanceUnits(
  manifest: AcceptanceUnit[],
  snapshot: AcceptanceSnapshot,
): Map<string, AcceptanceUnit[]> {
  if (manifest.some((u) => !u.item)) {
    try {
      const resolved = resolveIntent(snapshot);
      if (
        resolved.length !== manifest.length ||
        resolved.some((u, i) => u.id !== manifest[i]?.id || u.text !== manifest[i]?.text)
      )
        throw new Error("manifest mismatch");
      manifest = manifest.map((u, i) => ({ ...u, item: resolved[i]?.item }));
    } catch {
      throw new NeedsHumanError(
        "Follow-ups were not filed because the persisted manifest's top-level items could not be confirmed from the snapshot",
      );
    }
  }
  const groups = new Map<string, AcceptanceUnit[]>();
  for (const unit of manifest) {
    if (!unit.item) throw new Error("Missing top-level item");
    groups.set(unit.item, [...(groups.get(unit.item) ?? []), unit]);
  }
  return groups;
}

/** Quote untrusted text as data: no run inside it can close the fence, and no line starts at column 0. */
const fenced = (text: string) => {
  const fence = "`".repeat(Math.max(2, ...(text.match(/`+|~+/g) ?? []).map((run) => run.length)) + 1);
  return [`${fence}text`, ...text.split(/\r\n?|\n/), fence].map((line) => `> ${line}`).join("\n");
};

const Author = z.object({ __typename: z.string().optional(), login: z.string() }).nullable();
const Listing = z.object({
  data: z.object({
    repository: z.object({
      id: z.string(),
      epic: z.object({
        id: z.string(),
        subIssues: z.object({
          nodes: z.array(z.object({ id: z.string(), number: z.number(), body: z.string(), author: Author })),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
      ticket: z.object({
        id: z.string(),
        blockedBy: z.object({ nodes: z.array(z.object({ number: z.number() })) }),
      }),
    }),
  }),
});
const CREATE = `mutation($repo:ID!, $parent:ID!, $title:String!, $body:String!) {
  createIssue(input:{repositoryId:$repo, parentIssueId:$parent, title:$title, body:$body}) { issue { id number } } }`;
const Created = z.object({
  data: z.object({ createIssue: z.object({ issue: z.object({ id: z.string(), number: z.number() }) }) }),
});
const BLOCK = `mutation($issue:ID!, $blocker:ID!) {
  addBlockedBy(input:{issueId:$issue, blockingIssueId:$blocker}) { issue { number } } }`;

/** Redacted, publication-checked copy of a factory body, or null when it must not be posted. */
function publishable(ctx: RunContext, text: string): string | null {
  const { paths } = ctx.deps.cfg;
  const roots = [...publicationWorktree(ctx.state), ctx.repo.localPath ?? ""];
  const entries = [
    ...registeredCredentials().map((value) => ({ value, entry: 0 })),
    ...loadPrivateStrings(paths.configDir, [...roots, paths.repos, paths.work]),
  ];
  const checked = sanitizePublication(redactCredentials(text), roots, paths.home);
  try {
    checkPublicationText(checked, "", entries);
  } catch {
    return null;
  }
  return firstLine(checked) === firstLine(text) ? checked : null;
}

/** A GitHub failure ends the run for a human with `reason`; interruptions keep their own handling. */
async function guarded<T>(ctx: RunContext, reason: (failure: string) => string, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    const interrupted = [NeedsHumanError, CancelledError, SimulatedTermination, InjectedFault].some(
      (type) => err instanceof type,
    );
    if (interrupted || ctx.signal.aborted || ctx.termination) throw err;
    throw new NeedsHumanError(
      reason(`GitHub failed: ${redactCredentials(err instanceof Error ? err.message : String(err))}`),
    );
  }
}

/**
 * File one follow-up sub-issue per top-level item with a gap, at most once per durable handle,
 * or label the epic once it has used its passes. Undefined when there is nothing to file.
 */
export async function fileFollowUps(
  ctx: RunContext,
  acceptance: AcceptanceState,
): Promise<{ pass?: number; issues: number[]; limit?: boolean } | undefined> {
  const { outcome, manifest = [] } = acceptance;
  const repo = ctx.repo.slug;
  const gaps = new Map(outcome?.units.filter((u) => GAPS.includes(u.verdict)).map((u) => [u.unit, u]));
  if (!outcome || !gaps.size || !lifecycleManaged(ctx.deps.cfg, repo)) return undefined;
  const [epic, ticket] = [acceptance.snapshot.parent.number, acceptance.snapshot.ticket.number];
  const gh = ctx.deps.gh ?? runGh;
  const api = async (args: string[]) => {
    ctx.checkCancelled();
    return JSON.parse(String(await gh(["api", ...args], ctx.signal, undefined, repo))) as unknown;
  };
  const login = async (graphql = false) => {
    const identity = await githubIdentity(repo);
    const name =
      identity.kind === "app"
        ? identity.botLogin
        : z.object({ login: z.string() }).parse(await api(["user"])).login;
    return (author: z.infer<typeof Author>) =>
      identity.kind === "app" && graphql
        ? author?.__typename === "Bot" &&
          author.login.toLowerCase() === name.replace(/\[bot\]$/i, "").toLowerCase()
        : author?.login.toLowerCase() === name.toLowerCase();
  };
  const groups = [...groupAcceptanceUnits(manifest, acceptance.snapshot)].filter(([, units]) =>
    units.some((u) => gaps.has(u.id)),
  );
  const items = groups.map(([item]) => ({ item, state: "pending" as const }));
  const claimed = ctx.store.claimAcceptancePass(
    { repo, epic, ticket, runId: ctx.run.id, sha: outcome.sha, items },
    MAX_PASSES,
  );
  if (!claimed) {
    const limited = `Acceptance: ${outcome.summary}; pass limit reached for #${epic}`;
    return guarded(
      ctx,
      (failure) => `${limited}; ${failure}`,
      async () => {
        const labels = z
          .array(z.object({ name: z.string() }))
          .parse(await api([`repos/${repo}/issues/${epic}/labels`]));
        if (!labels.some((l) => l.name === NEEDS_YOU))
          await api([`repos/${repo}/issues/${epic}/labels`, "-X", "POST", "-f", `labels[]=${NEEDS_YOU}`]);
        const link = `${ctx.deps.cfg.uiUrl}/runs/${ctx.run.id}`;
        const body = publishable(
          ctx,
          `${LIMIT_MARKER}\nLimitless: acceptance ticket #${ticket} still has gaps after ${MAX_PASSES} follow-up passes, so no more follow-ups are filed. See ${link}.`,
        );
        if (!body) throw new NeedsHumanError(`${limited}; the pass-limit comment was withheld`);
        const factory = await login();
        let posted = false;
        for (let page = 1; !posted; page++) {
          const comments = z
            .array(z.object({ body: z.string(), user: Author }))
            .parse(await api([`repos/${repo}/issues/${epic}/comments?per_page=100&page=${page}`]));
          posted = comments.some((c) => factory(c.user) && firstLine(c.body) === LIMIT_MARKER);
          if (comments.length < 100) break;
        }
        const comment = posted ? "done" : ctx.store.claimAcceptanceLimit(repo, epic, ctx.run.id);
        if (!posted && comment === "claimed") {
          await api([`repos/${repo}/issues/${epic}/comments`, "-X", "POST", "-f", `body=${body}`]);
          posted = true;
        }
        if (posted) ctx.store.finishAcceptanceLimit(repo, epic, ctx.run.id);
        else if (comment === "requested")
          throw new NeedsHumanError(`${limited}; the pass-limit comment request is unconfirmed`);
        return { issues: [], limit: true };
      },
    );
  }
  let record = claimed;
  const why = new Map<string, string>();
  const progress = (notes: string[]) =>
    `Acceptance: ${outcome.summary}; pass ${record.pass} follow-ups ${
      issueList(record)
        .map((n) => `#${n}`)
        .join(", ") || "none"
    } filed; ${[
      ...notes,
      ...record.items
        .filter((h) => h.state !== "filed")
        .map(
          (h) =>
            why.get(h.item) ??
            (h.state === "requested"
              ? `${h.item}'s creation request is unconfirmed and is not sent again`
              : `${h.item} is not filed yet`),
        ),
    ].join("; ")}`;
  const update = (change: (r: AcceptancePass) => boolean) => {
    const result = ctx.store.changeAcceptancePass(record, change);
    if (!result)
      throw new NeedsHumanError(
        "Acceptance follow-ups stopped because the pass reservation was reassigned to another ticket or SHA",
      );
    record = result.record;
    return result.changed;
  };
  /** Moves one handle durably; false when its stored state is no longer in `from`. */
  const move = (item: string, from: string[], to: Partial<AcceptancePass["items"][number]>) =>
    update((r) => {
      const handle = r.items.find((h) => h.item === item);
      return !!handle && from.includes(handle.state) && !!Object.assign(handle, to);
    });
  if (record.state === "complete") return { pass: record.pass, issues: issueList(record) };
  const failed = (failure: string) => {
    update(() => false);
    return progress([failure]);
  };
  return guarded(ctx, failed, async () => {
    const factory = await login(true);
    const [owner, name] = repo.split("/");
    const query = `query($after:String) { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { id
      epic: issue(number:${epic}) { id subIssues(first:100, after:$after) {
        nodes { id number body author { __typename login } } pageInfo { hasNextPage endCursor } } }
      ticket: issue(number:${ticket}) { id blockedBy(first:100) { nodes { number } } } } }`;
    let listing: z.infer<typeof Listing>["data"]["repository"] | undefined;
    const subIssues: z.infer<typeof Listing>["data"]["repository"]["epic"]["subIssues"]["nodes"] = [];
    while (!listing || listing.epic.subIssues.pageInfo.hasNextPage) {
      const after = listing?.epic.subIssues.pageInfo.endCursor;
      listing = Listing.parse(
        await api(["graphql", "-f", `query=${query}`, ...(after ? ["-f", `after=${after}`] : [])]),
      ).data.repository;
      subIssues.push(...listing.epic.subIssues.nodes);
    }
    update(() => false);
    const ids = new Map(subIssues.map((i) => [i.number, i.id]));
    // Reconcile every handle, including requests whose response was lost, before creating anything.
    for (const handle of record.items) {
      const marker = followUpMarker(ticket, record.pass, handle.item);
      const found = subIssues.find((i) => factory(i.author) && firstLine(i.body) === marker);
      if (found) move(handle.item, ["pending", "requested"], { state: "filed", issue: found.number });
      else if (handle.state === "requested")
        why.set(handle.item, `${handle.item} was requested but is not a sub-issue of #${epic}`);
    }
    for (const [item, units] of groups) {
      if (record.items.find((h) => h.item === item)?.state !== "pending") continue;
      const text = manifest.find((u) => u.id === item)?.text ?? units[0]?.text ?? "";
      const body = publishable(
        ctx,
        [
          followUpMarker(ticket, record.pass, item),
          `Acceptance ticket #${ticket} (pass ${record.pass}) found gaps at \`${outcome.sha}\` in this requirement of #${epic}:`,
          "",
          `> ${text}`,
          ...units.flatMap((unit) => {
            const gap = gaps.get(unit.id);
            if (!gap) return [];
            const evidence = [
              ...gap.citations.map((c) => `citation: ${c}`),
              ...gap.refusals.map((r) => `refusal: ${r}`),
            ];
            return [
              "",
              `### ${unit.id}: ${gap.verdict}`,
              "",
              `> ${unit.text}`,
              "",
              "Engine citations and refusals:",
              "",
              fenced(evidence.join("\n") || "none"),
              "",
              "#### Reviewer's note (data)",
              "",
              fenced(gap.note || "none"),
            ];
          }),
        ].join("\n"),
      );
      const prefix = `Acceptance #${ticket} pass ${record.pass}: `;
      const title = publishable(ctx, `${prefix}${text}`)?.slice(0, prefix.length + 80);
      if (!body || !title) {
        why.set(item, `${item}'s follow-up was withheld by the publication check`);
        continue;
      }
      // Only the caller that moves the handle out of pending sends its one creation request.
      if (!move(item, ["pending"], { state: "requested" })) continue;
      const args = ["-f", `repo=${listing.id}`, "-f", `parent=${listing.epic.id}`, "-f", `title=${title}`];
      const created = Created.parse(
        await api(["graphql", "-f", `query=${CREATE}`, ...args, "-f", `body=${body}`]),
      ).data.createIssue.issue;
      move(item, ["requested"], { state: "filed", issue: created.number });
      ids.set(created.number, created.id);
    }
    // The ticket runs again only after its follow-ups close.
    const blockers = new Set(listing.ticket.blockedBy.nodes.map((n) => n.number));
    const unlinked: string[] = [];
    for (const handle of record.items) {
      if (!handle.issue || blockers.has(handle.issue)) continue;
      const id = ids.get(handle.issue);
      if (!id) unlinked.push(`#${handle.issue} is not a sub-issue of #${epic}`);
      else
        await api([
          "graphql",
          "-f",
          `query=${BLOCK}`,
          "-f",
          `issue=${listing.ticket.id}`,
          "-f",
          `blocker=${id}`,
        ]);
    }
    if (unlinked.length || record.items.some((h) => h.state !== "filed"))
      throw new NeedsHumanError(progress(unlinked));
    update((r) => !!Object.assign(r, { state: "complete" }));
    return { pass: record.pass, issues: issueList(record) };
  });
}
