import type { GateResult } from "../src/gates/run.ts";
import { gateIdentities, gatePrivacyScope } from "../src/gates/text-privacy.ts";
import { credentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import {
  createPrivacyChecker,
  type PrivacyWorkerPort,
  privacyWorkerHandler,
} from "../src/util/privacy-checker.ts";
import { checkAndSign } from "../src/util/privacy-proof.ts";

export function privacyPort(): PrivacyWorkerPort {
  const worker = {
    onmessage: undefined as PrivacyWorkerPort["onmessage"],
    postMessage: (data: unknown) => {
      setImmediate(() => parent.onmessage?.({ data: structuredClone(data) }));
    },
  };
  const parent: PrivacyWorkerPort = {
    postMessage: (data) => {
      setImmediate(() => worker.onmessage?.({ data: structuredClone(data) }));
    },
    ref() {},
    unref() {},
    terminate: async () => {},
  };
  privacyWorkerHandler(worker);
  return parent;
}
const registry = createPrivacyRegistry(credentialRegistry);
export const testGatePrivacy = {
  registry,
  checker: createPrivacyChecker({ registry, workerFactory: privacyPort }),
  signer: () => Buffer.alloc(32, 29),
};
export async function provenResult<T extends GateResult>(r: T): Promise<T> {
  const scope = gatePrivacyScope.getStore() ?? testGatePrivacy;
  const sign = async (field: "output" | "identities", text: string) => {
    const proof = await checkAndSign({
      ...scope,
      kind: "complete",
      field,
      text,
      cut: { limit: 0, unit: "U", marker: "" },
    });
    if (!proof) throw new Error("Fixture did not pass the privacy checker");
    return { ...proof, withheld: false, checkedComplete: true };
  };
  return {
    ...r,
    textPrivacy: {
      output: await sign("output", r.output),
      identities: await sign("identities", gateIdentities(r)),
    },
  };
}

export const privacyTexts = ["secret-host.example", "privacy-test-credential"].flatMap((value) => {
  const unicode = [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const percent = [...value].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
  let nested = percent;
  for (let i = 0; i < 6; i++) nested = encodeURIComponent(nested);
  return [
    value,
    [...value].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(""),
    unicode,
    percent,
    encodeURIComponent(percent),
    percent.replaceAll("%", "\\u0025"),
    encodeURIComponent(unicode),
    nested,
  ];
});

const percent = (value: string) =>
  [...value].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
export const truncationEncodings = [
  ["plain", (value: string) => value],
  ["URL", percent],
  ["double URL", (value: string) => encodeURIComponent(percent(value))],
  ["Unicode-escaped percent", (value: string) => percent(value).replaceAll("%", "\\u0025")],
  [
    "mixed",
    (value: string) =>
      [...value]
        .map(
          (c, i) =>
            [c, percent(c), encodeURIComponent(percent(c)), percent(c).replaceAll("%", "\\u0025")][i % 4],
        )
        .join(""),
  ],
] as const;
