import { statSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateStrings } from "../gates/private.ts";
import { privacyRegistry } from "./privacy-boundary.ts";
import { disposePrivacyChecker } from "./privacy-checker.ts";
import { redactCredentials } from "./proc.ts";

/** The one routine probe per check: identity, size and modification time, following any link. */
export function inspectPolicyFile(path: string) {
  const s = statSync(path, { throwIfNoEntry: false });
  return s ? `${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}` : "missing";
}
export const privacyPolicyDiagnostic = "Privacy policy unavailable; privacy checks will refuse.";
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
  let failed = false;
  registry.refreshPolicy = () => {
    try {
      // Stamped before reading, so an edit racing the load differs from `loaded` and reloads next check.
      const stamp = inspect(path);
      if (registry.ready && stamp === loaded) return;
      loaded = undefined;
      registry.replacePolicy(load(configDir, roots));
      loaded = stamp;
      failed = false;
    } catch {
      registry.failPolicy();
      if (!failed) {
        failed = true;
        log(redactCredentials(privacyPolicyDiagnostic));
      }
    }
  };
  registry.refreshPolicy();
}
export const processPrivacy = { provision: provisionPrivacyPolicy, dispose: disposePrivacyChecker };
