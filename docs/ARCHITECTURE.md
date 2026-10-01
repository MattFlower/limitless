# Limitless — Architecture

> Status: living document. Last revised 2026-09-26 (M0).
> Research that informed these decisions lives in [`docs/research/`](research/).

Limitless is a personal **software factory**: you hand it a prompt (from the web UI, a chat,
Discord, a GitHub webhook, the CLI, or another agent via MCP) and it plans, implements, verifies
and delivers a pull request — while spending as little of your paid AI capacity as the task allows.

## 1. Design principles

1. **Deterministic orchestration, probabilistic workers.** The pipeline is ordinary TypeScript
   state-machine code. LLMs are only ever *workers inside a stage*; they never decide what the
   factory does next. This makes runs debuggable, resumable and cheap. (Every competitor that
   let an LLM orchestrate — see research/01 pitfalls — got runaway loops and cost blowups.)
2. **External verification beats self-assessment.** The implementer never grades its own work.
   Gates are run by the factory, the review verdict comes from a *different vendor's* model where
   one is available, and acceptance scenarios are written by an author who never sees the
   implementation (research/02 §1, §3, §4). In panel review mode one finder is deliberately from
   the implementer's family, possibly its own model in a fresh session (recorded in the panel
   record); nothing it reports blocks until a verifier that did not raise it confirms it.
3. **Spend is a first-class dimension.** Every invocation records tokens, $ (metered) and
   $-equivalent (subscription). Routing picks the cheapest model that is *capable enough* for the
   role, and quota headroom on subscriptions is tracked from live rate-limit telemetry.
4. **Fresh context per stage, state on disk.** Each stage starts a fresh agent session that reads
   artifacts (spec, plan, feedback) from files; nothing important lives only in a context window
   (Ralph loop / Anthropic long-running-harness guidance, research/02 §6).
5. **Everything is observable.** Every agent event (message, tool call, tool result, rate-limit
   signal, stderr) is persisted and streamed to the UI. If a run fails you can see exactly what
   the agent saw and did.
6. **Portable single binary-ish daemon.** One Bun process, one SQLite file, one data directory.
   Runs on the Mac today; moving to twilight is a config change.

## 2. System overview

```
                 ┌───────────────────────── triggers ──────────────────────────┐
  Web UI chat ──►│                                                              │
  CLI ──────────►│   HTTP API  (Bun.serve, 127.0.0.1:7400)                      │
  MCP (Claude/  ►│   /api/*  /mcp  /webhooks/*  (only /webhooks/* is public,    │
   Codex)        │                              via Cloudflare Tunnel)          │
  GitHub ───────►│                                                              │
  Discord ──────►│   Discord gateway client (in-process)                        │
                 └──────────────────────────────┬───────────────────────────────┘
                                                ▼
                     ┌────────────── Run Store (SQLite, WAL) ──────────────┐
                     │ runs · stages · invocations · events · artifacts    │
                     │ questions · repos · provider_state · inbox · chat   │
                     └───────────────┬─────────────────────────▲───────────┘
                                     ▼                         │ events (+ SSE fan-out)
                           ┌──────────────────┐                │
                           │    Scheduler     │ concurrency per provider, priorities,
                           └────────┬─────────┘ crash-resume of interrupted runs
                                    ▼
      ┌──────────────────────── Pipeline Engine (per run) ────────────────────────┐
      │ prepare → triage → spec ─┬→ implement ⇄ gates/audit ⇄ review ⇄ verify → deliver │
      │                          └→ holdout author (blind, parallel)              │
      └──────────────┬───────────────────────────────────────────┬────────────────┘
                     ▼                                           ▼
             ┌──────────────┐   route(role, class, constraints)   ┌───────────────┐
             │   Router     │◄── quota + health + budget ────────│ Provider state │
             └──────┬───────┘                                     └───────────────┘
                    ▼
      ┌──────────────────────────── Harness adapters ─────────────────────────────┐
      │ claude-cli  (Claude subscription; also OpenRouter / oMLX / llama.cpp via  │
      │              ANTHROPIC_BASE_URL — one agent harness for every Anthropic-   │
      │              compatible backend)                                           │
      │ codex-cli   (ChatGPT subscription)                                         │
      │ llm         (plain structured completions: OpenAI-compatible HTTP, or the  │
      │              CLIs in no-tools mode for subscription models)                │
      └────────────────────────────────────────────────────────────────────────────┘
                    │ runs inside
                    ▼
      git worktree per run  (~/.limitless/work/<run>) from a bare repo cache
```

