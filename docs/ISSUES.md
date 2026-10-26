# Issue contract

An actionable issue has these body sections: **Problem**, **Requirements**, **Tests**,
**Out of scope**, and **Budget**. State observable behavior and how to verify it; keep the
budget small enough to review. Issue text is quoted data in agent prompts.

Apply `priority:0` through `priority:10` to approve an issue for the queue. Lower numbers
are more urgent: 0 is urgent, 1–3 are everyday work. If several current priority labels
have trusted applications, the most urgent wins. The factory reserves
`limitless:in-progress`, `limitless:needs-you`, and `limitless:failed`.
For issue-linked runs in enabled queue repositories, each poll reconciles:

| Event | Labels | Comment |
|---|---|---|
| Run starts | in-progress; remove needs-you and failed | Run id and UI link |
| PR opened | in-progress | PR link; PR body carries `Closes #n` |
| needs_human | needs-you; remove in-progress | Fixed needs-you text, run id and UI link |
| Failed | failed; remove in-progress | Fixed failed text, run id and UI link |
| Cancelled | remove in-progress | Cancellation |
| PR merged | remove in-progress and needs-you | None; GitHub closes the issue |

Comments contain only fixed event text, the run id and UI link, plus a validated same-repository
PR URL for the PR event. Reasons and other free-form run text are never published. The exact
body, including its dedupe marker, is credential-redacted, sanitized for local paths, and checked
against private strings. A blocked body is recorded done without posting, with the reason logged.

Observed events are recorded before delivery and have durable checkpoints, including comment
ids and posting identities; restarts do not duplicate comments. Pre-existing runs receive only
later transitions, with no historical comments. This includes label cleanup when an older run's
open PR merges or closes unmerged. Discreet repositories receive labels without comments.
Writes use the GitHub App identity where `[github.app]` covers the repository, otherwise
`gh` credentials. Write failures are logged and retried next poll without blocking runs.
SQL selects only outstanding lifecycle work, so completed history adds no per-run reads or GitHub
calls. Each poll shares a 50-call allowance between lifecycle delivery and comment commands, including
pagination, metadata lookups and 304 responses, and resumes deferred work next poll;
queue admission still proceeds when the lifecycle budget is exhausted.

