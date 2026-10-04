import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const canonical = (p: string): string =>
  lstatSync(p, { throwIfNoEntry: false }) ? realpathSync(p) : join(canonical(dirname(p)), basename(p));
export class PrivateError extends Error {}
export function loadPrivateStrings(
  configDir = process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless"),
  roots: (string | null | undefined)[] = [],
): { value: string; entry: number }[] {
  let text: string;
  try {
    const file = canonical(join(configDir, "private-strings.txt"));
    const locations = [resolve(configDir), canonical(configDir), file];
    const boundaries = roots.flatMap((root) => (root ? [resolve(root), canonical(resolve(root))] : []));
    if (boundaries.some((root) => locations.some((path) => `${path}/`.startsWith(`${root}/`))))
      throw new PrivateError("Private config is inside repository; publication blocked");
    if (!lstatSync(file, { throwIfNoEntry: false })) return [];
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch (error) {
    if (error instanceof PrivateError) throw error;
    throw new PrivateError("Cannot read private-strings.txt; publication blocked");
  }
  return text.split(/\r?\n/).flatMap((line, i) => {
    const value = line.trim();
    return value && !value.startsWith("#") ? [{ value, entry: i + 1 }] : [];
  });
}
export type PrivateStrings = ReturnType<typeof loadPrivateStrings>;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const decoded = (text: string) =>
  text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString());
export const privateMatches = (text: string, entries: PrivateStrings) =>
  entries.filter(({ value }) => normalize(`${text}\n${decoded(text)}`).includes(normalize(value)));
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