## 3. The run pipeline

A **run** is one request. It moves through **stages**; each stage makes one or more
**invocations** (an agent session or an LLM call). Profiles decide which stages run:

| Stage | quick | standard | deep | Who does it |
|---|---|---|---|---|
| prepare — fetch, worktree, **baseline gates on base branch** | ✓ | ✓ | ✓ | factory (no LLM) |
| triage — classify task, size, risk, ambiguity → profile & routing | ✓ | ✓ | ✓ | cheap/local LLM, JSON schema |
| clarify — ask the human *only if* triage/spec flags blocking ambiguity | – | if needed | if needed | via the run's origin channel |
| spec — requirements + acceptance criteria (EARS-style) | – | ✓ | ✓ | mid/frontier |
| plan + plan review (cross-vendor) | – | – | ✓ | frontier ×2 vendors |
| holdout author — concrete acceptance scenarios, **blind to the diff** | – | ✓ | ✓ | mid/frontier, runs in parallel with implement |
| implement — agent edits the worktree, runs tests | ✓ | ✓ | ✓ | routed by class/tier |
| gates — setup/lint/typecheck/test, compared to baseline | ✓ | ✓ | ✓ | factory (no LLM) |
| audit — reward-hacking & scope checks on the diff | ✓ | ✓ | ✓ | factory (no LLM) |
| review — rubric review by a **different vendor** | light | ✓ | ×2 | cross-vendor |
| preview — build/seed/serve matching UI changes on loopback | – | if configured | if configured | factory (no LLM) |
| verify — run holdout scenarios, judge each acceptance criterion | – | ✓ | ✓ | different session/vendor |
| deliver — commit, push, PR with evidence report, merge policy | ✓ | ✓ | ✓ | factory (no LLM) + cheap summary |

Failures in gates/audit/review/verify send **structured feedback** back to implement (a fresh
session resumed with the feedback file), bounded by `max_rounds`. After repeated failure the
implementer is **escalated** one tier (e.g. local → Sonnet → Opus) carrying the failure context,
before the run is marked `needs_human`.

Gate suites (baseline, post-change, post-rebase, eval trials) share a process-wide pool of
`max_concurrent_gates` slots so concurrent suites don't starve each other of CPU. A check that
passed on the baseline, fails after the change, and whose output names no changed file is re-run
once; a pass on retry is recorded as `flaky` (a non-blocking warning with both outputs kept).

Prepare caches the baseline in `passing_baselines`, keyed by repo, base SHA, gate commands and an
environment hash (lockfiles, Bun version, platform/arch, Limitless build SHA, and a digest of PATH
and toolchain variables such as `npm_config_*`, `NODE_*`, `LD_*`, plus any names listed in
`[gates] baseline_env`; values are hashed, never stored, and secret-looking names in the prefix
families are excluded, while known settings such as `GOPRIVATE` and `NODE_TLS_REJECT_UNAUTHORIZED`
and operator-listed names are always included).
**Only a baseline where setup and every check passed is cached**: a failing base (possibly flaky,
even after its retry) runs again on every run, so it can never turn a later regression into a
non-blocking `still_failing`; a fresh failing baseline evicts any cached pass for its key instead.
Cacheable lookups run in a per-key single flight, so concurrent runs on one base execute the
baseline once; if the flight's baseline fails, its waiters run theirs concurrently. Entries record
the writing run and time, expire after seven days (removed by `gc`), and can be dropped with
`limitless gates clear-cache [--repo owner/name]`. `limitless run --no-baseline-cache` or
`[gates] baseline_cache = false` skips the lookup and the single flight; a passing bypass baseline
refreshes the entry. Without a known Limitless build SHA the cache is neither read nor written.

The optional preview configuration is validated and saved from the base revision during prepare,
before model calls. A matching committed diff starts an isolated preview immediately before a new
verify attempt; reused round results do not start one. Build and seed use scratch HOME/TMPDIR,
reserved environment keys are enforced, and readiness stays on the loopback preview origin. The
server and scratch are torn down on success, failure or cancellation. Browser/MCP integration is
a separate step. Older runs without a snapshot restore it once from their recorded base SHA on
resume, before any model calls; the edited worktree configuration is never used.

