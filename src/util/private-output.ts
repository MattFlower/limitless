import { loadPrivateStrings, privateMatches } from "../gates/private.ts";
import { redactCredentials, registeredCredentials } from "./proc.ts";

export type OutputPrivacy = (text: string, truncated?: boolean) => string;

/** A missing filter means the policy is unreadable: callers must omit free text. */
export function loadOutputPrivacy(): OutputPrivacy | null {
  try {
    const entries = loadPrivateStrings();
    return (text, truncated = false) => {
      const protectedEntries = [...entries, ...registeredCredentials().map((value) => ({ value, entry: 0 }))];
      return text.includes("[redacted]") || privateMatches(text, protectedEntries, truncated).length
        ? "[withheld: private text]"
        : redactCredentials(text);
    };
  } catch {
    return null;
  }
}

export function privateOutputData<T>(value: T, privacy: OutputPrivacy, truncated = false): T {
  const clipped = (key: string, text: string, parent: Record<string, unknown>) =>
    truncated ||
    // Change-view pages were checked in full before paging; their cuts are already safe.
    (parent.truncated === true &&
      !(key === "text" && "total" in parent && "nextOffset" in parent) &&
      ["preview", "text", "output"].includes(key)) ||
    (key === "message" && "runId" in parent && "ts" in parent && "type" in parent && text.length >= 4000) ||
    // SQLite feed triggers clip by Unicode code points, not UTF-16 code units.
    (typeof parent.kind === "string" &&
      "ts" in parent &&
      "summary" in parent &&
      ((key === "title" && [...text].length >= 200) || (key === "summary" && [...text].length >= 500)));
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, field: unknown) {
      if (typeof field !== "string") return field;
      // Round titles append a public annotation after the stored 200-character cut.
      if (key === "title" && "ts" in this && "kind" in this && "summary" in this && [...field].length > 200) {
        const prefix = [...field].slice(0, 200).join("");
        const safe = privacy(prefix, true);
        if (safe !== prefix) return safe;
      }
      return privacy(field, clipped(key, field, this));
    }),
    (_key, field: unknown) =>
      field && typeof field === "object" && !Array.isArray(field)
        ? Object.fromEntries(Object.entries(field).map(([key, value]) => [privacy(key, truncated), value]))
        : field,
  ) as T;
}
