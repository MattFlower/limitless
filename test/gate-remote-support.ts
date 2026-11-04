import { privateStringsDigest } from "../src/gates/private.ts";
import type { GateResult } from "../src/gates/run.ts";
import { gatePrivacyScope, remoteGateData } from "../src/gates/text-privacy.ts";
import { createCredentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import {
  createPrivacyChecker,
  type PrivacyWorkerPort,
  privacyWorkerHandler,
} from "../src/util/privacy-checker.ts";
import { Check } from "../src/workers/protocol.ts";

function port(): PrivacyWorkerPort {
  const worker = {
    onmessage: undefined as PrivacyWorkerPort["onmessage"],
    postMessage(data: unknown) {
      setImmediate(() => parent.onmessage?.({ data: structuredClone(data) }));
    },
  };
  const parent: PrivacyWorkerPort = {
    postMessage(data) {
      setImmediate(() => worker.onmessage?.({ data: structuredClone(data) }));
    },
    ref() {},
    unref() {},
    terminate: async () => {},
  };
  privacyWorkerHandler(worker);
  return parent;
}
export function remoteFixture(entries: string[] = [], credential?: string) {
  const credentials = createCredentialRegistry();
  if (credential) credentials.add(credential);
  const registry = createPrivacyRegistry(credentials);
  registry.refreshPolicy = () => {};
  const policy = (values: string[]) =>
    registry.replacePolicy(values.map((value, entry) => ({ value, entry })));
  policy(entries);
  const checker = createPrivacyChecker({ registry, workerFactory: port });
  const signer: () => Buffer | undefined = () => Buffer.alloc(32, 29);
  const scope = { checker, registry, signer };
  const scoped = <T>(fn: () => T) => gatePrivacyScope.run(scope, fn);
  const result = (extra: Partial<GateResult> = {}) => {
    const claim = {
      withheld: false,
      checkedComplete: true,
      entriesDigest: privateStringsDigest(registry.entries),
    };
    return remoteGateData(
      Check.parse({
        name: "test",
        command: "bun test",
        ok: true,
        exitCode: 0,
        durationMs: 1,
        output: "clean",
        ...extra,
        textPrivacy: { output: claim, identities: claim },
      }),
    );
  };
  return { checker, registry, signer, scope, scoped, result, policy, credentials };
}
