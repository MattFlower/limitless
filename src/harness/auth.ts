import type { Harness } from "./types.ts";

/** Resolve subscription authentication locally at each machine's launch boundary. */
export function withSubscriptionAuth(
  name: string,
  harness: Harness,
  secrets: Record<string, string>,
): Harness {
  return (spec) =>
    harness(name === "claude" ? { ...spec, claudeSubscriptionToken: secrets.CLAUDE_CODE_OAUTH_TOKEN } : spec);
}
