import type { Role } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { DEFAULT_POLICY, MODELS, PROVIDERS } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { type RouteConstraints, Router } from "../src/router/router.ts";

export function identitySnapshot(catalog = { providers: PROVIDERS, models: MODELS }) {
  catalog = {
    ...catalog,
    providers: catalog.providers.map((p) => ({
      ...p,
      ...Object.fromEntries(
        ["baseUrl", "openaiBaseUrl", "decisionsBaseUrl", "healthUrl"].flatMap((key) => {
          const value = p[key as keyof typeof p];
          if (typeof value !== "string") return [];
          const url = new URL(value);
          url.hostname = `${p.id}.example.invalid`;
          return [[key, url.toString().replace(/\/$/, "")]];
        }),
      ),
      ...(p.apiKey ? { apiKey: "fixture-static-token" } : {}),
    })),
  };
  const store = new Store(":memory:");
  const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };
  const secrets = {
    OPENROUTER_API_KEY: "router-key",
    OMLX_API_KEY: "omlx-key",
    TWILIGHT_API_KEY: "twilight-key",
    TYPESAFE_API_KEY: "typesafe-key",
  };
  const constraints: RouteConstraints[] = [
    {},
    { billing: "free_only" },
    { billing: "free_first" },
    { minTier: 1 },
    { minTier: 4 },
    { minTier: 5 },
    { avoidVendor: "anthropic" },
    { avoidVendor: ["anthropic", "openai"] },
    { excludeModels: ["mtplx/qwen-27b@none"], excludedBecause: "already reviewed checkpoint" },
    { exclude: ["codex/sol@medium", { modelId: "omlx/qwen-flash", effort: "none" }] },
    { prefer: "codex/sol@low" },
    { prefer: { modelId: "claude/opus", effort: null } },
    { only: "omlx/qwen-flash@none" },
    { only: { modelId: "codex/sol", effort: "high" } },
    { preferVendor: "qwen" },
    { preferNotVendor: ["anthropic"] },
    { preferNotModels: ["codex/sol", "claude/opus"] },
    { billing: "free_first", independenceFirst: true, avoidVendor: "qwen", minTier: 2 },
    { billing: "free_first", independenceFirst: false, avoidVendor: ["qwen", "openai"], minTier: 3 },
    { prefer: "codex/sol", exclude: ["codex/sol"], excludeModels: ["claude/opus"], minTier: 4 },
    {
      preferVendor: "openai",
      preferNotVendor: ["anthropic"],
      preferNotModels: ["codex/sol"],
      avoidVendor: "openai",
    },
  ];
  try {
    const tracker = new ProviderTracker(
      catalog.providers,
      store,
      reserves,
      secrets,
      { openrouter: 50 },
      () => 1000,
    );
    for (const provider of catalog.providers) tracker.setHealthy(provider.id, true);
    tracker.observeWindows("claude", { five_hour: { utilization: 0.2, resetsAt: 100_000 } });
    tracker.observeWindows("codex", { seven_day: { utilization: 0.5, resetsAt: 100_000 } });
    const router = new Router(tracker, DEFAULT_POLICY, catalog.models, ["codex"]);
    const decisions = [];
    for (const state of ["healthy", "disabled", "exhausted", "unavailable"]) {
      if (state === "disabled") tracker.setEnabled("claude", false);
      if (state === "exhausted") tracker.record("codex", "quota", { exhaustedUntil: 100_000 });
      if (state === "unavailable") {
        tracker.setHealthy("omlx", false);
        tracker.blockModel("openrouter/glm-5.3", "unavailable");
      }
      for (const role of Object.keys(DEFAULT_POLICY) as Role[])
        for (const complexity of ["trivial", "small", "medium", "large"] as const)
          for (const constraint of constraints)
            decisions.push({
              state,
              role,
              complexity,
              constraint,
              decision: router.route(role, complexity, constraint, false),
            });
    }
    // Probe the actual mapping by changing one reserve at a time with a live quota window.
    const reserveMappings = [];
    for (const id of ["claude", "codex"])
      for (const window of ["five_hour", "seven_day"])
        for (const key of Object.keys(reserves) as (keyof typeof reserves)[]) {
          const probeStore = new Store(":memory:");
          try {
            const probe = new ProviderTracker(
              catalog.providers,
              probeStore,
              { ...reserves, [key]: 0.1 },
              secrets,
              {},
              () => 1000,
            );
            probe.observeWindows(id, { [window]: { utilization: 0.5, resetsAt: 100_000 } });
            if (probe.unavailableReason(id) === "at reserve limit") reserveMappings.push({ id, window, key });
          } finally {
            probeStore.close();
          }
        }
    return {
      providers: catalog.providers.map((p) => p.id),
      models: catalog.models.map((m) => ({
        id: m.id,
        provider: m.provider,
        model: m.model,
        checkpoint: router.checkpointIdentity(m.id),
      })),
      reserves,
      reserveMappings,
      decisions,
    };
  } finally {
    store.close();
  }
}
