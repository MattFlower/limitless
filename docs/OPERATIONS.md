# Operating Limitless

How the factory runs day to day, where to look when something breaks, and how changes ship.

## What runs where

| Component | Where | Managed by | Logs |
|---|---|---|---|
| Daemon (API, UI, scheduler, pipeline) | Mac, `~/.limitless/app` (release checkout of `main`) | launchd `dev.limitless.daemon` | `~/.limitless/logs/dev.limitless.daemon.log` |
| Local model (Qwen3.8 Flash Next; Swift-1.5 27B opt-in) | Mac, `127.0.0.1:8989` | external: oMLX.app / `omlx start` | oMLX server logs |
| GPU model (Qwen 3.8 27B, CUDA llama.cpp) | the remote llama.cpp host, `:8080` (LAN, API key) | systemd user unit `limitless-llama` (linger on) | `journalctl --user -u limitless-llama` on the remote llama.cpp host |
| Public webhook tunnel | Cloudflare → `<public_url host>/webhooks/*` | launchd `dev.limitless.tunnel` (opt-in) | `~/.limitless/logs/dev.limitless.tunnel.log` |
| Data | `~/.limitless/` — `limitless.db`, `repos/` (bare caches), `work/` (worktrees), `runs/<id>/inv-*.log` (raw agent streams) | the daemon | — |
| Config & secrets | `~/.config/limitless/config.toml`, `secrets.env` (chmod 600) | you | — |

The UI is at http://127.0.0.1:7400. The daemon prints which `claude`, `codex`, `gh` and `git`
binaries it resolved (with versions) at the top of its log on every start.

## Everyday commands

```bash
limitless providers                 # health + quota per provider
limitless ls                        # recent runs
limitless logs <run> -f             # follow a run
limitless gc --dry-run              # preview hourly retention cleanup
limitless gates clear-cache [--repo owner/name]  # drop cached passing baselines (all repos by default)
limitless service status            # launchd units, release commit, health
limitless deploy                    # ship origin/main (gated, auto-rollback)
limitless deploy --smoke            # also run live CLI contract checks before restart
```

(`limitless` is `bun src/cli/main.ts` from a checkout, or link it onto your PATH.)

`limitless service install` migrates older installations to the neutral labels above. It drains
the daemon with the same 45-minute wait as deploy, stops the old agent, then starts and checks
the replacement. A failed replacement restores the previous plist and starts that agent fresh.
Only requested tunnel and mtplx agents migrate; they restart with rollback without draining.

## Shipping a change

