<!-- Research report produced by a research subagent on 2026-09-26, edited by the orchestrator. Benchmark figures (Artificial Analysis index, "AA") came via a page summarizer: rough ranking only. -->

# Cheap models under a "no China-origin" policy (2026-09-26)

Context: the owner's work environment forbids China-origin models (Qwen, DeepSeek, GLM, Kimi,
MiniMax, …), even locally, and has no Claude Max / ChatGPT Pro subscriptions. Tool-less structured
roles (triage, chat) need a cheap, allowed default.

## Hosted
| Model | $/Mtok in/out | JSON schema | Notes |
|---|---|---|---|
| `gpt-6-luna` | 0.10 / 0.50 | yes | Cheapest GPT-6 tier (2026-09-22); effort none…max, default medium — use none/low. AA 18 (none) / 21 (low). Also on Azure. |
| `claude-haiku-4-5` | 1 / 5 | yes | Newest Haiku; Bedrock/Vertex/Foundry. AA 17. 10× Luna. |
| `gemini-3.1-flash-lite` | 0.25 / 1.50 | yes | Stable, 1M context. 3.5-flash-lite 0.30/2.50 (AA 22). |
| Mistral Small 4, Ministral 3 8B/14B | 0.15–0.20 | "custom structured outputs" | Model ids and schema support unverified. |

## Local open weights (US/EU)
- **Meta Muse Glimmer 30B** (Aug 2026, Apache-2.0, dense, 128K): official GGUF (~17–20 GB Q4);
  vendor-reported 75 tok/s on an RTX 5090, 27 tok/s on an M5 Max. MLX community-only.
- **Google Gemma 4** (Apr 2026, Apache-2.0): E2B/E4B/12B/26B-A4B MoE/31B; official QAT builds; MLX via
  mlx-community. AA 17 (26B-A4B) / 19 (31B).
- **OpenAI gpt-oss-20b/120b** (Aug 2025, Apache-2.0): fast lower bound (AA 9/12).
- NVIDIA Nemotron 3.5 Lightning 30B-A3B, IBM Granite 4.2 (official MLX), Mistral Small 4 (119B-A6B,
  M5 only), Ministral 3, AI2 Olmo 3 (cleanest provenance, weak).
- Expect a quality gap: the home model (Qwen 3.8 27B) scores ~34 vs 17–19 for these.

## Lineage traps
Cursor Composer 2 is Kimi K2.5 + RL; `nvidia/Qwen3.8-27B-NVFP4` is a Qwen model under NVIDIA's org;
HF architecture tags (e.g. `qwen3`) describe code, not weights; NVIDIA post-training data includes
DeepSeek/Qwen generations (distillation lineage, weights their own).

## How restrictions are defined
FY2026 NDAA §1532 targets AI "developed by" covered entities (developer origin, not hosting). The
pending No Adversarial AI Act lists AI "produced or developed by" foreign-adversary entities.
Neither addresses fine-tunes explicitly, so lineage checks are the safe reading.

## Encoding (for backlog item 18)
Each catalog model gets `origin` (who trained/released the checkpoint) and `baseOrigin` (root of the
base-model chain; `unknown` fails closed), optionally `distilledFrom`. A policy blocks a model if
either origin is excluded or `baseOrigin` is unknown; hosting location never un-blocks it.

## Sweep shortlist (triage/chat)
1. `gpt-6-luna` (effort none and low) — likely default.
2. `gemini-3.1-flash-lite` — second vendor.
3. `claude-haiku-4-5` — quality anchor.
4. Muse Glimmer 30B (local, Q4).
5. Gemma 4 26B-A4B (local; 31B fallback).
Use grammar-constrained decoding locally and grade per-field accuracy, not parse rate.

## Sources
developers.openai.com/api/docs/models/gpt-6-luna · artificialanalysis.ai/models/releases/gpt-6-luna ·
platform.claude.com/docs/en/about-claude/pricing · ai.google.dev/gemini-api/docs/pricing ·
mistral.ai/pricing/api · huggingface.co/meta-models/Muse-Glimmer-30B · huggingface.co/google/gemma-4-31B-it ·
huggingface.co/openai · huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 ·
huggingface.co/datasets/nvidia/Nemotron-Post-Training-Dataset-v1 · huggingface.co/ibm-granite/granite-4.2-30b ·
venturebeat.com (Cursor Composer 2 on Kimi) · agora.eto.tech/instrument/2694 (NDAA §1532) ·
techcrunch.com/2026/07/24 (open-weight restrictions) · lmstudio.ai/docs/advanced/structured-output

## Availability for the sweep (checked 2026-09-26)
Every shortlisted model is on OpenRouter with structured outputs, so the eval sweep can compare them
through one harness without downloading weights: `openai/gpt-6-luna` ($0.10/$0.50),
`google/gemini-3.1-flash-lite` ($0.25/$1.50), `anthropic/claude-haiku-4.5` ($1/$5),
`meta/muse-glimmer-30b` ($0.30/$1.20), `google/gemma-4-26b-a4b-it` ($0.068/$0.225),
`google/gemma-4-31b-it`, `openai/gpt-oss-20b` / `-120b`, `ibm-granite/granite-4.2-8b`,
`nvidia/nemotron-3.5-lightning`, `mistralai/ministral-8b-2512` / `-14b-2512`. A 40-case triage
sweep at k=3 across all of them costs roughly $1–2.
