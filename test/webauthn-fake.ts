import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();
const UP = 0x01,
  UV = 0x04,
  AT = 0x40;

/**
 * A software passkey for one origin: an ES256 key, "none" attestation and a signature counter, built
 * per the WebAuthn spec so the server library verifies it exactly as it would a real authenticator.
 * A `null` counter always reports 0, as most synced passkeys do.
 */
export function fakeAuthenticator(origin: string, start: number | null = 0) {
  let counter = start ?? 0;
  const rpID = new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x = "", y = "" } = publicKey.export({ format: "jwk" });
  const rawId = randomBytes(16);
  const id = b64(rawId);
  const authData = (flags: number, attested: Uint8Array = new Uint8Array()) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(start === null ? 0 : ++counter);
    return Buffer.concat([sha256(rpID), Buffer.from([flags]), count, attested]);
  };
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    create({ challenge }: { challenge: string }, flags = UP | UV): RegistrationResponseJSON {
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(Buffer.from(x, "base64url"))],
          [-3, new Uint8Array(Buffer.from(y, "base64url"))],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(rawId.length);
      const data = authData(flags | AT, Buffer.concat([Buffer.alloc(16), length, rawId, cose]));
      const attestation = new Map<string, string | Map<string, never> | Uint8Array>([
        ["fmt", "none"],
        ["attStmt", new Map<string, never>()],
        ["authData", new Uint8Array(data)],
      ]);
      const response = {
        clientDataJSON: b64(clientData("webauthn.create", challenge)),
        attestationObject: b64(isoCBOR.encode(attestation)),
        transports: ["internal" as const],
      };
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response };
    },
    get({ challenge }: { challenge: string }, flags = UP | UV): AuthenticationResponseJSON {
      const data = authData(flags);
      const client = clientData("webauthn.get", challenge);
      const signature = sign("sha256", Buffer.concat([data, sha256(client)]), {
        key: privateKey,
        dsaEncoding: "der",
      });
      const response = {
        clientDataJSON: b64(client),
        authenticatorData: b64(data),
        signature: b64(signature),
      };
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response };
    },
  };
}
