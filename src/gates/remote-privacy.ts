import { createHash } from "node:crypto";
import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { type BoundaryChunks, consumeBoundaryChunk } from "../util/privacy-chunks.ts";
import { checkAndSign, verifier } from "../util/privacy-proof.ts";
import { privateStringsDigest } from "./private.ts";
import type { GateResult } from "./run.ts";
import { gateIdentities, gatePrivacyScope, type TextPrivacy, withheldText } from "./text-privacy.ts";

type Field = TextPrivacy["output"];
type Kind = "attested:lan" | "attested:github-actions";
export type RemoteMemo = Map<string, { output: string; privacy: Field }>;
type Control = {
  signal?: AbortSignal;
  deadline: number;
  memo: RemoteMemo;
  valid?: () => boolean;
  parity?: () => boolean;
  whole?: BoundaryChunks;
  now?: () => number;
};
const context = () => {
  const scope = gatePrivacyScope.getStore(),
    checker = scope?.checker ?? getPrivacyChecker();
  return { checker, registry: scope?.registry ?? checker.registry, signer: scope?.signer };
};
export const checkRemoteLog = (text: string, control: Control) =>
  context().checker.protectText(
    { text, cut: { limit: 0, unit: "U" }, terminal: true, provenance: { kind: "complete" } },
    control,
  );
export async function recheckRemote(r: GateResult, kind: Kind, control: Control): Promise<GateResult> {
  const { failures: _failures, textPrivacy: _privacy, ...rest } = r;
  const out: GateResult = rest;
  const { checker, registry, signer } = context();
  const live = () =>
    !control.signal?.aborted && (control.valid?.() ?? true) && (control.now ?? Date.now)() < control.deadline;
  const field = async (name: "output" | "identities", text: string) => {
    const refuse = (reason: string) => ({
      output: withheldText(reason),
      privacy: { withheld: true, reason },
    });
    try {
      const fresh = verifier(registry, signer),
        claim = r.remoteAttestation?.[name];
      const eligible = () =>
        kind !== "attested:lan" ||
        (claim?.withheld === false &&
          claim.checkedComplete === true &&
          registry.ready &&
          claim.entriesDigest === privateStringsDigest(registry.entries) &&
          control.parity?.() === true);
      if (kind === "attested:lan" && claim?.withheld) return refuse("remote");
      if (!live() || !eligible()) return refuse("unproven");
      if (name === "identities" && text === "identity-cap") return refuse("identity-cap");
      const wholeReason = () => control.whole && consumeBoundaryChunk(control.whole, 0).reason;
      if (name === "output" && wholeReason()) return refuse(wholeReason() ?? "checker-failed");
      const cut =
        name === "identities"
          ? { limit: 0, unit: "U" as const }
          : kind === "attested:github-actions"
            ? { limit: 6000, unit: "U" as const, side: "tail" as const }
            : undefined;
      const key = createHash("sha256")
        .update(JSON.stringify([kind, name, text, cut, claim?.truncated === true]))
        .digest("hex");
      const cached = control.memo.get(key);
      if (
        cached?.privacy.kind === kind &&
        fresh.verify(
          cached.privacy,
          name,
          name === "identities" ? text : cached.output,
          cached.privacy.truncated === true,
        )
      )
        return cached;
      let output = text,
        truncated = false;
      const reader = {
        registry,
        protectText: async (...args: Parameters<typeof checker.protectText>) => {
          const receipt = await (args[0].provenance.kind === "cut"
              ? checker.protectProducerCut
              : checker.protectText)(...args),
            parts: Uint8Array[] = [];
          if (!live()) throw Error("Changed remote job");
          for (let index = 0; ; index++) {
            const part = consumeBoundaryChunk(receipt, index, { registry });
            truncated = name === "output" && part.truncated === true;
            if (part.withheld || part.done) break;
            parts.push(part.bytes);
          }
          if (name === "output") output = Buffer.concat(parts).toString();
          return receipt;
        },
      };
      let reason = "checker-failed";
      const proof = await checkAndSign({
        checker: { ...reader, protectProducerCut: reader.protectText },
        producerCut: name === "output" && kind === "attested:lan" && claim?.truncated === true,
        signer,
        kind,
        field: name,
        text,
        cut,
        signal: control.signal,
        deadline: control.deadline,
        onRefusal: (value) => {
          reason = value;
        },
      });
      if (!live() || !eligible()) return refuse("unproven");
      if (name === "output" && wholeReason()) return refuse(wholeReason() ?? "checker-failed");
      if (!proof) return refuse(reason);
      const signed = {
        output,
        privacy: {
          withheld: false,
          checkedComplete: true,
          ...(truncated ? { truncated: true } : {}),
          ...proof,
        },
      };
      control.memo.set(key, signed);
      return signed;
    } catch {
      return refuse("checker-failed");
    }
  };
  const output = await field("output", r.output);
  out.output = output.output;
  out.textPrivacy = {
    output: output.privacy,
    identities: (await field("identities", gateIdentities(r))).privacy,
  };
  for (const key of ["firstAttempt", "targetedRetry", "retryAttempt"] as const)
    if (r[key]) out[key] = await recheckRemote(r[key], kind, control);
  const fresh = verifier(registry, signer);
  for (const name of ["output", "identities"] as const) {
    const privacy = out.textPrivacy[name];
    if (
      privacy?.mac &&
      (!live() ||
        (kind === "attested:lan" && !control.parity?.()) ||
        (name === "output" && control.whole && consumeBoundaryChunk(control.whole, 0).withheld) ||
        !fresh.verify(
          privacy,
          name,
          name === "output" ? out.output : gateIdentities(out),
          privacy.truncated === true,
        ))
    ) {
      out.textPrivacy[name] = { withheld: true, reason: "stale-generation" };
      if (name === "output") out.output = withheldText("stale-generation");
    }
  }
  return out;
}
