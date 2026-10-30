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
calls. Each poll caps lifecycle GitHub calls at 50 and resumes deferred work next poll;
queue admission still proceeds when the lifecycle budget is exhausted.

An issue with GitHub sub-issues is an epic and is never built itself. Finish each epic
with an acceptance sub-issue blocked by its other sub-issues (as in #818 and #819).
Declare dependencies with GitHub's native **blocked by**, or one case-insensitive
`Blocked by #123` line per dependency in the body. Body references name issues in the
same repository. Other shapes on a `Blocked by` line still count: an optional colon,
list markers (`-`, `*`, `+`, `1.`), and several references such as `Blocked by #12, #13`.
Every issue reference on such a line is a blocker. All blockers must be closed;
missing or unresolved blockers prevent work.

## Acceptance intent

Acceptance runs resolve a stable manifest from trusted ticket and parent snapshots before any
model call. The ticket's `## The original intent` section names sections of the parent with
lines of the form `#123's "Goal" section`, optionally followed by ` (docs)`; #123 must be the
parent. Every list item and paragraph of a referenced section is a requirement unit. A `(docs)`
suffix marks that section's units as documentation requirements; other units require test
evidence. Other prose and list items in the intent section are context. Duplicate normalized
texts share one unit.

Quoting parent or file text (a `From #123:` or `From docs/PLAN.md:` line followed by `>` quotes)
is not supported: it was cut from #981's scope, and a lead-in or a quote refuses the run. Put the
requirements in a section of the parent and reference it.

The intent section and every referenced section use one strict line grammar. Each line must be:
- blank;
- an ATX heading: one to six `#` at column 0, then a space or the end of the line. A heading at
  the section's level or higher ends the section; a deeper heading is skipped and isn't a unit;
- a list item at column 0: `-`, `*`, `+`, or one to nine digits and `.` or `)`, then a space and
  text. The unit is that one line; a list item never continues onto the next line;
- a paragraph line at column 0. Consecutive paragraph lines form one unit, which ends at a blank
  line, a heading or a list item;
- in the intent section only, a section reference.

Any other line fails the run before the model with `unsupported Markdown in the intent: line <n>
of <#N or the ticket>: <kind>; normalize the ticket`. That covers a line starting with a space or
a tab (continuations, nested lists, indented code), a line starting with `>`, `|` or `<`, a fence
(three or more backticks or tildes), a line made only of `-`, `*`, `_`, `=`, `|`, `:` and spaces
(thematic breaks, setext underlines and table delimiter rows), a `[label]:` link or footnote
definition, a list marker without a space and text, a paragraph line directly under a list item,
and, in the intent section, a `From …:` lead-in. The scan covers the whole section, so an
unsupported line refuses before any later heading could end it.

The referenced heading must be the parent's only column-0 ATX heading with that text (`Goal` and
`Goal#` differ), or the run refuses. Lines outside the section aren't scanned, except that a fence
anywhere before it fails with `unresolvable source`, because a heading inside the fence can't be
told apart from a real one. The ticket's intent heading follows the same rules.

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
reads all open issues per repository in pages of 100, including their latest comments. Every
page must validate before commands are processed; a failed page or a rate-limit pause leaves
the repository for the next poll. It reads the
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

The same poll reads each issue's last 20 comments without an extra GraphQL call. A trusted
human author (no `[bot]` suffix, case-insensitively) can post `/limitless <request>` on any open
issue, without priority labels or queue capacity admission. With an App identity,
`@<slug> <request>` and `@<slug>[bot] <request>`
also work. If identity lookup fails, mentions wait for a later poll; slash commands still work.
Commands must be unedited. Leading factory markers cannot be commands, but a request may
mention a marker. Only the owner's request text can grant `Allow:` exemptions.

Before querying issues for a repository without a boundary, the poll calls
`gh api --include rate_limit` with that repository's identity and saves its valid HTTP `Date`
header as the fixed enable boundary. This request does not count against GitHub's rate limit.
That initialization poll does no further work for the repository, including when it has no open
issues. A failed request or missing or invalid header leaves it uninitialized until a later poll.
Comments must be strictly newer than the boundary, even after an issue reopens. The boundary
uses GitHub time, independent of issue activity and the daemon's clock. Malformed issue responses
and API errors never consume commands. Existing stored boundaries remain fixed.

Each command is recorded by repository and comment id in the run-creation transaction, so
restarts, repeated polls and overlapping webhook deliveries cannot start it twice. A claim
refusal is final and recorded too: post a new command after the claiming run finishes.
Other errors remain retryable. Skipped comments are never recorded.

This assumes a command remains among the last 20 comments at some poll (normally every 180 s).
More than 20 comments between polls can hide a command; there is no comment pagination or
cursor. Large comment counts do not affect label eligibility. Webhooks are optional for these
commands: a trusted issue `issue_comment.created` delivery hints a poll, coalesced with any poll
already running, and is recorded as ignored. Hints wait at least 30 seconds from the previous
tick's start and honor rate-limit reset deadlines. After an API failure, hints cannot shorten
the regular polling retry delay. Owner comments on pull requests, including in queue repositories,
and issue comments outside queue repositories still start runs directly through webhooks and
record the same comment id.

Managed issue runs use polling lifecycle comments instead of legacy notifier comments.
Marked queue runs outside managed repositories keep suppressing legacy comments. GitHub
questions and approvals remain later slices.

## Epic attention

Keep one list item per planned slice under an exact `## Slices` heading. Once filed,
start its text with `#N` for a child in the epic's repository, or `owner/repo#N` for a
child in a named repository (compared case-insensitively). The positive issue number
must be followed by whitespace, punctuation, or the end of the line; `#3abc` does not
count. Only that leading reference identifies the slice; later references are ignored,
so `#99 Build #123` cannot name child #123. Unrelated issues do not count.
Mark the acceptance child with an `Acceptance:` prefix followed by whitespace and
the leading reference. Links, autolinks, bare URLs, code spans, escaped references,
and references after descriptive text name no slice.

```markdown
## Slices
- #123 Build
- owner/repo#124 Documentation
- Acceptance: #125
```

For open epics in configured queue repositories, polls emit `queue.epic_attention`
once per change of attention state, including across restarts. The first matching state wins:

1. `unfiled`: a Slices list item names no child, including closed children.
2. `needs_approval`: open children exist but none has a current `priority:0` through
   `priority:10` label or an active run claim.
3. `ready_for_acceptance`: only the acceptance child remains open. Without an explicit
   acceptance item, the sole open child must have native blockers covering every sibling,
   including closed siblings.

Body-derived attention requires a trusted author and either no edit or a trusted last
editor. Unordered and numbered lists work; fenced code and text outside Slices are ignored.
Structural states still apply to untrusted bodies. Incomplete evidence preserves the saved
state, and epics with more than 50 children produce no attention. Returning to a previously
reported state emits again after a change or clear; changing only the listed items does not.
These notifications are observations: they do not file issues, approve slices, or start work.
