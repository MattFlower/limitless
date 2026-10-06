import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
    const read = (path: string) => readFileSync(path, "utf8").trim();
    const repositoryRoots = roots.flatMap((root) => {
      if (!root) return [];
      let git = canonical(join(root, ".git"));
      const stat = lstatSync(git, { throwIfNoEntry: false });
      if (stat?.isFile()) git = resolve(root, read(git).replace(/^gitdir: /, ""));
      else if (!stat) git = root;
      if (lstatSync(join(git, "commondir"), { throwIfNoEntry: false }))
        git = canonical(resolve(git, read(join(git, "commondir"))));
      const worktrees = join(git, "worktrees");
      const linked = lstatSync(worktrees, { throwIfNoEntry: false })
        ? readdirSync(worktrees).map((name) => dirname(read(join(worktrees, name, "gitdir"))))
        : [];
      return [root, git, ...(basename(git) === ".git" ? [dirname(git)] : []), ...linked];
    });
    const boundaries = repositoryRoots.flatMap((root) => [resolve(root), canonical(resolve(root))]);
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
  text
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString())
    // Diagnostics may JSON-quote a field's literal Unicode escapes.
    .replace(/\\+u([0-9a-f]{4})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
/** A clipped value also protects any trailing fragment of a private string. */
export function privateMatches(text: string, entries: PrivateStrings, truncated = false): PrivateStrings {
  const layers = [text];
  for (let round = 0; round < 5; round++) {
    const next = decoded(text);
    if (next === text) {
      const normalized = layers.map(normalize);
      return entries.filter(({ value }) => {
        const protectedText = normalize(value);
        return normalized.some((layer) => {
          if (layer.includes(protectedText)) return true;
          if (!truncated) return false;
          // A cutoff can split an escape or a UTF-8 percent sequence, hiding the decoded tail.
          const tails = [layer, layer.replace(/(?:%[0-9a-f]?|\\+u[0-9a-f]{0,3}|\\+|\ufffd)+$/i, "")];
          return tails.some((tail) => {
            for (let length = 1; length < protectedText.length && length <= tail.length; length++)
              if (tail.endsWith(protectedText.slice(0, length))) return true;
            return false;
          });
        });
      });
    }
    layers.push(next);
    text = next;
  }
  // Entry zero marks unsafe decoding, including when the denylist is empty.
  return [{ value: "", entry: 0 }];
}
export const privateReason = (location: string, entry: number) =>
  entry === 0
    ? `${location} exceeds the private text decoding limit; publication blocked`
    : `${location} contains a private string (entry ${entry} in private-strings.txt)`;
export function redactPrivate(text: string, entries: PrivateStrings): string {
  for (const { value } of entries)
    text = text.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  return privateMatches(text, entries).length ? "[redacted diagnostic]" : text;
}
export function checkPrivateText(text: string, location: string, entries: PrivateStrings): void {
  const hit = privateMatches(text, entries)[0];
  if (hit) throw new PrivateError(privateReason(location, hit.entry));
}