1. The change lands on `main` (normally a factory PR that the orchestrator reviewed and merged).
2. `limitless deploy` in any checkout:
   - checks out `origin/main` in `~/.limitless/app`, runs `bun install --frozen-lockfile` and
     the checks there (`bun run lint`, `bun run typecheck`, and `bun test` run directly, so
     `PATH` matches the daemon's) before draining, even when the checkout is already at that
     target commit — **a failing check aborts the deploy and keeps the old daemon running**.
     If the daemon already reports that SHA, it returns `already deployed <sha>` without checks
     or restart unless `--smoke` requests checks and smoke;
   - drains new scheduling, waits up to 2700 seconds for active runs (or `--max-wait`), then
     restarts via launchd and waits for `/api/health`; `--now` skips the drain wait;
   - **rolls back** to the previous commit and restarts again if the new version doesn't come up.
   Add `--smoke` (with or without an explicit ref) to run live CLI contract checks in the release
   checkout after the checks and before restart (`bun scripts/smoke.ts`, run directly for the same
   reason). A smoke failure restores the previous
   checkout through the same deploy gate failure path.
3. Runs in flight are interrupted by the restart and **resume** at the step they were on
   (the worktree and run state are persisted; a round whose implementation already committed
   goes straight to its checks).

Releases before panel review rosters (#136) refuse to start when `config.toml` sets `[review] mode`
or `[review.rosters]`. Leave both unset until the release that added them is known good: a rollback
to an older release fails at startup until they are removed.

Changing the launchd units themselves (PATH, arguments) needs `limitless service install`.
An interrupted deploy logs `interrupted, rolling back...`. Before restart begins, it attempts
to restore the previous checkout and resume the scheduler. After restart begins, an interrupt
leaves the new version starting and exits; ordinary startup/health failures still attempt rollback.
If the process was killed during rollback, inspect
`limitless service status` and the release checkout before retrying `limitless deploy`. If the
daemon has no boot SHA while the checkout already matches the target, restart it with
`launchctl kickstart -k gui/$UID/dev.limitless.daemon` (or `limitless service install`),
then retry. A second interrupt exits immediately; recovery may then require those manual steps.

## Live CLI smoke checks

Run `bun run smoke` manually from a checkout to check the installed `claude` and `codex` binaries
through their real harnesses. Both CLIs must be installed, logged in, and have usable subscription
quota. The runner uses the cheapest catalog model per provider, spends a small amount of quota,
and reports each check with a duration. It creates temporary git repositories and removes them
after every check. Smoke is opt-in and is not part of `bun run check` or CI.
The no-tools checks fail on any observed tool call or disclosure of a random local file token.
Codex no-tools calls ignore user configuration and disable MCP, plugins, apps, code mode, shell,
sub-agents, image viewing, and web search; they retain session rollouts for quota inspection.
If the ChatGPT account rejects the cheapest Codex model, the runner tries the next catalog model
in price order and reports which model it used. Other CLI errors fail the check.
A check that fails for a transient availability reason (a timeout, a provider or network error
such as HTTP 5xx, a rate limit or a connection failure, or a failed health probe) is retried once,
and a passing retry still reports the first attempt's reason. Assertion failures (a disclosed
token, a tool call, a forbidden worktree write, wrong structured output) are never retried. Each
check has its own timeout, cut to what is left of the smoke budget (inside the deploy gate's
900 s); a retry is not started when the remaining budget is shorter than that timeout. A timed-out
attempt is cancelled and awaited, so a leak it reports while stopping still fails the check, and
one that does not stop is not retried. Each result line is printed as the check finishes, so a
killed run still shows which checks passed and which one was running.

The oMLX structured / Claude-harness edit checks are skipped when their required key is absent or their health probe
fails on both attempts. OpenRouter is skipped when `OPENROUTER_API_KEY` is absent from the Limitless secrets file or
environment. An attempted check that fails exits nonzero; skips alone do not. Use
`limitless deploy [ref] --smoke` to require these checks during deployment.

## Local models

- `limitless local up|down|status` reports externally managed oMLX authenticated `/v1/models`
  reachability on every action, including `down`; it never changes Mac processes or enablement.
  `up` starts `limitless-llama.service` on the remote llama.cpp host over SSH. An installed unit is never overwritten
  (it may carry host-specific tuning such as a patched chat template); only when none exists does
  `up` generate one, which needs the installed GGUF path in `~/.config/limitless/config.toml`:

  ```toml
  [local]
  remote_model_path = "/absolute/path/to/model.gguf"
  remote_host = "example.com" # required for remote management; no default
  # remote_llama_binary = "/usr/local/bin/llama-server"
  ```

  oMLX uses `http://127.0.0.1:8989/v1`; the remote llama.cpp host uses `http://<host>:8080/v1`;
  OpenRouter uses `https://openrouter.ai/api/v1` for direct structured completions. Agentic
  calls retain their Anthropic-compatible Claude CLI endpoints. `limitless service install`
  installs the daemon; `--mtplx` explicitly adds the rollback agent. `limitless local` controls
  only the configured remote host; without remote_host all actions report only oMLX. Remote
  management requires SSH access and an installed model/binary.
  The generated unit reads its API key from the remote llama.cpp host's `~/.config/limitless/llama-api-key` (so it
  never appears in the process list); configure a matching LAN provider as shown in
  [GUIDE](GUIDE.md#providers-1), using that key for authenticated health checks. Up/down update
  enablement only for a configured provider whose endpoint matches the remote host.

- **Mac (oMLX):** start the server with oMLX.app / `omlx start`; Limitless does not manage it.
  Put `OMLX_API_KEY` in `~/.config/limitless/secrets.env` (used by both inference transports and
  health probes). The default is `omlx/qwen-flash` (backend `Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp`);
  `omlx/qwen-27b` (`Swift-1.5-Qwen3.8-27b-oQ8e-mtp`) is opt-in and needs far more memory.
  Limitless allows 4 concurrent requests by default; override with `[providers.omlx]` and
  `max_concurrent = 8` in `config.toml`. This does not tune oMLX's own scheduler.
  Use `omlx/qwen-flash@none` or `@high` for tool-free roles (thinking off/on); bare selections
  preserve server-default thinking and are required for agentic roles such as review/verify.
  Built-in triage/summarize/chat prefer oMLX, but the committed `routing/policy.json` overlay
  remains authoritative where present until replaced by eval-backed policy.
  For rollback, `limitless service install --mtplx` installs the old agent on port 8000;
  enable `mtplx` explicitly if disabled and select `mtplx/qwen-27b`. Existing agents are not
  automatically removed; `LIMITLESS_MTPLX_MODEL` still overrides the rollback model at install.
- **Remote llama.cpp host:** `systemctl --user stop limitless-llama` frees the GPU (e.g. for Unsloth Studio);
  `start` brings it back. The factory routes around it while it's down. The binary is a copy of
  Unsloth Studio's CUDA build in `~/.local/share/limitless/llama-bin/`; the chat template is patched
  (`~/.config/limitless/qwen38-limitless.jinja`) so agent harnesses may send system messages
  mid-conversation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A provider shows `down` | model server not reachable | check the server's log above; the daemon re-probes every minute |
| A model shows "model rejected" in a run | the provider refused that model (plan, CLI version) | it's blocked for 24h automatically; check the CLI version in the daemon log |
| Runs stuck in `queued` | run slots full, or scheduler draining | Inspect active runs and `/api/health`; resume an interrupted drain. No provider capacity ends a run `needs_human`, rather than leaving it queued. |
| `exhausted` on a subscription | reserve reached (Claude 80% of 5h, Codex per `config.toml`) | wait for the window reset shown in the UI, or raise the reserve |
| Deploy says "deploy gate failed" | a check failed on `main` in the release checkout | fix `main`; production keeps running the previous commit. If `bun run check` passes elsewhere, compare `which -a codex claude` with the daemon's `PATH`: a CLI in a parent directory's `node_modules/.bin` is picked up only by `bun run` scripts |
| Run failed with a git error in `prepare` | repo cache problem | delete `~/.limitless/repos/<owner>__<name>.git`; it is re-cloned on the next run |

Every agent session's raw event stream is kept in `~/.limitless/runs/<run>/inv-<n>.log`, and the UI
shows the same events live, so failures can be diagnosed without re-running.

## Evaluations

Evaluations run in the daemon using its catalog, harness adapters, pipeline role prompts/schemas and shared
provider tracker. Start the daemon first; the CLI only submits and reads HTTP requests:

```sh
limitless eval run triage --models omlx/qwen-flash@none,omlx/qwen-flash@high,claude/haiku --k 2 --max-usd 1 --follow
limitless eval run triage --models claude/haiku --cases triage-001,triage-002 --no-cache
limitless eval run review --models openrouter/gpt-6-luna --follow
limitless eval run review --systems systems.json --follow   # {"systems": [{name, mode: "single", finders: [{target, prompt: "standard"}], implementerReport}]}
limitless eval run review --systems panel.json --follow     # mode "panel": parallel finders, prompt "standard" | "adversarial" | "careful", plus verifier: {target}
limitless eval run review --systems roster.json --follow    # {name, roster: "standard", targets: [one per roster finder, then per lens], lenses?, verifier: {target}, implementerReport}
limitless eval run verify --models openrouter/gpt-6-luna --follow # requires a curated verify dataset
limitless eval report <eval-id>
limitless eval report <eval-id> --json
limitless eval regrade <eval-id>   # review: recompute grades from stored outputs, no model calls
limitless eval cancel <eval-id>    # stop a running eval; it ends interrupted
limitless eval resume <eval-id>    # continue an interrupted or failed eval; changed trials run again
```

Use catalog IDs shown by the daemon's `/api/models` endpoint. `triage`, `review`, and `verify` are supported, including models absent from the routing policy. Defaults
are `k=1`, `maxUsd=1.00`, `concurrency=2`, all cases, and caching enabled. Case selections retain dataset order and
trial indices start at zero. The daemon resolves `evals/<role>/cases.json` from its application
checkout, validates it before scheduling, and reads the exact pinned commits from locked bare repo
caches (cloning/fetching when needed). Triage reads the pinned tree listing; review and verify create disposable standalone checkouts detached at head (containing only history reachable from base and head, no refs or remotes), apply any review seed patch locally, and remove them on every exit. Pins whose history contains eval datasets or seed patches fail with a preparation error. Each provider group starts its
trials in a fixed order, running up to `max(1, min(concurrency, provider maxConcurrent − 1))` at once
(`--concurrency N`, default 2, recorded on the run; runs from before the option omit it and report
`concurrency=1 (legacy)`). All eval runs in the daemon also share one cap per provider,
`max(1, min(largest concurrency among running evals, maxConcurrent − 1))`, so production runs keep
a slot on providers with `maxConcurrent` of 2 or more; a provider with `maxConcurrent = 1` still
allows one eval call, which can take its only slot. Provider groups may overlap, and every call
takes its run's slot, then the shared eval slot, then a slot from the provider tracker. The caps
apply to the provider each call actually uses, including every panel finder and verifier call and
switched implement retry rounds. Trials that share a cache key wait for
earlier queued trials with that key before reusing the cache, so completion order never changes
trial identity, cache keys, cache sources, grades or report order. The runner never falls back or retries; normal adapter-level structured-output repair remains the
same as in the pipeline and its cost is included in the trial.
Unavailable providers, reserves, provider budgets, circuit breakers, blocked models and missing
harnesses produce explicit skipped trials. Actual eval spend counts toward provider-wide budgets.

`maxUsd` is a scheduling threshold for **recorded metered spend**, not a billing ceiling. Once
reached, remaining trials are skipped and the run becomes `budget_exhausted`. Zero prevents new
trials. Already-started calls finish and retain their full costs, so concurrent calls may exceed the
threshold: by at most N−1 in-flight trials per provider group (N being that group's concurrency),
plus whatever other provider groups have in flight. Failed calls also consume metered budget; API-equivalent subscription costs do not.

The SHA-256 cache identity includes model ID, selected harness, each target's provider, backend
model and effort, prompt and system additions, strict JSON schema and trial index. Only schema-valid `ok` outputs are reusable, even when they failed
grading. Cache replay re-grades current gold, adds zero new cost/tokens, and leaves provider quota and
health untouched (cached outputs remain usable when the provider is unavailable). Original cost, tokens and latency are retained in trial cache provenance. Gold-only
changes do not invalidate the cache; `--no-cache` forces fresh calls. Historical reports use their
persisted grades, so later label edits do not rewrite past results.

Reports include distinct evaluated cases, evaluated trials, skips/errors/cache hits/pending/unscored
counts, pass rate with Wilson 95% intervals, mean weighted score, risk under-call rate, flip rate,
metered and API-equivalent dollars, p50 invocation latency, and paired comparisons against the best
model. Denominators and comparison coverage are included in both text and JSON:

- Pass requires all non-null gold fields to match; alternatives accept any listed value.
  `needs_questions` means nonempty `blocking_questions`. Risk has weight 2; other fields have weight 1.
  All-null gold is unscored. Attempted failed calls or invalid outputs count as pass failures with
  score 0; unattempted skips are excluded.
- Wilson intervals use evaluated trials and z=1.959963984540054. Risk under-call means predicted risk
  is below every accepted gold risk; null gold risk and calls without a valid prediction have no risk
  observation. Flip rate is the fraction of cases with all k evaluated trials whose pass/fail values
  differ; it is unavailable for k=1. Latency excludes cache replays and skips.
- Best means highest observed trial pass rate, breaking ties by model ID. Comparisons use per-case
  mean pass outcomes for cases with all k observations for both models. A paired bootstrap resamples
  cases together, reports candidate-minus-best mean difference, and uses the nearest-rank fifth
  percentile as the one-sided 95% lower bound. `nonInferior` requires that bound strictly above
  `-delta`. Defaults: delta=0.10, 10,000 resamples, seed=20260926 (Mulberry32 RNG). These settings can be
  configured through typed report/statistics options. Empty denominators and absent pairs are `null`
  in JSON and `n/a` in text.

The API provides `POST /api/evals` with `{role, models | systems, k?, maxUsd?, concurrency?, caseIds?, cache?}` (202 with `{id}`),
`GET /api/evals` to list runs, `GET /api/evals/:id` for the run, summaries and trials,
`POST /api/evals/:id/cancel` (returns `{id, status}`) and `POST /api/evals/:id/resume` with
`{}` (202 with `{id, resumedFrom}`). Mutations use
the usual local Origin and JSON content-type rules; Cloudflare tunnel requests are refused.

Runs progress from `queued` to `running`, then `completed`, `budget_exhausted`, `failed` or
`interrupted`. Completed means execution ended, not that candidates passed. Trial errors and skips
remain visible in partial reports. Daemon shutdown and `limitless eval cancel <eval-id>` abort active
calls, release slots and end the run `interrupted`; startup marks evals left queued or running by a
crash `interrupted` too. Unfinished trials (queued, or in flight with unknown final usage/latency)
are skipped and unscored. Nothing resumes automatically: `limitless eval resume <eval-id>`
continues an interrupted or failed eval as a new linked run that copies finished trials whose cache
key is unchanged and runs the rest again, against a `maxUsd` that covers the
whole chain (see [EVALS.md](EVALS.md)). Unknown latency is excluded from the p50. `--follow` polls until any
terminal state and prints a final report. The Evals UI lists runs, displays per-trial reports, and
compares latest completed evidence in a roles-by-models eligibility matrix. Other role graders remain pending.

Review/verify dataset contracts and formulas are detailed in [EVALS.md](EVALS.md#implemented-repository-reading-evaluations).
There is no committed verify dataset yet; supply a separately curated one before running verify
evals. The three-case test fixture is never a fallback.
Repository-reading cache keys include role, repository identity, base/head pins and seed content;
same-stat code changes invalidate them, while seed timestamps and temporary paths do not.
Review reports pooled blocking recall (Wilson 95%; only round-1 blocking findings catch a defect),
recall by gold severity, under-rated defects, clean false-block rate and verdict accuracy. Verify reports false-accept rate first, false-reject rate and criterion accuracy.
Every rate includes numerator/denominator; empty denominators are `n/a`/null. Errors remain pass
failures and are excluded from prediction metrics, with valid prediction coverage disclosed.
Optional defects are never misses; matching uses file and a ±5-line window, not category equality.
Line 0 matches only file-level completeness defects. Verify missing/unclear/duplicate IDs match
neither binary label and count as false rejects for gold-met criteria. Overall is not used to grade.

Models API/UI origin and base-origin metadata identify checkpoint organizations, not hosting
providers. When `[routing].exclude_origins` is configured (even `[]`), runtime routing, fallback,
escalation, the policy generator and the Evals matrix exclude models whose origin or baseOrigin is listed or
whose baseOrigin is `unknown`. Matching is exact and case-sensitive; omitting the key applies no
filter. Excluded models are never a fallback: routing fails if no eligible candidate remains.
New run/retry pins, routing cell saves and explicit eval targets naming them are refused.
The exclusions are read-only in Setup; edit config.toml and restart to change them (see below).


### Generate a routing policy from evals

```sh
limitless eval policy                       # Preview only; no writes or model calls
limitless eval policy --evals eval-a,eval-b  # Restrict to completed evidence IDs
limitless eval policy --write               # Write both reviewable files in this checkout
```

The CLI obtains evidence and current settings from `GET /api/evals/policy` (optional `?evals=id,id`),
then validates and preserves the checkout's existing partial `routing/policy.json`. It updates only
eligible triage/review/verify default cells; unrelated and complexity-specific overrides survive.
Empty/unknown/non-completed explicit IDs or invalid existing files fail before writing. Missing
files and no-op proposals are reported explicitly. The preview compares the effective policy that
would result from the exact proposed file against the daemon's active policy; pre-existing checkout
changes can therefore also appear in the diff. Roles without eligible results receive no generated
change. `routing/EVIDENCE.md` contains the reproducible evidence and unchanged-role explanations.
Review evidence from `--systems` runs counts only for systems whose `implementerReport` matches the
daemon's `[review] implementer_report`.

The [policy configuration and formulas](EVALS.md#policy-generation-and-review) specify inclusive Wilson
lower-bound floors on pass rate and blocking recall, inclusive Wilson upper-bound ceilings on risk under-call,
clean false-block and false-accept, strict paired non-inferiority, optional origin exclusions, and
subscription_weight (default 0.25). Review clean false-block and verify false-accept ceilings
default to 0.50 and 0.25, using Wilson 95% upper bounds rather than observed rates.
After cost-ordering eligible candidates, a nonempty chain adds the cheapest candidate from each
provider not yet covered that clears every floor/ceiling and fails only non-inferiority. These
availability fallbacks are identified in the evidence; they never bypass missing evidence or origins.
Cost/case averages attempts over repetitions; local is zero, metered is recorded dollars, subscriptions
use weighted API-equivalent dollars, and cache estimates use original provenance without increasing
recorded spend. Prediction and latency coverage and unavailable values are disclosed.

Review generated changes through a PR: the diff is approval. Deployment/restart loads the validated
partial overlay from the daemon's application checkout over DEFAULT_POLICY; writing a worker checkout
does not hot-reload a running daemon. Invalid overlay files fail startup loudly with their path.
The generator does not push, create PRs or deploy. Browse **Evals** in the UI for current eligibility,
source run links, metrics with intervals, comparisons, and error/skip/cache trial details.

## Remote UI via LAN proxy

Keep local access at `http://127.0.0.1:7400`. For remote access over WireGuard, set
these keys in `~/.config/limitless/config.toml` (replace the example IPs with the Mac's
fixed wired LAN IP and NPM's socket source IP):

```toml
[server]
listen_lan = "10.0.0.10"
trusted_proxies = ["10.0.0.20"]
public_origins = ["https://limitless.example.test"]
# auth = "required"    # default: proxied browsers sign in to Limitless; "proxy" leaves it to NPM

[auth]
# idle_days = 30       # a session unused this long ends
# absolute_days = 180  # every session ends this long after sign-in
```

Restart the daemon; allow incoming connections for Bun/Limitless if macOS displays its
firewall prompt. The additional listener binds only `listen_lan`, on the configured
`server.port` (default 7400); the loopback listener remains. Omit these keys for local-only
operation. Do not use a wildcard address or change `server.host` to a LAN address.

Create an NPM Proxy Host for your UI hostname (for example `limitless.example.test`), terminating TLS with the wildcard
certificate and forwarding to `http://<mac>:7400`. Preserve the public `Host` header
(`proxy_set_header Host $http_host;`), including any configured non-default port. Attach an
Access List allowing only your LAN and WireGuard source ranges and denying all other sources.
This is essential if NPM also faces the internet: an internet client can send the expected
Host, so hostname routing and the daemon's Host check alone do not restrict access. With
built-in sign-in (the default) the Access List needs no basic authentication; remove it if an
older setup added it. Test that a forbidden source is rejected by NPM.

In the proxy host's custom nginx configuration, disable buffering/caching for SSE and
allow long-lived streams:

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 1h;
```

The daemon's streams also send `X-Accel-Buffering: no`, which nginx honours per response, and the
UI re-fetches its runs from the API whenever a stream reconnects.

The daemon trusts the proxy's socket IP for UI/API access (including SSE), never forwarded
client-address headers. Proxy mutations require the configured public Origin and JSON.
Administration (`/api/admin/*`, including drain/resume) and `/mcp` remain loopback-only;
deploy remains a local CLI operation. The backend hop is unencrypted HTTP: confine it to the
small wired segment, whose hosts and the proxy must be trusted. Other LAN peers are refused by
the daemon. Tunnel traffic remains webhook-only, and all webhook signature/source checks still apply.

### Signing in

Requests through the proxy need a Limitless session; loopback requests (CLI, MCP, deploy,
administration) never do. Without one, pages redirect to `/login` and API calls (SSE streams
included) get 401. Set the password on the Mac:

```bash
limitless auth add-passkey                 # prints a one-time link to register a passkey
limitless auth passkeys                    # id, added, last used, browser; `passkeys remove <id>`
limitless auth set-password                # prompts twice; never echoed or taken as an argument
limitless auth sessions                    # id, method, last seen, signed in, browser
limitless auth sessions revoke <id>        # or: revoke --all
```

Passkeys are the primary sign-in. `add-passkey` prints a link such as
`https://limitless.example.test/enroll#<token>`; open it within 10 minutes in the browser (or
password manager, such as 1Password) that should keep the passkey. The link works once, and
registering also signs that browser in. Afterwards **Sign in with a passkey** on the login page
needs no typing. The passkey belongs to the host of the first `public_origins` entry and works
only there; user verification (biometrics or a PIN) is required. WebAuthn verification uses
[`@simplewebauthn/server`](https://simplewebauthn.dev). Removing a passkey does not end the
sessions it signed in; revoke those separately. A failed passkey registration or sign-in shows only
"passkey registration failed" or "passkey sign-in failed"; the reason is in the daemon log.

The password is the fallback. It is stored in the database as an argon2id hash. The login page is a plain form
(username `limitless`, `autocomplete="username"` / `"current-password"`), so password managers
fill it. Signing in sets `__Host-limitless-session`, an opaque random cookie with
`HttpOnly; Secure; SameSite=Strict`; the database keeps only its SHA-256. A session ends after
`idle_days` unused or `absolute_days` after sign-in, whichever comes first; open SSE streams
end with it. Because the cookie
is `Secure`, `public_origins` must be HTTPS unless `auth = "proxy"`. The UI's navigation bar
offers **Sign out** and **Sign out everywhere**.

Failed password attempts are limited to 5 per 15 minutes per source address (429 with
`Retry-After` after that). The daemon sees only the proxy's address, so all proxied clients
share that budget; the Access List keeps everyone else out. Passkey sign-ins are not counted:
a signature cannot be guessed, so a burst of wrong passwords never locks out passkey sign-in. Setting a new password does not
end existing sessions; revoke them if the old one may have leaked.

`auth = "proxy"` keeps the earlier behaviour for setups that authenticate at the proxy: no
built-in sign-in, so keep basic authentication on the Access List, with NPM's “Satisfy Any”
disabled so both the source and the credentials are required.
