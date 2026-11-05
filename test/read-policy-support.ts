import { test as bunTest, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatePrivacyScope } from "../src/gates/text-privacy.ts";
import { configureReadPolicy, readPolicyScope } from "../src/harness/read-policy.ts";
import { credentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry, privacyLimits } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker } from "../src/util/privacy-checker.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { testGatePrivacy } from "./privacy-support.ts";

export const testReadPolicy = configureReadPolicy(undefined, join(tmpdir(), "test-factory-config"));

// Bun isolates async context between hooks and tests. Bind the policy to each callback instead.
function scoped<T extends (...args: never[]) => unknown>(runner: T): T {
  return new Proxy(runner, {
    apply(target, receiver, args: unknown[]) {
      const [name, callback, ...rest] = args;
      const result = Reflect.apply(
        target,
        receiver,
        typeof callback === "function"
          ? [
              name,
              async (...values: unknown[]) => {
                // Match daemon startup without retaining oversized credentials from earlier test fixtures.
                const previous = new Set(credentialRegistry.values()),
                  added = new Set<string>();
                const add = credentialRegistry.add;
                const registration = spyOn(credentialRegistry, "add").mockImplementation((value) => {
                  added.add(value);
                  add(value);
                });
                const registry = createPrivacyRegistry({
                  ...credentialRegistry,
                  values: (worker) =>
                    credentialRegistry
                      .values(worker)
                      .filter(
                        (v) => v.length <= privacyLimits.originalLength || !previous.has(v) || added.has(v),
                      ),
                });
                provisionPrivacyPolicy(
                  process.env.LIMITLESS_CONFIG_DIR ?? join(tmpdir(), "test-factory-config"),
                  [],
                  { registry },
                );
                const checker = createPrivacyChecker({ registry });
                try {
                  return await gatePrivacyScope.run(
                    { checker, registry, signer: testGatePrivacy.signer },
                    () =>
                      readPolicyScope.run(testReadPolicy, () => Reflect.apply(callback, undefined, values)),
                  );
                } finally {
                  registration.mockRestore();
                  await checker.dispose();
                }
              },
              ...rest,
            ]
          : args,
      );
      return typeof result === "function" ? scoped(result) : result;
    },
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? scoped(value.bind(target)) : value;
    },
  });
}
export const test = scoped(bunTest);