### Why the holdout author is blind (our twist on StrongDM's scenarios)
StrongDM keeps scenarios in a directory the agent can't read. We go one better and cheaper: the
scenarios **don't exist yet** while the implementer works. The holdout author gets the original
prompt + spec and a private, read-only export of the **base** commit (no `.git`, removed afterwards;
the daemon sweeps snapshots orphaned by a crash at start). Its tools are confined to that snapshot
and its scratch: home directories, temporary directories (other invocations' scratch and logs, CLI
transcripts under `~/.claude`/`~/.codex`) and the factory's paths are denied, so it can ground
steps in real commands and config without seeing the implementer's working state. It writes
concrete checks (commands to run, inputs/outputs, and edge cases only where the request implies
them) into the database, and the verifier executes them against the finished worktree. The
implementer can't special-case tests it has never seen.

Residual risk: the implementer's harness has no read sandbox, and the holdout runs in parallel as
the same user. While it runs, its scratch and CLI log are in the shared temporary directory. The
log keeps only JSON structure (every string is withheld), CLI sessions aren't persisted, and the
prompt tells the author to return scenario text only in its answer, but a scratch file the author
writes anyway is readable until the invocation ends.

### Reward-hacking audit (deterministic)
Flags (fed to the reviewer; some are blocking): deleted/renamed test files, net loss of
assertions, new `skip`/`only`/`xit`/`@pytest.mark.skip`, edits to test runner config / CI
workflows / lint config, new lint-disable comments, `--no-verify` usage seen in the event log,
lockfile edits outside dependency tasks, and files touched outside the planned scope.

## 4. Routing, quotas and fallback

**Model catalog** (configurable; tier 1 = weakest):

| Tier | Subscription (sunk cost) | Metered / free |
|---|---|---|
| 5 | Claude Fable 5.1, Claude Opus 5.5, GPT-6 Astra | (OpenRouter frontier — last resort) |
| 4 | Claude Sonnet 5, GPT-6 Sol | Kimi / MiniMax / DeepSeek-class via OpenRouter |
| 3 | GPT-6 Luna, Claude Haiku 4.5 | GLM Flash / DeepSeek Flash via OpenRouter |
| 2 | — | Swift-1.5 Qwen3.8 27B MTP (`omlx/qwen-27b`, Mac), twilight llama.cpp models |

The primary Mac backend is **oMLX**, managed externally by oMLX.app / `omlx start` at
`http://127.0.0.1:8989` (port 8989). Set `OMLX_API_KEY` in
`~/.config/limitless/secrets.env` for inference and authenticated `/v1/models` health probes.
Limitless defaults to 4 concurrent oMLX requests; override in `config.toml` with:

```toml
[providers.omlx]
max_concurrent = 8
```

Select `omlx/qwen-27b` for backend `Swift-1.5-Qwen3.8-27b-oQ8e-mtp`. Tool-free roles accept
`omlx/qwen-27b@none` / `omlx/qwen-27b@high` to turn thinking off/on; compare them with
`limitless eval run triage --models omlx/qwen-27b@none,omlx/qwen-27b@high --follow`.
Agentic roles require the bare ID, preserving server-default thinking. Built-in triage,
summarize and chat prefer oMLX; the committed `routing/policy.json` overlay remains authoritative
where present. `limitless local up|down|status` only reports Mac endpoint reachability, including
on `down`; it does not manage the Mac server or provider enablement. Twilight retains lifecycle
controls. For rollback, `limitless service install --mtplx` explicitly installs the old agent;
enable `mtplx` if disabled and select `mtplx/qwen-27b`. Default installation omits that agent and
does not remove existing installations.

