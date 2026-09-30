import type { Billing, Complexity, Effort, Role, Vendor } from "../core/types.ts";

export interface ProviderDef {
  id: string;
  label: string;
  harness: "claude" | "codex" | "decisions" | "fake";
  billing: Billing;
  maxConcurrent: number;
  /** Anthropic-compatible endpoint for the claude harness (OpenRouter, mtplx, llama.cpp). */
  baseUrl?: string;
  /** OpenAI-compatible endpoint for tool-free structured completions. */
  openaiBaseUrl?: string;
  /** Typed-question API for decision models (harness "decisions"). */
  decisionsBaseUrl?: string;
  /** Name of the secret holding the API key for baseUrl. */
  apiKeySecret?: string;
  /** Static token for local servers that want one. */
  apiKey?: string;
  /** URL polled to decide whether a local server is up. */
  healthUrl?: string;
  /** Reach a remote localhost-only server through `ssh -L` (no firewall changes needed). */
  sshForward?: { host: string; localPort: number; remotePort: number };
}

export interface ModelDef {
  id: string; // "<provider>/<short>"
  provider: string;
  model: string; // name the backend understands
  vendor: Vendor;
  /** ISO alpha-2 checkpoint organization country; independent of hosting provider. */
  origin: string;
  baseOrigin: string;
  tier: 1 | 2 | 3 | 4 | 5;
  /** $ per million tokens at list price (metered cost or subscription-equivalent). */
  price: { input: number; output: number; cacheRead?: number };
  effort?: Effort;
  supportedEfforts: Effort[];
  notes?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    label: "Claude (Max subscription)",
    harness: "claude",
    billing: "subscription",
    maxConcurrent: 3,
  },
  {
    id: "codex",
    label: "ChatGPT (Codex subscription)",
    harness: "codex",
    billing: "subscription",
    maxConcurrent: 3,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    harness: "claude",
    billing: "metered",
    maxConcurrent: 4,
    baseUrl: "https://openrouter.ai/api",
    openaiBaseUrl: "https://openrouter.ai/api/v1",
    apiKeySecret: "OPENROUTER_API_KEY",
  },
  {
    id: "omlx",
    label: "Local MLX (oMLX, this Mac)",
    harness: "claude",
    billing: "free",
    maxConcurrent: 4,
    baseUrl: "http://127.0.0.1:8989",
    openaiBaseUrl: "http://127.0.0.1:8989/v1",
    apiKeySecret: "OMLX_API_KEY",
    healthUrl: "http://127.0.0.1:8989/v1/models",
  },
  {
    id: "mtplx",
    label: "Local MLX (mtplx, this Mac)",
    harness: "claude",
    billing: "free",
    maxConcurrent: 1,
    baseUrl: "http://127.0.0.1:8000",
    openaiBaseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "mtplx-local",
    healthUrl: "http://127.0.0.1:8000/v1/models",
  },
  {
    id: "twilight",
    label: "twilight RTX 5090 (llama.cpp)",
    harness: "claude",
    billing: "free",
    maxConcurrent: 1,
    // llama-server (CUDA build) on the LAN, API-key protected; ufw allows 10.1.0.0/16 on 8080.
    // When away from the LAN, set sshForward instead: { host: "twilight", localPort: 18080, remotePort: 8080 }
    // with baseUrl/healthUrl on http://127.0.0.1:18080.
    baseUrl: "http://twilight:8080",
    openaiBaseUrl: "http://twilight:8080/v1",
    apiKeySecret: "TWILIGHT_API_KEY",
    healthUrl: "http://twilight:8080/v1/models",
  },
  {
    // Decision models answer typed questions instead of writing text (docs/research/09-jev-decisions.md).
    id: "typesafe",
    label: "TypeSafe (decisions API)",
    harness: "decisions",
    billing: "metered",
    maxConcurrent: 4,
    decisionsBaseUrl: "https://api.typesafe.ai",
    apiKeySecret: "TYPESAFE_API_KEY",
  },
];

