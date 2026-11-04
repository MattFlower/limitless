import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { consumeBoundaryChunk } from "../util/privacy-chunks.ts";
import { checkAndSign } from "../util/privacy-proof.ts";
import type { ProcResult } from "../util/proc.ts";
import { privateStringsDigest } from "./private.ts";
import { gatePrivacyScope, type TextPrivacy, withheldText } from "./text-privacy.ts";

/** Only complete captures enter the checker; process tails are never evidence. */
export async function protectGateOutput(
  res: ProcResult,
  identities: string | (() => string),
  control: { signal?: AbortSignal; deadline: number },
): Promise<{ output: string; textPrivacy: TextPrivacy }> {
  const withheld = (reason: string): TextPrivacy["output"] => ({ withheld: true, reason });
  let output = "",
    field = withheld("checker-failed"),
    identityField = withheld("checker-failed");
  try {
    identities = typeof identities === "function" ? identities() : identities;
    if (identities === "identity-cap") identityField = withheld("identity-cap");
    const scope = gatePrivacyScope.getStore(),
      checker = scope?.checker ?? getPrivacyChecker(),
      registry = scope?.registry ?? checker.registry;
    let checked = field,
      bytes = "",
      digest = "";
    // Receipt consumption and its policy digest are observed in the same synchronous turn.
    const reader = {
      registry,
      protectText: async (...args: Parameters<typeof checker.protectText>) => {
        const receipt = await checker.protectText(...args),
          parts: Uint8Array[] = [];
        checked = withheld("checker-failed");
        bytes = "";
        digest = privateStringsDigest(registry.entries);
        for (let index = 0; ; index++) {
          const part = consumeBoundaryChunk(receipt, index, { registry });
          if (part.withheld || !part.checkedComplete) {
            checked = withheld(part.reason ?? "checker-failed");
            break;
          }
          checked = { withheld: false, checkedComplete: true, kind: "complete" };
          if (part.done) {
            bytes = Buffer.concat(parts).toString();
            break;
          }
          parts.push(part.bytes);
        }
        return receipt;
      },
    };
    const verdict = { limit: 0, unit: "U" as const, marker: "" };
    const sign = async (
      text: string,
      field: string,
      cut: Parameters<typeof checkAndSign>[0]["cut"] = verdict,
    ) => {
      let refused: string | undefined;
      const proof = await checkAndSign({
        onRefusal: (reason) => {
          refused = reason;
        },
        checker: reader,
        signer: scope?.signer,
        kind: "complete",
        field,
        text,
        cut,
        ...control,
      });
      // A configured signer refusing its final guard must not become an unsigned release.
      return refused ? withheld(refused) : { ...checked, ...proof };
    };
    try {
      const capture = res.capture;
      if (
        res.cancelled ||
        res.timedOut ||
        capture?.provenance.kind !== "complete" ||
        !("stdout" in capture)
      ) {
        field = withheld(
          res.cancelled
            ? "checker-cancelled"
            : capture?.provenance.kind === "cut"
              ? "capture-cap"
              : "capture-incomplete",
        );
      } else {
        const { stdout, stderr } = capture;
        let generation: string | undefined;
        // A single stream is already the rendering; R3 checks its untrimmed original once.
        for (const text of stdout && stderr ? [stdout, stderr] : []) {
          await reader.protectText(
            { text, cut: verdict, terminal: true, provenance: { kind: "complete" } },
            control,
          );
          field = checked;
          if (generation !== undefined && generation !== digest) field = withheld("stale-generation");
          generation ??= digest;
          if (field.withheld) break;
        }
        if (generation === undefined || !field.withheld) {
          field = await sign(stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr, "output", {
            limit: 6000,
            unit: "U",
            side: "tail",
          });
          if (generation !== undefined && generation !== digest) field = withheld("stale-generation");
          if (!field.withheld) output = bytes;
        }
      }
    } catch {
      field = withheld("checker-failed");
    }
    if (identities !== "identity-cap") {
      try {
        identityField = await sign(identities, "identities");
      } catch {
        identityField = withheld("checker-failed");
      }
    }
  } catch {
    field = withheld("checker-failed");
  }
  return {
    output: field.withheld ? withheldText(field.reason, res.timedOut) : output,
    textPrivacy: { output: field, identities: identityField },
  };
}
