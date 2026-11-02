import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateStrings } from "../gates/private.ts";
import { privacyRegistry } from "./privacy-boundary.ts";
import { disposePrivacyChecker } from "./privacy-checker.ts";
import { redactCredentials } from "./proc.ts";

/** At most two metadata probes capture both the path itself and any link target. */
export function inspectPolicyFile(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return "missing";
  return [entry, statSync(path, { throwIfNoEntry: false })]
    .map((s) => (s ? `${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}` : "missing"))
    .join(":");
}
export const privacyPolicyDiagnostic = "Privacy policy unavailable; privacy checks will refuse.";
const failedRegistries = new WeakSet<typeof privacyRegistry>();
/** Bind once at startup; checks share this synchronous freshness/readiness boundary. */
export function provisionPrivacyPolicy(
  configDir: string,
  roots: string[],
  {
    registry = privacyRegistry,
    inspect = inspectPolicyFile,
    load = loadPrivateStrings,
    log = console.error,
  } = {},
) {
  const path = join(configDir, "private-strings.txt");
  let loaded: string | undefined;
  registry.refreshPolicy = () => {
    try {
      // Stamped before reading, so an edit racing the load differs from `loaded` and reloads next check.
      const stamp = inspect(path);
      if (registry.ready && stamp === loaded) return;
      loaded = undefined;
      registry.replacePolicy(load(configDir, roots));
      loaded = stamp;
      failedRegistries.delete(registry);
    } catch {
      registry.failPolicy();
      if (!failedRegistries.has(registry)) {
        failedRegistries.add(registry);
        log(redactCredentials(privacyPolicyDiagnostic));
      }
    }
  };
  registry.refreshPolicy();
}
export const processPrivacy = { provision: provisionPrivacyPolicy, dispose: disposePrivacyChecker };