**Routing** = `route(role, taskClass, complexity, constraints)` → ordered candidates filtered by:
- **health** — circuit breaker per provider (consecutive failures → cooldown),
- **quota headroom** — Claude: `rate_limit_event.unifiedWindows` (5-hour & 7-day utilization)
  captured from every `claude -p` call; Codex: `rate_limits.used_percent` read from its session
  rollout after every `codex exec`. Reserves are config (default: Codex stops at 90% to honor the
  "leave 10%" rule; Claude stops at 80% five-hour so your interactive use isn't starved),
- **budget** — OpenRouter spend vs. the $50 cap (and per-run budgets),
- **vendor constraints** — the reviewer avoids the implementer's vendor. A panel verifier never
  reuses a model that raised the candidate; it prefers a vendor that neither raised it nor
  implemented the change, then the implementer's, then a raising vendor.

When two subscriptions can both serve a role, the router prefers the one with **more headroom**,
spreading load across Claude and ChatGPT.

**Failure classes** are distinguished: `quota` / `unavailable` (→ try next provider, mark state
until reset), `timeout` / `stuck` (→ retry once, then next candidate), and `task failure`
(→ feedback round or tier escalation). Only the last one counts against the task.

## 5. Harnesses

All agent work goes through one interface:

```ts
runAgent(spec: AgentSpec): AsyncIterable<AgentEvent> & { result: Promise<AgentResult> }
```

- **claude-cli** spawns the official `claude -p --output-format stream-json`. Using the official
  binary with your own login is the supported way to automate a Claude subscription (research/03 §1).
  The *same adapter* drives OpenRouter, oMLX and llama.cpp by setting `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` — all of them speak the Anthropic Messages API. Factory runs use
  `--setting-sources project` + an explicit `--settings` so your personal hooks/plugins don't
  fire inside factory runs.
- **codex-cli** spawns `codex exec --json` (sandbox `workspace-write`), then reads the session
  rollout for rate-limit telemetry.
- **llm** does single structured calls (triage, judging, summaries): OpenAI-compatible HTTP for
  local/OpenRouter models, or `claude -p --json-schema --tools ""` / `codex exec --output-schema`
  for subscription models.
- **decisions** asks a decision model (TypeSafe Jev) typed questions — choice, score, yes/no — and
  maps the answer probabilities to a role's output in code. Only roles with a decisions mapping
  (triage) can route to it (research/09).

Safety rails in every adapter: wall-clock timeout, inactivity timeout, identical-tool-call loop
detection, per-invocation budget, process-group kill on cancel.

## 6. Isolation & git

- Bare repo cache `~/.limitless/repos/<owner>__<name>.git`, fetched before each run.
- One worktree per run at `~/.limitless/work/<run-id>` on branch `limitless/<run-id>-<slug>`.
- Local-only (non-GitHub) repos are supported: worktrees come straight from the local clone and
  delivery leaves a branch instead of a PR.
- Agents run with the CLIs' own sandboxes (Seatbelt on macOS) where they're compatible with the
  repo's toolchain; secrets for Discord/GitHub/OpenRouter are scrubbed from agent environments.
- Triggers are **allowlisted** (your GitHub login, `dependabot[bot]`, your Discord user id).
  Untrusted issue/PR text is treated as data and quoted, never as instructions.

## 7. Persistence

SQLite (`bun:sqlite`, WAL) at `~/.limitless/limitless.db`; large artifacts (event logs, diffs,
prompts) as files under `~/.limitless/runs/<run-id>/`. Tables: `repos`, `runs`, `stages`,
`invocations`, `events`, `artifacts`, `questions`, `provider_state`, `inbox` (webhook dedupe +
audit), `chat_messages`, `settings`. The frozen legacy migrations and timestamped SQL files are applied at startup.

On startup, runs left `running` by a crash/restart are re-queued and resume at the start of their
current stage (the worktree is preserved; Claude sessions can be resumed).

## 8. Interfaces

| Surface | What it does |
|---|---|
| **Web UI** (SolidJS) | Mission control: live runs, queue, quota gauges, spend; run detail with stage timeline, invocations (model/cost/tokens/duration), live event log, spec/diff/review/verdict artifacts, questions, cancel/retry; chat to start runs. |
| **CLI** `limitless` | `run`, `ls`, `show`, `logs -f`, `cancel`, `answer`, `serve`, `mcp`, `deploy`. |
| **Chat concierge** | Shared by UI chat and Discord: turns free text into a confirmed run, answers status questions. Runs on a local model when available. |
| **GitHub** | `POST /webhooks/github` (HMAC-verified): Dependabot PRs → `quick` verify-and-merge; issue labeled `limitless` or `/limitless …` comment by the owner → run; CI failure on a factory PR → fix run. |
| **Discord** | `/build`, `/runs`, `/show`, `/cancel`; one thread per run with progress, questions and the final report. |
| **MCP + skills** | `limitless mcp` (stdio) and `/mcp` (HTTP) expose create/get/list/cancel/answer tools; `SKILL.md` for Claude Code (plugin) and Codex (`.agents/skills`). |
| **Generic webhook** | `POST /webhooks/generic/<token>` for anything else (cron, IFTTT, scripts). |

## 9. Self-hosting

The factory runs from a **release checkout** (`~/.limitless/app`, tracking `main`) under launchd,
never from the tree it is modifying. Improvements to Limitless are made *by Limitless*: the
orchestrator (Claude, in this session) files runs against `MattFlower/limitless`, reviews the PRs
the factory produces, merges, and runs `limitless deploy` (pull → install → build UI → restart).
The limitless repo's merge policy is `pr` (reviewed by the orchestrator) even though your other
repos default to auto-merge when all gates pass.
