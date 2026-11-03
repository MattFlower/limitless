import { privacyRegistry } from "../src/util/privacy-boundary.ts";
import { disposePrivacyChecker } from "../src/util/privacy-checker.ts";

export const testPrivacy = { provision() {}, async dispose() {} };

export async function resetProcessPrivacy() {
  privacyRegistry.refreshPolicy = () => {};
  privacyRegistry.replacePolicy([]);
  privacyRegistry.failPolicy();
  await disposePrivacyChecker();
}
