import { statSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateStrings } from "../gates/private.ts";
import { privacyRegistry } from "./privacy-boundary.ts";
import { disposePrivacyChecker } from "./privacy-checker.ts";
import { redactCredentials } from "./proc.ts";

const inspect = (path: string) => statSync(path, { throwIfNoEntry: false });
export const privacyPolicyDiagnostic = "Privacy policy unavailable; privacy checks will refuse.";
/** Bind once at startup; checks share this synchronous freshness/readiness boundary. */
export function provisionPrivacyPolicy(
  configDir: string,
  roots: string[],
  { registry = privacyRegistry, stat = inspect, load = loadPrivateStrings, log = console.error } = {},
) {
  let stamp: string | undefined;
  let failed = false;
  registry.refreshPolicy = () => {
    try {
      const file = stat(join(configDir, "private-strings.txt"));
      const next = file ? `${file.dev}/${file.ino}/${file.size}/${file.mtimeMs}/${file.ctimeMs}` : "missing";
      // stat follows links: a missing target still needs the loader's dangling-link validation.
      if (registry.ready && file && next === stamp) return;
      registry.replacePolicy(load(configDir, roots));
      stamp = next;
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
