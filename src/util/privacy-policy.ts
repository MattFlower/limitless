import { lstatSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateStrings } from "../gates/private.ts";
import { privacyRegistry } from "./privacy-boundary.ts";
import { disposePrivacyChecker } from "./privacy-checker.ts";
import { redactCredentials } from "./proc.ts";

const stamp = (s?: Stats) => (s ? `${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}` : "missing");
/** One lstat tells true absence from a dangling link; only a symlinked policy also stats its target. */
export const inspectPolicyFile = (path: string) => {
  const link = lstatSync(path, { throwIfNoEntry: false });
  return link?.isSymbolicLink()
    ? `${stamp(link)}>${stamp(statSync(path, { throwIfNoEntry: false }))}`
    : stamp(link);
};
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
  let failed = false;
  registry.refreshPolicy = () => {
    try {
      const next = inspect(join(configDir, "private-strings.txt"));
      if (registry.ready && next === loaded) return;
      registry.replacePolicy(load(configDir, roots));
      loaded = next;
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