export const MODELS: ModelDef[] = [
  // Anthropic via the Claude subscription (prices = API list price, for cost-equivalence).
  {
    id: "claude/fable",
    provider: "claude",
    model: "claude-fable-5-1",
    vendor: "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high"],
    tier: 5,
    price: { input: 10, output: 50, cacheRead: 0.25 },
  },
  {
    id: "claude/opus",
    provider: "claude",
    model: "claude-opus-5-5",
    vendor: "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high"],
    tier: 5,
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  {
    id: "claude/sonnet",
    provider: "claude",
    model: "claude-sonnet-5",
    vendor: "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high"],
    tier: 4,
    price: { input: 2, output: 10, cacheRead: 0.2 },
  },
  {
    id: "claude/haiku",
    provider: "claude",
    model: "claude-haiku-4-5",
    vendor: "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: 3,
    price: { input: 1, output: 5, cacheRead: 0.1 },
  },
  {
    id: "claude/sonnet-5.5",
    provider: "claude",
    model: "claude-sonnet-5-5",
    vendor: "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high"],
    tier: 4,
    price: { input: 2, output: 10, cacheRead: 0.2 },
    notes: "Released 2026-09-28; under evaluation (#133), not in the routing policy",
  },
  // OpenAI via the ChatGPT subscription (Codex CLI >= 0.157 serves the gpt-6 family on this plan).
  {
    id: "codex/astra",
    provider: "codex",
    model: "gpt-6-astra",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    tier: 5,
    effort: "high",
    price: { input: 10, output: 50 },
  },
  {
    id: "codex/sol",
    provider: "codex",
    model: "gpt-6-sol",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    tier: 4,
    effort: "medium",
    price: { input: 2, output: 10 },
  },
  {
    id: "codex/luna",
    provider: "codex",
    model: "gpt-6-luna",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    tier: 3,
    effort: "medium",
    price: { input: 0.1, output: 0.5 },
  },
  {
    id: "codex/sol-5.6",
    provider: "codex",
    model: "gpt-5.6-sol",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    tier: 4,
    effort: "medium",
    price: { input: 2, output: 10 },
    notes: "Previous generation; fallback if gpt-6-sol is unavailable",
  },
  {
    id: "codex/sol-6.1",
    provider: "codex",
    model: "gpt-6.1-sol",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    tier: 4,
    effort: "medium",
    price: { input: 2, output: 10, cacheRead: 0.1 },
    notes: "Needs Codex CLI >= 0.159 on ChatGPT sign-in; under evaluation (#133), not in the routing policy",
  },
  // Metered open models via OpenRouter (tiers are provisional until the M4 eval suite calibrates them).
  {
    id: "openrouter/deepseek-v4-pro",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro-0813",
    vendor: "deepseek",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: [],
    tier: 4,
    price: { input: 0.264, output: 0.792 },
  },
  {
    id: "openrouter/glm-5.3",
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    vendor: "zhipu",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: [],
    tier: 4,
    price: { input: 0.379, output: 1.192 },
  },
  {
    id: "openrouter/minimax-m3",
    provider: "openrouter",
    model: "minimax/minimax-m3",
    vendor: "minimax",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: [],
    tier: 4,
    price: { input: 0.3, output: 1.2 },
  },
  {
    id: "openrouter/kimi-code",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.7-code",
    vendor: "moonshot",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: [],
    tier: 4,
    price: { input: 0.656, output: 3.3 },
  },
  {
    id: "openrouter/glm-5.3-flash",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    vendor: "zhipu",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: [],
    tier: 3,
    price: { input: 0.04, output: 0.5 },
  },
  {
    id: "openrouter/qwen-27b-free",
    provider: "openrouter",
    model: "qwen/qwen3.8-27b:free",
    vendor: "qwen",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: [],
    tier: 2,
    price: { input: 0, output: 0 },
  },
  // Eval candidates; provisional tiers, deliberately absent from DEFAULT_POLICY.
  {
    // Metered alternative to codex/sol-6.1 (Codex CLI before 0.159 rejects gpt-6.1-sol on ChatGPT sign-in).
    id: "openrouter/gpt-6.1-sol",
    provider: "openrouter",
    model: "openai/gpt-6.1-sol",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    tier: 4,
    price: { input: 2, output: 10, cacheRead: 0.1 },
    notes: "Released 2026-09-29; under evaluation (#133), not in the routing policy",
  },
  {
    id: "openrouter/gpt-6-luna",
    provider: "openrouter",
    model: "openai/gpt-6-luna",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["none", "low", "medium", "high"],
    tier: 3,
    price: { input: 0.1, output: 0.5 },
  },
  {
    id: "openrouter/gemini-3.1-flash-lite",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    vendor: "google",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: 3,
    price: { input: 0.25, output: 1.5 },
  },
  {
    id: "openrouter/claude-haiku-4.5",
    provider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
    vendor: "anthropic",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: 3,
    price: { input: 1, output: 5 },
  },
  {
    id: "openrouter/muse-glimmer-30b",
    provider: "openrouter",
    model: "meta/muse-glimmer-30b",
    vendor: "meta",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: 3,
    price: { input: 0.3, output: 1.2 },
  },
  {
    id: "openrouter/gemma-4-26b-a4b-it",
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it",
    vendor: "google",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: 3,
    price: { input: 0.068, output: 0.225 },
  },
  {
    id: "openrouter/gemma-4-31b-it",
    provider: "openrouter",
    model: "google/gemma-4-31b-it",
    vendor: "google",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: [],
    tier: 3,
    price: { input: 0.09, output: 0.34 },
  },
  {
    id: "openrouter/gpt-oss-20b",
    provider: "openrouter",
    model: "openai/gpt-oss-20b",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high"],
    tier: 3,
    price: { input: 0.018, output: 0.09 },
  },
  {
    id: "openrouter/gpt-oss-120b",
    provider: "openrouter",
    model: "openai/gpt-oss-120b",
    vendor: "openai",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "medium", "high"],
    tier: 3,
    price: { input: 0.15, output: 0.6 },
  },
  {
    id: "openrouter/ministral-14b-2512",
    provider: "openrouter",
    model: "mistralai/ministral-14b-2512",
    vendor: "mistral",
    origin: "FR",
    baseOrigin: "FR",
    supportedEfforts: [],
    tier: 3,
    price: { input: 0.2, output: 0.2 },
  },
  // Decision model: only roles with a decisions mapping can route to it (DECISION_ROLES).
  {
    id: "typesafe/jev-1.13",
    provider: "typesafe",
    model: "jev-1.13.0",
    vendor: "typesafe",
    origin: "US",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 1,
    price: { input: 0.042, output: 0 },
    notes: "Pinned version: confidence thresholds are tuned per version. Base model undisclosed.",
  },
  // Free local models.
  {
    id: "omlx/qwen-27b",
    provider: "omlx",
    model: "Swift-1.5-Qwen3.8-27b-oQ8e-mtp",
    vendor: "qwen",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: ["none", "high"],
    tier: 2,
    price: { input: 0, output: 0 },
    notes: "Local Swift-1.5 Qwen3.8 27B oQ8e MTP build, served by oMLX on this Mac",
  },
  {
    id: "omlx/qwen-flash",
    provider: "omlx",
    model: "Qwen3.8-Flash-Next-REAP-288-MLX-4bit",
    vendor: "qwen",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: ["none", "high"],
    tier: 2,
    price: { input: 0, output: 0 },
    notes:
      "Local Qwen3.8 Flash Next (REAP-pruned, 4-bit MLX), served by oMLX on this Mac; on trial against omlx/qwen-27b",
  },
  {
    id: "mtplx/qwen-27b",
    provider: "mtplx",
    model: "mtplx-qwen38-27b-optimized-quality",
    vendor: "qwen",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: ["none", "high"],
    tier: 2,
    price: { input: 0, output: 0 },
    notes: "Qwen 3.8 27B (MTPLX optimized-quality) on this Mac, 262K context",
  },
  {
    id: "twilight/qwen-27b",
    provider: "twilight",
    model: "qwen3.8-27b",
    vendor: "qwen",
    origin: "CN",
    baseOrigin: "CN",
    supportedEfforts: ["none", "high"],
    tier: 2,
    price: { input: 0, output: 0 },
  },
];

