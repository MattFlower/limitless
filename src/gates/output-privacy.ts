import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { consumeBoundaryChunk } from "../util/privacy-chunks.ts";
import { checkAndSign, verifier } from "../util/privacy-proof.ts";
import type { ProcResult } from "../util/proc.ts";
import { privateStringsDigest } from "./private.ts";
import { gatePrivacyScope, type TextPrivacy, withheldText } from "./text-privacy.ts";

/** Only complete captures enter the checker; process tails are never evidence. */
export async function protectGateOutput(
  res: ProcResult,
  identities: string | (() => string),
  control: { signal?: AbortSignal; deadline: number },
  excerpt?: string,
  excerptCurrent?: () => boolean,
): Promise<{ output: string; textPrivacy: TextPrivacy; failures?: string }> {
  const withheld = (reason: string): TextPrivacy["output"] => ({ withheld: true, reason });
  let failures: string | undefined, failureField: TextPrivacy["failures"];
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
        const receipt = await (args[0].provenance.kind === "cut"
            ? checker.protectProducerCut
            : checker.protectText)(...args),
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
          checked = {
            withheld: false,
            checkedComplete: true,
            kind: "complete",
            entriesDigest: digest,
            ...(part.truncated && args[0].cut?.limit !== 0 && { truncated: true }),
          };
          if (part.done) {
            bytes = Buffer.concat(parts).toString();
            break;
          }
          parts.push(part.bytes);
        }
        return receipt;
      },
    };
    const signingReader = { ...reader, protectProducerCut: reader.protectText };
    const verdict = { limit: 0, unit: "U" as const, marker: "" };
    const sign = async (
      text: string,
      field: string,
      cut: Parameters<typeof checkAndSign>[0]["cut"] = verdict,
      producerCut = false,
    ) => {
      let refused: string | undefined;
      const proof = await checkAndSign({
        onRefusal: (reason) => {
          refused = reason;
        },
        checker: signingReader,
        producerCut,
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
    let sourceDigest = "";
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
          if (!field.withheld) {
            output = bytes;
            sourceDigest = digest;
          }
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
    if (excerpt !== undefined) {
      const signing = verifier(registry, scope?.signer).available;
      failureField = field.withheld ? withheld(field.reason ?? "checker-failed") : withheld("checker-failed");
      if (!field.withheld && excerptCurrent?.()) {
        try {
          failureField = await sign(
            excerpt,
            "failures",
            { limit: Math.max(1, excerpt.length), unit: "U" },
            true,
          );
          if (digest !== sourceDigest) failureField = withheld("stale-generation");
          if (!failureField.withheld) failures = excerpt;
        } catch {
          failureField = withheld("checker-failed");
        }
      }
      if (!excerptCurrent?.()) {
        failures = undefined;
        failureField = withheld("stale-generation");
      }
      if (!signing) failureField = undefined;
    }
  } catch {
    field = withheld("checker-failed");
  }
  return {
    output: field.withheld ? withheldText(field.reason, res.timedOut) : output,
    ...(failures !== undefined && { failures }),
    textPrivacy: {
      output: field,
      identities: identityField,
      ...(failureField && { failures: failureField }),
    },
  };
}
