# Operating Limitless

How the factory runs day to day, where to look when something breaks, and how changes ship.

## What runs where

| Component | Where | Managed by | Logs |
|---|---|---|---|
| Daemon (API, UI, scheduler, pipeline) | Mac, `~/.limitless/app` (release checkout of `main`) | launchd `cc.mattflower.limitless` | `~/.limitless/logs/cc.mattflower.limitless.log` |
| Local model (Qwen 3.8 27B, MLX) | Mac, `127.0.0.1:8000` | launchd `cc.mattflower.limitless-mtplx` | `~/.limitless/logs/cc.mattflower.limitless-mtplx.log` |
| GPU model (Qwen 3.8 27B, CUDA llama.cpp) | twilight, `:8080` (LAN, API key) | systemd user unit `limitless-llama` (linger on) | `journalctl --user -u limitless-llama` on twilight |
| Public webhook tunnel | Cloudflare → `limitless.mattflower.cc/webhooks/*` | launchd `cc.mattflower.limitless-tunnel` (opt-in) | `~/.limitless/logs/cc.mattflower.limitless-tunnel.log` |
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
limitless service status            # launchd units, release commit, health
limitless deploy                    # ship origin/main (gated, auto-rollback)
limitless deploy --smoke            # also run live CLI contract checks before restart
```

(`limitless` is `bun src/cli/main.ts` from a checkout, or link it onto your PATH.)

## Shipping a change

1. The change lands on `main` (normally a factory PR that the orchestrator reviewed and merged).
2. `limitless deploy` in any checkout:
   - checks out `origin/main` in `~/.limitless/app`, runs `bun install` and the full `bun run check`
     there — **a failing check aborts the deploy and keeps the old version**;
   - restarts the daemon via launchd and waits for `/api/health`;
   - **rolls back** to the previous commit and restarts again if the new version doesn't come up.
   Add `--smoke` (with or without an explicit ref) to run live CLI contract checks in the release
   checkout after `bun run check` and before restart. A smoke failure restores the previous
   checkout through the same deploy gate failure path.
3. Runs in flight are interrupted by the restart and **resume** at the step they were on
   (the worktree and run state are persisted; a round whose implementation already committed
   goes straight to its checks).

Changing the launchd units themselves (PATH, arguments) needs `limitless service install`.

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

The mtplx and twilight checks are skipped when their required key is absent or their health probe
fails. OpenRouter is skipped when `OPENROUTER_API_KEY` is absent from the Limitless secrets file or
environment. An attempted check that fails exits nonzero; skips alone do not. Use
`limitless deploy [ref] --smoke` to require these checks during deployment.

## Local models

- `limitless local up|down|status` manages both model servers and reports service state plus
  `/v1/models` endpoint health separately. `up` creates the mtplx launchd plist if absent and
  starts `limitless-llama.service` on twilight over SSH. An installed unit is never overwritten
  (it may carry host-specific tuning such as a patched chat template); only when none exists does
  `up` generate one, which needs the installed GGUF path in `~/.config/limitless/config.toml`:

  ```toml
  [local]
  twilight_model_path = "/absolute/path/to/model.gguf"
  # twilight_host = "twilight"
  # twilight_llama_binary = "/home/mflower/.local/share/limitless/llama-bin/llama-server"
  ```

  mtplx uses `http://127.0.0.1:8000/v1`; twilight uses `http://twilight:8080/v1`;
  OpenRouter uses `https://openrouter.ai/api/v1` for direct structured completions. Agentic
  calls retain their Anthropic-compatible Claude CLI endpoints. `limitless service install`
  installs the daemon and can install the mtplx agent, while `limitless local` controls the
  model servers independently. SSH access to twilight and an installed model/binary are required.
  The generated unit reads its API key from twilight's `~/.config/limitless/llama-api-key` (so it
  never appears in the process list); put the same value in the Mac's `TWILIGHT_API_KEY`.

- **Mac (mtplx):** the launchd agent keeps Qwen 3.8 27B (optimized-quality, ~30 GB, 262K context)
  loaded. Stop it to free memory: `launchctl bootout gui/$UID/cc.mattflower.limitless-mtplx`;
  `limitless service install` brings it back. Change the model with `LIMITLESS_MTPLX_MODEL` at
  install time.