An issue with GitHub sub-issues is an epic and is never built itself. Finish each epic
with an acceptance sub-issue blocked by its other sub-issues (as in #818 and #819).
Declare dependencies with GitHub's native **blocked by**, or one case-insensitive
`Blocked by #123` line per dependency in the body. Body references name issues in the
same repository. Other shapes on a `Blocked by` line still count: an optional colon,
list markers (`-`, `*`, `+`, `1.`), and several references such as `Blocked by #12, #13`.
Every issue reference on such a line is a blocker. All blockers must be closed;
missing or unresolved blockers prevent work.

## Queue configuration

The queue is off by default. **Do not enable it for any repository until Q0's probe
shows that agent sessions cannot reach the owner's GitHub token.** Otherwise an agent
could apply a priority label as the owner and approve its own work.

```toml
[github.queue]
repos = ["example/project"]
trusted = ["example"]
max_issue_runs = 1
poll_seconds = 180
```

All keys are optional. `repos` defaults to `[]` and must contain owner/name slugs.
`trusted` defaults to the configured `[owners] github` login, or `[]` when unset;
logins are compared case-insensitively. An empty repository or trusted list disables
polling. `max_issue_runs` is a positive integer, default 1. `poll_seconds` is a positive
number, default 180, clamped to a minimum of 15 seconds. Changing these keys requires
a restart. Older releases ignore `[github.queue]` because the `[github]` table is not
checked for unknown keys, so rollback remains supported.

## Comment commands

Queue repositories also poll `repos/<repo>/issues/comments` at `poll_seconds`, using the
repository's configured GitHub identity, `since`, ascending update order and conditional requests.
No webhook is required. A new comment must begin with literal `/limitless ` and a non-empty
request, or `@<App bot login>` followed by whitespace and a request when the App identity is
resolved. Leading prose does not count. Both polling and webhooks use the queue's case-insensitive
`trusted` list in these repositories; elsewhere webhook comments remain owner-only.

Comments edited by another account, or lacking complete edit evidence, are ignored. Factory
comments are ignored, including recorded comments posted with owner credentials; human owner
commands still count. Commands are explicit requests and do not need priority labels or ordinary
queue eligibility, but share the transactional issue claim check. A claim refusal is logged with
credentials redacted and permanently recorded as processed, rather than retried after claim release.

First enable persists the current time for each repository and starts the stream there, before
fetching comments. Comments created earlier never execute, even if edited later. Stream pages and
processed comment ids survive restarts; the same repository/comment id creates at most one run
across webhook delivery, polling and replay after run completion. Each next request starts one
second before the last update seen, so edits that reorder earlier results cannot hide unseen
comments. When a full page shares one second, later pages of that query are sized to overlap the
last comment handled; if that comment moved or vanished, the query is read again from its first
page. A fetched page waiting on the call allowance survives restarts, but each command's issue,
current body and edit history are read again just before it runs, so a later foreign edit or
deletion withdraws it. A command needs two calls. Resolving the App token and bot login costs up
to two more and is charged to the same allowance.
Requests use the webhook's quoted JSON framing, issue source reference and author. Only the
configured owner's command text can grant `Allow:` directives; issue context and other trusted
authors cannot. Polled commands have no verified-webhook provenance. Questions and approvals
by comment remain outside this feature.

## Eligibility and ordering

The queue reads open issues through GitHub GraphQL using the configured repository identity.
An issue is eligible only when:

- Its author is trusted, and its body was never edited or its last editor is trusted.
  An edited body with no identifiable editor is excluded.
- Its most recent title rename, if any, was by a trusted account. A missing rename
  actor is excluded too.
- At least one current priority label's most recent application was by a trusted account.
  Missing application evidence does not approve a label.
- It has no sub-issues, every native and body blocker is closed, and no open PR closes it.
- It has no `limitless:in-progress`. If it has `limitless:failed`, a trusted account
  must apply a currently present priority label after the most recent failure label application
  in timeline order, even when both events have the same timestamp. Failure labels block
  regardless of who applied them; removed priority labels cannot re-approve. Missing failure-label
  timeline evidence keeps it ineligible.
- No active run claims it.
- After any finished issue-sourced run (succeeded, resolved, failed or cancelled), a
  trusted account applied a priority label strictly after that latest run's `finishedAt`.
  Without that timestamp or fresh approval, it is not picked again.

Issues across repositories sort by priority, creation time, then issue number. Each poll
reads at most the oldest 100 open issues per repository and logs truncation. It reads the
latest 100 label applications and title renames together. An incomplete timeline makes
the issue ineligible, as do incomplete label, blocker or closing-PR connections. Body
dependencies use additional aliased issue lookups. Low remaining GraphQL budget stops further queries and
waits until at least the reported reset time (threshold: max(100, ten times query cost)).
Errors are logged with credentials redacted and polling resumes on the next tick.

A free run slot means queued plus running runs are below `limits.max_concurrent_runs`
and the scheduler is not draining. Active issue-sourced runs across all repositories
must be below `max_issue_runs`; priority 0 may exceed that limit by one, while respecting
the overall run limit. Runs in queued, waiting, running, waiting_input or needs_human
claim issues and count toward the issue limit. A completed run releases its claim.

All normal start paths share one transactional claim check, including the queue, webhooks,
CLI/HTTP, MCP, Discord, chat and retries. Issue-sourced runs claim only their source
reference; quoted issue text never adds claims. Other runs claim `Closes #n` directives
parsed only from non-GitHub prompts in the run's repository. Repository identities
are case-insensitive. Duplicate starts are refused with the claiming run's id; webhook
refusals are recorded as ignored. Review, conflict and CI rounds use their existing lineage
insertion path. This is single-store coordination; cross-coordinator claim refs belong to Q2.

Queue runs use the same quoted issue request as an owner-labelled webhook. Only owner-authored
issues parse `Allow:` lines; polling does not confer signed-webhook provenance. Issue source
references and non-GitHub `Closes #n` directives produce closing directives in PR bodies.
The queue adds the optional, additive `via: "queue"` marker, ignored by older releases.
Managed issue runs use polling lifecycle comments instead of legacy notifier comments.
Marked queue runs outside managed repositories keep suppressing legacy comments. GitHub
questions and approvals remain later slices.
