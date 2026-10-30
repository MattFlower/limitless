import { createHmac, hkdfSync } from "node:crypto";
import { canonicalJson, snapshotJson } from "./control-json.ts";
import type { ControlKey, ControlKind } from "./control-ref.ts";

export interface ControlNamer {
  derive(kind: ControlKind, components: readonly string[]): ControlKey;
}

export function createControlNamer(dataKey: Uint8Array): ControlNamer {
  let namingKey: Buffer;
  try {
    if (!(dataKey instanceof Uint8Array)) throw new Error();
    const owned = Buffer.from(dataKey);
    if (owned.byteLength !== 32) throw new Error();
    namingKey = Buffer.from(hkdfSync("sha256", owned, "limitless-control-naming", "v1", 32));
  } catch {
    throw new Error("Invalid control naming key");
  }
  return {
    derive(kind, components) {
      try {
        if (!["receipt", "boundary", "run-index", "member", "land-authority"].includes(kind))
          throw new Error();
        const captured = snapshotJson(components);
        if (!Array.isArray(captured) || captured.some((part) => typeof part !== "string")) throw new Error();
        const tuple = canonicalJson(["limitless-control-id", 1, kind, ...captured]);
        const id = createHmac("sha256", namingKey).update(tuple, "utf8").digest("hex");
        return { kind, id };
      } catch {
        throw new Error("Invalid control identity");
      }
    },
  };
}
