# Limitless — Milestones

Each milestone ends with a demo (a short published page with architecture, screenshots and a live
run) before work continues. Self-hosting starts at M2: from then on, features are built *by the
factory* via PRs against `MattFlower/limitless`, reviewed and merged by the orchestrator.

| # | Milestone | Scope | Demo |
|---|---|---|---|
| M0 | Foundations | Research, architecture, repo scaffold, lint/typecheck/test, CI | Architecture page |
| M1 | Walking skeleton | Daemon + SQLite + pipeline (prepare → triage → implement → gates → audit → cross-vendor review → deliver), claude & codex harnesses, CLI, minimal live UI, PRs to `limitless-sandbox` | A real task → reviewed PR, watched live in the UI |
| M2 | Self-hosting + quality | launchd release deploy; factory builds its own features: spec + blind holdout + verify, fix rounds + tier escalation, quota-aware routing & fallback, gate auto-detection | Factory-built PRs to itself, quality gates catching real problems |
| M3 | Triggers | GitHub webhooks through `limitless.mattflower.cc`, Discord bot, UI chat concierge, MCP server + skills for Claude Code & Codex | Kick off runs from Discord, GitHub, and a Claude Code session |
| M4 | Cheap & local models | mtplx + twilight llama.cpp + OpenRouter backends; a factory eval suite to calibrate routing; cost dashboards & budget alerts | Dependabot PR handled end-to-end for $0 on local models; routing table justified by eval data |
| M4.5 | Review quality | Research-first redesign of the review stage: a review eval built from real escaped defects and clean controls, graded on what production would block; coverage-first finders from different vendors, a grounded cross-vendor verifier with a consequence-based severity rubric, and a tightening round schedule on verified findings (#109) | Review eval v2 results: the new review system against the old single reviewer on escaped defects, false blocks and cost |
| M5 | Hardening & docs | Failure-injection tests, retention, remote UI access (Cloudflare Access), optional twilight hosting, complete user docs | Final walkthrough |
| M6 | Portable & work-ready | Providers, models and policy defined in config with a detecting `limitless init` (no machine-specific catalog); model-origin constraints (e.g. no China-origin models) enforced by the router; per-repo discreet mode (no Limitless branding) and approval-gated merges; provider workload analytics; Homebrew tap + curl installer | Fresh install on a second machine with a different provider set, routed by evals |
| M7 | Stage craft | State-of-the-art prompting and technique per stage and per model tier, A/B tested on the role evals (#110); implement eval v2 stratified by difficulty with rounds-to-converge and cost per converged task (#111) | Per-stage prompt variants justified by eval deltas |

## Definition of done (from PROMPT.md)
1. The factory has completed tasks end-to-end without errors (tracked in the UI's run history).
2. All eight "Required Functionality" items are shipped and documented.
