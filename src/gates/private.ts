import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class PrivateError extends Error {}
export function loadPrivateStrings(
  configDir = process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless"),
): { value: string; entry: number }[] {
  let text: string;
  try {
    text = readFileSync(join(configDir, "private-strings.txt"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new PrivateError("Cannot read private-strings.txt; publication blocked");
  }
  return text.split(/\r?\n/).flatMap((line, i) => {
    const value = line.trim().toLowerCase();
    return value && !value.startsWith("#") ? [{ value, entry: i + 1 }] : [];
  });
}
export type PrivateStrings = ReturnType<typeof loadPrivateStrings>;
export const privateMatches = (text: string, entries: PrivateStrings) =>
  entries.filter(({ value }) => text.toLowerCase().includes(value));
export const privateReason = (location: string, entry: number) =>
  `${location} contains a private string (entry ${entry} in private-strings.txt)`;
export function redactPrivate(text: string, entries: PrivateStrings): string {
  for (const { value } of entries)
    text = text.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  return privateMatches(text, entries).length ? "[redacted diagnostic]" : text;
}
export function checkPrivateText(text: string, location: string, entries: PrivateStrings): void {
  const hit = privateMatches(text, entries)[0];
  if (hit) throw new PrivateError(privateReason(location, hit.entry));
}
