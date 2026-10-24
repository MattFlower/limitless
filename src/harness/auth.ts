import { registerCredential } from "../util/proc.ts";
import type { Harness } from "./types.ts";

export function subscriptionToken(name: string, secrets: Record<string, string>): string | undefined {
  const token = name === "claude" ? secrets.CLAUDE_CODE_OAUTH_TOKEN : undefined;
  if (token) registerCredential("CLAUDE_CODE_OAUTH_TOKEN", token);
  return token;
}

/** Resolve subscription authentication locally at each machine's launch boundary. */
export function withSubscriptionAuth(
  name: string,
  harness: Harness,
  secrets: Record<string, string>,
): Harness {
  return (spec) =>
    harness(
      name === "claude" ? { ...spec, claudeSubscriptionToken: subscriptionToken(name, secrets) } : spec,
    );
}
