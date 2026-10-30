import { z } from "zod";
import type { Factory } from "../app.ts";
import type { EpicAttention, Run } from "../core/types.ts";
import { CommentProcessed, ISSUE_CLAIM_STATUSES, type IssueRunSummary, linkedIssues } from "../db/store.ts";
import { redactCredentials } from "../util/proc.ts";
import { beginActivity } from "../util/stall.ts";
import {
  ANSWER_UNSUPPORTED,
  commentRunRequest,
  type GhRunner,
  issueRunRequest,
  reservedAnswer,
  runGh,
} from "./github.ts";
import { githubIdentity } from "./github-identity.ts";
import { type IssueLifecycleOptions, reconcileIssueLifecycle } from "./issue-lifecycle.ts";
import { issueTextRefusal } from "./issue-trust.ts";

const date = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const actor = z.object({ login: z.string() }).nullable();
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    nodes: z.array(node),
    totalCount: z.number().int().nonnegative(),
  });
const issueReference = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED"]),
  repository: z.object({ nameWithOwner: z.string() }),
});
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  createdAt: date,
  updatedAt: date,
  comments: connection(
    z.object({
      databaseId: z.number().int().positive(),
      body: z.string(),
      createdAt: date,
      lastEditedAt: date.nullable(),
      author: actor,
    }),
  ),
  state: z.enum(["OPEN", "CLOSED"]),
  author: actor,
  editor: actor,
  lastEditedAt: date.nullable(),
  labels: connection(z.object({ name: z.string() })),
  subIssuesSummary: z.object({ total: z.number().int().nonnegative() }),
  subIssues: connection(
    issueReference.extend({
      labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
    }),
  ),
  blockedBy: connection(issueReference),
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
const issueKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const priority = (s: string) => /^priority:(10|[0-9])$/.test(s);
const blockers = (body: string) =>
  body
    .split(/\r?\n/)
    .filter((line) => /^[\t ]*(?:(?:[-*+]|\d+[.)])[\t ]+)?blocked by\b:?/i.test(line))
    .flatMap((line) => [...line.matchAll(/#([1-9][0-9]*)\b/g)].map((m) => Number(m[1])));

/** Undefined means incomplete evidence: preserve the saved observation. */
export function epicAttention(
  repo: string,
  epic: QueueIssue,
  trusted: string[],
  issues: ReadonlyMap<string, QueueIssue>,
  claimed: (repo: string, number: number) => boolean,
): EpicAttention | null | undefined {
  if (epic.state !== "OPEN") return null;
  const children = epic.subIssues;
  const key = (c: z.infer<typeof issueReference>) => issueKey(c.repository.nameWithOwner, c.number);
  const childKeys = new Set(children.nodes.map(key));
  if (
    children.totalCount > 50 ||
    children.totalCount !== children.nodes.length ||
    children.totalCount !== epic.subIssuesSummary.total ||
    childKeys.size !== children.totalCount
  )
    return undefined;
  if (!children.totalCount) return null;
  const trusts = (login: string | undefined) =>
    !!login && trusted.some((t) => t.toLowerCase() === login.toLowerCase());
  const lines: { line: string; text: string }[] = [];
  let slices = false;
  let fence: string | undefined;
  if (trusts(epic.author?.login) && (!epic.lastEditedAt || trusts(epic.editor?.login))) {
    for (const line of epic.body.split(/\r?\n/)) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker)
          fence = undefined;
        continue;
      }
      if (marker) {
        fence = marker;
        continue;
      }
      if (/^ {0,3}#{1,2}(?:\s|$)/.test(line)) slices = /^ {0,3}## Slices\s*$/.test(line);
      const text = line.match(/^ {0,1}(?:[-*+]|\d+[.)])\s+(.*)$/)?.[1];
      if (slices && text !== undefined) lines.push({ line, text });
    }
  }
  const reference = (text: string) => {
    const match = text.match(/^(?:Acceptance:\s+)?(?:([\w.-]+\/[\w.-]+))?#([1-9][0-9]*)(?=$|[\s\p{P}])/u);
    return match?.[2] ? issueKey(match[1] ?? repo, Number(match[2])) : undefined;
  };
  const unfiled = lines.filter((l) => !childKeys.has(reference(l.text) ?? "")).map((l) => l.line);
  if (unfiled.length) return { state: "unfiled", items: unfiled };
  const open = children.nodes.filter((c) => c.state === "OPEN");
  if (!open.length) return null;
  const records = open.map((c) => issues.get(key(c)));
  if (
    open.some((c, n) => {
      const i = records[n];
      // Local records must be complete; unobserved foreign children lack priority evidence.
      if (!i) return c.repository.nameWithOwner.toLowerCase() === repo.toLowerCase();
      return i.state !== "OPEN" || i.labels.totalCount !== i.labels.nodes.length;
    })
  )
    return undefined;
  if (
    !open.some(
      (c, n) =>
        records[n]?.labels.nodes.some((l) => priority(l.name)) ||
        claimed(c.repository.nameWithOwner, c.number),
    )
  )
    return { state: "needs_approval", items: open.map((c) => `#${c.number}`) };
  if (open.length !== 1) return null;
  const candidate = open[0];
  const record = records[0];
  if (!candidate || !record) return undefined;
  const acceptance = lines.filter((l) => /^Acceptance:/.test(l.text));
  if (acceptance.length) {
    const references = new Set(acceptance.map((l) => reference(l.text)));
    return acceptance.length === 1 && references.size === 1 && references.has(key(candidate))
      ? { state: "ready_for_acceptance", items: [`#${candidate.number}`] }
      : null;
  }
  if (record.blockedBy.totalCount !== record.blockedBy.nodes.length) return undefined;
  const covered = new Set([key(candidate), ...record.blockedBy.nodes.map(key)]);
  return children.nodes.every((c) => covered.has(key(c)))
    ? { state: "ready_for_acceptance", items: [`#${candidate.number}`] }
    : null;
}

/** Policy only: callers supply observed dependency and local run state. Missing evidence never approves. */
export function issueEligibility(
  issue: QueueIssue,
  trusted: string[],
  context: {
    blockers?: ReadonlyMap<number, string>;
    claim?: Run | null;
    latest?: IssueRunSummary | null;
    failureBoundary?: number | null;
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
      const last = events.toReversed().find((e) => e.label.name === l.name);
      return trusts(last?.actor?.login);
    });
  const reapprovedAfterFailure =
    failedIndex >= 0 &&
    approved.some(
      (label) =>
        issue.timelineItems.nodes.findLastIndex(
          (e) => e.__typename === "LabeledEvent" && e.label.name === label.name && trusts(e.actor?.login),
        ) > failedIndex,
    );
  const failed = issue.labels.nodes.some((l) => l.name === "limitless:failed");
  const textRefusal = issueTextRefusal(issue, trusted);
  let reason = "";
  if (issue.state !== "OPEN") reason = "issue is closed";
  else if (textRefusal) reason = textRefusal;
  else if (rename && !trusts(rename.actor?.login)) reason = "untrusted title editor";
  else if (!issue.labels.nodes.some((l) => priority(l.name))) reason = "no priority label";
  else if (!approved.length) reason = "priority application is untrusted or missing";
  else if (issue.subIssuesSummary.total) reason = "epic has sub-issues";
  else if (issue.blockedBy.nodes.some((b) => b.state !== "CLOSED")) reason = "open native blocker";
  else if (blockers(issue.body).some((n) => context.blockers?.get(n) !== "CLOSED"))
    reason = "open or unresolved body blocker";
  else if (issue.labels.nodes.some((l) => l.name === "limitless:in-progress"))
    reason = "factory status label";
  else if (failed && !reapprovedAfterFailure)
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
    // A failure recorded before lifecycle support has no boundary: it follows the completion-time rule.
    (context.latest.status === "failed" && context.failureBoundary != null
      ? !(reapprovedAfterFailure && failedIndex >= context.failureBoundary)
      : context.latest.finishedAt === null ||
        !events.some(
          (e) => trusts(e.actor?.login) && Date.parse(e.createdAt) > (context.latest?.finishedAt ?? Infinity),
        ))
  )
    reason = "priority re-approval required after the latest issue run";
  return reason
    ? { eligible: false, reason }
    : { eligible: true, priority: Math.min(...approved.map((l) => Number(l.name.slice(9)))) };
}

