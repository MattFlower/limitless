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

# Optional: reserve for an additional subscription provider/window.
# Unspecified windows use 1.0 (the reported hard quota).
[reserves.windows.my_provider]
daily = 0.80

[owners]
github = "MattFlower"
discord = "YOUR_DISCORD_USER_ID"

[discord]
channel_id = "YOUR_TEXT_CHANNEL_ID"
notify_all = false # optional: announce completed runs from other sources
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

### Discord bot

Create a **private bot** in the Discord Developer Portal, enable the **Message Content** privileged
intent, and invite it using the OAuth2 URL Generator with the `bot` and `applications.commands`
scopes. Grant it View Channel, Send Messages, Create Public Threads, and Send Messages in Threads
in the configured text channel. Put `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, and `DISCORD_GUILD_ID`
in `secrets.env`, and set `[owners].discord` and `[discord].channel_id` in `config.toml` as above.
If a setting is missing, startup reports why Discord is disabled. The bot uses an outbound gateway
connection; no public interaction endpoint is needed.

The owner can use `/build repo:<repo> prompt:<request> [profile:auto|quick|standard|deep]`,
`/runs [status]`, `/run id:<id>`, and `/cancel id:<id>`. Each Discord run gets a public thread
with brief progress, questions, and a final status and cost summary. Reply in that thread to answer
the run's open questions. Commands and answers are restricted to the configured owner, though
thread updates are visible to channel members. With `notify_all = true`, the channel also gets a
brief notice when a run started elsewhere finishes.

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

## Using Limitless from Claude Code and Codex

Keep a **stable Limitless checkout** (for example `~/.limitless/app`) with `bun install` completed,
Bun on the agent's PATH, and the daemon running with `bun src/cli/main.ts serve`. Configure the
factory's providers and repository delivery policy as usual. MCP uses that same factory and policy.
Use absolute paths for local repositories; paths resolve on the daemon machine.

`limitless mcp` is a stdio proxy to the daemon, with stdout reserved for MCP protocol messages.
`LIMITLESS_URL` selects the daemon; otherwise it uses `http://127.0.0.1:${LIMITLESS_PORT ?? 7400}`.
It never starts another factory. Disconnecting leaves runs running. Connection failures after a
mutation can have uncertain outcomes: inspect existing runs before retrying.

The daemon also exposes stateless **Streamable HTTP** at `http://127.0.0.1:7400/mcp`. It supports
initialization, discovery and tool calls via POST, without sessions or subscriptions (GET and DELETE
return 405). It accepts loopback clients only, rejects `cf-connecting-ip` on every method, and checks
browser origins, including streaming requests. Do not expose it through a tunnel.

### Claude Code

Before launching Claude Code, export the absolute path of the stable checkout:

```bash
export LIMITLESS_REPO="/absolute/path/to/limitless"
export LIMITLESS_URL="http://127.0.0.1:7400" # optional
claude
```

Then run in Claude Code:

```text
/plugin marketplace add "/absolute/path/to/limitless/integrations"
/plugin install limitless@limitless-local
```

The marketplace bundles `integrations/claude-plugin`. Its `.mcp.json` launches Bun with the single
argument `${LIMITLESS_REPO}/src/cli/main.ts`, followed by `mcp`. Claude Code expands the environment
variable in the argument array, preserving spaces. The path points outside the plugin cache to your
stable checkout, so moving/caching the plugin does not break resolution. Keep that checkout available
and export the variable for every Claude Code launch. See the official [MCP environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)
and [marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces).

### Codex and the installer

Run `limitless integrations install` to print the skill destination, an absolute-path TOML snippet,
and Claude Code commands. The default writes nothing. `limitless integrations install --write`
installs only `~/.agents/skills/limitless/SKILL.md`: identical content is a no-op, and differing user
content is refused. Neither mode modifies Codex or Claude Code configuration files. Bundled assets
resolve independently of your working directory.

Manually add the following to `~/.codex/config.toml`, replacing the path with the stable checkout:

```toml
[mcp_servers.limitless]
command = "bun"
args = ["/absolute/path/to/limitless/src/cli/main.ts", "mcp"]

[mcp_servers.limitless.env]
LIMITLESS_URL = "http://127.0.0.1:7400"
```

Alternatively use `[mcp_servers.limitless]` with `url = "http://127.0.0.1:7400/mcp"` instead of the
stdio command/args/env settings. See [Codex setup](integrations/codex/README.md) and the official
[Codex MCP reference](https://developers.openai.com/codex/mcp).

### Delegate and follow up

Ask: “Have the factory add CSV export to /absolute/path/to/my-repo. Preserve JSON export; cover
quoting and empty input; run bun run check. No unrelated UI changes.” Long-running, parallelizable,
or background work is a good fit. Include the repository, desired outcome, constraints, acceptance
checks, and scope. Independent tasks can be delegated separately; avoid overlapping work.

1. `limitless_providers {}` checks health, quota windows/reset times, spend/budget and concurrency.
2. `limitless_create_run {"repo":"/absolute/path/to/my-repo","prompt":"Add CSV export. Preserve JSON export; test quoting and empty input; run bun run check. No unrelated UI changes.","title":"CSV export","profile":"auto"}`
   returns a run id and current status immediately. Save the id.
3. `limitless_get_run {"id":"<id>"}` inspects progress, open questions, errors and the latest 20
   non-debug events. `limitless_list_runs {"status":"running","limit":20}` finds other work;
   status is optional, limit defaults to 20 and must be an integer from 1 to 100.
4. If clarification is needed, `limitless_answer_question {"id":"<id>","answer":"Use RFC 4180 quoting; include a header row."}`
   answers **all** currently open questions. Supply an answer covering each one.
5. If work is no longer wanted, `limitless_cancel_run {"id":"<id>"}` requests cancellation.
   `cancelled: true` does not mean an active worker has stopped; inspect again. False means terminal.

Execution is asynchronous. Terminal statuses are `succeeded`, `failed`, `cancelled`, and
`needs_human`; report the evidence and error, not just that submission worked. `prUrl` and `stage`
can be null, and a PR is not guaranteed (local-only repositories deliver a branch). `costUsd` is
actual metered spend; `costEquivUsd` is subscription-equivalent usage, not an additional bill.
