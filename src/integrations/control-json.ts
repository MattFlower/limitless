import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) break;
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) break;
      const array = Array.isArray(value);
      const proto = Object.getPrototypeOf(value);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) break;
      ancestors.add(value);
      const keys = Reflect.ownKeys(value);
      const parts: string[] = [];
      if (array) {
        if (keys.length !== value.length + 1) break;
        for (let i = 0; i < value.length; i++) {
          const property = Object.getOwnPropertyDescriptor(value, String(i));
          if (!property || !("value" in property) || !property.enumerable)
            throw new Error("Invalid control JSON");
          parts.push(encode(property.value, ancestors));
        }
      } else {
        if (keys.some((key) => typeof key !== "string")) break;
        for (const key of (keys as string[]).sort()) {
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (!property || !("value" in property) || !property.enumerable)
            throw new Error("Invalid control JSON");
          parts.push(`${JSON.stringify(key)}:${encode(property.value, ancestors)}`);
        }
      }
      ancestors.delete(value);
      return array ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
    }
  }
  throw new Error("Invalid control JSON");
}

export function canonicalJson(value: unknown): string {
  try {
    return encode(value, new Set());
  } catch {
    // Reflection and recursion failures must not disclose caller-controlled exception text.
    throw new Error("Invalid control JSON");
  }
}

export function commandDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function snapshotJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value));
}