/**
 * Preference-ordered candidate groups per role and complexity.
 * Models joined with "|" are interchangeable; the router orders them by quota headroom,
 * which spreads subscription load across Claude and ChatGPT.
 */
export type Policy = Record<Role, Partial<Record<Complexity | "default", string[]>>>;

export const DEFAULT_POLICY: Policy = {
  triage: { default: ["omlx/qwen-27b", "claude/haiku|codex/luna", "openrouter/glm-5.3-flash"] },
  summarize: { default: ["omlx/qwen-27b", "claude/haiku|codex/luna", "openrouter/glm-5.3-flash"] },
  chat: { default: ["omlx/qwen-27b", "claude/haiku|codex/luna"] },
  spec: {
    default: ["claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra"],
    large: ["claude/opus|codex/astra", "claude/sonnet|codex/sol|codex/sol-5.6"],
  },
  plan: { default: ["claude/opus|codex/astra", "claude/fable"] },
  plan_review: { default: ["claude/opus|codex/astra"] },
  holdout: { default: ["claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra"] },
  implement: {
    trivial: ["claude/haiku|codex/luna", "claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra"],
    small: ["claude/sonnet|codex/sol|codex/sol-5.6", "openrouter/glm-5.3", "claude/opus|codex/astra"],
    medium: ["claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra", "openrouter/kimi-code"],
    large: ["claude/opus|codex/astra", "claude/fable"],
  },
  review: {
    default: ["codex/sol|codex/sol-5.6|claude/sonnet", "openrouter/glm-5.3", "codex/astra|claude/opus"],
    large: ["codex/astra|claude/opus", "codex/sol|codex/sol-5.6|claude/sonnet"],
  },
  verify: {
    default: ["claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra"],
    large: ["claude/opus|codex/astra", "claude/sonnet|codex/sol|codex/sol-5.6"],
  },
};
