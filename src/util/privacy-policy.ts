import { lstatSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateStrings } from "../gates/private.ts";
import { privacyRegistry } from "./privacy-boundary.ts";
import { disposePrivacyChecker } from "./privacy-checker.ts";
import { redactCredentials } from "./proc.ts";

const stamp = (s?: Stats) => (s ? `${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}` : "missing");
/** One probe: lstat watches a cached absence (a dangling link appears), stat a loaded file through any link. */
export const inspectPolicyFile = (path: string, follow: boolean) =>
  stamp((follow ? statSync : lstatSync)(path, { throwIfNoEntry: false }));
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
  let loaded: string | undefined;
  let follow = false;
  let failed = false;
  registry.refreshPolicy = () => {
    try {
      const path = join(configDir, "private-strings.txt");
      if (registry.ready && inspect(path, follow) === loaded) return;
      // Reloads pick the next routine probe, stamped before reading so a concurrent edit reloads again.
      const present = inspect(path, false) !== "missing";
      const next = present ? inspect(path, true) : "missing";
      registry.replacePolicy(load(configDir, roots));
      [loaded, follow] = [next, present];
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
