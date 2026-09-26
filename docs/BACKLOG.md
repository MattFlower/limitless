# Self-hosting backlog

From M2 on, Limitless builds itself. Each item below is submitted as a run against
`MattFlower/limitless` (merge policy `pr`); the orchestrator reviews every PR, merges, and deploys
with `limitless deploy`. Status is tracked here and in the UI.

| # | Milestone | Task | Status |
|---|---|---|---|
| 1 | M3 | GitHub webhook trigger | done — #4 (+ GitHub IP allowlist by orchestrator); live on limitless-sandbox |
| 2 | M3 | MCP server + skills for Claude Code and Codex | done — #1 |
| 3 | M2 | Blind holdout scenarios | done — #3 (Codex flags fixed by orchestrator) |
| 4 | M2 | Rebase onto the moving base branch before delivery | todo |
| 5 | M3 | Discord bot | done — #2 |
| 6 | M3 | Chat concierge (UI + Discord free text) | todo |
| 7 | M4 | Direct-HTTP LLM path + local model servers | todo |
| 8 | M4 | OpenRouter spend reconciliation | todo |
| 9 | M5 | Retention and cleanup | done — #5 |
| 10 | M2 | Live CLI contract smoke tests | done — #7 (`limitless deploy --smoke`) |
| 11 | M3 | Quota alerts (Discord + UI) | done — #6 |
| 12 | M5 | Graceful (draining) deploys | todo |

---

## 1. GitHub webhook trigger

Add a GitHub webhook integration so runs can be triggered from GitHub.

- New module `src/integrations/github.ts`, mounted from `src/integrations/index.ts` as route
  `POST /webhooks/github`.
- Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `GITHUB_WEBHOOK_SECRET` from
  `cfg.secrets`) using a constant-time comparison; reject with 401 when missing/invalid. If the
  secret is not configured, the route responds 503 and startup notes say webhooks are disabled.
- Deduplicate deliveries by `X-GitHub-Delivery` using `store.recordInbox` (ignore repeats with 200).
  Record every delivery in the inbox with its outcome (`ignored`, `run_created`, `error`) and a note.
- Only act for the owner configured as `cfg.githubOwner` (and `dependabot[bot]` for Dependabot PRs).
  Everything else is recorded as `ignored`. Issue/PR text is untrusted: quote it into the run
  prompt as data, never as instructions.
- Triggers:
  - `issues` with action `labeled` and label `limitless` → run with the issue title + body as the
    prompt, `sourceRef` {kind:"issue", repo, number}.
  - `issue_comment` `created` whose body starts with `/limitless ` by the owner → run with the text
    after the command plus the issue context.
  - `pull_request` `opened`/`reopened`/`synchronize` by `dependabot[bot]` → a `quick` profile run
    whose prompt asks to verify the dependency update (run gates, fix breakages caused by the bump),
    with the run's base branch set to the PR's head branch so the fix lands on Dependabot's branch.
    If that needs engine support (base branch = PR head, deliver by pushing to that branch and
    commenting instead of opening a new PR), add it cleanly.
- Report back on GitHub with the `gh` CLI (factory context, not agents): comment on the
  issue/PR when a run is created (with run id) and when it finishes (status, PR link, cost). Use a
  small notifier that subscribes to store run updates and only reacts to runs with a GitHub
  `sourceRef`.
- Tests: signature verification (valid/invalid/missing), dedupe, owner filtering, each trigger
  mapping to the right CreateRunRequest, and that untrusted text is quoted. Use recorded sample
  payloads; never call GitHub in tests (inject the `gh` runner).
- Document setup in README (webhook URL `https://limitless.mattflower.cc/webhooks/github`, content
  type JSON, secret, events: Issues, Issue comments, Pull requests).

## 2. MCP server + skills

Expose the factory to other agents (Claude Code, Codex) over MCP, plus skills that teach them when
to use it.

- `src/integrations/mcp.ts` using `@modelcontextprotocol/sdk`: tools `limitless_create_run`
  (repo, prompt, optional title/profile), `limitless_get_run` (id → status, stage, PR, cost, open
  questions, last 20 non-debug events), `limitless_list_runs` (status filter, limit),
  `limitless_cancel_run`, `limitless_answer_question` (run id, answer), `limitless_providers`
  (quota/health). Tool descriptions must be written for an LLM caller: what it does, when to use it,
  what comes back.
