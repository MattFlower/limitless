<!-- Research report produced by a Claude Sonnet 5 research subagent on 2026-09-26. Figures marked unverified should be re-checked. -->

# Software Factory Building Blocks — Research Report
*(TypeScript/Bun, SQLite, SolidJS, macOS M5 Max + Linux worker — researched 2026-09-26)*

---

## 1. Driving Agent CLIs Headlessly

### 1.1 Claude Code (`claude -p`)

Verified locally against **claude-code 2.1.281** (`claude -p --help`). Key flags:

- `-p, --print` — non-interactive, print-and-exit mode (required for everything below).
- `--output-format <text|json|stream-json>` — `json` gives one final object; `stream-json` gives NDJSON, one event/line.
- `--input-format <text|stream-json>` — `stream-json` lets you feed multi-turn input programmatically (send `SDKUserMessage` objects on stdin).
- `--verbose`, `--include-partial-messages` (token-level deltas), `--include-hook-events`.
- `--model <alias|full-name>` (aliases: `sonnet`, `opus`, `haiku`, `fable`).
- `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>` — **note:** this differs from the Agent-SDK's `Options.permissionMode` enum (`default|plan|bypassPermissions|preview`) documented on the SDK page — the CLI and SDK type surfaces have diverged; verify against your installed version before hard-coding.
- `--allowedTools` / `--disallowedTools <tools...>` (e.g. `"Bash(git *)" Edit`).
- `--append-system-prompt <prompt>`, `--system-prompt <prompt>`, `--system-prompt-snapshot on|off`.
- `--mcp-config <configs...>` (JSON files or inline strings), `--strict-mcp-config`, `--settings <file-or-json>`.
- `--session-id <uuid>` (fixed ID for a new session) and `-r, --resume [value]` / `-c, --continue` (resume/continue existing sessions); `--fork-session` to branch instead of continuing.
- `--max-budget-usd <amount>` — dollar spend cap (only flag of this kind found).
- **Unverified/flag not found:** I could not find a `--max-turns` CLI flag in the current `--help` output, even though `maxTurns` exists as an **Agent SDK** `Options` field. If you need a turn cap from the CLI, it may need to go through `--max-budget-usd`, a wrapper using the SDK directly, or has been renamed/removed since your training/expectation — confirm with `claude -p --help` on your machine.
- `-w, --worktree [name]` — Claude Code can create its own git worktree per session (useful for your isolation layer, see §2).
- `--allow-dangerously-skip-permissions` / `--dangerously-skip-permissions` — bypass all permission checks (sandboxes only).

