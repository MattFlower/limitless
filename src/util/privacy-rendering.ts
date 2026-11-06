import { gatePrivacyScope } from "../gates/text-privacy.ts";
import { getPrivacyChecker } from "./privacy-checker.ts";
import { consumeBoundaryChunk } from "./privacy-chunks.ts";
import { checkAndSign } from "./privacy-proof.ts";

export function renderingPrivacy() {
  const scope = gatePrivacyScope.getStore(),
    checker = scope?.checker ?? getPrivacyChecker();
  return { checker, registry: scope?.registry ?? checker.registry, signer: scope?.signer };
}
/** Capture the receipt's rendering; checkAndSign reconsumes and signs it synchronously. */
export async function checkRendering(text: string, field: string, signal?: AbortSignal) {
  const { checker, registry, signer } = renderingPrivacy();
  let rendering = "",
    reason: string | undefined;
  try {
    const proof = await checkAndSign({
      kind: "rendering",
      field,
      text,
      signer,
      signal,
      deadline: Date.now() + 30_000,
      checker: {
        registry,
        protectText: async (...args: Parameters<typeof checker.protectText>) => {
          const receipt = await checker.protectText(...args),
            parts: Uint8Array[] = [];
          for (let index = 0; ; index++) {
            const part = consumeBoundaryChunk(receipt, index, { registry });
            if (part.withheld || !part.checkedComplete || part.done) break;
            parts.push(part.bytes);
          }
          rendering = Buffer.concat(parts).toString();
          return receipt;
        },
      },
      onRefusal: (value) => {
        reason = value;
      },
    });
    return { rendering, proof: reason ? undefined : proof, reason };
  } catch {
    return { rendering: "", reason: "checker-failed" };
  }
}
