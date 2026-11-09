import { createHash } from "node:crypto";
import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { type BoundaryChunks, consumeBoundaryChunk } from "../util/privacy-chunks.ts";
import { checkAndSign, verifier } from "../util/privacy-proof.ts";
import { RENDER_LIMITS, renderGateOutput } from "./failures.ts";
import { renderingCredentialsUnchanged } from "./output.ts";
import { privateStringsDigest } from "./private.ts";
import type { GateResult } from "./run.ts";
import { gateIdentities, gatePrivacyScope, type TextPrivacy, withheldText } from "./text-privacy.ts";

type Field = TextPrivacy["output"];
type FieldName = "output" | "identities" | "failures" | `rendering:${(typeof RENDER_LIMITS)[number]}`;
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
  const eligible = (source: GateResult, name: FieldName) => {
    const claim = source.remoteAttestation?.[name === "identities" ? name : "output"];
    return (
      kind !== "attested:lan" ||
      (claim?.withheld === false &&
        claim.checkedComplete === true &&
        registry.ready &&
        claim.entriesDigest === privateStringsDigest(registry.entries) &&
        control.parity?.() === true)
    );
  };
  const field = async (name: FieldName, text: string): Promise<{ output: string; privacy: Field }> => {
    const refuse = (reason: string) => ({
      output: withheldText(reason),
      privacy: { withheld: true, reason },
    });
    try {
      const fresh = verifier(registry, signer),
        diagnostic = name === "failures" || name.startsWith("rendering:"),
        claim = r.remoteAttestation?.[name === "identities" ? name : "output"];
      if (name !== "identities" && r.timedOut) return refuse("timeout");
      if (kind === "attested:lan" && claim?.withheld) return refuse("remote");
      if (!live() || !eligible(r, name)) return refuse("unproven");
      if (name === "identities" && text === "identity-cap") return refuse("identity-cap");
      const wholeReason = () => control.whole && consumeBoundaryChunk(control.whole, 0).reason;
      if (name !== "identities" && wholeReason()) return refuse(wholeReason() ?? "checker-failed");
      if (
        diagnostic &&
        (!out.textPrivacy ||
          out.textPrivacy.output.withheld ||
          !fresh.verify(
            out.textPrivacy.output,
            "output",
            out.output,
            out.textPrivacy.output.truncated === true,
          ))
      )
        return refuse("stale-generation");
      const cut = diagnostic
        ? { limit: Math.max(1, text.length), unit: "U" as const }
        : name === "identities"
          ? { limit: 0, unit: "U" as const }
          : kind === "attested:github-actions"
            ? { limit: 6000, unit: "U" as const, side: "tail" as const }
            : undefined;
      const key = createHash("sha256")
        .update(JSON.stringify([kind, name, text, cut, diagnostic || claim?.truncated === true]))
        .digest("hex");
      const cached = control.memo.get(key);
      // Rechecking an old cut cannot recover a newly registered credential's missing suffix.
      if (diagnostic && cached?.privacy.kind === kind && !fresh.credentialsUnchanged(cached.privacy))
        return refuse("credential-changed");
      if (
        cached?.privacy.kind === kind &&
        (!diagnostic ||
          (fresh.credentialsUnchanged(cached.privacy) && renderingCredentialsUnchanged(text))) &&
        fresh.verify(
          cached.privacy,
          name,
          name !== "output" ? text : cached.output,
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
            truncated = name !== "identities" && part.truncated === true;
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
        producerCut:
          diagnostic || (name === "output" && kind === "attested:lan" && claim?.truncated === true),
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
      if (!live() || !eligible(r, name)) return refuse("unproven");
      if (name !== "identities" && wholeReason()) return refuse(wholeReason() ?? "checker-failed");
      if (!proof) return refuse(reason);
      if (diagnostic && !renderingCredentialsUnchanged(text)) return refuse("credential-changed");
      const signed = {
        output,
        privacy: {
          withheld: false,
          checkedComplete: true,
          entriesDigest: privateStringsDigest(registry.entries),
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
  out.output = output.privacy.withheld ? withheldText(output.privacy.reason, r.timedOut) : output.output;
  out.textPrivacy = {
    output: output.privacy,
    identities: (await field("identities", gateIdentities(r))).privacy,
  };
  if (kind === "attested:lan" && !r.ok && !r.timedOut && r.failures !== undefined) {
    const excerpt = output.privacy.withheld ? output : await field("failures", r.failures);
    out.textPrivacy.failures = excerpt.privacy;
    if (!excerpt.privacy.withheld) out.failures = r.failures;
  }
  if (!output.privacy.withheld) {
    for (const limit of RENDER_LIMITS) {
      const bytes = renderGateOutput(out, limit);
      if (bytes === out.output) continue;
      const rendering = await field(`rendering:${limit}`, bytes);
      out.textPrivacy.renderings ??= {};
      out.textPrivacy.renderings[limit] = rendering.privacy;
    }
  }
  for (const key of ["firstAttempt", "targetedRetry", "retryAttempt"] as const)
    if (r[key]) out[key] = await recheckRemote(r[key], kind, control);
  const fresh = verifier(registry, signer);
  // Later retry checks can invalidate proofs from an earlier sibling.
  const revalidate = (result: GateResult, source: GateResult) => {
    const privacy = result.textPrivacy;
    if (!privacy) return;
    const fields: [FieldName, Field | undefined, () => string, (value: Field) => void][] = [
      [
        "output",
        privacy.output,
        () => result.output,
        (v) => {
          privacy.output = v;
          result.output = withheldText(v.reason, source.timedOut);
        },
      ],
      [
        "identities",
        privacy.identities,
        () => gateIdentities(result),
        (v) => {
          privacy.identities = v;
        },
      ],
      [
        "failures",
        privacy.failures,
        () => result.failures ?? "",
        (v) => {
          privacy.failures = v;
          delete result.failures;
        },
      ],
      ...RENDER_LIMITS.map((limit): (typeof fields)[number] => [
        `rendering:${limit}`,
        privacy.renderings?.[limit],
        () => renderGateOutput(result, limit),
        (v) => {
          if (privacy.renderings) privacy.renderings[limit] = v;
        },
      ]),
    ];
    for (const [name, record, candidate, refuse] of fields) {
      const bytes = candidate();
      if (
        record?.mac &&
        (!live() ||
          !eligible(source, name) ||
          (name !== "identities" &&
            (source.timedOut || (control.whole && consumeBoundaryChunk(control.whole, 0).withheld))) ||
          (name !== "output" &&
            name !== "identities" &&
            (privacy.output.withheld ||
              !fresh.credentialsUnchanged(record) ||
              !renderingCredentialsUnchanged(bytes))) ||
          !fresh.verify(record, name, bytes, record.truncated === true))
      )
        refuse({ withheld: true, reason: "stale-generation" });
    }
    for (const key of ["firstAttempt", "targetedRetry", "retryAttempt"] as const) {
      const child = result[key],
        original = source[key];
      if (child && original) revalidate(child, original);
    }
  };
  revalidate(out, r);
  return out;
}
