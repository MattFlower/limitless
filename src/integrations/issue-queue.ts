import { z } from "zod";
import type { Factory } from "../app.ts";
import type { Run } from "../core/types.ts";
import { ISSUE_CLAIM_STATUSES } from "../db/store.ts";
import { redactCredentials } from "../util/proc.ts";
import { type GhRunner, issueRunRequest, runGh } from "./github.ts";
import { type IssueLifecycleOptions, reconcileIssueLifecycle } from "./issue-lifecycle.ts";

const date = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const actor = z.object({ login: z.string() }).nullable();
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    nodes: z.array(node),
    totalCount: z.number().int().nonnegative(),
  });
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  createdAt: date,
  state: z.enum(["OPEN", "CLOSED"]),
  author: actor,
  editor: actor,
  lastEditedAt: date.nullable(),
  labels: connection(z.object({ name: z.string() })),
  subIssuesSummary: z.object({ total: z.number().int().nonnegative() }),
  blockedBy: connection(z.object({ state: z.enum(["OPEN", "CLOSED"]) })),
  closedByPullRequestsReferences: connection(z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]) })),
  timelineItems: connection(
    z.discriminatedUnion("__typename", [
      z.object({
        __typename: z.literal("LabeledEvent"),
        label: z.object({ name: z.string() }),
        actor,
        createdAt: date,
      }),
      z.object({ __typename: z.literal("RenamedTitleEvent"), actor, createdAt: date }),
    ]),
  ),
});
export type QueueIssue = z.infer<typeof issueSchema>;
const priority = (s: string) => /^priority:(10|[0-9])$/.test(s);
const blockers = (body: string) =>
  body
    .split(/\r?\n/)
    .filter((line) => /^[\t ]*(?:(?:[-*+]|\d+[.)])[\t ]+)?blocked by\b:?/i.test(line))
    .flatMap((line) => [...line.matchAll(/#([1-9][0-9]*)\b/g)].map((m) => Number(m[1])));

/** Policy only: callers supply observed dependency and local run state. Missing evidence never approves. */
export function issueEligibility(
  issue: QueueIssue,
  trusted: string[],
  context: {
    blockers?: ReadonlyMap<number, string>;
    claim?: Run | null;
    latest?: Run | null;
  } = {},
): { eligible: true; priority: number } | { eligible: false; reason: string } {
  const trusts = (login: string | undefined) =>
    !!login && trusted.some((s) => s.toLowerCase() === login.toLowerCase());
  const events = issue.timelineItems.nodes
    .filter((e) => e.__typename === "LabeledEvent")
    .filter((e) => priority(e.label.name));
  const failedIndex = issue.timelineItems.nodes.findLastIndex(
    (e) => e.__typename === "LabeledEvent" && e.label.name === "limitless:failed",
  );
  const rename = issue.timelineItems.nodes
    .toReversed()
    .filter((e) => e.__typename === "RenamedTitleEvent")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const approved = issue.labels.nodes
    .filter((l) => priority(l.name))
    .filter((l) => {
      const last = events
        .toReversed()
        .filter((e) => e.label.name === l.name)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      return trusts(last?.actor?.login);
    });
  let reason = "";
  if (issue.state !== "OPEN") reason = "issue is closed";
  else if (!trusts(issue.author?.login)) reason = "untrusted author";
  else if (issue.lastEditedAt && !trusts(issue.editor?.login)) reason = "untrusted body editor";
  else if (rename && !trusts(rename.actor?.login)) reason = "untrusted title editor";
  else if (!issue.labels.nodes.some((l) => priority(l.name))) reason = "no priority label";
  else if (!approved.length) reason = "priority application is untrusted or missing";
  else if (issue.subIssuesSummary.total) reason = "epic has sub-issues";
  else if (issue.blockedBy.nodes.some((b) => b.state !== "CLOSED")) reason = "open native blocker";
  else if (blockers(issue.body).some((n) => context.blockers?.get(n) !== "CLOSED"))
    reason = "open or unresolved body blocker";
  else if (issue.labels.nodes.some((l) => l.name === "limitless:in-progress"))
    reason = "factory status label";
  else if (
    issue.labels.nodes.some((l) => l.name === "limitless:failed") &&
    (failedIndex < 0 ||
      !approved.some(
        (label) =>
          issue.timelineItems.nodes.findLastIndex(
            (e) => e.__typename === "LabeledEvent" && e.label.name === label.name && trusts(e.actor?.login),
          ) > failedIndex,
      ))
  )
    reason = "factory status requires priority re-approval after failure";
  else if (issue.closedByPullRequestsReferences.nodes.some((p) => p.state === "OPEN"))
    reason = "open closing PR";
  else if (
    [issue.labels, issue.blockedBy, issue.closedByPullRequestsReferences, issue.timelineItems].some(
      (c) => c.totalCount !== c.nodes.length,
    )
  )
    reason = "incomplete issue evidence";
  else if (context.claim) reason = `claimed by run ${context.claim.id}`;
  else if (
    context.latest &&
    !ISSUE_CLAIM_STATUSES.includes(context.latest.status) &&
    (context.latest.finishedAt === null ||
      !events.some(
        (e) => trusts(e.actor?.login) && Date.parse(e.createdAt) > (context.latest?.finishedAt ?? Infinity),
      ))
  )
    reason = "priority re-approval required after the latest issue run";
  return reason
    ? { eligible: false, reason }
    : { eligible: true, priority: Math.min(...approved.map((l) => Number(l.name.slice(9)))) };
}

const ISSUE_FIELDS = `number title body createdAt state author { login } editor { login } lastEditedAt
  labels(first:100) { totalCount nodes { name } } subIssuesSummary { total }
  blockedBy(first:100) { totalCount nodes { state } }
  closedByPullRequestsReferences(first:100) { totalCount nodes { state } }
  timelineItems(last:100, itemTypes:[LABELED_EVENT, RENAMED_TITLE_EVENT]) { totalCount nodes { __typename
    ... on LabeledEvent { label { name } actor { login } createdAt }
    ... on RenamedTitleEvent { actor { login } createdAt } } }`;
export type IssueQueueClock = {
  now: () => number;
  set: typeof setTimeout;
  clear: typeof clearTimeout;
};
type QueueFactory = Pick<Factory, "cfg" | "store" | "scheduler" | "createRun">;

export function startIssueQueue(
  factory: QueueFactory,
  opts: {
    gh?: GhRunner;
    clock?: IssueQueueClock;
    log?: (s: string) => void;
    lifecycle?: IssueLifecycleOptions;
  } = {},
): () => void {
  const q = factory.cfg.githubQueue;
  if (!q?.repos.length || !q.trusted.length) return () => {};
  const { gh = runGh, log = console.warn } = opts;
  const { now, set, clear } = opts.clock ?? { now: Date.now, set: setTimeout, clear: clearTimeout };
  const abort = new AbortController();
  let stopped = false;
  let notBefore = 0;
  let limited = false;
  let timer: ReturnType<typeof setTimeout>;
  const query = async (repo: string, fields: string) => {
    const [owner, name] = repo.split("/");
    const raw = await gh(
      [
        "api",
        "graphql",
        "-f",
        `query=query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${fields} } rateLimit { cost remaining resetAt } }`,
      ],
      abort.signal,
      undefined,
      repo,
    );
    const response = z
      .object({
        errors: z.array(z.unknown()).optional(),
        data: z.object({
          repository: z.unknown(),
          rateLimit: z.object({
            cost: z.number().nonnegative(),
            remaining: z.number().nonnegative(),
            resetAt: date,
          }),
        }),
      })
      .parse(JSON.parse(raw ?? ""));
    const rate = response.data.rateLimit;
    if (rate.remaining < Math.max(100, 10 * rate.cost)) {
      limited = true;
      notBefore = Math.max(notBefore, Date.parse(rate.resetAt));
    }
    if (response.errors?.length) throw new Error("GraphQL issue query returned errors");
    return z.record(z.string(), z.unknown()).parse(response.data.repository);
  };
  const tick = async () => {
    limited = false;
    const candidates: { repo: string; issue: QueueIssue; priority: number; states: Map<number, string> }[] =
      [];
    try {
      await reconcileIssueLifecycle(factory.store, factory.cfg, gh, abort.signal, log, opts.lifecycle);
      for (const repo of q.repos) {
        if (stopped || limited || now() < notBefore) break;
        try {
          const data = await query(
            repo,
            `issues(first:100, states:OPEN, orderBy:{field:CREATED_AT,direction:ASC}) { pageInfo { hasNextPage } nodes { ${ISSUE_FIELDS} } }`,
          );
          const issues = z
            .object({ nodes: z.array(issueSchema), pageInfo: z.object({ hasNextPage: z.boolean() }) })
            .parse(data.issues);
          if (issues.pageInfo.hasNextPage)
            log(redactCredentials(`Issue queue ${repo}: open issues truncated at 100`));
          const states = new Map<number, string>();
          const numbers = [...new Set(issues.nodes.flatMap((i) => blockers(i.body)))];
          if (numbers.length && !stopped && !limited && now() >= notBefore) {
            const deps = await query(
              repo,
              numbers.map((n) => `i${n}:issue(number:${n}) { state }`).join(" "),
            );
            for (const n of numbers) {
              const found = z
                .object({ state: z.enum(["OPEN", "CLOSED"]) })
                .nullable()
                .parse(deps[`i${n}`]);
              if (found) states.set(n, found.state);
            }
          }
          for (const issue of issues.nodes) {
            const result = issueEligibility(issue, q.trusted, {
              blockers: states,
              claim: factory.store.issueClaim(repo, issue.number),
              latest: factory.store.latestIssueRun(repo, issue.number),
            });
            if (result.eligible) candidates.push({ repo, issue, priority: result.priority, states });
            else if (result.reason.startsWith("claimed"))
              log(redactCredentials(`Issue queue ${repo}#${issue.number}: ${result.reason}`));
          }
        } catch (e) {
          if (!stopped) log(redactCredentials(`Issue queue ${repo}: ${String(e)}`));
        }
      }
      candidates.sort(
        (a, b) =>
          a.priority - b.priority ||
          Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt) ||
          a.issue.number - b.issue.number,
      );
      for (const { repo, issue, priority, states } of candidates) {
        if (stopped || factory.scheduler.draining) break;
        const current = issueEligibility(issue, q.trusted, {
          blockers: states,
          claim: factory.store.issueClaim(repo, issue.number),
          latest: factory.store.latestIssueRun(repo, issue.number),
        });
        if (!current.eligible) {
          log(redactCredentials(`Issue queue ${repo}#${issue.number}: ${current.reason}`));
          continue;
        }
        const admission = () => {
          if (stopped) return "queue stopped";
          if (factory.scheduler.draining) return "scheduler draining";
          const eligibility = issueEligibility(issue, q.trusted, {
            blockers: states,
            latest: factory.store.latestIssueRun(repo, issue.number),
          });
          if (!eligibility.eligible) return eligibility.reason;
          const active = factory.store.listRuns({
            status: ISSUE_CLAIM_STATUSES,
            limit: Number.MAX_SAFE_INTEGER,
          });
          if (
            active.filter((r) => r.status === "queued" || r.status === "running").length >=
            factory.cfg.maxConcurrentRuns
          )
            return "run limit reached";
          if (
            active.filter((r) => r.sourceRef?.kind === "issue").length >=
            q.maxIssueRuns + Number(priority === 0)
          )
            return "issue run limit reached";
          return null;
        };
        if (admission()) continue;
        try {
          const request = issueRunRequest(
            {
              repo,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              author: issue.author?.login ?? "",
            },
            factory.cfg.githubOwner,
          );
          request.sourceRef = { ...request.sourceRef, via: "queue" };
          await factory.createRun(request, false, undefined, true, admission);
        } catch (e) {
          log(redactCredentials(`Issue queue ${repo}#${issue.number}: ${String(e)}`));
        }
      }
    } catch (e) {
      if (!stopped) log(redactCredentials(`Issue queue: ${String(e)}`));
    } finally {
      const deadline = Math.max(now() + q.pollSeconds * 1000, notBefore);
      const schedule = () => {
        if (!stopped)
          timer = set(
            () => (now() < deadline ? schedule() : void tick()),
            Math.min(3_600_000, Math.max(0, deadline - now())),
          );
      };
      schedule();
    }
  };
  timer = set(() => void tick(), 0);
  return () => {
    stopped = true;
    abort.abort();
    clear(timer);
  };
}