- Two transports: `limitless mcp` (stdio; proxies to the daemon's HTTP API at `LIMITLESS_URL`) and
  Streamable HTTP mounted on the daemon at `/mcp` (localhost only — reject requests arriving through
  the Cloudflare tunnel, as the rest of the API does). Runs created via MCP use source `mcp`.
- `integrations/claude-plugin/` — a Claude Code plugin: `.claude-plugin/plugin.json`, `.mcp.json`
  (stdio server via `bun <repo>/src/cli/main.ts mcp`), and `skills/limitless/SKILL.md` describing
  when to delegate (long-running, parallelizable or background work; "have the factory do X"), how
  to write a good task prompt, and how to follow up. Include a `marketplace.json` so it can be added
  with `/plugin marketplace add`.
- `integrations/codex/` — the same SKILL.md under `.agents/skills/limitless/` and a documented
  `~/.codex/config.toml` `[mcp_servers.limitless]` snippet.
- `limitless integrations install` CLI command that installs the skill for Codex
  (`~/.agents/skills/limitless`) and prints the Claude Code plugin install command. Never edit the
  user's existing config files without an explicit `--write` flag; default is to print instructions.
- Tests: tool handlers against a Factory with the fake harness (create → get → cancel), input
  validation errors, and stdio proxy request mapping.
- README section: using Limitless from Claude Code and Codex.

## 3. Blind holdout scenarios

Add StrongDM-style holdout checks that the implementer never sees (see docs/ARCHITECTURE.md §3).

- New stage `holdout` for `standard`/`deep` profiles: after `spec`, a separate invocation (role
  `holdout`, read-only, different vendor than the spec author when possible) writes 3–8 concrete
  scenarios from the original request + spec only: each with id `H-n`, a description, exact steps
  (commands to run / inputs) and the expected observable outcome, including at least two edge or
  failure cases not literally listed in the acceptance criteria. Zod schema + strict JSON schema.
- Start it concurrently with the first implement round (it must not delay implementation); await it
  before verify. Store scenarios in run state and as an artifact that is only written after
  delivery (the implementer must not be able to read them from disk during the run).
- `verify` receives both the acceptance criteria and the holdout scenarios, reports each `H-n` with
  met/unmet/unclear + evidence. Unmet holdout scenarios produce implementer feedback that describes
  the *observed failure* without revealing the scenario text verbatim.
- PR report gets a "Holdout scenarios" table.
- Tests with the fake harness: holdout runs in parallel with implement, verify prompt contains the
  scenarios, feedback for an unmet scenario does not contain the scenario's steps, resume after a
  restart doesn't lose the scenarios.

## 4. Rebase before delivery

When the base branch moved while a run was working, deliver should rebase instead of opening a PR
that conflicts.

- In `deliver`, fetch the base branch; if it advanced past `run.baseSha`, rebase the run branch onto
  it. On a clean rebase, re-run the gates (not review/verify) and only deliver if nothing regressed;
  update `baseSha`.
- On conflicts: abort the rebase and run one extra implement round whose feedback tells the agent to
  merge the new base (`git merge origin/<base>`), resolve conflicts preserving both intents, and
  re-run checks; then continue through gates/audit/review as usual.
- Tests with local git repos: base advanced without conflict (rebased, gates re-run), with conflict
  (extra round), base unchanged (no-op).

## 5. Discord bot

`src/integrations/discord.ts` using discord.js (enabled when `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`
and `DISCORD_GUILD_ID` are set).

- Guild slash commands: `/build repo:<string> prompt:<string> [profile]`, `/runs [status]`,
  `/run id:<string>`, `/cancel id:<string>`. Only the owner (`cfg.discordOwnerId`, configurable)
  may create or cancel runs; others get an ephemeral refusal.
- Each run started from Discord gets a thread; post concise progress updates (stage transitions,
  questions, final status with PR link and cost) — rate-limited and batched so a run posts at most
  ~10 messages. Replies in the thread from the owner answer open questions.
- Notifications for runs started elsewhere are optional (config flag) and go to a configured channel.
- Keep all Discord API calls behind a small interface so tests can use a fake client. Tests:
  command → CreateRunRequest mapping, owner check, message batching, thread reply → answer.

## 6. Chat concierge

A conversational front door shared by the UI `/chat` page and Discord free-text mentions.

- `src/concierge.ts`: given a conversation (stored in `chat_messages`), a cheap model (role `chat`)
  returns a structured action: `reply` (text), `propose_run` (repo, prompt, profile, title — shown
  for confirmation), `create_run` (only after the user confirmed a proposal), `status` (run id or
  "recent"), `answer_question` (run id, answer). The daemon executes actions; the model never calls
  APIs directly. Include known repos and recent runs in the context.
- API: `POST /api/chat/:conversationId/messages`, `GET /api/chat/:conversationId`; SSE updates.
- UI: the `/chat` page with a message list, proposal cards with Confirm/Edit buttons, and links to
  created runs.
- Tests with the fake harness for each action type and for confirmation being required before a run
  is created.

## 7. Direct-HTTP LLM path + local model servers

- `src/harness/llm.ts`: single structured completions over OpenAI-compatible HTTP
  (`/v1/chat/completions` with `response_format: json_schema`, falling back to extract-and-validate
  with one retry) for providers with an OpenAI-compatible endpoint (mtplx, twilight llama.cpp,
  OpenRouter). Use it for roles that don't need tools (triage, chat, summarize) so local models
  don't pay Claude Code's large system prompt.
- Provider config gains `openaiBaseUrl`. Manage local servers: `limitless local up|down|status`
  starts/stops `mtplx serve` on the Mac and a llama-server systemd user unit on twilight over SSH
  (unit file generated by the command; model path configurable).
- Tests with a local fake OpenAI-compatible server (Bun.serve in the test).

## 8. OpenRouter spend reconciliation

- Periodically (and before metered invocations) read `GET https://openrouter.ai/api/v1/key` to get
  actual usage and limit; feed it into the tracker so the $50 budget is enforced on real numbers,
  not only local estimates. Surface both in `/api/providers`.
- Record per-invocation cost from token counts × the model's price (already done) and flag drift
  >20% vs. the key usage delta in the event log.
- Tests with a stubbed fetch.

## 9. Retention and cleanup

- Remove worktrees of finished runs after N days (default 3; failed runs 7), prune `git worktree`
  metadata, delete per-run log files after 30 days, and cap the `events` table by deleting debug
  events older than 14 days. Run hourly in the daemon; `limitless gc [--dry-run]` on demand.
- Tests on temp directories and a temp DB.

## 10. Live CLI contract smoke tests

Unit tests use the fake harness, so nothing verifies that the flags and stream formats we rely on
still work with the installed `claude` and `codex` binaries. Twice already (Codex models on the
ChatGPT plan; Codex no-tools flags) a PR passed every gate and still failed against the real CLI.

- `scripts/smoke.ts`, run with `bun run smoke` (never part of `bun run check` or CI — it spends a
  little subscription quota and needs local logins). Each check runs the real harness function
  (`runClaude` / `runCodex`) against a throwaway temp git repo with the cheapest model on that
  provider and a tiny prompt, with a short timeout, and prints a pass/fail table with durations:
  - claude: read-only structured output (json schema) returns the expected object; `noTools` really
    has no file access (ask it to read a file containing a random token; the token must not appear);
    edit mode can write a file; the stream reports rate-limit windows.
  - codex: same four checks (structured output, `noTools` cannot read the token, edit mode writes,
    rate-limit windows read from the rollout).
  - each local/metered provider that is healthy (mtplx, twilight, OpenRouter via the claude
    harness): structured output works (recovered from prose is acceptable).
  - Skip providers that are disabled or down, and say so.
- `limitless deploy --smoke` runs it after the check gate and before restarting; a failure aborts
  the deploy like a failing check does. Document in docs/OPERATIONS.md.
- A unit test for the smoke runner's reporting logic with injected fake check functions.

## 11. Quota alerts

Tell the operator when a subscription reaches its reserve, so banked resets can be applied in time.

- When a provider transitions into `exhausted` (quota reserve reached, or a hard limit hit), or
  crosses 75% of its reserve for the first time in a window, emit one alert per provider per window:
  a Discord message in the configured channel (when Discord is enabled) and a banner on the UI
  dashboard (a new `alerts` field on `/api/providers` or a small `/api/alerts` endpoint).
- Include the provider, which window, utilization, when it resets, and what the router will do
  meanwhile (which providers it falls back to).
- Tests with a fake Discord port and a fake clock: one alert per window, no alert storms on
  flapping, reset clears it.

## 12. Graceful deploys

Every `limitless deploy` restarts the daemon, interrupting in-flight runs; they resume at the start
of their current step, but the model work already done in that step is lost.

- Add `POST /api/admin/drain` (localhost only, same CSRF rules as other mutations) and
  `POST /api/admin/resume`: while draining, the scheduler starts no new runs; `/api/health` reports
  `draining: true` and the active run ids.
- `limitless deploy` (after the check/smoke gates pass) drains, waits until no runs are active or
  until `--max-wait` (default 45 minutes) expires, then restarts; `--now` skips waiting. On rollback
  or failure, it resumes the scheduler. Print progress while waiting (active runs and their stages).
- The daemon starts un-drained after a restart. Show a "draining" banner in the UI.
- Tests: drain stops new starts but not active runs; deploy waits and times out correctly (inject a
  fake health client and clock).