**stream-json event shapes** (confirmed via Anthropic docs + community cheatsheets):
```json
{"type":"system","subtype":"init","session_id":"…","cwd":"/repo","model":"sonnet","tools":["Bash","Read"],"mcp_servers":[{"name":"approvals","status":"connected"}]}
{"type":"assistant","session_id":"…","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"…"}],"usage":{"input_tokens":120,"output_tokens":45}}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls -la"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"…"}]}}
{"type":"result","subtype":"success","session_id":"…","total_cost_usd":0.0123,"is_error":false,"duration_ms":12345,"duration_api_ms":12000,"num_turns":2,"result":"Done.","usage":{"input_tokens":150,"output_tokens":70,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
```
Important nuance from the official [cost-tracking doc](https://code.claude.com/docs/en/agent-sdk/cost-tracking): `total_cost_usd`/`usage` on the `result` event are **client-side estimates**, cumulative for the *session* when you `resume`, and per-*call* otherwise; in streaming-input mode each turn emits its own `result` and you must read the *latest* one, not sum them. `total_cost_usd` and `costUSD` are explicitly documented as **not authoritative billing data**.

**Claude Agent SDK (TypeScript, `@anthropic-ai/claude-agent-sdk`)** — `query({ prompt, options })` returns an `AsyncGenerator<SDKMessage>`. Key `Options` fields: `model`, `cwd`, `maxTurns`, `maxBudgetUsd`, `effort`, `permissionMode`, `allowedTools`/`disallowedTools`, `canUseTool` (custom permission callback), `mcpServers`, `systemPrompt`, `agents` (define subagents programmatically), `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`, `resume`/`continue`/`forkSession`, `abortController`, `env`, `executable: 'bun'|'deno'|'node'`. Cancellation:
```ts
const controller = new AbortController();
const p = (async () => { for await (const m of query({ prompt, options: { abortController: controller } })) { /* … */ } })();
setTimeout(() => controller.abort(), 5000);
```
**Bun compatibility is explicit and first-class**: the SDK auto-detects `bun`, and for compiled single-executable builds there's a documented pattern using `@anthropic-ai/claude-agent-sdk-darwin-arm64` + `extractFromBunfs` to bundle the native `claude` binary. A `/core` subpath entry point (`@anthropic-ai/claude-agent-sdk/core`) trims bundle size. Auth: `ANTHROPIC_API_KEY` env var or the CLI's own OAuth/keychain session (the SDK shells out to the `claude` binary, so whatever auth that binary has works).

### 1.2 Codex (`codex exec`)

Verified locally against **codex-cli 0.154.0**:
- `codex exec [OPTIONS] [PROMPT]`, subcommands `resume`, `fork`, `review`.
- `-s, --sandbox <read-only|workspace-write|danger-full-access>`.
- `-c, --config <key=value>` (dotted TOML path override, e.g. `-c model="o3"`), `--enable/--disable <FEATURE>`.
- `--oss` / `--local-provider <lmstudio|ollama>` — first-class support for local models.
- `-C, --cd <DIR>`, `--worktree` (**"Run the session in a new managed Git worktree"** — built-in, directly usable for your isolation design), `--add-dir`.
- `--ephemeral` (no session persistence), `--skip-git-repo-check`, `--output-schema <FILE>` (JSON-schema-constrained final answer).
- `--json` — JSONL events to stdout. `-o, --output-last-message <FILE>` — writes only the final agent message to a file.
- `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me` (routes approvals through automatic review under `workspace-write`).
- `codex exec resume [SESSION_ID] [PROMPT] --last --all` — resume most recent or a specific session; `codex exec resume --last "fix the race conditions you found"`.

**JSONL event schema** (confirmed from `learn.chatgpt.com/docs/non-interactive-mode`):
```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```
Item types include `agent_message`, `reasoning`, `command_execution`, `file_change`, MCP tool calls, web searches, plan updates; an `error` event type exists but its exact shape wasn't documented on the fetched page (unverified).

**`@openai/codex-sdk` (TypeScript)** wraps the CLI over stdin/stdout JSONL, Node 18+:
```ts
import { Codex } from "@openai/codex-sdk";
const codex = new Codex({ env, config, configOverrides, baseUrl });
const thread = codex.startThread({ workingDirectory, skipGitRepoCheck });
// or: codex.resumeThread(threadId) — restores from ~/.codex/sessions
const turn = await thread.run("Diagnose the failing test"); // buffers to completion
const { events } = await thread.runStreamed("Diagnose the test failure and propose a fix");
for await (const event of events) {
  if (event.type === "item.completed") console.log(event.item);
  if (event.type === "turn.completed") console.log(event.usage);
}
```
Auth: the SDK spawns the `codex` CLI, so it inherits whatever the CLI is authenticated with — ChatGPT login (OAuth, the default interactive flow) or an API key via `CODEX_API_KEY`/config. Exact ChatGPT-login-vs-API-key selection logic inside the SDK itself wasn't spelled out in the README fetch — treat as **unverified detail**, confirm via `codex login status` locally.

### 1.3 Open-source harnesses for OpenRouter / local endpoints

| Harness | Headless invocation | JSON/event stream | Notes |
|---|---|---|---|
| **OpenCode** (`sst/opencode`, now `open-code.ai`) | `opencode run -m provider/model --format json` | `--format json` gives raw JSON events over one-shot run | Also has `opencode serve` (HTTP server, OpenAPI at `/doc`, `OPENCODE_SERVER_PASSWORD` for basic auth) + official `@opencode-ai/sdk`. `--attach http://localhost:4096` to drive a running server. `--continue/-c`, `--session/-s`, `--fork`, `--auto` (auto-approve). Supports 75+ providers including OpenRouter and local/MCP endpoints — probably your best all-around pick for a JSON-first, multi-provider headless harness. |
| **Pi coding agent** (`badlogic/pi-mono`) | RPC mode: JSON commands on stdin, JSON events on stdout, one object per line (JSONL) | Rich RPC protocol: commands (`prompt`, `steer`, `bash`, `new_session`, `fork`, `compact`, `get_state`…) and events (`message_update` with streaming deltas, `bash_execution_update`, `agent_end`, `agent_settled`, `compaction_start/end`) | Supports 15+ providers uniformly (no capability gating for weak models). Per an independent security audit (agent-safehouse.dev), **Pi has no sandboxing by default** — bash runs with full host permissions unless you explicitly enable an `@anthropic-ai/sandbox-runtime`-based extension — and credentials are stored unencrypted (0600) in `~/.pi/agent/auth.json`. Good RPC ergonomics, weaker security posture out of the box. |
| **mini-swe-agent** | `mini -m <model> -t "<task>" -y --exit-immediately -o out.traj.json -l <cost-limit>` | Not line-JSON-streamed; writes a single `.traj.json` trajectory file (conversation history, exit status, cost) at the end | Deliberately minimal (4 tools: read/search/bash/write pattern), explicitly designed as a CI-friendly "task in → PR/result out → exit code" worker — good for a disposable, low-trust weak-model lane, but no incremental event stream to pipe into a live UI. |
| **Goose** (Block) | `goose run`/session export | Sessions exportable as JSON (full backup incl. conversation, metadata, settings) rather than a live NDJSON stream | In-process agent w/ recipes; less clean for a subprocess-driven factory than OpenCode/Pi. |
| **Aider** | `aider --message "…" --yes-always` | No first-class structured JSON event stream found in this research pass — treat headless JSON support as **unverified/likely weak**; Aider is optimized for interactive/git-commit-message UX, not machine event streams. |

**Robustness with weak/free models**: no source gave a rigorous head-to-head benchmark. Qualitatively, OpenCode's structured `--format json` plus its own permission/session model (built for many providers from day one) and Pi's explicit RPC protocol (designed for exactly "embed me in another app") are the two strongest candidates for driving cheap/free OpenRouter or local models with a robust event contract; mini-swe-agent trades robustness for radical simplicity (fewer tools → less for a weak model to misuse). This comparison is **not independently benchmarked** in this report — validate empirically before committing.

**Claude Code against OpenRouter/local endpoints via `ANTHROPIC_BASE_URL`**: Viable. OpenRouter now ships an "Anthropic-compatible" surface: set `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<OPENROUTER_API_KEY>`, `ANTHROPIC_API_KEY=""` — Claude Code then speaks its native protocol straight to OpenRouter, which maps to non-Anthropic models and reportedly passes through thinking blocks/native tool use for compatible models. For a fully local OpenAI-compatible server, community proxies exist (e.g. `maxnowack/anthropic-proxy`, translating Anthropic-shaped requests to OpenAI-shaped ones) since most local servers (llama.cpp, vLLM, Ollama) speak OpenAI's schema, not Anthropic's — so pointing `ANTHROPIC_BASE_URL` directly at a raw local OpenAI-compatible server generally **won't work without a translation proxy** in front of it. Flag this as the main practical caveat.

---

## 2. Isolation

**Git worktrees per run** is the now-standard baseline (confirmed by multiple independent 2026 guides): give every agent run its own `git worktree` + branch, avoiding stash/branch collisions between concurrent runs sharing one clone. Both driving CLIs now bake this in natively — `claude -w/--worktree [name]` and `codex exec --worktree` — so your factory's run-launcher can often just pass that flag rather than shelling out to `git worktree add` itself.

**macOS sandboxing options**, cheapest → strongest:
1. **Seatbelt / `sandbox-exec`** — what both agent CLIs already use internally. Claude Code's built-in `/sandbox` (settings: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`) uses Seatbelt on macOS with no extra install; restricts filesystem writes to the working directory and filters network via a proxy allowlist, enforced in-kernel (denied paths are invisible to the sandboxed process, not just permission-denied). Codex implements its own SBPL profiles for `read-only`/`workspace-write`/`danger-full-access` via `/usr/bin/sandbox-exec`. **Known rough edges** (from GitHub issues): `workspace-write` can block directory rename/remove inside the writable root, and nested Seatbelt (an outer sandbox spawning an inner one) can fail with `sandbox_apply: Operation not permitted` — worth testing your exact nesting scenario (agent-inside-worktree-inside-your-launcher) before relying on it.
2. **Apple `container` CLI** (`apple/container`, Apache-2.0, GA around mid-2026) — each Linux container gets its **own lightweight VM** via the macOS Virtualization framework (no shared kernel, no always-on VM, ~zero idle memory). Requires Apple Silicon + macOS 26+. This is the strongest macOS-native isolation for a "worker" that runs untrusted agent-generated shell commands, at some per-container startup cost vs. Seatbelt.
3. **Docker Desktop / OrbStack** — familiar, cross-platform-consistent images, easiest to keep identical between your Mac and the Linux box. OrbStack is generally the lighter-weight macOS choice.

**Linux**: Claude Code's sandbox uses **bubblewrap** (`bwrap`, the same sandbox Flatpak uses) + `socat` to relay the network-proxy allowlist (`apt install bubblewrap socat` / `dnf install bubblewrap socat`); Codex's Linux sandbox is a comparable namespace-based seccomp/bwrap-style profile. Docker remains the default for a dedicated Linux worker box.

**Pragmatic recommendation**: (a) git worktree per run everywhere — free, instant; (b) on macOS, default to the CLIs' built-in Seatbelt sandbox (`/sandbox`, `--sandbox workspace-write`) for day-to-day runs since it's zero-install and kernel-enforced; (c) promote a run to the Apple `container` CLI (or Docker/OrbStack) only when running less-trusted code (e.g. an OpenRouter/free-model-driven OpenCode/Pi run, or executing a PR's own CI scripts) — container isolation is worth the extra latency there; (d) on the Linux worker, standardize on Docker (or bubblewrap directly if you want Claude Code/Codex's native sandbox instead of a full container) for parity with what the CLIs already assume.

---

## 3. MCP & Skills

**MCP server in TypeScript on Bun** (`@modelcontextprotocol/sdk`): runs on Node, Bun, and Deno with no special shimming; peer-depends on `zod`. Both transports are supported side-by-side in one process:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({ name: "factory", version: "1.0.0" });
server.registerTool("trigger_run", { /* zod input schema */ }, async (input) => { /* … */ });
// stdio, for Claude Code / Codex local config:
await server.connect(new StdioServerTransport());
// or Streamable HTTP, for a remote/shared instance:
// await server.connect(new StreamableHTTPServerTransport({ port: 8787 }));
```
Run directly with `bun run mcp-server.ts` — no build step required for local/stdio use.

**Claude Code plugin/skill packaging**: a plugin directory contains `.claude-plugin/plugin.json` (metadata), `skills/<name>/SKILL.md` (YAML frontmatter + Markdown instructions — this is the vendor-neutral **Agent Skills** format), `agents/` (subagent defs), `hooks/hooks.json`, and `.mcp.json` (MCP server declarations). A **marketplace** is just a git repo/directory with `.claude-plugin/marketplace.json` at its root listing installable plugins by name/source.

**Codex skills/AGENTS.md/MCP**: Confirmed via official `developers.openai.com/codex/skills`: a Codex skill is *the same* `SKILL.md`-in-a-directory format, discovered from (in order) `./.agents/skills/`, `../.agents/skills/`, repo-root `.agents/skills/`, `~/.agents/skills/`, `/etc/codex/skills/`, plus built-ins — i.e. SKILL.md has become a genuinely cross-tool open standard (also adopted by Gemini CLI, Cursor, Copilot per community reporting). `AGENTS.md` is the repo-level "constitution," concatenated root→cwd, capped at 32 KiB. MCP servers live in `~/.codex/config.toml` (or project `.codex/config.toml`, merged on top, only for trusted projects):
```toml
[mcp_servers.factory]
command = "bun"
args = ["run", "/path/to/mcp-server.ts"]
env_vars = ["FACTORY_TOKEN"]
startup_timeout_sec = 20
tool_timeout_sec = 45

# Streamable-HTTP remote server variant:
[mcp_servers.factory_remote]
url = "https://factory.example.ts.net/mcp"
bearer_token_env_var = "FACTORY_BEARER"
```

**Packaging "trigger a run / check status" for both agents**: build one Bun-based MCP server (stdio for local dev, Streamable HTTP for the always-on daemon) exposing `trigger_run(repo, task)` and `get_run_status(run_id)` tools; register it once as `.mcp.json` for Claude Code and once in `~/.codex/config.toml` for Codex (both point at the same binary/URL). Layer a thin `SKILL.md` on top for each agent (`.claude/skills/factory/SKILL.md` and `.agents/skills/factory/SKILL.md`, content can be near-identical since it's the same format) that tells the model *when* to call those MCP tools in natural language — this gets you a single implementation surfaced idiomatically to both CLIs.

---

## 4. Triggers

**GitHub webhooks — signature verification** (`X-Hub-Signature-256`, HMAC-SHA256 over the *raw* request body):
```ts
import { timingSafeEqual, createHmac } from "node:crypto";
function verify(rawBody: Buffer, header: string | undefined, secret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
```
Always hash the raw bytes (before any JSON parsing) and compare with `timingSafeEqual`, never `===`.

**GitHub App vs. repo webhook**: a repo/org webhook is simplest for a single personal repo, but a **GitHub App** installation token scales rate limits with repo/org count, uses short-lived (8h) fine-grained installation tokens instead of a long-lived PAT, and centrally receives events for every repo it's installed on without per-repo webhook config — worth the extra setup if the factory will eventually span multiple repos.

**Relevant events**: `pull_request` (Dependabot's actual PRs fire ordinary `pull_request` `opened`/`synchronize` events — usable directly in a workflow or your webhook handler); `dependabot_alert` is a **separate**, alert-specific event (state/CVE/severity payload) that GitHub Actions cannot trigger on directly (a GitHub App needs explicit "Dependabot alerts" read permission to receive it) — use it only if you want to react to vulnerability alerts themselves, not PR creation. `issues` with `action: labeled` for label-triggered runs. `issue_comment` (`created`) for `@mention`-triggered runs — you must parse the comment body yourself for the mention; GitHub doesn't filter by mention server-side.

**Receiving webhooks on a home machine** — options in rough order of "does it fit a personal factory":
- **Cloudflare Tunnel** — outbound-only connection, permanent subdomain on your own domain, no port-forwarding, generous free tier; the most commonly recommended default for a persistent home-server webhook receiver in 2026. Watch for Cloudflare Access policies accidentally blocking `/webhooks/*` (needs a Bypass policy, not an Allow policy).
- **Tailscale Funnel** — good if you're already on a Tailscale tailnet for other reasons, but it's beta/limited and needs a paid tier for full functionality; less turnkey than Cloudflare Tunnel for this specific job.
- **`gh webhook forward --repo=OWNER/REPO --events=issues,pull_request,issue_comment --url=http://localhost:3000/webhook`** — official GitHub CLI command, explicitly **testing/dev only, not for production** (GitHub's own docs state this), and only supports repo/org webhooks (not GitHub Apps).
- **smee.io** — a classic relay proxy for webhook testing; I could not find current (2026) evidence it's still actively maintained/recommended over the newer options above — treat as **secondary/legacy, unverified for 2026 reliability**.

**Discord bot on Bun**: `discord.js` runs on Bun "with no extra setup" per Bun's own official guide (`bun.com/guides/ecosystem/discordjs`) — `bun add discord.js`, standard `IntentsBitField` usage, slash commands/buttons/threads all behave as on Node. For per-run updates, create a thread under a "factory runs" channel per run and post progress messages into it; required intents for a slash-command + thread-posting bot are typically `Guilds` (+ `GuildMessages`/`MessageContent` only if you also need to read messages, e.g. for an `@mention`-in-Discord trigger analogous to the GitHub one).

---

## 5. SolidJS + Bun

**Build/serve**: Bun's bundler has native HTML entrypoint support — `bun index.html` (or `Bun.build({ entrypoints: ["./index.html"], outdir, minify })`) treats a single HTML file as an SPA fallback route for all paths, bundling its `<script type=module>`/CSS references automatically, with built-in hot reload in dev. **However**, Bun ships no official Solid JSX/TSX plugin; the community fills the gap: `bun-plugin-solid` (`DaniGuardiola/bun-plugin-solid`, also packaged as `@dschz/bun-plugin-solid`) transforms Solid JSX via Babel at build- or run-time and is usable both with `Bun.build`'s plugin API and via `bunfig.toml` for the frontend dev server — but plugins are *not* usable through the plain `bun build` CLI form, only through the JS `Bun.build()` API or the dev-server config. Given that gap, several current templates (e.g. `thedanchez/template-bun-solidjs-elysia`) still reach for **Vite + `vite-plugin-solid`** for the full dev toolchain (HMR quality, testing story) and only use Bun as the runtime/backend (e.g. via Elysia) — a reasonable pragmatic choice: Vite for the SolidJS frontend build, Bun for the API/backend and `bun:sqlite`.

**Live updates from `Bun.serve`**: two native options, no external broker needed.
- *WebSocket pub/sub*: `Bun.serve({ fetch(req, server) { if (server.upgrade(req)) return; }, websocket: { open(ws) { ws.subscribe("run:123"); }, message(ws, msg) {} } })`, then `server.publish("run:123", JSON.stringify(event))` from anywhere in your process — built-in topic-based broadcast, no Redis required.
- *SSE*: return a `Response` with a `ReadableStream` and `Content-Type: text/event-stream`, `data: …\n\n` framing; Bun's guide recommends an async-generator-backed stream so the generator (and any timers) clean up automatically on client disconnect, and explicitly disabling the idle timeout for long-lived SSE connections (`server.timeout(req, 0)`, since `Bun.serve` otherwise closes idle connections after 10s).

**`bun:sqlite` best practices**: open with `journal_mode = WAL` immediately (`db.exec("PRAGMA journal_mode = WAL")`) for any concurrent-access app — writes go to a separate `-wal` file, reads coordinate via a `-shm` file, and SQLite checkpoints back into the main file later; pair with `PRAGMA synchronous = NORMAL` for a safety/speed balance under WAL. Use `db.prepare()` for statements executed repeatedly, and `db.transaction()` to wrap multi-statement writes atomically. For migrations, hand-roll a small versioned migration runner (a `schema_migrations` table + numbered `.sql` files applied in order) — no single de-facto Bun-native migration library emerged clearly from this research; this is a build-it-yourself area, not a gap in Bun's SQLite driver itself.

---

## Summary of flagged unverified/uncertain items
1. `claude -p --max-turns` — not found in current `--help`; may only exist as an SDK `Options.maxTurns` field now.
2. CLI `--permission-mode` enum values (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`) vs. SDK `Options.permissionMode` enum (`default|plan|bypassPermissions|preview`) appear inconsistent across docs/CLI — re-check against your exact installed versions.
3. Exact `codex exec --json` `error` event shape — not found in the fetched docs.
4. `@openai/codex-sdk` auth selection logic (ChatGPT login vs. `CODEX_API_KEY`) — not spelled out in the README excerpt fetched.
5. Headless/JSON-event robustness ranking of OpenCode vs. Pi vs. mini-swe-agent vs. Goose vs. Aider under weak/free OpenRouter models — no rigorous benchmark found; this report's ranking is qualitative, based on protocol design, not measured tool-calling success rates.
6. Aider's headless JSON output capability — could not confirm it has a structured event stream comparable to the others.
7. smee.io's current (2026) maintenance/reliability status — no fresh source found; Cloudflare Tunnel is the well-evidenced default instead.
8. Pointing `ANTHROPIC_BASE_URL` directly at a raw local OpenAI-compatible server (llama.cpp/vLLM/Ollama) without a translation proxy — inferred to not work (protocol mismatch), not directly tested.
