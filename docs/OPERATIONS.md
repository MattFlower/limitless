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
