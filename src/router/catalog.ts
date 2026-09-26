import type { Billing, Complexity, Role, Vendor } from "../core/types.ts";

export interface ProviderDef {
  id: string;
  label: string;
  harness: "claude" | "codex" | "fake";
  billing: Billing;
  maxConcurrent: number;
  /** Anthropic-compatible endpoint for the claude harness (OpenRouter, mtplx, llama.cpp). */
  baseUrl?: string;
  /** OpenAI-compatible endpoint for tool-free structured completions. */
  openaiBaseUrl?: string;
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
  tier: 1 | 2 | 3 | 4 | 5;
  /** $ per million tokens at list price (metered cost or subscription-equivalent). */
  price: { input: number; output: number; cacheRead?: number };
  effort?: string;
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
];

export const MODELS: ModelDef[] = [
  // Anthropic via the Claude subscription (prices = API list price, for cost-equivalence).
  {
    id: "claude/fable",
    provider: "claude",
    model: "claude-fable-5-1",
    vendor: "anthropic",
    tier: 5,
    price: { input: 10, output: 50, cacheRead: 0.25 },
  },
  {
    id: "claude/opus",
    provider: "claude",
    model: "claude-opus-5-5",
    vendor: "anthropic",
    tier: 5,
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  {
    id: "claude/sonnet",
    provider: "claude",
    model: "claude-sonnet-5",
    vendor: "anthropic",
    tier: 4,
    price: { input: 2, output: 10, cacheRead: 0.2 },
  },
  {
    id: "claude/haiku",
    provider: "claude",
    model: "claude-haiku-4-5",
    vendor: "anthropic",
    tier: 3,
    price: { input: 1, output: 5, cacheRead: 0.1 },
  },
  // OpenAI via the ChatGPT subscription (Codex CLI >= 0.157 serves the gpt-6 family on this plan).
  {
    id: "codex/astra",
    provider: "codex",
    model: "gpt-6-astra",
    vendor: "openai",
    tier: 5,
    effort: "high",
    price: { input: 10, output: 50 },
  },
  {
    id: "codex/sol",
    provider: "codex",
    model: "gpt-6-sol",
    vendor: "openai",
    tier: 4,
    effort: "medium",
    price: { input: 2, output: 10 },
  },
  {
    id: "codex/luna",
    provider: "codex",
    model: "gpt-6-luna",
    vendor: "openai",
    tier: 3,
    effort: "medium",
    price: { input: 0.1, output: 0.5 },
  },
  {
    id: "codex/sol-5.6",
    provider: "codex",
    model: "gpt-5.6-sol",
    vendor: "openai",
    tier: 4,
    effort: "medium",
    price: { input: 2, output: 10 },
    notes: "Previous generation; fallback if gpt-6-sol is unavailable",
  },
  // Metered open models via OpenRouter (tiers are provisional until the M4 eval suite calibrates them).
  {
    id: "openrouter/deepseek-v4-pro",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro-0813",
    vendor: "deepseek",
    tier: 4,
    price: { input: 0.264, output: 0.792 },
  },
  {
    id: "openrouter/glm-5.3",
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    vendor: "zhipu",
    tier: 4,
    price: { input: 0.379, output: 1.192 },
  },
  {
    id: "openrouter/minimax-m3",
    provider: "openrouter",
    model: "minimax/minimax-m3",
    vendor: "minimax",
    tier: 4,
    price: { input: 0.3, output: 1.2 },
  },
  {
    id: "openrouter/kimi-code",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.7-code",
    vendor: "moonshot",
    tier: 4,
    price: { input: 0.656, output: 3.3 },
  },
  {
    id: "openrouter/glm-5.3-flash",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    vendor: "zhipu",
    tier: 3,
    price: { input: 0.04, output: 0.5 },
  },
  {
    id: "openrouter/qwen-27b-free",
    provider: "openrouter",
    model: "qwen/qwen3.8-27b:free",
    vendor: "qwen",
    tier: 2,
    price: { input: 0, output: 0 },
  },
  // Free local models.
  {
    id: "mtplx/qwen-27b",
    provider: "mtplx",
    model: "mtplx-qwen38-27b-optimized-quality",
    vendor: "qwen",
    tier: 2,
    price: { input: 0, output: 0 },
    notes: "Qwen 3.8 27B (MTPLX optimized-quality) on this Mac, 262K context",
  },
  {
    id: "twilight/qwen-27b",
    provider: "twilight",
    model: "qwen3.8-27b",
    vendor: "qwen",
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
  triage: { default: ["mtplx/qwen-27b", "claude/haiku|codex/luna", "openrouter/glm-5.3-flash"] },
  summarize: { default: ["mtplx/qwen-27b", "claude/haiku|codex/luna", "openrouter/glm-5.3-flash"] },
  chat: { default: ["mtplx/qwen-27b", "claude/haiku|codex/luna"] },
  spec: {
    default: ["claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra"],
    large: ["claude/opus|codex/astra", "claude/sonnet|codex/sol|codex/sol-5.6"],
  },
  plan: { default: ["claude/opus|codex/astra", "claude/fable"] },
  plan_review: { default: ["claude/opus|codex/astra"] },
  holdout: { default: ["claude/sonnet|codex/sol|codex/sol-5.6", "openrouter/deepseek-v4-pro"] },
  implement: {
    trivial: ["claude/haiku|codex/luna", "claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra"],
    small: [
      "claude/sonnet|codex/sol|codex/sol-5.6",
      "openrouter/deepseek-v4-pro|openrouter/glm-5.3",
      "claude/opus|codex/astra",
    ],
    medium: ["claude/sonnet|codex/sol|codex/sol-5.6", "claude/opus|codex/astra", "openrouter/kimi-code"],
    large: ["claude/opus|codex/astra", "claude/fable"],
  },
  review: {
    default: [
      "codex/sol|codex/sol-5.6|claude/sonnet",
      "openrouter/deepseek-v4-pro|openrouter/glm-5.3",
      "codex/astra|claude/opus",
    ],
    large: ["codex/astra|claude/opus", "codex/sol|codex/sol-5.6|claude/sonnet"],
  },
  verify: {
    default: [
      "claude/sonnet|codex/sol|codex/sol-5.6",
      "openrouter/deepseek-v4-pro",
      "claude/opus|codex/astra",
    ],
    large: ["claude/opus|codex/astra", "claude/sonnet|codex/sol|codex/sol-5.6"],
  },
};
