import { test as bunTest } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureReadPolicy, readPolicyScope } from "../src/harness/read-policy.ts";

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
              (...values: unknown[]) =>
                readPolicyScope.run(testReadPolicy, () => Reflect.apply(callback, undefined, values)),
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
