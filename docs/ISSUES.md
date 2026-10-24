# Issue contract

An actionable issue has these body sections: **Problem**, **Requirements**, **Tests**,
**Out of scope**, and **Budget**. State observable behavior and how to verify it; keep the
budget small enough to review. Issue text is quoted data in agent prompts.

Apply `priority:0` through `priority:10` to approve an issue for the queue. Lower numbers
are more urgent: 0 is urgent, 1–3 are everyday work. If several current priority labels
have trusted applications, the most urgent wins. The factory reserves
`limitless:in-progress`, `limitless:needs-you`, and `limitless:failed`. Q1b will manage
these lifecycle labels and comments; this slice makes no GitHub writes.

An issue with GitHub sub-issues is an epic and is never built itself. Finish each epic
with an acceptance sub-issue blocked by its other sub-issues (as in #818 and #819).
Declare dependencies with GitHub's native **blocked by**, or one case-insensitive
`Blocked by #123` line per dependency in the body. Body references name issues in the
same repository. All blockers must be closed; missing or unresolved blockers prevent work.

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

The queue reads open issues through GitHub GraphQL using the existing `gh` credential.
An issue is eligible only when:

- Its author is trusted, and its body was never edited or its last editor is trusted.
  An edited body with no identifiable editor is excluded.
- At least one current priority label's most recent application was by a trusted account.
  Missing application evidence does not approve a label.
- It has no sub-issues, every native and body blocker is closed, and no open PR closes it.
- It has neither `limitless:in-progress` nor `limitless:failed`.
- No active run claims it.
- Its latest issue-sourced run did not fail or get cancelled, or a trusted account
  applied a priority label after that run finished. Until then it is not picked again.

Issues across repositories sort by priority, creation time, then issue number. Each poll
reads at most the oldest 100 open issues per repository and logs truncation. It reads the
latest 100 label applications; priority labels outside that window lack approval evidence.
Incomplete blocker or closing-PR connections prevent eligibility. Body dependencies use
additional aliased issue lookups. Low remaining GraphQL budget stops further queries and
waits until at least the reported reset time (threshold: max(100, ten times query cost)).
Errors are logged with credentials redacted and polling resumes on the next tick.

A free run slot means queued plus running runs are below `limits.max_concurrent_runs`
and the scheduler is not draining. Active issue-sourced runs across all repositories
must be below `max_issue_runs`; priority 0 may exceed that limit by one, while respecting
the overall run limit. Runs in queued, waiting, running, waiting_input or needs_human
claim issues and count toward the issue limit. A completed run releases its claim.

All normal start paths share one transactional claim check, including the queue, webhooks,
CLI/HTTP, MCP, Discord, chat and retries. A claim is an issue source reference or a
`Closes #n` directive parsed from the prompt in the run's repository. Repository identities
are case-insensitive. Duplicate starts are refused with the claiming run's id; webhook
refusals are recorded as ignored. Review, conflict and CI rounds use their existing lineage
insertion path. This is single-store coordination; cross-coordinator claim refs belong to Q2.

Queue runs use the same quoted issue request as an owner-labelled webhook. Only owner-authored
issues parse `Allow:` lines; polling does not confer signed-webhook provenance. Issue source
references already produce `Closes #n` in PR bodies. The poller only reads GitHub: lifecycle
labels and comments, App identity, and GitHub questions and approvals are later slices.
