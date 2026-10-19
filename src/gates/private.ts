import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const canonical = (p: string): string =>
  lstatSync(p, { throwIfNoEntry: false }) ? realpathSync(p) : join(canonical(dirname(p)), basename(p));
const absent = (path: string) => !lstatSync(path, { throwIfNoEntry: false });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
/** `path` is `root` or below it; the filesystem root contains every path. */
const within = (path: string, root: string) => `${path}/`.startsWith(root.endsWith("/") ? root : `${root}/`);
export class PrivateError extends Error {}

/**
 * Checkouts of the linked worktrees listed in `worktrees`. Another run's worktree that git is adding or
 * removing is skipped only in git's own transient states, judged by lstat: an entry or gitdir file that
 * no longer (or doesn't yet) exist, or an empty gitdir file while git's "initializing" lock is held.
 * A symlink, an unreadable file, or an empty gitdir without the lock (`worktree move` rewrites it) is read
 * strictly and blocks.
 */
function linkedCheckouts(worktrees: string): string[] {
  let names: string[];
  try {
    names = readdirSync(worktrees);
  } catch (error) {
    // git drops the directory with its last entry.
    if (missing(error) && absent(worktrees)) return [];
    throw error;
  }
  return names.flatMap((name) => {
    const entry = join(worktrees, name);
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat) return [];
    const gitdir = join(entry, "gitdir");
    const file = lstatSync(gitdir, { throwIfNoEntry: false });
    // git creates the entry before it writes gitdir, and removes gitdir before the entry.
    if (stat.isDirectory() && !file) return [];
    const plain = stat.isDirectory() && file?.isFile() === true;
    let target: string;
    try {
      target = readFileSync(gitdir, "utf8").trim();
    } catch (error) {
      if (plain && missing(error) && absent(gitdir)) return [];
      throw error;
    }
    if (!target) {
      if (plain && !absent(join(entry, "locked"))) return [];
      throw new Error(`Empty gitdir in ${entry}`);
    }
    // git can write the checkout's path relative to the entry.
    return [dirname(resolve(entry, target))];
  });
}

function readPrivateStrings(configDir: string, roots: (string | null | undefined)[]) {
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
    const linked = absent(worktrees) ? [] : linkedCheckouts(worktrees);
    return [root, git, ...(basename(git) === ".git" ? [dirname(git)] : []), ...linked];
  });
  const boundaries = repositoryRoots.flatMap((root) => [resolve(root), canonical(resolve(root))]);
  if (boundaries.some((root) => locations.some((path) => within(path, root))))
    throw new PrivateError("Private config is inside repository; publication blocked");
  if (!lstatSync(file, { throwIfNoEntry: false })) return [];
  // Read only the path that was checked: a symlinked component restored since then could lead elsewhere.
  if (realpathSync(file) !== file) throw new Error("Private config moved during the check");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  return text.split(/\r?\n/).flatMap((line, i) => {
    const value = line.trim();
    return value && !value.startsWith("#") ? [{ value, entry: i + 1 }] : [];
  });
}

export function loadPrivateStrings(
  configDir = process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless"),
  roots: (string | null | undefined)[] = [],
): { value: string; entry: number }[] {
  // Another run's worktree can vanish between canonicalization's lstat and realpath. Each attempt is a
  // whole check that fails closed, so only a missing path is retried, and three failures block.
  for (let attempt = 1; ; attempt++) {
    try {
      return readPrivateStrings(configDir, roots);
    } catch (error) {
      if (error instanceof PrivateError) throw error;
      if (missing(error) && attempt < 3) continue;
      throw new PrivateError("Cannot read private-strings.txt; publication blocked");
    }
  }
}
export type PrivateStrings = ReturnType<typeof loadPrivateStrings>;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const decoded = (text: string) =>
  text
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString())
    // Diagnostics may JSON-quote a field's literal Unicode escapes.
    .replace(/\\+u([0-9a-f]{4})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
/** Raw and successively decoded forms, NFKC-normalized and lowercased; null when decoding never settles. */
export function normalizedLayers(text: string): string[] | null {
  const layers = [text];
  for (let round = 0; round < 5; round++) {
    const next = decoded(text);
    if (next === text) return layers.map(normalize);
    layers.push(next);
    text = next;
  }
  return null;
}
/** A clipped value also protects any trailing fragment of a private string. */
export function privateMatches(text: string, entries: PrivateStrings, truncated = false): PrivateStrings {
  const normalized = normalizedLayers(text);
  if (normalized)
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
