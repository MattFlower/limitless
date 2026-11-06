import { appendFileSync, chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { projectGateDiagnostics, redactGateOutput } from "../gates/output.ts";
import type { GateResult } from "../gates/run.ts";
import { verifier } from "../util/privacy-proof.ts";
import { checkRendering, renderingPrivacy } from "../util/privacy-rendering.ts";

export function openLandLog(path: string) {
  for (const file of [path, `${path}.proof`]) {
    writeFileSync(file, "", { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return {
    path,
    length: 0,
    chain: Promise.resolve(),
    error: undefined as unknown,
    async settled() {
      await this.chain;
      if (this.error) throw this.error;
    },
  };
}
export function appendLandLog(
  log: ReturnType<typeof openLandLog>,
  parts: readonly (string | GateResult)[],
  signal?: AbortSignal,
) {
  log.chain = log.chain
    .then(async () => {
      const { registry, signer } = renderingPrivacy();
      const text = parts
        .map((part) => {
          if (typeof part === "string") return part;
          const projected = projectGateDiagnostics(part, { mode: "outward", registry, signer });
          return `${projected.command}\n${projected.output}`;
        })
        .join("");
      const { rendering, proof, reason } = await checkRendering(text, "land-log-entry", signal);
      const bytes = Buffer.from(reason ? `[land log entry withheld: ${reason}]\n` : rendering);
      // Older releases can append foreign bytes; inspect placement without rereading any content.
      const offset = statSync(log.path).size;
      appendFileSync(log.path, bytes);
      log.length = offset + bytes.length;
      const entry = { offset, length: bytes.length, mac: proof?.mac };
      if (proof) appendFileSync(`${log.path}.proof`, `${JSON.stringify(entry)}\n`);
    })
    .catch((error: unknown) => {
      log.error ??= error;
    });
  return log.chain;
}
export function readLandLog(path: string): string {
  const bytes = readFileSync(path),
    { registry, signer } = renderingPrivacy(),
    fresh = verifier(registry, signer);
  let sidecar = "",
    offset = 0;
  try {
    sidecar = readFileSync(`${path}.proof`, "utf8");
  } catch {
    /* Legacy/unreadable sidecars prove nothing. */
  }
  const out: string[] = [],
    marker = (reason = "unproven") => `[land log entry withheld: ${reason}]\n`;
  for (const line of sidecar.split("\n")) {
    try {
      const entry: { offset: number; length: number; mac: string } = JSON.parse(line);
      if (
        !entry ||
        !Number.isSafeInteger(entry.offset) ||
        !Number.isSafeInteger(entry.length) ||
        entry.offset < offset ||
        entry.length <= 0 ||
        entry.offset + entry.length > bytes.length
      )
        continue;
      if (entry.offset > offset) out.push(marker());
      const part = bytes.subarray(entry.offset, entry.offset + entry.length),
        text = part.toString();
      const proved = fresh.verify({ kind: "rendering", mac: entry.mac }, "land-log-entry", part);
      const reason = !proved ? "unproven" : redactGateOutput(text) !== text ? "credential-changed" : null;
      out.push(reason ? marker(reason) : text);
      offset = entry.offset + entry.length;
    } catch {
      /* Malformed lines leave their bytes uncovered. */
    }
  }
  if (offset < bytes.length) out.push(marker());
  return out.join("");
}
