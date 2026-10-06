import { loadPrivateStrings, privateMatches } from "../gates/private.ts";
import { redactCredentials, registeredCredentials } from "./proc.ts";

export type OutputPrivacy = (text: string, truncated?: boolean) => string;

/** A missing filter means the policy is unreadable: callers must omit free text. */
export function loadOutputPrivacy(): OutputPrivacy | null {
  try {
    const entries = loadPrivateStrings();
    return (text, truncated = false) => {
      const protectedEntries = [...entries, ...registeredCredentials().map((value) => ({ value, entry: 0 }))];
      return privateMatches(text, protectedEntries, truncated).length
        ? "[withheld: private text]"
        : redactCredentials(text);
    };
  } catch {
    return null;
  }
}

export function privateOutputData<T>(value: T, privacy: OutputPrivacy): T {
  return JSON.parse(
    JSON.stringify(value, (_key, field: unknown) => (typeof field === "string" ? privacy(field) : field)),
    (_key, field: unknown) =>
      field && typeof field === "object" && !Array.isArray(field)
        ? Object.fromEntries(Object.entries(field).map(([key, value]) => [privacy(key), value]))
        : field,
  ) as T;
}
