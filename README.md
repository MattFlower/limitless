# Limitless

A personal **software factory**. Give it a prompt and a repository; it plans, implements,
verifies and delivers a pull request — routing each step to the cheapest model that is capable
enough, across your Claude and ChatGPT subscriptions, OpenRouter, and local GPUs.

```
limitless run "Add a --json flag to the export command" --repo MattFlower/some-repo -f
```

## How a run works

```
prepare ─ triage ─ (clarify) ─ spec ─┬─ implement ⇄ gates · audit · review · verify ─ deliver
                                     │   └─ feedback loops, then tier escalation
```

| Stage | What happens |
|---|---|
| **prepare** | Fresh git worktree from a cached clone; detects lint/typecheck/test commands and runs them on the *base* branch as a baseline. |
| **triage** | A cheap model classifies the task (class, complexity, risk, ambiguity) and picks a profile: `quick`, `standard` or `deep`. |
| **clarify** | Only if the request is genuinely ambiguous: the run pauses with a question (answer in the UI or with `limitless answer`). |
| **spec** | Requirements + testable acceptance criteria, grounded in the actual code. |
| **implement** | An agent edits the worktree (Claude Code or Codex under the hood). |
| **gates** | The factory re-runs the checks. A check that passed at baseline and now fails blocks the change; pre-existing failures don't. |
| **audit** | Deterministic reward-hacking checks: skipped tests, weakened assertions, suppressions, config tampering, secrets, protected paths. |
| **review** | Adversarial code review by a **different vendor's** model than the implementer, against a fixed rubric. |
| **verify** | A separate session checks every acceptance criterion by running things, not by trusting the implementer. |
| **deliver** | Commit, push, open a PR with an evidence report (criteria, checks, review, audit, per-model cost); merge per repo policy. |

Any failing gate sends structured feedback back to the implementer. After two failed rounds on
one model the implementer is escalated to a stronger one; after five rounds the run stops as
`needs_human` and opens a draft PR with everything it learned.

## Quick start

```bash
bun install
bun src/cli/main.ts serve          # daemon: API + UI on http://127.0.0.1:7400
bun src/cli/main.ts run "<prompt>" --repo owner/name -f
```

Open http://127.0.0.1:7400 for the mission-control UI (live runs, stage timelines, event logs,
diffs, reviews, quota gauges, cost).

### CLI

| Command | |
|---|---|
| `limitless serve` | Start the daemon |
| `limitless run "<prompt>" --repo <owner/name or path> [--profile auto\|quick\|standard\|deep] [-f]` | Queue a run (`-f` follows the log) |
| `limitless ls [--status running,queued]` | List runs |
| `limitless show <run>` / `logs <run> [-f]` | Details / event log |
| `limitless cancel <run>` / `answer <run> "<text>"` | Cancel / answer an open question |
| `limitless providers` | Health and quota of every provider |
| `limitless service install\|uninstall\|status` | Run the daemon (and Cloudflare tunnel) under launchd |
| `limitless deploy [ref]` | Update the release checkout, gate on `bun run check`, restart, auto-rollback |

## Configuration

Everything is optional. Files live in `~/.config/limitless/`:

- `secrets.env` — `OPENROUTER_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`,
  `GITHUB_WEBHOOK_SECRET` (chmod 600).
- `config.toml`:

```toml
[server]
port = 7400

[limits]
max_concurrent_runs = 3
max_rounds = 3
openrouter_budget_usd = 50

[reserves]            # stop using a subscription at this fraction of its window
claude_five_hour = 0.80
claude_seven_day = 0.85
codex_weekly = 0.90   # keeps 10% of ChatGPT usage free for you

[owners]
github = "MattFlower"
```

Per-repository settings go in a `.limitless.toml` at the repo root:

```toml
[gates]
setup = ["bun install --frozen-lockfile"]
checks = [{ name = "test", run = "bun test" }]

[policy]
merge = "auto"                 # auto | pr | none
protected_paths = ["migrations/**"]
```

Without it, gates are auto-detected (package.json scripts, Cargo, Go, Python, Makefile).

## Models and routing

Each role (triage, spec, implement, review, verify, …) has an ordered list of candidate models
per task complexity; models joined with `|` are interchangeable and the one whose subscription has
more headroom goes first. Providers that are out of quota, over budget, failing, or unreachable
are skipped automatically; models a provider rejects are blocked for 24 hours. See
`src/router/catalog.ts` and the **Models** page in the UI.

Subscription usage is tracked from the CLIs' own telemetry: Claude's 5-hour and 7-day
utilization arrive with every `claude -p` call, and Codex's weekly usage is read from its
session log after every `codex exec`.

## Data

`~/.limitless/` holds the SQLite database, the bare-repo cache, per-run worktrees, and raw agent
logs (`runs/<id>/inv-<n>.log`) for post-mortems.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and [`docs/research/`](docs/research/)
for the research behind it.
