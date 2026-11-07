import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { redactGateOutput } from "../gates/output.ts";
import { gatePrivacyScope, withheldText } from "../gates/text-privacy.ts";
import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { checkAndSign, verifier } from "../util/privacy-proof.ts";

type Options = Pick<Parameters<typeof checkAndSign>[0], "checker" | "signer">;
const options = (): Options => gatePrivacyScope.getStore() ?? { checker: getPrivacyChecker() };
const withheld = (reason = "unverified") =>
  reason === "unverified"
    ? "[land log entry withheld: unverified]"
    : withheldText(reason).replace("[withheld:", "[land log entry withheld:");
export function openLandLog(path: string, header: string, privacy = options()) {
  writeFileSync(path, "");
  writeFileSync(`${path}.proof`, "", { mode: 0o600 });
  chmodSync(`${path}.proof`, 0o600);
  const log = { path, offset: 0, pending: Promise.resolve(), privacy };
  appendLandLog(log, [header]);
  return log;
}
export function appendLandLog(log: ReturnType<typeof openLandLog>, parts: readonly string[]): Promise<void> {
  log.pending = log.pending
    .then(async () => {
      let reason = "unverified";
      const text = parts.join("");
      const proof = await checkAndSign({
        ...log.privacy,
        text,
        kind: "rendering",
        field: "land-log-entry",
        cut: { limit: 0, unit: "U", marker: "" },
        onRefusal: (r) => {
          reason = r;
        },
      });
      const bytes = Buffer.from(proof ? text : withheld(reason));
      const offset = log.offset;
      appendFileSync(log.path, bytes);
      log.offset += bytes.length;
      if (proof)
        appendFileSync(
          `${log.path}.proof`,
          `${JSON.stringify({ offset, length: bytes.length, mac: proof.mac })}\n`,
          { mode: 0o600 },
        );
    })
    .catch(() => {
      /* A failed append must not stall subsequent entries or reject the attempt. */
    });
  return log.pending;
}
export function readLandLog(path: string, privacy = options()): string {
  const bytes = readFileSync(path),
    snapshot = verifier(privacy.checker.registry, privacy.signer);
  let sidecar = "",
    offset = 0;
  try {
    sidecar = readFileSync(`${path}.proof`, "utf8");
  } catch {
    /* Legacy logs have no proofs. */
  }
  const output: string[] = [];
  let uncovered = false;
  const hide = () => {
    if (!uncovered) output.push(withheld());
    uncovered = true;
  };
  for (const line of sidecar.split("\n")) {
    let entry: { offset: number; length: number; mac: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !entry ||
      !Number.isSafeInteger(entry.offset) ||
      !Number.isSafeInteger(entry.length) ||
      entry.offset < offset ||
      entry.length <= 0 ||
      entry.offset > bytes.length - entry.length
    )
      continue;
    if (entry.offset > offset) hide();
    const part = bytes.subarray(entry.offset, entry.offset + entry.length),
      text = part.toString("utf8");
    if (!snapshot.verify({ kind: "rendering", mac: entry.mac }, "land-log-entry", part)) {
      output.push(withheld());
      uncovered = false;
    } else if (redactGateOutput(text) !== text) {
      output.push(withheld("credential-changed"));
      uncovered = false;
    } else {
      output.push(text);
      uncovered = false;
    }
    offset = entry.offset + entry.length;
  }
  if (offset < bytes.length) hide();
  return output.join("");
}