const ISSUE_FIELDS = `number title body createdAt updatedAt state author { login } editor { login } lastEditedAt
  comments(last: 20) { totalCount nodes { databaseId body createdAt lastEditedAt author { login } } }
  labels(first:100) { totalCount nodes { name } } subIssuesSummary { total }
  subIssues(first:50) { totalCount nodes { number state repository { nameWithOwner } labels(first:20) { nodes { name } } } }
  blockedBy(first:100) { totalCount nodes { number state repository { nameWithOwner } } }
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
): (() => void) & { pollNow: () => void } {
  const q = factory.cfg.githubQueue;
  if (!q?.repos.length || !q.trusted.length) return Object.assign(() => {}, { pollNow: () => {} });
  const { gh = runGh, log = console.warn } = opts;
  const { now, set, clear } = opts.clock ?? { now: Date.now, set: setTimeout, clear: clearTimeout };
  const abort = new AbortController();
  let stopped = false;
  let notBefore = 0;
  let limited = false;
  let inFlight = false;
  let pending = false;
  let startedAt = -Infinity;
  let retryNotBefore = 0;
  let nextTickAt = Infinity;
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
  const latestContext = (repo: string, number: number, latest: IssueRunSummary | undefined) => {
    const failure =
      latest?.status === "failed"
        ? factory.store.issueLifecycleEffects(latest.id, repo, number).find((e) => e.effect === "failure")
        : null;
    const boundary = failure?.state === "done" && failure.body !== null ? Number(failure.body) : NaN;
    return { latest, failureBoundary: Number.isInteger(boundary) && boundary >= 0 ? boundary : null };
  };
  const tick = async () => {
    if (stopped) return;
    startedAt = now();
    inFlight = true;
    pending = false;
    limited = false;
    let failed = false;
    let unsubscribe = () => {};
    const invalidated = new Set<string>();
    const changedDuringPoll = (repo: string, number: number) =>
      invalidated.has(issueKey(repo, number))
        ? "linked run changed during the poll; retrying next poll"
        : null;
    const candidates: { repo: string; issue: QueueIssue; priority: number; states: Map<number, string> }[] =
      [];
    const snapshots = new Map<string, Map<number, IssueRunSummary>>();
    try {
      unsubscribe = factory.store.subscribe((msg) => {
        if (msg.kind !== "run") return;
        const run = msg.run;
        const issues = linkedIssues(run, factory.store);
        const links = new Set(issues.map((i) => issueKey(i.repo, i.number)));
        for (const [repo, latest] of snapshots) {
          for (const [number, summary] of latest) {
            const key = issueKey(repo, number);
            const state =
              summary.id === run.id ? summary : summary.ownerId === run.id ? summary.ownerState : undefined;
            if (
              (state && (state.status !== run.status || state.finishedAt !== run.finishedAt)) ||
              ((summary.id === run.id || summary.ownerId === run.id) && !links.has(key))
            )
              invalidated.add(key);
          }
        }
        // Missing snapshots retain conservative invalidation; existing ones compare only linked candidates.
        for (const { repo, number } of issues) {
          const summary = snapshots.get(repo.toLowerCase())?.get(number);
          if (summary?.id !== run.id && summary?.ownerId !== run.id) invalidated.add(issueKey(repo, number));
        }
      });
      await reconcileIssueLifecycle(factory.store, factory.cfg, gh, abort.signal, log, opts.lifecycle);
      for (const repo of q.repos) {
        if (stopped || limited || now() < notBefore) break;
        const end = beginActivity("issue-queue.repository");
        try {
          const boundary = factory.store.githubCommentBoundary(repo);
          if (!boundary) {
            const raw = await gh(["api", "--include", "rate_limit"], abort.signal, undefined, repo);
            const headers = (raw ?? "").split(/\r?\n\r?\n/)[0] ?? "";
            const githubAt = Date.parse(headers.match(/^date:[\t ]*(.+)$/im)?.[1] ?? "");
            if (!/^HTTP\/\S+ 2\d\d\b/.test(headers) || !Number.isFinite(githubAt))
              throw new Error("GitHub enable boundary requires a successful response with a Date header");
            if (!stopped) factory.store.githubCommentBoundary(repo, new Date(githubAt).toISOString());
            continue;
          }
          const issues = { nodes: [] as QueueIssue[] };
          const cursors = new Set<string>();
          let after: string | null = null;
          // Validate every page before consuming commands.
          do {
            const data = await query(
              repo,
              `issues(first:100, states:OPEN, orderBy:{field:CREATED_AT,direction:ASC}${after ? `, after:${JSON.stringify(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } }`,
            );
            const page = z
              .object({
                nodes: z.array(issueSchema),
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
              })
              .parse(data.issues);
            issues.nodes.push(...page.nodes);
            after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
            if (page.pageInfo.hasNextPage && (!after || cursors.has(after)))
              throw new Error("Open issue pagination did not advance");
            if (after) {
              cursors.add(after);
              if (stopped || limited || now() < notBefore)
                throw new Error("Open issue pagination interrupted");
            }
          } while (after);
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
          if (stopped) break;
          const identity = await (opts.lifecycle?.identity ?? githubIdentity)(repo).catch(() => null);
          if (stopped) break;
          const observed = new Map(issues.nodes.map((i) => [issueKey(repo, i.number), i]));
          factory.store.reconcileEpicAttention(
            repo,
            new Map(
              issues.nodes.map((i) => [
                i.number,
                epicAttention(repo, i, q.trusted, observed, (r, n) => !!factory.store.issueClaim(r, n)),
              ]),
            ),
          );
          const bot = identity?.kind === "app" ? identity.botLogin.toLowerCase() : null;
          const latest = factory.store.latestIssueRuns(
            repo,
            issues.nodes.map((i) => i.number),
          );
          snapshots.set(repo.toLowerCase(), latest);
          for (const issue of issues.nodes) {
            for (const c of boundary && issue.state === "OPEN" ? issue.comments.nodes : []) {
              const author = c.author?.login;
              const command = c.body.startsWith("/limitless ")
                ? c.body.slice(11)
                : bot && c.body.match(/^@(\S+)\s+([\s\S]*)$/)?.slice(1);
              const request =
                typeof command === "string"
                  ? command
                  : command && [bot, bot?.replace(/\[bot\]$/, "")].includes(command[0]?.toLowerCase())
                    ? command[1]
                    : null;
              const comment = { repo, id: c.databaseId };
              if (
                !request?.trim() ||
                !author ||
                c.lastEditedAt ||
                /\[bot\]$/i.test(author) ||
                !q.trusted.some((t) => t.toLowerCase() === author.toLowerCase()) ||
                Date.parse(c.createdAt) <= Date.parse(boundary ?? "") ||
                factory.store.githubCommentProcessed(comment)
              )
                continue;
              if (reservedAnswer(request)) {
                factory.store.recordGitHubComment(comment, null, ANSWER_UNSUPPORTED);
                continue;
              }
              try {
                const req = commentRunRequest(
                  {
                    repo,
                    number: issue.number,
                    issueTitle: issue.title,
                    issueBody: issue.body,
                    request,
                    author,
                  },
                  factory.cfg.githubOwner,
                );
                req.sourceRef = { ...req.sourceRef, via: "queue" };
                await factory.createRun(
                  req,
                  false,
                  undefined,
                  true,
                  () => (stopped ? "queue stopped" : null),
                  comment,
                );
              } catch (error) {
                if (!(error instanceof CommentProcessed))
                  log(redactCredentials(`Issue queue ${repo}#${issue.number}: ${String(error)}`));
              }
            }
            const result = issueEligibility(issue, q.trusted, {
              blockers: states,
              claim: factory.store.issueClaim(repo, issue.number),
              ...latestContext(repo, issue.number, latest.get(issue.number)),
            });
            if (result.eligible) candidates.push({ repo, issue, priority: result.priority, states });
            else if (result.reason.startsWith("claimed"))
              log(redactCredentials(`Issue queue ${repo}#${issue.number}: ${result.reason}`));
          }
        } catch (e) {
          failed = true;
          if (!stopped) log(redactCredentials(`Issue queue ${repo}: ${String(e)}`));
        } finally {
          end();
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
          ...latestContext(repo, issue.number, snapshots.get(repo.toLowerCase())?.get(issue.number)),
        });
        const reason = changedDuringPoll(repo, issue.number) ?? (!current.eligible ? current.reason : null);
        if (reason) {
          log(redactCredentials(`Issue queue ${repo}#${issue.number}: ${reason}`));
          continue;
        }
        const admission = () => {
          if (stopped) return "queue stopped";
          if (factory.scheduler.draining) return "scheduler draining";
          const deferred = changedDuringPoll(repo, issue.number);
          if (deferred) return deferred;
          const eligibility = issueEligibility(issue, q.trusted, {
            blockers: states,
            ...latestContext(repo, issue.number, snapshots.get(repo.toLowerCase())?.get(issue.number)),
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
      failed = true;
      if (!stopped) log(redactCredentials(`Issue queue: ${String(e)}`));
    } finally {
      unsubscribe();
      inFlight = false;
      const regular = now() + q.pollSeconds * 1000;
      retryNotBefore = failed ? regular : 0;
      const hinted = pending && !failed ? Math.max(now(), startedAt + 30_000) : Infinity;
      schedule(Math.max(Math.min(regular, hinted), notBefore));
    }
  };
  const schedule = (deadline: number) => {
    nextTickAt = deadline;
    if (!stopped)
      timer = set(
        () => (now() < deadline ? schedule(deadline) : void tick()),
        Math.min(3_600_000, Math.max(0, deadline - now())),
      );
  };
  timer = set(() => void tick(), 0);
  return Object.assign(
    () => {
      stopped = true;
      abort.abort();
      clear(timer);
    },
    {
      pollNow: () => {
        if (stopped) return;
        if (inFlight) pending = true;
        else {
          clear(timer);
          const hinted = Math.max(now(), startedAt + 30_000, retryNotBefore, notBefore);
          schedule(Math.min(nextTickAt, hinted));
        }
      },
    },
  );
}