- **twilight:** `systemctl --user stop limitless-llama` frees the GPU (e.g. for Unsloth Studio);
  `start` brings it back. The factory routes around it while it's down. The binary is a copy of
  Unsloth Studio's CUDA build in `~/.local/share/limitless/llama-bin/`; the chat template is patched
  (`~/.config/limitless/qwen38-limitless.jinja`) so agent harnesses may send system messages
  mid-conversation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A provider shows `down` | model server not reachable | check the server's log above; the daemon re-probes every minute |
| A model shows "model rejected" in a run | the provider refused that model (plan, CLI version) | it's blocked for 24h automatically; check the CLI version in the daemon log |
| Runs stuck in `queued` | concurrency limit, or no provider available | `limitless providers`; UI Models page shows why candidates were skipped |
| `exhausted` on a subscription | reserve reached (Claude 80% of 5h, Codex per `config.toml`) | wait for the window reset shown in the UI, or raise the reserve |
| Deploy says "deploy gate failed" | `bun run check` failed on `main` | fix `main`; production keeps running the previous commit |
| Run failed with a git error in `prepare` | repo cache problem | delete `~/.limitless/repos/<owner>__<name>.git`; it is re-cloned on the next run |

Every agent session's raw event stream is kept in `~/.limitless/runs/<run>/inv-<n>.log`, and the UI
shows the same events live, so failures can be diagnosed without re-running.

## Triage evaluations

Evaluations run in the daemon using its catalog, harness adapters, triage prompt/schema and shared
provider tracker. Start the daemon first; the CLI only submits and reads HTTP requests:

```sh
limitless eval run triage --models mtplx/qwen-27b,claude/haiku --k 2 --max-usd 1 --follow
limitless eval run triage --models claude/haiku --cases triage-001,triage-002 --no-cache
limitless eval report <eval-id>
limitless eval report <eval-id> --json
```

Use catalog IDs shown by the daemon's `/api/models` endpoint. Only `triage` is supported. Defaults
are `k=1`, `maxUsd=1.00`, all cases, and caching enabled. Case selections retain dataset order and
trial indices start at zero. The daemon resolves `evals/triage/cases.json` from its application
checkout, validates it before scheduling, and reads the exact pinned commits from locked bare repo
caches (cloning/fetching when needed). It never creates an eval worktree. Each model runs sequentially;
provider groups may overlap within shared capacity limits. The runner never falls back or retries; normal adapter-level structured-output repair remains the
same as in the pipeline and its cost is included in the trial.
Unavailable providers, reserves, provider budgets, circuit breakers, blocked models and missing
harnesses produce explicit skipped trials. Actual eval spend counts toward provider-wide budgets.

`maxUsd` is a scheduling threshold for **recorded metered spend**, not a billing ceiling. Once
reached, remaining trials are skipped and the run becomes `budget_exhausted`. Zero prevents new
trials. Already-started calls finish and retain their full costs, so concurrent calls may exceed the
threshold. Failed calls also consume metered budget; API-equivalent subscription costs do not.

The SHA-256 cache identity includes model ID, selected harness, prompt and system additions, strict
JSON schema and trial index. Only schema-valid `ok` outputs are reusable, even when they failed
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

The API provides `POST /api/evals` with `{role, models, k?, maxUsd?, caseIds?, cache?}` (202 with `{id}`),
`GET /api/evals` to list runs, and `GET /api/evals/:id` for the run, summaries and trials. Mutations use
the usual local Origin and JSON content-type rules; Cloudflare tunnel requests are refused.

Runs progress from `queued` to `running`, then `completed`, `budget_exhausted` or `failed`. Completed
means execution ended, not that candidates passed. Trial errors and skips remain visible in partial
reports. Daemon shutdown aborts active calls and releases slots; startup marks interrupted evals
failed, retaining completed trials for cache reuse on a new submission. In-flight trials interrupted
by a crash are errors with unknown final usage/latency; queued trials are skipped. Unknown latency is
excluded from the p50. `--follow` polls until any
terminal state and prints a final report. Other role graders, the Evals UI and policy generation are
not implemented yet.
