import { RunTransferError, rethrowRunTransfer } from "./run-transfer-errors.ts";

export type TransferJsonValue =
  | null
  | boolean
  | number
  | string
  | TransferJsonValue[]
  | { [key: string]: TransferJsonValue };

export function parseTransferCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new RunTransferError("invalid");
  return value;
}

export function parseTransferIdentity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  )
    throw new RunTransferError("invalid");
  return value;
}

export function parseTransferOid(value: unknown): string {
  if (
    typeof value !== "string" ||
    (value.length !== 40 && value.length !== 64) ||
    !/^[0-9a-f]+$/i.test(value)
  )
    throw new RunTransferError("invalid");
  return value;
}

// Serialize members directly: JSON.stringify would reorder numeric-looking object keys.
function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value))
    throw new RunTransferError("invalid");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new RunTransferError("invalid");
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    const member = (key: string): string => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new RunTransferError("invalid");
      return canonical(descriptor.value, ancestors);
    };
    if (array) {
      if (keys.length !== value.length + 1) throw new RunTransferError("invalid");
      return `[${Array.from({ length: value.length }, (_, i) => member(String(i))).join(",")}]`;
    }
    const names = keys.map((key) => {
      if (typeof key !== "string") throw new RunTransferError("invalid");
      return key;
    });
    return `{${names
      .sort()
      .map((key) => `${JSON.stringify(key)}:${member(key)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function transferJsonText(value: unknown): string {
  try {
    return canonical(value, new Set());
  } catch (error) {
    rethrowRunTransfer(error, "invalid");
  }
}

export function parseTransferJson(value: unknown): TransferJsonValue {
  transferJsonText(value);
  return value as TransferJsonValue;
}

export function encodeTransferJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(transferJsonText(value));
}
